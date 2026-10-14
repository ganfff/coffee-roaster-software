# RoasterDesktop — Tauri 桌面壳

把 `roaster/static/` 里的网页前端**原样**包进一个 Windows / macOS / Linux 桌面应用。
不重写任何 UI 代码；桌面壳通过 HTTP/WebSocket 连接烘焙机后端（FastAPI）。

```
┌─────────────────────────────┐
│  RoasterDesktop (Tauri 壳)   │     ┌──────────────────────────┐
│  ┌───────────────────────┐  │     │  烘焙机后端 (树莓派/本机)  │
│  │ WebView2 渲染         │  │     │  python main.py          │
│  │ roaster/static 前端   │──┼────►│  FastAPI :8000           │──► RS485/TC4S
│  │ (与浏览器版同一份代码) │  │     │  REST /api/v1/* + WS /ws │
│  └───────────────────────┘  │     └──────────────────────────┘
└─────────────────────────────┘
```

## 一、环境准备（首次一次性）

### Windows

1. **Node.js** LTS — https://nodejs.org （本仓库开发机已装 v25）
2. **Rust** — `winget install Rustlang.Rustup`（已装 1.97）；装完重开终端
3. **MSVC 生成工具** — Visual Studio 2022（Community 即可）勾选「使用 C++ 的桌面开发」工作负载（本机已装）
4. **WebView2** — Windows 11 自带；Win10 老机器装「WebView2 Runtime」

### macOS（如需出 Mac 版）

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
```

### Linux（如需出 Linux 版）

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
```

## 二、开发

```bash
cd desktop
npm install        # 首次：装 @tauri-apps/cli
npm run dev        # 开发模式：打开桌面窗口，改 roaster/static/ 里文件后自动热重载
```

只做界面开发或验收时，使用完全隔离真实串口的模拟器：

```bash
npm run dev:sim -- --freeze             # 固定在 05:42 的烘焙中场景
npm run dev:sim -- --scenario=idle      # 待机
npm run dev:sim -- --scenario=cooling   # 冷却
npm run dev:sim -- --scenario=error     # 错误
npm run check:frontend                  # 静态契约与资源检查
```

模拟器只绑定本机 HTTP/WebSocket，不导入 Python 硬件模块，也不会打开 TC4S/RS485 端口。最终界面验收仍应在 `roaster-desktop.exe` 原生窗口内完成。

窗口打开后，默认连 `http://localhost:8000`（本机后端）。

**连局域网上的树莓派**：点窗口右下角半透明的 **⚙** 按钮 → 填 `http://<树莓派IP>:8000`
→ 「保存并重连」。地址存在本机 localStorage，只需设置一次。

> ⚙ 按钮只在 Tauri 壳里出现；浏览器打开同一前端时不会显示。
> 实现见 `roaster/static/js/tauri-adapter.js`（浏览器环境下它是完全的空操作）。

## 三、打包分发

```bash
cd desktop
npm run build
```

产物：

| 文件 | 说明 |
|---|---|
| `src-tauri/target/release/roaster-desktop.exe` | 绿色单文件，可直接运行 |
| `src-tauri/target/release/bundle/nsis/RoasterDesktop_0.1.0_x64-setup.exe` | **给客户的安装包**（NSIS，~5-10MB） |

客户安装体验：双击 setup.exe → 下一步 → 桌面出现图标 → 打开即用（首次点 ⚙ 填一次烘焙机地址）。

版本号升级：同时改 `desktop/package.json`、`desktop/src-tauri/Cargo.toml`、`desktop/src-tauri/tauri.conf.json` 三处的 `version`。

## 四、macOS / Linux 打包

在对应系统上执行同样的 `npm run build`（Tauri 不支持 Windows 上交叉打包 Mac）：

- macOS 产物：`bundle/dmg/*.dmg`、`bundle/macos/*.app`
- Linux 产物：`bundle/deb/*.deb`、`bundle/appimage/*.AppImage`

把 `tauri.conf.json` 的 `bundle.targets` 改成 `"all"` 可一次出全部格式。

## 五、桌面版的远程升级（对接 OTA 计划）

Tauri 官方有 **updater 插件**（签名 + 自动下载替换），建议路线：

```bash
npm run tauri add updater
```

1. 生成签名密钥：`npx tauri signer generate -w ~/.tauri/roaster.key`
2. `tauri.conf.json` 配置 `plugins.updater.endpoints` 指向你的 manifest（如 `https://你的服务器/roaster-desktop/latest.json`）
3. 每次发版：`npm run build` 后把 `bundle/` 产物 + `.sig` 签名上传到服务器，更新 manifest 里的版本号和下载地址
4. 客户端启动时自动检查、弹窗确认、下载替换、重启完成

manifest 格式与完整步骤见官方文档 https://v2.tauri.app/plugin/updater/ 。
这套 manifest 协议可以和树莓派应用级 OTA、ESP32 OTA **共用同一台静态文件服务器**。

## 六、目录结构

```
desktop/
├── package.json            # npm 脚本与 Tauri CLI
├── tools/
│   ├── check-frontend.mjs  # HTML/CSS/JS/资源与安全契约检查
│   ├── dev-sim.mjs         # 安全模拟器 + Tauri 联合启动
│   ├── roaster-simulator.mjs # 仅本机 HTTP/WebSocket 模拟数据
│   ├── sync-icons.mjs      # 可重复生成离线 Phosphor 图标子集
│   ├── gen-icon.js         # 应用图标生成器（纯 Node，无依赖）
│   └── icon-source.png     # 1024x1024 源图标
└── src-tauri/
    ├── tauri.conf.json     # 窗口尺寸/标题/CSP/打包配置（frontendDist 指向 ../../roaster/static）
    ├── Cargo.toml          # Rust 依赖
    ├── build.rs
    ├── capabilities/
    │   └── default.json    # 权限：默认 + 允许新开窗口（导出预览用）
    ├── icons/              # npx tauri icon 生成的全套图标
    └── src/
        └── main.rs         # 最小入口（壳无原生逻辑）
```

## 七、已知边界

- **记录导出（CSV/JSON）**：桌面版里点导出会新开一个系统窗口显示内容（后端返回的是
  内联文本而非附件下载）。要「保存为文件」对话框体验，后续加
  `tauri-plugin-dialog` + `tauri-plugin-fs` 即可，前端不用改。
- **iOS 不支持**：Tauri 移动端目前不成熟；苹果手机用户继续用浏览器/PWA。
- **树莓派本机不需要这个壳**：本机触摸屏场景继续用 Chromium Kiosk 模式即可，
  桌面壳是给「Windows/Mac 电脑远程操作烘焙机」的场景用的。

## AI 烘焙助手（桌面 v0.2.0 / Web 资源 v3.22）

Windows 桌面版增加记录复盘、曲线设计/优化和实时只读辅导。普通网页与树莓派 kiosk 保持共享页面，第一版不提供 AI 入口。模型不会启动/结束烘焙、修改 SV、预测参数或当前执行曲线。

1. 打开「设置 → AI 服务」，选择供应商并保存 API Key，点击「加载模型目录」选择模型，再点击「测试连接」。测试会产生少量模型调用。DeepSeek、Moonshot 中国、OpenAI、Anthropic、Gemini、OpenRouter 使用各自目录；自定义模式填写 OpenAI Chat Completions 兼容 API 根地址与模型 ID（例如 `http://127.0.0.1:1234/v1`），本地无密钥服务可留空 Key。
2. 「烘焙记录」打开一锅记录，展开「AI 烘焙复盘」。可保存豆子、处理法、重量、目标及杯测笔记；没有杯测时只评价过程，没有完整事件时不编造 DTR。「按建议设计下一锅」在待机时进入原始快照的编辑器副本。
3. 「曲线管理」点击「AI 设计曲线」或卡片上的「AI 优化」。编辑器支持锁定前段秒数和选择历史参考；候选以紫色虚线叠加，采用前展示节点与自动结束阈值变化。采用后可以撤销/重做，再「保存曲线」生成新 UUID，返回曲线库手动应用。
4. 烘焙中展开「AI 实时辅导」，点击「开启本锅持续辅导」。按阶段变化和约每分钟生成建议，也可单次提问；暂停、出豆、断线、ERROR、切换设备或离开页面均终止相关请求。下一锅需重新开启。

密钥通过 Windows 凭据管理器保存；AI 配置与对话保存在系统应用数据目录的 `com.ganf.roaster/ai` 下，按设备和对象区分。前端只读取是否配置密钥；不写入 localStorage、不随 Git 上传。自定义地址不支持 URL 内嵌密码或查询参数中的密钥，密钥使用独立输入框。「删除密钥」移除当前供应商/地址凭据；「新对话」清除当前对象对话。

### 运行环境与打包变化

`npm run prepare:ai` 下载并核验锁定的 Node 24 LTS（版本与 SHA256 在 `ai/runtime-manifest.json`），生成拆分的 ESM `.mjs` 与 Tauri IPC 前端桥。`dev`、`dev:sim` 与 `build` 自动准备资源；无需额外安装 Python AI SDK。

正式 NSIS 安装包包含 Node 和 AI 资源，客户无需安装系统 Node。绿色版现在必须整体分发 `roaster-desktop.exe`、`ai-node.exe`、`ai/` 与 `node-manifest.json`；不再是单个 EXE。旧的单文件/5–10MB 说明仅适用于 v0.1.0。Node 与生成物位于被忽略的 `desktop/runtime/`，源码、锁文件与下载校验清单进入 Git。

后端需同步本次代码并重新启动，以提供 `/api/v1/analysis/context`、候选校验及副本保存接口。旧后端可继续复盘已有记录；实时辅导和安全保存 AI 曲线会提示更新后端。

### 验证命令

```powershell
npm run prepare:ai
npm run test:ai
npm run test:ai:ui
npm run check:frontend
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

`test:ai:ui` 使用本机安全模拟器和模拟原生 IPC，浏览器需已安装 Microsoft Edge，使用端口 8031；它不启动 Python 硬件后端或请求云端模型。后端 ASGI 测试注入 fake controller、不运行硬件 lifespan：

```powershell
Set-Location ../roaster
uv run --python 3.12 --with-requirements requirements.txt --with httpx python -m unittest discover -s tests -v
```

设计、接口和验证边界见 [`docs/qa/ai-v3.22.md`](../docs/qa/ai-v3.22.md)。
