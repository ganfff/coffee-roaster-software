# 项目目录约定

当前产品入口保持 `roaster/` 与 `desktop/` 的相对位置，Tauri 的 `frontendDist` 指向共享网页资源。

```text
咖啡烘焙机-软件/
├── roaster/
│   ├── src/          # core/hardware/services/web/ai/workbench
│   ├── static/       # 共享网页、AI 聊天、工作台及离线资源
│   ├── tests/        # 契约与格式测试，fixtures 为合成数据
│   └── data/         # profiles 可版本化；records/ai 属于本机运行数据
├── desktop/
│   ├── ai/           # Node AI 服务与测试
│   ├── src-tauri/    # Rust/Tauri
│   └── tools/        # 构建、模拟和验证
├── docs/
│   ├── guides/       # 当前使用/部署指南
│   ├── qa/           # 当前证据；archive/ 保存历史
│   ├── design/       # 仍在使用的设计基准
│   └── maintenance/  # 整理与同步记录
├── scripts/          # 仓库维护命令
├── dist/             # 本机最新交付，不进入 Git
└── README.md         # 唯一根入口
```

## 清理范围

使用 PowerShell 7 执行 `scripts/clean-workspace.ps1`，默认只预览；加 `-Apply` 才删除。

| 参数 | 范围 |
| --- | --- |
| 无额外参数 | Python/pytest 缓存和本轮隔离 WebView QA 缓存 |
| `-Build` | 重复打包 staging、Rust debug 与 release 编译中间物；保留 release 程序和运行资源 |
| `-OldPackages` | 已识别的旧版交付和旧上传临时包；根据 `desktop/package.json` 保留当前版本 |
| `-Dependencies` | 额外删除可由 `npm ci` 恢复的 Node 依赖，日常整理不必使用 |
| `-Report 路径` | 在项目内保存清理清单和字节数 |

脚本拒绝删除 Git 已跟踪路径、项目外路径和指向生成目录外的链接。不清理设备配置、曲线、记录、AI 数据、凭据、开发虚拟环境或最新运行时。删除编译中间物后，下一次 Rust 构建会重新编译。

## 文件放置与同步

- 模块使用说明放各模块 README；跨模块操作放 `docs/guides/`；产品版本变化放 `roaster/UPDATE_LOG.md`。
- 当前验收放 `docs/qa/`，旧版材料连同图片/报告移入 `docs/qa/archive/`，保留可追溯链接。
- 发布文件只保留本机 `dist/` 当前版本；校验值和验证边界进入 Git。安装包、依赖、缓存与凭据不放源码仓库。
- Git 主交付分支为 `main`，工作分支按任务使用 `codex/` 前缀；同步前 fetch 并比较提交，正常快进，不强推。
- KL 参考项目独立保留在相邻目录；本项目包含已迁移引擎，不再嵌套另一套 Git 仓库。可选语料用 `WORKBENCH_REFERENCE` 指定。
- Flutter 历史实现留在 `feature/flutter-app`，不在当前目录复制生成文件。本机 `.agents/`、`.codex/`、`.vscode/` 与 Claude 本地设置保留，不作为产品源码。
