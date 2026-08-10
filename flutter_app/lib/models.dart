/// 数据模型 —— 对齐 roaster/src/core/models.py 的 Pydantic 定义
library;

import 'spline.dart';

/// 烘焙曲线
class RoastProfile {
  final String id;
  String name;
  String description;
  List<ProfileNode> nodes;
  double endTemp;

  RoastProfile({
    this.id = '',
    required this.name,
    this.description = '',
    required this.nodes,
    this.endTemp = 0,
  });

  factory RoastProfile.fromJson(Map<String, dynamic> j) => RoastProfile(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '未命名').toString(),
        description: (j['description'] ?? '').toString(),
        nodes: ((j['nodes'] as List?) ?? [])
            .map((n) => ProfileNode.fromJson(Map<String, dynamic>.from(n as Map)))
            .toList(),
        endTemp: (j['end_temp'] as num?)?.toDouble() ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'name': name,
        'description': description,
        'nodes': nodes.map((n) => n.toJson()).toList(),
        'end_temp': endTemp,
      };

  double get totalTime => nodes.isEmpty ? 0 : nodes.last.time;
}

/// 烘焙事件
class RoastEvent {
  final double time;
  final String type;
  final String note;
  final double? temperature;

  RoastEvent({
    required this.time,
    required this.type,
    this.note = '',
    this.temperature,
  });

  factory RoastEvent.fromJson(Map<String, dynamic> j) => RoastEvent(
        time: (j['time'] as num?)?.toDouble() ?? 0,
        type: (j['type'] ?? '').toString(),
        note: (j['note'] ?? '').toString(),
        temperature: (j['temperature'] as num?)?.toDouble(),
      );

  static const labels = {
    'charge': '入豆',
    'yellowing': '转黄',
    'first_crack': '一爆开始',
    'first_crack_end': '一爆结束',
    'second_crack': '二爆开始',
    'second_crack_end': '二爆结束',
    'drop': '出豆',
  };

  String get label => labels[type] ?? type;
}

/// 分阶段超前预测配置
class PhaseLookaheadConfig {
  final double drying;
  final double maillard;
  final double development;

  const PhaseLookaheadConfig({
    this.drying = 1.0,
    this.maillard = 0.5,
    this.development = 1.0,
  });

  factory PhaseLookaheadConfig.fromJson(Map<String, dynamic> j) =>
      PhaseLookaheadConfig(
        drying: (j['drying'] as num?)?.toDouble() ?? 1.0,
        maillard: (j['maillard'] as num?)?.toDouble() ?? 0.5,
        development: (j['development'] as num?)?.toDouble() ?? 1.0,
      );

  double of(String phase) => switch (phase) {
        'drying' => drying,
        'maillard' => maillard,
        'development' => development,
        _ => 0,
      };
}

/// 实时状态快照（WS 广播 + GET /api/v1/status）
class RoasterStatus {
  final String state; // IDLE / ROASTING / COOLING / ERROR
  final double? pv;
  final double? sv;
  final double ror;
  final double elapsed;
  final String? profileId;
  final String? profileName;
  final String? sessionId;
  final List<RoastEvent> events;
  final Map<String, dynamic> eventStats;
  final bool connected;
  final String? errorReason;
  final double? lookaheadUsed;
  final double? lookaheadOffset;
  final String? currentPhase;
  final PhaseLookaheadConfig? phaseLookaheadConfig;

  RoasterStatus({
    required this.state,
    this.pv,
    this.sv,
    this.ror = 0,
    this.elapsed = 0,
    this.profileId,
    this.profileName,
    this.sessionId,
    this.events = const [],
    this.eventStats = const {},
    this.connected = false,
    this.errorReason,
    this.lookaheadUsed,
    this.lookaheadOffset,
    this.currentPhase,
    this.phaseLookaheadConfig,
  });

  factory RoasterStatus.fromJson(Map<String, dynamic> j) => RoasterStatus(
        state: (j['state'] ?? 'IDLE').toString(),
        pv: (j['pv'] as num?)?.toDouble(),
        sv: (j['sv'] as num?)?.toDouble(),
        ror: (j['ror'] as num?)?.toDouble() ?? 0,
        elapsed: (j['elapsed'] as num?)?.toDouble() ?? 0,
        profileId: j['profile_id']?.toString(),
        profileName: j['profile_name']?.toString(),
        sessionId: j['session_id']?.toString(),
        events: ((j['events'] as List?) ?? [])
            .map((e) => RoastEvent.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(),
        eventStats: Map<String, dynamic>.from((j['event_stats'] as Map?) ?? {}),
        connected: j['connected'] == true,
        errorReason: j['error_reason']?.toString(),
        lookaheadUsed: (j['lookahead_used'] as num?)?.toDouble(),
        lookaheadOffset: (j['lookahead_offset'] as num?)?.toDouble(),
        currentPhase: j['current_phase']?.toString(),
        phaseLookaheadConfig: j['phase_lookahead_config'] is Map
            ? PhaseLookaheadConfig.fromJson(
                Map<String, dynamic>.from(j['phase_lookahead_config'] as Map))
            : null,
      );

  bool get isRoastActive => state == 'ROASTING' || state == 'COOLING';

  String get stateLabel => switch (state) {
        'IDLE' => '待机',
        'ROASTING' => '烘焙中',
        'COOLING' => '烘焙结束',
        'ERROR' => '错误',
        _ => state,
      };
}

/// 记录列表摘要
class RecordSummary {
  final String sessionId;
  final String? startedAt;
  final String? profileName;
  final double durationSec;
  final int? seqNo;
  final String? displayName;

  RecordSummary({
    required this.sessionId,
    this.startedAt,
    this.profileName,
    this.durationSec = 0,
    this.seqNo,
    this.displayName,
  });

  factory RecordSummary.fromJson(Map<String, dynamic> j) => RecordSummary(
        sessionId: (j['session_id'] ?? '').toString(),
        startedAt: j['started_at']?.toString(),
        profileName: j['profile_name']?.toString(),
        durationSec: (j['duration_sec'] as num?)?.toDouble() ?? 0,
        seqNo: (j['seq_no'] as num?)?.toInt(),
        displayName: j['display_name']?.toString(),
      );

  String get name =>
      displayName ?? 'log${(seqNo ?? 0).toString().padLeft(3, '0')}';
}

/// 单次烘焙完整记录。data 元素: [elapsed, pv, sv, ror]
class RoastRecord {
  final String sessionId;
  final String? startedAt;
  final String? profileId;
  final String? profileName;
  final List<RoastEvent> events;
  final List<List<double>> data;
  final int? seqNo;
  final String? displayName;
  final RoastProfile? profileSnapshot;

  RoastRecord({
    required this.sessionId,
    this.startedAt,
    this.profileId,
    this.profileName,
    this.events = const [],
    this.data = const [],
    this.seqNo,
    this.displayName,
    this.profileSnapshot,
  });

  factory RoastRecord.fromJson(Map<String, dynamic> j) => RoastRecord(
        sessionId: (j['session_id'] ?? '').toString(),
        startedAt: j['started_at']?.toString(),
        profileId: j['profile_id']?.toString(),
        profileName: j['profile_name']?.toString(),
        events: ((j['events'] as List?) ?? [])
            .map((e) => RoastEvent.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(),
        data: ((j['data'] as List?) ?? [])
            .map((row) => (row as List)
                .map((v) => (v as num).toDouble())
                .toList())
            .toList(),
        seqNo: (j['seq_no'] as num?)?.toInt(),
        displayName: j['display_name']?.toString(),
        profileSnapshot: j['profile_snapshot'] is Map
            ? RoastProfile.fromJson(
                Map<String, dynamic>.from(j['profile_snapshot'] as Map))
            : null,
      );

  double get duration => data.isEmpty ? 0 : data.last[0];

  /// 终温：以实际记录的最后一个采样点 PV 为准
  double? get actualEndTemp => data.isEmpty ? null : data.last[1];

  String get name =>
      displayName ?? 'log${(seqNo ?? 0).toString().padLeft(3, '0')}';
}
