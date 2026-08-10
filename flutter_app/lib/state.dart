/// 中央状态仓库 —— 对齐 app.js 的全局状态与 handleStateUpdate 行为：
/// 实时曲线追加（同秒覆盖）、ROR EWMA 平滑、曲线来源切换（待机选中/烘焙锁定）、
/// 事件标注、对比模式、COOLING 保存确认、乐观复位。
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'models.dart';
import 'socket.dart';
import 'spline.dart';

class RoasterStore extends ChangeNotifier {
  RoasterStore({required this.api, required this.socket});

  final RoasterApi api;
  final RoasterSocket socket;

  static const int maxPoints = 2400;
  static const double rorEwmaAlpha = 0.3;

  // ---- 状态快照 ----
  RoasterStatus status = RoasterStatus(state: 'IDLE');
  bool wsConnected = false;

  // ---- 实时图表数据（对齐 app.js datasets 0/1/3）----
  List<ChartPoint> pvSeries = [];
  List<ChartPoint> svSeries = [];
  List<ChartPoint> rorSeries = [];
  double _rorEwma = 0;

  // ---- 目标曲线（dataset 2/4）----
  List<ChartPoint> profileSeries = [];
  List<ChartPoint> profileRorSeries = [];
  String profileSeriesName = '目标曲线';
  String _profileCurveKey = '';

  // ---- 图例可见性 ----
  final Map<String, bool> legendVisible = {
    'pv': true,
    'sv': true,
    'profile': true,
    'ror': true,
    'rorPreview': true,
  };

  // ---- 曲线选择（对齐 app.js: currentProfile/activeRoastProfile）----
  Map<String, RoastProfile> profileMap = {};
  String? selectedProfileId;
  RoastProfile? currentProfile;
  RoastProfile? _activeRoastProfile;
  String? _activeRoastProfileId;
  String? _activeRoastProfileName;
  String? _activeFetchId;
  int _activeRequestSeq = 0;

  // ---- 对比模式 ----
  bool compareMode = false;
  List<ChartPoint> compareASeries = [];
  List<ChartPoint> compareBSeries = [];

  // ---- 提示与一次性事件 ----
  final _toastController = StreamController<String>.broadcast();
  Stream<String> get toasts => _toastController.stream;

  /// COOLING 保存确认（session-scoped，只弹一次，对齐 app.js）
  final _saveConfirmController = StreamController<String>.broadcast();
  Stream<String> get saveConfirmRequests => _saveConfirmController.stream;
  String? _lastPromptedSessionId;

  String _lastState = 'IDLE';
  double _lastOfflineToastAt = 0;

  StreamSubscription? _statusSub;
  StreamSubscription? _errorSub;
  StreamSubscription? _connSub;

  void attach() {
    _statusSub = socket.status.listen(handleStatus);
    _errorSub = socket.errors.listen(_toast);
    _connSub = socket.connection.listen((v) {
      wsConnected = v;
      notifyListeners();
    });
    socket.connect();
  }

  void _toast(String msg) {
    if (!_toastController.isClosed) _toastController.add(msg);
  }

  /// 对齐 app.js sendCmd：关键命令断线时 toast
  bool sendCmd(String cmd, [Map<String, dynamic> payload = const {}]) {
    final ok = socket.sendCmd(cmd, payload);
    if (!ok && _shouldWarnOffline(cmd)) {
      final now = DateTime.now().millisecondsSinceEpoch / 1000.0;
      if (now - _lastOfflineToastAt > 2) {
        _toast('WebSocket 未连接，操作未发送');
        _lastOfflineToastAt = now;
      }
    }
    return ok;
  }

  bool _shouldWarnOffline(String cmd) =>
      cmd == 'start' ||
      cmd == 'event' ||
      cmd == 'emergency_stop' ||
      cmd == 'e-stop' ||
      cmd.startsWith('set_');

  // ============ 状态帧处理（对齐 handleStateUpdate）============

  void handleStatus(RoasterStatus msg) {
    status = msg;
    if (!compareMode) _syncActiveRoastProfile(msg);

    if (msg.state == 'ERROR' && compareMode) exitCompareMode();

    if (!compareMode && msg.state != 'ERROR') {
      final enteringRoast = msg.state == 'ROASTING' && _lastState != 'ROASTING';
      final enteringIdle = msg.state == 'IDLE' && _lastState != 'IDLE';
      if (enteringRoast || enteringIdle) {
        pvSeries = [];
        svSeries = [];
        rorSeries = [];
        _rorEwma = 0;
      }
      _lastState = msg.state;

      if (msg.state == 'ROASTING') {
        final t = msg.elapsed.floorToDouble().clamp(0.0, double.infinity).toDouble();
        _appendPoint(pvSeries, t, msg.pv);
        _appendPoint(svSeries, t, msg.sv);
        _rorEwma = rorEwmaAlpha * msg.ror + (1 - rorEwmaAlpha) * _rorEwma;
        _appendPoint(rorSeries, t, _rorEwma);
      } else if (msg.state == 'COOLING') {
        // COOLING 只定格温度与 SV，不再追加 ROR
        final t = msg.elapsed.floorToDouble().clamp(0.0, double.infinity).toDouble();
        _appendPoint(pvSeries, t, msg.pv);
        _appendPoint(svSeries, t, msg.sv);
      }
    } else {
      _lastState = msg.state;
    }

    // COOLING 保存确认（session-scoped 只弹一次）
    if (msg.state == 'COOLING' &&
        msg.sessionId != null &&
        msg.sessionId != _lastPromptedSessionId) {
      _lastPromptedSessionId = msg.sessionId;
      final sid = msg.sessionId!;
      Timer(const Duration(milliseconds: 500), () {
        if (!_saveConfirmController.isClosed) _saveConfirmController.add(sid);
      });
    }

    notifyListeners();
  }

  /// 同一秒内只保留最新有效值（对齐 appendRealtimePoint）
  void _appendPoint(List<ChartPoint> series, double x, double? y) {
    if (y == null || y.isNaN) return;
    if (series.isNotEmpty && series.last.x == x) {
      if (series.last.y == y) return;
      series[series.length - 1] = ChartPoint(x, y);
      return;
    }
    series.add(ChartPoint(x, y));
    if (series.length > maxPoints) series.removeAt(0);
  }

  // ============ 曲线来源（对齐 syncActiveRoastProfile 等）============

  RoastProfile? get displayProfile =>
      status.isRoastActive ? _activeRoastProfile : currentProfile;

  String get currentProfileDisplayName {
    if (status.isRoastActive) {
      return _activeRoastProfileName ??
          _activeRoastProfile?.name ??
          (_activeRoastProfileId != null ? '曲线 $_activeRoastProfileId' : '--');
    }
    final p = currentProfile ??
        (selectedProfileId != null ? profileMap[selectedProfileId] : null);
    return p?.name ?? '--';
  }

  void _syncActiveRoastProfile(RoasterStatus msg) {
    if (!msg.isRoastActive) {
      final hadActive = _activeRoastProfile != null ||
          _activeRoastProfileId != null ||
          _activeRoastProfileName != null;
      _activeRoastProfile = null;
      _activeRoastProfileId = null;
      _activeRoastProfileName = null;
      _activeFetchId = null;
      _activeRequestSeq++;
      if (hadActive) _restoreProfileCurveForState(msg.state);
      return;
    }

    final backendId = msg.profileId;
    final backendName = msg.profileName ?? '';
    if (backendId != _activeRoastProfileId) {
      _activeRoastProfile = null;
      _activeFetchId = null;
      _activeRequestSeq++;
    }
    _activeRoastProfileId = backendId;
    _activeRoastProfileName = backendName;

    if (backendId == null) {
      _clearProfilePreview();
      return;
    }
    if (_activeRoastProfile != null && _activeRoastProfile!.id == backendId) {
      _showProfileCurve(_activeRoastProfile!, 'active');
      return;
    }
    if (currentProfile != null && currentProfile!.id == backendId) {
      _activeRoastProfile = currentProfile;
      _showProfileCurve(_activeRoastProfile!, 'active');
      return;
    }
    final cached = profileMap[backendId];
    if (cached != null && cached.nodes.isNotEmpty) {
      _activeRoastProfile = cached;
      _showProfileCurve(cached, 'active');
      return;
    }

    _clearProfilePreview();
    if (_activeFetchId == backendId) return;
    _activeFetchId = backendId;
    final seq = ++_activeRequestSeq;
    api.getProfile(backendId).then((profile) {
      if (seq != _activeRequestSeq) return;
      if (!status.isRoastActive || _activeRoastProfileId != backendId) return;
      if (profile == null) return;
      _activeRoastProfile = profile;
      profileMap[backendId] = profile;
      _showProfileCurve(profile, 'active');
      notifyListeners();
    });
  }

  void _restoreProfileCurveForState(String state) {
    final profile = (state == 'ROASTING' || state == 'COOLING')
        ? _activeRoastProfile
        : currentProfile;
    if (profile != null) {
      _showProfileCurve(profile, profile == _activeRoastProfile && state != 'IDLE' ? 'active' : 'selected');
    } else {
      _clearProfilePreview();
    }
  }

  String _curveKey(RoastProfile p, String source) {
    final nodes = p.nodes;
    final first = nodes.isNotEmpty ? nodes[0] : null;
    final last = nodes.isNotEmpty ? nodes[nodes.length - 1] : null;
    return [
      source,
      p.id,
      p.name,
      nodes.length,
      first?.time ?? '',
      first?.temperature ?? '',
      last?.time ?? '',
      last?.temperature ?? ''
    ].join('|');
  }

  void _clearProfilePreview() {
    profileSeries = [];
    profileRorSeries = [];
    profileSeriesName = '目标曲线';
    _profileCurveKey = 'empty';
  }

  void _showProfileCurve(RoastProfile profile, String source) {
    if (profile.nodes.isEmpty) {
      _clearProfilePreview();
      return;
    }
    final key = _curveKey(profile, source);
    if (key == _profileCurveKey) return;
    _profileCurveKey = key;
    profileSeries = splineInterpolate(profile.nodes, 5);
    profileRorSeries = buildRORDataset(profile.nodes);
    profileSeriesName = profile.name;
  }

  // ============ 曲线库操作 ============

  Future<void> refreshProfiles() async {
    try {
      final list = await api.listProfiles();
      profileMap = {for (final p in list) p.id: p};
      if (list.isEmpty) {
        selectedProfileId = null;
        currentProfile = null;
        _clearProfilePreview();
      } else {
        if (selectedProfileId == null || !profileMap.containsKey(selectedProfileId)) {
          selectedProfileId = list.first.id;
        }
        if (!status.isRoastActive) {
          await applySelectedProfile(silent: true);
        }
      }
      notifyListeners();
    } catch (_) {
      _toast('加载曲线失败');
    }
  }

  Future<bool> applySelectedProfile({bool silent = false}) async {
    final id = selectedProfileId;
    if (id == null) return false;
    if (status.isRoastActive) {
      if (!silent) _toast('烘焙中不能应用曲线');
      return false;
    }
    final profile = await api.getProfile(id);
    if (profile == null) return false;
    currentProfile = profile;
    profileMap[id] = profile;
    _showProfileCurve(profile, 'selected');
    notifyListeners();
    return true;
  }

  Future<void> selectAndApplyProfile(String id) async {
    if (status.isRoastActive) {
      _toast('烘焙中不能应用曲线');
      return;
    }
    selectedProfileId = id;
    if (await applySelectedProfile()) {
      _toast('已应用曲线');
    }
  }

  Future<bool> deleteProfile(String id) async {
    final ok = await api.deleteProfile(id);
    if (ok) {
      await refreshProfiles();
    } else {
      _toast('删除曲线失败');
    }
    return ok;
  }

  // ============ 流程操作 ============

  void startRoast() {
    final id = selectedProfileId;
    if (id == null) {
      _toast('请先选择一条曲线');
      return;
    }
    sendCmd('start', {'profile_id': id});
  }

  void logEvent(String type) {
    if (status.state != 'ROASTING') return;
    sendCmd('event', {'type': type});
  }

  void emergencyStop() => sendCmd('emergency_stop');

  Future<void> saveAndClear() async {
    _toast('正在保存...');
    try {
      await api.saveAndClear();
    } catch (_) {}
  }

  /// 不保存：乐观复位 + 后端丢弃（对齐 optimisticResetToIdle）
  Future<void> discardAndClear() async {
    optimisticResetToIdle();
    try {
      await api.discardAndClear();
    } catch (_) {}
  }

  void optimisticResetToIdle() {
    _lastPromptedSessionId = null;
    _lastState = 'IDLE';
    _activeRoastProfile = null;
    _activeRoastProfileId = null;
    _activeRoastProfileName = null;
    _activeFetchId = null;
    _activeRequestSeq++;
    _rorEwma = 0;
    pvSeries = [];
    svSeries = [];
    rorSeries = [];
    status = RoasterStatus(state: 'IDLE', connected: status.connected);
    _restoreProfileCurveForState('IDLE');
    notifyListeners();
  }

  // ============ 对比模式 ============

  Future<void> enterCompare(String sidA, String sidB) async {
    try {
      final results = await Future.wait([api.getRecord(sidA), api.getRecord(sidB)]);
      final r1 = results[0], r2 = results[1];
      if (r1 == null || r2 == null) throw StateError('missing');
      compareASeries = r1.data.map((d) => ChartPoint(d[0], d[1])).toList();
      compareBSeries = r2.data.map((d) => ChartPoint(d[0], d[1])).toList();
      compareMode = true;
      _profileCurveKey = 'compare';
      notifyListeners();
    } catch (_) {
      _toast('加载对比记录失败');
    }
  }

  void exitCompareMode() {
    compareMode = false;
    compareASeries = [];
    compareBSeries = [];
    _restoreProfileCurveForState(status.state);
    notifyListeners();
  }

  // ============ 超前预测 ============

  void setPhaseLookahead(String phase, double value) {
    sendCmd('set_phase_lookahead', {'phase': phase, 'value': value});
  }

  void setLookaheadOffset(double value) {
    sendCmd('set_lookahead_offset', {
      'params': {'value': value}
    });
  }

  void toggleLegend(String key) {
    legendVisible[key] = !(legendVisible[key] ?? true);
    notifyListeners();
  }

  @override
  void dispose() {
    _statusSub?.cancel();
    _errorSub?.cancel();
    _connSub?.cancel();
    _toastController.close();
    _saveConfirmController.close();
    super.dispose();
  }
}
