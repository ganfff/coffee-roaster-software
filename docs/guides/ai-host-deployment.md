# 本机 AI 配置

桌面 0.6.1 起固定使用这台电脑的 AI 服务。设备连接地址只负责烘焙机数据，不切换 AI 账户、凭据或历史。设置移除运行位置、设备共享、配对客户端和远端迁移入口；旧共享选择会被忽略，本机历史保留。AI 服务不导入控制器、串口或硬件模块。

## 连接本地模型

先启动 LM Studio、Ollama 等兼容服务，在「设置 → AI 账户 → 添加账户 → 本地模型」填写实际接口地址，选择协议后点击「连接本地模型」。页面提供本机地址示例，模型从该服务的目录加载，不需要 API Key。连接失败或目录为空时显示原因，不自动切换其他服务。

正式桌面账户与历史保存在 Windows 应用数据目录 `com.ganf.roaster/ai/host`，主密钥由 Windows 凭据管理器保护。网页调试使用独立的 `%LOCALAPPDATA%/RoasterDesktop/dev-web/ai`，以当前用户 DPAPI 保护主密钥。账户数据、凭据和运行记录不进入 Git。

浏览器直接访问本机后端时，同源请求、环回 Host 与环回对端地址同时成立即可使用本机 AI，无需设备配对。局域网、异源请求或其他域名不会获得这项本机权限。

配置保存在本机也可以连接用户选择的在线供应商；这些供应商会接收用户发送的消息。配置与历史不会向其他设备共享。

## 首次连接账户

在「设置 → AI 账户」添加 ChatGPT、Claude Code 或 Kimi Code。点击后请求系统默认浏览器打开官方页面；页面同时保留打开按钮、复制地址和适用的设备码。被浏览器拦截或系统打开失败时显示具体恢复操作。官方授权完成后，自动获取模型目录、选择默认模型并保存。授权由用户自行完成。

Claude 订阅通过用户安装的官方 Claude Code 连接，最低版本 2.1.248；页面提供官方安装/升级入口。凭据由官方客户端管理，本软件不读取其凭据文件。模型通过初始化控制通道获取；对话关闭文件、命令与浏览器工具，曲线提案仍经本软件校验和人工采用。远程使用时，官方客户端需要安装并登录在 AI 服务所在机器。

Copilot、xAI、API Key 与自定义接口位于「其他订阅与 API」。新自定义服务需要提供模型目录接口；目录不可用时显示恢复说明，已有连接保留。高级参数保留密钥更新、自定义请求头、回复上限和思考强度。

断开或移除账户均保留聊天历史。移除后必须主动选择另一账户才会继续发送；移除 Claude 连接不退出其官方全局登录。失败不会自动更换收费渠道或自动重发消息。

## 历史后端兼容：树莓派部署

以下保留旧版后端的部署与配对接口说明；当前桌面界面不连接这些共享接口，也不会自动迁移或同步本机配置。

在 `desktop` 运行 `node tools/package-ai-arm64.mjs`，生成 `dist/RoasterAIHost_<version>_linux_arm64.tar.gz` 及 SHA256 文件。脚本固定 Node v24.21.0 的 ARM64 官方归档校验值，打包后端源码、共享前端及独立 AI bundle。它不安装系统软件、不启动控制器、不修改设备。

将归档解到目标设备新目录，按内置 `AI-HOST-INSTALL.md` 配置 Python 虚拟环境和设备配置。升级时保留原 `config.yaml` 与 `data`，切勿用示例覆盖设备串口配置。AI 默认数据目录是后端目录下 `data/ai`；可在配置中设置：

```yaml
ai:
  enabled: true
  data_dir: /home/pi/roaster/data/ai
  # 默认使用随包 runtime；仅在自定义安装位置时指定：
  # node_path: /home/pi/roaster/runtime/node/bin/node
  # service_path: /home/pi/roaster/runtime/ai/service.mjs
```

Node 服务按需启动，进程终止时进行中的请求不会自动重发；后续新请求可启动新进程。Linux AI 数据目录为 0700，主密钥文件为 0600；Windows 主密钥保存在 Credential Manager。删除主密钥会使对应加密凭据无法解密，备份应同时保留密钥与加密数据，并与源码分开。

## 本机生成配对码

在后端工作目录运行以下命令。此入口只操作 AI 配对文件，不启动 Web 服务或控制器：

```sh
.venv/bin/python -m src.ai pair-code
.venv/bin/python -m src.ai clients
.venv/bin/python -m src.ai revoke --client-id <ID>
```

8 位配对码 10 分钟有效，最多 5 次错误尝试，成功后立即失效。网页配对使用 HttpOnly、SameSite=Strict Cookie；原生桌面将配对 bearer 存入 Windows 凭据管理器。配对令牌有效期 30 天，可随时撤销。配对文件仅保存令牌和配对码的哈希。浏览器 AI 端点只接受同源访问，不继承控机 API 的宽泛 CORS。原生代理只向配对凭据对应的精确 HTTP(S) origin 发送令牌，禁止重定向。

若配置了自定义 `ai.data_dir`，配对管理命令必须同时传 `--data-dir /同一数据目录`。订阅登录由供应商决定交互方式：Claude 交由官方客户端登录；ChatGPT 可回填浏览器最后显示的完整回调 URL；Copilot、Kimi Code、xAI 使用设备码。不要将固定回调地址改成树莓派局域网地址。授权过期或额度失败时由用户选择重新登录或切换渠道，软件不自动改走 API 计费。

AI API 位于 `/api/v1/ai`：`GET /status`、`POST /pair`、`POST /rpc`、`GET /clients`、`DELETE /clients/{id}`、`GET /events`、`WS /ws`。RPC 仅允许 AI 方法，拒绝 `initialize` 和任意控制器命令；主密钥只由宿主注入。事件可按游标读取；断线后可调用 `runs.events` 恢复具体请求的事件。网络断开不会自动重发用户消息。

本机验证仅证明源码、打包与安全模拟协议。ARM64 Node 执行、树莓派系统兼容和真实设备必须在目标设备另行验收。
