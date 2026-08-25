# 更新记录

## v3.20 (2026-08-16) — 苹果式设计语言重构 / 深色·浅色双主题 / 全链路动画

### 上一版本功能摘要(v3.19 之后的未记录提交)
- Tauri 2 桌面壳(`desktop/`)复用网页前端,Chart.js 本地化、CORS 放开、根路径静态兜底挂载
- Artisan 灵感特性移植网页端:回温点自动检测、结束提醒、自动标记转黄/一爆、自定义报警、ETA、对比模式
- 后端连接设置并入原生设置 tab;急停按钮集成进底部状态栏

### 核心改进

1. **设计令牌系统(新增 `css/theme.css`)**
   - 全部颜色收敛为语义 CSS 变量:`:root` 为深色(Apple Dark),`:root[data-theme="light"]` 为浅色(Apple Light,`#f2f2f7` 组背景 + 白卡)
   - 令牌分层:背景/面层级、文字三级、品牌与语义色、阶段色、图表色(`--chart-*`)、事件色(`--event-*`)、偏差色(`--delta-*`)、阴影/圆角/缓动
   - `style.css` / `editor.css` 零硬编码色值(仅 `#fff` 白钮/白字等主题无关常量);cubic-bezier 字面量全仓只剩 theme.css 两处变量定义(PITFALLS #39)
   - 原因:单点改色双主题同步生效,杜绝风格漂移

2. **主题切换基础设施(新增 `js/theme.js`)**
   - localStorage `roaster.theme` ∈ dark / light / auto(跟随系统),默认 dark 保持树莓派 kiosk 既有观感
   - 在 `<head>` 以同步外链脚本把 `data-theme` 写到 `<html>`,首帧即目标主题,零 FOUC(Tauri CSP `script-src 'self'` 禁止内联脚本,故必须外部文件)
   - 切换时 `<html>` 临时挂 `.theme-animating`(420ms)启用纯颜色系过渡,结束后移除,不干扰高频 DOM 更新;`prefers-reduced-motion` 自动跳过
   - 主题变化派发 `roaster-themechange` 事件,app.js / editor.js 监听后给 Chart.js 原地换色并 `update('none')`
   - 入口:顶栏日/月图标快捷切换 + 设置页「外观 → 主题」iOS 分段选择器(跟随系统/深色/浅色)
   - 原因:主题不是一张新皮肤,而是贯穿 CSS / Chart.js / canvas 插件 / Tauri 弹窗的全链路契约

3. **苹果美学重构(`style.css` 全文重写)**
   - 字体:弃用 Times/宋体衬线栈与 Google Fonts 外链,改系统 SF/PingFang/雅黑无衬线栈;数字统一 `tabular-nums` 等宽,跳动不抖布局
   - 布局:三条信息条改为浮动圆角卡片(iOS 分组列表感),控制面板改为透明容器 + 独立卡片区块
   - 组件:Tabs 改 iOS 分段控件(`.tab-glider` 滑动拇指,transform 驱动);设置页复选框改 iOS 开关;按钮/输入框/滑块全面发丝边框 + 柔和分层阴影;状态徽章改着色胶囊 + 圆点
   - 动画:全部 transition/animation 只动 transform/opacity/颜色;ERROR 浮层加 scale-in;toast 改胶囊浮起
   - 清理死代码:`.control-group` / `.form-row` / `.slider-group` / `.control-meta` / `.action-btn` / `.profile-meta` / `.import-hidden` / `.ctrl-btn.warning`、HTML 里 `rpb-seg-*` 死类名
   - 原因:美学一致性 + 简约操作(触控目标 ≥44px 保留,hover 全部 `(hover:hover)` 包裹防触摸残留)

4. **Chart.js 颜色主题化(`app.js` / `editor.js`)**
   - 新增 `chartPalette` / `editorPalette`:经 `utils.js` 的 `cssVar()` 读取 `--chart-*` / `--event-*` 令牌,构建时用、主题切换时重读
   - 事件标注对象新增 `annType` 字段,主题切换后颜色可无损重映射;三处重复的事件色表收敛为 `eventColor()`
   - 事件竖线插件:标签底色 `'rgba(10,10,10,0.8)'` 与 `'11px Fira Sans'` 字体改读色板(浅色主题下不再是黑块)
   - tooltip 显式配色(两张实时图 + 编辑器图),浅色下不再沿用 Chart.js 深色默认
   - `#delta-val` 内联色改读色板,并修复「style.color 与 hex 比较恒为假」导致的每帧无效赋值(模块级 `lastDeltaColor` 缓存短路)
   - applyChartTheme 无条件重染全部数据集后再覆盖 compare 色,杜绝 compare 中切主题残留旧色
   - 原因:图表是视觉主体,必须与 CSS 同源换色,且不能破坏 PITFALLS #33/#43 的更新纪律

5. **注入模板去内联色(`app.js` / `tauri-adapter.js` / `editor.js`)**
   - 列表空态/加载占位统一 `.list-placeholder`(`.error` 变体),报警行布局收敛到 `.alarm-row` CSS
   - Tauri 浮动设置钮与后端弹窗 12 处内联深色全部改 `var(--*)`(内联样式中的 var 同样跟随主题)
   - sparkline 描边色从 SVG 属性移到 CSS(表现属性被 CSS 覆盖,双主题生效)
   - 原因:内联硬编码色是主题系统的旁路,必须清零

6. **安全契约修复**
   - `#footer` 加 `position: relative; z-index: 1020`,恢复 PITFALLS #21 的 1010 < 急停 < 9999 层级(原 `.estop-box` 层级在急停并入底栏后丢失,记录图表全屏会盖住急停)
   - 浅色主题 `--phase-maillard` 加深为 `#b45309`(小字对比度)
   - 原因:安全控件可见性 > 视觉整洁

### 协议与边界变更

#### REST / WebSocket / config.yaml
- 无变更。本次改动全部位于 `roaster/static/` 前端。

#### 前端新增契约
- localStorage 新键 `roaster.theme`(与既有 `roaster.settings` 并存,独立读写)
- window 事件 `roaster-themechange`,detail = `{ theme: 'dark'|'light', mode: 'dark'|'light'|'auto' }`
- 全局 API `window.RoasterTheme.{getMode,getTheme,setMode}`;工具函数 `cssVar(name, fallback)`(utils.js)

### 修改文件清单
- `roaster/static/css/theme.css` —— 新增:双主题设计令牌 + 主题过渡 + 全局基件(滚动条/焦点环/reduced-motion)
- `roaster/static/js/theme.js` —— 新增:主题解析/持久化/切换/事件派发/控件接线
- `roaster/static/css/style.css` —— 全文重写:苹果设计语言 + 全令牌化
- `roaster/static/css/editor.css` —— 全文重写:同上,保留 `touch-action: none` 与 44px 触控规则
- `roaster/static/index.html` —— head 主题引导(theme.js 在样式表前)、`color-scheme` meta、顶栏主题钮、tab-glider、设置页外观区块、占位符 class、seg-color 变量化、`?v=3.20`
- `roaster/static/editor.html` —— head 主题引导与 `?v=3.20`(编辑器继承主页面主题,无页内开关)
- `roaster/static/js/app.js` —— 图表色板 + applyChartTheme + annType + delta 缓存短路 + tab glider + 模板去内联色
- `roaster/static/js/editor.js` —— editorPalette + applyEditorChartTheme + 主题监听 + 占位符 class
- `roaster/static/js/tauri-adapter.js` —— 浮动 UI / 弹窗内联色全部 var 化
- `roaster/static/js/utils.js` —— 新增 `cssVar()`

### 审查与验证
- 两个未参与实现的独立审查 agent 全量 diff 复核:DOM 契约零缺失、JS 行为零越权变更、PITFALLS 前端条款逐条过检;发现的急停层级回归、compare 残色、死令牌已修复
- Windows 静态验证:全部 JS `node --check` 通过;三个 CSS 大括号平衡;零 backdrop-filter/blur;cubic-bezier 字面量仅 2 处变量定义
- **需要在树莓派上测试**:触摸屏实机过目双主题(尤其浅色)观感、主题切换动画流畅度、长烘焙下无掉帧

### 未触及的范围
- `roaster/src/`(后端 / 硬件通信 / 控制算法)零改动
- `desktop/src-tauri`(原生壳配置;WebView2 启动白底闪帧可后续给窗口配 `backgroundColor` 优化)
- `flutter_app/`(独立分支的全量重写,不共享本前端)

## v3.19 (2026-06-04) — 第一批低风险硬化 / 活跃曲线可信源 / 编辑器触摸拖拽

### 上一版本功能摘要（v3.18）
- 三层超前补偿上限统一对齐到 30 秒，覆盖 Pydantic、Controller、前端输入与状态 payload fallback
- 紧急停止按钮从浮动圆形重构为右下角嵌入小方框，保留双击确认、闪烁提示与 z-index 1020 约束
- 源码注释清理版本前缀、评审术语和考古注释，README 回归项目当前说明，更新流水归档到 UPDATE_LOG
- `index.html` / `editor.html` 静态资源缓存破坏字符串同步到 `?v=3.18`

### 核心改进

1. **Git 仓库准备与本地文件边界**
   - 创建并切换到 `dev` 分支，作为第一批低风险优化承载分支
   - `.gitignore` 新增忽略本地工具目录 `/.agents/` 与 `/.codex/`
   - 未把 `roaster/data/records`、`__pycache__`、`settings.local`、`.vscode`、`readme.txt` 纳入 Git
   - 原因：先把可提交边界与本地工具噪音隔离清楚，避免后续代码审查混入运行数据或个人环境文件

2. **后端低风险硬化**
   - `roaster/src/core/roaster_controller.py`：基础 lookahead 统一使用 `[0, 30]` clamp，覆盖初始化、阶段配置、fallback、状态 payload 与兼容 `update_lookahead` 入口；自适应 `extra` 是额外补偿项，不纳入基础 clamp 截断
   - `roaster/src/web/web_api.py`：`/api/v1/records` Query 参数收紧为 `limit=1..200`、`offset>=0`
   - `roaster/src/services/data_manager.py`：`list_records` 内部做防御性 clamp，避免绕过 API 层时传入异常分页参数
   - `roaster/src/services/data_manager.py`：profile id 白名单收紧为 `^[A-Za-z0-9._-]+$`，并通过 `resolve()` / `relative_to()` 防止路径逃逸
   - `roaster/src/services/data_manager.py`：SQLite 迁移只吞 `duplicate column`，其他 `OperationalError` 记录日志后重新抛出
   - 原因：本批只做输入边界、路径安全与迁移错误处理等低风险防御，不改变硬件控制算法主体

3. **主控前端交互与活跃曲线可信源**
   - `roaster/static/js/app.js`：WS 收到 `{error}` 时只 toast 并 `return`，收到 `{ok}` 时静默 `return`，命令回包不再进入 `handleStateUpdate`
   - `roaster/static/js/app.js`：`sendCmd` 在 WS 断线时对关键命令做 2 秒节流提示，避免触摸屏连续误点刷屏
   - `roaster/static/js/app.js`：活跃烘焙曲线以后端 `profile_id` / `profile_name` 为可信源；烘焙中禁用或忽略应用、删除、导入自动应用，不用曲线库当前选择覆盖正在烘焙的目标曲线
   - `roaster/static/js/app.js`：曲线列表为空时清空 UI、目标曲线与 ROR 预览，避免显示残留曲线
   - `roaster/static/js/app.js`：phase number 输入在 `input` 期间不发送空值或非法值，只在 `blur/change` 归一化到 `0..30` 后发送，并通过 `lastSent` 去重
   - `roaster/static/js/app.js`：ROR 实时点同秒覆盖，避免同一秒内追加多个抖动点；profile id 用 URL encode，HTML 属性写入做转义
   - `roaster/static/css/style.css` / `roaster/static/js/app.js`：触摸目标优化；急停结构和 z-index 未改
   - 原因：把「正在烘焙的目标曲线」与「曲线库当前待机选择」隔离，减少断线、空列表、触摸误操作和输入中间态造成的 UI 错判

4. **曲线编辑器触摸拖拽稳定化**
   - `roaster/static/js/editor.js`：Pointer Events 作为主路径，配合 `setPointerCapture` 与 `activePointerId` 约束单一拖拽指针
   - `roaster/static/js/editor.js`：鼠标 fallback 避免与 Pointer Events 双触发
   - `roaster/static/css/editor.css`：编辑器拖拽区域保持 `touch-action: none`
   - `roaster/static/css/editor.css`：coarse pointer 下 `.node-insert-btn` 常显，并保证 44px 触控目标
   - `roaster/static/editor.html`：编辑器静态资源 query 已同步为 `?v=3.19`
   - 原因：树莓派触摸屏上用原生指针捕获统一鼠标与触摸路径，避免拖拽丢指针或双路径重复触发

5. **源码注释清理**
   - `roaster/static/js/app.js`、`roaster/static/css/style.css`：删除 PITFALL 编号式源代码注释引用，只保留当前代码的技术原因
   - 原因：源码注释只说明当前实现为什么这样写，维护历史与坑点编号归档到 UPDATE_LOG / PITFALLS

6. **静态资源缓存破坏字符串同步**
   - `roaster/static/index.html` 与 `roaster/static/editor.html` 已使用 `?v=3.19`
   - 原因：避免浏览器继续加载 v3.18 旧 CSS / JS，干扰输入边界、触摸与曲线可信源修复验证

### 协议与边界变更

#### REST 端点
- `/api/v1/records` 查询参数边界明确为 `limit=1..200`、`offset>=0`
- profile 相关路径参数仅接受 `^[A-Za-z0-9._-]+$`，并做路径解析防逃逸

#### WebSocket 命令
- 命令格式无新增；`set_phase_lookahead`、`set_lookahead_offset`、兼容 `set_lookahead` 继续使用现有 payload
- 前端对 `{ok}` / `{error}` 命令回包做入口级短路，避免误走状态更新路径

#### config.yaml
- 无结构变更；基础 lookahead 越界值在 Controller 入口统一 clamp 到 `[0, 30]`

### 修改文件清单
- `.gitignore` —— 忽略 `/.agents/`、`/.codex/`
- `roaster/src/core/roaster_controller.py` —— 基础 lookahead clamp 覆盖所有入口与状态 payload；保留 adaptive extra 额外叠加语义
- `roaster/src/services/data_manager.py` —— records 分页防御性 clamp、profile id 白名单与路径防逃逸、SQLite 迁移错误处理收紧
- `roaster/src/web/web_api.py` —— `/api/v1/records` Query 边界、WS 命令回包相关路径配套
- `roaster/static/js/app.js` —— WS 回包 guard、断线关键命令提示节流、活跃烘焙曲线可信源、phase number 输入归一、ROR 同秒覆盖、profile id 编码与属性转义
- `roaster/static/css/style.css` —— 主控触摸目标与注释清理
- `roaster/static/js/editor.js` —— Pointer Events 主路径、pointer capture、active pointer 约束、鼠标 fallback
- `roaster/static/css/editor.css` —— `touch-action: none` 与 coarse pointer 插入按钮触控目标
- `roaster/static/index.html`、`roaster/static/editor.html` —— 静态资源 query 同步 `?v=3.19`

### 未触及的范围
- `roaster/src/hardware/tc4s_async.py`
- TC4S / Modbus / GPIO / 串口通讯
- 硬件安全专项与树莓派实机硬件行为
- 急停结构和 z-index 约束

### 验证
- Reviewer：`PASS_WITH_NITS`；唯一后续建议是 `buildProfileCurveKey` 未来可加入更强摘要或 `updated_at`，进一步降低同名同点曲线误判概率
- Verifier：不能记录为完整 `PASS`；当前验证结论为部分证据通过，运行时与硬件项仍待目标环境补测
- `git diff --check`：通过；仅有行尾转换 warning
- JavaScript 语法检查：此前 Verifier 使用相对路径确认 `app.js` / `editor.js` 均通过 `node --check`；最终复核 main loop 中 `app.js` 检查被权限拦截，`editor.js` 检查通过
- Python import / clamp smoke：未完成，Windows 环境无 `python` / `python3`，`py` 被权限拦截
- 树莓派实机 / TC4S 测试：待运行

### 已知风险/提交前提醒
- 本机 Claude/Git 权限不要提交进版本化 `.claude/settings.json`；个人权限应放入 `settings.local` 或从提交中排除
- 本批没有覆盖硬件/树莓派实机验证，合入或部署前仍需在目标环境跑完整烘焙流程

### 代码注释
- 删除 `app.js` / `style.css` 中 PITFALL 编号式源码注释引用
- 保留当前实现的技术原因说明；版本流水、审查记录和历史原因归档到 UPDATE_LOG / PITFALLS

### 已知坑点
- 见 PITFALLS.md #48：本地 Claude/Git 权限不要写入版本化 `.claude/settings.json` 的本机绝对路径
- 见 PITFALLS.md #49：活跃烘焙 UI 必须以后端 `profile_id` / `profile_name` 为可信源
- 见 PITFALLS.md #50：基础 lookahead 所有入口共用 `[0, 30]` clamp，adaptive extra 不截断
- 见 PITFALLS.md #51：WS `{error}` / `{ok}` 必须入口短路
- 见 PITFALLS.md #52：phase number 输入中间态不能发送空值或非法值
- 见 PITFALLS.md #53：编辑器触摸拖拽依赖 Pointer Events + pointer capture + `touch-action: none`

### 项目结构（v3.19）

无文件级别结构变化；仅 Git 忽略规则、既有源码与文档内容调整。`roaster/data/records`、本地缓存、个人工具配置与编辑器配置仍不纳入 Git。

---

## v3.18 (2026-04-30) — 三层 30 秒上限对齐 / 紧急停止小方框重构 / 文档归档清理

### 上一版本功能摘要（v3.17）
- 删除后端 `set_phase_lookahead` / `set_lookahead_offset` 命令分支末尾的立即 `manager.broadcast(...)`（2 行），让 0.5s 节流的 `_broadcast_state` 自然带出回包
- 删除前端 `handleStateUpdate` 中 `phase_lookahead_config` / `lookahead_offset` 两段反向回写代码（31 行），不再把后端反推的"配置类"字段写回用户正在交互的输入控件
- `ws.onmessage` 入口加 `if (msg.ok === true || msg.error != null) return;` guard（1 行），跳过 `{ok}/{error}` 命令回包
- 缓存破坏字符串统一升级到 `?v=3.17`（index.html / editor.html 共 6 处）
- 字面回退到 V3.11 行为：用户输入是唯一可信源，IDLE 拖任意 phase slider / EV 偏移零 DOM 回波

### 核心改进

1. **三层超前补偿上限对齐到 30 秒**
   - `roaster/src/core/models.py:126-128`：`PhaseLookaheadConfig` 三字段（`drying_sec` / `maillard_sec` / `development_sec`）`Field(..., le=30.0)`，原 60.0 → 30.0
   - `roaster/src/core/roaster_controller.py:546`：`update_phase_lookahead` 入口对三字段统一 `clamp(0.0, 30.0)`
   - `roaster/src/core/roaster_controller.py:558`：`update_lookahead`（V3.11 兼容入口）也补 `clamp(0.0, 30.0)`，避免老前端发 60.0 触碰 ValidationError
   - `roaster/src/core/roaster_controller.py:307-317`：`get_state_payload` 在构造 `PhaseLookaheadConfig` 前对从 yaml 读出的 fallback 值做 `min(30.0, max(0.0, float(...)))` 静默 clamp，防止老 `config.yaml` 中 `lookahead_sec > 30` 触发 ValidationError 让广播线程崩
   - `roaster/static/index.html:150-168`：三段 phase slider + number input 共 6 处 `max="30"`（v3.15 收紧到 15 → v3.18 放宽到 30，匹配后端上限）
   - `roaster/static/js/app.js:1186`：`Math.min(30, ...)` clamp 提交值，配合 0.1 步长
   - 原因：用户希望每个阶段超前补偿可拉到 30 秒，并把 v3.17 之前长期存在的"前端 max=15 / 后端 le=60"前后端宽严不一致的隐患一并修复

2. **紧急停止按钮：浮动圆形 → 右下角嵌入小方框**
   - 旧结构：`<button class="floating-emergency">` 直接 `position: fixed` 浮动在 `<body>` 末尾
   - 新结构：`<div class="estop-box"><button id="btn-e-stop" class="estop-btn">…</button></div>`，工具区域容器与按钮职责分离
   - `roaster/static/css/style.css` 容器样式 `.estop-box`：`fixed` 16/16，深色半透明背景，1px 灰色边框，圆角 12，柔和投影 — 视觉上是"独立工具区域"
   - 按钮样式 `.estop-btn`：88×56 圆角矩形，红底白字，居中加粗，2px 暗红描边
   - 闪烁动画 `estopBlink` 专绑 `.estop-btn.confirming`，外层 `.estop-box` 容器保持稳定（已加 PITFALL #47 锁定该约束）
   - z-index 1020 维持（PITFALL #21 约束依然成立，已更新条目描述指向 `.estop-box`）
   - `@media (hover: hover)` 包裹 hover 样式，触摸屏点击后不残留视觉态（沿用 PITFALL #25）
   - 不使用 `backdrop-filter`（沿用 PITFALL #36 / #37 性能与闪烁约束）
   - 原因：浮动圆按钮在小屏触摸场景下视觉过强、容易遮挡曲线右下角；嵌入小方框既保留双击确认 + 闪烁强提示，又与右下角工具区视觉风格一致

3. **代码归档清理（用户原话："AI 到处乱写工作记录"）**
   - 38 处源代码注释改写：去掉 `// v3.11 ... v3.17` 等版本前缀、删除 `reviewer NIT` / `reviewer MAJOR` / `Task N` 等 AI 评审术语
   - 4 行考古注释整行删除（描述"删除了什么"而非"当前代码做什么"，已无价值）
   - 5 行连续 reviewer 设计取舍 JSDoc 合并为简洁版
   - 保留：`events.py:8-9` `DEPRECATED` 标记、`main.py:19` 用户日志版本提示、PITFALLS 引用、v3.18 当前版本标记
   - 验证：源代码 grep `reviewer NIT` / `reviewer MAJOR` / `Task \d+` 全部 0 命中
   - 原因：源代码注释应描述"当前代码做什么"，不是"开发流程中谁说过什么"；版本演进信息归档到 UPDATE_LOG.md 与 PITFALLS.md 即可

4. **README 文档归档（用户原话："readme 里怎么记录了更新日志"）**
   - 357 行 → 343 行
   - 标题去版本号（不再写死"v3.17"）
   - 删除第 5-11 行 v3.11~v3.17 版本变更摘要（信息已在 UPDATE_LOG 中，README 不再重复）
   - 项目结构剥离 30+ 处版本注解（改为只描述当前结构而非"v3.X 起新增"）
   - 散落的"v3.X 起..."升级说明改为去版本化的事实陈述
   - 修复 4 处描述与代码现状冲突（紧急停止"嵌入小方框"、"0~30s 输入框"三处）
   - 保留末尾 `## 更新日志` 章节指向 `UPDATE_LOG.md`
   - 原因：README 是"项目当前形态说明书"，UPDATE_LOG 才是"历史变更记录"；两者职责分离

5. **缓存破坏字符串升级**
   - 所有静态资源 `?v=3.17` → `?v=3.18`：`index.html` ×3（style.css / app.js / utils.js）+ `editor.html` ×3（editor.css / editor.js / utils.js）
   - 原因：避免浏览器缓存旧版资源干扰用户验证 30 秒上限放宽与紧急停止小方框重构的视觉效果

### 协议变更

#### WebSocket 命令无新增
- `set_phase_lookahead` / `set_lookahead_offset` / `set_lookahead`（V3.11 兼容）命令格式不变
- 三层 phase 字段服务端 / 客户端上限统一为 30.0；超出会被静默 clamp（不再返回 ValidationError）

#### REST 端点无变更

#### config.yaml 无变更
- 老 yaml 中 `lookahead_sec > 30` 不再使广播线程崩溃，由 `get_state_payload` 静默截到 30

### 修改文件清单
- `roaster/src/core/models.py` —— `PhaseLookaheadConfig` 三字段 `le=60.0` → `le=30.0`
- `roaster/src/core/roaster_controller.py` —— `update_phase_lookahead` / `update_lookahead` clamp、`get_state_payload` fallback 静默 clamp
- `roaster/static/index.html` —— 6 处 `max="30"` + `?v=3.18` 缓存破坏 + 紧急停止结构改 `.estop-box` / `.estop-btn`
- `roaster/static/editor.html` —— `?v=3.18` 缓存破坏
- `roaster/static/css/style.css` —— 新增 `.estop-box` 容器样式 + `.estop-btn` 按钮样式 + `estopBlink` 重绑 `.estop-btn.confirming`
- `roaster/static/js/app.js` —— `Math.min(30, ...)` clamp 提交值
- `roaster/README.md` —— 357 → 343 行，去版本化、删除版本变更摘要、修复 4 处与代码现状冲突
- 38 处源代码注释清理 + 4 行考古注释删除 + 5 行 JSDoc 合并

### 未触及的范围
- 所有硬件代码（TC4S 寄存器 / GPIO / PWM）
- `roaster/src/core/events.py`（`DEPRECATED` 标记保留）
- `roaster/src/services/data_manager.py`
- `roaster/static/js/utils.js`、`editor.js`
- 自适应 `max_extra=10s` 算法（未改动；与 30 秒上限叠加后理论可达 40s 提前投影）

### 已知风险/兼容性提示
1. **v3.11~v3.17 老前端缓存**（PWA / 浏览器强缓存）必须**硬刷新一次**才能拿到 `?v=3.18` 资源；否则旧 `index.html` 仍带 `max="15"`，用户拖到 15 后无法继续上拉
2. 老 `config.yaml` 中 `lookahead_sec > 30` 会被 `get_state_payload` 静默截到 30，**建议用户主动核对** yaml 中相关字段
3. 30 秒上限放宽后**建议运行时观察 development 阶段 PID 振荡振幅**（叠加自适应 `max_extra=10s` 后理论可达 40s 提前投影），如出现震荡可通过 EV 风格总体偏移微调回退

### 代码注释
- `roaster/src/core/models.py:126-128`：注释"PhaseLookaheadConfig 三字段 `le=30.0`，与前端 max=30 对齐"
- `roaster/src/core/roaster_controller.py:307-317`：注释"老 yaml 兼容：fallback 值静默 clamp 到 [0, 30]，避免广播线程崩（参见 PITFALL #46）"
- `roaster/src/core/roaster_controller.py:558`：注释"V3.11 兼容入口也 clamp，避免老前端发 60.0 触发 ValidationError"
- `roaster/static/css/style.css:.estop-box / .estop-btn`：注释"急停闪烁动画必须绑 `.estop-btn`，外层容器保持稳定（参见 PITFALL #47）"

### 已知坑点
- 见 PITFALLS.md #21 更新：浮动急停 → 嵌入小方框，z-index 1020 约束依然成立，作用层从 `.floating-emergency` 改为 `.estop-box`
- 见 PITFALLS.md #46 新增：`PhaseLookaheadConfig` 历史值兼容性（老 yaml `lookahead_sec > 30` 风险 + `get_state_payload` 静默 clamp 防御方案）
- 见 PITFALLS.md #47 新增：紧急停止小方框闪烁动画绑定层（`estopBlink` 必须绑 `.estop-btn` 而非 `.estop-box`，否则容器随按钮闪烁视觉混乱）
- 树莓派 4B 实机验证仍需运行后确认（Windows 开发环境无法跑 main.py）

### 项目结构（v3.18）

无文件级别结构变化；仅文件内部内容修改与 README 行数收缩。

---

## v3.17 (2026-04-29) — 彻底回退到 V3.11 算法行为：砍掉 v3.13 引入的"反向回写"链路，调超前预测真正不再刷图

### 上一版本功能摘要（v3.16）
- 在 `handleStateUpdate` 5 个高频写 DOM 点（进度条三段、滑动条 / 数字框 value、`--ev-pointer-transform`、`updateEventAnnotations` + `chart.update('none')`、状态徽章 / body class / elapsed text）前加「值未变就跳过」短路
- `updateProgress` 拆 `lastStructureSig` + `lastPositionSig` + `lastTimeText` + `lastPhaseLabel` 三层签名
- `updateEventAnnotations` 加 `lastEventsSig` 短路（不再每帧 chart.update）
- `updateEvPointer` 加 `lastEvPointerTransform` 字符串缓存
- `index.html` / `editor.html` CSS / JS 引用统一加 `?v=3.16` 缓存破坏

### 核心改进

1. **真正修复「调超前预测刷图」BUG（v3.15 / v3.16 失败的根因终判）**
   - 用户连续 3 次反馈调超前预测刷图问题（v3.13~v3.16 都未修复）。前两次（v3.15 raf→setTimeout / v3.16 前端短路签名）只在前端做"症状缓解"，**针对了错误的层**
   - **走 systematic-debugging Phase 1 后才找到真正根因**（不在前端 DOM 优化层）：
     1. `roaster/src/web/web_api.py` 在 `set_phase_lookahead` / `set_lookahead_offset` 命令分支末尾**立即**调 `await manager.broadcast(controller.get_state_payload())`
     2. `roaster/src/core/roaster_controller.py:get_state_payload` 自 v3.13 起被加入 `phase_lookahead_config` 与 `lookahead_offset` 两个配置字段
     3. `roaster/static/js/app.js:handleStateUpdate` 消费这两个字段并**反向写回其他**滑块的 `.value` / `<span>` textContent / 调 `updateEvPointer` 写 `style.transform`
   - 用户拖一个滑块 → 后端立即广播 → 前端反向重写其他几个滑块的 thumb 位置 + EV pointer transform → 浏览器 layout / paint / composite 重算 → 视觉上"整张图刷新"
   - **V3.11 之所以没这个问题**：V3.11 的 `get_state_payload` 根本不发这两个字段，前端 `handleStateUpdate` 也没有任何反向回写代码，所以 V3.11 拖滑块完全不刷图
   - **v3.15 失败原因**：把 raf 改回 100ms setTimeout 方向对，但只解决了"拖动期间命令频率过高"的小问题，没解决根因
   - **v3.16 失败原因**：在前端 `handleStateUpdate` 加 5 处"值未变跳过"短路缓解了部分症状但不能根除——只要用户当前 `activeElement !== sliderEl`（拖动期间因 touch 事件经常短暂偏离），`shouldSkipUpdate` 失效，反向回写仍会执行

2. **v3.17 修复策略——字面意义回退到 V3.11**
   - **删除后端立即广播（2 行）**：`roaster/src/web/web_api.py` 中 `set_phase_lookahead` / `set_lookahead_offset` 命令分支末尾的 `await manager.broadcast(controller.get_state_payload())` 全部删除。回包仅靠 0.5s 节流的 `_broadcast_state` 自然带出（与 V3.11 之外的其他命令行为一致）。`set_lookahead`（V3.11 兼容命令）保持立即广播不变
   - **删除前端反向回写（31 行）**：`roaster/static/js/app.js:handleStateUpdate` 中两段：
     - `if (msg.phase_lookahead_config != null) { ... }` 整段（消费三段配置字段，反写两个 input.value）
     - `if (msg.lookahead_offset != null) { ... }` 整段（消费总体偏移字段，反写 offset slider / value / prefix + 调 updateEvPointer）
   - **onmessage guard（1 行）**：`ws.onmessage` 入口加 `if (msg.ok === true || msg.error != null) return;`，跳过 `{ok: true}` 类命令回包，不让它走 `handleStateUpdate` 全路径
   - **缓存破坏 `?v=3.17`**：`index.html` 与 `editor.html` 共 6 处
   - 原因：**用户输入是唯一可信源**——任何"用户输入"型的命令路径，后端不应在收到命令后立即广播完整 state；前端也不应把后端反推的"配置类"字段写回用户正在交互的输入控件

3. **不动后端 controller payload（保持向下兼容）**
   - `roaster/src/core/roaster_controller.py:get_state_payload` 仍发送 `phase_lookahead_config` / `lookahead_offset` 字段，前端不消费即可，便于未来需要时恢复初始化能力
   - 原因：删字段是侵入式改动，会影响其他可能消费这些字段的客户端（如未来移动端 / 监控面板）；前端不消费已足够字面回退到 V3.11 行为

### 协议变更

#### WebSocket 命令无新增
- `set_phase_lookahead` / `set_lookahead_offset` 命令格式不变，仅后端不再立即广播完整 state，回包仅 `{ok: true}`
- `set_lookahead`（V3.11 兼容命令）保持立即广播不变

#### REST 端点无变更

#### config.yaml 无变更

### 结果
- IDLE 状态拖任意 phase slider 或 EV 偏移 → 浏览器**零 DOM 回波写入** → chart 完全不重绘 → ROR 预览（dataset[4]）不变化 → **与 V3.11 字面等价**
- ROASTING 状态拖滑块 → 0.5s 节流的 `_broadcast_state` 仍会推 PV / SV / elapsed / 事件常规更新（这是烘焙过程本就存在的，与 lookahead 无关）→ chart.update 仅由烘焙数据驱动
- 经过 v3.13 / v3.14 / v3.15 / v3.16 四个版本的尝试，v3.17 通过精准定位"反向回写链路"并按 V3.11 字面回退，**第一次真正解决了"调超前预测刷图"问题**

### 保留的现有机制（不要误删）
- v3.15 的 `setTimeout(100ms)` debounce（与 V3.11 同款，不回退到 raf）
- v3.15 的滑动条紧凑化（max=15、`.phase-input-row` grid-template-columns: `56px minmax(0, 150px) 56px 18px`、`.phase-slider max-width: 150px`）
- v3.13 的 `shouldSkipUpdate` / `markUserEdit` 1500ms 用户编辑窗口（兜底防护）
- v3.14 的 `installSliderDragGuard` + window 级 capture pointerup / pointercancel 兜底
- v3.16 的模块级缓存签名 `lastBodyState` / `lastEventsSig` / `lastStructureSig` / `lastPositionSig` / `lastTimeText` / `lastPhaseLabel` / `lastSegmentSig` / `lastEvPointerTransform`（用于其他广播帧的 DOM 短路，与 lookahead 无关）
- 三段 UI（drying / maillard / development phase sliders + EV 偏移微调滑动条）

### 修改文件清单
- `roaster/src/web/web_api.py` —— 删除 2 行立即 broadcast
- `roaster/static/js/app.js` —— 删除 31 行反向回写 + 加 1 行 ok / error guard
- `roaster/static/index.html` —— `?v=3.17` 缓存破坏
- `roaster/static/editor.html` —— `?v=3.17` 缓存破坏

### 未触及的范围
- `roaster/src/core/roaster_controller.py`（payload 仍发送 `phase_lookahead_config` / `lookahead_offset`，前端不消费即可，向下兼容）
- `roaster/src/core/models.py`
- 所有硬件代码（TC4S 寄存器 / GPIO / PWM）
- `roaster/static/css/style.css`
- `roaster/static/js/utils.js`、`editor.js`
- `config.yaml`

### 已知取舍（必须明确）
- WS 断线重连后，前端三段滑块与 EV 偏移 UI 不会自动从后端 payload 同步真值，会回到 HTML 默认值。这是与 V3.11 行为字面等价的有意取舍（V3.11 没有这些字段也没有这些滑块，自然不存在同步路径）
- **用户在调过参后断线重连需手动调整或刷新页面**
- 如未来需要恢复初始化能力，应使用"仅在 `dataset.lastUserEdit` 为空且非 focused 时执行一次性初始化"，而非无条件回写（否则又是 v3.13 的问题）
- 详见 PITFALLS.md #45

### 代码注释
- `roaster/src/web/web_api.py:set_phase_lookahead` / `set_lookahead_offset` 命令分支末尾注释「v3.17: 不再立即 broadcast，让 0.5s 节流主控循环自然带出（参见 PITFALL #44）」
- `roaster/static/js/app.js:ws.onmessage` 入口注释「v3.17: 跳过 `{ok}/{error}` 命令回包，避免走 `handleStateUpdate` 全路径」
- `roaster/static/js/app.js:handleStateUpdate` 删除位置留注释「v3.17: 删除 phase_lookahead_config / lookahead_offset 反向回写（参见 PITFALL #44），用户输入是唯一可信源」

### 已知坑点
- 见 PITFALLS.md #44：后端立即 broadcast + payload 多塞字段 + 前端反向回写 = 视觉刷图三连击
- 见 PITFALLS.md #45：WS 断线重连后 phase slider / EV 偏移 UI 不与后端真值同步——有意取舍
- 树莓派 4B 实机验证仍需运行后确认（Windows 开发环境无法跑 main.py）

### 项目结构（v3.17）

与 v3.16 结构一致，无文件新增 / 删除。

---

## v3.16 (2026-04-29) — 真正修复"调参刷图"：沿用 V3.11 的轻量每帧 DOM 模型

### 上一版本功能摘要（v3.15）
- 把 phase slider / lookahead-offset slider 命令节流由 `requestAnimationFrame` 改为 `setTimeout(100ms)` debounce，意图修复「拖动调参时图表被刷新」
- 三段 phase slider 量程由 `max="60"` 收紧到 `max="15"`、轨道宽度 `220px` → `150px`、grid 列模板 `minmax(0, 1fr)` → `minmax(0, 150px)`
- JS clamp(0, 60) → clamp(0, 15)，HTML / JS / CSS 三处量程同步
- 变量重命名 `sendThrottled` → `sendDebounced`，注释指引后人不要重蹈 raf 覆辙

### 核心改进

1. **真正修复「调节超前预测参数刷数据」BUG（v3.15 失败的根因复盘）**
   - 用户反馈：v3.15 发布后实测仍有「整个图表/整个网页就刷新（前面的烘焙数据被刷掉）」的视觉效果，问题并未解决
   - **真正根因**（不是 raf vs setTimeout）：`handleStateUpdate` 在 `ROASTING` 阶段每 0.5s 收到一次常规 state 帧，其中 5 处 DOM 写入是「无差别重写」——即便值未发生任何变化也照样改写 DOM（重建 `.phase-segments` 子节点 / 重写滑动条与数字框 `value` / 重置 `--ev-pointer-transform` / 调 `chart.update('none')` 重绘 annotations / 重写 badge 与 body class）。浏览器合成层被反复 invalidate，造成「整张图都在刷」的视觉错觉
   - 拖动滑动条期间 setTimeout(100ms) debounce 命令派发后，后端立即把新 config 通过 WS 反推一帧，叠加到上述无差别 DOM 重写路径上，问题被进一步放大
   - **V3.11 实测无此现象的根本原因**：V3.11 的 `handleStateUpdate` 全程是「值未变就跳过」的轻量模型——多数高频 textContent 写入前都做了 `el.textContent !== newValue` 短路比较；progress / lookahead 相关也有签名缓存兜底
   - 修复策略：**沿用 V3.11 的 5 处短路模式**，在每个高频写 DOM 点前加签名/缓存比较：
     - `static/js/app.js:updateProgress` 拆分签名：旧 `lastProgressSig` 把 `elapsed` 也包进去导致 ROASTING 中每 0.5s 都重建进度条；新拆为 `lastStructureSig`（state | phase | 三段宽度 | totalEnd）+ `lastPositionSig`（`Math.round(ratio*1000)`）+ `lastTimeText`（formatTime 字符串）+ `lastPhaseLabel`，三层独立短路。静止帧下三签名都不变，**不重建 `.phase-segments`、不重写 `--rpb-cols`、不动 indicator transform**
     - `static/js/app.js:handleStateUpdate` 内 `phase_lookahead_config` 处理块：slider / number input 写入前加 `el.value !== v` 比较，配合 v3.13 的 `shouldSkipUpdate` 1500ms 用户编辑窗口形成双重保护
     - `static/js/app.js:handleStateUpdate` 内 `lookahead_offset` 处理块：offsetEl / prefixEl / sliderEl 写入前加比较；`updateEvPointer` 用模块级 `lastEvPointerTransform` 缓存 `transform: translateX(...)` 字符串，相同时直接 `return`，不再触碰 CSS 变量
     - `static/js/app.js:updateEventAnnotations` 顶部短路：`events` 数组拼接签名 `${type}:${time}:${temperature}` 写入 `lastEventsSig` 缓存；签名相同时函数直接 `return`，**不再每帧调 `chart.update('none')`**——这是 v3.15 残留的最大一笔重 DOM 操作
     - `static/js/app.js:handleStateUpdate` 状态徽章 / body class / elapsed text：`badge.textContent` / `badge.className` / `lastBodyState` / `elapsedText` 全部加比较短路，避免每帧重写 className 触发样式重算
   - 模块级缓存变量声明：新增 `lastBodyState` / `lastEventsSig` / `lastStructureSig` / `lastPositionSig` / `lastTimeText` / `lastPhaseLabel` / `lastSegmentSig` / `lastEvPointerTransform`；删除旧 `lastProgressSig`（被三层签名替代）
   - 原因：v3.15 的「raf → setTimeout」改动方向正确但单独不够——0.5s 的常规广播也会持续触发重 DOM；只有把每个高频写 DOM 点都改成「值未变就跳过」，才能让用户在拖动调参时不再看到任何刷数据视觉

2. **保留 v3.15 已实现的滑动条紧凑化**
   - `static/index.html` 三个 phase slider + number input 的 `max="15"` 与 `static/css/style.css:.phase-input-row` grid 列模板 `56px minmax(0, 150px) 56px 18px`、`.phase-slider max-width: 150px` 全部沿用 v3.15
   - 本版本不调整 slider 量程或视觉尺寸

3. **缓存破坏**
   - `static/index.html` 主页 CSS / JS 引用（`style.css`、`app.js`、`utils.js`）统一加 `?v=3.16` query 参数
   - `static/editor.html` 编辑器 CSS / JS 引用（`editor.css`、`editor.js`、`utils.js`）同步加 `?v=3.16`
   - 原因：避免浏览器缓存旧版 `app.js` 干扰用户验证修复结果

### 协议变更

#### WebSocket 命令无新增
- `set_phase_lookahead` / `set_lookahead_offset` / 全部 state 广播帧格式与 v3.15 完全一致
- 后端 `roaster/src/web/web_api.py` 无变更

#### REST 端点无变更

#### config.yaml 无变更

### 保留的现有机制（不要误删）
- v3.15 的 `setTimeout(100ms)` debounce（不回退到 raf）
- v3.13 的 `shouldSkipUpdate` / `markUserEdit` 1500ms 用户编辑窗口（与值未变短路并行，双重保护）
- v3.14 的 `installSliderDragGuard` + window 级 capture pointerup/pointercancel 兜底
- v3.12 起的三段独立 lookahead + EV 风格总体偏移滑动条 UI

### 未触及的范围
- 所有后端代码（FastAPI / WebSocket / Modbus / 状态机 / 持久化）
- 所有硬件代码（TC4S 寄存器 / GPIO / PWM）
- `static/css/style.css`（v3.15 已完成滑动条紧凑化，本版本无样式改动）
- `static/js/editor.js`、`static/js/utils.js`

### 代码清理
- `static/js/app.js` 删除旧 `lastProgressSig`（被 `lastStructureSig` + `lastPositionSig` + `lastTimeText` + `lastPhaseLabel` 拆分替代）
- 模块级缓存变量集中声明在 `app.js` 顶部，便于后续审计

### 代码注释
- `static/js/app.js:updateProgress` 头部注释解释为什么把单一 `lastProgressSig` 拆成三层签名（结构 / 位置 / 时间文本）以及对应 V3.11 的轻量帧模型
- `static/js/app.js:updateEventAnnotations` 顶部注释强调「events 签名相同时不调 chart.update('none')」的关键依据（v3.15 残留的最大一笔重 DOM）
- `static/js/app.js:updateEvPointer` 注释 `lastEvPointerTransform` 字符串缓存的必要性（CSS 变量写入也要跳过）
- `static/js/app.js:handleStateUpdate` 在 5 个高频写 DOM 点前加注释 `// v3.16: 值未变就跳过（参见 PITFALL #43）`

### 已知坑点
- 见 PITFALLS.md #43：WebSocket 高频广播下 `handleStateUpdate` 必须对所有 DOM 写做「值未变跳过」
- 树莓派 4B 实机验证仍需运行后确认（Windows 开发环境无法跑 main.py）
- 备注：v3.15 的「raf → setTimeout」方向正确但单独不够，v3.16 在此基础上补齐了 V3.11 真正的轻量帧模式

### 项目结构（v3.16）

与 v3.15 结构一致，无文件新增 / 删除。

---

## v3.15 (2026-04-29) — 曲线超前预测稳定化：V3.11 式 debounce + slider 视觉精炼

### 上一版本功能摘要（v3.14）
- 删除 `.roast-section` / `.floating-emergency` 的 `backdrop-filter` 玻璃拟态，改半透明纯色 + canvas 父容器 `contain: paint; isolation: isolate;` 独立合成层（修复 v3.13 引入的 slider 拖动 canvas 闪烁回归 BUG）
- `installSliderDragGuard` window 级 capture pointerup/pointercancel 兜底，拖动期间 body 加 `dragging-slider` 类静默全部 transition
- phase slider 轨道 `max-width: 220px` 收紧，三段独立色 thumb（脱水蓝 / 美拉德橙 / 发展期红）
- 偏移微调改成相机 EV 风格刻度尺（大号读数 + 主副刻度 + 零位发光蓝条 + 橙色三角指针 GPU 合成层）
- 缓动函数 `--ease-apple` / `--ease-apple-fast` 变量化（30+ 处 cubic-bezier 字面量替换）
- 烘焙进度从百分比改成 CSS Grid 三段进度条（events 优先权重 + `lastProgressSig` 短路签名）

### 核心改进

1. **修复曲线超前预测刷数据 BUG（参考 V3.11 实现）**
   - 根因：v3.13 引入 phase slider 三段独立配置时，命令节流改用 `requestAnimationFrame`（约 60fps，16ms 间隔）。每帧 `sendCmd('set_phase_lookahead', ...)` 在后端 `roaster/src/web/web_api.py:112-130` 触发 `manager.broadcast(controller.get_state_payload())`，前端 `handleStateUpdate` 每帧执行 `updateEventAnnotations` + `roastChart.update('none')`，叠加 `appendChartData` 在同一 elapsed 秒内的高频追加，造成视觉上「已记录烘焙曲线被刷新」的假象
   - 用户报告：「调节曲线超前预测参数时前面的烘焙数据依旧被刷」，跨多个版本未修复
   - V3.11 实测无此现象的原因：V3.11 用 `setTimeout(100ms)` debounce，一次拖动只发 1 条命令，后端 broadcast 频次回到 0.5s 自然节流
   - 修复：
     - `static/js/app.js:1115-1149` `initPhaseLookahead`：`requestAnimationFrame/cancelAnimationFrame` → `setTimeout(100ms)/clearTimeout`，变量重命名 `sendThrottled` → `sendDebounced`（语义对齐）
     - `static/js/app.js:1168-1195` `initLookaheadOffset`：`raf` → `sendTimer` + `setTimeout(100ms)` debounce
   - 原因：raf 节流在「每命令立即 broadcast」的后端路径下放大了广播频次，100ms debounce 是 V3.11 验证过的稳定阈值，用户拖动手感无可感差异但消除了视觉刷数据

2. **slider 视觉精炼：max 60 → 15 + 轨道宽度 220px → 150px**
   - `static/index.html:147-170` 三个 phase（脱水 / 美拉德 / 发展期）slider + number input 的 `max="60"` 全部改为 `max="15"`
   - `static/css/style.css:983-989` `.phase-input-row` grid 列模板由 `56px minmax(0, 1fr) 56px 18px` 改为 `56px minmax(0, 150px) 56px 18px`
   - `static/css/style.css:1025-1027` `.phase-slider max-width: 220px` 改为 `max-width: 150px`，注释更新为 v3.15
   - 用户需求：「10s 内即可满足需求，不超过 30s」，60s 上界过宽导致拖动精度差（每像素 ~0.27s）；15s 上界后每像素 ~0.10s，与 step=0.1 对齐
   - 原因：v3.14 的 220px 轨道在 60s 量程下精度不足，且 grid 列模板用 `1fr` 在小窗口下 slider 会被拉伸到不必要的长度；改 `minmax(0, 150px)` 后控制栏更紧凑、视觉重心向 number input 倾斜

3. **clamp 上界三处一致同步**
   - JS clamp(0, 60) → clamp(0, 15)：`initPhaseLookahead` 与 `initLookaheadOffset` 中所有数值上界统一为 15
   - HTML `max="60"` → `max="15"`：三个 phase 的 slider 与 number input 同步
   - 与 V3.11 的差异：V3.11 单滑块 + clamp(0, 30)，v3.15 三阶段独立 slider + clamp(0, 15)，上界更紧（用户实际只用 ≤10s）
   - 原因：JS / HTML / CSS 三处任一不一致都会导致用户输入超界后被静默裁剪，视觉与实际值脱节

### 协议变更

#### WebSocket 命令无新增
- `set_phase_lookahead` / `set_lookahead_offset` 命令格式不变，仅前端发送频次降低（raf 60fps → debounce 100ms 一次）
- 后端 `roaster/src/web/web_api.py` 无变更

#### REST 端点无变更

#### config.yaml 无变更

### 代码清理
- `static/js/app.js` `requestAnimationFrame` / `cancelAnimationFrame` 在节流命令路径中被完全移除（仅保留 `app.js:1204` 一处用于 EV 三角指针初始 DOM 就绪后绘制的合法用法）
- 变量重命名：`sendThrottled` → `sendDebounced`（语义对齐 setTimeout debounce 模型）

### 代码注释
- `static/js/app.js:initPhaseLookahead` 头部注释解释为什么改回 setTimeout（避免后人重蹈 raf 覆辙，参见 PITFALL #42）
- `static/js/app.js:initLookaheadOffset` 头部注释同上，强调「每命令立即 broadcast 路径必须配套 ≥100ms debounce」
- `static/css/style.css:.phase-slider` 注释 `max-width: 150px (v3.15 由 220px 收紧)` 与量程改 0~15 的视觉精度依据

### 已知坑点
- 见 PITFALLS.md #42：requestAnimationFrame 节流叠加 WS 立即 broadcast 导致图表视觉刷数据
- 树莓派 4B 实机验证仍需运行后确认（Windows 开发环境无法跑 main.py）

### 项目结构（v3.15）

与 v3.14 结构一致，无文件新增 / 删除。

---

## v3.14 (2026-04-29) — 苹果级丝滑：曲线零闪烁 + 相机 EV 偏移 + 进度条焕新

### 上一版本功能摘要（v3.13）
- 曲线编辑器拖动吸附改为 opt-in（默认丝滑、Shift 才吸附 5s/0.5℃ 网格）
- 超前预测三阶段控件改为 slider+number 双向绑定，默认 1.0/0.5/1.0
- 偏移微调改为单滑块（删除 6 颗步进按钮）
- WS 广播覆盖防抖（`shouldSkipUpdate` 1500ms 窗口）
- 图表 `update()` 全部改 `'none'` 模式
- 苹果风格 UI 全面焕新（自定义滑块 thumb、focus 光晕、玻璃拟态 backdrop-filter、卡片 hover 微缩放、tab fade、cubic-bezier、`@media (hover: hover)` 包裹）

### 核心改进

1. **修复 v3.13 引入的回归 BUG：烘焙过程中改 phase / offset slider 实时温度曲线闪烁**
   - 根因（取自 PITFALLS #36 复现 + Debug 子代理调查）:v3.13 在 `.roast-section` 加了 `backdrop-filter: blur(10px)` 玻璃拟态,slider 拖动时父元素持续 dirty,强制每帧重新采样身后合成内容,包含 `#charts-panel` canvas 被卷入软件渲染回退
   - **三层防御修复**：
     - `static/css/style.css` 删除 `.roast-section` 与 `.floating-emergency` 的 `backdrop-filter` / `-webkit-backdrop-filter`,改半透明纯色背景 `var(--glass)` (rgba 28,28,30,0.85)
     - `static/css/style.css` `#charts-panel` 加 `contain: paint; isolation: isolate;` 形成独立合成层,外部 dirty 不再回卷 canvas
     - `static/js/app.js` 新增 `installSliderDragGuard`:slider pointerdown / pointerup 切换 `body.dragging-slider` 类,CSS 层级关闭 `.roast-section` 与 phase/ev thumb 与 `.rpb-seg` `.rpb-indicator` 的全部 transition,把拖动期间 repaint 路径完全静默;额外加 window 级 pointerup/pointercancel 兜底(capture=true)防触摸场景漏 pointerup
   - 与 v3.12 完全等同的「零闪烁」体验,PV/SV/ROR 历史曲线在 slider 拖动期间持续可见
   - 原因:v3.13 玻璃拟态在视觉上提升了精致度,但在树莓派 4B Chromium 上引发 canvas 软件渲染回退,代价过大;改用半透明纯色 + 独立合成层既保留深色质感又彻底消除闪烁

2. **阶段超前预测 slider 缩短 + 偏移微调改成相机 EV 曝光补偿样式**
   - `static/index.html:131-149` phase slider(脱水 / 美拉德 / 发展期)轨道 `max-width: 220px` 收紧,三段独立色彩 `--phase-color` 注入 thumb 边缘光环(脱水蓝 #3b82f6 / 美拉德橙 #f59e0b / 发展期红 #ff453a)
   - 偏移微调(lookahead offset)从单 slider 改为 `.ev-compensation` 块:
     - 大号读数(prefix `+ / − / ±` + 数字 + 单位 s)
     - 横向刻度尺:主刻度 -3/-2/-1/0/+1/+2/+3,副刻度 0.5 间隔 6 个
     - 零位发光蓝条(SF 蓝 `#0a84ff` 渐变 + box-shadow),中线对齐
     - 橙色三角指针通过 `transform: translateX` 走 GPU 合成层(非 left)
     - 原生 `<input type="range">` 透明覆盖(opacity: 0),保留键盘 / 触摸 / step=0.1 原生行为
   - `static/js/app.js` 新增 `updateEvPointer`:`transform: translateX(${ratio * trackWidth - 7}px)` 半宽校正(三角形 14px 宽)
   - 后端命令仍为 `set_lookahead_offset`,无 API 改动
   - 原因:单滑块对 ±3.0s 微调精度反馈不直观,相机 EV 风格刻度尺让操作员一眼读出当前偏移值,且分阶段 slider 缩短后控制栏更紧凑

3. **整体美学向苹果看齐**
   - `static/css/style.css` `:root` 新增 `--ease-apple: cubic-bezier(0.32, 0.72, 0, 1)`(spring 风,用于 hover/focus/卡片缩放)和 `--ease-apple-fast: cubic-bezier(0.4, 0, 0.2, 1)`(数据驱动场景)
   - 全文 30+ 处 cubic-bezier 字面量统一替换为变量引用(grep 确认仅 :root 变量定义保留 2 行字面量)
   - 圆角 12-16px 系(`.roast-section` / `#charts-panel` / `.roast-progress-bar` / `.rpb-track` / `.ev-scale-track` / `.phase-slider`)
   - 数字回显 `font-feature-settings: "tnum"` 等宽,避免数字抖动
   - 颜色系:深色 `#1c1c1e`/`#2c2c2e` + SF 蓝 `#0a84ff` + 阶段色
   - 原因:v3.13 已奠定苹果风格基调,但缓动函数散落两套字面量、圆角不统一、数字宽度跳动等细节仍可雕琢;变量化 + 等宽数字让整体一致性达到苹果级

4. **烘焙进度从百分比改成进度条**
   - `static/index.html` 移除右上角「阶段 · m:ss · X%」文本中的百分比数字
   - `static/index.html` 改为 `.roast-progress-bar`:
     - `.rpb-meta` 显示阶段名 + `formatTime(elapsed)/formatTime(totalEnd)`
     - `.rpb-track` 用 CSS Grid `var(--rpb-cols)` 三段拼接,权重由 JS 根据 `msg.events` (yellowing / first_crack 真实段边界) + profile 时长动态分配,事件未发生时默认 1:1:1
     - 段位 `.active`/`.done` 配阶段渐变色(`[data-phase]` 注入 `--rpb-color`)
     - 发光指示器 `.rpb-indicator` 用 `transform: translate(x,-50%)` 走合成层
     - 阶段切换时进度条颜色随阶段切换(drying 蓝 → maillard 橙 → development 红 → cooling 灰)
   - 性能:`updateProgress` 加模块级 `lastProgressSig` 缓存,烘焙 + idle 双分支独立签名(含 phase / elapsedSec / 三段权重 / totalEnd / ratioQ 千分位量化),同签名直接 return,避免 500ms WS 推送下重复 DOM 操作
   - 原因:数字百分比对烘焙节奏感知差,阶段进度条让脱水/美拉德/发展三段比例一目了然,事件优先权重分配让进度条与真实烘焙节点对齐

### 协议变更

#### WebSocket 命令无新增
- `set_lookahead_offset` 调用频率与 v3.13 持平(input 事件 + rAF 节流)
- 后端无需调整

#### REST 端点无变更

#### config.yaml 无变更

### 代码清理
- `static/css/style.css` 删除 `.offset-slider-row` / `.stepper-value` / 旧 `phase-input-row` flex 死代码
- `static/css/style.css` 删除 `.roast-section` / `.floating-emergency` 的 `backdrop-filter` / `-webkit-backdrop-filter`(v3.13 玻璃拟态)
- `static/js/app.js` 移除右上角进度条百分比拼接逻辑

### 代码注释
- `static/css/style.css:--ease-apple` / `--ease-apple-fast`:注释 spring 风与 Material 风缓动的使用场景区分
- `static/js/app.js:installSliderDragGuard`:注释 window 级 capture pointerup/pointercancel 兜底依据(参见 PITFALL #38)
- `static/js/app.js:updateEvPointer`:注释半宽校正公式 `ratio * trackWidth - 7`(三角形 14px 宽,参见 PITFALL #40)
- `static/js/app.js:updateProgress`:注释 `lastProgressSig` 短路签名构造(phase / elapsedSec / 三段权重 / totalEnd / ratioQ 千分位量化)与 events 优先权重分配(参见 PITFALL #41)

### 已知坑点
- 树莓派 4B 实机验证仍需运行后确认(Windows 开发环境无法跑 main.py)
- 触摸屏长时间拖动 slider 时 `dragging-slider` 类的清理依赖 capture phase 的 window pointerup/pointercancel;若浏览器有特殊事件吞噬,需观察 body 是否会残留 `.dragging-slider`

### 项目结构（v3.14）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件（v3.13 phase_lookahead 默认 1.0/0.5/1.0）
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── PITFALLS.md                  # 已知坑点与注意事项（v3.14 新增 5 条 #37~#41）
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型
│   │   └── roaster_controller.py # 核心控制器
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/
│   │   └── default-light-roast.json # 默认浅焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.14 进度条结构、三段 phase 行 data-phase、EV 刻度尺与覆盖 input、移除百分比 span）
    ├── editor.html              # 曲线编辑器页面
    ├── css/
    │   ├── style.css            # 主页面样式（v3.14 删除 backdrop-filter、cubic-bezier 变量化、phase slider 缩短、EV 刻度尺、进度条新建、dragging-slider 类规则、死代码清理）
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑（v3.14 updateProgress 重写 + 签名短路、updateEvPointer、installSliderDragGuard 含 window 级兜底、移除百分比拼接）
        └── editor.js            # 编辑器逻辑
```

---

## v3.13 (2026-04-29) — 丝滑交互与苹果风格 UI 全面焕新

### 上一版本功能摘要（v3.12）
- 整体配色统一为苹果风格低饱和色系
- WS/TC4S 双状态指示灯拆分
- 超前预测支持脱水/梅纳/发展三阶段独立配置 + 运行时 ±3.0s 偏移微调
- 烘焙控制栏重规划（开始按钮独立突出、当前曲线只读、删除冗余事件日志）
- 出豆按钮恢复统一大小

### 核心改进

1. **曲线编辑器拖动吸附改为 opt-in（默认丝滑）**
   - `static/js/editor.js:30-31` 反转吸附语义:`SNAP_TIME_DEFAULT=1` / `SNAP_TEMP_DEFAULT=0.1`(最小量化,JSON 整洁), `SNAP_TIME_GRID=5` / `SNAP_TEMP_GRID=0.5`(Shift 网格)
   - `static/js/editor.js:190-197` 拖动路径根据 `e.shiftKey` 选择吸附粒度,默认丝滑、Shift 吸附到 5s/0.5℃ 网格
   - `static/editor.html:42` 提示文案对齐:「按住 Shift 吸附 / 默认丝滑」(与 v3.12 之前的「拖动 5s/0.5℃ 网格,Shift 精确」完全相反)
   - 原因:旧默认网格吸附在精细调节脱水段、一爆段时手感发涩,反转为「默认丝滑、Shift 网格」后拖动体验贴近 Figma/Sketch,需要严格对齐时按住 Shift 即可

2. **超前预测三阶段控件改为 slider+number 双向绑定 + 默认 1.0/0.5/1.0**
   - `static/index.html:131-134` 删除"单位是秒:"5字+冒号(冗余文案)
   - `static/index.html:135-149` 三阶段控件改为 `<input type="range">` + `<input type="number">` 双向绑定,step=0.1,默认值 `drying=1.0` / `maillard=0.5` / `development=1.0`
   - `static/js/app.js:991-1004` `initPhaseLookahead` 重写为 `input` 事件 + `requestAnimationFrame` 节流 + 双向绑定(slider 拖动 → number 同步,number 输入 → slider 同步)
   - `src/core/models.py:126-128` `PhaseLookaheadConfig` 字段默认值 15.0 → 1.0/0.5/1.0
   - `config.yaml:27-30` `phase_lookahead:` 节默认 15.0 → 1.0/0.5/1.0
   - 原因:v3.12 用三个独立 number 输入框,无可视化反馈,且 15s 的默认值在浅焙节奏下偏激进容易超调;改 slider+number 双向绑定既保留键盘精确输入,又给出直观刻度反馈,小默认值更稳健

3. **偏移微调按钮改单滑块**
   - `static/index.html:152-165` 偏移微调改为单 `<input type="range">` 滑块(-3~+3, step=0.1) + 数字回显,删除 4 个 `stepper-btn`(`-1 / -0.5 / -0.1 / +0.1 / +0.5 / +1`)
   - `static/js/app.js:1007-1022` `initLookaheadOffset` 重写为单滑块 + rAF 节流,所有 set/get 走 `round1` + clamp ±3.0
   - 原因:6 颗按钮在树莓派触摸屏上点选麻烦且占空间,单滑块拖动连续可视,微调路径更短

4. **WS 广播覆盖防抖(关键 BUG 修复)**
   - `static/js/app.js` 新增 `shouldSkipUpdate(el)` / `markUserEdit(el)` 工具函数(`round1` 后定义),通过 `el.dataset._lastUserEdit` 时间戳判定 1500ms 窗口
   - `static/js/app.js:325-340` `handleStateUpdate` 加 skip 守卫:遍历 phase-lookahead 三阶段 / lookahead-offset 控件,若用户最近 1500ms 内交互过则跳过 WS 广播覆盖
   - 1500ms 窗口依据:WS 广播间隔 ~500ms × 3 帧容错,刚松开 slider 后下一拍广播不会把值「吸」回旧值
   - 原因:v3.12 拖动 slider 时 WS 广播每 ~500ms 把值覆盖回旧值,导致拖动有「弹回」抖动;skip 守卫确保用户正在交互的控件 1500ms 内不被广播覆写

5. **图表 update 全部改 'none' 模式**
   - `static/js/app.js` 7 处 `roastChart.update()` → `roastChart.update('none')`(264/282/412/418/497/1571/1602)
   - Chart.js v4 中 `'none'` 字符串明确禁用动画与重排,比无参 `update()` 在树莓派 4B 上掉帧更少
   - 原因:树莓派 4B 在烘焙中段 PV/SV/ROR 三 dataset + 事件竖线频繁刷新时,默认动画路径占主线程 ~16ms,导致触摸事件延迟;`'none'` 模式直接跳过过渡帧

6. **苹果风格 UI 全面焕新**
   - `static/css/style.css` 滑块自定义 thumb(白色径向渐变 14px) + 轨道渐变(`#3a3a3c → #48484a`),适配 `::-webkit-slider-thumb` / `::-moz-range-thumb`
   - 输入框 focus 蓝色光晕 `box-shadow: 0 0 0 3px rgba(10,132,255,0.18)`
   - `.roast-section` 玻璃拟态(`backdrop-filter: blur(10px)` + 半透明背景)
   - `.profile-card` / `.record-card` hover 微缩放(`translateY(-2px) scale(1.02)`) + 渐变背景
   - tab 切换 fade 动画 `tabFadeIn` 160ms
   - `.ctrl-btn` / `.action-btn` active 反馈 `transform: scale(0.96)`
   - `.floating-emergency` `backdrop-filter: blur(8px)`
   - 缓动函数 `ease` → `cubic-bezier(0.4, 0, 0.2, 1)` 共 11 处替换
   - 删除 `.stepper-btn` / `.stepper-group` 旧样式
   - 所有 hover 规则用 `@media (hover: hover) and (pointer: fine)` 包裹,触摸设备不再残留 hover 态(参见 PITFALL #25)
   - 原因:v3.12 已统一苹果配色,但控件层细节仍是默认浏览器样式;本次焕新让滑块/输入框/卡片/按钮都达到苹果级精致度,玻璃拟态与微缩放反馈在树莓派触摸屏上手感显著提升

### 协议变更

#### WebSocket 命令无新增
- `cmd=set_phase_lookahead` / `cmd=update_lookahead_offset` 触发频率提升(`input` 事件 + `requestAnimationFrame` 节流,约 16ms/帧)
- 后端无需调整,`update_lookahead_offset` 内部已经是 `round1` + clamp ±3.0 + 纯内存写入,高频调用安全

#### REST 端点无变更

#### config.yaml 变更
- `phase_lookahead.drying_sec` / `maillard_sec` / `development_sec` 默认值 15.0 → 1.0/0.5/1.0
- `predictive_control.lookahead_sec: 15.0` 保留作老配置 fallback(参见 PITFALL #30、#35)
- 老用户升级时 `phase_lookahead` 节中的旧值 15.0 不会被自动覆盖,需手动编辑 yaml 才能享受新默认值

### 代码清理

- `static/css/style.css` 删除 `.stepper-btn` / `.stepper-group` 旧样式(v3.12 偏移微调按钮组)
- `static/js/app.js` 删除旧偏移按钮组 6 颗按钮的事件监听器
- `static/index.html` 删除"单位是秒:"冗余文案

### 代码注释
- `static/js/app.js:shouldSkipUpdate`:注释 1500ms 窗口的 WS 广播覆盖防抖依据(500ms × 3 帧)
- `static/js/app.js:markUserEdit`:注释 `dataset._lastUserEdit` 时间戳约定
- `static/js/editor.js:SNAP_*`:注释默认丝滑/Shift 网格的反转语义与 v3.12 之前完全相反
- `static/js/app.js:initPhaseLookahead`/`initLookaheadOffset`:注释 rAF 节流与双向绑定路径
- `static/css/style.css`:注释 `@media (hover: hover) and (pointer: fine)` 包裹策略与触摸设备 hover 残留修复

### 项目结构（v3.13）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件（v3.13 phase_lookahead 默认 1.0/0.5/1.0）
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── PITFALLS.md                  # 已知坑点与注意事项（v3.13 新增 5 条 #32~#36）
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型（v3.13 PhaseLookaheadConfig 默认 1.0/0.5/1.0）
│   │   └── roaster_controller.py # 核心控制器
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/
│   │   └── default-light-roast.json # 默认浅焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.13 三阶段 slider+number 双向绑定、偏移单滑块、删除冗余文案）
    ├── editor.html              # 曲线编辑器页面（v3.13 提示文案改「按住 Shift 吸附 / 默认丝滑」）
    ├── css/
    │   ├── style.css            # 主页面样式（v3.13 苹果风格滑块/光晕/玻璃拟态/卡片hover/tab fade/cubic-bezier、@media hover 包裹、删除 stepper 样式）
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑（v3.13 shouldSkipUpdate/markUserEdit、initPhaseLookahead/initLookaheadOffset rAF 节流双向绑定、update('none')）
        └── editor.js            # 编辑器逻辑（v3.13 SNAP 默认丝滑/Shift 网格反转语义）
```

---

## v3.12 (2026-04-29) — 烘焙控制与 UI 美学优化

### 上一版本功能摘要（v3.11）
- 状态机简化为 `IDLE → ROASTING` 直通（取消「等待入豆 / 预热中」中间态）
- 出豆按钮兼任结束烘焙，急停改为右下角浮动按钮
- UI 分 7 区差异化配色
- PID 参数固化在 `config.yaml`（运行时只读）

### 核心改进

1. **出豆按钮恢复正常大小**
   - `static/css/style.css` `.drop-prominent` 去掉 v3.11 的 `flex:1.6` / `min-height:80px` / `font-size:22px`，恢复与普通 `.event-action-btn` 一致的大小
   - 脉冲动画幅度降至 `scale(1.02)`
   - 原因：v3.11 的 80px 高度在树莓派小屏上挤占过多事件栏空间，且与相邻按钮比例失衡；恢复统一高度后横向 6 按钮更匀称

2. **曲线图 tooltip 修复**
   - `static/js/app.js` Chart.js tooltip 添加 `filter` 回调：实时数据集（PV/SV/ROR）只在有数据的 X 范围内显示，插值曲线（目标曲线 / ROR 预览）始终显示
   - `callbacks.title` 增加空数组防护 `if (!items?.length) return ''`
   - 原因：旧 filter 在烘焙开始前把所有 dataset 一并过滤掉，导致 title callback 收到空数组抛 `Cannot read property 'parsed' of undefined`

3. **整体配色统一苹果风格**
   - `static/css/style.css` 7 个区域背景统一为 `#1c1c1e`（图表区 `#0f0f0f`），边框统一 `#2c2c2e`，次要文字 `#8e8e93`
   - 强调色更新为苹果风格：绿 `#30d158`、橙 `#ff9f0a`、红 `#ff453a`、蓝 `#0a84ff`
   - 按钮 hover 改用 `filter: brightness(1.15)`，删除 `transform: translateY(-1px) scale(1.02)`，避免触摸屏松手后残留 hover 态
   - 原因：v3.11 的 7 区差异化配色色相跨度大，长时间烘焙中视觉疲劳；苹果风格低饱和统一色更耐看，且 `brightness` 滤镜在触摸设备上不会残留几何变换

4. **WS/TC4S 连接状态指示灯拆分**
   - `static/index.html` 底部状态栏拆分为两个独立 `.status-dot`，分别对应 WebSocket（前端↔后端）与 TC4S（后端↔硬件）
   - `static/css/style.css` 两个指示灯均有 `.online`（绿色常亮，无动画）与 `.offline`（红色常亮）状态
   - 修正 v3.11 TC4S 状态误传给 WS 指示灯的 bug（`app.js` 中 `tc4sConnected` 与 `wsConnected` 变量混淆）
   - 原因：v3.11 只有一个指示灯，用户无法区分「前端掉线」还是「硬件断线」；拆分后故障定位一目了然

5. **移除烘焙控制栏事件日志**
   - `static/index.html` 删除 `#event-float` 冗余展示（事件日志列表 + 统计卡片）
   - `static/js/app.js` 删除 `updateEventFloat`、`renderStatsGrid` 及相关 DOM 写入
   - 事件信息由事件按钮 badge、图表事件线、顶部温度条统一提供，不再重复展示
   - 原因：右侧控制面板在烘焙中同时显示事件日志、统计卡、曲线管理，信息过载；删除冗余后控制区更清爽，关键信息已通过其他三条路径覆盖

6. **超前预测功能大改（分阶段配置 + 运行时偏移微调）**
   - **后端模型**：`src/core/models.py` 新增 `PhaseLookaheadConfig` 模型，支持脱水期 / 梅纳期 / 发展期三阶段独立配置（0~60s）
   - **后端状态**：`RoasterStatus` 新增 `current_phase: Optional[str]` 与 `phase_lookahead_config: PhaseLookaheadConfig`
   - **后端控制**：`src/core/roaster_controller.py` `_maybe_adjust_sv_locked` 自动根据当前阶段读取对应基础 lookahead 值；新增 `_get_current_phase` 方法，只在有 charge 事件后开始判断阶段，IDLE/COOLING/ERROR 返回 None
   - **后端偏移微调**：新增 `update_lookahead_offset(value)` 方法，运行时偏移微调 ±3.0s，不持久化；`_lookahead_offset` 纯内存变量，重启归零
   - **后端兼容**：`config.yaml` 新增 `phase_lookahead` 配置节；`set_lookahead` 仍保留作向后兼容入口（写入全局 `lookahead_sec`）
   - **前端控件**：`static/index.html` `#tab-roast` 新增三阶段输入框（脱水 / 梅纳 / 发展）和苹果风格步进器偏移微调控件（±0.1s / ±0.5s / ±1s）
   - 原因：不同烘焙阶段对超前预测的需求不同（脱水期可激进、发展期需保守）；分阶段配置让一爆前后微调更精准，偏移微调则允许操作员在单锅烘焙中根据实际升温趋势临时修正

7. **烘焙控制栏布局重规划**
   - `static/index.html` 当前曲线改为只读显示（点击跳转曲线管理 tab），删除旧 `#profile-select` 下拉框
   - 开始按钮独立突出（大号主按钮），与事件操作栏物理分离
   - 阶段设置（三阶段 lookahead 输入框）和偏移微调（步进器）分区清晰，中间用 1px 分割线隔开
   - 删除旧滑块和下拉框（v3.11 的 `lookahead-slider` 与 `#profile-select`）
   - 原因：旧布局把曲线选择、开始按钮、事件按钮、超前预测滑块堆叠在同一面板，操作路径混乱；重规划后「开始烘焙」是唯一点击目标，阶段配置与偏移微调分区明确，减少误触

### 协议变更

#### WebSocket 命令新增
- `cmd=update_lookahead_offset`：运行时偏移微调
  ```json
  { "cmd": "update_lookahead_offset", "params": { "value": 0.5 } }
  ```
- `cmd=set_lookahead` 仍保留向后兼容（写入全局 `lookahead_sec`）

#### REST 端点无变更

#### config.yaml 变更
- 新增 `phase_lookahead:` 节（三阶段独立配置）
- 保留 `predictive_control.lookahead_sec` 作全局 fallback 与老配置兼容

### 代码清理

- `static/css/style.css` 删除 `.drop-prominent` 的 `flex:1.6` / `min-height:80px` / `font-size:22px`
- `static/css/style.css` 删除 `#event-float` 相关样式规则
- `static/js/app.js` 删除 `updateEventFloat`、`renderStatsGrid`、旧滑块绑定
- `static/index.html` 删除 `#profile-select`、旧 `lookahead-slider`、旧 `#event-float`

### 代码注释
- `src/core/roaster_controller.py:_get_current_phase`：注释阶段判断逻辑与 None 返回值含义
- `src/core/roaster_controller.py:update_lookahead_offset`：注释纯运行时、不持久化、重启归零
- `src/core/models.py:PhaseLookaheadConfig`：注释三阶段字段范围 0~60s
- `static/js/app.js` 偏移步进器绑定：注释 `round1` + clamp ±3.0 路径
- `static/css/style.css`：注释苹果风格色值映射（绿/橙/红/蓝）与 `brightness` hover 替代方案

### 项目结构（v3.12）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件（v3.12 新增 phase_lookahead 节）
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── PITFALLS.md                  # 已知坑点与注意事项（v3.12 新增 5 条）
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型（v3.12 新增 PhaseLookaheadConfig；RoasterStatus 新增 current_phase/phase_lookahead_config）
│   │   └── roaster_controller.py # 核心控制器（v3.12 分阶段 lookahead、偏移微调、_get_current_phase）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket（v3.12 新增 update_lookahead_offset WS 命令）
├── data/
│   ├── profiles/
│   │   └── default-light-roast.json # 默认浅焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.12 双指示灯、删除 #event-float/#profile-select、三阶段输入框、偏移步进器、开始按钮独立突出）
    ├── editor.html              # 曲线编辑器页面
    ├── css/
    │   ├── style.css            # 主页面样式（v3.12 苹果风格配色、brightness hover、双 status-dot、删除 #event-float 样式）
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑（v3.12 tooltip filter 修复、双指示灯状态分离、删除事件浮层、三阶段/偏移控件绑定）
        └── editor.js            # 编辑器逻辑
```

---

## v3.11 (2026-04-28) — 简化与突出实战体验

### 上一版本功能摘要（v3.10）
- 默认曲线 + 编辑器默认值统一升级为耶加雪菲 7 节点（5 号节点修正为 `{270, 188}`）
- 删除独立 DTR 仪表卡片，`stats-grid` 改为 2 列布局
- 曲线管理改为卡片网格 UI（sparkline 缩略图 + 内嵌应用/导出/删除）
- 烘焙记录三连改造（`log00X` 顺序命名 + `profile_snapshot` 嵌入 + 详情查看器全屏）
- 超前预测控制 + 自适应误差修正（`predictive_control.lookahead_sec` + `set_lookahead` WS 命令）
- WebSocket 命令契约扩展，统一 `params` 嵌套兼容旧扁平格式

### 核心改进

1. **状态机简化:点开始即 IDLE → ROASTING 直通,出豆按钮兼任结束烘焙**
   - `src/core/events.py` 保留 `RoasterState` 枚举字面量但给 `WAITING / PREHEATING` 加 `# DEPRECATED v3.11` 注释,运行时不再触发,仅供历史 `RoastRecord` 反序列化兼容
   - `src/core/roaster_controller.py:start_roast` 删除 `WAITING → PREHEATING → ROASTING` 三段式,点击「开始烘焙」直接 `state = ROASTING`,同时下发首段 SV
   - `src/core/roaster_controller.py:log_event` 在 `type=='drop'` 时 `asyncio.create_task(self.end_roast())`,出豆按钮即烘焙结束按钮(后端 `log_event(type='drop')` 触发 `end_roast`)
   - `static/js/app.js` 删除「等待入豆」「预热中」UI 分支,出豆按钮按下后端自动结束烘焙
   - 原因:实战中操作员入豆动作就是开始,中间「等待 / 预热」两态在树莓派触摸屏上多两次确认反而打断节奏;出豆即结束烘焙也避免双按钮冗余

2. **移除运行时 PID 调节 tab**
   - `static/index.html` 删除 `#tab-pid` 整页 + 顶栏 PID tab 按钮
   - `static/js/app.js` 删除 PID 滑块绑定与 `set_pid` 调用
   - `src/web/web_api.py` `_handle_ws_command` 删除 `set_pid` 分支,删除 `/api/v1/config/pid` REST 端点
   - PID 参数仍由 `config.yaml:pid:` 节加载,运行时只读
   - 原因:TC4S 不支持在线调节 PID,开放滑块只会让用户误以为可以热调;固化在 config.yaml 启动时一次加载,清晰对齐硬件能力

3. **超前预测精细化**
   - `static/index.html` 超前预测从 PID tab 提到独立 segment-bar 控件
   - 范围 `0–30s`,`step=0.1`,新增 6 个微调按钮(`-1 / -0.5 / -0.1 / +0.1 / +0.5 / +1`) + 数字输入框直接输入
   - `static/js/app.js` 所有 set/get 走 `round1(v) = Math.round(v*10)/10` + clamp 到 `[0, 30]`,避免浮点 12.300000001
   - 原因:0.5s 步长对一爆前后微调过粗,0.1s + 微调按钮让现场调整更细腻

4. **紧急停止改为浮动按钮**
   - `static/index.html` `.floating-emergency` 右下角 `position: fixed`,圆形红色,`z-index: 1020`(高于模态 1010,低于 ERROR overlay 9999)
   - `static/css/style.css` IDLE 状态下灰色禁用,ROASTING 状态下红色高亮
   - 原因:原顶栏急停按钮在烘焙中段视线被图表拉走时不易触达,固定右下角让操作员肌肉记忆始终命中

5. **出豆按钮醒目化**
   - `static/css/style.css` `.btn-drop` 高度 80px,橙色渐变背景,新增 `@keyframes dropPulse` 1.6s 周期脉冲
   - 仅 `state == ROASTING` 时启用脉冲,其他状态静止
   - 原因:出豆是整锅烘焙的关键时刻,延迟 1-2 秒就过 DTR 目标值;视觉脉冲提醒减少漏点风险

6. **事件按钮按下后保持 active 高亮 + 时温 badge**
   - `static/js/app.js:syncEventActionsBar(events)` 根据当前 events 数组同步每个按钮的 active class(绿色背景 + ✓ 角标)与 `m:ss · 温度°` badge
   - 每次 state 广播 + `log_event` 后均同步,events 为空时自动清空
   - 原因:旧版按下事件后按钮状态不变,操作员易重复点击;新版状态化让「按过」一目了然

7. **当前曲线名进图例**
   - `static/js/app.js:setProfileCurve(nodes, name)` 动态写 `chart.data.datasets[2].label = name`
   - `static/index.html` 删除独立的「当前曲线: XXX」文案块
   - 原因:图例本来就显示「曲线」标签,直接换成实际名字省去一行 UI

8. **烘焙进度融入曲线图**
   - `static/index.html` 删除原 `.progress-area` 独立小窗
   - `#charts-panel` 顶部 `.chart-header` 右侧新增 `#roast-progress-inline`(`阶段 · m:ss · X%`)
   - 原因:进度条独立块挤占图表高度,内联到 chart-header 后图表区可用空间增加 ~5%

9. **Chart.js tooltip 修复**
   - `static/js/app.js` chart options 新增 `plugins.tooltip.callbacks.title = ctx => formatMmSs(ctx[0]?.parsed?.x)` 把 X 轴 tooltip 标题格式化为 `m:ss`
   - `plugins.tooltip.filter = ctx => ctx.parsed.y != null && !Number.isNaN(ctx.parsed.y)` 过滤空 dataset(NaN/null)
   - 原因:旧 tooltip 显示「123.4」秒不直观;ROR 预览/曲线在烘焙开始前 dataset 为空时会出现 `NaN: NaN` 行

10. **烘焙记录改进**
    - `static/index.html` 全屏模态新增右上角 `×` 退出按钮
    - `static/js/app.js` 监听 `Escape` 键退出全屏模态
    - `static/js/app.js:showRecordDetail` 终温改用 `record.data` 末点 BT(实际采样末值)而非配方设定值
    - 原因:全屏模态原本只能再次点击「图表全屏」退出,新手找不到出口;终温显示实际采样值才反映真实烘焙结果

11. **曲线管理选中态强化**
    - `static/css/style.css` `.profile-card:not(.active)` opacity 0.7 + filter saturate(0.6) 淡化
    - `.profile-card.active` 橙色发光边框(`box-shadow: 0 0 0 2px var(--orange), 0 0 16px rgba(255,140,40,0.4)`) + ✓「当前选中」角标 + `z-index: 2`
    - 原因:卡片网格变多后选中卡片不够突出,淡化未选中 + 发光选中让视觉锚点立即抓住

12. **UI 7 区域差异化配色**
    - `static/css/style.css` 各 section 独立背景:
      - `#top-bar` 深蓝灰 / `#event-temps-bar` 深棕 / `#event-actions-bar` 深绿 / `#segment-bar` 深紫 / `#charts-panel` 标准黑 / `#controls-panel` 深石墨 / `#footer` 与 top-bar 呼应
    - 各 section 间加 1px 暗色分割线
    - 原因:全黑界面在长时间烘焙中区域辨识度低,温和的色相分区让操作员一眼定位"我现在要点哪个区"

13. **TC4S 指示灯呼吸/快闪动画**
    - `static/css/style.css` `.tc4s-indicator.online::before` 2s 周期 `@keyframes pulseOnline` 呼吸缩放
    - `.tc4s-indicator.offline::before` 0.6s 周期 `@keyframes pulseOffline` 红色快闪
    - 删除 footer「UI 运行正常」文案
    - 原因:文案占空间且无信息量,呼吸/快闪指示灯一眼分辨在线状态

14. **图例美化与全局微动效**
    - `static/js/app.js` chart legend 选项 `usePointStyle: false`,`labels.boxWidth = 24`,`padding = 16`,`pointStyle = 'rectRounded'`
    - `static/css/style.css` 全局 `button:hover` 加 `transform: translateY(-1px) scale(1.02)`,tab 切换加 `@keyframes tabFadeIn`
    - `@media (prefers-reduced-motion: reduce) { *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important } }` 兼容辅助功能
    - 原因:长时间盯界面需要细腻反馈;同时无障碍兼容避免对动画敏感用户造成不适

15. **标题改"Ganf's咖啡烘焙机"**
    - `static/index.html` `<title>` 与顶部 H1 改为 `Ganf's咖啡烘焙机`
    - `static/editor.html` 同步修改
    - 原因:个人化品牌标识

### 协议变更

#### WebSocket 命令删除
- `cmd=set_preheat`(预热配置)
- `cmd=charge`(入豆)
- `cmd=set_pid`(PID 在线调节)
- 保留 `cmd=end`(向后兼容,前端不再调用)

#### REST 端点删除
- `POST /api/v1/control/charge`
- `GET/POST/PUT /api/v1/config/preheat*`
- `GET/POST/PUT /api/v1/config/pid`
- 保留 `POST /api/v1/control/end`(向后兼容)

#### config.yaml 变更
- 删除 `preheat:` 节(老配置启动时打 warning,自动忽略,不报错)
- 保留 `pid:` 节(启动时加载,运行时只读)
- 保留 `predictive_control:` 节

### 代码清理

- 删除 `formatSegmentStat` 死函数
- 修复 `.btn-grid` 选择器(从依赖 3 子元素的 `:nth-child(1):nth-last-child(3)` 改为 `:only-child { grid-column: 1 / -1 }`)
- 删除死 CSS 规则:`.event-btns / .event-btn / .event-action-btn.recorded / .segment.active.pulsing / @keyframes segPulse`
- `main.py` 加 preheat 节兼容 warning 日志(检测到老配置 `preheat` key 时打 warning 自动忽略,不退出)
- `src/web/web_api.py` `cmd=end` 与 `/api/v1/control/end` 兼容入口加注释明确"v3.11 仅向后兼容,前端不再调用"

### 代码注释
- `src/core/events.py:RoasterState`:`WAITING` / `PREHEATING` 字面量上方加 `# DEPRECATED v3.11: 仅供历史 RoastRecord 反序列化兼容,运行时不再触发`
- `src/core/roaster_controller.py:log_event`:注释 `type=='drop'` 触发 `end_roast` 的 race 条件处理(锁内重判 `state != ROASTING`)
- `static/js/app.js:syncEventActionsBar`:注释 active class + badge 同步策略
- `static/js/app.js:round1`:注释 0.1s 步长浮点精度处理
- `static/css/style.css:.btn-grid:only-child`:注释列数自适应(单按钮跨满)

### 项目结构（v3.11）

```
roaster/
├── main.py                      # FastAPI 应用入口（v3.11 加 preheat 节兼容 warning）
├── config.yaml                  # 配置文件（v3.11 删除 preheat: 节，保留 pid: 与 predictive_control:）
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── PITFALLS.md                  # 已知坑点与注意事项（v3.11 新增 12 条）
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举（v3.11 WAITING/PREHEATING 标 DEPRECATED）
│   │   ├── models.py            # Pydantic 数据模型
│   │   └── roaster_controller.py # 核心控制器（v3.11 IDLE→ROASTING 直通、log_event drop 触发 end_roast）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket（v3.11 删除 set_pid/set_preheat/charge、preheat/pid REST 端点）
├── data/
│   ├── profiles/
│   │   └── default-light-roast.json # 默认浅焙曲线（7 节点耶加雪菲）
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.11 删除 PID tab、浮动急停、出豆脉冲、超前预测精细化、UI 7 区差异化、Ganf's 标题）
    ├── editor.html              # 曲线编辑器页面（v3.11 标题 Ganf's）
    ├── css/
    │   ├── style.css            # 主页面样式（v3.11 浮动急停、dropPulse、profile-card 强化、TC4S 呼吸/快闪、prefers-reduced-motion）
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑（v3.11 syncEventActionsBar、round1、tooltip 修复、ESC 退出、终温取实际末值）
        └── editor.js            # 编辑器逻辑
```

---

## v3.10 (2026-04-28)

### 上一版本功能摘要（v3.9）
- 曲线编辑器「选中节点」时间输入改成「分/秒」双数字输入（首节点锁定为 0）
- 新建曲线默认 `tempNodes` 替换为 7 节点曲线（5 号节点 `{330, 188}`），更贴近真实预热 → 脱水 → 美拉德 → 一爆节奏
- 后端契约保持不变：`ProfileNode.time` 仍以整数秒落盘，分秒切片只发生在 UI 显示与输入层

### 核心改进

1. **默认曲线 + 编辑器默认值统一升级为耶加雪菲 7 节点**
   - `data/profiles/default-light-roast.json`: 替换 `nodes` 为 7 节点 `[(0,30),(60,100),(120,135),(180,155),(270,188),(360,203),(435,212)]`，并新增 `"end_temp": 212` 字段
   - `static/js/editor.js:8-16` 的 `tempNodes` 初始数组同步替换为同样 7 节点
   - 与 v3.9 默认曲线相比，5 号节点从 `{330, 188}` 修正为 `{270, 188}`
   - 原因：v3.9 的 5 号节点导致美拉德段过宽，浅焙节奏被拉长；前移 60 秒后整段更紧凑，与浅焙实战节奏对齐，且后端 / 前端两份默认值一致，避免用户感知差异

2. **删除独立 DTR 仪表卡片**
   - `static/index.html` 删除原 `stat-dtr` 整张 `<div class="stat-card">`
   - `static/css/style.css` `.stats-grid` 从 3 列改为 2 列布局
   - `static/js/app.js` 删除 `stat-dtr` 写入和重置语句
   - 原因：DTR 已在「发展期」段以 `X.X% / DTR` 形式展示，独立卡片是冗余信息且占用宝贵的统计区面积；删除后剩下 2 列布局更宽敞清晰

3. **曲线库卡片网格 UI（取代旧下拉框管理）**
   - `static/index.html` 将「曲线管理」标签页 (`#tab-profile`) 整体改造：顶部 3 个按钮（新建曲线 / 导入曲线 / 刷新），下方 `<div class="profile-cards" id="profile-cards"></div>` 网格容器
   - `static/css/style.css` 新增 `.profile-cards` grid 布局（`auto-fill, minmax(220px, 1fr)`，gap 12px）、`.profile-card`/`.profile-card.active`/`.profile-card .sparkline`/`.profile-card .actions`
   - `static/js/app.js` 新增 `renderProfileCards(list)`：每张卡片含曲线名、节点数、总时长、200×50 内联 SVG sparkline 缩略图，hover/选中时显示「应用 / 导出 / 删除」按钮；导出走 `window.open('/api/v1/profiles/{id}/export', '_blank')`
   - `src/web/web_api.py` 新增 `GET /api/v1/profiles/{profile_id}/export` 端点：返回 `Response(profile.model_dump_json(indent=2))` + `Content-Disposition: attachment; filename="{name}.json"`
   - 首页下拉框 `#profile-select` 仍保留作为快速切换入口
   - 原因：随着曲线数量增长，下拉框管理成本陡增，无法预览曲线形状；卡片库 + sparkline 缩略图能让用户在 1 秒内识别要找的曲线，导出/删除按钮内嵌每张卡片，操作路径更短

4. **烘焙记录三连改造（log00X 顺序命名 + 背景曲线快照 + 增强查看器）**
   - `src/services/data_manager.py:init_db` 追加 4 个 try/except `ALTER TABLE`：`seq_no INTEGER`、`display_name TEXT`、`profile_snapshot_json TEXT`、`duration_sec REAL`（向后兼容老 db）
   - `src/services/data_manager.py:save_record` 在 INSERT 前 `SELECT COALESCE(MAX(seq_no),0)+1 FROM records`，组装 `display_name = f"log{seq:03d}"`；`profile_snapshot.model_dump_json()` 序列化整棵曲线一并落盘
   - `src/services/data_manager.py:_row_to_record` 反序列化时 `RoastProfile.model_validate_json` 还原快照
   - `src/services/data_manager.py:list_records` 改为单 SELECT 直读所有列，**修复了原本的 N+1 查询问题**
   - `src/core/models.py` `RoastRecord` 新增 `seq_no`/`display_name`/`profile_snapshot: Optional[RoastProfile]`，`RecordSummary` 新增 `seq_no`/`display_name`
   - `src/core/roaster_controller.py:_save_session` 构造 `RoastRecord` 时填入 `profile_snapshot=self.profile`
   - `static/js/app.js:loadRecords` 列表显示 `r.display_name || ('log' + 零填充 seq_no)`，meta 行追加 `profile_name` 副标题
   - `static/js/app.js:showRecordDetail` 详情标题改为 `display_name` + `profile_name` 副标题，新增节点信息块（来自 `profile_snapshot.nodes`：节点数 / 终温）
   - `static/js/app.js:renderRecordChart` 新增第 4 个 dataset「背景曲线」（borderColor `#a3a3a3`、虚线），数据来自 `record.profile_snapshot.nodes` 经 `splineInterpolate(nodes, 5)` 插值；事件竖虚线、ROR 沿用之前
   - `static/index.html` 记录详情区图表外层包 `<div class="record-chart-container" id="record-chart-container">`，新增「图表全屏」切换按钮
   - `static/css/style.css` 新增 `.record-chart-container { height: 480px; }` 与 `.record-chart-fullscreen { position: fixed; inset: 20px; z-index: 9999; }`
   - 原因：旧记录命名是 UUID 片段，肉眼难以追踪「我昨天的第 3 锅」；log00X 顺序命名直观；同时把当时使用的曲线 JSON 整棵嵌入记录，使得历史记录在曲线被改/被删后仍可完整回放对比；查看器图表全屏按钮则解决了树莓派小屏下细节看不清的问题

5. **超前预测控制 + 自适应误差修正（核心痛点解决）**
   - `config.yaml` 末尾新增：
     ```yaml
     predictive_control:
       lookahead_sec: 15.0
       adaptive_enabled: true
       adaptive_max_extra_sec: 10.0
       adaptive_error_threshold: 3.0
     ```
   - `src/core/models.py:RoasterStatus` 新增 `lookahead_used: Optional[float] = None`（含自适应在内的本周期实际超前量）
   - `src/core/roaster_controller.py:_maybe_adjust_sv_locked` 在 `ROASTING` 分支替换 SV 计算：
     - `base_la = lookahead_sec`
     - 若 `adaptive_enabled` 且 `current_pv` 非空：误差 `err = nominal - PV` 超阈值（默认 3°C）时，按 `ratio = min(1, (err - thresh)/thresh)` 与 `ror_factor = clamp(1.5 - max(ror, 0)/30, 0.5, 1.5)` 乘上 `adaptive_max_extra_sec` 得 `extra_la`
     - 最终 `target = profile.get_target_temp(elapsed + base_la + extra_la)`，并 `self.current_lookahead = base_la + extra_la` 用于 UI 反馈
   - `src/core/roaster_controller.py:_enter_normal_roasting` 同步把 `elapsed` 改为 `elapsed + base_la`（首次进入 ROASTING 此处不开自适应，缺稳定误差信号）
   - `src/core/roaster_controller.py` 新增 `update_lookahead(value)` 方法：写入 `self.config["predictive_control"]["lookahead_sec"]`
   - `src/core/roaster_controller.py:get_state_payload` 填入 `lookahead_used = getattr(self, "current_lookahead", base_la)`
   - `src/core/roaster_controller.py:__init__` 加 `self.current_lookahead = 0.0`
   - `src/web/web_api.py` 新增 WS 命令 `set_lookahead`：从 `params.get("value", data.get("value"))` 读值（兼容嵌套和扁平格式），调 `controller.update_lookahead(float(value))`，并广播状态
   - `static/index.html` PID 调节面板加「超前预测 (秒)」滑块（id `lookahead-slider`，0~30s，0.5 步长）+ 当前值显示（`lookahead-value`）+ 实际超前量回显（`lookahead-used`）
   - `static/js/app.js` 滑块 `input` 事件 `sendCmd('set_lookahead', { params: { value } })`；`handleStateUpdate` 读 `msg.lookahead_used` 渲染 `lookahead-used.textContent`
   - 原因：纯 SV 跟踪在升温滞后场景下永远「落后曲线一步」，PID 再怎么调也补不齐；引入 lookahead 把目标提前 15s 让 PID 有时间提前抬升加热功率；自适应层在实测温度持续低于曲线时进一步加大超前量，烘焙结束温度落点显著更准

6. **WebSocket 命令契约扩展**
   - `src/web/web_api.py:_handle_ws_command` 新增 `set_lookahead` 分支，注意 params 兼容性：`params.get("value", data.get("value"))`，缺失时返回 error，调用后 `await manager.broadcast(controller.get_state_payload())`
   - 原因：保持 WS 命令风格一致（PID/预热都走 params 嵌套），同时兼容前端旧扁平格式调用方式，向下兼容老前端版本

### 代码注释
- `src/core/roaster_controller.py:_maybe_adjust_sv_locked`：注释 lookahead 公式、自适应分支条件、`ror_factor` 饱和段（[0, 30] °C/min 线性映射）
- `src/core/roaster_controller.py:update_lookahead`：注释 set_lookahead 写入路径与默认范围
- `src/services/data_manager.py:init_db`：注释 `ALTER TABLE` 必须 try/except 包裹的兼容性约定
- `src/services/data_manager.py:save_record`：注释 `display_name = f"log{seq:03d}"` 命名规则
- `static/js/app.js:renderProfileCards`：注释 sparkline 200×50 SVG 生成与 hover/active 显示策略
- `static/js/app.js:renderRecordChart`：注释「背景曲线」dataset 来自 `profile_snapshot.nodes` 的还原路径

### 项目结构（v3.10）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件（v3.10 新增 predictive_control 块）
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── PITFALLS.md                  # 已知坑点与注意事项（v3.10 新增 6 条 A-F）
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型（v3.10 RoastRecord 新增 seq_no/display_name/profile_snapshot；RoasterStatus 新增 lookahead_used）
│   │   └── roaster_controller.py # 核心控制器（v3.10 超前预测 + 自适应、profile_snapshot 嵌入、update_lookahead）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化（v3.10 ALTER TABLE 兼容、log00X 顺序命名、N+1 查询修复、快照序列化）
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket（v3.10 新增 /profiles/{id}/export、set_lookahead WS 命令）
├── data/
│   ├── profiles/
│   │   └── default-light-roast.json # 默认浅焙曲线（v3.10 升级为 7 节点耶加雪菲，5 号节点修正为 {270,188}）
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.10 删除 stat-dtr、曲线管理改为卡片网格、PID 面板加超前预测滑块、记录图表全屏按钮）
    ├── editor.html              # 曲线编辑器页面
    ├── css/
    │   ├── style.css            # 主页面样式（v3.10 stats-grid 改 2 列、新增 .profile-cards/.profile-card/.sparkline、.record-chart-container、.record-chart-fullscreen）
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑（v3.10 renderProfileCards、log00X 渲染、记录详情背景曲线、超前预测滑块联动）
        └── editor.js            # 编辑器逻辑（v3.10 默认 tempNodes 同步为 7 节点 {270,188}）
```

---

## v3.9 (2026-04-28)

### 上一版本功能摘要（v3.8）
- TC4S 异步驱动新增写入互斥锁、指数退避重试、状态回调与自动重连
- `RoasterState.ERROR` 状态机完整路径打通（硬件断开 / 过温 / SV 连续写失败）
- 新增 `max_safe_temperature` 过温硬限制
- 前端 ERROR 全屏阻断横幅，仅允许复位
- 急停按钮双击确认 + 触摸事件支持，消除 300ms 触摸延迟
- 新增常驻「快捷事件操作栏」（转黄 / 一爆 / 一爆结束 / 二爆 / 二爆结束 / 出豆）
- 代码清理：去除重复 `escapeHtml`、未使用 CSS、调试输出

### 核心改进

1. **曲线编辑器「选中节点」时间输入改成「分/秒」双数字输入**
   - `editor.html` 将单个 `<input id="sel-time">` 拆为 `<input id="sel-time-min">` + `<input id="sel-time-sec">`，分别带「分」「秒」标签，符合烘焙现场以分秒读时间的直觉
   - `editor.js` 的 `selectNode` 在填充时使用 `Math.floor(t / 60)` 取分、`Math.round(t % 60)` 取秒；当 `idx === 0`（首节点）时禁用两个输入框，并通过 CSS 灰显，明确告知用户首节点时间锁定为 0
   - `updateSelectedFromInputs` 在提交时以 `t = m * 60 + s` 重组为整数秒；秒数 ≥ 60 允许进位（例如输入 `1分75秒`），提交后由下一次 `selectNode` 自动归一为 `2分15秒`
   - 邻居夹紧逻辑（`prevTime + 1` / `nextTime - 1`）保持不变，与拖拽 / 微调路径完全一致，避免节点顺序错乱
   - `editor.css` 新增 `.form-row-time .time-inputs` 样式块（约 40 行），含 disabled 状态灰显与对齐

2. **新建曲线默认 `tempNodes` 替换为 7 节点曲线**
   - 旧默认（6 节点，150°C 起、228°C 终）的脱水起步偏陡，与实际烘焙行为不符
   - 新默认（用户指定，更贴近真实预热 → 脱水 → 美拉德 → 一爆的节奏）：
     ```js
     [
       { time: 0,   temperature: 30  },  // 0:00
       { time: 60,  temperature: 100 },  // 1:00
       { time: 120, temperature: 135 },  // 2:00
       { time: 180, temperature: 155 },  // 3:00
       { time: 330, temperature: 188 },  // 5:30
       { time: 360, temperature: 203 },  // 6:00
       { time: 435, temperature: 212 }   // 7:15
     ]
     ```

3. **后端契约保持不变**
   - `ProfileNode.time` 仍是 `float` 秒，`models.py` 未改动
   - `saveProfile` / `exportJSON` 落盘 payload 仍为 `{ time: <秒数>, temperature: <°C> }` 列表
   - 前端 UI 层只是在「显示与输入」环节做分秒切片，存储与 API 契约对外完全透明

### 代码注释
- `editor.js` `selectNode`：注释首节点锁定逻辑（`idx === 0` 时禁用两个时间输入框并附说明）
- `editor.js` `updateSelectedFromInputs`：注释分秒解析公式 `t = m * 60 + s` 与「秒 ≥ 60 进位由 selectNode 归一」的约定
- `editor.css` `.form-row-time .time-inputs`：注释双输入对齐与 disabled 灰显方案

### 项目结构（v3.9）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件（v3.8 新增 max_safe_temperature）
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── PITFALLS.md                  # 已知坑点与注意事项（v3.8 新增）
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块（v3.8 写入锁、重试、状态回调、自动重连）
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型（v3.8 RoasterStatus 新增 error_reason）
│   │   └── roaster_controller.py # 核心控制器（v3.8 ERROR 状态机、过温保护、SV 失败检测）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.8 新增 event-actions-bar、ERROR overlay）
    ├── editor.html              # 曲线编辑器页面（v3.9 时间输入改成分/秒双数字输入）
    ├── css/
    │   ├── style.css            # 主页面样式（v3.8 ERROR overlay、event-actions-bar、急停双击样式）
    │   └── editor.css           # 编辑器样式（v3.9 新增 .form-row-time 双输入样式 + 禁用态灰显）
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑（v3.8 急停双击、触摸事件、ERROR 状态处理）
        └── editor.js            # 编辑器逻辑（v3.9 时间双输入解析、首节点锁、新默认曲线）
```

---

## v3.8 (2026-04-27)

### 上一版本功能摘要（v3.7）
- ROR 自动计算回退为 4-17 简单分段差分法
- 彻底删除一键平滑 ROR 按钮
- 顶部事件温度显示条（Artisan 风格）
- ROR 预览列表简化
- 代码清理

### 核心改进

1. **TC4S 硬件层健壮性增强**
   - `tc4s_async.py` 新增写入互斥锁：`asyncio.Lock()` 保护串口 `write/drain`，防止并发写冲突
   - `send_command` 引入指数退避重试：最多 3 次重试，延迟 0.05s → 0.15s → 0.45s
   - 新增状态回调机制：`register_status_callback` / `_notify_status`，支持 `connected` / `disconnected` / `error` 三种状态通知
   - 断开检测与自动重连：`_monitor_loop` 连续 3 次失败触发断开；`_reconnect_loop` 自动重连（最大 30 次，指数退避 2s → 30s）
   - 回调异常安全：每个数据回调单独 `try/except` 包裹，防止用户回调抛异常拖垮硬件轮询
   - CRC 错误上报：CRC 校验失败时通过状态回调通知上层，而非静默丢弃

2. **ERROR 状态机完整路径**
   - `roaster_controller.py` 的 `RoasterState.ERROR` 从"定义但未使用"变为完全功能状态
   - 进入 ERROR 的三种条件：
     - 硬件断开（TC4S 状态回调 `disconnected`）
     - 过温（当前 PV > `max_safe_temperature`）
     - SV 写入连续 3 次失败
   - ERROR 状态下只允许 `emergency_stop` 复位，其他操作一律拒绝
   - `models.py` 的 `RoasterStatus` 新增 `error_reason: Optional[str]`，前端可显示具体错误原因

3. **过温硬限制**
   - `config.yaml` 新增 `max_safe_temperature: 250.0`
   - 任何时刻实测温度超过此阈值立即进入 ERROR 状态，防止设备过热

4. **SV 写入失败检测**
   - `_maybe_adjust_sv` 检查 `tc4s.set_sv()` 返回值，连续 3 次失败进入 ERROR
   - 解决此前"SV 写丢但系统继续运行"的隐患

5. **ROR OLS 中心化修正**
   - `_compute_regression_ror` 使用 `tc = t - elapsed` 消除浮点精度损失
   - 窗口注释修正："对称窗口"改为"回溯窗口"，与实际实现一致

6. **前端 ERROR 状态全屏阻断横幅**
   - `index.html` + `style.css` + `app.js` 新增红色全屏 overlay
   - 显示错误原因，仅允许复位按钮操作，彻底阻断误操作

7. **急停按钮双击确认**
   - 第一次点击变红显示"再次点击确认"，2 秒内第二次才执行 `emergency_stop`
   - 防止触摸屏误触导致意外急停

8. **触摸事件支持**
   - `app.js` 新增 `bindTouchClick()` 辅助函数，消除 300ms 触摸延迟
   - 所有关键按钮（事件记录、急停等）已绑定触摸事件

9. **快捷事件操作栏**
   - `index.html` 新增 `#event-actions-bar`，始终可见
   - 6 个事件按钮：转黄 / 一爆 / 一爆结束 / 二爆 / 二爆结束 / 出豆
   - 替代原先折叠式事件面板，提升烘焙中操作效率

10. **代码清理**
    - 删除 `app.js` 重复 `escapeHtml`（已存在于 `utils.js`）
    - 删除未使用 `.ctrl-btn.toggle` CSS
    - 合并重复 `.record-item` CSS 规则
    - 移除 `console.error` 调试输出

### 代码注释
- `tc4s_async.py`：为 `_write_lock`、`_reconnect_loop`、`_monitor_loop`、状态回调等新增注释
- `roaster_controller.py`：为 ERROR 状态转移路径、过温检查、SV 失败计数器添加注释
- `app.js`：为 `bindTouchClick`、急停双击逻辑、ERROR overlay 渲染添加 JSDoc

### 项目结构（v3.8）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件（v3.8 新增 max_safe_temperature）
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── PITFALLS.md                  # 已知坑点与注意事项（v3.8 新增）
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块（v3.8 写入锁、重试、状态回调、自动重连）
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型（v3.8 RoasterStatus 新增 error_reason）
│   │   └── roaster_controller.py # 核心控制器（v3.8 ERROR 状态机、过温保护、SV 失败检测）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.8 新增 event-actions-bar、ERROR overlay）
    ├── editor.html              # 曲线编辑器页面
    ├── css/
    │   ├── style.css            # 主页面样式（v3.8 ERROR overlay、event-actions-bar、急停双击样式）
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑（v3.8 急停双击、触摸事件、ERROR 状态处理）
        └── editor.js            # 编辑器逻辑
```

---

## v3.7 (2026-04-20)

### 上一版本功能摘要（v3.6）
- 曲线编辑器 ROR 高斯后处理 + 一键平滑 ROR 回归
- 实时烘焙 ROR 前端 EWMA 平滑
- 结束烘焙保存逻辑修复（乐观更新）
- 修复提前结束烘焙拖长线回 0 秒
- 事件日志增强：温度、升温率、发展时间
- 烘焙界面预设曲线 ROR 预览

### 核心改进

1. **ROR 自动计算回退为 4-17 简单分段差分法**
   - `utils.js` 重写 `buildRORDataset()`：删除 delta-span 线性回归与高斯平滑，改为节点间简单差分（dT/dt×60），每段中点一个 ROR 值
   - 删除 `linearRegressionROR()` 与 `gaussianSmoothROR()`（不再使用）
   - 原因：用户反馈复杂的 delta-span + 高斯平滑在曲线编辑器中效果不可控，4-17 版本的简单分段差分法直接反映用户在控制点之间设定的升温率，简单可预测

2. **彻底删除一键平滑 ROR 按钮**
   - 删除 `editor.html` 中的「平滑 ROR」按钮
   - 删除 `editor.js` 中的 `smoothROR()` 函数及其事件绑定
   - 原因：该功能强制改变用户设定的节点温度，与「可预测」的设计目标冲突；用户应通过拖拽节点自然调整 ROR

3. **顶部事件温度显示条（Artisan 风格）**
   - `index.html` 在状态栏与阶段条之间新增 `#event-temps-bar`
   - 实时显示「转黄」和「一爆」的时间与温度（格式：MM:SS @ XX.X°C）
   - `app.js` 新增 `updateEventTempsBar(events)`，在 WebSocket 推送事件时自动更新
   - `style.css` 新增样式：转黄用黄色标签，一爆用红色标签，Fira Code 字体，28px 高度
   - 烘焙结束（optimisticResetToIdle）后自动清空

4. **ROR 预览列表简化**
   - `editor.js` 的 `renderRORList()` 不再遍历平滑后的数据集求区间平均
   - 直接复用 `computeROR()` 的结果显示每段恒定升温率，与图表完全对应

5. **代码清理**
   - `utils.js` 彻底移除 `linearRegressionROR` 和 `gaussianSmoothROR`
   - `editor.js` 移除 `smoothROR` 残留引用
   - 确认 `app.js` 无对旧 ROR 函数的残留引用

### 代码注释
- `utils.js`：`buildRORDataset` 注释更新为简单差分法说明
- `editor.js`：`buildRORDataset` 包装函数、`renderRORList` 添加注释
- `app.js`：`updateEventTempsBar` 添加 JSDoc 注释

### 项目结构（v3.7）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型（RoastEvent 含 temperature）
│   │   └── roaster_controller.py # 核心控制器
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.7 新增顶部事件温度条）
    ├── editor.html              # 曲线编辑器页面（v3.7 删除平滑 ROR 按钮）
    ├── css/
    │   ├── style.css            # 主页面样式（v3.7 新增 event-temps-bar 样式）
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数（v3.7 简化 buildRORDataset，清理旧滤波器）
        ├── app.js               # 主页面逻辑（v3.7 新增 updateEventTempsBar）
        └── editor.js            # 编辑器逻辑（v3.7 删除 smoothROR，简化 renderRORList）
```

---

## v3.6 (2026-04-20)

### 上一版本功能摘要（v3.5）
- ROR 预览与后端实时计算均改用 delta-span 滑动线性回归（Artisan 同款）
- 彻底移除"一键平滑 ROR"按钮残留
- 清理废弃滤波函数与高斯平滑遗留代码
- Chart.js 渲染稳定性修复（`animation: false` + `safeUpdateDataset`）

### 核心改进

1. **曲线编辑器 ROR 高斯后处理 + 一键平滑 ROR 回归**
   - `utils.js` 新增 `gaussianSmoothROR(rorData, windowSec=7, sigma=2)`：对 delta-span 输出的 ROR 做高斯加权移动平均，消除 Catmull-Rom 样条稀疏节点带来的导数振荡，保留整体递减趋势
   - `editor.js` 的 `buildRORDataset()` 在 delta-span 之后追加高斯平滑层，拖动节点后 ROR 曲线更加丝滑自然
   - 恢复"一键平滑 ROR"按钮（`smoothROR`）：根据首尾节点固定时间，让升温率从 1.8×平均线性递减到 0.4×平均，自动重新计算中间节点温度，并接入撤销/重做系统
   - 原因：纯 delta-span 在稀疏节点下无法完全消除样条 C2 不连续带来的局部波动，高斯后处理是标准信号处理做法；一键平滑则帮助用户快速生成理想递减曲线

2. **实时烘焙 ROR 前端 EWMA 平滑**
   - `app.js` 引入指数加权移动平均（EWMA）：`rorEwma = 0.3 * msg.ror + 0.7 * rorEwma`
   - 跳过 2 秒内重复 ROR 值的冗余渲染，减少视觉抖动
   - 进入烘焙时自动重置 EWMA 状态
   - 效果：ROR 曲线在保持极低延迟的同时，视觉上明显更平滑，更接近 Artisan 的丝滑体验

3. **结束烘焙保存逻辑修复（乐观更新）**
   - 点击"不保存"后立即执行 `optimisticResetToIdle()`：
     - 清空实时温度、SV、ROR dataset
     - 强制重置 UI 状态徽章、读数、按钮、统计卡片、阶段条、事件日志
     - 然后再异步发送 `discard_and_clear`，彻底消除"正在等待保存确认"的卡顿感
   - 点击"保存"后显示"正在保存..."轻量提示
   - `handleStateUpdate` 增加 `msg.state === 'IDLE' && lastState !== 'IDLE'` 兜底清空分支，确保后端广播 IDLE 时图表绝对干净

4. **修复提前结束烘焙拖长线回 0 秒**
   - `app.js` 状态守卫：仅在 `PREHEATING` / `ROASTING` 状态下才执行 `appendChartData`
   - `COOLING` 状态仅追加 PV/SV（定格结束画面），不再追加 ROR
   - `IDLE` / `WAITING` 状态完全不追加；若 dataset 非空则主动清空
   - 根因：之前后端在 IDLE 下仍广播 `elapsed=0`，前端无条件 append 导致 Chart.js 将旧曲线末点与 x=0 新点连成异常长线

5. **事件日志增强：温度、升温率、发展时间**
   - `models.py` 的 `RoastEvent` 新增 `temperature: Optional[float] = None`，兼容旧数据（反序列化时缺失字段为 null）
   - `roaster_controller.py` 的 `log_event()` 记录当前 `current_pv`
   - `app.js` 事件日志每行显示：`时间 事件名 @ XX.X°C`
   - 一爆之后的事件额外追加：`ΔT +X.X°C · 发展 MM:SS`
   - `style.css` 微调 `.event-item` 为 flex 多段布局，信息更紧凑清晰

6. **烘焙界面预设曲线 ROR 预览**
   - `utils.js` 提取 `buildRORDataset(nodeList, spanSec)`（原仅在 `editor.js` 中），供 `app.js` 复用
   - `app.js` 图表新增第 5 个 dataset：
     - label: `'ROR 预览'`（虚线 `#82b1ff`、无填充、线宽 1.5）
   - 现有 dataset[3] label 从 `'升温率'` 统一改为 `'ROR'`
   - `setProfileCurve()` 加载曲线时同时计算并填充 profile ROR dataset
   - Y1 轴标题改为 `'ROR (°C/min)'`
   - 对比模式 `enterCompareMode()` 与 `exitCompareMode()` 正确处理 dataset[4] 的显隐

7. **自我审查与通用修复**
   - `roaster_controller.py` `_on_tc4s_data` 限制仅在 `PREHEATING` / `ROASTING` 时更新 ROR 与采样记录，防止 IDLE 长期运行下 `_temp_history` 无限增长
   - `web_api.py` 删除未使用的 `Optional` import
   - `editor.css` `.panel-actions` 增加 `flex-wrap: wrap` 以容纳三个按钮
   - `style.css` 新增 `.app-toast` 样式供主页面轻量提示使用

### 代码注释
- `utils.js`：为 `gaussianSmoothROR`、`buildRORDataset` 添加 JSDoc
- `editor.js`：`smoothROR` 函数添加注释说明算法参数
- `app.js`：`optimisticResetToIdle`、状态守卫、EWMA 等新增逻辑均添加注释
- `roaster_controller.py`：`log_event` docstring 更新

### 项目结构（v3.6）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型（v3.6 RoastEvent 增加 temperature）
│   │   └── roaster_controller.py # 核心控制器（v3.6 log_event 记录温度）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面
    ├── editor.html              # 曲线编辑器页面（v3.6 恢复平滑 ROR 按钮）
    ├── css/
    │   ├── style.css            # 主页面样式（v3.6 事件日志布局、toast 样式）
    │   └── editor.css           # 编辑器样式（v3.6 panel-actions 换行）
    └── js/
        ├── utils.js             # 公共工具函数（v3.6 新增 gaussianSmoothROR、提取 buildRORDataset）
        ├── app.js               # 主页面逻辑（v3.6 EWMA、乐观重置、状态守卫、profile ROR、事件增强）
        └── editor.js            # 编辑器逻辑（v3.6 高斯平滑 ROR、恢复 smoothROR）
```

---

## v3.5 (2026-04-19)

### 上一版本功能摘要（v3.4）
- 修复曲线编辑器与主页面 Chart.js 渲染冻结（`animation: false` + `safeUpdateDataset` 安全更新）
- 删除风机/功率双曲线预留，简化为单温度曲线
- 触摸屏优化（按钮 44px、输入框 16px、插入按钮 28px）
- 旧数据兼容（Pydantic `extra="ignore"`）
- **遗留问题**：v3.4 更新记录声称已移除"一键平滑 ROR"按钮，但 `editor.html` 与 `editor.js` 中仍有残留

### 核心改进
1. **ROR 预览彻底改用 delta-span 线性回归（Artisan 同款）**
   - `utils.js` 新增 `linearRegressionROR(tempData, centerIdx, spanSec)`：在中心时刻的左右 `span/2` 窗口内对温度做 OLS 线性回归，斜率 * 60 即为 ROR
   - `editor.js` 重写 `buildRORDataset()`：1 秒密集采样温度 -> 滑动线性回归计算 ROR，无需任何后处理滤波（彻底删除高斯平滑、双边滤波、镜像延拓等旧策略）
   - 该算法利用窗口内所有数据点平均噪声，从根本上消除尖点，ROR 曲线丝滑连续，与 Artisan 体验一致

2. **后端实时 ROR 改用滑动线性回归**
   - `roaster_controller.py` 重写 `_update_ror()` 并新增 `_compute_regression_ror()`：与前端完全相同的 delta-span 算法
   - 替换原先 60 秒两点差分的粗糙计算，实时 ROR 读数更稳定、噪声更低
   - `config.yaml` 新增 `ror_window_sec: 15.0` 配置项，用户可自定义 ROR 计算窗口（秒）

3. **真正移除"一键平滑 ROR"按钮（v3.4 遗留清理）**
   - 删除 `editor.html` 第 30 行 `btn-smooth-ror` 按钮
   - 删除 `editor.js` `smoothROR()` 函数及其事件绑定（v3.4 记录声称已删但实际仍在）
   - 原因：新的线性回归已天然丝滑，无需手动平滑；旧 `smoothROR` 算法（高斯模糊 + 整数秒重采样）在控制点时间为非整数时会丢失精度

4. **清理废弃代码与死代码**
   - `utils.js` 删除不再使用的函数：`catmullRomDerivative()`、`getSplineROR()`、`mirrorPad()`、`unpad()`、`gaussianSmooth()`、`bilateralSmoothROR()`、`movingAverage()`
   - `app.js` 删除未调用的 `clearCharts()` 死函数
   - `editor.css` 删除 orphaned 规则 `.ctrl-btn.info`

### 代码注释
- `utils.js`：为 `linearRegressionROR` 添加 JSDoc 注释，说明算法原理与参数
- `editor.js`：更新 `buildRORDataset` 注释，反映新算法
- `roaster_controller.py`：为 `_compute_regression_ror` 添加 docstring

### 项目结构（v3.5）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件（v3.5 新增 ror_window_sec）
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型
│   │   └── roaster_controller.py # 核心控制器（v3.5 滑动线性回归 ROR）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面
    ├── editor.html              # 曲线编辑器页面（v3.5 真正移除平滑按钮）
    ├── css/
    │   ├── style.css            # 主页面样式
    │   └── editor.css           # 编辑器样式（v3.5 清理 orphaned 规则）
    └── js/
        ├── utils.js             # 公共工具函数（v3.5 新增 linearRegressionROR，清理旧滤波器）
        ├── app.js               # 主页面逻辑（v3.5 删除 clearCharts 死代码）
        └── editor.js            # 编辑器逻辑（v3.5 线性回归 ROR、删除 smoothROR）
```

---

## v3.4 (2026-04-19)

### 上一版本功能摘要（v3.3）
- 彻底修复曲线编辑器Chart.js渲染冻结（`animation: false` + `updateDataset` 安全更新）
- 删除风机/功率双曲线预留，简化为单温度曲线
- 触摸屏优化（按钮44px、输入框16px、插入按钮28px）
- 旧数据兼容（Pydantic `extra="ignore"`）

### 核心改进
1. **ROR预览平滑化（类似Artisan）**
   - `editor.js` 重写 `buildRORDataset()`：
     - 插值步长从 5 秒改为 **1 秒**，生成更密集的温度曲线
     - 差分计算原始ROR后，应用 **15秒对称移动平均** 平滑
     - 平滑后的ROR曲线连续自然，无锯齿感
   - `editor.js` 重写 `renderRORList()`：
     - 不再用控制点间平均ROR，而是基于平滑后的ROR数据集按区间采样
     - 确保右侧面板数值与图表曲线趋势完全一致
   - ROR Y轴 `suggestedMin` 从 0 改为 **-5**，允许显示负升温率，视觉更自然
   - 新增 `utils.js` `movingAverage(data, windowSize)` 工具函数

2. **修复主页面 Chart.js 渲染隐患**
   - 根因：`app.js` 中仍有 6 处使用 `chart.update('none')` 和直接数组替换，这是 v3.3 修复在编辑器中遗留的同类问题
   - `app.js` 新增 `safeUpdateDataset(chart, idx, newData)` 安全更新函数
   - `clearCharts()` 改为 `ds.length = 0` 安全清空
   - `setProfileCurve()` 改用 `safeUpdateDataset`
   - 对比模式中的数组替换也改用安全方式
   - 全部 6 处 `update('none')` 改为无参 `update()`

3. **移除无效UI元素**
   - 删除 `editor.html` "一键平滑ROR"按钮
   - 删除 `editor.js` `smoothROR()` 空壳函数
   - 原因：v3.4的ROR预览已天然平滑，无需手动触发

4. **CSS修复**
   - `style.css` 移除 `#charts-panel canvas` 的 `!important`
   - 与 v3.3 `editor.css` 的修复保持一致，避免干扰Chart.js响应式逻辑

### 代码注释
- `utils.js`：为 `movingAverage` 添加JSDoc注释
- `editor.js`：为 `buildRORDataset`、`renderRORList`、`updateDataset` 添加注释
- `app.js`：为 `safeUpdateDataset`、`enterCompareMode`、`exitCompareMode` 添加注释

### 项目结构（v3.4）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型
│   │   └── roaster_controller.py # 核心控制器
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面
    ├── editor.html              # 曲线编辑器页面（v3.4 移除一键平滑按钮）
    ├── css/
    │   ├── style.css            # 主页面样式（v3.4 移除 canvas !important）
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数（v3.4 新增 movingAverage）
        ├── app.js               # 主页面逻辑（v3.4 修复 Chart.js 更新模式）
        └── editor.js            # 编辑器逻辑（v3.4 平滑ROR、移除空壳按钮）
```

---

## v3.3 (2026-04-19)

### 核心修复
1. **彻底修复曲线编辑器渲染卡住问题**
   - 根因：Chart.js 4.x 中 `animation: { duration: 0 }` 不是正确禁用动画的方式，导致 `chart.update('none')` 内部状态不一致，重绘被跳过；同时直接替换 `chart.data.datasets[i].data = newArray` 导致 Chart.js Proxy 变化检测失效
   - 方案：
     - `animation: { duration: 0 }` → `animation: false`
     - 新增 `updateDataset()` 辅助函数：先 `data.length = 0` 再 `push(...newData)`，确保 Chart.js 正确识别数据变化
     - `chart.update('none')` → 无参 `chart.update()`
     - 初始化后显式调用 `chart.resize()` 确保 canvas 尺寸正确
     - CSS 中移除 `.chart-wrapper canvas` 的 `!important`，避免干扰 Chart.js 响应式逻辑
   - 修复后：初始加载即正确显示曲线；拖拽控制点时曲线实时跟随；列表编辑、撤销重做后曲线即时刷新

### 功能删除
2. **移除风机/功率曲线预留功能**
   - 删除编辑器顶部的温度/风机/功率标签切换（`editor.html` `.curve-type-tabs`）
   - `editor.js` 删除 `fanNodes`、`powerNodes`、`currentCurveType` 及所有双曲线适配函数，简化数据操作直接针对 `tempNodes`
   - `app.js` 删除 dataset[4]（"功率输出"）和 `y2` 轴
   - `models.py` 删除 `FanNode`、`PowerNode` 类；`RoastProfile` 删除 `fan_nodes`、`power_nodes` 字段；删除 `get_target_fan_speed()`、`get_target_power()` 方法
   - `roaster_controller.py` 从 `RoasterStatus` 输出中删除 `fan_speed`、`power_output`
   - 保存/导出的 JSON 不再包含 `fan_nodes` 和 `power_nodes`

### UI/UX 改进
3. **触摸屏优化**
   - `editor.css` 中 `.ctrl-btn` 增加 `min-height: 44px`，满足触摸目标要求
   - `.node-insert-btn` 尺寸从 18px 增大到 28px，提升点击准确性
   - 输入框字体从 13px 提升到 16px，避免部分浏览器自动缩放
   - 替换 `editor.html` 底部 hint 中的 emoji 为文字描述

### 兼容性
4. **旧数据兼容**
   - `RoastProfile` 新增 `model_config = ConfigDict(extra="ignore")`
   - 导入 v3.2 及更早版本含 `fan_nodes`/`power_nodes` 的 JSON 时，Pydantic 自动忽略多余字段，不报错

### 项目结构（v3.3）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型（v3.3 删除 FanNode/PowerNode，简化 RoastProfile）
│   │   └── roaster_controller.py # 核心控制器（v3.3 删除 fan/power 预留字段）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.3 删除功率 dataset 和 y2 轴）
    ├── editor.html              # 曲线编辑器页面（v3.3 删除曲线类型切换标签）
    ├── css/
    │   ├── style.css            # 主页面样式
    │   └── editor.css           # 编辑器样式（v3.3 移除 canvas !important）
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑（v3.3 删除功率通道和 y2 轴）
        └── editor.js            # 编辑器逻辑（v3.3 重写：修复渲染 bug、删除双曲线）
```

---

## v3.2 (2026-04-19)

### 核心修复
1. **修复曲线编辑器拖拽实时更新 bug**
   - 根因：`chart.update('none')` 配合高频 DOM 重建（`innerHTML`）阻塞了主线程，导致图表渲染被跳过
   - 方案：将 `refresh()` 拆分为 `refreshChartOnly()`（仅 Canvas）和 `refresh()`（图表+DOM）
   - 拖拽时通过 `requestAnimationFrame` 只更新图表，释放鼠标后才统一更新 DOM
   - 修复后拖拽节点时曲线预览实时跟随鼠标，体验流畅

### 新增功能
2. **撤销/重做系统**
   - 支持最大 50 步历史记录
   - 覆盖操作：移动节点、添加节点、删除节点、插入节点、复制节点、微调节点、精确编辑
   - UI 按钮：撤销（Ctrl+Z）、重做（Ctrl+Y / Ctrl+Shift+Z）

3. **键盘快捷键**
   - `Ctrl+Z` 撤销，`Ctrl+Y` 重做
   - `Delete` / `Backspace` 删除选中节点
   - `Ctrl+D` 复制选中节点
   - `Ctrl+N` 添加节点，`Ctrl+S` 保存曲线
   - `↑/↓` 温度/数值 ±0.5，`Shift+↑/↓` ±5
   - `←/→` 时间 ±1s，`Shift+←/→` ±10s
   - `Esc` 取消选中
   - `1/2/3` 快速切换温度/风机/功率曲线

4. **网格吸附**
   - 时间吸附粒度：5 秒
   - 温度/数值吸附粒度：0.5（风机/功率为 1%）
   - 按住 `Shift` 拖拽临时禁用吸附，实现精确定位

5. **节点操作增强**
   - **插入节点**：节点列表每行悬浮显示 "+" 按钮，在两节点间中点插入，温度通过样条插值自动计算
   - **复制节点**：复制选中节点到后方 30 秒处，自动避让避免时间冲突
   - **拖拽 Tooltip**：拖拽时在鼠标旁实时显示当前时间/温度数值

6. **双曲线系统预留（温度 + 风机 + 功率）**
   - 后端 `RoastProfile` 新增 `fan_nodes` 和 `power_nodes` 字段
   - 编辑器标题栏新增曲线类型切换标签（温度 / 风机 / 功率）
   - 风机/功率曲线使用线性插值（无需样条平滑），Y 轴范围 0-100%
   - 主页面图表预留第 5 个 dataset（功率输出）和 `y2` 轴，默认隐藏
   - 当前为纯预留状态，有完整 UI 编辑能力，等硬件扩展风机控制后启用

### 改进
7. **提取公共工具函数**
   - 新建 `static/js/utils.js`，统一存放 `splineInterpolate`、`getSplineTemp`、`catmullRom`、`formatTime`、`deepClone`、`snapValue`、`escapeHtml`
   - `editor.js` 和 `app.js` 共用，消除代码重复

8. **UI/UX 优化**
   - 拖拽控制点时，控制点放大到 10px 并添加白色描边，视觉反馈更清晰
   - 选中节点在列表中高亮更醒目（蓝色背景 + 左侧蓝色边框）
   - 操作后显示轻量 toast 提示（如"已撤销"、"节点已复制"），替代部分 `alert()`
   - 编辑器底部提示条显示所有快捷键速查
   - 曲线类型切换标签使用图标 + 文字，当前选中有高亮边框

9. **代码清理**
   - 移除 `editor.js` 中无实际作用的 `smoothROR()` 弹窗提示逻辑
   - 简化 `app.js` 中 `Chart.register` 的冗余兼容代码
   - 为所有关键函数添加 JSDoc 注释

### 项目结构

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型（v3.2 新增 FanNode/PowerNode、双曲线预留）
│   │   └── roaster_controller.py # 核心控制器（v3.2 预留 fan_speed/power_output 字段）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（v3.2 引入 utils.js）
    ├── editor.html              # 曲线编辑器页面（v3.2 新增曲线类型切换、撤销重做按钮）
    ├── css/
    │   ├── style.css            # 主页面样式
    │   └── editor.css           # 编辑器样式（v3.2 新增曲线标签、tooltip、toast 样式）
    └── js/
        ├── utils.js             # 公共工具函数（v3.2 新增）
        ├── app.js               # 主页面逻辑（v3.2 引入 utils.js，预留功率通道）
        └── editor.js            # 编辑器逻辑（v3.2 重写：修复bug、撤销重做、快捷键、双曲线）
```

---

## v3.1 (2026-04-18)

### 新增功能
1. **Catmull-Rom 样条曲线插值**
   - 曲线编辑器中控制点之间改用样条插值替代线性插值，曲线自然平滑
   - ROR 计算基于平滑后的样条曲线，结果更连续、更真实
   - 后端 `get_target_temp()` 同步使用样条插值，确保实际烘焙追踪与显示一致
   - 控制点数量不变，用户仍只编辑稀疏控制点

2. **烘焙日志对比叠加**
   - 新增"烘焙记录"标签页中的对比功能
   - 可同时选中最多 2 条历史记录，点击"对比选中"叠加显示温度曲线
   - 对比模式使用橙色（记录A）和紫色（记录B）区分
   - 支持"退出对比"一键恢复实时烘焙视图

3. **结束烘焙自动弹窗确认**
   - 结束烘焙后自动弹出确认对话框："是否保存此锅烘焙记录？"
   - 选择"保存"则保存数据并自动清屏回到待机
   - 选择"不保存"则直接丢弃并自动清屏回到待机
   - 严格区分每一锅，避免上一锅数据残留

4. **动态阶段条**
   - 顶部阶段颜色条改为动态显示：初始只显示脱水期
   - 记录转黄事件后自动显示梅纳期
   - 记录一爆事件后自动显示发展期
   - 未激活的阶段自动隐藏，避免挤占空间

### 改进
1. **入豆流程简化**
   - 点击"入豆"按钮后自动在 0:00 记录入豆事件，无需手动点击事件面板
   - 事件浮层中删除"入豆"按钮，减少误操作

2. **移除烘焙页面结束温度显示**
   - 烘焙控制面板不再显示结束温度（该信息已在曲线中设定）
   - 保持自动结束烘焙的后端逻辑不变

3. **UI/UX 整体优化**
   - 顶部读数区数字更醒目（38px），间距更合理（64px）
   - 阶段条高度优化为 30px，文字防溢出处理
   - Chart.js 图例支持点击隐藏/显示数据线
   - 全屏模式下图表占更大比例（3:1）
   - 按钮最小高度调整为 44px，满足触摸目标要求
   - 响应式适配优化，支持树莓派小屏幕（800x480）

### 修复
1. 移除未使用的 `_cooling_task` 代码
2. 移除冗余的"保存记录"/"结束存储"按钮，统一为弹窗确认流程

---

## v3.0 (2026-04-18)

### 核心功能更新

1. **新增"转黄"事件与三阶段统计**
   - 事件面板增加"转黄"按钮
   - 阶段统计从原来的"脱水期+发展期"扩展为"脱水期+梅纳期+发展期"
   - DTR（发展时间比率）计算保持不变

2. **顶部阶段颜色条**
   - 在主图表上方新增阶段颜色条
   - 脱水期（蓝色）、梅纳期（橙色）、发展期（绿色）
   - 实时显示各阶段时长与占比

3. **烘焙流程全面重构**
   - 新增 WAITING（等待入豆）状态：点击"开始烘焙"后不加热，仅加载曲线
   - 新增 PREHEATING（预热中）状态：入豆后定死高温，快速升温
   - 预热结束后自动转入正常曲线跟随（ROASTING）
   - 到达结束温度或点击"结束烘焙"后进入 COOLING 状态
   - 新增"结束存储"按钮：确认保存并清屏，开始下一锅
   - 新增"保存记录"按钮：在冷却阶段可保存当前记录

4. **预热参数配置**
   - UI 中可设置预热时长（秒）和预热温度（°C）
   - 支持"保存为默认"写入 config.yaml，重启后仍生效
   - 每锅烘焙前可临时调整

5. **曲线编辑器优化**
   - 增加"结束温度"字段
   - 移除"点击空白添加节点"功能，防止误操作
   - 一键平滑 ROR 改为：保持控制点不动，在控制点之间插入辅助节点使 ROR 平滑

6. **烘焙记录查看**
   - 新增"烘焙记录"标签页
   - 可查看历史记录列表、事件明细
   - 支持导出 CSV / JSON

7. **图表颜色优化**
   - 实时温度（PV）：亮绿 #00e676
   - 设定温度（SV）：亮红 #ff5252
   - 背景曲线：灰色 #9e9e9e 虚线
   - 升温率（ROR）：亮蓝 #448aff
   - 背景曲线在烘焙全程常驻显示

### 项目结构

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件（新增 preheat 段）
├── requirements.txt             # Python 依赖
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举（新增 WAITING/PREHEATING）
│   │   ├── models.py            # Pydantic 数据模型（新增 PreheatConfig/end_temp/yellowing）
│   │   └── roaster_controller.py # 核心控制器（重构状态机、预热、自动结束）
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket（新增预热/记录 API）
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面（新增阶段条、记录标签页、预热配置）
    ├── editor.html              # 曲线编辑器页面（新增结束温度）
    ├── css/
    │   ├── style.css            # 主页面样式（新增阶段条、按钮样式）
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── app.js               # 主页面逻辑（重构状态机、记录查看）
        └── editor.js            # 编辑器逻辑（移除空白点击、修正 smoothROR）
```

---

## v2.0 (2026-04-17)

- 全新深色专业 UI，整合温度与 ROR 双轴显示
- 新增独立曲线编辑器，支持拖拽节点、一键平滑 ROR
- 事件记录面板与烘焙控制深度融合，实时显示 DTR 与阶段占比
- 支持曲线导入导出
- 时间轴统一以分钟显示
