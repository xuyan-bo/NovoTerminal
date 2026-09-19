# OmniDesk · Windows RDP 外置 mstsc 技术方案

**状态**：已定路线（2026）  
**适用版本**：v0.2 起（Windows 首发）  
**关联**：`ROADMAP.md` v0.2、`DESIGN.md`、原型 `prototype/omniDesk-prototype.html`

## 1. 决策摘要

| 项 | 决定 |
|----|------|
| 是否内嵌 RDP 画布 | **否**（首发） |
| 会话进程 | 系统 **`mstsc.exe`**（远程桌面连接） |
| OmniDesk 职责 | 资产/访问方式配置、生成连接描述、拉起与监控、状态 UI |
| 画面位置 | **系统独立窗口**，非 Electron Tab 内 Canvas |
| 后期升级 | `EmbeddedRdpAdapter`（FreeRDP 等）替换实现，业务与 IPC 不变 |
| 平台 | v0.2 **仅 Windows**；Linux 预留 `xfreerdp` 同构适配器 |

**为什么**：去掉 FreeRDP 编译与帧管线，把 P0 从「协议引擎」降为「文件映射 + 子进程编排」，优先保证可用。

## 2. 架构

```text
Renderer (Vue/Element)
  详情 Tab「连接」 / 树右键「用 RDP 连接」
        │  ipcRenderer.invoke('session.connect', payload)
        ▼
Main / SessionManager
        │  resolve SessionAdapter by method.protocol + platform
        ▼
RdpWindowsMstscAdapter
  1) 组装 connection 描述（.rdp 或 cmdkey+/v:）
  2) 可选 cmdkey 注入凭据
  3) spawn('mstsc.exe', args, { detached: true })
  4) 监听 exit → 推送 session.ended
        ▼
mstsc.exe  ←→  目标机 RDP (default 3389)
```

### SessionAdapter 接口（草案）

```ts
type ConnectPayload = {
  sessionId: string;
  assetId: string;
  asset: { host: string; user: string; /* pass 不进渲染日志 */ };
  method: { id: string; protocol: 'rdp'|'vnc'|'ssh'; port: number; primary: boolean };
  display?: {
    mode: 'window'|'fullscreen';
    width?: number; height?: number;
    colorDepth?: 8|15|16|24|32;
    multimon?: boolean;
    layout?: 'single'|'extend'|'stack'|'mirror';
  };
  redirect?: { clipboard?: boolean; drives?: boolean; printers?: boolean; audio?: boolean };
  auth?: { mode: 'keytar'|'prompt'|'session-only'; passwordRef?: string };
};

interface SessionAdapter {
  id: string;                          // 'rdp-windows-mstsc'
  capabilities(): {
    embeddable: boolean;               // mstsc → false
    resolution: 'full'|'partial'|'none';
    colorDepth: boolean;
    refreshRate: boolean;              // mstsc → false
    multimon: 'full'|'partial'|'none';
    clipboard: boolean;
    processTracked: boolean;
  };
  testConnection(payload: ConnectPayload): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  connect(payload: ConnectPayload): Promise<{ pid?: number; note?: string }>;
  disconnect(sessionId: string): Promise<void>;
  // 事件经 Event 或 ipc 发出: connecting | connected | ended | error
}
```

- `embeddable: false` → 渲染层不渲染桌面工具条/HUD，改为「已启动系统远程桌面」过渡页。  
- `refreshRate: false` → 显示设置中刷新率只读 + 文案「由远程桌面协议/系统桌面决定」。

## 3. `.rdp` 字段映射

临时文件建议：`app.getPath('temp')/omnidesk-rdp/<sessionId>.rdp`，用后删除（`ended` 时清理）。

| OmniDesk 配置 | `.rdp` 键 | 说明 |
|---------------|-----------|------|
| 主机:端口 | `full address:s:host:port` | 访问方式端口，非写死 3389 |
| 用户名 | `username:s:` | 资产共享用户名 |
| 窗口/全屏 | `screen mode id:i:` | 0=窗口，1=全屏 |
| 分辨率 | `desktopwidth:i:` `desktopheight:i:` | 窗口模式生效；全屏可省略 |
| 色深 | `color depth:i:` | 15/16/24/32 |
| 窗口比例 | `winposstr:s:` | 可选：最大化等 |
| 剪贴板 | `redirectclipboard:i:` | 1/0 |
| 磁盘 | `redirectdrives:i:` | 1/0 |
| 打印机 | `redirectprinters:i:` | 1/0 |
| 音频 | `audiomode:i:` | 0=远程播放，1=不播放，2=本地（按产品映射） |
| 多显示器 | `screen mode id:i:2` + `use multimon:i:1` | 尽力；复杂布局 v0.3+ |
| 用户名提示 | `prompt for credentials:i:` | 0 用已给用户；1 每次弹窗 |
| 目标集合 | `administrative session:i:` | 一般 0；`/admin` 场景另议 |
| 启动 | `autoreconnection enabled:i:` | 1 |

**不要写入**：明文密码、原始 keytar 摘要到可分享日志。

### 凭据策略（优先级）

1. **推荐**：主进程从 keytar 取密 → `cmdkey /generic:TERMSRV:host:port /user:u /pass:p` → `mstsc /v:host:port` → 结束后按策略 `cmdkey /delete`。  
2. **无密/仅本次**：`.rdp` 只写 `username`，`prompt for credentials:i:1`，由系统弹窗。  
3. **禁止**：非 DPAPI 的明文 `Password` 字段；把密码打在命令行参数（易进进程列表）。

`cmdkey` 与当前用户上下文相关，注意会话与提权（一般保持 OmniDesk 非管理员即可）。

## 4. 启动与生命周期

```text
connect:
  capabilities 已校验 → 写 .rdp → cmdkey(可选) →
  spawn mstsc [rdpPath] { detached: true, stdio: 'ignore' } →
  记录 { sessionId, pid, rdpPath } → IPC session.connected

exit(code):
  清理 rdp 临时文件 → 可选 cmdkey /delete →
  IPC session.ended { sessionId, code }

disconnect(用户主动):
  若 pid 仍存活 → taskkill /PID（或 CloseMainWindow 优雅关）→ 走 exit 流程
```

- 检测 `mstsc`：`where mstsc` 或 `%SystemRoot%\System32\mstsc.exe`。  
- 找不到：`error code: MSTSC_NOT_FOUND`，文案引导「系统远程桌面客户端缺失」。  
- 同一资产多开会话：允许多 pid；sessionId 区分。  
- 测试连接：TCP `connect` 到 `host:port`（超时 2–3s）；**不做**完整 RDP 握手（v0.2 非目标）。

## 5. IPC 草案（preload 白名单）

主 → 渲染（事件）：

| channel | payload 摘要 |
|---------|----------------|
| `session:state` | `{ sessionId, assetId, state: 'connecting'\|'connected'\|'ended'\|'error', code?, message? }` |
| `session:stats` | 预留；mstsc 无帧源则可不发 |

渲染 → 主（invoke）：

| channel | 说明 |
|---------|------|
| `session:connect` | `ConnectPayload`（**不含明文 password**，仅 passwordRef/mode） |
| `session:disconnect` | `{ sessionId }` |
| `session:test` | 端口探测 |
| `asset:export-rdp` | 可选：导出 `.rdp` 供高级用户（仍无明文密码） |

安全：`contextIsolation: true`，`nodeIntegration: false`，preload 只暴露上表 API；日志脱敏 `user` 可保留、密码永不打印。

## 6. UI / 原型映射

| 原型 | v0.2 行为 |
|------|-----------|
| 详情 Tab · 连接 | invoke `session:connect` → toast「已启动系统远程桌面」；**不**开内嵌桌面 Tab |
| 桌面会话工具条 / HUD | **不显示**（embeddable=false）；可后续仅 VNC 用 |
| 分辨率/色深/全屏 | 写入 `.rdp`，下次连接生效 |
| 刷新率 | 设置页 disabled + hint「mstsc 无法协商刷新率」 |
| 多屏 | 提供「全屏/窗口」+ 尽力 multimon；复杂布局延后 |
| 剪贴板/磁盘/音频开关 | 映射 redirect 字段 |
| 首页「最近连接」 | spawn 成功即记一条 |
| 状态栏/详情 | 进程 exited → `ended` |

## 7. 错误码（文案化）

| code | 建议文案 |
|------|----------|
| `MSTSC_NOT_FOUND` | 未找到系统远程桌面客户端（mstsc） |
| `TCP_TIMEOUT` | 无法连接 host:port，请检查网络与远程桌面是否开启 |
| `SPAWN_FAILED` | 启动远程桌面失败 |
| `CMDKEY_FAILED` | 写入凭据失败，将改为系统弹窗登录 |
| `USER_CANCEL` | 已取消登录（exit code 特征或用户关闭） |

具体 exit code 与取消对话框的对应关系，在实现时用真实环境补表。

## 8. 后续替换路径

| 阶段 | Adapter | 平台 |
|------|---------|------|
| v0.2 | `RdpWindowsMstscAdapter` | Windows |
| v0.3 可选 | `RdpExternalCliAdapter`（xfreerdp） | Linux |
| v1.0+ | `EmbeddedRdpAdapter`（FreeRDP 侧车） | 三端，Tab 内画布 |

`SessionManager` 只依赖 `capabilities()` + `connect` + 事件；**渲染层根据 capabilities 降级 UI**，无需判断具体实现。

## 9. 非目标（明确不做）

- ActiveX / `MsRdpClient` COM 内嵌（老旧、兼容性差）  
- v0.2 内帧率/带宽 HUD（无内嵌无帧）  
- 明文密码 `.rdp`  
- 将 `mstsc` 窗口 HWND 嵌入 Electron 子窗口（跨版本脆弱，不排入首发）  
