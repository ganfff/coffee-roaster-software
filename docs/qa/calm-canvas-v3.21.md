# Calm Canvas v3.21 Design QA

## 基准与证据

- 设计基准：`docs/design/calm-canvas/calm-canvas-reference.png`（原始 1639×960）。
- 第一轮原生截图：`docs/design/calm-canvas/calm-canvas-pass-1.jpg`（Tauri 窗口 1369×831，WebView 内容 1366×800）。
- 第一轮同帧对照：`docs/design/calm-canvas/calm-canvas-comparison-pass-1.jpg`。
- 第二轮原生截图：`docs/design/calm-canvas/calm-canvas-pass-2.jpg`（同窗口、同 ROASTING / 05:42 状态）。
- 第二轮同帧对照：`docs/design/calm-canvas/calm-canvas-comparison-pass-2.jpg`。
- 最小窗口证据：`docs/design/calm-canvas/calm-canvas-1024x640.jpg`（Tauri 窗口 1027×671，WebView 内容 1024×640）。

对照板把参考图归一化到 1369×831，并与同状态的原生 Tauri 截图并排放入同一张图片。截图中的蓝色光晕是 Windows Computer Use 的鼠标定位标记，不属于产品界面。

## 第一轮

### 观察

- P0：无。
- P1：烘焙记录卡片只有鼠标点击路径，键盘不能进入详情；小字号元数据在暖白背景上的可读性不足。
- P2：主图曾同时显示自定义图例和 Chart.js 内置图例；模拟曲线初段尺度导致 ROR 右轴被异常负值拉伸。
- P2：浅色与深色的三级文字令牌对小字偏淡。

### 修正

- 记录卡片增加 `role="button"`、`tabindex="0"`、Enter/Space 入口、复选框标签和统一焦点环，元数据字号提升到 11px。
- 关闭主图 Chart.js 内置图例，仅保留与参考图一致的页内图例。
- 模拟器改为平滑上升的目标温度与衰减 ROR，且提供 `--freeze`，保证两轮截图状态可重复。
- 深浅主题三级文字分别提高到 `#9a968d` / `#746f68`，增强小字对比度。

## 第二轮

### 结果

- P0 / P1 / P2：无未解决阻断项。
- 视觉层级与参考一致：暖白画布、窄遥测栏、中央最大曲线、右侧情境架、顶部工作区与底部急停。
- 1366×800 保持完整三栏；1024×640 自动把遥测提升为顶部紧凑栏，曲线和操作架保持可见，底部状态栏不被内容覆盖。
- 原生浅色、深色与主题持久化通过；主题切换后实时、记录、对比、编辑器和曲线预览均重新取色。
- 主导航、记录详情、下一事件点击写入、设置分组和编辑器拖动/撤销通过实际 Tauri 交互验证。
- E-STOP 保持 `z-index:1020`、危险色、ROASTING 可用和双重确认路径；验证全程连接本机模拟器，未访问真实 TC4S/RS485。
- 全局焦点环、记录卡片键盘入口、ARIA 工作区状态、44px 主要触控目标和 `prefers-reduced-motion` 已检查。

final result: passed
