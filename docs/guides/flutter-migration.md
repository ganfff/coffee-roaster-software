# Flutter 移植与开发指南

> 完整 Flutter 源码位于 Git 分支 `feature/flutter-app`。当前 Tauri 分支不保留 Flutter 平台生成目录，切换分支后再按本文档验证。

> 目标：把 `roaster/static/` 网页前端用 Flutter（Dart）重写一份，得到可上架应用商店的
> 原生 iOS/Android App，同时可编译为 Windows/Linux/macOS 桌面程序。
> **后端（FastAPI + 树莓派/ESP32）一行不用改**——Flutter 只是又一个 HTTP/WebSocket 客户端。

## 〇、先做决策：你真的需要 Flutter 吗？

| 诉求 | 够用的方案 | 需要 Flutter |
|---|---|---|
| 客户在机器旁操作 | 浏览器 / PWA（现状） | 否 |
| Windows/Mac 桌面软件 | Tauri 壳（见 desktop/） | 否 |
| 手机桌面图标、全屏 | PWA「添加到主屏幕」 | 否 |
| **应用商店上架、品牌曝光** | — | **是** |
| **锁屏推送通知**（"一爆了！"） | — | **是** |
| 微信小程序 | uni-app 重写（另一套技术） | 否（Flutter 不出小程序） |

如果确认要做，按本文档执行。**建议先做完 PWA + Tauri，Flutter 排到最后。**

## 一、API 契约（Flutter 端要对齐的接口清单）

后端地址：开发期连真机 `http://<树莓派IP>:8000`，或本机 `python main.py`。

### REST（`roaster/src/web/web_api.py`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/status` | 状态快照（WS 断线时兜底） |
| POST | `/api/v1/control/start` | body: `{profile_id}` |
| POST | `/api/v1/control/end` | 兼容入口（出豆自动结束） |
| POST | `/api/v1/control/save_and_clear` | 保存记录并清屏 |
| POST | `/api/v1/control/discard_and_clear` | 丢弃并清屏 |
| POST | `/api/v1/control/emergency_stop` | 急停 |
| POST | `/api/v1/events` | body: `{type, note}` |
| GET | `/api/v1/profiles` | 曲线列表 |
| GET | `/api/v1/profiles/{id}` | 曲线详情 |
| POST | `/api/v1/profiles` | 保存曲线（新建/覆盖） |
| DELETE | `/api/v1/profiles/{id}` | 删除 |
| POST | `/api/v1/profiles/import` | 导入（自动去 id） |
| GET | `/api/v1/profiles/{id}/export` | 导出 JSON 附件 |
| GET | `/api/v1/records?limit=&offset=` | 记录列表 |
| GET | `/api/v1/records/{id}` | 记录详情（含 profile_snapshot） |
| GET | `/api/v1/records/{id}/export/csv` | 导出 CSV |
| GET | `/api/v1/records/{id}/export/json` | 导出 JSON |

### WebSocket `ws://<host>/ws`

- 连接后服务端立刻发一帧**全量状态快照**，之后按 `broadcast_interval` 周期广播
  （结构 = `RoasterController.get_state_payload()`，字段见 `src/core/models.py` 的
  `RoasterStatus`：pv/sv/ror/state/elapsed/events/current_phase/lookahead_used/...）
- 客户端命令（JSON）：

```
{ "cmd": "start", "profile_id": "..." }
{ "cmd": "save_and_clear" } / { "cmd": "discard_and_clear" }
{ "cmd": "emergency_stop" }
{ "cmd": "event", "type": "yellowing|first_crack|first_crack_end|second_crack|second_crack_end|drop", "note": "" }
{ "cmd": "set_phase_lookahead", "phase": "drying|maillard|development", "value": 1.0 }
{ "cmd": "set_lookahead", "params": { "value": 10.0 } }
{ "cmd": "set_lookahead_offset", "params": { "value": 0.5 } }
```

错误帧格式：`{ "error": "..." }`；部分写命令回 `{ "ok": true }`。

## 二、模块映射：现有 JS → Flutter

| 现有（web） | Flutter 对应 | 移植难度 |
|---|---|---|
| `index.html` 主控页 | `MainScreen`（Scaffold + 自定义布局） | 中 |
| Chart.js 双轴图表 | **CustomPainter 自绘**（推荐，行为完全可控）或 fl_chart 改造 | **高（最大工作量）** |
| `editor.html` 曲线编辑器（拖拽/撤销重做/键盘吸附） | `EditorScreen` + GestureDetector + 命令栈 | **高** |
| `utils.js` 样条插值 | 纯函数直译 Dart（见下，30 行） | 低 |
| `utils.js` ROR 数据集 | 直译 | 低 |
| WS 重连/指示灯 | `RoasterSocket`（Stream + 自动重连） | 低 |
| 曲线卡片网格 | `GridView` + Card | 低 |
| 记录列表/对比/导出 | ListView + 多选 + `share_plus`/`path_provider` 导出 | 中 |
| 阶段条/事件 badge | Widget 组合 | 低 |
| 后端地址配置 | `shared_preferences` 持久化 + 设置页 | 低 |

**建议策略：编辑器首期用 WebView 嵌现有 editor.html 过渡**（`webview_flutter` 包），
把重写量最大的两块（主图表交互 + 编辑器）里的编辑器后置，先让 App 跑起来。

## 三、关键代码移植示例

### 1. 样条插值（utils.js → Dart，直译）

```dart
double catmullRom(double p0, double p1, double p2, double p3, double t) {
  return 0.5 *
      ((2 * p1) +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

double getSplineTemp(List<({double time, double temperature})> nodes, double elapsed) {
  if (nodes.isEmpty) return 0;
  if (elapsed <= nodes.first.time) return nodes.first.temperature;
  final n = nodes.length;
  for (var i = 0; i < n - 1; i++) {
    final prev = nodes[i], curr = nodes[i + 1];
    if (prev.time <= elapsed && elapsed <= curr.time) {
      if (n < 4) {
        final ratio = (elapsed - prev.time) / (curr.time - prev.time);
        return prev.temperature + ratio * (curr.temperature - prev.temperature);
      }
      final p1 = prev.temperature, p2 = curr.temperature;
      final p0 = i == 0 ? p1 : nodes[i - 1].temperature;
      final p3 = i == n - 2 ? p2 : nodes[i + 2].temperature;
      final t = (elapsed - prev.time) / (curr.time - prev.time);
      return catmullRom(p0, p1, p2, p3, t);
    }
  }
  return nodes.last.temperature;
}
```

### 2. WebSocket 服务（自动重连 + 状态流）

```dart
class RoasterSocket {
  RoasterSocket(this.baseUrl);
  String baseUrl; // 如 http://192.168.1.50:8000

  final _controller = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get status => _controller.stream;
  WebSocketChannel? _ch;
  Timer? _retry;

  void connect() {
    _retry?.cancel();
    final ws = baseUrl.replaceFirst('http', 'ws');
    _ch = WebSocketChannel.connect(Uri.parse('$ws/ws'));
    _ch!.stream.listen(
      (data) => _controller.add(jsonDecode(data) as Map<String, dynamic>),
      onDone: _scheduleReconnect,
      onError: (_) => _scheduleReconnect(),
    );
  }

  void send(Map<String, dynamic> cmd) => _ch?.sink.add(jsonEncode(cmd));

  void _scheduleReconnect() {
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 2), connect);
  }
}
```

### 3. 推荐依赖（pubspec.yaml）

```yaml
dependencies:
  flutter:
    sdk: flutter
  web_socket_channel: ^3.0.0   # WebSocket
  dio: ^5.0.0                  # REST（比 http 好用：拦截器/超时）
  riverpod: ^2.5.0             # 状态管理（或 provider，二选一）
  shared_preferences: ^2.2.0   # 存后端地址等配置
  fl_chart: ^0.69.0            # 备选图表库（主图表建议最终自绘 CustomPainter）
  webview_flutter: ^4.8.0      # 过渡期内嵌曲线编辑器网页
  share_plus: ^10.0.0          # 导出记录时调系统分享
```

## 四、开发环境与工作流

```bash
# 1. 装 Flutter SDK（https://flutter.dev），把 flutter/bin 加入 PATH
flutter doctor                 # 检查环境，按提示补 Android Studio / VS 等

# 2. 建项目（建议放在仓库 flutter_app/ 目录）
cd <仓库根目录>
flutter create --org com.ganf --project-name roaster_app flutter_app
cd flutter_app

# 3. 跑起来（三选一）
flutter run -d windows         # Windows 桌面，调试最快
flutter run -d <手机设备名>     # 手机插线开 USB 调试（flutter devices 查看）
flutter run -d chrome          # 也可以先跑 web 版调布局

# 4. 日常开发循环
#    改代码 → 按 r（热重载，亚秒级）→ 看效果；按 R 热重启
```

开发期把 `baseUrl` 指向真机后端（`http://<树莓派IP>:8000`）或本机
`python main.py`（Windows 调试时用 `http://localhost:8000`）。
**后端 CORS 已在 Tauri 分支中放开（allow_origins=*），Flutter 直连无障碍。**

## 五、移植里程碑（建议顺序）

| 阶段 | 内容 | 预估 |
|---|---|---|
| M1 | 工程骨架 + 设置页（后端地址）+ RoasterSocket 连通，能显示实时 PV/SV/ROR 三个数 | 1~2 天 |
| M2 | 主图表 CustomPainter 自绘：双 Y 轴、温度/设定/目标/ROR 四线、图例开关 | 3~5 天 |
| M3 | 烘焙流程闭环：开始/事件按钮/阶段条/出豆结束/保存确认/急停 | 2~3 天 |
| M4 | 曲线库卡片网格（应用/删除/导入/导出） | 1~2 天 |
| M5 | 记录列表 + 详情 + 双记录对比 | 2~3 天 |
| M6 | 曲线编辑器：首期 WebView 嵌网页；原生重写（拖拽/撤销栈）另排 5~8 天 | 1 天 / 5~8 天 |
| M7 | 打磨：深色系主题对齐网页版、PWA 同款图标、断线提示 | 2 天 |

**总计约 3~4 周**（编辑器原生重写占大头）。M1 当天就能看到东西，每阶段独立可用。

## 六、打包发布

```bash
flutter build apk --release          # Android：直接发 apk 给客户（国内无需商店）
flutter build appbundle --release    # 上架 Google Play / 国内各商店用 aab
flutter build windows --release      # Windows 桌面（build/windows/runner/Release/）
flutter build linux --release        # Linux 桌面（需在 Linux 机器上构建）
flutter build ios --release          # iOS：必须 Mac + Apple 开发者账号($99/年) + App Store 审核
```

### 树莓派本机屏跑 Flutter（可选）

Flutter 官方支持 Linux 桌面，树莓派 4B 可跑：

- 简单路线：Pi OS 桌面环境 + `flutter build linux`（在 Pi 上或交叉编译）
- 极致路线：`flutter-pi`（开源 embedder），不跑桌面环境直接全屏 DRM/KMS 渲染，
  开机直达 App —— 体验等同"烘焙机操作系统"

但注意：**这条路线下 Pi 本机 UI 和手机 App 是同一套 Flutter 代码**，
这是 Flutter 相对"网页 + Tauri"唯一的覆盖面优势，代价是全量重写。

## 七、两条路线的关系（避免重复投入）

```
现状网页前端
 ├── 浏览器/PWA ────────────► 手机、触摸屏（零成本，已有）
 ├── Tauri 壳 ──────────────► Windows/Mac/Linux 桌面（零重写，见 desktop/）
 └── Flutter 重写（本文档）─► 应用商店 App、推送通知
        ↑ 仅当"上架商店/推送"成为真实商业需求时启动
```

Flutter 版与网页版**共用同一个后端**，可以长期并存、按设备场景分发，
不存在"迁移后旧的要下线"的问题。
