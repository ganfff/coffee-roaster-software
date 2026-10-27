# RoasterDesktop

当前版本 **0.8.0**，复用 `../roaster/static/` 的 Web 3.31。Windows 安装包内置 Python 设备 HTTP 服务与串口依赖，Rust 启动并管理专属随机本机端口，同时管理本机 AI 与独立原生文件引擎。

日常调试优先双击根目录 **调试网页.cmd**／**调试桌面.cmd**，默认使用真实 Python 控制服务；网页、API、WebSocket、离线工作台和本机 AI 一起启动。`npm run dev:sim` 明确使用开发模拟夹具。完整说明见 [免安装调试与打包](../docs/guides/debugging-and-packaging.md)。

每次控制服务启动进入真实 TC4S 模式。在「设置 → 设备连接」选择实际串口、波特率和站号，收到合法 PV/SV 响应后才显示已连接；无有效温度不能开始。无硬件时选择模拟器并点击连接，模式不跨服务重启恢复。启动／重连不写 SV、不自动烘焙，模式与串口参数仅在待机时修改。Windows 有未处理的本锅时，关闭窗口要求先 End 并保存或放弃记录。详见 [真实设备连接](../docs/guides/real-device-setup.md)。

## 开发环境

Windows 构建需要 Node、Rust/MSVC、WebView2，以及 Python 3.12 x64 的设备／工作台打包环境。首次建立隔离环境：

```powershell
# 在项目根目录执行
py -3.12 -m venv desktop/.venv
desktop/.venv/Scripts/python.exe -m pip install -r desktop/workbench-requirements.txt
desktop/.venv/Scripts/python.exe -m pip install -r roaster/requirements.txt
Set-Location desktop
npm ci
npm run check:frontend
npm run dev:sim -- --freeze
```

设备／工作台准备脚本使用 `WORKBENCH_PYTHON`、`desktop/.venv`、`roaster/.venv`、根 `.venv`、系统 Python 的顺序查找解释器。设备源码调试需要 `roaster/requirements.txt`，完整构建还需要 `workbench-requirements.txt`。项目不依赖旧 KL 副本或其虚拟环境。

独立开发模拟夹具支持 `--scenario=idle`、`--scenario=cooling`、`--scenario=error` 和 `--freeze`，只绑定本机、不访问串口。这些参数用于 `npm run dev:sim`；正常设备服务中的模拟器通过设置切换，真实／模拟曲线库与记录隔离。电脑访问树莓派先建立已有认证 SSH 隧道，再在「设备连接 → 控制服务」填写 `http://127.0.0.1:18000`；服务默认仅监听本机。

## 当前功能

- Mhub 黑白蓝深浅主题、MiSans、平面按钮和200ms区域动画；所有工作区与编辑器共用同一套组件，支持减少动效、窄屏及130%缩放。
- 主页采用 KL 风格细曲线与小事件标记；右侧操作台顶部仅 CC／FC／SC／End 四个文字操作，不提供一爆／二爆结束按钮。

- AI 对话在全局侧栏或放大视图使用，支持历史、停止、编辑重发、重新生成、附件和模型切换。设置按任务分组，提供账户登录与自动模型目录；本地模型为首选入口，其他订阅与 API 保留独立分组。
- Windows 固定使用本机 AI，账户与会话不随设备连接地址切换；移除运行位置、配对与设备共享入口。支持本地模型以及保存在本机的订阅/API 配置。
- 原生工作台离线编辑 `.kpro/.klog`，内置功能说明与参数帮助。AI 候选先预览再确认采用；保存、入库与应用仍由用户分别操作。
- 账号与密钥不进入 Git；Windows 凭据由系统凭据管理器保护。

详见 [本机 AI 配置](../docs/guides/ai-host-deployment.md)、[原生工作台](../docs/guides/native-workbench.md)。

## 构建与分发

```powershell
npm run build
npm run package:pi
```

构建前自动校验并准备 `runtime/` 中的 Node、AI ESM bundle、原生工作台引擎和 Python 设备服务。Node 版本和下载 SHA256 固定在 `ai/runtime-manifest.json`。Windows 安装包位于 `src-tauri/target/release/bundle/nsis/`；最终交付统一复制到根 `dist/`。ARM64 包直接输出到根 `dist/`；`package:ai:arm64` 保留为同一打包命令的兼容入口。

Windows 安装包包含运行时，用户无需安装 Node/Python。绿色版必须整体保留程序、`ai/`、Node 清单、`workbench/` 和 `device/` 资源，不能只复制 EXE。本机控制数据在应用数据目录的 `device/`，AI 继续使用 `ai/`，设备地址切换不迁移本机 AI 账户和历史。

`RoasterDevice_0.8.0_linux_arm64.tar.gz` 是源码部署包，内置 Node ARM64 与安装／启动／打开脚本，首次安装 Python 依赖需要网络；不是交叉编译得到的 Linux 应用。部署与 SSH 隧道步骤见 [真实设备连接](../docs/guides/real-device-setup.md)。ARM64 执行、树莓派界面与真实 TC4S 仍待目标设备验收。

版本以 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`Cargo.lock` 和 `tauri.conf.json` 为准，升级时同步维护。

## 验证

```powershell
npm run test:ai
npm run test:device:ui
npm run test:device:native
npm run test:roast:ui
npm run test:instrument:ui
npm run test:instrument:native
npm run test:editor:session
npm run test:ai:ui
npm run test:ai:native-ui
npm run test:workbench:ui
npm run test:workbench:native-ui
npm run check:frontend
cargo test --manifest-path src-tauri/Cargo.toml
```

AI UI 使用真实共享核心、确定性模型与模拟传输，不调用云端模型。设备原生 UI 检查实际 Tauri WebView 和内置 Python 服务，使用隔离数据目录；安装版本机服务使用随机端口。工作台 UI 默认源码引擎；`WORKBENCH_SOURCE=0` 使用打包引擎。默认多通道日志为仓库内的合成夹具；`WORKBENCH_SAMPLE` 可指定真实样本，`WORKBENCH_QA_DIR` 可重定向报告目录。

后端 `pytest` 默认可选读取相邻独立 `kaffelogic逆向` 项目的 418 文件语料及原版 oracle；也可用 `WORKBENCH_REFERENCE` 指定。没有参考库时两项扩展回归跳过，日常 UI 与构建仍可独立运行。

设备连接与部署说明见 [真实设备连接](../docs/guides/real-device-setup.md)；既有图表与 AI 证据见 [v3.30.1 QA](../docs/qa/kl-home-chart-v3.30.1.md)，完整主题验证见 [v3.30 QA](../docs/qa/mhub-v3.30.md)，历版证据见 [QA 归档](../docs/qa/archive/README.md)。

## 目录

`ai/` 是 AI 服务及契约测试，`src-tauri/` 是 Rust 宿主，`tools/` 是构建/验证/模拟脚本。`runtime/` 为已准备的运行时；`build/`、`src-tauri/target/` 为生成物；`.venv/` 和 `node_modules/` 为本机依赖，均不进入 Git。
