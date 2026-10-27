# Ganf's 咖啡烘焙机

当前源码版本：**桌面 0.8.0 / Web 3.31**。Windows 安装包内置 Python 设备控制服务与串口依赖，启动进入真实 TC4S 模式。共享界面覆盖浏览器、Windows 和树莓派，采用 Mhub 黑白蓝深浅主题；主页曲线参考 Kaffelogic，CC／FC／SC／End 位于右侧操作台顶部。本机 AI 账户与模型静默恢复，历史对话由用户明确选择。

| 目录 | 内容 | 入口 |
| --- | --- | --- |
| `roaster/` | Python 后端、设备控制、共享网页、AI 和离线格式引擎 | [运行说明](roaster/README.md) |
| `desktop/` | Tauri 桌面壳、设备服务、AI worker、打包与验证工具 | [开发与构建](desktop/README.md) |
| `docs/` | 使用指南、当前验收、历史归档与维护记录 | [文档索引](docs/README.md) |
| `scripts/` | 项目维护和生成物清理 | [目录约定](docs/project-structure.md) |
| `dist/` | 本机安装包、ARM64 部署包和校验文件；不进入 Git | [连接与部署](docs/guides/real-device-setup.md) |

原生工作台提供编辑、ABC、参数、日志、比较、变换、合并及导出，内置离线说明中心。AI 提供多轮聊天、ChatGPT/Kimi Code 账户模型目录、官方 Claude Code 连接、API Key、自定义接口和可撤销候选；真实授权由用户实际使用时完成。使用见 [工作台指南](docs/guides/native-workbench.md)、[AI 配对与部署](docs/guides/ai-host-deployment.md)。

## 常用命令

源码调试：双击根目录 **调试网页.cmd**，打开 `http://127.0.0.1:18180`；原生窗口双击 **调试桌面.cmd**。两个入口默认使用真实 Python 控制服务，源码修改后刷新即可，并共用已保存的本机调试 AI 账户。无硬件时，在「设置 → 设备连接」选择模拟器并点击连接；控制服务重启后恢复真实设备模式。安装环境与命令见 [调试与打包说明](docs/guides/debugging-and-packaging.md)。

```powershell
Set-Location desktop
npm ci
npm run check:frontend
# 以下调试入口任选其一
npm run dev:web               # 真实设备服务与源码网页
npm run dev:sim -- --freeze   # 显式选择开发模拟夹具与原生窗口

Set-Location ..
./scripts/clean-workspace.ps1 -Build -OldPackages          # 预览
./scripts/clean-workspace.ps1 -Build -OldPackages -Apply   # 清理生成物，保留最新版
```

设备连接在设置中显示实际串口、波特率、站号与状态；收到合法 PV/SV 响应才就绪，无有效温度不能开始。启动和重连不写 SV、不自动烘焙，模式与串口参数只允许待机时更改；真实／模拟记录与曲线库隔离。AI 仅分析和提出候选，采用、保存与应用由操作者明确执行。

树莓派 ARM64 部署包内置 Node、源码及安装／启动／打开脚本，首次安装 Python 依赖需要网络。控制服务默认仅监听本机；电脑使用已有 SSH 登录建立隧道后访问 `http://127.0.0.1:18000`。完整步骤见 [真实设备连接与调试](docs/guides/real-device-setup.md)。目标树莓派、TC4S 通讯、测温、加热与真实急停仍需接机验收。

更新记录集中在 [UPDATE_LOG](roaster/UPDATE_LOG.md)，既有图表与 AI 验收见 [v3.30.1 QA](docs/qa/kl-home-chart-v3.30.1.md)，整理记录在 [项目清理记录](docs/maintenance/2026-10-22-workspace-cleanup.md)。Flutter 历史实现位于独立分支 `feature/flutter-app`，不混入当前目录。
