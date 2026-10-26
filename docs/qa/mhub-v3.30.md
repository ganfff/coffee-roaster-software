# Web 3.30 / RoasterDesktop 0.7.0 验收

日期：2026-10-26。已批准方向与源码对应见 [Mhub适配记录](../design/mhub-source-map.md)。

## 交付内容

五个工作区、独立编辑器、AI及动态弹层采用同一套 Mhub 黑白蓝主题与平面控件。旧六配色归一为 Mhub，保留原深浅／跟随系统选择。MiSans在本地分发，包含字体说明、版权与官方许可。

统一区域动效为200ms与 `cubic-bezier(.43,.77,.16,1)`，提供队列、暂停恢复、取消和退出清理；快速工作区／AI切换遵循最后一次意图。实时读数、实时图表、编辑画布和安全栏保持稳定。

## 实际验证

以下命令在 `desktop/` 中运行，全部通过。

| 验证 | 本轮结果 |
| --- | --- |
| `npm run check:frontend` | 15个JS、6个CSS、2个HTML契约、54个图标 |
| `npm run check:themes` | 两种完整外观与主题源一致 |
| `npm run test:local-ai:ui` | 9项；两外观、五工作区、三尺寸的30个布局组合；正文、控件及输入边界对比度 |
| `npm run test:instrument:ui` | 6项；2048／1366／1024×640／375、130%缩放、聊天、菜单、授权恢复与急停命中 |
| `npm run test:mhub:motion` | 6项；正常／减少动效、25次切页、10次AI关闭重开中断、七类区域队列与暂停恢复 |
| `npm run test:editor:session` | 5项、7个尺寸；字段布局、长内容、对话停靠／放大、焦点与会话恢复 |
| `npm run test:workbench:ui` | 22项；指针编辑与撤销、原始字节保真、工具、导出、只读和急停协议 |
| `npm run test:atlas:ui` | 63项；含1024／1179／1180边界五个可见导航图标、单一输入边界、故障恢复及应用保护 |
| `npm run test:instrument:native` | 3项；真实dev WebView读取当前源码、聊天与真实Rust离线引擎 |
| `npm run test:ai:ui` | 12项；完整对话、附件、候选、流式停止、横屏、缩放和恢复 |
| `npm run test:ai` | 48项逻辑与协议测试 |
| `npm run test:dev` | 9项；独立调试服务、未连接提示、设置、离线工作台与本机AI |
| `npm run test:ai:native-ui` | 5项；实际release EXE/WebView/Rust、本机两轮流式对话、系统默认浏览器、离线引擎与嵌入资源一致性 |

实际release验收逐项核对了主题、展示层、动效模块、两个HTML入口和业务脚本的内容，并对三份嵌入字体执行SHA-256比较。OAuth与模型流程使用本地合成夹具，真实服务授权留待实际使用。

## 独立视觉复核

首轮结论为 `fix`，以下原清单均在复核中判定 `resolved`，最终为 `ship（视觉验收范围）`。

- 紧凑侧栏显式恢复图标，覆盖1024、1179与1180px，入口保留可访问名称。
- 搜索和数值字段只由外层容器绘制边界，内部输入透明无边，整体焦点可见。
- 故障原因改为16px，复位按钮使用14px文字、8px圆角及平面危险样式；面板保留单一层次方式。
- 2048px截图等待当前曲线、阶段、偏差、字体及两个绘制帧稳定后采集。

机械detector运行一次。旧设计系统的颜色／字体／字级／圆角提示由本轮批准的设计规范替换处理。两个透明无边外层容器的贴边提示，经实际截图和源码复核关闭；未添加忽略规则。

截图、日志、原始报告和复核索引留在被Git忽略的 `.impeccable/review/`、`desktop/build/qa/mhub-v3.30/` 与 `desktop/build/qa/editor-session/`。

## 设计文档一致性

独立documenter逐项核对两主题148个颜色条目与源码一致，82个组件引用可解析；schemaVersion 2侧车、10个组件及dark/light共20次shadow DOM渲染通过，0页面错误。旧Flavor Atlas约定已明确标记被当前Mhub合约替代。

## Windows构建与本机产物

`node tools/tauri-cli.cjs build` 已完成release构建和NSIS打包。已实际运行release程序；安装器执行与安装后环境未在本轮验证。

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `dist/RoasterDesktop_0.7.0_x64-setup.exe` | 57,536,126 | `83a9bc2f2156d0b33db1bf900f229600db87f7b4ea87283294d3a09b1ac90915` |
| `desktop/src-tauri/target/release/roaster-desktop.exe` | 26,162,688 | `f02a2445539c2e17962b9a4991dd30d1f90b2477359cd4fa7fff56f3c1d8fcfd` |

安装包副本与原NSIS输出哈希一致，旁有 `.sha256` 校验文件。直接运行release EXE时应保留构建目录中的配套资源，不能仅复制EXE作为便携版。

本轮使用Windows、安全模拟器和本地合成AI夹具；未连接真实串口／GPIO／加热器，未验证树莓派帧率或真实付费订阅授权。

根目录 `调试桌面.cmd` 已实际执行，启动0.7.0 dev EXE与 `http://127.0.0.1:18180` 安全模拟服务，健康检查返回当前项目路径。系统窗口捕获接口因缺少Codex app-server未能启动；本轮原生UI证据来自实际WebView的CDP截图与Rust/IPC调用，未将进程启动单独等同于操作系统窗口验收。

## Git交付约定

延续 `codex/github-sync`，只提交源码、设计文档、测试及必要字体许可资源；运行记录、凭据、截图日志和构建产物留在本机。提交推送后另行核对本地HEAD与远端分支一致，不改变main。
