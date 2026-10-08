# 前端与 Tauri 参考

在修改 `roaster/static/`、Chart.js、曲线编辑器、Tauri 适配层或视觉交互时读取。这里是风险提示，不是固定步骤或角色提示词；先以当前代码和 `roaster/PITFALLS.md` 为准。

## 当前结构

- `roaster/static/index.html` 与 `editor.html` 是共享页面。
- `roaster/static/css/theme.css` 是语义颜色、间距、圆角、阴影和动效的来源；页面样式位于同目录其他 CSS。
- `roaster/static/js/app.js`、`editor.js`、`utils.js`、`theme.js` 和 `tauri-adapter.js` 分别承载主页面、编辑器、公共逻辑、主题和桌面适配。
- `desktop/src-tauri/tauri.conf.json` 的 `frontendDist` 指向 `roaster/static/`；不要维护第二份桌面前端。
- `desktop/tools/roaster-simulator.mjs` 与 `dev-sim.mjs` 提供不导入 Python 硬件模块、不访问串口的本机 HTTP/WebSocket 模拟环境。

路径和职责可能演进；修改前搜索真实入口、DOM 引用、事件绑定和资源加载顺序。

## 交互与视觉不变量

- 保留稳定 DOM ID、REST/WS 命令、状态字段和事件语义。视觉重排优先改变布局容器与 ARIA 状态，不随意重命名业务挂点。
- WebSocket `{ok}` / `{error}` 回包在入口短路；不要让确认帧或错误帧落入普通状态渲染。
- 所有颜色先进入 `theme.css` 语义令牌。Chart.js、canvas、内联动态模板经现有主题工具取值；主题变化后重绘所有相关数据集、标注、预览和对比图。
- 主页面与编辑器保持相同的首帧主题顺序，兼容 `dark`、`light`、`auto` 和既有本地存储键。
- 保持 Calm Canvas 的清晰层级、离线 Phosphor 图标、无 `blur` / `backdrop-filter`、可减少动效和键盘焦点可见。不要为了“Apple 风格”牺牲信息密度、对比度或 44px 触控目标。
- Chart.js 容器从隐藏变可见、工作区切换或全屏变化后，在下一帧执行合适的 `resize()` / `update('none')`，避免零尺寸或残色。
- E-STOP 所在底栏维持 `普通模态 < 急停 < ERROR overlay` 的层级关系，常规模态和图表全屏不能遮挡急停；闪烁只属于确认中的按钮本体。
- 编辑器画布保持 Pointer Events 主路径、pointer capture、active pointer 约束和 `touch-action: none`；不要用仅鼠标事件的实现替换。
- 高频 WebSocket 状态更新要跳过值未变化的 DOM 写入，避免与 Chart.js 重绘竞争。

## 验证选择

在 `desktop/` 中按任务选用：

```powershell
npm run check:frontend
npm run dev:sim -- --freeze
```

- 静态或契约小改至少运行聚焦语法/契约检查。
- 视觉或交互改动使用模拟器在 `roaster-desktop.exe` 原生窗口验收；不要启动可能连接真实 TC4S 的 Python 后端。
- 覆盖受影响的 `idle`、烘焙、`cooling`、`error` 场景，以及 1366×800、最小 1024×640、深色/浅色/跟随系统中相关组合。
- 若用户要求查看原生效果，确认 Tauri 构建完成且进程/窗口真实存在；localhost 页面只证明模拟器服务启动。
- 记录截图或人工观察时，说明窗口、主题、尺寸、场景与未覆盖项。
