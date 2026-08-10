/// 数据模型解析测试 —— 对齐后端 Pydantic 模型与 WS 广播帧结构
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:roaster_app/models.dart';

void main() {
  group('RoasterStatus.fromJson', () {
    test('完整帧解析', () {
      final st = RoasterStatus.fromJson({
        'state': 'ROASTING',
        'pv': 152.34,
        'sv': 155.0,
        'ror': 8.456,
        'elapsed': 123.4,
        'profile_id': 'abc-123',
        'profile_name': '耶加雪菲浅焙',
        'session_id': 'sess-1',
        'events': [
          {'time': 0.0, 'type': 'charge', 'note': '', 'temperature': 30.1},
          {'time': 95.0, 'type': 'yellowing', 'note': '', 'temperature': 150.0},
        ],
        'event_stats': {
          'segment_times': {'脱水期': 95.0},
          'segment_ratios': {'脱水期': 42.0},
        },
        'connected': true,
        'error_reason': null,
        'lookahead_used': 12.5,
        'lookahead_offset': 0.5,
        'current_phase': 'drying',
        'phase_lookahead_config': {
          'drying': 1.0,
          'maillard': 0.5,
          'development': 2.0,
        },
      });

      expect(st.state, 'ROASTING');
      expect(st.pv, closeTo(152.34, 1e-9));
      expect(st.events.length, 2);
      expect(st.events[1].label, '转黄');
      expect(st.connected, isTrue);
      expect(st.lookaheadUsed, 12.5);
      expect(st.currentPhase, 'drying');
      expect(st.phaseLookaheadConfig!.development, 2.0);
      expect(st.isRoastActive, isTrue);
      expect(st.stateLabel, '烘焙中');
      expect(st.eventStats['segment_times']!['脱水期'], 95.0);
    });

    test('最小帧（IDLE 大量 null）', () {
      final st = RoasterStatus.fromJson({
        'state': 'IDLE',
        'pv': null,
        'sv': null,
        'ror': 0,
        'elapsed': 0,
        'profile_id': null,
        'profile_name': null,
        'events': <dynamic>[],
        'event_stats': <String, dynamic>{},
        'connected': false,
      });
      expect(st.pv, isNull);
      expect(st.isRoastActive, isFalse);
      expect(st.stateLabel, '待机');
      expect(st.phaseLookaheadConfig, isNull);
    });
  });

  group('RoastProfile / RoastRecord', () {
    test('profile 解析与序列化往返', () {
      final p = RoastProfile.fromJson({
        'id': 'p1',
        'name': '测试曲线',
        'description': '',
        'nodes': [
          {'time': 0, 'temperature': 30},
          {'time': 300, 'temperature': 200},
        ],
        'end_temp': 205,
      });
      expect(p.totalTime, 300);
      final j = p.toJson();
      expect(j['nodes'], hasLength(2));
      expect(j['end_temp'], 205);
    });

    test('record 解析（data 元组 + 快照）', () {
      final r = RoastRecord.fromJson({
        'session_id': 's1',
        'started_at': '2026-08-10T10:00:00',
        'profile_id': 'p1',
        'profile_name': '耶加',
        'events': [
          {'time': 0, 'type': 'charge', 'temperature': 30.0},
          {'time': 400, 'type': 'drop', 'temperature': 210.5},
        ],
        'data': [
          [0, 30.0, 30.0, 0.0],
          [400, 210.5, 212.0, 3.2],
        ],
        'seq_no': 7,
        'display_name': 'log007',
        'profile_snapshot': {
          'id': 'p1',
          'name': '耶加',
          'nodes': [
            {'time': 0, 'temperature': 30},
            {'time': 400, 'temperature': 212},
          ],
          'end_temp': 210,
        },
      });
      expect(r.name, 'log007');
      expect(r.duration, 400);
      expect(r.actualEndTemp, closeTo(210.5, 1e-9));
      expect(r.profileSnapshot!.nodes.length, 2);
    });

    test('RecordSummary 名称回退', () {
      final s = RecordSummary.fromJson({
        'session_id': 'x',
        'started_at': null,
        'profile_name': null,
        'duration_sec': 500,
        'seq_no': 3,
        'display_name': null,
      });
      expect(s.name, 'log003');
    });
  });
}
