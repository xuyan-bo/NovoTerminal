# OmniDesk 开发说明（v0.1）

## 环境

- Node.js 18+（本机可用 `node -v`）
- Windows 首发；RDP 通过系统 `mstsc.exe`

## 常用命令

```powershell
# 安装依赖（国内可设镜像）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install

# 构建渲染层 + 启动 Electron（生产预览）
npm start

# 开发：两个终端
npm run dev          # Vite @ http://127.0.0.1:5173
npm run electron     # 连接 dev server

# 仅打包 Windows
npm run pack:win
```

若 `require('electron')` 报未正确安装，确认 `node_modules/electron/path.txt` 内容为 `electron.exe`，且 `dist/electron.exe` 存在；可用镜像重跑 `node node_modules/electron/install.js`。

**Electron 二进制缺 DLL（0xC0000135）时**：用镜像完整包覆盖 dist：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
curl.exe -L -o electron-dl\electron-v33.4.11-win32-x64.zip https://npmmirror.com/mirrors/electron/33.4.11/electron-v33.4.11-win32-x64.zip
Remove-Item -Recurse node_modules\electron\dist
Expand-Archive electron-dl\electron-v33.4.11-win32-x64.zip node_modules\electron\dist -Force
Set-Content node_modules\electron\path.txt electron.exe -NoNewline
```

## 目录

```
electron/          主进程
  main.js          窗口 + IPC
  preload.js       contextBridge API
  store/           资产库（safeStorage 加密 JSON）
  session/         SessionManager + adapters
    adapters/RdpWindowsMstscAdapter.js  ← v0.2 外置 mstsc
src/               Vue2 渲染层
  App.vue store.js components/
dist/              vite 产物（electron 加载）
prototype/         高保真交互原型（设计参考）
docs/TECH-RDP-MSTSC.md
```

## 功能边界（v0.1）

- 资产 / 分组 CRUD、首页四块、双击详情 Tab、设置（主题/语言/数据路径/关于）
- RDP：TCP 测试 + spawn mstsc（Windows）
- VNC / SSH：适配器占位，后续版本
