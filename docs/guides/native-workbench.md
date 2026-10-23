# 原生文件工作台

桌面 0.3.0 / Web v3.23 将参考项目 RoastWorkbench 0.2.2 的离线功能接入同一个控制台。顶部“原生工作台”可以独立编辑本地文件；桌面内置 Python/NumPy 数值引擎，断开后端后仍可打开、编辑、比较和导出文件。

## 操作

v3.24 / 桌面 0.4.0 新增「功能与说明」：离线搜索功能、KL 适配差异、变化、注意事项与 144 项参数，说明可直达操作和当前字段。AI 对话可带入当前原生文件，先比较温度/风扇候选，再确认采用；一次撤销恢复精确原文。`.klog` 候选创建独立 `.kpro`，原日志可撤销返回。未知版本文件继续只读，不会自动升级。

- 新建，打开或拖入 `.kpro` / `.klog`；每次编辑生成文档副本，原始文件只在显式保存并选择路径后写入。
- 温度与风扇使用六参数贝塞尔曲线。拖动锚点或左右控制柄，或用右侧数值输入；连接、插点、删除、平滑、变换和选择性合并均进入撤销历史。首节点时间锁定，一次拖动一次撤销。
- 右侧 ABC 按推荐程度、预期转黄和一爆温度实时计算阶段时间、占比与温升；推荐程度可在文件信息中修改。时间支持秒数及 `分:秒`。
- 风扇叠加按两幅图未缩放的纵轴范围映射，缩放不会改变映射；风扇增减使用原生的累计时间阶跃。
- 日志可选温度、记录 RoR、独立重算 RoR、功率、风扇、电压及 PID 通道。平滑与倍率仅作用于显示；采样、offsets 与原始事件不回写。六类事件可编辑或清除，缺少事件时阶段指标留空。
- “比较文件”最多加载四个背景文件；可以选通道、隐藏或移除。文件信息及参数页标出差异；背景不替换主文件。
- 参数按原分类、难度、提示和顺序展示。摄氏、华氏和温差分别转换。日志只开放品尝笔记和烘焙日期；未知字段只读。
- 原生文件保存保留未知行、字段顺序、重复事件、BOM、原行尾及未编辑数字。CSV 使用 UTF-8 BOM 原始数值；PNG 导出当前图表；PDF 可选择图表、温度、风扇、记录、文件信息和参数页。
- 取消保存保留未保存状态；更换文件前可保存、放弃或取消。浏览器不支持文件保存 API 时生成下载副本，保留未保存标记，因为下载完成与取消无法可靠区分。

支持 Ctrl+N/O/S、Ctrl+Z/Y、Ins/Del 和方向键。滚轮缩放，Shift+滚轮只缩放纵轴，“全部缩放”恢复范围。数值输入提供拖动操作的键盘与单次点击替代。

## 与现有软件衔接

“从曲线库打开”将当前控制曲线插值精确转换为贝塞尔表达。原生来源的已存曲线优先重开保留的原生文档。记录详情的“在原生工作台分析”可查看本软件的历史采样；缺少历史曲线快照时不生成嵌入曲线。

现有曲线只包含温度时，生成的原生文档会明确标记风扇与设备参数使用新建文件的默认参考。预期转黄和一爆初始留空；真实采样和事件只从历史记录读取。

“存入曲线库”仅在待机时生成新 UUID，用户随后在曲线管理中手动应用。温度目标适配现有 Catmull-Rom 插值，最多 64 节点；逐段密集探针检查采样最大误差不超过 0.25°C，另由现有解析极值校验检查设备温度上限。无法表示的曲线会拒绝转换。转换误差证据写入 `native_conversion`，原生文档写入 `native_source`；这些原生字节不会进入 AI 提示。

推荐结束温度来自原生推荐程度。风扇曲线、Kaffelogic PID、预热和区域参数保留在原生文件内用于编辑分析，不转成 TC4S 输出。现有硬件控制器、主动应用流程、急停和只读 AI 辅导继续工作。

## 兼容范围

可写 profile schema 为 1.4 / 1.6 / 1.8，native log schema 为 1.8。未知版本、缺失版本及倒序/重复采样时间保持只读。空文件和截断日志显示诊断，不补写内容。

本次迁移覆盖参考项目已经实现的离线功能。参考项目未实现的 Link、第三方转换、USB/Wi-Fi/云端连接不随本次新增；现有 TC4S 控机路径继续保留。界面沿用 风味研究图谱（以根 DESIGN.md 为准），功能迁移不代表原 Qt/wx 窗口像素一致。树莓派、真实烘焙机和物理风扇仍需目标设备验证。

## 实现与开发

| 层 | 路径 |
|---|---|
| 保真格式、曲线、RoR、指标、叠加及 ABC | `roaster/src/workbench/native/` |
| 共享离线命令与转换 | `roaster/src/workbench/engine.py` |
| 主界面与多页 PDF | `roaster/static/js/workbench.js`、`workbench-pdf.js` |
| 桌面 IPC、原生保存对话框 | `desktop/src-tauri/src/workbench.rs` |
| 引擎打包、独立运行验证 | `desktop/tools/prepare-workbench.*`、`verify-workbench-package.py` |

Python 3.12 x64 引擎构建环境：

```powershell
python -m venv roaster/.venv
roaster/.venv/Scripts/python.exe -m pip install -r roaster/requirements.txt -r desktop/workbench-requirements.txt httpx
$env:WORKBENCH_PYTHON = (Resolve-Path roaster/.venv/Scripts/python.exe).Path
Set-Location desktop
npm run prepare:workbench
npm run test:workbench:ui
npm run build
```

生产包运行不依赖参考文件夹、虚拟环境、系统 Python、Qt 或 Kaffelogic 安装。独立引擎只读入 stdin JSON，输出 stdout JSON，不访问串口、设备或网络。FastAPI 使用同一核心并在线程中完成数值工作；模拟器也只调用这个离线引擎。Windows 真实后端与串口不用于本机验收。

迁移来源说明见 `roaster/src/workbench/NOTICE.md`，当次验证见 [workbench-v3.23](../qa/archive/workbench-v3.23.md)。
