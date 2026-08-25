# 项目结构约定

## 稳定源码目录

```text
咖啡烘焙机-软件/
├── roaster/                 # 核心服务、硬件接口和共享 Web 前端
│   ├── src/                 # Python 业务代码
│   ├── static/              # HTML/CSS/JavaScript/Chart.js
│   ├── data/profiles/       # 可版本化烘焙曲线
│   └── tools/               # 明确需要人工运行的硬件测试工具
├── desktop/                 # Tauri 壳
│   ├── src-tauri/           # Rust/Tauri 配置
│   └── tools/               # 模拟器、静态检查和资源生成脚本
├── docs/                    # 项目级说明、设计与 QA
├── scripts/                 # 仓库维护脚本
└── README.md                # 唯一根入口
```

不要随意移动 `roaster/` 或 `desktop/`：`desktop/src-tauri/tauri.conf.json` 的 `frontendDist` 依赖两者的稳定相对位置。

## 分支边界

- `codex/tauri-calm-canvas`：v3.21 Tauri/Web 前端完成态。
- `feature/flutter-app`：完整 Flutter 客户端；它不是当前 Tauri 分支的工作目录组成部分。
- 当前整理分支只调整仓库入口、文档层级和可再生生成物，不合并 Flutter 功能，也不修改控制算法或硬件通信。

## 不进入 Git 的内容

| 类型 | 示例 | 恢复方式 |
|---|---|---|
| Node 依赖 | `desktop/node_modules/` | `npm install` |
| Rust/Tauri 构建 | `desktop/src-tauri/target/` | `npm run build:debug` 或 `npm run dev` |
| Python 缓存 | `__pycache__/`, `.pytest_cache/` | 运行时自动生成 |
| Flutter 缓存 | `.dart_tool/`, `build/`, `flutter/ephemeral/` | `flutter pub get` / `flutter build` |
| 本机工具配置 | `.agents/`, `.codex/`, `.vscode/` | 本机保留，不提交 |
| 运行记录 | `roaster/data/records/` | 真实运行时生成，禁止混入源码提交 |

## 新文件放置规则

- 面向使用者的运行说明放到所属模块 `README.md`。
- 跨模块指南放到 `docs/guides/`，视觉证据放到 `docs/design/<主题>/`，验收报告放到 `docs/qa/`。
- 可重复执行的仓库维护命令放到 `scripts/`；模块专用工具留在模块自己的 `tools/`。
- 根目录只保留仓库入口、Git 配置与一级模块目录。
