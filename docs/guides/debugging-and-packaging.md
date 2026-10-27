# 免安装调试与安装包说明

适用：桌面 0.8.0 / Web 3.31。设备接线、串口选择、树莓派部署和 SSH 隧道步骤见 [真实设备连接与调试](real-device-setup.md)。

## 直接调试网页

双击项目根目录的 **调试网页.cmd**。它启动本机调试服务并打开默认浏览器：

**http://127.0.0.1:18180**

也可以在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DebugWeb.ps1
```

服务仅监听本机，直接读取 `roaster/static` 源码，提供网页、Python 设备 HTTP API、实时 WebSocket、离线工作台和本机 AI。默认使用真实 TC4S 模式，启动只连接读取遥测，不写 SV 或开始烘焙。修改前端后刷新浏览器即可；开发响应禁用缓存。不要双击 HTML 文件，也不要只运行 `npm run simulator` 后期待它提供网页。

首次需要 Node 和 Python 开发依赖。在根目录建立环境并安装：

```powershell
py -3.12 -m venv desktop/.venv
desktop/.venv/Scripts/python.exe -m pip install -r roaster/requirements.txt
desktop/.venv/Scripts/python.exe -m pip install -r desktop/workbench-requirements.txt
cd desktop
npm ci
```

启动脚本优先使用项目已准备的 Node 24，缺失时使用系统 Node；Python 按 `WORKBENCH_PYTHON`、项目虚拟环境、系统 Python 的顺序选择。脚本会复用此项目已经启动的真实设备调试服务。端口被其他程序占用时，可给 PowerShell 入口加 `-Port 18181`。

停止服务：双击 **停止调试网页.cmd**；有未处理的本锅时，先 End 并保存或放弃记录。直接在终端运行的方式是：

```powershell
cd desktop
npm run dev:web
# Ctrl+C 停止；--port=0 可自动分配端口
```

## 直接调试原生桌面窗口

双击根目录 **调试桌面.cmd**，或者执行：

```powershell
cd desktop
node tools/dev-sim.mjs
```

CMD 会先启动或复用 `18180` 的真实设备调试服务，再打开 Tauri 开发窗口；关闭窗口后这个独立服务继续保留，下次双击可直接使用。`node tools/dev-sim.mjs` 也使用真实设备服务；仅由该命令独立建立的临时服务随窗口退出清理，有未处理的本锅时须先结束并处理记录。首次需要 Rust/MSVC/WebView2，并编译开发二进制，**不制作也不安装 NSIS 包**。源码来自同一 HTTP 调试地址，前端修改后刷新窗口即可。

启动器直接调用 Tauri CLI API，兼容随应用打包的 `ai-node-*.exe`；资源准备也使用同一 Node，不依赖 npm 的启动命令推断。缺少依赖或 Rust 时终端给出明确错误；失败退出码会保留。

正常启动进入待机并读取真实设备状态。无硬件时，在「设置 → 设备连接 → 连接模式」选择模拟器并点击连接。自动化测试还可以明确使用独立的开发模拟夹具：

```powershell
cd desktop
npm run dev:sim -- --freeze
# --scenario=roasting、--scenario=cooling、--scenario=error 用于该开发夹具
```

`dev:sim` 的名称沿用历史命令，现已明确附带 `--simulator`。它与正常设备服务中的设置切换是两条开发路径；已有调试服务只在模式匹配时复用。

## 调试数据和 AI

- 底栏与设置显示实际串口／模式和连接状态，不再显示安全模拟器／样例数据常驻小注释。串口打开后显示等待响应，收到合法 PV/SV 才显示已连接；无有效温度时开始按钮不可用。
- 设备服务默认真实模式，模拟器必须在设置中明确选择并连接；模式与串口参数仅在待机时修改。串口、波特率、站号保留，模拟模式不跨控制服务重启恢复。
- 真实／模拟曲线库与记录分别保存在设备数据目录与其 `simulator/` 子目录。内置模拟器不打开串口，数据不混入真实记录；独立开发模拟夹具的样例修改仍随夹具重启重置。原生文件可手动打开、保存和导出。
- AI 使用真实共享核心，首次没有预置账号。进入「设置 → AI 账户」添加账户并完成一次官方授权；之后静默恢复账户和模型。每次从 AI 入口进入创建新对话，历史记录通过明确选择或候选曲线交接恢复。网络错误保留登录信息；软件启动不自动调用付费模型或打开授权网页。
- 网页和调试桌面共用 `%LOCALAPPDATA%\RoasterDesktop\dev-web\ai`，不会在打开桌面窗口时另建空账户空间。正式安装版与设备后端仍各自保存数据。凭据加密，调试主密钥由 Windows 当前用户 DPAPI 保护。
- 同一调试目录中的 `device/` 保存设备设置、真实曲线／记录及模拟器子目录。正式 Windows 安装版在应用数据目录使用独立的 `device/`，本机 AI 继续使用 `ai/`；更换控制服务地址不改变本机 AI 账户和历史。
- 本机调试页面自动建立开发授权；该授权仅用于环回地址，不修改正式设备配对规则，也不恢复旧 AI 对话。

## 安装包实际包含什么

| 内容 | Windows 安装包 |
| --- | --- |
| Tauri / WebView 桌面程序、内嵌共享网页、离线字体和图表 | 包含 |
| `.kpro/.klog` 独立离线数值引擎与原生保存入口 | 包含 |
| 固定版本 Node 和本机 AI 运行时 | 包含 |
| Python 设备 HTTP 服务、TC4S 驱动与串口依赖 | 包含；Rust 自动启动专属本机端口 |
| 当前设备的曲线库和烘焙记录 | 由所选控制服务的数据目录保存，真实与模拟分别存储 |
| 本机 AI 账户和会话 | 首次使用后保存在本机；不会随安装包预置用户账号 |
| 官方 Claude Code | 用户使用 Claude 订阅时按页面引导自行安装或更新 |
| 源码调试服务器与独立开发模拟夹具 | 开发工具；安装版使用内置 Python 设备服务 |

安装版由 Rust 启动 `device/RoasterDevice.exe`，绑定随机的 `127.0.0.1` 端口并等待服务健康检查，再连接网页 HTTP／WebSocket。服务日志位于应用数据目录的 `device/service.log`。退出时只关闭本窗口拥有的服务；服务须确认待机，未处理的本锅会阻止关闭并提示先 End、保存或放弃记录。连接外部控制服务不会使桌面接管那个服务的进程。

电脑访问树莓派时，控制服务继续只监听派本机。先使用已有 SSH 登录建立隧道：

```sh
ssh -N -L 18000:127.0.0.1:8000 用户名@树莓派地址
```

保持隧道运行，在浏览器打开 `http://127.0.0.1:18000`，或在 Windows「设备连接 → 控制服务」填写此地址。「本机」回到电脑内置服务。设置中的串口属于所连接的控制服务；不要让两个服务同时占用同一串口。

**已安装的旧二进制不会随源码修改更新。** 新安装包由用户选择安装；构建与调试不自动覆盖已有安装目录或预置账户。

## 怎样打包

```powershell
cd desktop
npm run build
```

构建依次准备 Node/AI bundle、离线工作台引擎和 Python 设备服务，运行前端契约检查，把 `roaster/static` 嵌入 release EXE，再由 NSIS 生成 `desktop/src-tauri/target/release/bundle/nsis/RoasterDesktop_0.8.0_x64-setup.exe`。这用于分发；日常开发使用上述调试入口。

只需本机验证 release EXE 时也可以 `npm run tauri -- build --no-bundle`，然后从完整构建目录运行 `src-tauri/target/release/roaster-desktop.exe`；必须保留完整 Node、AI、`workbench/` 和 `device/` 资源。Windows 用户安装完整包后无需另外安装 Node/Python。

树莓派包使用 `npm run package:pi`，输出根目录 `dist/RoasterDevice_0.8.0_linux_arm64.tar.gz` 与校验文件。它内置 Node ARM64、Python 源码及 `install-roaster.sh`／`start-roaster.sh`／`open-roaster.sh`；首次安装需要网络下载 Python 依赖，默认监听 `127.0.0.1:8000`。Windows 安装包、ARM64 包、构建产物和运行数据均保持在忽略目录中。源码、打包和 Windows 模拟传输验证不代表树莓派、TC4S、测温、加热或真实急停已验收。
