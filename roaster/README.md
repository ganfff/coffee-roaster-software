# Ganf's 咖啡烘焙机控制系统

一款运行在树莓派 4B 上的专业热风咖啡烘焙机上位机软件，采用苹果风格深色统一配色，全面对齐 Artisan 烘焙控制体验。支持实时双轴温度/ROR 曲线显示（温度 Catmull-Rom 样条插值，ROR 简单分段差分）、可视化曲线编辑器（撤销重做、键盘快捷键、网格吸附）、事件记录与三阶段自动计算（含温度与发展时间）、顶部关键事件温度显示、超前预测分阶段配置 + 相机 EV 风格偏移微调、曲线库卡片网格、烘焙记录顺序命名与背景曲线快照对比、以及完整的曲线导入导出功能。

## 项目结构

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录
├── README.md                    # 本文件
├── PITFALLS.md                  # 已知坑点与注意事项
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举（运行时使用 IDLE/ROASTING/COOLING/ERROR；WAITING/PREHEATING 仅供历史 RoastRecord 反序列化兼容）
│   │   ├── models.py            # Pydantic 数据模型（RoastRecord 含 seq_no/display_name/profile_snapshot；RoasterStatus 含 lookahead_used/current_phase/phase_lookahead_config；PhaseLookaheadConfig）
│   │   └── roaster_controller.py # 核心控制器（IDLE→ROASTING 直通、log_event drop 触发 end_roast、分阶段 lookahead、偏移微调）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/
│   │   └── default-light-roast.json # 默认浅焙曲线（7 节点耶加雪菲）
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面
    ├── editor.html              # 曲线编辑器页面
    ├── css/
    │   ├── style.css            # 主页面样式
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑
        └── editor.js            # 编辑器逻辑
```

## 硬件与环境要求

- Python 3.10+
- Raspberry Pi OS (Bullseye/Bookworm) 或通用 Linux
- 台泉 TC4S 温控器，通过 USB-RS485 连接（默认 `/dev/ttyUSB0`）
- 触摸屏或外接显示器，建议分辨率 1280x700 以上
- 局域网浏览器（支持 Chrome / Edge / Firefox）

## 安装与启动

### 1. 进入项目目录

```bash
cd roaster
```

### 2. 安装依赖

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

> 若 `pyserial-asyncio-fast` 安装失败，可替换为 `pyserial-asyncio==0.6`。

### 3. 配置串口参数

编辑 `config.yaml`：

```yaml
serial:
  port: "/dev/ttyUSB0"
  baudrate: 9600
  slave_id: 1
```

> 配置文件不支持 `preheat:` 节（状态机不走预热中间态）。如老配置仍含 `preheat:` 节，启动时会打 warning 自动忽略，不会报错退出。
>
> `pid:` 节启动时一次加载，运行时只读（TC4S 不支持在线 PID 调节）。`predictive_control:` 节作为全局 fallback。`phase_lookahead:` 节支持脱水期/梅纳期/发展期三阶段独立超前预测配置。

### 4. 启动服务

```bash
python main.py
```

服务默认监听 `0.0.0.0:8000`。

- 本机访问：`http://localhost:8000`
- 局域网访问：`http://<树莓派IP>:8000`

## 主界面使用说明

### 顶部状态栏

- **温度**：当前实测温度（PV，亮绿色）
- **设定温度**：当前目标温度（SV，亮红色）
- **升温率**：ROR（Rate of Rise，亮蓝色，单位 °C/min）
- **已用时间**：从「入豆」起计时的 MM:SS
- **全屏按钮**：一键切换浏览器全屏，适合烘焙时专注观察

### 关键事件温度条

位于状态栏下方，实时显示当前烘焙中已记录的关键事件时间与温度：

- **转黄**：格式 `MM:SS @ XX.X°C`，记录转黄事件后自动显示
- **一爆**：格式 `MM:SS @ XX.X°C`，记录一爆开始后自动显示

烘焙结束自动清空。

### 阶段颜色条

位于关键事件温度条下方，**动态显示**三阶段时长与占比：

- **脱水期**（蓝色）：入豆 → 转黄，烘焙开始时即显示
- **梅纳期**（橙色）：转黄 → 一爆开始，记录转黄后自动显示
- **发展期**（绿色）：一爆开始 → 出豆，记录一爆后自动显示

未到达的阶段自动隐藏，避免挤占空间。

### 主图表区

采用 **双 Y 轴** 设计，将温度与升温率整合在同一图表中：

- **左轴**：温度 0~300°C
- **右轴**：升温率（ROR）
- **X 轴**：以分钟为单位显示（格式 mm:ss）

图表中的五条线：
1. **温度**（亮绿实线）：实时实测温度
2. **设定温度**（亮红虚线）：系统下发的目标温度
3. **曲线**（灰色虚线）：待机时当前应用的预设曲线；烘焙中显示本锅后端确认的目标曲线（全程常驻，Catmull-Rom 样条平滑）
4. **ROR**（亮蓝实线+半透明填充）：实时升温速率（前端 EWMA 平滑）
5. **ROR 预览**（浅蓝虚线）：当前选中曲线的目标升温率（简单分段差分）

点击图例可隐藏/显示对应数据线。

### 烘焙控制流程

完整的一锅烘焙 workflow：

1. **选择曲线**：在「曲线管理」标签页的卡片网格中选择一条烘焙曲线并「应用」；主界面顶部只读显示当前曲线名，点击可跳转曲线管理 tab
2. **开始烘焙**：放好豆子、调整好转速后，点击 **开始烘焙**（大号独立主按钮），系统直接进入 `ROASTING` 状态，自动记录入豆事件在 0:00，并按曲线下发首段 SV
3. **事件记录**：烘焙过程中点击事件按钮（转黄/一爆/一爆结束/二爆/二爆结束/出豆），自动标注在图表上；按下后按钮变为绿色 active 高亮 + ✓ 角标 + `m:ss · 温度°` badge
4. **出豆即结束**：点击 **出豆** 按钮（橙色脉冲），后端 `log_event(type='drop')` 自动触发 `end_roast`，进入 `COOLING` 状态
5. **保存确认**：系统弹出确认框「是否保存此锅烘焙记录？」，选择后清屏回到待机，开始下一锅
6. **紧急停止**：右下角嵌入小方框急停按钮始终可见，双击确认触发紧急停止（IDLE 时灰色禁用，ROASTING 时红色高亮，z-index 1020 高于模态层）

> **状态机说明**：运行时仅使用 4 个状态 `IDLE / ROASTING / COOLING / ERROR`。`WAITING / PREHEATING` 在 `RoasterState` 枚举中保留字面量但已 DEPRECATED，仅供历史 `RoastRecord` JSON 反序列化兼容，运行时不会触发。

### 快捷事件操作栏

位于控制面板顶部，**烘焙过程中始终可见**，6 个事件按钮横向排列：

- **转黄** / **一爆** / **一爆结束** / **二爆** / **二爆结束** / **出豆**
- 点击后事件自动以**垂直虚线+标签**形式标注在主图表上
- 入豆事件在点击「开始烘焙」时由后端自动记录于 0:00，无需手动点击
- 按下事件按钮后保持 **active 高亮**（绿色背景 + ✓ 角标），并显示 `m:ss · 温度°` badge，避免重复点击
- **出豆按钮**：橙色渐变背景、`@keyframes dropPulse` 脉冲（仅 `ROASTING` 启用，幅度 `scale(1.02)`），按下后兼任「结束烘焙」自动进入冷却阶段

### 阶段统计

阶段信息由顶部阶段颜色条与事件按钮 badge 统一提供，烘焙结束后自动清空：

- **脱水期**（蓝色）：入豆 → 转黄
- **梅纳期**（橙色）：转黄 → 一爆开始
- **发展期**（绿色）：一爆开始 → 出豆
- 同时显示各阶段时长、占比与发展时间比率（DTR）

### 曲线管理

「曲线管理」标签页采用**卡片网格库**布局。顶部三个全局按钮：

- **新建曲线**：跳转到专业曲线编辑器页面
- **导入曲线**：从本地 JSON 文件导入曲线到曲线库
- **刷新**：重新拉取曲线列表

下方为曲线卡片网格（`auto-fill, minmax(220px, 1fr)`，gap 12px）。每张卡片显示：

- 曲线名称
- 节点数与总时长
- **200×50 SVG sparkline 缩略图**：直接看到曲线形状，1 秒识别
- hover/选中时浮现「**应用 / 导出 / 删除**」三个按钮

待机时「应用」点击后将选中曲线加载到主图表预览；「导出」会触发 `/api/v1/profiles/{id}/export` 端点下载 JSON 文件；「删除」从曲线库移除。

> 曲线选择完全通过卡片网格完成，主页面无下拉框。烘焙中应用/删除曲线以及导入后的自动应用会被禁用或忽略，本锅目标曲线以后端状态显示为准。

### 超前预测控制

位于主界面烘焙控制栏，采用**分阶段配置 + 偏移微调**模式：

- **三阶段独立配置**：脱水期 / 梅纳期 / 发展期各有一个 0~30s 输入框，分别对应不同阶段的基准超前量
  - 后端 `_maybe_adjust_sv_locked` 自动根据 `current_phase` 读取对应阶段值
  - 老 config 无 `phase_lookahead` 节时 fallback 到全局 `lookahead_sec`
- **偏移微调**：相机 EV 风格刻度尺/滑块，运行时微调范围 ±3.0s，步进 0.1s
  - 通过 `update_lookahead_offset` WS 命令下发，纯内存不持久化，重启归零
- **当前实际超前量**：UI 同时显示「当前设定值」与「实际超前量」（含自适应误差修正叠加后的本周期实际 lookahead）
- 设为 0 等价于关闭预测，退化为传统 SV 跟踪

> **PID 参数固化**：运行时无 PID 调节面板（TC4S 不支持在线调节）。`config.yaml:pid:` 节在启动时一次加载，运行时只读。

### 连接状态指示灯

底部状态栏左右两侧各有一个状态点：

- **WS 指示灯**（左侧）：WebSocket 前端↔后端连接状态，在线绿色常亮，断线红色常亮
- **TC4S 指示灯**（右侧）：后端↔硬件串口连接状态，在线绿色常亮，断线红色常亮
- 两个指示灯完全独立，方便区分「前端掉线」还是「硬件断线」

### 烘焙记录

在「烘焙记录」标签页中：

- 历史记录列表使用 **`log00X` 顺序命名**（`log001`、`log002`、…），肉眼追踪「我昨天的第 3 锅」非常直观；列表 meta 行追加 profile_name 副标题
- 点击某条记录展开详情：
  - 标题为 `display_name` + `profile_name` 副标题
  - 节点信息块（节点数 / 终温）来自当时记录的曲线快照
  - 详情图表新增第 4 条线「**背景曲线**」（灰虚线），数据来自 `record.profile_snapshot.nodes` 经样条插值还原
  - 即使原曲线后续被修改/删除，历史记录仍可完整重现当时的目标曲线
  - 右上角「**图表全屏**」按钮可一键放大记录详情图表（`position: fixed; inset: 20px;`），适合树莓派小屏下查看细节
- 支持导出 CSV / JSON
- **日志对比**：勾选最多 2 条记录，点击「对比选中」可在主图表中叠加显示两条记录的温度曲线，便于比较烘焙一致性

## 曲线编辑器使用说明

访问路径：在主页面点击「新建曲线」即可进入 `/editor.html`。

### 基本操作

- **拖拽节点**：用鼠标或触摸在图表上直接拖动已有的橙色圆点（控制点），调整该节点的时间与温度
- **精确编辑**：右侧面板「节点列表」中点击某一行可选中该节点；在「选中节点」输入框中输入精确数值
- **删除节点**：选中节点后点击「删除选中」按钮，或按 `Delete` / `Backspace`（至少保留 2 个节点）
- **添加节点**：点击「+ 添加节点」按钮，或按 `Ctrl+N`，在曲线末尾按相同间隔新增节点
- **插入节点**：鼠标悬停在节点列表某行时显示「+」按钮；触摸屏等 coarse pointer 下按钮常显，点击后在两节点间中点插入（温度通过样条插值自动计算）
- **复制节点**：选中节点后按 `Ctrl+D`，复制到后方 30 秒处

### 撤销与重做

- `Ctrl+Z` 撤销上一步操作
- `Ctrl+Y` 或 `Ctrl+Shift+Z` 重做
- 支持的操作：移动节点、添加节点、删除节点、插入节点、复制节点、微调节点、精确编辑
- 最大保留 50 步历史

### 拖拽量化与网格吸附

- 普通拖拽默认丝滑，时间按 1 秒、温度按 0.1°C 最小量化
- 按住 `Shift` 拖拽时吸附到 5 秒 / 0.5°C 网格，便于严格对齐

### 键盘微调节点

选中节点后：

- `↑/↓`：温度 ±0.5°C
- `Shift+↑/↓`：温度 ±5°C
- `←/→`：时间 ±1 秒
- `Shift+←/→`：时间 ±10 秒
- `Esc`：取消选中

### 样条曲线

编辑器使用 **Catmull-Rom 样条插值**渲染温度曲线，控制点之间自动平滑过渡，无需手动插入辅助节点。

### ROR 预览

编辑器会实时计算升温率（°C/min），并在右侧「ROR 预览」区列出每段的升温速率。ROR 采用 **简单分段差分法**：
- 每两个控制点之间计算 `dT/dt × 60`，取该段中点作为 ROR 数据点
- 直接反映用户在控制点之间设定的升温率，简单可预测
- 通过拖拽节点自由调整每段的 ROR，无需额外平滑按钮

### 结束温度

在编辑器顶部输入「结束温度」，当烘焙过程中实测温度到达此值时，系统将自动结束烘焙并进入冷却阶段。

### 保存与导出

- **保存曲线**：填写名称和结束温度后点击保存，自动回到主页面并加入曲线库
- **导出 JSON**：将当前曲线导出为 JSON 文件，方便备份或在其他设备上导入

## 配置文件说明

`config.yaml` 关键字段：

| 字段 | 说明 |
|------|------|
| `serial.port` | TC4S 串口设备路径 |
| `serial.baudrate` | 串口波特率（默认 9600） |
| `serial.slave_id` | Modbus 从机地址 |
| `poll_interval` | TC4S 读取轮询间隔（秒） |
| `broadcast_interval` | WebSocket 广播间隔（秒） |
| `pid` | 默认 PID 参数（启动时一次加载，运行时只读） |
| `max_safe_temperature` | 过温硬限制（°C），超过即进入 ERROR 状态（默认 250.0） |
| `ror_window_sec` | ROR 计算窗口（秒），建议 10~20 |
| `predictive_control.lookahead_sec` | 全局超前预测时长（秒），默认 15.0（全局 fallback，`phase_lookahead` 缺失时使用）；0 等价关闭预测 |
| `predictive_control.adaptive_enabled` | 是否启用自适应误差修正（默认 true） |
| `predictive_control.adaptive_max_extra_sec` | 自适应附加超前量上限（秒），默认 10.0 |
| `predictive_control.adaptive_error_threshold` | 触发自适应的 PV-nominal 误差阈值（°C），默认 3.0 |
| `phase_lookahead.drying_sec` | 脱水期基准超前量（秒），范围 0~30，默认 1.0 |
| `phase_lookahead.maillard_sec` | 梅纳期基准超前量（秒），范围 0~30，默认 0.5 |
| `phase_lookahead.development_sec` | 发展期基准超前量（秒），范围 0~30，默认 1.0 |

## WebSocket 命令

前端通过 `ws://<host>/ws` 连接，可发送如下 JSON 命令：

```json
{ "cmd": "start", "profile_id": "default-light-roast" }
{ "cmd": "save_and_clear" }
{ "cmd": "discard_and_clear" }
{ "cmd": "emergency_stop" }
{ "cmd": "event", "type": "yellowing", "note": "" }
{ "cmd": "event", "type": "first_crack", "note": "" }
{ "cmd": "event", "type": "first_crack_end", "note": "" }
{ "cmd": "event", "type": "second_crack", "note": "" }
{ "cmd": "event", "type": "second_crack_end", "note": "" }
{ "cmd": "event", "type": "drop", "note": "" }
{ "cmd": "set_phase_lookahead", "phase": "drying", "value": 1.0 }
{ "cmd": "set_lookahead", "params": { "value": 10.0 } }
{ "cmd": "set_lookahead_offset", "params": { "value": 0.5 } }
```

> `cmd=set_phase_lookahead` 写入脱水期/梅纳期/发展期基础超前量，`phase` 可取 `drying` / `maillard` / `development`，value 范围 0~30s（超出会被静默 clamp）。`cmd=set_lookahead` 写入全局 `lookahead_sec` fallback，value 范围 0~30s。`cmd=set_lookahead_offset` 为运行时偏移微调（±3.0s，不持久化，重启归零）。`cmd=end` 保留作向后兼容入口，前端不再调用（出豆事件已自动触发结束烘焙）。

## 开发建议

- **串口权限问题**：若启动后无法读取温度，执行 `sudo usermod -aG dialout $USER` 后重新登录。
- **前端开发**：直接修改 `static/` 下的文件，刷新浏览器即可生效，无需重启后端。
- **曲线设计**：浅焙建议总时长 10~12 分钟，深焙 13~16 分钟。编辑器默认提供 7 节点的耶加雪菲浅焙模板（0~7:15），可自由增减。
- **树莓派触摸屏**：按钮最小高度 44px，满足触摸目标要求；全屏模式适合专注观察。
- **急停按钮**：双击确认机制，第一次点击变红提示"再次点击确认"，2 秒内第二次点击才执行，防止误触。
- **ERROR 状态**：系统进入 ERROR 后，前端会显示全屏红色阻断横幅，仅允许点击「复位」恢复；常见触发原因包括硬件断线、过温（>250°C）、SV 写入连续失败。
- **曲线库导出端点**：曲线卡片网格中的「导出」按钮走 `GET /api/v1/profiles/{id}/export`，返回 `Content-Disposition: attachment` 形式的 JSON 文件下载，前端通过 `window.open(url, '_blank')` 触发。
- **烘焙记录命名**：记录使用 `log00X` 顺序命名（数据库列 `seq_no` + `display_name`），新增记录会自动 `MAX(seq_no)+1`；同时记录会嵌入当时使用的曲线快照（`profile_snapshot_json`），便于历史回放。
- **坑点汇总**：开发或二次修改时，请参阅 [PITFALLS.md](PITFALLS.md) 了解已知的并发锁、状态机、重试、SQLite ALTER 兼容、超前预测边界、`current_phase` 空值处理、`lookahead_offset` 运行时归零等注意事项。

## 更新日志

详见 [UPDATE_LOG.md](UPDATE_LOG.md)。

## 许可证

MIT License
