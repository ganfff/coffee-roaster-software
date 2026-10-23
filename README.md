# Ganf's 咖啡烘焙机

当前交付：**桌面 0.6.1 / Web 3.27**。包含烘焙控制、曲线与记录、原生 `.kpro/.klog` 工作台，以及本机 AI 对话与六套完整主题。

| 目录 | 内容 | 入口 |
| --- | --- | --- |
| `roaster/` | Python 后端、设备控制、共享网页、AI 和离线格式引擎 | [运行说明](roaster/README.md) |
| `desktop/` | Tauri 桌面壳、AI worker、打包与安全模拟器 | [开发与构建](desktop/README.md) |
| `docs/` | 使用指南、当前验收、历史归档与维护记录 | [文档索引](docs/README.md) |
| `scripts/` | 项目维护和生成物清理 | [目录约定](docs/project-structure.md) |
| `dist/` | 本机最新安装包、ARM64 部署包和校验文件；不进入 Git | [交付记录](docs/qa/local-ai-v3.27/delivery-report.json) |

原生工作台提供编辑、ABC、参数、日志、比较、变换、合并及导出，内置离线说明中心。AI 提供多轮聊天、ChatGPT/Kimi Code 账户模型目录、官方 Claude Code 连接、API Key、自定义接口和可撤销候选；真实授权由用户实际使用时完成。使用见 [工作台指南](docs/guides/native-workbench.md)、[AI 配对与部署](docs/guides/ai-host-deployment.md)。

## 常用命令

免安装预览：双击根目录 **调试网页.cmd**，打开 `http://127.0.0.1:18180`。源码修改后刷新即可。原生开发窗口使用 `desktop` 下的 `npm run dev:sim`。安装包与设备后端的关系见 [调试与打包说明](docs/guides/debugging-and-packaging.md)。

```powershell
Set-Location desktop
npm ci
npm run check:frontend
npm run dev:sim -- --freeze   # 安全模拟器与原生窗口

Set-Location ..
./scripts/clean-workspace.ps1 -Build -OldPackages          # 预览
./scripts/clean-workspace.ps1 -Build -OldPackages -Apply   # 清理生成物，保留最新版
```

Windows 只做源码、前端、模拟器和打包验证；不要启动真实串口、GPIO 或加热控制。设备操作只在已明确授权的目标设备上执行。AI 仅分析和提出候选，不控制设备。

更新记录集中在 [UPDATE_LOG](roaster/UPDATE_LOG.md)，当前验证在 [v3.27 QA](docs/qa/local-ai-v3.27.md)，整理记录在 [项目清理记录](docs/maintenance/2026-10-22-workspace-cleanup.md)。Flutter 历史实现位于独立分支 `feature/flutter-app`，不混入当前目录。
