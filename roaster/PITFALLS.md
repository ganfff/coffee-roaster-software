# 已知坑点与注意事项

本文档记录咖啡烘焙机控制系统在开发、维护与二次修改过程中需要特别注意的设计权衡与潜在陷阱。

---

## 1. `asyncio.Lock` 不可重入

`tc4s_async.py` 中的 `_write_lock` 是标准 `asyncio.Lock`，**不可重入**。

- `_on_tc4s_data` 持有 `_state_lock` 时，其内部调用的子方法若需写串口，必须使用 `*_locked` 后缀版本（如 `set_sv_locked`），否则会导致死锁。
- 新增任何在锁内调用的子方法时，务必同步提供对应的 `_locked` 变体。

## 2. `_state_lock` 内 await I/O 会阻塞状态机

`roaster_controller.py` 的 `_state_lock` 保护状态机一致性，但锁内存在 `await tc4s.set_sv()` 等 I/O 操作。

- 后果：I/O 等待期间状态机无法响应其他事件（如急停、事件记录）。
- 权衡：这是**安全性优先**的设计。SV 写入与状态转移必须原子化，避免竞态导致加热器在不应加热时开启。
- 修改建议：若需提升并发响应，可将 I/O 与状态转移拆分为"预检查（无锁）→ I/O → 确认转移（持锁）"三阶段，但需仔细验证原子性。

## 3. `send_command` 重试期间持有 `_write_lock` 最长约 1 秒

`tc4s_async.py` 的 `send_command` 在重试期间始终持有 `_write_lock`。

- 最大等待时间：0.05 + 0.15 + 0.45 = 0.65s，加上串口响应超时约 0.3s，总计约 1s。
- 影响：高频调用 `set_sv`（如每轮询周期一次）时，若偶发失败，后续写操作会排队等待。
- 缓解：当前轮询间隔为 1s，实际冲突概率较低；若缩短轮询间隔，需评估锁竞争。

## 4. ERROR 状态下急停按钮仍有双击确认

当前设计：ERROR 状态下前端显示全屏阻断横幅，单击「复位」即可恢复。

- 但急停按钮（物理/屏幕）的双击确认机制在 ERROR 状态下仍然生效。
- 这意味着如果用户想通过急停按钮复位，仍需双击，与横幅上的「单击复位」提示不一致。
- 未来优化：可在 ERROR 状态下临时禁用急停按钮的双击确认，或统一为单击逻辑。

## 5. TC4S 断线后 `set_sv(0)` 可能失败

当 TC4S 断线触发 ERROR 状态时，`roaster_controller.py` 会尝试 `set_sv(0)` 关闭加热器。

- 若此时串口已完全断开，`set_sv(0)` 会失败，error_reason 会附加「加热器关闭失败」警告。
- 这是预期行为：硬件已不可达，软件层面只能记录警告，无法强制关闭。
- 安全依赖：硬件层应配置独立的过温硬件保护（如 TC4S 自身的报警输出），不能仅依赖软件关加热器。

## 6. 自动重连的指数退避上限

`tc4s_async.py` 的 `_reconnect_loop` 最大重连 30 次，退避间隔从 2s 指数增长到 30s。

- 最坏情况下，从首次断开到放弃重连约需 10 分钟以上。
- 若树莓派与 TC4S 之间为 USB-RS485 转换器，拔插后通常需要 1~3 次重连即可恢复。
- 若 30 次后仍未恢复，系统会永久停留在 `disconnected` 状态，需人工检查硬件并重启服务。

## 7. 状态回调异常被吞掉

`tc4s_async.py` 对每个数据回调单独 `try/except`，防止用户回调抛异常拖垮轮询。

- 副作用：回调内部的异常不会向上传播，也不会被记录（除非回调自己处理）。
- 调试建议：在 `register_status_callback` 的回调函数内部自行加 `try/except + logging`，否则异常静默消失。

## 8. 旧曲线 float `time` 在「分/秒」双输入下被静默取整

`editor.js` 的 `selectNode` 用 `Math.floor(total / 60)` 和 `Math.round(total % 60)` 拆分时间填充输入框，`updateSelectedFromInputs` 提交时通过 `m * 60 + s` 重组为整数秒。

- 后果：若历史曲线 JSON 中 `time` 是浮点数（例如 `90.5`），双输入面板显示 `1分31秒`；用户编辑该节点（即使只是确认）后，落盘值会变成整数 `91` 秒，丢失 0.5s 精度。
- 这是符合存储契约的良性行为：`tempNodes` 内部从未真正使用浮点秒（拖拽 snap 到 5s、微调 ±1s），曲线编辑器的所有路径都生成整数秒。
- 注意点：若未来引入亚秒级精度（例如毫秒级控制点），需把 `selectNode` 拆分逻辑改为带小数的 `total / 60`，并在输入框中暴露毫秒位或保留浮点存储。

## 9. `set_sv` 仅接受 int，超前预测产生的小数温度会被截断

`tc4s_async.py` 的 `set_sv` 内部以 `int(temperature)` 落寄存器，但 v3.10 引入超前预测后，`profile.get_target_temp(elapsed + lookahead)` 在样条插值下可能返回浮点温度（如 187.4°C），最终写入 TC4S 的会被截断为 187。

- 影响：后端
- 解决方案：浅焙 PID 控制对 1°C 内精度不敏感，当前可接受；若未来需要亚度精度（如恒温烘焙、SCA 表征实验），需把 TC4S 寄存器升级为 0.1°C 单位编码并改 `set_sv` 逻辑（同时确认 TC4S 协议手册中是否支持 0.1°C 寄存器）。
- 相关文件：`src/hardware/tc4s_async.py`、`src/core/roaster_controller.py`

## 10. `lookahead_sec=0` 是合法配置，等价于退化为传统跟踪

把超前预测滑块拉到 0 后，`base_la=0`；自适应分支按公式 `extra_la = ratio * ror_factor * adaptive_max_extra_sec` 仍会计算，但 nominal 与 PV 同步即视作不落后，所以 `extra_la` 多数时间为 0，整体退化为「SV = profile(elapsed)」的旧行为。

- 影响：后端、前端
- 解决方案：作为合法的「关闭预测」模式保留，调试 PID 时可临时归零；UI 上让用户明白滑块 0 = 关闭预测，避免「调到 0 后效果反而变差」的困惑。
- 相关文件：`src/core/roaster_controller.py:_maybe_adjust_sv_locked`、`static/index.html` 滑块说明

## 11. SQLite `ALTER TABLE ADD COLUMN` 只能吞 `duplicate column`

v3.10 引入 4 个新列（`seq_no` / `display_name` / `profile_snapshot_json` / `duration_sec`），但老用户 `roasts.db` 已存在；SQLite 同一列重复 ALTER 会报 `duplicate column name` 错。

- 影响：后端（数据持久化）
- 解决方案：每个 `ALTER TABLE` 语句单独 `try/except`；仅当 `OperationalError` 内容为 `duplicate column` 时视作幂等并跳过，其他 `OperationalError` 必须记录日志后重新抛出，避免真实迁移失败被静默吞掉。
- 相关文件：`src/services/data_manager.py:init_db`

## 12. `profile_snapshot` 让每锅记录额外 +1~3KB

v3.10 起每条 record 嵌入完整曲线 JSON（节点 + 元信息），即便几年后曲线被改/删仍能完整还原历史；但单条记录体积从 ~1KB 涨到 2~4KB。

- 影响：后端
- 解决方案：长期可接受（一年 100 锅也不到 0.5MB 净增）；若极度在乎容量可抽离 `profile_snapshot` 到独立表用 `profile_hash` 共享，但收益不抵复杂度，目前不推荐。
- 相关文件：`src/services/data_manager.py:save_record`、`src/core/models.py:RoastRecord`

## 13. 自适应 lookahead 的 `ror_factor` 公式假设 ROR 在 [0, 30] °C/min

`ror_factor = clamp(1.5 - max(ror, 0)/30, 0.5, 1.5)`，当 ROR > 30 时直接饱和到 0.5；某些极端浅焙可能在脱水末段 ROR 短暂冲到 25-35 °C/min。

- 影响：后端（控制算法）
- 解决方案：当前线性映射在常见烘焙范围（5-25 °C/min）行为良好，饱和段也只是把 `extra_la` 收紧并不出错；若未来需要更精细控制，可改成对数或分段映射。
- 相关文件：`src/core/roaster_controller.py:_maybe_adjust_sv_locked`

## 14. `current_lookahead` 仅在 ROASTING 中刷新，IDLE/COOLING 下保留上次值

UI 上 `lookahead_used` 显示的是 `getattr(self, "current_lookahead", base_la)`；ROASTING 之外的状态下该字段不会被重置，前端会看到上一锅烘焙结束时的 lookahead 值定格在面板上。

- 影响：前端（视觉）
- 解决方案：进入 IDLE 时显式 `self.current_lookahead = 0.0`，或前端在 IDLE 状态下隐藏该字段——任选其一即可，目前是次要 UX 问题。
- 相关文件：`src/core/roaster_controller.py`、`static/js/app.js`

---

## v3.11 新增坑点 (2026-04-28)

### 15. 历史 RoastRecord 反序列化兼容

v3.11 删除了运行时 `PREHEATING / WAITING` 状态，但保留了 `RoasterState` 枚举的字面量并加 `# DEPRECATED v3.11` 注释。

- **问题**：旧 `RoastRecord` JSON 中 events 数组可能含 `type='preheat_*'` 字符串，需保证可加载。
- **影响**：后端（数据持久化）、前端（事件渲染）
- **解决方案**：`RoastEvent.type` 是字符串而非枚举，反序列化天然兼容；前端 `eventLabel` 映射需补充对未知 type 的兜底显示（"未知事件" 或原 type 字符串），避免历史记录详情出现 `undefined`。
- **相关文件**：`src/core/events.py`、`src/core/models.py:RoastEvent`、`static/js/app.js:eventLabel`

### 16. WS race：drop 触发 end_roast 后并发 log_event

出豆事件触发 `asyncio.create_task(self.end_roast())` 后，可能仍有 1-2 个 `log_event` 已排队等锁。

- **问题**：end_roast 已把 state 切到 COOLING，但等锁的 log_event 拿到锁时仍按 ROASTING 处理逻辑，写入「不该有」的事件。
- **影响**：后端
- **解决方案**：`log_event` 入锁后第一行重判 `if self.state != RoasterState.ROASTING: return`（噪音消除），此时 drop 已是序列里最后一个有效事件。
- **相关文件**：`src/core/roaster_controller.py:log_event`

### 17. Chart.js tooltip filter 副作用

`filter: ctx => ctx.parsed.y != null && !Number.isNaN(ctx.parsed.y)` 可能让 `callbacks.title` 收到空 items 数组。

- **问题**：所有 dataset 在该 X 值下都被过滤后 `items.length === 0`，访问 `items[0].parsed.x` 抛 `Cannot read property 'parsed' of undefined`。
- **影响**：前端
- **解决方案**：`callbacks.title` 第一行 `if (!items?.length) return ''`，安全降级为空标题。
- **相关文件**：`static/js/app.js` chart options `plugins.tooltip.callbacks.title`

### 18. slider step=0.1 浮点精度

JS 浮点会出 `12.300000001`。

- **问题**：滑块拖动到 12.3 后下次读值变成 12.299999999...，UI 显示丑陋且 set_lookahead 命令带尾巴。
- **影响**：前端
- **解决方案**：所有 set/get 走 `round1(v) = Math.round(v * 10) / 10` 一次，并 clamp 到 `[0, 30]` 防越界。微调按钮 ±0.1 也走同一函数。
- **相关文件**：`static/js/app.js:round1`、所有 lookahead 滑块/微调按钮的 set 路径

### 19. prefers-reduced-motion 兼容

某些用户系统设置无障碍，密集动画反而变卡。

- **问题**：`dropPulse` 1.6s + `pulseOnline/Offline` 0.6~2s + 全局 hover translateY/scale 在前庭功能敏感用户上会引发眩晕。
- **影响**：前端（UX/无障碍）
- **解决方案**：CSS 全局加
  ```css
  @media (prefers-reduced-motion: reduce) {
    *::before, *::after, * {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
  ```
- **相关文件**：`static/css/style.css` 末尾

### 20. `.btn-grid` 选择器列数依赖

原 `.btn-grid > .btn:nth-child(1):nth-last-child(3) { grid-column: 1 / -1 }` 假设 3 个子元素（btn-charge / btn-end / btn-start）；v3.11 删除 charge/end 后只剩 1 个 btn-start。

- **问题**：选择器不再匹配，btn-start 不再跨满行，UI 排版断裂。
- **影响**：前端
- **解决方案**：改为 `.btn-grid > .btn:only-child { grid-column: 1 / -1 }`，单子元素时自动跨满，未来无论 1/2/3 子元素都能正确处理。
- **相关文件**：`static/css/style.css:.btn-grid`

### 21. fixed 嵌入小方框急停按钮 z-index 冲突

- **问题**：`#error-overlay` z-index 9999；常规模态层 1010；嵌入小方框急停按钮（`.estop-box` / `.estop-btn`）必须既高于普通模态（让用户在模态打开时仍能点急停）又低于 ERROR overlay（让 ERROR 状态下急停不与复位横幅重叠）。
- **影响**：前端
- **解决方案**：`.estop-box { z-index: 1020 }`，落在 1010 < x < 9999 区间。
- **相关文件**：`static/css/style.css:.estop-box`、`.estop-btn`、`#error-overlay`
- **备注**：v3.18 重构为嵌入小方框结构后，z-index 约束依然成立，作用在 `.estop-box` 容器上。

### 22. drop → end 后事件按钮 active 重置

COOLING 状态下事件栏可能仍可见，旧的 active class 持续显示。

- **问题**：用户把上一锅的 active 状态误认为本锅已按过事件，重复确认混乱。
- **影响**：前端
- **解决方案**：`syncEventActionsBar([])` 在 `optimisticResetToIdle` 中显式清空；同时 state 广播每次都带 events 同步，events 为空时按钮自动清 active + badge。
- **相关文件**：`static/js/app.js:syncEventActionsBar`、`optimisticResetToIdle`

### 23. `#detail-stats` 删除范围混淆

v3.11 删除的是**主页** `#event-float .stats-grid`（顶部小窗 4 张统计卡），**保留** `#detail-stats`（record-detail 模态内的烘焙详情统计）。

- **问题**：两者命名相近，按 id 直接 `document.getElementById('detail-stats')` 可能误删历史详情面板。
- **影响**：前端
- **解决方案**：清理脚本 / Edit 操作时，确认上下文是「主页烘焙中实时统计」还是「历史详情查看器」；前者 id 为 `event-float`/`stats-grid`，后者 id 为 `detail-stats`，**不要混淆**。
- **相关文件**：`static/index.html`、`static/js/app.js:showRecordDetail`

### 24. config.yaml 老配置 preheat 节兼容

v3.11 删除 `preheat:` 节，但老用户配置可能仍含此节。

- **问题**：直接 `KeyError` 退出会让升级用户在没看到提示前就崩溃。
- **影响**：后端（启动）
- **解决方案**：`main.py` 启动时检测到 `config.get('preheat')` 非空打 warning 日志（非 error），自动忽略不退出；用户后续可主动清理 yaml。
- **相关文件**：`main.py`

### 25. 触摸屏 hover 残留

树莓派触摸屏环境下 `:hover` 在松手后可能保留 `transform: translateY(-1px) scale(1.02)`。

- **问题**：用户点完按钮后视觉上按钮"卡住"在 hover 态，下次点击前以为系统卡死。
- **影响**：前端（树莓派触摸屏专用）
- **解决方案**：可考虑后续优化用 `@media (hover: hover)` 包裹全局 hover 规则，让纯触摸设备不应用 hover 变换；目前作为已知 UX 瑕疵记录。
- **相关文件**：`static/css/style.css` 全局 button:hover

### 26. `#event-actions-bar` 是 flex 不是 grid

plan 原假设 grid 布局，实际是 flex。

- **问题**：出豆按钮想跨整行突出时，套用 grid 的 `grid-column: 1 / -1` 在 flex 容器中无效。
- **影响**：前端
- **解决方案**：flex 容器中通过 `flex: 1.6`（或更大比重）让出豆按钮占更大宽度；如未来改 grid 需同步调整为 `grid-column: 1 / -1`。
- **相关文件**：`static/css/style.css:#event-actions-bar`、`.btn-drop`

## v3.12 新增坑点

27. `current_phase` 在 IDLE/COOLING/ERROR 状态下为 None
    - `_get_current_phase` 只在有 charge 事件后才开始判断阶段，IDLE/COOLING/ERROR 时返回 None
    - 前端需做好空值处理，不要假设 current_phase 始终有值

28. `phase_lookahead` 运行时配置不持久化到文件
    - `update_phase_lookahead` 只更新内存中的 `self.config`，重启后恢复为 `config.yaml` 中的值
    - 如需持久化修改，需手动编辑 config.yaml 或通过其他持久化机制实现

29. `lookahead_offset` 纯运行时，重启归零
    - 偏移微调值 `_lookahead_offset` 不写入任何文件，重启服务后自动归零
    - 每锅烘焙前检查偏移是否为预期值

30. 老 config 无 `phase_lookahead` 时的 fallback 行为
    - 老 config.yaml 缺少 `phase_lookahead` 节时，系统 fallback 到全局 `lookahead_sec`
    - 三阶段输入框会显示相同的 fallback 值，用户可能误以为已配置分阶段值
    - 建议升级 config.yaml 时手动添加 `phase_lookahead` 节

31. `#profile-select` 删除后曲线选择完全依赖卡片网格
    - v3.12 删除了 `<select>` 下拉框，曲线选择/应用/导入全部通过 `#profile-cards` 卡片网格完成
    - 确保卡片网格渲染正常，否则用户无法选择曲线开始烘焙

## v3.13 新增坑点 (2026-04-29)

### 32. WS 广播覆盖正在交互的控件

v3.13 之前用户拖动 phase-lookahead slider / lookahead-offset slider 时，每 ~500ms 一次的 WS 广播会把值覆盖回后端旧值，导致拖动有「弹回」抖动。

- **问题**：广播间隔 ~500ms,用户连续拖动时下一拍广播会把 input 值改回旧值,UI 出现视觉抖动且 set 命令派发被打断
- **影响**：前端
- **解决方案**：`static/js/app.js` 新增 `shouldSkipUpdate(el)` 通过 `el.dataset._lastUserEdit` 判定 1500ms 窗口,`handleStateUpdate` 内对相关控件先检查 skip;1500ms 依据是「广播 500ms × 3 帧容错」,松开 slider 后下一拍广播不会被「吸」回旧值
- **相关文件**：`static/js/app.js:shouldSkipUpdate`、`markUserEdit`、`handleStateUpdate`

### 33. Chart.js v4 `update('none')` 必须用字符串

Chart.js v4 的 `update(mode)` 第二参数必须是字符串字面量(`'none'` / `'active'` / `'resize'` 等),不能用数字 0 或 false。

- **问题**：写成 `chart.update(0)` / `chart.update(false)` 不会报错,但 `mode` 参数被忽略,默认动画路径仍然执行,树莓派 4B 上掉帧
- **影响**：前端
- **解决方案**：所有禁用动画的 update 调用统一改为 `roastChart.update('none')`(已替换 7 处:264/282/412/418/497/1571/1602)
- **相关文件**：`static/js/app.js`

### 34. 编辑器拖动吸附语义反转(v3.13)

v3.13 反转了 v3.12 之前的吸附语义:**默认丝滑(1s/0.1℃ 量化), Shift 才吸附到 5s/0.5℃ 网格**;此前是「默认 5s 网格,Shift 精确」。

- **问题**：习惯 v3.12 之前操作的用户会发现「拖动手感变细腻了但需要严格对齐 5s 节点时反而要按 Shift」;若未来再次反转会让肌肉记忆混乱
- **影响**：前端(UX)
- **解决方案**：`editor.html` 提示条文案明确写「按住 Shift 吸附 / 默认丝滑」,代码注释 `SNAP_TIME_DEFAULT` / `SNAP_TIME_GRID` 注明语义反转;若再次调整需同步更新提示文案与注释
- **相关文件**：`static/js/editor.js:30-31, 190-197`、`static/editor.html:42`

### 35. config.yaml 默认值升级时旧文件不会自动覆盖

v3.13 把 `phase_lookahead` 三阶段默认值从 15.0 改为 1.0/0.5/1.0,但 v3.12 用户已有的 `config.yaml` 里旧值 15.0 不会被自动覆盖。

- **问题**：升级用户启动后三阶段超前预测仍然是 15.0(旧 yaml 值优先),与新的"小默认值"设计意图不符;若用户没看 UPDATE_LOG 会困惑「为什么浅焙超调没改善」
- **影响**：后端(配置)、前端(显示)
- **解决方案**：升级时在 README/UPDATE_LOG 显式提示「老用户需手动把 `phase_lookahead.{drying,maillard,development}_sec` 改为 1.0/0.5/1.0」;或将来加入启动时检测旧默认值并打 warning(目前未做)
- **相关文件**：`config.yaml:27-30`、`src/core/models.py:PhaseLookaheadConfig`

### 36. backdrop-filter blur 在树莓派 4B 性能监测

v3.13 多处启用 `backdrop-filter: blur(...)`(`.roast-section` blur(10px) / `.floating-emergency` blur(8px)),WebKit 在树莓派 4B 上 GPU 加速并不总是稳定。

- **问题**：长时间烘焙(60+ 分钟)中,部分场景下 backdrop-filter 会触发软件渲染回退,导致整体掉帧明显;Chromium 版本不同表现也不同
- **影响**：前端(性能)
- **解决方案**：上线前在树莓派 4B 上跑一锅完整烘焙观察 FPS;若掉帧,降级方案是把 `backdrop-filter: blur(Xpx)` 改为半透明纯色背景(`background: rgba(28,28,30,0.85)`),牺牲玻璃拟态保性能
- **相关文件**：`static/css/style.css:.roast-section`、`.floating-emergency`

## v3.14 新增坑点 (2026-04-29)

### 37. `backdrop-filter: blur` 在树莓派 4B Chromium 上与 canvas 同合成树会卷入闪烁

v3.13 在 `.roast-section` 与 `.floating-emergency` 启用 `backdrop-filter: blur(...)` 实现玻璃拟态,但拖动控制面板内的 slider 时,邻居 `<canvas>`(`#charts-panel`)区域出现历史绘制内容短暂消失/闪烁。

- **问题**：父元素的 backdrop-filter 强制每帧重新采样合成树,canvas 被卷入软件渲染回退路径,PV/SV/ROR 历史曲线在 slider 拖动期间反复消失重画
- **影响**：前端(性能/视觉)
- **解决方案**：v3.14 已删除 `.roast-section` / `.floating-emergency` 的 `backdrop-filter`;改用半透明纯色背景 `var(--glass)` (rgba 28,28,30,0.85);同时给 canvas 父容器加 `contain: paint; isolation: isolate;` 形成独立合成层,外部 dirty 不再回卷 canvas
- **应避免**：任何与 canvas 共享祖先合成树的元素再次引入 `backdrop-filter` / `filter: blur(>2px)` / `mix-blend-mode`;新增视觉特效前先在树莓派 4B 实机验证 FPS
- **相关文件**：`static/css/style.css:.roast-section`、`.floating-emergency`、`#charts-panel`

### 38. `dragging-slider` 状态类必须有 window 级 capture pointerup/pointercancel 兜底

v3.14 在 slider 拖动期间用 `body.dragging-slider` 类关闭 transition 静默 repaint;但仅在元素自身上绑定 pointerup 时,触摸或鼠标在 slider 短轨道外释放可能漏触。

- **问题**：触摸或鼠标在 slider 短轨道外释放时,pointerup 可能不冒泡到原始绑定,body 残留 `.dragging-slider` 类,导致 transition 永久关闭(后续 hover/focus 动效全部失效)
- **影响**：前端(交互/视觉)
- **解决方案**：v3.14 在 `installSliderDragGuard` 末尾注册 `window.addEventListener('pointerup', forceCleanup, true)` 和 `pointercancel` 同样规则(capture=true 优先收到),`forceCleanup` 检查 body 类命中则强制清零并移除 class
- **应避免**：仅在元素自身上绑定 pointerup;新增任何「按下进入临时 body 类、抬起退出」的交互必须配 window 级 capture 兜底
- **相关文件**：`static/js/app.js:installSliderDragGuard`

### 39. `cubic-bezier` 字面量必须变量化

v3.13 在 30+ 处散落两套缓动字面量(苹果系 `(0.32,0.72,0,1)` 与 Material 系 `(0.4,0,0.2,1)`),后续维护时易出现风格不一致。

- **问题**：手写字面量分散导致风格漂移;某些 transition 用了 spring 风,某些用了 Material 风,视觉一致性下降
- **影响**：前端(代码可维护性/视觉一致性)
- **解决方案**：v3.14 在 `:root` 定义 `--ease-apple: cubic-bezier(0.32, 0.72, 0, 1)`(spring 风)和 `--ease-apple-fast: cubic-bezier(0.4, 0, 0.2, 1)`(数据驱动场景),所有 transition / animation 用变量引用
- **应避免**：直接写字面量 cubic-bezier;新增动画必须用 `var(--ease-apple)` 或 `var(--ease-apple-fast)`;grep `cubic-bezier` 应只命中 `:root` 的 2 行变量定义
- **相关文件**：`static/css/style.css:root`、全文 transition / animation

### 40. EV 三角指针位置需减半宽校正(指针尖端对齐刻度)

v3.14 偏移微调改成相机 EV 风格刻度尺,橙色三角指针走 `transform: translateX` 合成层。

- **问题**：CSS 三角形 14px 宽,若直接 `translateX(ratio * trackWidth)` 会让指针**左边缘**对齐刻度,看起来偏左
- **影响**：前端(视觉对齐)
- **解决方案**：v3.14 `updateEvPointer` 中 `transform: translateX(${ratio * trackWidth - 7}px)`(-7 = 半宽校正),让三角尖端正中刻度
- **应避免**：忘记半宽校正,或用错指针宽度;若调整三角形 CSS 宽度需同步更新 `-7` 这个偏移
- **相关文件**：`static/js/app.js:updateEvPointer`、`static/css/style.css:.ev-pointer`

### 41. 进度条三段权重必须有 events 优先 + profile 兜底

v3.14 烘焙进度从百分比改成三段进度条(脱水 / 美拉德 / 发展),三段宽度由权重决定。

- **问题**：单纯按 profile 时长 1:1:1 平分三段时,实际烘焙 yellowing / first_crack 事件早 / 晚发生会导致进度条与真实进度脱节(例如发展期实际很短但占了 1/3 宽度)
- **影响**：前端(视觉)
- **解决方案**：v3.14 `updateProgress` 优先用 `msg.events` 中的 yellowing / first_crack 时间戳计算真实段宽,事件未发生时回退到 profile 时长比例,profile 缺失时再回退 1fr 1fr 1fr 默认
- **应避免**：硬编码权重;或仅依赖单一数据源;权重变化也要纳入 `lastProgressSig` 签名(已纳入三段权重),否则 ratioQ 不变但权重变时 DOM 不更新
- **相关文件**：`static/js/app.js:updateProgress`

## v3.15 新增坑点 (2026-04-29)

### 42. requestAnimationFrame 节流叠加 WS 立即 broadcast 导致图表视觉刷数据

v3.13 引入 phase slider 三段独立配置时,命令节流改用 `requestAnimationFrame`(约 60fps,16ms 间隔)。每帧 `sendCmd('set_phase_lookahead', ...)` 在后端 `web_api.py` 触发 `manager.broadcast(controller.get_state_payload())`,前端 `handleStateUpdate` 每帧执行 `updateEventAnnotations` + `roastChart.update('none')`,叠加 `appendChartData` 在同一 elapsed 秒内的高频追加,造成视觉上「已记录烘焙曲线被刷新」的假象。

- **问题**：用户报告「调节曲线超前预测参数时前面的烘焙数据依旧被刷」,跨多个版本未修复
- **影响**：前端(视觉/可信度)
- **解决方案**：参考 V3.11 实现,将 `initPhaseLookahead` 与 `initLookaheadOffset` 内的 raf 节流改为 `setTimeout(100ms)` debounce。一次拖动只发 1 条命令,后端 broadcast 频次回到 0.5s 自然节流水平
- **应避免**：在高频拖动控件上使用 raf 节流并直接发送 WS 命令;任何「每命令立即 broadcast」的后端路径都必须配套保守的前端 debounce(≥100ms)
- **相关文件**：`roaster/static/js/app.js:1115-1149` `initPhaseLookahead`、`roaster/static/js/app.js:1168-1195` `initLookaheadOffset`、`roaster/src/web/web_api.py:112-130` 后端立即 broadcast 路径、`V3.11/roaster/static/js/app.js:982-1036` 参考实现

## v3.16 新增坑点 (2026-04-29)

### 43. WebSocket 高频广播下 `handleStateUpdate` 必须对所有 DOM 写做「值未变跳过」

v3.15 把 raf 节流改为 `setTimeout(100ms)` debounce 后,用户实测仍报告「整个图表/网页都在刷,烘焙数据被刷掉」。复盘发现:WebSocket 每 0.5s 推送一次 state 帧,只要 `handleStateUpdate` 在每帧无差别地写入 DOM(即使值没变),浏览器合成层会被反复 invalidate,给用户造成「整个图表/网页都在刷」的视觉错觉,且会与 chart.js 的 raf 渲染竞争 CPU。

- **问题**：用户拖动曲线超前预测滑动条 → 命令以 setTimeout 100ms debounce 发出 → 服务端立即把新 config 通过 WS 反推 → 前端 `handleStateUpdate` 无差别重建 progress bar / 重写 6 个 input.value / 重置 `--ev-pointer-transform` / 重建 annotations + `chart.update('none')` → 累积出「刷图」视觉效果。即使没有用户操作,0.5s 的常规 broadcast 也会一直触发重 DOM,因此单独把 raf 改成 100ms setTimeout 不能解决该问题
- **影响**：前端(视觉/可信度/性能)
- **解决方案**：每个高频写 DOM 点必须加「值未变就跳过」短路。具体覆盖:
  - **进度条段**:`updateProgress` 拆 `lastStructureSig`(state | phase | 三段宽度 | totalEnd)+ `lastPositionSig`(`Math.round(ratio*1000)`)+ `lastTimeText` + `lastPhaseLabel`,三层独立短路;静止帧下不重建 `.phase-segments`、不重写 `--rpb-cols`、不动 indicator transform
  - **滑动条 / 数字框 input.value**:写入前 `el.value !== v` 比较,叠加 v3.13 的 `shouldSkipUpdate` 1500ms 用户编辑窗口形成双重保护
  - **CSS 自定义属性写入**(如 `--ev-pointer-transform`):用模块级字符串缓存(`lastEvPointerTransform`),相同时直接 return,不再触碰 CSS 变量
  - **chart annotations + `chart.update('none')`**:用 events 数组拼接签名 `${type}:${time}:${temperature}` + `lastEventsSig` 缓存;签名相同时函数直接 return,不再每帧调 chart.update。这是 v3.15 残留的最大一笔重 DOM 操作
  - **状态徽章 textContent / className / body classList / elapsed text**:全部加 `!==` 比较短路,避免每帧重写 className 触发样式重算
- **反例**：直接在每个 ws msg 里 `el.style.transform = '...'` / `chart.update('none')` 而不做缓存。在低频静态页面看不出差别,但 0.5s 高频推送下立刻表现为视觉刷新
- **参考实现**：V3.11 的 `handleStateUpdate`(`V3.11/roaster/static/js/app.js:303-435`)和 `updateProgress`(541-552 行)
- **相关文件**：`roaster/static/js/app.js:handleStateUpdate`、`updateProgress`、`updateEventAnnotations`、`updateEvPointer`、模块级缓存变量声明区(`lastBodyState` / `lastEventsSig` / `lastStructureSig` / `lastPositionSig` / `lastTimeText` / `lastPhaseLabel` / `lastSegmentSig` / `lastEvPointerTransform`)

## v3.17 新增坑点 (2026-04-29)

### 44. 后端立即 broadcast + payload 多塞字段 + 前端反向回写 = 视觉刷图三连击

v3.13 引入三段 phase 配置时同时引入了三件事，单独存在都没问题，但三个叠加产生了"用户拖一个滑块 → 后端立即广播 → 前端反向重写**其他**滑块 → 浏览器 layout / paint / composite 重算 → 视觉刷图"的副作用链。这是 v3.13~v3.16 跨四个版本始终未真正修复"调超前预测刷图"问题的根本原因。

- **问题**：三个互相独立的设计同时出现就构成了完整链路：
  1. `roaster/src/web/web_api.py` 在 `set_phase_lookahead` / `set_lookahead_offset` 命令分支末尾立即 `await manager.broadcast(controller.get_state_payload())`
  2. `roaster/src/core/roaster_controller.py:get_state_payload` 多发了 `phase_lookahead_config` 与 `lookahead_offset` 两个字段
  3. `roaster/static/js/app.js:handleStateUpdate` 加了消费这两个字段并反向回写其他滑块 `.value`、调 `updateEvPointer` 写 `style.transform` 的代码
- **影响**：前端（视觉 / 可信度）、后端（命令处理路径）
- **为什么 v3.15 / v3.16 的前端优化无法根除**：`shouldSkipUpdate` 只在 `activeElement === sliderEl` 时短路，但拖动期间 `activeElement` 经常因 touch 事件导致短暂偏离，导致短路失效。v3.16 加的"值未变跳过"短路在用户**首次**拖动时就生效不了——因为后端反推的值与 UI 当前值"确实不同"
- **正确做法**：**任何"用户输入"型的命令路径，后端不应在收到命令后立即广播完整 state**。命令处理只回 `{"ok": True}`，让 0.5s 节流的主控广播循环自然带出新状态。前端则不应把后端反推的"配置类"字段写回用户正在交互的输入控件——**用户输入是唯一可信源**
- **反例**：
  1. 后端命令分支：`controller.update_X(v); await manager.broadcast(...)` → 拖滑块产生密集广播
  2. 前端 handleStateUpdate：`if (msg.config != null) { input.value = msg.config.X }` → 反向覆盖用户当前输入
- **参考实现**：V3.11 的 `set_lookahead` 路径——立即 broadcast 是可以的，但前提是 payload 不含可写回字段（V3.11 只发 `lookahead_used` 这种只读反馈），且前端只更新 `<span>` textContent，永远不写 `<input>.value`
- **v3.17 修复策略**：字面意义回退到 V3.11——砍掉 web_api 立即 broadcast 与 app.js 反向回写两条链路，payload 字段保留向下兼容（前端不消费即可）；onmessage 入口加 `{ok} / {error}` guard 避免命令回包走 handleStateUpdate 全路径
- **相关文件**：
  - v3.17 修复点：`roaster/src/web/web_api.py:set_phase_lookahead, set_lookahead_offset`（删除立即广播）
  - v3.17 修复点：`roaster/static/js/app.js:handleStateUpdate`（删除两段反向回写）、`ws.onmessage`（加 ok / error guard）
  - 反例参考：v3.13~v3.16 期间的同位置代码（git 历史）
  - 正例参考：`V3.11/roaster/static/js/app.js:handleStateUpdate`（只读 `lookahead_used` 文本反馈）

### 45. WS 断线重连后 phase slider / EV 偏移 UI 不与后端真值同步——有意取舍

v3.17 删除前端 `handleStateUpdate` 对 `phase_lookahead_config` / `lookahead_offset` 的反向回写后，WS 断线重连或新打开页面时，三段滑块与 EV 偏移 UI 不再用后端 payload 真值初始化，会停留在 HTML 默认值。这是为修复 #44（反向回写副作用）必须的取舍。

- **问题**：用户调过参 → 断线重连 → 看到 UI 显示默认值，但后端 `_lookahead_offset` 与 `phase_lookahead_config` 仍是真值。烘焙逻辑使用后端真值，UI 显示有偏差但不影响烘焙结果
- **影响**：前端（视觉 / UX）
- **为什么是有意取舍**：与 V3.11 行为字面等价（V3.11 根本不含这些字段也没有这些滑块，自然不存在同步路径）。用 v3.17 的方式回退是为了优先消除 #44 的视觉刷图副作用
- **当前应对**：用户重连后如发现 UI 与后端不一致，可直接手动拖回想要的值或刷新页面
- **应如何处理**（如未来需要恢复"重连同步"能力）：使用"仅在 `dataset.lastUserEdit` 为空、且 `document.activeElement !== sliderEl`、且本次会话尚未做过同步"的条件下执行一次性初始化，避免再次触发 #44 的反向回写副作用。任何无条件回写都会引发 #44
- **相关文件**：
  - 触发场景：`roaster/src/web/web_api.py:web_websocket_endpoint` WS 接入时的 `await websocket.send_json(controller.get_state_payload())` 仍会推送配置字段，但前端不消费
  - 涉及代码：`roaster/static/js/app.js:handleStateUpdate`（无消费此字段的代码）
  - 后端 payload 来源：`roaster/src/core/roaster_controller.py:get_state_payload`（仍发送 `phase_lookahead_config` / `lookahead_offset`，向下兼容）

## v3.18 新增坑点 (2026-04-30)

### 46. PhaseLookaheadConfig 历史值兼容性

- **问题**：用户从 v3.17 或更早版本升级到 v3.18，且其 `config.yaml` 里 `lookahead_sec` 历史上手动改过 >30 的值（v3.17 之前 Pydantic le=60.0 允许）。v3.18 把 `PhaseLookaheadConfig` 三字段 Pydantic 校验上限收紧到 le=30.0；但 `roaster_controller.get_state_payload` 每 0.5s 用 `PhaseLookaheadConfig(...)` 包装从配置读取的 fallback 值，如果 fallback 值 > 30 就会触发 `ValidationError`，让状态广播线程崩溃。
- **影响**：后端（状态广播线程）
- **解决方案**：v3.18 在 `get_state_payload` 构造 `PhaseLookaheadConfig` 之前对每个 fallback 值做 `min(30.0, max(0.0, ...))` 静默 clamp。即使老 yaml 有越界值，也只会被截断到 30，不会让广播崩。
- **未来注意**：如果以后又调整 `PhaseLookaheadConfig` 的 le 上限，记得同步更新 `get_state_payload` 中的 clamp 上限。
- **相关文件**：`src/core/models.py:PhaseLookaheadConfig`、`src/core/roaster_controller.py:get_state_payload`

### 47. 紧急停止小方框闪烁动画绑定层

- **问题**：v3.18 重构后的紧急停止结构是 `<div class="estop-box"><button class="estop-btn">…</button></div>`。如果未来开发者想"让整个紧急停止区域更醒目"，可能误把 `estopBlink` 动画从 `.estop-btn.confirming` 改为绑定到 `.estop-box`。外层容器整体闪烁会让用户误以为整个工具框是一个大按钮（视觉语义错误）——容器是静态的"小方框工具区"，按钮才是真正可交互的紧急停止控件，闪烁应该只作用在按钮本体上吸引注意，容器保持稳定边框。
- **影响**：前端（视觉语义 / UX）
- **解决方案**：`estopBlink` 动画与 `confirming` 状态类**只能**绑在 `.estop-btn`，不要改在 `.estop-box`。
- **相关文件**：`static/css/style.css`（搜索 `estopBlink`、`.estop-btn.confirming`）

## v3.19 新增坑点 (2026-06-04)

### 48. 本地 Claude/Git 权限不要写入版本化 `.claude/settings.json`

- **问题**：本地工具权限容易被自动写入版本化的 `.claude/settings.json`，其中可能包含当前机器的绝对路径。
- **影响**：Git / 本地开发环境；提交后会把个人路径、工具权限和团队无关配置带入仓库。
- **解决方案**：提交前检查 `.claude/settings.json`，本机绝对路径权限应移到 ignored 的 `settings.local` 或从提交中排除。
- **相关文件**：`.claude/settings.json`、`.claude/settings.local`

### 49. 活跃烘焙 UI 必须以后端 `profile_id` / `profile_name` 为可信源

- **问题**：烘焙中如果用曲线库当前选择覆盖主图表目标曲线，会把「待机选择」误当成本锅正在使用的曲线。
- **影响**：前端（曲线显示 / 操作可信度）、后端状态理解。
- **解决方案**：ROASTING / COOLING 期间，活跃目标曲线只认后端状态广播中的 `profile_id` / `profile_name`；曲线库的应用、删除、导入自动应用应禁用或忽略，不能覆盖正在烘焙的目标曲线。
- **相关文件**：`static/js/app.js`、`src/core/roaster_controller.py:get_state_payload`

### 50. 基础 lookahead 所有入口共用 `[0, 30]` clamp，adaptive extra 不截断

- **问题**：初始化、阶段配置、fallback、状态 payload、兼容入口若各自 clamp，容易再次出现前后端上限或广播上限不一致；同时把自适应 extra 误纳入基础 clamp 会改变控制算法语义。
- **影响**：后端（控制算法 / 状态广播）、前端（显示与输入边界）。
- **解决方案**：基础 lookahead 的所有入口统一 clamp 到 `[0, 30]`；自适应 `extra_la` 是额外项，只在最终 `base + extra` 中叠加，不要用基础上限把它截断。
- **相关文件**：`src/core/roaster_controller.py`、`src/core/models.py`、`static/js/app.js`

### 51. WS `{error}` / `{ok}` 必须入口短路

- **问题**：命令回包不是状态 payload；如果 `{error}` 或 `{ok}` 继续进入 `handleStateUpdate`，会触发不必要的 DOM 更新，甚至把非状态对象当成状态帧处理。
- **影响**：前端（状态显示 / toast / 性能）。
- **解决方案**：`{error}` 只 toast 并 `return`；`{ok}` 静默 `return`。两者都不得进入 `handleStateUpdate`。
- **相关文件**：`static/js/app.js:ws.onmessage`、`static/js/app.js:handleStateUpdate`

### 52. phase number 输入中间态不能发送空值或非法值

- **问题**：用户正在编辑 number 输入框时会短暂出现空字符串、单个负号、小数点等中间态；若在 `input` 阶段把它当 0 或默认值发送，会意外改写后端配置。
- **影响**：前端（输入体验）、后端（lookahead 配置）。
- **解决方案**：`input` 期间只同步本地 UI，不发送空值或非法值；仅在 `blur/change` 时 clamp 到 `0..30` 并归一化后发送，同时用 `lastSent` 去重。
- **相关文件**：`static/js/app.js:initPhaseLookahead`

### 53. 编辑器触摸拖拽依赖 Pointer Events + pointer capture + `touch-action: none`

- **问题**：触摸屏拖拽曲线节点时，如果没有 pointer capture 或禁用浏览器默认触摸行为，拖拽可能丢指针、被页面滚动打断，或与鼠标 fallback 双触发。
- **影响**：前端（曲线编辑器触摸交互）。
- **解决方案**：Pointer Events 作为主路径，使用 `setPointerCapture` 和 `activePointerId` 锁定当前拖拽；鼠标 fallback 只在无 Pointer Events 时启用；拖拽区域保留 `touch-action: none`。
- **相关文件**：`static/js/editor.js`、`static/css/editor.css`

## v3.20 新增坑点 (2026-08-16)

### 54. 颜色唯一来源是 `theme.css` 令牌,JS 图表色经 `cssVar()` 读取

- **问题**：双主题后，任何在 style.css / editor.css / JS 模板里硬编码的色值都只在一个主题下正确；canvas / Chart.js 不读 CSS，必须经 `utils.js:cssVar(name, fallback)` 取 `--chart-*` / `--event-*` 令牌。
- **影响**：前端全部。
- **解决方案**：新颜色先入 theme.css 双主题令牌区再消费；JS 侧走 `chartPalette` / `editorPalette`，主题切换经 `roaster-themechange` 事件重读。fallback 字面量只许出现在 `refreshChartPalette` 一处（与深色主题一致）。
- **相关文件**：`static/css/theme.css`、`static/js/utils.js:cssVar`、`static/js/app.js:refreshChartPalette`、`static/js/editor.js:refreshEditorPalette`

### 55. `theme.js` 必须在 `<head>` 同步外链，且先于样式表

- **问题**：Tauri CSP `script-src 'self'` 禁止内联脚本，防 FOUC 的「预读 localStorage 写 data-theme」不能写成 HTML 内联 `<script>`；若推迟到 DOMContentLoaded 才应用主题，首帧会先按默认深色闪一下。
- **影响**：前端（Tauri 桌面版 CSP 约束、两页首帧观感）。
- **解决方案**：`<script src="js/theme.js">` 放在两个 HTML 的 `<head>` 内、样式表 `<link>` 之前；theme.js 顶层同步执行 `applySilent(readMode())`，控件接线才等 DOMContentLoaded。
- **相关文件**：`static/index.html`、`static/editor.html`、`static/js/theme.js`、`desktop/src-tauri/tauri.conf.json:CSP`

### 56. 事件标注对象必须带 `annType`，否则主题切换后颜色无法重映射

- **问题**：事件标注 `{time, label, color}` 在创建时取色；切换主题后 label 无法反推事件类型，颜色残留旧主题。
- **影响**：前端（图表事件标注）。
- **解决方案**：标注对象携带 `annType: e.type`，applyChartTheme 用 `eventColor(a.annType)` 无损重染后 `update('none')`；新增标注来源（如未来的新事件类型）必须同样带 annType，并注意 `lastEventsSig` 签名不含颜色（主题切换不走该缓存）。
- **相关文件**：`static/js/app.js:updateEventAnnotations`、`renderRecordChart`、`applyChartTheme`

### 57. 急停层级契约迁移到 `#footer`（1010 < 1020 < 9999）

- **问题**：急停并入底栏后，原 `.estop-box { z-index: 1020 }` 消失；记录详情「图表全屏」容器是 `position:fixed; inset:20px; z-index:1000`，会连同底栏一起盖住，急停不可见不可点。
- **影响**：前端（安全控件可见性）。
- **解决方案**：`#footer { position: relative; z-index: 1020 }` 恢复层级契约；任何新增 fixed 浮层 z-index 必须避开 1020 这个档位，并复查是否盖住底栏。
- **相关文件**：`static/css/style.css:#footer`、`.record-chart-container.record-chart-fullscreen`、`#error-overlay`

### 58. `style.color` 与 hex 字面量比较恒为假——内联色短路要用字符串缓存

- **问题**：浏览器把 `el.style.color` 读回时已序列化为 `rgb(r, g, b)`，与 JS 里的 `'#22c55e'` 比较永远不等，「值未变跳过」形同虚设，每帧都在做同值赋值。
- **影响**：前端（PITFALLS #43 高频 DOM 写纪律）。
- **解决方案**：模块级 `lastDeltaColor` 字符串缓存比对（v3.20 已修 `#delta-val`）；今后任何「JS 写内联色 + 跳过短路」都用同模式，不要直接比对 `style.color`。
- **相关文件**：`static/js/app.js:handleStateUpdate`

### 59. 浅色主题橙系小字对比度偏弱，新增橙色文字用途需过一遍对比度

- **问题**：`#f59e0b`/`#ff9f0a` 一族在白底上仅 ~2.3:1;v3.20 浅色已把品牌橙加深为 `#f07d00`、`--phase-maillard` 加深为 `#b45309`。
- **影响**：前端（浅色主题可读性）。
- **解决方案**：浅色主题下新增「橙色文字/细线」用途时，优先复用已加深的令牌；实心橙底上的文字用 `--on-accent`（深底黑字 / 浅底白字）而非固定色。编辑器等小字场景实测后再微调。
- **相关文件**：`static/css/theme.css:[data-theme="light"]`

## v3.21 新增坑点 (2026-08-25)

### 60. 工作区切换后必须延迟 resize Chart.js

- **问题**：隐藏工作区中的 canvas 宽高为零或沿用旧容器尺寸，切回主控台/记录详情后会出现压扁、留白或命中区域错位。
- **解决方案**：只切换包装容器与 `data-view`，保留稳定 DOM ID；工作区变为可见后下一帧调用对应 Chart.js `resize()` / `update('none')`。
- **相关文件**：`static/js/app.js:activateWorkspace`、记录详情与对比恢复路径。

### 61. 离线图标必须由锁定版本可重复生成

- **问题**：运行时 CDN 会在离线 Tauri/树莓派环境丢图标；手工复制字体又无法审计来源和许可证。
- **解决方案**：锁定 `@phosphor-icons/web` 版本，由 `desktop/tools/sync-icons.mjs` 生成最小 CSS、字体与许可证；提交前运行 `npm run icons:sync` 和 `npm run check:frontend`。
- **相关文件**：`desktop/package.json`、`desktop/tools/sync-icons.mjs`、`static/assets/icons/phosphor/`。

### 62. 首次主题默认 auto，主页面和编辑器必须共用首帧加载顺序

- **问题**：只有一个页面在样式前同步加载 theme.js，或无历史值仍回退到固定主题，会造成两个页面观感不一致与首帧闪烁。
- **解决方案**：`roaster.theme` 无值时返回 `auto`；`index.html` 与 `editor.html` 都必须在任何 CSS 前同步外链 `theme.js`。
- **相关文件**：`static/js/theme.js`、`static/index.html`、`static/editor.html`。

### 63. 全工作区导航必须保留稳定 ID 和业务绑定

- **问题**：为重新布局而重建烘焙控件，会让已有事件监听、状态短路与硬件安全语义失效。
- **解决方案**：保留原 ID 和控制函数，仅用包装容器、`data-view` 与 ARIA 状态切换工作区；视觉层不得重写 REST/WebSocket 命令。
- **相关文件**：`static/index.html`、`static/js/app.js`。

### 64. 桌面视觉验收只能使用本机协议模拟器，禁止碰真实串口

- **问题**：为了截图启动完整 Python 后端可能自动连接 TC4S/RS485，让视觉测试影响真实机器。
- **解决方案**：使用 `npm run dev:sim`；模拟器只监听 127.0.0.1 的 HTTP/WebSocket，覆盖 IDLE/ROASTING/COOLING/ERROR 与管理数据，不导入硬件代码。最终截图来自 `roaster-desktop.exe`，不能用普通浏览器代替。
- **相关文件**：`desktop/tools/roaster-simulator.mjs`、`desktop/tools/dev-sim.mjs`。

### 65. 跨分支平台生成目录会伪装成项目源码

- **问题**：从 `feature/flutter-app` 切回 Tauri 分支后，`.dart_tool/`、IDE 元数据、Gradle wrapper、插件注册文件和 `flutter/ephemeral/` 可能作为忽略或未跟踪残留继续留在 `flutter_app/`，让当前分支看起来像包含一份不完整 Flutter 项目。
- **影响**：项目结构、Git 审查、磁盘占用；开发者可能误把生成残留当成需要维护的源码。
- **解决方案**：完整 Flutter 源码以 `feature/flutter-app` 分支为准；切换分支前保持工作区干净，切回后先用 `git ls-files -- flutter_app` 确认当前分支没有跟踪内容，再清理生成残留。通用依赖与缓存使用根目录 `scripts/clean-workspace.ps1`，不要让脚本删除可能包含未提交源码的整个业务目录。
- **相关文件**：根 `.gitignore`、`docs/project-structure.md`、`scripts/clean-workspace.ps1`。

---

*最后更新：v3.21 (2026-08-25)*
