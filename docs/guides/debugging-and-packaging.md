# 免安装调试与安装包说明

## 直接调试网页

双击项目根目录的 **调试网页.cmd**。它启动本机调试服务并打开默认浏览器：

**http://127.0.0.1:18180**

也可以在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DebugWeb.ps1
```

服务仅监听本机，直接读取 `roaster/static` 源码，提供网页、HTTP API、实时 WebSocket、安全模拟器及真实本机 AI 服务。修改前端后刷新浏览器即可；开发响应禁用缓存。不要双击 HTML 文件，也不要只运行 `npm run simulator` 后期待它提供网页。

首次需要项目开发依赖：在 `desktop` 执行 `npm ci`。启动脚本优先使用项目已准备的 Node 24，缺失时使用系统 Node。脚本会复用此项目已经启动的调试服务。端口被其他程序占用时，可给 PowerShell 入口加 `-Port 18181`。

停止服务：双击 **停止调试网页.cmd**。直接在终端运行的方式是：

```powershell
cd desktop
npm run dev:web
# Ctrl+C 停止；--port=0 可自动分配端口
```

## 直接调试原生桌面窗口

双击根目录 **调试桌面.cmd**，或者执行：

```powershell
cd desktop
npm run dev:sim -- --freeze
```

CMD 会先启动或复用 `18180` 的本机调试服务，再打开 Tauri 开发窗口；关闭窗口后服务继续保留，下次双击可直接使用。`npm run dev:sim` 也会复用现有服务；仅由该命令独立建立的临时服务随窗口结束。首次需要 Rust/MSVC/WebView2，并编译开发二进制，**不制作也不安装 NSIS 包**。源码来自同一 HTTP 调试地址，前端修改后刷新窗口即可。

启动器直接调用 Tauri CLI API，兼容随应用打包的 `ai-node-*.exe`；资源准备也使用同一 Node，不依赖 npm 的启动命令推断。缺少依赖或 Rust 时终端给出明确错误；失败退出码会保留。

默认状态是待机，便于进入编辑器；使用 `--scenario=roasting`、`--scenario=cooling`、`--scenario=error` 检查其他场景。已有网页服务时沿用其状态，需要改初始场景可先停止网页服务。

## 调试数据和 AI

- 页面底栏标明“安全模拟器 · 样例数据”，不会连接真实串口、GPIO 或加热器。
- 曲线和烘焙记录是模拟器样例，模拟器内修改会随服务重启重置；原生文件可手动打开、保存和导出。
- AI 使用真实共享核心，首次没有预置账号。进入「设置 → AI 账户」添加账户并完成一次官方授权；之后自动恢复已保存的账户、模型与会话。网络错误保留登录信息，令牌正常到期会自动续期；供应商明确拒绝授权时才需要重新登录。打开软件不会自动调用付费模型。
- 网页和调试桌面共用 `%LOCALAPPDATA%\RoasterDesktop\dev-web\ai`，不会在打开桌面窗口时另建空账户空间。正式安装版与设备后端仍各自保存数据。凭据加密，调试主密钥由 Windows 当前用户 DPAPI 保护。
- 本机调试页面自动建立当前会话；该开发授权仅用于环回地址，不修改正式设备配对规则。

## 安装包实际包含什么

| 内容 | Windows 安装包 |
| --- | --- |
| Tauri / WebView 桌面程序、内嵌共享网页、离线字体和图表 | 包含 |
| `.kpro/.klog` 独立离线数值引擎与原生保存入口 | 包含 |
| 固定版本 Node 和本机 AI 运行时 | 包含 |
| TC4S 控制器、串口服务、完整 HTTP 控机后端 | 不包含，在设备后端运行 |
| 当前设备的曲线库、烘焙记录和文件目录 | 不包含，通过设备后端读取；本地原生文件由用户打开 |
| 本机 AI 账户和会话 | 首次使用后保存在本机；不会随安装包预置用户账号 |
| 官方 Claude Code | 用户使用 Claude 订阅时按页面引导自行安装或更新 |
| 本次新增的网页调试服务器与开发样例 | 开发工具，不随正式客户端启动 |

安装版默认连接 `http://localhost:8000`。如果此地址没有服务，普通曲线库与记录无法读取；桌面本机 AI 和离线文件工作台可以单独使用，访问该网页地址也不会成功。使用实机时，先在树莓派启动后端，再在桌面「设置 → 设备连接」填写设备地址。安装桌面客户端本身不会建立一个网页服务器。

0.5.0 的问题是首次启动只显示等待/加载失败，未解释缺少后端，且原来的模拟器没有网页入口。本轮修正源码的连接诊断，补齐免安装调试服务器。**已经安装的旧二进制不会被源码修改自动更新；更新安装包由用户自行选择安装，不自动覆盖现有安装目录。**

## 怎样打包

```powershell
cd desktop
npm run build
```

构建依次准备 Node/AI bundle 和离线引擎，运行前端契约检查，把 `roaster/static` 嵌入 release EXE，再由 NSIS 生成 `desktop/src-tauri/target/release/bundle/nsis/RoasterDesktop_<版本>_x64-setup.exe`。这用于分发；日常开发使用上面的 `dev:web` 或 `dev:sim`。

只需本机验证 release EXE 时也可以 `npm run tauri -- build --no-bundle`，然后从完整构建目录运行 `target/release/roaster-desktop.exe`；仍需正确的后端地址和旁边的 Node、AI、workbench 资源。只复制 EXE 会丢失这些外部运行时。
