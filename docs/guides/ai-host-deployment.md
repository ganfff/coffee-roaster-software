# AI 宿主与配对

桌面和网页默认使用当前后端的共享 AI 服务；Windows 桌面还可在「设置 → AI 服务 → AI 运行位置」主动切换本机独立模式。配置、凭据、对话和附件均归所选宿主，两个宿主的数据不会自动搬运。「迁移旧本机配置与历史」经确认后由原生宿主直接传到已配对后端，密钥不经过网页界面；原文件保留。AI 模块不导入控制器、串口或硬件模块，故障或未安装时不会阻断烘焙控制。

## 树莓派部署

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

若配置了自定义 `ai.data_dir`，配对管理命令必须同时传 `--data-dir /同一数据目录`。订阅登录由供应商决定交互方式：远程网页上的 Claude 可选复制授权码；ChatGPT 可回填浏览器最后显示的完整回调 URL；Copilot、Kimi Code、xAI 使用设备码。不要将固定回调地址改成树莓派局域网地址。授权过期或额度失败时由用户选择重新登录或切换渠道，软件不自动改走 API 计费。

AI API 位于 `/api/v1/ai`：`GET /status`、`POST /pair`、`POST /rpc`、`GET /clients`、`DELETE /clients/{id}`、`GET /events`、`WS /ws`。RPC 仅允许 AI 方法，拒绝 `initialize` 和任意控制器命令；主密钥只由宿主注入。事件可按游标读取；断线后可调用 `runs.events` 恢复具体请求的事件。网络断开不会自动重发用户消息。

本机验证仅证明源码、打包与安全模拟协议。ARM64 Node 执行、树莓派系统兼容和真实设备必须在目标设备另行验收。
