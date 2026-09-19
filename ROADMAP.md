# OmniDesk 版本功能规划

> 项目定位：本地优先的跨平台远程桌面客户端（**Windows 首发**，再移植 macOS / Linux）  
> 技术路线：Electron + Vue 2 + Element UI（对齐 [Another Redis Desktop Manager](https://github.com/qishibo/AnotherRedisDesktopManager)）  
> 协议：RDP / VNC / SSH  
> **RDP 策略（已定）**：首发 **不内嵌**，主进程生成 `.rdp` 并调用系统 **`mstsc.exe`**；会话层用 `SessionAdapter` 接口，后续可替换为 FreeRDP 侧车 / xfreerdp。详见 `docs/TECH-RDP-MSTSC.md`  
> 范围：本地客户端；资源 CRUD（**资产 1:N 访问方式**）；远程桌面 / 终端 / 文件传输；显示参数可配置（按协议动态能力）

## 规划原则

1. **每个版本都可安装、可演示、可回滚**，避免长周期「半成品」。
2. **配置与会话解耦**：资产元数据与 `SessionAdapter`（mstsc / VNC / SSH）分层，Windows→Linux/mac 只换适配器。
3. **本地加密落盘**：密码优先 keytar / 系统钥匙串；敏感字段可选「仅本次」；**禁止明文密码写入 `.rdp`**。
4. **UI 心智一致 ARDM**：左侧资产树 + 多标签工作区 + 状态栏；主色 `#409EFF` 暗色默认。
5. **先 Windows 可用，再移植**：v0.1–v0.2 以 Windows 安装包与 mstsc 路径为验收主轴；mac/linux 构建脚本可先占位。

---

## v0.1 · 工程骨架 · 资产模型（约 2–3 周）

**目标**：应用能跑起来，连接「存得下、管得住」。

| 模块 | 交付内容 |
|------|----------|
| 工程 | Electron（建议 **28+，勿抄 ARDM Electron 12**）+ Vue 2 + Element UI + electron-builder；win 优先出包，mac/linux 脚本占位 |
| 配置库 | **资产**（共享 IP/账号）与 **访问方式**（协议+端口，1:N）CRUD；分组/标签；导出导入 |
| 连接树 | 分组折叠、搜索、颜色标记、右键菜单（连接/编辑/克隆/删除） |
| 壳与 Tab | 自定义标题栏、**首页仪表盘**（最近/总数/会话/快捷）、**资产详情独立 Tab**（上下布局、无编辑按钮）、多标签；设置（主题、语言、数据路径、关于） |
| 安全 | 主配置加密；密码掩码；keytar 接入 |
| 会话层 | **`SessionAdapter` 接口与 SessionManager 空实现**（为 v0.2 预留 IPC） |
| 非目标 | 真实协议建链、文件传输 |

**验收**：Windows 安装包可装；重启后配置不丢；1000 条资产滚动不卡；右键/详情 Tab 与原型一致。

---

## v0.2 · MVP · 外置 mstsc 的 RDP（约 3–4 周）

**目标**：局域网内一键拉起系统远程桌面完成办公；**不内嵌画布**。

| 模块 | 交付内容 |
|------|----------|
| RDP 适配器 | `RdpWindowsMstscAdapter`：按资产+访问方式写临时 `.rdp` → `spawn mstsc.exe`（detached）→ 监听 exit |
| 凭据 | 优先 `cmdkey /generic:TERMSRV:` + `mstsc /v:`，或系统凭据弹窗；**禁止** Password 明文落盘；keytar 只存库内 |
| 认证文案 | 端口不通 / 未允许远程 / NLA 策略 / 找不到 mstsc → 可读错误 |
| 显示映射 | 分辨率 `desktopwidth/height` 或全屏；色深 `color depth`；**刷新率 UI 降级为提示**（mstsc 无法协商） |
| 重定向 | 剪贴板、磁盘、打印机、音频 → `.rdp` redirect 字段，与详情页开关一致 |
| 多屏 | 基础：全屏 / 单窗口；`/multimon` 或 `screen mode id:2` 尽力而为 |
| 会话状态 | spawn 后会话态、关闭 mstsc → OmniDesk 显示已断开；「测试连接」= TCP 3389 探测 |
| 平台 | **仅 Windows** 正式验收；不做 mac/linux RDP |

**非目标**：OmniDesk Tab 内嵌像素画面、AVC HUD、帧率统计（无内嵌则无帧源）。

**验收**：

1. 详情页「连接」→ 系统 mstsc 拉起并登录目标机  
2. 分辨率/全屏/剪贴板开关与生成的 `.rdp` 一致  
3. 关闭 mstsc 后 OmniDesk 状态变为已结束  
4. 密码不出现在明文 `.rdp` 或日志  
5. `host:3389` 探测失败时有明确提示  

---

## v0.3 · 显示能力边界 + SSH 终端 + VNC（约 3 周）

**目标**：按协议区分显示能力；补齐终端；mac/linux 先走 VNC/SSH（桌面内嵌），RDP 外置可选。

| 模块 | 交付内容 |
|------|----------|
| 显示能力模型 | `adapter.capabilities()`：RDP(mstsc) 可配分辨率/色深/全屏；VNC 多数只读提示；SSH 无显示 |
| 多显示器 | UI 保留布局示意；RDP 映射 multimon/span；VNC 置灰并说明 |
| 终端 | xterm.js 多 Tab、字体/主题、复用资产 SSH 凭据 |
| VNC | **内嵌** RFB/noVNC 类路径（与 mstsc 不同，画面在 OmniDesk 内） |
| 平台 | macOS 屏幕共享 VNC；Linux VNC + SSH；可选 **xfreerdp CLI** 适配器（与 mstsc 同构外置） |
| 主题 | 浅色主题；资产颜色标签 |

**验收**：能力矩阵与 UI 启用态一致（无假可配）；mac/linux 能 VNC/SSH；显示改动持久化。

---

## v0.4 · 文件与安全 · 能力扩展（约 3–4 周）

**目标**：SFTP 闭环 + 安全加固。

| 模块 | 交付内容 |
|------|----------|
| 文件传输 | 双栏浏览器、上传/下载、队列、校验（经 SSH） |
| Linux 桌面加强 | SSH 隧道拉起 x11vnc / TurboVNC（可选） |
| 安全 | 私钥、跳板/隧道、主密码、锁屏、本地审计日志 |
| 诊断 | TCP/端口探测、mstsc 路径检测、连接预检 |
| 更新 | 手动检查更新（可选 feed） |

**验收**：1GB 传输可取消并有明确断点策略；私钥与密码双路径通过。

---

## v0.5 · 打磨 · 体验与 i18n（约 3 周）

**目标**：VNC 会话体验与多开效率（mstsc 路径下优化空间有限）。

| 模块 | 交付内容 |
|------|----------|
| VNC 性能 | 码率/画质档位、区域刷新（内嵌路径） |
| 输入 | 快捷键映射策略（内嵌 VNC）；RDP 仍交给 mstsc |
| 多开 | 收藏、最近、批量启动外置会话 |
| 国际化 | zh-CN / en-US；基础无障碍 |
| 视觉 | 动效收敛；首页数据刷新节流 |

**验收**：多开 VNC 不卡死 UI；冷启动 < 3s；i18n 覆盖主路径。

---

## v1.0+ · 内嵌 RDP / 生态预留（后续，不承诺日期）

- **EmbeddedRdpAdapter**（FreeRDP 侧车或 N-API）：Tab 内画布、HUD、真多屏热切换——**替换 mstsc 适配器，不改业务层**  
- 可选自建中继；团队同步；插件；Wayland / 云桌面 SDK  

---

## 版本对照速查

| 版本 | 一句话 | 关键词 |
|------|--------|--------|
| v0.1 | 骨架与资产模型 | 分组、资产 1:N、右键、首页/详情 Tab、Adapter 接口 |
| v0.2 | **外置 mstsc RDP** | .rdp 生成、spawn 监控、cmdkey、TCP 探测、仅 Windows |
| v0.3 | 能力边界 + 终端 + VNC | capabilities、xterm.js、VNC 内嵌、mac/linux 非 RDP |
| v0.4 | 文件与安全 | SFTP、隧道、私钥、锁屏 |
| v0.5 | 打磨 i18n | VNC 性能、多开、双语 |
| v1.0+ | 内嵌 RDP / 生态 | FreeRDP 侧车、中继、插件（预留） |

---

## 与原型的对应关系

交互原型：`prototype/omniDesk-prototype.html`

| 原型界面 | 首次落地版本 | 实现备注 |
|----------|--------------|----------|
| 主壳 / 资产树 / 首页四块 / 详情 Tab（上下布局） | v0.1 | 详情无「编辑」，编辑走右键 |
| 新增资产（类型 + 多访问方式分端口） | v0.1 | |
| 连接按钮（RDP） | v0.2 | → mstsc 外窗口，**非** Tab 内画布 |
| 桌面会话工具条 / HUD | **延后或仅 VNC** | mstsc 路径无内嵌帧源；刷新率降级提示 |
| 显示 Tab（色深/分辨率/多屏） | v0.2 映射字段；v0.3 能力矩阵 | 刷新率在 mstsc 下不可真配 |
| 终端 Tab | v0.3 | |
| 文件传输 Tab | v0.4 | |
| 设置（主题/语言/路径/关于） | v0.1 | |
| 版本规划页 | 文档同步维护 | |

---

## 技术文档

- `docs/TECH-RDP-MSTSC.md` — mstsc 调用、`.rdp` 字段、凭据、SessionAdapter 与 IPC 草案  
- `DESIGN.md` — 信息架构与视觉规范  
- `prototype/omniDesk-prototype.html` — 高保真交互原型  
