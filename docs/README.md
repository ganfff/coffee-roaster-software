# 项目文档索引

项目级文档按用途集中管理；模块自身的运行说明仍放在对应模块目录中。

## 架构

- [`project-structure.md`](project-structure.md)：仓库目录、生成物和分支边界。

## 开发指南

- [`guides/flutter-migration.md`](guides/flutter-migration.md)：Flutter 客户端移植、API 契约与验证说明。
- [`guides/native-workbench.md`](guides/native-workbench.md)：原生文件工作台、功能迁移和曲线库衔接。
- [`guides/ai-host-deployment.md`](guides/ai-host-deployment.md)：共享 AI、三种认证配置、配对及 ARM64 部署。
- [`../desktop/README.md`](../desktop/README.md)：Tauri 桌面开发、模拟器与构建。
- [`../roaster/README.md`](../roaster/README.md)：核心服务、硬件配置与烘焙流程。

## 设计与质量

- [`qa/calm-canvas-v3.21.md`](qa/calm-canvas-v3.21.md)：v3.21 原生 Tauri 两轮设计验收。
- [`qa/workbench-v3.23.md`](qa/workbench-v3.23.md)：原生核心、真实语料、界面与独立引擎验证。
- [`qa/ai-workspace-v3.24.md`](qa/ai-workspace-v3.24.md)：完整会话、认证、原生候选及桌面/网页验证。
- [`design/calm-canvas/calm-canvas-reference.png`](design/calm-canvas/calm-canvas-reference.png)：Calm Canvas 设计基准。
- `design/calm-canvas/`：1366×800、1024×640 与并排对照截图。

## 模块内长期记录

- [`../roaster/UPDATE_LOG.md`](../roaster/UPDATE_LOG.md)：版本变更记录。
- [`../roaster/PITFALLS.md`](../roaster/PITFALLS.md)：项目陷阱和安全契约。
