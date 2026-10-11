# NovoTerminal 开发规范

本文件适用于整个仓库，是开发代理修改代码前必须阅读的项目约定。子目录存在 `AGENTS.md` 时，其规定仅在对应目录内补充或覆盖本文件；与上级指令冲突时遵循上级指令。遇到需求与本规范不一致，先明确差异，不擅自扩大改动范围。

## 1. 基本原则

- 先理解现有实现与调用链，再修改；以当前代码为准，不能将规划文档中的目标当作已实现功能。
- 开始前检查 `git status --short`，区分已有改动和本次改动；不得覆盖、回退或清理他人的未提交内容。
- 优先修改已有模块、复用已有入口；按真实职责拆分，不按行数机械拆文件。
- 只解决当前需求，不顺带升级技术栈、格式化全仓、重命名公共字段或修改打包配置。
- 可扩展性通过明确的模块边界、协议元数据和小型函数实现，不预建插件框架、通用基类或多层包装。
- **文件与目录**：默认改既有文件，不新增文件；新增文件必须落入第 2 节职责表中的既有目录。仅当「同一职责、预计长期容纳多个文件、现有目录无法容纳」同时成立时才可新建目录；新建 `src/`、`electron/` 下的直接子目录或调整现有目录归属，须先说明理由并获用户同意，再同步第 2 节职责表。禁止按技术类型横向铺开目录（如 `utils/`、`helpers/`、`types/`、`index.js` 桶文件），禁止为单个文件建目录或为一次调用建转发文件。
- 重构应保持实际运行语义；原代码存在重复方法定义时，以最后生效的定义为准，确认引用后才能删除死代码。
- 发现与任务无关的问题应说明，不夹带大范围修复；发现本次引入的问题必须修复后再交付。
- 未经用户主动提出，不执行 `git commit` 与 `git push`；用户提出提交/推送时按第 11 节的自查流程执行，无需逐次询问。破坏性 Git 操作仍须单独授权。没有明确授权，不操作真实远程服务器，不导入、覆盖或删除真实用户数据。

## 2. 技术栈与职责边界

当前采用 Electron、Vue 2.7 Options API、Element UI、Vite；渲染进程使用 ESM，Electron 代码使用 CommonJS。状态集中于 `Vue.observable`，没有 Vuex、Pinia 或 vue-router。

| 位置 | 职责与约束 |
| --- | --- |
| `src/main.js` | Vue 启动、Element UI 和全局 `$t`；组件不重复定义同名翻译方法 |
| `src/App.vue` | 页面/页签编排、关闭确认、应用布局；不堆放协议实现 |
| `src/store.js` | 共享界面状态、资产操作、连接入口、页签管理；不直接访问文件系统或网络套接字 |
| `src/api.js` | 使用 preload 桥接 API；无 Electron 时仅提供有限预览，不伪造真实连接成功 |
| `src/protocols.js` | 协议标签、默认端口、样式标识、可选异步会话组件 |
| `src/constants.js` | OS 访问方式目录、表单默认值与高级参数 schema；不承载连接执行逻辑 |
| `src/lib/` | 渲染端纯工具与数据模块（资产树、Markdown 渲染），无 UI 与状态 |
| `src/components/views/` | 页面级/根容器视图（首页、资产详情、协议视图、SFTP 页、独立会话窗口）；协议视图负责各自的输入、显示、尺寸和连接状态协调 |
| `src/components/dialogs/` | 模态弹窗（设置、资产/分组、方法高级参数、SSH 主题与认证、日志、关闭确认、更新提示） |
| `src/components/panels/` | 应用外壳与停靠面板（侧边栏、页签栏、AI 助手、SSH 监控） |
| `src/components/common/` | 通用小组件（右键菜单、SVG 图标、方法配置、Markdown 展示） |
| `src/components/session/fullscreen.js` | 共用全屏生命周期；协议组件只提供样式类和尺寸回调 |
| `src/components/sftp/` | 文件面板、传输队列、任务/传输/拖放方法及纯路径工具 |
| `src/i18n.js`、`src/styles/main.css` | 双语文案、主题入口、全局样式变量和公共样式 |
| `electron/preload.js` | 通过 `contextBridge` 暴露具名、受限 API 和事件订阅 |
| `electron/main.js` | 窗口、应用生命周期和 IPC 编排；具体协议逻辑交给对应模块 |
| `electron/session/` | 外部会话适配及连接探测；RDP 分内置（IronRDP-WASM，由渲染端连接）与外部客户端（mstsc/xfreerdp/wfreerdp，由本目录适配器启动）两条路径 |
| `electron/ssh/`、`electron/vnc/`、`electron/sftp/` | 各自的连接、代理、资源和传输管理 |
| `electron/store/`、`electron/auth/` | 持久化与系统身份验证；UI 不绕过这些边界自行实现 |
| `scripts/` | 构建钩子与工具（`build-mac-auth.cjs`、`afterPack.cjs`、`gen-os-icons.js`）及开发期 SSH 检查脚本；不参与运行时，新增文件须同步 `.gitignore` 的 `/scripts/*` 例外 |

- 普通页面使用 store 页签；SFTP 使用独立窗口的 `#sftp?assetId=...` 入口，拆分出去的会话窗口使用 `#window?gid=…`（一个窗口承载多条页签），两者都不擅自迁移为另一套路由。
- SSH 实际使用主进程 ssh2 与渲染进程 xterm；VNC 使用主进程代理与 noVNC；不能把 `SessionManager` 的 SSH/VNC 占位适配器当作真实连接实现。
- 重型会话组件通过异步 import 按需加载，不能为了读取常量反向引入整个视图或主进程模块。
- `README.md` 可作背景参考，实现与其不一致时应核对代码；项目不再维护设计说明、路线图与交互原型，历史目标一律以当前代码为准，不得据此推断已实现功能。

## 3. 编码风格

- 沿用当前 JavaScript 风格：两空格缩进、单引号、分号；Vue 单文件组件按 template、script、style 排列。
- Vue 组件文件使用 PascalCase，普通变量与函数使用 camelCase，协议 ID 使用稳定的小写字符串，常量使用 UPPER_SNAKE_CASE。
- 不为局部需求引入 TypeScript、Vue 3 写法或新状态库。第三方依赖（现成轮子）可以引入，但必须先给出候选、实测体积与模块格式、说明取舍并获得用户批准；做技术调研时应主动优先推荐可用的轮子，而不是默认自研。
- 简单条件赋值优先用清晰的三目表达式；复杂分支使用早返回，不堆叠多层三目或重复状态守卫。
- 业务规则和默认值放在所属模块；纯工具的内部常量保持自包含，不为了复用新建庞大配置中心。
- 优先普通参数、对象、props/events；不要为一次调用创建包装类或没有实际隔离价值的抽象层。
- 默认不写注释；仅对非直观的约束、异步竞态或兼容原因添加简短说明，不复述代码，不保留任务过程说明。
- 新增错误处理要有实际边界依据，不添加不可能触发的兜底，不将操作失败吞掉后返回成功。
- 删除代码前确认模板、动态调用和跨文件引用；不保留空组件、无用导出或仅用于兼容已删除内部调用的转发函数。
- **日志规范**：新增或修改功能时，必须在关键节点补充持久化日志——连接成功/断开/失败、IPC 错误、SFTP 任务起止等。主进程通过 `electron/logs/logStore.js` 暴露的 `logger` 注入到各 manager（渲染端经 preload 的 `logWrite` 写入），层级用 `info`/`warn`/`error`，meta 携带主机、端口、错误码、耗时等不含凭据的信息。示例：
  - 连接成功：`this.log.info('ssh', 'ssh connected', { sessionId, host, port })`
  - 连接失败：`this.log.error('rdp', 'session connect failed', { host, port, code: e.code, message: e.message })`
  - meta 一律禁止 password、私钥、vnc pass 等敏感字段，脱敏交给 `logStore` 兜底仍不应依赖。
- **滚动条样式**：所有可滚动区域统一使用 Element 的细滚动条（约 6px、圆角，滑块用 `--border`，hover 变 `--text-3`，轨道透明），不出现粗的原生滚动条。SSH 的 `.xterm-viewport`、VNC 及会话视图 `.view` 超出宽高时的右侧/底部滚动条已在此约定内；新增可滚动容器应复用并用 `::webkit-scrollbar` 收敛宽度，避免另起更粗样式。
- **图标规范**：通用 UI 图标（箭头、刷新、关闭等）首选 Element 内置的 `el-icon-*` 字体图标类，使用前须在已安装的 `element-ui/lib/theme-chalk/index.css` 中核对类名确实存在；`el-icon-*` 中没有合适图标时，告知用户并由用户提供 SVG，图标文件（单色、白色填充/描边）放入 `public/icons/`，页面统一通过全局 `<svg-icon name="…" :size="…">` 组件引用（亮度遮罩 + `currentColor` 跟随主题），组件模板内禁止硬编码内联 `<svg>`；不允许自行用 `‹ › ✕ ＋` 之类的文本字符充当图标，也不引入外部图标库；操作系统等品牌图标作为数据集中在 `src/constants.js` 内渲染，是唯一例外。图标符号不得写进 i18n 文案，菜单图标用菜单项的 `icon` 类名字段承载。

## 4. Vue 组件与状态所有权

- 一个业务状态只有一个所有者：页面持有草稿、连接和任务状态，展示组件通过 props 接收，通过事件通知修改。
- 子组件不得直接修改 props 或嵌套对象；复用 `MethodConfig`、`SftpFilePanel`、`SftpTransferQueue` 时保持此边界。
- Vue 2 新增对象属性、替换数组项时使用 `$set` 或替换整个引用，不能套用 Vue 3 的响应式假设。
- 以下划线开头的实例字段不会从 `data` 代理到 `this`；非响应式资源、锁和计时器在 `created` 中显式初始化。
- DOM 事件跨组件传递时保留原 event 对象、多参数顺序及同步调用语义，尤其是拖放事件的 target、默认行为和传播控制。
- 按职责复用组件，差异通过少量明确 props、events、slots 表达；不要将协议专有行为塞进通用 UI 组件。
- 新增用户可见文案使用 `t`/`$t` 并补齐中英文；校验文案在校验时翻译，不能因初始化时缓存导致切换语言后不更新。
- 输入控件按值的语义选型：数值项一律使用带上下界的 `el-input-number`（`:min`/`:max`，保留 `controls-position="right"` 步进箭头，不写 `:controls="false"`，也不用 `el-input type="number"` 这类拦不住输入的写法），枚举用 `el-select`、布尔用 `el-switch`、连续量用 `el-slider`。控件宽度要实测：`el-input-number--mini` 在 `controls-position="right"` 下内边距为 `15px/50px`，五位数字至少 101px 才不被裁。
- 校验以 `el-form` 的 `rules` 加 `validate` 为主，必填、格式、跨字段约束都写成规则并指定 `blur`/`change` 触发；控件层面已经避开的非法值（例如端口越界）不再补写报错文案，只在读取持久化数据时把脏值、空值归一化回落到默认值。不得绕过 `rules` 在提交函数里用 `if` 判断加 `$message` 自行报错。
- 不得自行在页面上添加解释性、说明性描述文字（表单 hint、段落提示、空态引导语等）：界面只保留标签、占位符、按钮和必要的错误/确认文案；确实需要补充说明时，先征得用户同意。
- 界面上的领域术语沿用既有文案，不因内部实现命名（例如数据字段、方法名）而改动；新文案落笔前先核对 `src/i18n.js` 里的同类词条。
- 新样式优先使用主题变量；组件私有样式使用 scoped，全局规则只承载真实公共需求。兼顾明暗主题及禁用、加载、错误状态。
- 资产名称、主机、路径、菜单标签等外部内容默认使用文本插值；禁止拼接为 `innerHTML` 或未经处理的 `v-html`。

## 5. 新增或修改访问协议

所有连接入口复用 `src/store.js` 的 `connectAsset`，不得在侧边栏、资产详情、最近连接中重新复制协议分支。新增协议逐项检查下面的完整链路；仅注册一个组件不等于协议功能完成。

1. **协议标识**：在 `src/protocols.js` 登记稳定 ID、标签、默认端口和样式标识；需要内嵌页签时提供稳定的异步组件工厂。
2. **可用目录**：更新 `src/constants.js` 的 OS catalog、推荐项及所需样式，不能假设所有操作系统支持相同访问方式。
3. **配置与保存**：需要高级参数时补齐 defaults、schema、翻译和实际消费逻辑；检查启用状态、端口、唯一主连接、编辑回填和取消操作。
4. **跨进程契约**：同步实现渲染 API、preload、主进程 IPC 及协议管理器/适配器；浏览器预览缺少能力时应明确返回不可用。
5. **真实执行**：实现连接、失败状态、断开及资源释放；外部窗口协议补相应适配器，内嵌协议由视图调用专属 IPC，不能复用返回成功的 stub。
6. **探测与能力**：检查 `electron/session/SessionManager.js` 和 `electron/session/testers.js`；区分 TCP 可达、协议握手与身份认证成功，不误报能力。
7. **状态与最近连接**：检查页签 connected 状态、最近连接写入与重连端口；包括 `electron/store/assetStore.js` 中的默认端口分支。
8. **生命周期**：检查切换、重复打开、连接中关闭、失败重试、主动断开及应用退出，明确每项资源的释放责任。

必须保持的约束：

- 未知协议明确报告不支持，不默认当作 SSH、VNC 或 RDP；查注册表时仅接受自有属性。
- 渲染进程默认端口复用协议注册表；主进程具有独立运行边界，新增参数要核对所有实际消费者的默认值，不强行 import Vue 模块共享常量。
- 当前高级默认值分散于 `src/constants.js`、`electron/main.js` 和对应协议管理器；不能只改表单就宣称参数生效。
- 保存高级设置不能无意丢弃同一方法下的其他合法字段，例如 SSH 配色；数据格式变更应兼容已有持久化记录，不做无需求的兼容层。
- RDP 有两条实现路径：内置 IronRDP-WASM（渲染端 SessionBuilder + 主进程 RDCleanPath 代理）与外部客户端命令行（mstsc/xfreerdp/wfreerdp）；有配置项不代表对应引擎支持该参数，不得以成功启动代替验证高级能力。

## 6. 页签、全屏和资源生命周期

- 使用 `kind: 'asset'` 标识资产详情，协议页签使用协议 ID；不能仅靠 `assetId` 将会话误渲染成资产详情。
- 保持稳定页签 ID、组件类型及 key；重复打开同一页签仅激活，不覆盖已存在连接状态。
- 栏内拖动排序只经 `store.moveTab` 调整原页签对象顺序，首页保持首位，活动页签不变；保留溢出滚动、关闭确认和协议实例。
- 会话页签（`protocols.js` 注册了 component 的 ssh/vnc/rdp）拖出栏外或经右键菜单可拆成独立窗口：`electron/main.js` 的 `detachedGroups` + `tabGroup` 是唯一权威状态，经 `session:detached` 落到主窗口的停放副本；资产详情、外置 RDP 和首页页签不可拆分，拖出保持原样取消。拖出过程中显示跟随光标的独立窗口轮廓预览（仅可拆分的会话页签）；拖拽松手由渲染端发 `fromDrag: true` 的 `session:detach`，主进程用 `screen.getCursorScreenPoint()` 实时光标裁决——光标在**起手窗口自己**的页签栏矩形内则返回 cancelled 不改宿主，否则以光标为中心创建窗口并 clamp 到所在显示器工作区（Chromium 在光标离开窗口后不再给出可靠坐标，判定必须留在主进程）；右键菜单拆分不带 `fromDrag`，保持默认摆位。
- 拆分期间页签不在页签栏出现（`TabBar` 过滤 `detached`），活动页签随之交给邻近可见页签；不得改成“空白内容区 + 保留占位页签”。
- 拆分只切换宿主窗口，不改变连接：SSH 在 `ssh:attach` 里转移 `ownerId` 并重放该会话的输出尾巴；VNC 与内置 RDP 的代理是单客户端的，拆分与合并都会重新握手，凭据已保存所以无需用户输入。握手途中被转走所有权也算正常交接：`ssh:connect` 返回后只有在发起方 webContents 已销毁时才收回这条连接，**不得**按"自己不再拥有它"断开，否则把一条连接中的页签搬去另一个窗口只会留下"已断开"（实测踩过）；渲染端自己丢弃结果时（重连、关页签）都按 `liveSessionId` 显式断开。
- 独立窗口保留原生标题栏，移动、缩放和关闭都交给系统，不在渲染进程用鼠标位移驱动 `setPosition`（会与系统移动/缩放互相抖动）。独立窗口也是页签宿主：`electron/main.js` 用 `detachedGroups`（`groupId → {window, tabIds}`）+ `detachedTabs`（页签描述符）记录归属，路由 `#window?gid=…`，`SessionWindow` 拿 `session:group-tabs` 快照写进**本窗口自己的** `store.tabs` 并渲染 `TabBar scope="group"`，成员或顺序一变主进程就 `session:group` 重推；组内最后一个页签离开时窗口自动关闭（`closeGroupIfEmpty`）。页签跨窗口搬运只有一条原语 `session:tab-move`（`to:'host'` 就是收回主窗口），SSH 按页签 `liveSessionId` 转移所有权并给源窗口发 `session:handover`，VNC/RDP 由新宿主重新握手。
- 跨窗口拖放必须抬层：Chromium 只把拖放交给光标下最上层的窗口，而光标必然落在起手的那个窗口里，所以 `dragstart` 经 `session:dock-prepare`（同时把页签描述符交给主进程）后，主进程以 90ms 轮询 `screen.getCursorScreenPoint()`，**只把光标正压在其页签栏上的那一个窗口** `moveTop()`（起手窗口自己的栏也算，回到自己栏就把自己抬回去）。不要在 `dragstart` 一次性抬起所有其他宿主窗口——那会让子窗口内部的排序被误投到主窗口（实测踩过）。只用 `moveTop`，不要 `setAlwaysOnTop`，否则拖完会把窗口压到其他应用下面。Wayland 拿不到全局光标，这条轮询不成立，需要另给不依赖拖放的入口。
- 拖放结束时的落点分两种，别再合并写：`session:tab-move` 成功即 `restoreDockTargets(toWindow)`，**把接收方抬到最前并 `focus()`**（投放成功后用户要看的就是它），不再把起手窗口放回去；只有 `session:dock-abort`、源窗口 `closed` 或渲染进程死亡才停止轮询、把起手窗口抬回并还原焦点，同时广播 `session:dock-clear` 让所有宿主窗口收回落点提示。
- 落点接受区必须等于上报的抬起判定矩形：`session:tabbar-bounds` 上报的是整条 `.tabbar-row`（含折叠与左右滚动按钮），所以 `dragover/dragleave/drop` 也要绑在 `.tabbar-row` 上——只绑 `.tabbar-wrap` 会出现"窗口被抬起来却看不到占位、松手也没反应"，而且独立窗口没有折叠按钮，同一个屏幕位置在两种窗口里一边有落点一边没有（实测踩过）。落点提示只由事件清除（离开这条栏、落位、`session:dock-clear`），不得加计时器过期：停下来瞄准间隙 Chromium 不再发 `dragover`，计时器会在松手前把提示吃掉。
- 独立窗口里"复制会话"不得自己分配页签 id（id 由 `store.tabs` 推instance，只有主窗口看得见全量页签）：`session:tab-copy` → 主窗口 `openCopyForGroup` 用 `buildSessionTab` 建页签并**立刻标 `detached:true` 停放**（本窗口不显示、不挂载视图）→ 带 `groupId` 的 `session:detach` 交回原窗口，**连接由那个窗口的视图发起**，所以点下去立刻出现一条「连接中」的新页签，与主窗口同源。绝不在主窗口先连好再搬过去：那样那个窗口只会"过一会儿凭空冒出一条已连好的"，而且搬走一条还在握手的连接时主进程 `ssh:connect` 回来发现所有权已换窗口，会把这条刚建好的会话直接 `disconnect`（实测踩过）。交不出去时当场撤销这条停放页签。
- 组快照到达时，新加入的那一条成为该窗口的当前页签（`applyGroupTabs`，复制和拖入都算，与浏览器一致）；原来的活动页签被搬走才退回第一枚。
- 独立窗口的原生关闭按钮走一次确认，问法与主窗口批量关闭完全一致（`tab.closeBulkConfirmMsg` + `tab.closeConfirmTitle`）：还有 `connecting`/`ready` 页签就提示"有 N 个活动会话"，确认后答复 `confirmed:true` 由主进程关窗，全部会话随该窗口 webContents 一起释放；全空闲直接关。应用退出（`appQuitting`）、渲染进程已死或页面未就绪时必须跳过拦截，否则窗口与进程都退不掉。
- 主窗口那份"停放副本"（`detached:true` 的页签对象）始终保留，用于收回落位、批量关闭与关闭确认；独立窗口回灌的连接状态走 `session:tab-state` → `applyTabState`，否则收回后小圆点与活动会话判定都是旧的。页签栏矩形上报 `session:tabbar-bounds` 按上报窗口分别存进 `tabbarRects`，只用于"拖出栏外"的落点裁决。
- 合并（页签丢进主窗口页签栏）走 `session:tab-move` 的 `to:'host'` 分支 `dockToHost`：先按该页签的 `liveSessionId` 转移 SSH 所有权并向源窗口发 `session:handover`，再把页签从组里摘掉并回推组快照，最后广播 `session:detached:false`；主窗口在自己那次 drop 里用 `store.setDockTarget` 记下插入位置，收回广播到达时消费一次。源窗口被摘空时由 `closeGroupIfEmpty` 关闭；页签跟着窗口一起消失才走 `session:closed` → `store.dropDetachedTab`，VNC/RDP 代理由视图 `onEnd` 停止监听。两条路径不得混淆；主窗口不主动关闭独立窗口（批量关闭只作用于当前窗口页签栏里可见的页签，见 `TabBar.onTabCtxSelect`）。
- 独立窗口的关闭确认只回答"关或不关"（见前面的关窗确认条目），渲染端不在那里逐个断会话：确认后留下的页签统一随该窗口 webContents 结束（主进程 `closeSshOwner`），单条页签的关闭仍由 `store.closeTab` 在点击时就发起断开，不等视图销毁。未加载完成、已标记 reason 或渲染进程已死时必须跳过拦截，否则窗口将无法关闭。
- 会话切换用 `v-show` 保留实例，不改成切换时销毁的 `v-if`；移除页签才触发相应销毁清理。
- 区分 UI 页签 ID 与主进程返回的实际连接 ID，事件和断开调用必须绑定正确会话。
- connected 状态应反映实际连接；保留关闭确认，连接中关闭不能让晚返回结果创建无人管理的会话。
- IPC 订阅、DOM 监听、计时器、ResizeObserver、终端实例、WebSocket、代理和连接必须有对应清理；订阅函数返回的取消函数要保存并调用。
- 异步初始化和重连在 await 后检查实例是否仍有效；已销毁时释放晚到资源，不能再启动轮询、显示成功或修改新会话状态。
- 全屏复用 `src/components/session/fullscreen.js`；只能退出自己拥有的全屏，兼顾请求失败、CSS 回退、Escape 和销毁中的晚完成请求。
- 新增主进程资源要明确窗口关闭与应用退出的回收路径，不假设其他 manager 或进程退出会替它清理。

## 7. SFTP 改动约束

- `SftpPage.vue` 持有状态与协调逻辑；面板和队列只负责展示/事件；任务、传输、拖放分别维护在对应 methods 模块。
- 保持 `.sftp-panel`、`.file-list`、`.file-row` 的层级及 `data-side`、`data-name`、`data-isdir`、`data-parent` 属性，现有拖放解析依赖这些信息。
- 面板、根节点和 document 的多层监听不能导致同一次 drop 重复传输；保持事件传播控制和去重锁。
- 不随意合并 `onZoneDrop` 与 `runDrop`：前者处理面板直传，后者是区域判定与 document 兜底；两者的文件/文件夹分发统一收敛在 `transferMethods.runTransfers(items, zoneSide, destDir)`（文件走 `uploadPaths`/`downloadPaths`，文件夹走 `transferFolderUpload`/`transferFolderDownload` 聚合任务），目标目录由 `dragDropMethods.localDropDir` 解析。
- 面板 `selected` 是名称数组，选中状态由 `selectionMethods` 持有：普通单击替换、多选修饰键切换（macOS 用 Cmd、其他平台用 Ctrl）、Shift 按锚点范围选、空白区橡皮筋框选、Ctrl/Cmd+A 全选、Escape 清空；导航与刷新必须同时清空选中与锚点。框选只能从 `.file-list` 空白处起手，行上按下要保持 HTML5 拖拽语义。
- 本机文件管理器复制的文件用 Ctrl/Cmd+V 上传到远端当前目录（`transferMethods.pasteFromClipboard`，与远端空白区右键「粘贴」共用同一条路径），未连接时不劫持按键。Windows 下 Electron 读不到 `CF_HDROP`（Chromium 不透出该格式，`FileNameW` 只有首项），完整列表由主进程经 `Get-Clipboard -Format FileDropList` 获取，仅在真正粘贴时调用；菜单置灰判断走廉价的 `FileNameW` 探测。
- 拖拽载荷是 `{ side, list }`：被拖行属于选中集时携带全部选中项，否则只携带该行；右键菜单项随选中数量变化（多项时不提供重命名，删除按数量切换确认文案）。空白处右键固定包含新建目录、刷新、全选（远端侧另有粘贴）。
- 列头排序由页面按侧持有 `{ key: 'name'|'size'|'time', dir }`，统一经 `utils.sortItems` 排序：`..` 恒在首位、目录先于文件、组内按列排序。按时间排序依赖主进程 `SftpManager.list`/`localList` 返回的原始 `mtimeMs`，不要用本地化后的 `mtime` 字符串比较；新增列表字段时同步两处。
- 保持本机/远端路径规则独立，不能用 Windows 分隔符拼远端路径，也不能让路径工具变更悄悄改变已有目标位置。
- 保留文件夹任务聚合、展开状态、暂停/恢复、取消及未完成目标文件清理语义；删除任务不等于可任意删除目标文件。文件夹任务采用「先建行、后增量扫描」：`transferMethods.scanFolderUpload/scanFolderDownload` 按目录逐层列举（复用 `sftpLocalList`/`sftpList`，不要用会阻塞主进程的整树同步遍历），边扫边传；行的 `taskId` 是稳定 row-key，主进程传输 id 存在 `xferId`，进度事件按 `xferId` 或 `sourcePath|targetPath` 命中行并原地更新。表格用 el-table 的 `lazy`+`load` 懒渲染，子节点只在用户展开时经 `loadTreeChildren` 交出；扫描未结束时根任务不得判定为完成。
- 目录递归、覆盖确认、拖入（OS 文件与跨面板拖放，落点按 `localDropDir()` 或目录行自带路径解析）和公用队列的跨会话进度订阅属于功能契约，拆分组件不能省略或简化这些步骤。**拖出到本机/资源管理器没有实现**：原生 `webContents.startDrag` 那条链路（`sftp:start-drag`、`SftpManager.prepareDragOut`）已随 2026-10 的死代码清理移除，别按"已有功能"引用它；要恢复必须重新设计——一次拖放只能有一个宿主，HTML5 面板直传与 `startDrag` 会互相抢事件，且 macOS/Linux 的文件拖出行为还需单独实测。

## 8. IPC、凭据和持久化安全

- 保持 `contextIsolation: true`、`nodeIntegration: false`；不得为方便 UI 调用而直接开放 Node、任意 IPC channel 或任意命令执行能力。
- IPC 使用明确的命名和 payload；新增入口在主进程校验外部参数、资源归属和必要的调用来源，而不是只依赖表单校验。
- 保持错误契约：主进程 `handle` 将异常封装为 `{ __error, message, code }`，渲染端需要时用 `unwrap`；业务结果 `{ ok: false }` 要单独处理。
- 不混淆错误结果与正常数据，不丢失错误码；加载状态在 finally 恢复，取消操作与真正失败分开处理。
- 系统进程优先用 `execFile`/`spawn` 的参数数组，禁止将用户输入拼接进 shell 命令。
- 密码、私钥内容、剪贴板内容和完整资产快照不得进入日志、源码、示例、截图或提交；调试和示例只使用虚构数据。
- 不新增不必要的凭据传递或明文副本；当前 snapshot、导出及部分协议可能携带敏感字段，不能假定已经脱敏或始终加密。
- 持久化通过 `AssetStore` 完成，保留备份、自定义路径、默认值和既有数据语义；导入/导出的身份验证策略必须留在主进程，不能只在 UI 确认。
- 系统认证按客户端平台分支：Windows 保留 Hello/账号密码；macOS 使用原生 LocalAuthentication（登录密码兜底），查看可复用 30 秒缓存、导入/导出重新认证；Linux 经确认跳过认证并返回 `Skipped`，不是已验证身份。未知平台拒绝，macOS 组件缺失、取消或失败不得跳过。
- 不降低 SSH 主机密钥策略或扩大本地 VNC 代理监听范围来绕过连接问题；安全策略变化需单独说明并获得授权。

## 9. 开发命令与验证边界

命令以 `package.json` 为准。以下是用途说明，不代表每次任务都要执行。

| 命令 | 用途与注意事项 |
| --- | --- |
| `npm run dev` | 启动 Vite；默认回环地址、5173 端口，只运行它不具备 Electron 能力 |
| `npm run electron` | 另一个终端启动 Electron，依赖已运行的默认端口 Vite 服务；macOS 启动前自动编译认证组件 |
| `npm run build:renderer` | 生产渲染构建，会生成 dist；不是轻量语法检查 |
| `npm run build:auth:mac` | 仅在 macOS 编译双架构认证组件到 `build/auth`，需要 Xcode Command Line Tools；非 macOS 不执行 |
| `npm start` | 先构建，再运行 Electron；macOS 启动前自动编译认证组件，不是单纯启动开发服务 |
| `npm run pack:mac` | 在 macOS 构建并打包：dmg 与 zip 各出 arm64 / x64 两份，另出一份 universal 的 `pkg`（`mac.target` 用 `{target:"pkg",arch:["universal"]}` 声明，需 Xcode CLT 的 `productbuild`）；beforePack 自动编译认证组件（已是 arm64+x86_64 通用二进制，两架构各编译一次）并随包复制、纳入签名；用户无需编译工具 |
| `npm run pack:win` | 构建并打包 Windows x64 与 arm64 的 nsis 安装程序与 zip 绿色包；非普通修改的默认检查步骤 |
| `npm run pack:linux` | 在 Linux 构建并打包 deb / rpm / AppImage / tar.xz（x64 与 arm64）；须在 Linux 物理机或虚拟机执行，产物落 `release/`（已 gitignore）；仓库不配置 CI，三平台一律手工打包后人工验证 |
| `npm run lint` | 当前仅打印占位消息，不能作为静态检查通过的证据 |

- 打包体积依赖 `package.json` 两处约定，改动协议或新组件时必须同步：`dependencies` 只允许主进程真正 `require` 的模块（现为 `iconv-lite`、`openai`、`ssh2`、`ws`），渲染端依赖一律放 `devDependencies`，否则 electron-builder 会把 Vite 已打进 `dist/` 的包再复制进 `app.asar`；`scripts/afterPack.cjs` 在 Windows 与 Linux 打包后只保留 `locales/` 里的 `en-US.pak`、`zh-CN.pak`（约省 39 MB），macOS 走 `.lproj` 且涉及签名，钩子对 darwin 直接返回不裁剪。
- 当前没有 `npm test` 或项目测试套件入口；`electron/session/testers.js` 是产品联网探测，不能当作离线测试运行。
- `scripts/gen-os-icons.js` 会生成/改写资源和代码，不属于检查命令，不为验证代码而运行。
- 依赖必须有实际需要，并且按第 3 节的流程先经用户批准才能引入；变更依赖时同步锁文件，不为执行一次检查擅自安装工具或升级依赖。
- 默认完成代码复审与轻量静态检查，真实环境手测由用户完成；只有当前任务或上级指令要求时，才执行相应浏览器验证、测试、构建或打包。
- CommonJS 可用 `node --check`；ESM 必须按模块模式解析，例如 `node --input-type=module --check < src/protocols.js`；Vue 文件使用现有 `vue/compiler-sfc` 提取脚本并编译模板作语法检查，不能把整份 `.vue` 交给 `node --check`。
- 静态检查同时覆盖引用路径、导出、props/events、重复定义及差异空白；运行 `git diff --check` 并检查新增文件。
- UI 验证被要求时，应覆盖正常操作和本次相关边界状态；浏览器预览成功不代表 Electron IPC、系统身份验证或真实 SSH/VNC/SFTP 功能通过。
- Vite 的生产 `build.target` 不等于开发依赖预构建目标；遇到依赖语法兼容问题先定位对应阶段，不无依据升级/降级依赖。
- 不修改 `node_modules/`、`dist/` 或发布产物代替修复源码；临时验证服务和模拟数据结束后清理，仅停止自己启动的进程。
- 开发与自测产生的临时脚本、快照、验证产物（如测试 harness、mock 数据、编译中间文件）统一放在仓库根的 `tmp/` 下（已在 `.gitignore` 忽略）并在会话结束时删除；不得散落到仓库根目录或进入提交，根目录出现 `tmp_*` 之类残留文件视为未清理。

## 10. 交付前必查

- [ ] 改动范围与需求一致，未覆盖已有改动，未夹带依赖、配置或生成产物变更。
- [ ] 相关调用入口均已核对，没有只更新 UI 而遗漏 IPC、持久化或真实执行路径。
- [ ] 表单、错误契约、默认值、语言/主题及取消操作语义没有被无意改变。
- [ ] 连接状态、页签复用、事件归属、异步销毁和资源释放有完整对应关系。
- [ ] 新增文件/目录已归入第 2 节职责归属，未按技术类型横向铺开或为单个文件新建目录。
- [ ] 修改和新增文件完成适用的静态检查；其他验证按本次要求执行。
- [ ] 检查通过的范围、未验证项及已知限制已明确说明，不以静态扫描承诺功能绝对无误。
- [ ] 最终说明简洁，提供关键文件位置；未经用户提出不提交、不推送，用户提出时按第 11 节执行；`tmp/` 下临时文件已清理。

## 11. 提交与推送

未经用户主动要求不执行 `git commit` / `git push`；用户提出提交后，执行前按固定四项自查，逐项给结论，不能笼统回答「检查过了」：

1. **是否存在问题**：改动范围与需求一致，未覆盖他人未提交内容；调用链、默认值、语言/主题、取消与错误契约没有被无意改变。
2. **是否存在冗余代码**：全仓 grep 被删除的方法、字段、i18n 键和样式的残留消费方；孤儿 props、computed、样式规则、无用导出，以及同一选择器被写两遍的覆盖关系都要查出来并清理。
3. **是否存在错误代码**：跑适用的静态门——主进程 CJS 用 `node --check`，渲染端 ESM 用 `node --input-type=module --check <`，`.vue` 用 `vue/compiler-sfc` 编译模板并抽出脚本按模块检查，另跑 `git diff --check`；`npm run lint` 只打印占位消息，不能作为通过证据。
4. **是否影响其他正常功能**：核对共享组件与 `src/store.js` 导出的全部使用方（返回值、事件名、props 变化都算），确认未改动的入口仍按原语义工作。

四项全绿即完成用户要求的提交并按仓库既有 upstream 推送，不必再次询问；任一项不通过先修复再交付。与本次无关的既有缺陷只说明、不夹带修复。

- 按文件名 `git add`，禁止 `git add -A` 与 `git add .`；不得提交 `.env`、凭据、`node_modules/`、`dist/`、`release/` 或临时验证文件。
- commit 单行简洁，沿用仓库既有风格 `<type>: 短句，短句`（type 取 `feat`/`fix`/`refactor`/`perf`/`docs`/`chore`），不写多段 body。
- 用户提出「提交」即把当前项目全部待提交文件一次提交完，不按性质拆成多个 commit；本规范条目、README/文档改动与代码改动属于同一批提交。只有用户明确要求拆分时才拆分。一次提交包含多种性质时，type 取主要的一类，短句把其余内容一并带到标题里。
- 破坏性 Git 操作（`--force`、`reset --hard`、改写已推送历史、跳过钩子）仍需单独授权。

本规范是开发与复审约束，不代替自动化检查工具。修改架构、命令或上述契约时，应同步更新对应条目，避免规则与代码脱节。
