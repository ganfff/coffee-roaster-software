# 风味研究图谱 v3.25 / 桌面 0.5.0 验证记录

日期：2026-10-22。范围：共享前端视觉与工作流、AI、原生工作台和 Windows 安全模拟器。本文由各执行任务汇总；待补充项表示尚无完整记录，不能视为通过。

## 当前规范与证据

- [根 DESIGN.md](../../DESIGN.md)：当前实际设计系统；[机器侧车](../../.impeccable/design.json) 承载扩展元数据和组件片段。
- [PRODUCT.md](../../PRODUCT.md) 与 [主入口 surface brief](../../.impeccable/surfaces/roaster-static-index-html.md)：产品边界与界面方向。
- [截图与机器报告目录](flavor-atlas-v3.25/)：按页面、主题、尺寸命名。Calm Canvas 截图仅供历史追溯。

## 本次结果

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| 前端静态检查 | 12 JS / 6 CSS / 2 HTML / 45 icons 通过 | npm run check:frontend；检查语法和资源，不证明运行行为 |
| 页面布局与行为 | 35 checks，0 errors | [layout-report.json](flavor-atlas-v3.25/layout-report.json)；30页面组合、4项工作流及编辑器字号/点击高度检查 |
| AI UI | 12 checks，0 errors | [ui-report.json](flavor-atlas-v3.25/ui-report.json)；共享 AI 核心、faux provider、浏览器、安全模拟器 |
| Workbench UI | 22项通过 | npm run test:workbench:ui；[工作台报告](flavor-atlas-v3.25/workbench/ui-report.json) |
| Workbench native UI | 4项通过 | npm run test:workbench:native-ui；独立数值引擎、候选、撤销、帮助与只读日志4组 |
| Tauri native UI | 2项通过 | npm run test:ai:native-ui；最终 EXE 的 atlas/theme CSS 与 atlas/app JS 已和源码逐一比对 SHA256；[实际 Tauri 报告](flavor-atlas-v3.25/native-ui-report.json) |
| 桌面生产构建 | 成功 | 安装包与哈希见下；构建通过不证明设备行为 |
| 独立视觉复核 | ship，上一轮六项修复均 resolved | 仅对应该六项修复范围，不代表完整无障碍或硬件认证；[修复复核记录](flavor-atlas-v3.25/visual-review.json) |

页面矩阵：1366×800 / 1024×640 / 375×800 × 浅色/深色 × 烘焙/曲线/记录/工作台/设置，共30组合。布局检查核对 pageerror 与页面横向溢出，不等于逐控件无障碍审计。另有预览不应用、明确应用后状态更新、开始烘焙后预览动作禁用、冷却确认期间急停可达四项行为检查，并检查编辑器输入字号至少14px、点击高度至少44px。

补充截图覆盖 ERROR、100/115/130%缩放，以及编辑器三种尺寸和双主题。编辑器夹具已避开 ROASTING 状态下的保护性重定向；早期被重定向的截图不能作为编辑器证据，应以最终重拍为准。

AI回归覆盖配对与手动通道切换、历史恢复/过滤、编辑重发、设置布局与三种配置模式、深浅主题/桌面/手机、横屏输入与急停、缩放、刷新重连与停止、曲线比较/校验采用/撤销/文本键盘隔离、不可变klog附件与真实偏移读取。不据此宣称真实外部供应商和硬件全部路径通过。

## 产物

- 安装包：dist/RoasterDesktop_0.5.0_x64-setup.exe。
- SHA256：fd5817fe434ce3a10fdf88f446e6da6271f255636d060b272d26fe2d36ca7e20。
- 大小：42,277,128 bytes。完整交付摘要见 [delivery-report.json](flavor-atlas-v3.25/delivery-report.json)。
- 完整产物大小、SHA256及验证边界见 [交付报告](flavor-atlas-v3.25/delivery-report.json)。
- NSIS 已构建，尚未执行安装/卸载；真实云端AI和订阅登录未验证。源码改动为本地状态，尚未提交或推送。

## 设计与安全边界

当前规范包含实际双主题完整色板、系统/数字字体、间距、字级、图表语义、响应式、组件、AI与焦点/触控要求。最新代码已提高 AI 消息操作、节点行和图标/插点的触控尺寸，并调整危险/信息色及连接浮层层级。

正文与控件14–16px，辅助标注至少12px。最终 atlas 为按钮设置最小44×44px，输入、滑块和标签行至少44px高；双主题完整对比度和逐控件辅助技术行为未做认证。

当前层级为普通工作台dialog1000、AI/记录全屏/连接浮层/冷却确认1010、急停底栏1020、故障1100，toast1200且不拦截指针。独立编辑入口连接按钮1030若迁入主控制页，应重新验证安全覆盖关系。

## 额外检查与限制

| 项目 | 状态 |
| --- | --- |
| Impeccable detector / finish review | 已执行一次检测并修复对比度/间距；六项复核 resolved，详见视觉报告 |
| 令牌、JSON、文档链接 | 已检查 JSON、文档本地链接与 git diff --check |
| 系统主题首帧、焦点顺序、44px区域与全量对比度 | 待完整审计 |
| Git | 本轮成果仅保存在本地，未提交或推送 |

## 真机结论

**未验真机。** 目标树莓派性能、物理触控、TC4S/RS485/GPIO、温度传感器、真实加热关断与硬件急停均未验证。本次 Windows 工作只能支持源码、浏览器、安全模拟器、明确执行的原生程序和构建结论。
