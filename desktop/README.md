# RoasterDesktop

当前版本 **0.6.1**，复用 `../roaster/static/` 的 Web 3.27。桌面通过 HTTP/WebSocket 连接设备后端，Rust 管理本机 AI 与独立原生文件引擎。

日常调试优先双击根目录 **调试网页.cmd**，或运行 `npm run dev:web`；网页、API、WebSocket、离线工作台和本机 AI 会一起启动。原生窗口用 `npm run dev:sim`，无需安装。完整说明见 [免安装调试与打包](../docs/guides/debugging-and-packaging.md)。

安装包是设备客户端，不会启动控机 HTTP 后端。默认 `localhost:8000` 没有服务时，需要改为设备后端地址；本机无硬件预览使用上面的调试入口。

## 开发环境

Windows 构建需要 Node、Rust/MSVC、WebView2，以及 Python 3.12 x64 的工作台打包环境。首次建立隔离环境：

```powershell
# 在项目根目录执行
py -3.12 -m venv desktop/.venv
desktop/.venv/Scripts/python.exe -m pip install -r desktop/workbench-requirements.txt
Set-Location desktop
npm ci
npm run check:frontend
npm run dev:sim -- --freeze
```

工作台解释器依次使用 `WORKBENCH_PYTHON`、`desktop/.venv`、`roaster/.venv`、根 `.venv`、系统 Python。构建要求安装 `workbench-requirements.txt`；源码分析只需后端依赖。项目不依赖旧 KL 副本或其虚拟环境。

安全模拟器支持 `--scenario=idle`、`--scenario=cooling`、`--scenario=error`；只绑定本机，不访问串口。真实设备地址在设置页的连接配置中填写。Windows 不启动真实硬件后端。

## 当前功能

- AI 对话在全局侧栏或放大视图使用，支持历史、停止、编辑重发、重新生成、附件和模型切换。设置按任务分组，提供账户登录与自动模型目录；本地模型为首选入口，其他订阅与 API 保留独立分组。
- Windows 固定使用本机 AI，账户与会话不随设备连接地址切换；移除运行位置、配对与设备共享入口。支持本地模型以及保存在本机的订阅/API 配置。
- 原生工作台离线编辑 `.kpro/.klog`，内置功能说明与参数帮助。AI 候选先预览再确认采用；保存、入库与应用仍由用户分别操作。
- 账号与密钥不进入 Git；Windows 凭据由系统凭据管理器保护。

详见 [本机 AI 配置](../docs/guides/ai-host-deployment.md)、[原生工作台](../docs/guides/native-workbench.md)。

## 构建与分发

```powershell
npm run build
npm run package:ai:arm64
```

构建前自动校验并准备 `runtime/` 中的 Node、AI ESM bundle 和原生工作台引擎。Node 版本和下载 SHA256 固定在 `ai/runtime-manifest.json`。Windows 安装包位于 `src-tauri/target/release/bundle/nsis/`；最终交付统一复制到根 `dist/`。ARM64 包直接输出到根 `dist/`。

安装包包含运行时，用户无需安装 Node/Python。绿色版必须整体保留程序、AI、Node 清单和 `workbench/` 资源，不能只复制 EXE。ARM64 包是设备后端部署包；部署步骤见 [AI 宿主说明](../docs/guides/ai-host-deployment.md)。当前实测交付平台为 Windows x64，ARM64 执行与实机仍待目标设备验收。

版本以 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`Cargo.lock` 和 `tauri.conf.json` 为准，升级时同步维护。

## 验证

```powershell
npm run test:ai
npm run test:ai:ui
npm run test:ai:native-ui
npm run test:workbench:ui
npm run test:workbench:native-ui
npm run check:frontend
cargo test --manifest-path src-tauri/Cargo.toml
```

AI UI 使用真实共享核心、确定性模型与安全模拟器，不调用云端模型。原生 UI 检查运行构建后的实际 Tauri WebView，启动地址 8000 必须空闲。工作台 UI 默认源码引擎；`WORKBENCH_SOURCE=0` 使用打包引擎。默认多通道日志为仓库内的合成夹具；`WORKBENCH_SAMPLE` 可指定真实样本，`WORKBENCH_QA_DIR` 可重定向报告目录。

后端 `pytest` 默认可选读取相邻独立 `kaffelogic逆向` 项目的 418 文件语料及原版 oracle；也可用 `WORKBENCH_REFERENCE` 指定。没有参考库时两项扩展回归跳过，日常 UI 与构建仍可独立运行。

当前证据见 [v3.27 QA](../docs/qa/local-ai-v3.27.md)，历版证据见 [QA 归档](../docs/qa/archive/README.md)。

## 目录

`ai/` 是 AI 服务及契约测试，`src-tauri/` 是 Rust 宿主，`tools/` 是构建/验证/模拟脚本。`runtime/` 为已准备的运行时；`build/`、`src-tauri/target/` 为生成物；`.venv/` 和 `node_modules/` 为本机依赖，均不进入 Git。
