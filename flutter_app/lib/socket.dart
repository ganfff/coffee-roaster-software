/// WebSocket 服务 —— 对齐 app.js 的 connectWS：自动重连、错误帧分流
library;

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'models.dart';

class RoasterSocket {
  RoasterSocket(this.baseUrl);

  /// http(s)://host:port
  String baseUrl;

  final _statusController = StreamController<RoasterStatus>.broadcast();
  final _errorController = StreamController<String>.broadcast();
  final _connController = StreamController<bool>.broadcast();

  /// 状态广播流（后端快照帧）
  Stream<RoasterStatus> get status => _statusController.stream;

  /// 服务端 error 帧（如 "未知命令"）→ toast
  Stream<String> get errors => _errorController.stream;

  /// 连接状态变化流
  Stream<bool> get connection => _connController.stream;

  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  Timer? _retry;
  bool _disposed = false;
  bool _connected = false;
  bool get isConnected => _connected;

  Uri get _wsUri {
    final u = Uri.parse(baseUrl);
    return Uri(
      scheme: u.scheme == 'https' ? 'wss' : 'ws',
      host: u.host,
      port: u.port,
      path: '/ws',
    );
  }

  void connect() {
    if (_disposed) return;
    _retry?.cancel();
    _sub?.cancel();
    final old = _ch;
    _ch = null;
    if (old != null) {
      // close() 的失败 Future 必须吞掉，否则变成 unhandled async error
      unawaited(old.sink.close().catchError((_) {}));
    }
    WebSocketChannel ch;
    try {
      ch = WebSocketChannel.connect(_wsUri);
    } catch (_) {
      _scheduleReconnect();
      return;
    }
    _ch = ch;
    // ready 在握手成功/失败时完成；失败统一走重连（也必须捕获，理由同上）
    unawaited(ch.ready.then((_) {
      _setConnected(true);
    }).catchError((_) {}));
    _sub = ch.stream.listen(
      (data) {
        _setConnected(true);
        Map<String, dynamic> msg;
        try {
          msg = jsonDecode(data as String) as Map<String, dynamic>;
        } catch (_) {
          return;
        }
        // 命令回包不进入状态解析（对齐 app.js handleWSMessage）
        if (msg['error'] != null) {
          _errorController.add(msg['error'].toString());
          return;
        }
        if (msg['ok'] == true) return;
        _statusController.add(RoasterStatus.fromJson(msg));
      },
      onDone: _handleDrop,
      onError: (_) => _handleDrop(),
      cancelOnError: false,
    );
  }

  void _handleDrop() {
    _setConnected(false);
    _scheduleReconnect();
  }

  void _setConnected(bool v) {
    if (_connected == v) return;
    _connected = v;
    if (!_connController.isClosed) _connController.add(v);
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _setConnected(false);
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 2), connect);
  }

  /// 发送命令；未连接返回 false（调用方给 toast）
  bool sendCmd(String cmd, [Map<String, dynamic> payload = const {}]) {
    final ch = _ch;
    if (!_connected || ch == null) return false;
    try {
      ch.sink.add(jsonEncode({'cmd': cmd, ...payload}));
      return true;
    } catch (_) {
      return false;
    }
  }

  void updateBaseUrl(String url) {
    baseUrl = url;
    connect();
  }

  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _sub?.cancel();
    final ch = _ch;
    _ch = null;
    if (ch != null) {
      unawaited(ch.sink.close().catchError((_) {}));
    }
    _statusController.close();
    _errorController.close();
    _connController.close();
  }
}
