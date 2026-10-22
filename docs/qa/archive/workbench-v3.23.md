# 原生工作台 v3.23 / 桌面 0.3.0 验证

日期：2026-10-21。参考来源为本工作区 `kaffelogic逆向` 中的 RoastWorkbench 0.2.2。测试只使用离线数学引擎、fake controller 和 Node 安全模拟器，未启动 Python 硬件 lifespan，未访问真实串口。

## 功能迁移

| 功能 | 实现与证据 |
|---|---|
| 原生格式保真、未知字段、BOM、行尾、offsets、事件 | `roaster/src/workbench/native/core.py`；224 项参考项目核心/编辑/诊断回归 |
| 用户提供的完整语料 | 418 个实例：403 个有效文件逐字节往返、14 个空文件、1 个截断文件；32 个有效文档保持只读，验证前后源 SHA-256 一致 |
| 双贝塞尔曲线、控制柄、插点、删除、连接、平滑 | 离线 engine + Web 画布；数值编辑、实际 Pointer Events 拖动、一次拖动一次撤销及精确字节撤销/重做 |
| 风扇映射、累计阶跃、反向叠加 | 直接复用 `cross_plot_points`；原运行时 default/real/steps 三场景的完整坐标数组对照，默认叠加起点 215.5°C |
| ABC、推荐结束、温度单位 | 从参考模块提取纯计算部分；阶段总时长与占比、温差与零阈值、曲线变更及输入重算 |
| 原分类参数、帮助、难度与只读边界 | 原 144 参数目录；默认曲线现有 50 个设置字段全部显示，未知键和 schema 不允许修改 |
| 日志通道、记录/重算 RoR、平滑、倍率、事件与阶段 | 真实多通道日志 + 合成边界；显示设置不改原始字节，移除事件后对应指标留空 |
| 比较、参数差异、变换、合并、提取、面积与时间 | 纯函数与引擎契约；界面验证比较不替换主文档，参数差异可见 |
| 原生保存、取消、CSV、PNG、多页 PDF | 原生格式导出/重开、取消保留 dirty、非法字段阻止旧文档误存、UTF-8 BOM CSV；4 页 PDF 经 pypdf 解析与 Poppler 渲染检查 |
| 当前曲线库与历史记录 | 现有插值精确转贝塞尔；控制曲线新 UUID、安全温度边界与非待机拒绝；缺快照时不生成曲线，默认参考参数明确标记 |
| 现有 AI 与急停 | 16 项 AI 测试、既有 AI UI 全流程；工作台对话框不拦截急停，烘焙模拟场景双击急停进入 ERROR，离线文档保持原样 |

## 当次检查

- 后端 unittest：24 项通过（原有 9 项 + 离线引擎/语料 12 项 + 新 API 3 项）。API 测试断言硬件连接未被调用。
- 参考项目核心回归：224 项通过，导入对象映射到本次迁移后的 native 包，未使用原实现替代被测对象。
- 工作台浏览器集成：最终使用打包 EXE 的 22 个场景通过，JavaScript errors 为空；源码引擎也完成了基础流程，最新 [ui-report.json](workbench-v3.23/ui-report.json) 记录实际引擎类型。
- AI：16 项 Node 测试通过；原有 AI UI 覆盖设置、复盘、源曲线、候选/采用/撤销/保存、取消、1024 布局和每锅手动辅导，使用模拟 IPC。截图保存在 [ai-regression](workbench-v3.23/ai-regression/)。
- Rust：2 项测试通过；共享前端 9 个 JS、5 个 CSS、2 个 HTML 契约检查通过。
- 独立引擎：复制到随机临时目录，移除开发 PATH、PYTHONPATH、PYTHONHOME 与虚拟环境，10 项检查通过；结果见 [package-report.json](workbench-v3.23/package-report.json)。
- Windows release 与 NSIS 安装包构建通过；最终文件、字节数、SHA-256 与引擎源指纹见 [delivery.json](workbench-v3.23/delivery.json)。
- `git diff --check` 通过。

## 界面与导出

- [1366×800 浅色曲线](workbench-v3.23/profile-light.png)
- [1024×640 深色真实日志](workbench-v3.23/log-dark-1024.png)
- [本软件历史记录分析](workbench-v3.23/console-record.png)
- [多页 PDF](workbench-v3.23/untitled.pdf) 与 `pdf-page-*.png`：曲线及中文参数均可渲染。

上述交互截图来自 Microsoft Edge 浏览器，使用与 Tauri 相同的共享前端。打包引擎使用真实 EXE，Tauri 壳已编译；这些证据不冒充原生窗口人工操作或 Windows 保存对话框的物理鼠标验证。未运行安装器覆盖现有用户安装。

## 迁移与控制边界

原生温度曲线进入曲线库时适配现有 Catmull-Rom 表达，最多 64 节点；至少 1001 个并包含原锚点的密集探针检查采样误差 ≤0.25°C，后端进一步检查完整插值极值和实际设备温度限制。此误差是采样验证，不宣称任意连续时间的解析误差界。

保存只生成新 UUID，不自动应用。风扇和 Kaffelogic 专用参数留在离线文档中；控制器和硬件通信没有改变。原生附件不进入 AI 提示。用户提供的参考目录、真实样本、原程序与研究工具没有成为产品运行依赖。

本次范围是参考项目已实现的离线功能。Link、第三方转换、USB/Wi-Fi/云连接仍不包含；未声称 Qt/wx 像素一致。树莓派依赖安装、原生窗口物理输入、真实 TC4S、风扇和试烘待目标环境验收。

## 重现

```powershell
Set-Location roaster
.venv/Scripts/python.exe -m unittest discover -s tests -v
Set-Location ../desktop
npm run check:frontend
npm run test:ai
npm run test:ai:ui
$env:WORKBENCH_SOURCE = '0'
npm run test:workbench:ui
../roaster/.venv/Scripts/python.exe tools/verify-workbench-package.py
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

原有 AI UI 命令会写入其历史截图目录，交付时已将本次截图移至新的 `ai-regression` 子目录并恢复旧版基准。真实语料测试在本机参考目录存在时执行；新 checkout 无此目录时这两项 oracle/语料检查明确 skip，基础合成契约仍执行。
