# Ganf's 咖啡烘焙机软件

这是咖啡烘焙机控制系统的统一工作区。稳定运行路径保持简短：核心后端与 Web 前端在 `roaster/`，Tauri 桌面壳在 `desktop/`，项目级资料统一进入 `docs/`。

## 目录入口

| 目录 | 用途 | 首选入口 |
|---|---|---|
| `roaster/` | FastAPI、WebSocket、控制器、TC4S/RS485、Web 前端 | [`roaster/README.md`](roaster/README.md) |
| `desktop/` | 复用 Web 前端的 Tauri 桌面应用 | [`desktop/README.md`](desktop/README.md) |
| `docs/` | 架构、迁移指南、设计基准和 QA 证据 | [`docs/README.md`](docs/README.md) |
| `scripts/` | 仓库级维护脚本 | [`scripts/clean-workspace.ps1`](scripts/clean-workspace.ps1) |

Flutter 完整实现保存在独立分支 `feature/flutter-app`，避免当前 Tauri 工作区同时混入两套平台生成文件。迁移说明见 [`docs/guides/flutter-migration.md`](docs/guides/flutter-migration.md)。

## 常用命令

```powershell
# Tauri 前端静态检查
Set-Location desktop
npm install
npm run check:frontend

# 安全模拟器 + 原生 Tauri 窗口（不访问真实串口）
npm run dev:sim -- --freeze

# 预览可清理的生成物；确认后再实际清理
Set-Location ..
.\scripts\clean-workspace.ps1
.\scripts\clean-workspace.ps1 -Apply
```

## 开发边界

- Windows 只做源码、前端、模拟器和桌面构建验证；不要启动真实串口、GPIO 或加热控制。
- `desktop/node_modules/`、`desktop/src-tauri/target/`、Python/Flutter 缓存和本地 IDE 配置不纳入 Git。
- `.agents/`、`.codex/`、`.vscode/` 与 `.claude/settings.local.json` 是本机工具配置，保留在本地但不属于产品源码。
- 更新前先看 [`roaster/UPDATE_LOG.md`](roaster/UPDATE_LOG.md)；修改已知敏感路径前先看 [`roaster/PITFALLS.md`](roaster/PITFALLS.md)。
