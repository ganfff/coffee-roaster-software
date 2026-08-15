# Roaster App — Flutter 客户端

把 `roaster/static/` 网页前端完整移植为 Flutter 原生应用，对接**同一个**
树莓派 FastAPI 后端（REST + WebSocket），后端零改动。

## 功能覆盖（对齐网页版）

| 模块 | 状态 |
|---|---|
| 主控页：PV/SV/ROR 读数、状态徽标、时钟 | ✅ |
| 双轴图表（温度/设定/目标曲线/ROR/ROR预览，图例点击切换） | ✅ CustomPainter 自绘 |
| 事件垂直标注 + 标签（7 类事件配色与网页一致） | ✅ |
| 快捷事件按钮（active 高亮 + `m:ss · 温度°` badge） | ✅ |
| 关键事件温度条（转黄/一爆/发展期 ΔT·时长） | ✅ |
| 阶段颜色条（event_stats 驱动，未到达阶段隐藏） | ✅ |
| 三段式烘焙进度条（事件时间戳定段宽 + 指示器） | ✅ |
| 烘焙流程：开始 → 事件 → 出豆自动结束 → 保存确认弹窗 | ✅ |
| 急停（双击确认，2 秒窗口，IDLE 禁用） | ✅ |
| ERROR 全屏红色阻断 + 复位 | ✅ |
| 超前预测三阶段滑块（0~30s，100ms 防抖下发） | ✅ |
| 偏移微调（±3.0s，相机 EV 风格，防抖下发） | ✅ |
| 曲线库：卡片网格 + sparkline + 应用/导出/删除/导入 | ✅ |
| 烘焙记录：列表 / 详情（统计+DTR+事件+背景曲线）/ 导出 CSV·JSON | ✅ |
| 双记录对比（主图表叠加，记录A橙/记录B紫） | ✅ |
| 曲线编辑器：拖拽节点/撤销重做50步/网格吸附/插入复制/精确编辑/键盘快捷键 | ✅ |
| ROR EWMA 平滑（α=0.3）、同秒去重、2400 点上限 | ✅ |
| WS 断线自动重连（2s）、离线命令 toast 提醒 | ✅ |
| 设置页：后端地址配置（持久化） | ✅ |

未做（网页版有，移动端意义不大或后续补）：图表 hover tooltip、记录图表全屏按钮。

## 一、环境准备

1. **Flutter SDK**（stable）：
   ```bash
   git clone --depth 1 -b stable https://github.com/flutter/flutter.git C:\src\flutter
   # 把 C:\src\flutter\bin 加入 PATH
   flutter doctor   # 检查并按提示补全
   ```
2. 目标平台工具链：
   - **Windows 桌面**：Visual Studio 2022 +「使用 C++ 的桌面开发」（本机已装）
   - **Android**：Android Studio + SDK（`flutter doctor` 会引导）

> ⚠️ **重要（本机已踩坑）**：Flutter 的分析服务器在**非 ASCII 路径**（中文目录）
> 下通过 Git Bash 运行会崩溃（LSP 通道解析异常）。规避：
> - 在 **cmd / PowerShell**（非 Git Bash）里跑 flutter 命令；或
> - 把项目放到纯英文路径（本仓库的校验是在 `C:\src\roaster_build` 副本里跑的）。
>
> 日常使用 VS Code / Android Studio 打开项目不受影响（IDE 内嵌分析服务正常）。

## 二、开发

```bash
cd flutter_app
flutter pub get

# 跑起来（三选一）
flutter run -d windows        # Windows 桌面，调试最快
flutter run -d <android设备>   # 手机插线开 USB 调试（flutter devices 查看）
flutter run -d chrome          # 也可先跑 web 版调布局

# 热重载：改代码后按 r；热重启按 R
```

首次启动默认连 `http://localhost:8000`。切换后端很方便：
**主界面底部状态栏点击当前地址** → 弹出最近使用列表一键切换（最多记 5 条，
持久化保存）；也可在「设置」页编辑或点选历史地址。

### 没有后端？用内置模拟后端

`tools/mock_backend.js`（零依赖 Node 脚本）实现了与树莓派后端相同的
REST + WebSocket 协议，内置热仿真模型（一阶滞后 + 噪声），
点开始烘焙即可看到温度沿曲线爬升的完整过程：

```bash
node tools/mock_backend.js 8000   # 然后 App 设置页填 http://localhost:8000
```

支持：开始/事件/出豆自动结束/保存记录/阶段统计/超前预测回显/记录导出。

## 三、测试与静态检查

```bash
flutter analyze    # 静态检查（当前：No issues found）
flutter test       # 25 个单元测试：样条插值/模型解析/状态机行为
```

测试锁定与网页版一致的关键行为：Catmull-Rom 样条数值、ROR 分段差分、
同秒覆盖、EWMA 平滑、状态切换清图、COOLING 保存确认只弹一次等。

## 四、打包发布

```bash
flutter build windows --release   # build\windows\x64\runner\Release\（绿色目录，整体拷走即可）
flutter build apk --release       # Android apk（国内直接发 apk 给客户）
flutter build appbundle           # Play / 国内商店用 aab
flutter build ios                 # 需 Mac + Apple 开发者账号($99/年)
```

Android 打包前建议改 `android/app/build.gradle.kts` 的 `applicationId`
（默认 com.ganf.roaster_app）和应用名（`AndroidManifest.xml` 的 `android:label`）。

## 五、架构

```
lib/
├── main.dart          # 入口 + 外壳（宽屏 NavigationRail / 窄屏底部导航）
├── theme.dart         # 深色配色（与网页版色板一致）
├── models.dart        # 数据模型（对齐 Pydantic：RoasterStatus/Profile/Record/Event）
├── spline.dart        # Catmull-Rom 样条 + ROR 差分 + 格式化（移植自 utils.js）
├── api.dart           # REST 客户端（对齐 web_api.py 全部端点）
├── socket.dart        # WebSocket：自动重连、error/ok 帧分流（对齐 app.js）
├── state.dart         # 中央状态仓库（对齐 app.js 图表/曲线来源/对比/保存确认逻辑）
├── widgets/
│   └── roast_chart.dart   # 双轴图表 CustomPainter（含虚线/填充/事件标注/图例）
└── pages/
    ├── main_page.dart     # 主控页（读数/事件条/阶段条/进度条/控制面板/急停/错误层）
    ├── profiles_page.dart # 曲线库卡片网格 + 导入导出
    ├── records_page.dart  # 记录列表/详情/对比
    ├── editor_page.dart   # 曲线编辑器（拖拽/撤销重做/吸附/快捷键）
    └── settings_page.dart # 后端地址与连接状态
```

状态管理用 Flutter 内置 `ChangeNotifier + ListenableBuilder`，无三方框架；
图表为 `CustomPainter` 自绘（不依赖 fl_chart），视觉与网页版 Chart.js 配置逐条对齐。

## 六、与网页版/Tauri 版的关系

三套前端**共用同一个后端**，可长期并存：

- 网页/PWA：树莓派触摸屏、手机浏览器（零安装）
- Tauri 壳（`desktop/` 分支）：Windows/Mac/Linux 桌面，复用网页
- 本 Flutter App：应用商店分发、锁屏推送通知（推送需后续接 Firebase/厂商通道）

Flutter 原生端不受 CORS 约束，dev 分支的后端可直连。
