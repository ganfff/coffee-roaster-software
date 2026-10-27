# Mhub 设计与代码适配记录

本次方向由用户确认：以 Mhub 正式主程序／音频界面为基准，使用纯色黑白蓝、平面按钮、浅色／深色／跟随系统和原版区域动效。学习控制台的配色不作为产品主题。

## 固定参考身份

参考项目：`D:\项目\MHUB逆向`，主界面分发版本 1.1.26。以下路径相对于该项目的 `public/vendor/cdn.mchose.com.cn/customPage/prod/assets/`。

| 原始文件 | SHA-256 | 本项目对应实现 |
| --- | --- | --- |
| `main-xA7mzCYt.js` | `bece4f92096af739fbb6cec4f981f7f6c47b539ba5511e76078cc0bedf4cf847` | `mhub-motion.js` 的区域参数、登记、取消、批调度、暂停与恢复；`theme.js` 的有效主题与持久化 |
| `main-Bigq7yvw.css` | `f6db1450f4849448b43268e898661f4f16112f37c65a9860644b1152b2b26c07` | `theme-palettes.mjs` 的语义令牌；`mhub.css` 的控件、表面和交互状态 |
| `animeCeilTransition-Dg_CUVBx.js` | `3fdb39bbe6bc0129a3b33d9ee52b5095e4300992f504b9c891c4f6c60abbec32` | 进入与离开完成的 Promise、取消后的清理，以及工作区和 AI 面板的过渡衔接 |

## 行为对应

统一时长为200ms，缓动为 `cubic-bezier(.43,.77,.16,1)`。七类进入参数如下，离开时反转。

| 区域 | 进入参数 | 在烘焙软件中的使用 |
| --- | --- | --- |
| sidebar | Y 100% → 0 | 首次呈现的任务导航 |
| header | Y -100% → 0 | 首次呈现的侧栏产品身份 |
| tab | X 100% → 0 | AI 面板的打开与关闭 |
| content | opacity 0 → 1，scale 1.25 → 1 | 管理页面、普通对话框 |
| mouseKey | X calc(-100% - 60px) → 0 | 可供局部参数面板复用的区域类型 |
| footer | 视口底部之外 → 0 | 可供普通对话操作区复用；不绑定安全底栏 |
| up | Y 20px → 0，opacity 0 → 1 | 菜单、设置任务内容和轻量提示 |

管理器每批最多5项任务，优先使用 `requestIdleCallback`，回退为20ms定时器；空闲调度设超时，避免繁忙线程无限延后内容。重复目标先取消旧实例，所有 Promise 都明确完成或取消。采用 WAAPI 效果，完成后移除效果，不把临时 transform 写入业务元素的内联样式。

页面的 active 状态与业务操作立即更新。离开页面不可交互，快速返回时旧回调不能隐藏新状态。AI 关闭等待视觉退出，重新打开取消旧关闭意图。系统减少动效时立即完成视觉状态；实时读数、实时图表、编辑画布和安全栏不参加区域位移或缩放。

## 主题与组件适配

- 正式主题使用基础灰阶／蓝色和组件语义令牌两层。浅色面板为白，卡片参考 `#f2f3f7`；深色卡片参考 `#212225`，主要按钮参考 `#226bee`；浅色主要按钮参考 `#0053e2`。
- 深色文本链接与焦点采用较浅蓝色，与实色主按钮分别取色。次级文字和输入边界为可读性调整过的值；图表、事件与安全颜色保持业务语义。
- 原版按钮的8px圆角、实色／描边／中性／文字层级及150ms状态反馈被保留。原版40px高度与13px控件字，适配为至少44px触控目标和14–16px正文。
- 旧 `roaster.palette` 归一为 `mhub`，`roaster.theme` 的 dark／light／auto 选择保留。主题在首帧前确定，跨窗口同步；主题事件仍包含 theme、mode、palette。图表使用现有无动画重新取色路径。

## 主页曲线与事件细化（2026-10-27）

本次只对主页图表和事件呈现采用用户指定的 Kaffelogic 参考，其他区域继续使用以上 Mhub 系统。已读取的真实界面参考位于 `D:\项目\kaffelogic逆向\analysis\validation\reference-gui\`：

| 参考 | 采用的呈现规则 | 本项目对应实现 |
| --- | --- | --- |
| `08-real-log.png` | 细温度／目标线、实际曲线点位上的紧凑事件标记 | `app.js` 主页图表与 `eventLines.compactMarkers`；`theme-palettes.mjs` 深浅主题的 PV／SV／目标语义色 |
| `11-real-profile-phases-ror-fan-zones.png` | 分钟刻度、绿色 ROR 与参考线、轻量网格 | `app.js` 主页坐标轴、ROR 无填充和参考点线；`index.html` 图例 |

图下事件按钮使用至少 44×44px 的紧凑操作行，时间／温度保留在 title、可访问 badge 与详情展开中。待机不预填事件，历史记录页的标注方式继续由记录模块维护。参考截图不复制进仓库；这些图像提供呈现依据，不代表本项目已验证真实 Kaffelogic 设备。

AI 入口统一创建新对话；本机账户／模型继续静默恢复，历史消息仅通过明确选择历史或候选曲线交接恢复。账户与硬件权限边界保持原有约束。

## 工程与资源边界

这是现有原生 HTML／CSS／JavaScript 的可读适配实现，未恢复或声称拥有厂商原始 Vue 工程。厂商编译主包、产品图、图标字体、壁纸、Electron 外壳、账号与硬件 SDK、模拟桥接不进入本仓库。

原有 REST／WebSocket／Tauri 契约、显式保存与应用、原生文件保真及 AI 建议权限继续由既有模块维护。网页、kiosk 与 Windows WebView 共用 `roaster/static/`。Windows 模拟器与 WebView 的验证不代替树莓派或真实烘焙硬件验证。

MiSans 字体作为应用资源保留原始字节、版权和许可，详见 `roaster/static/assets/fonts/misans/NOTICE.md`。图标继续使用项目已有的离线 Phosphor。
