/// 状态仓库测试 —— 对齐 app.js 的图表数据行为（同秒覆盖/EWMA/状态切换清空）
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:roaster_app/api.dart';
import 'package:roaster_app/models.dart';
import 'package:roaster_app/socket.dart';
import 'package:roaster_app/state.dart';

RoasterStore _makeStore() => RoasterStore(
      api: RoasterApi('http://localhost:8000'),
      socket: RoasterSocket('http://localhost:8000'),
    );

RoasterStatus _status({
  String state = 'ROASTING',
  double? pv,
  double? sv,
  double ror = 0,
  double elapsed = 0,
  String? sessionId,
}) =>
    RoasterStatus(
      state: state,
      pv: pv,
      sv: sv,
      ror: ror,
      elapsed: elapsed,
      sessionId: sessionId,
      connected: true,
    );

void main() {
  test('ROASTING 中追加实时点；同秒覆盖最新值', () {
    final store = _makeStore();
    store.handleStatus(_status(pv: 100, sv: 100, ror: 10, elapsed: 5));
    store.handleStatus(_status(pv: 101, sv: 100, ror: 10, elapsed: 5)); // 同秒
    store.handleStatus(_status(pv: 102, sv: 101, ror: 12, elapsed: 6));

    expect(store.pvSeries.length, 2);
    expect(store.pvSeries.last.y, 102);
    expect(store.pvSeries.first.y, 101); // 同秒被覆盖
  });

  test('进入 ROASTING / IDLE 时清空实时曲线与 EWMA', () {
    final store = _makeStore();
    store.handleStatus(_status(pv: 100, sv: 100, ror: 10, elapsed: 5));
    store.handleStatus(_status(pv: 101, sv: 100, ror: 10, elapsed: 6));
    expect(store.pvSeries, isNotEmpty);

    store.handleStatus(_status(state: 'COOLING', pv: 200, sv: 0, elapsed: 7));
    expect(store.pvSeries, isNotEmpty); // COOLING 定格不清空

    store.handleStatus(_status(state: 'IDLE', pv: 50, sv: 0, elapsed: 0));
    expect(store.pvSeries, isEmpty);
    expect(store.rorSeries, isEmpty);
  });

  test('COOLING 不追加 ROR', () {
    final store = _makeStore();
    store.handleStatus(_status(pv: 100, sv: 100, ror: 10, elapsed: 5));
    final rorCount = store.rorSeries.length;
    store.handleStatus(_status(state: 'COOLING', pv: 180, sv: 0, ror: 99, elapsed: 6));
    store.handleStatus(_status(state: 'COOLING', pv: 175, sv: 0, ror: 99, elapsed: 7));
    expect(store.rorSeries.length, rorCount); // 未追加
    expect(store.pvSeries.last.y, 175); // PV 仍定格追加
  });

  test('COOLING 保存确认同一 session 只触发一次', () async {
    final store = _makeStore();
    final sessions = <String>[];
    final sub = store.saveConfirmRequests.listen(sessions.add);

    store.handleStatus(_status(state: 'COOLING', elapsed: 10, sessionId: 's1'));
    store.handleStatus(_status(state: 'COOLING', elapsed: 11, sessionId: 's1'));
    store.handleStatus(_status(state: 'COOLING', elapsed: 12, sessionId: 's1'));

    await Future.delayed(const Duration(milliseconds: 700));
    expect(sessions, ['s1']);
    await sub.cancel();
  });

  test('乐观复位清空实时数据并回到待机', () {
    final store = _makeStore();
    store.handleStatus(_status(pv: 100, sv: 100, ror: 10, elapsed: 5));
    store.optimisticResetToIdle();
    expect(store.status.state, 'IDLE');
    expect(store.pvSeries, isEmpty);
  });
}
