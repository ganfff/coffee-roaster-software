/// 主控页 —— 对齐 index.html + app.js：
/// 顶部读数/状态徽标、事件温度条、快捷事件按钮、阶段条、进度条、
/// 双轴图表、烘焙控制（开始/超前预测/偏移微调）、急停、ERROR 全屏阻断。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../models.dart';
import '../spline.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/roast_chart.dart';

class MainPage extends StatefulWidget {
  final RoasterStore store;
  const MainPage({super.key, required this.store});

  @override
  State<MainPage> createState() => _MainPageState();
}

class _MainPageState extends State<MainPage> {
  // 超前预测滑块本地值（用户拖动是唯一可信源，对齐 app.js）
  final Map<String, double> _phaseValues = {
    'drying': 1.0,
    'maillard': 0.5,
    'development': 1.0,
  };
  bool _phaseInitialized = false;
  double _offsetValue = 0;
  final Map<String, Timer?> _phaseTimers = {};
  Timer? _offsetTimer;

  // 时钟
  Timer? _clockTimer;
  String _clockText = '--:--:--';

  RoasterStore get store => widget.store;

  @override
  void initState() {
    super.initState();
    _tickClock();
    _clockTimer =
        Timer.periodic(const Duration(seconds: 1), (_) => _tickClock());
  }

  void _tickClock() {
    final now = DateTime.now();
    final text =
        '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}:${now.second.toString().padLeft(2, '0')}';
    if (text != _clockText && mounted) setState(() => _clockText = text);
  }

  @override
  void dispose() {
    _clockTimer?.cancel();
    for (final t in _phaseTimers.values) {
      t?.cancel();
    }
    _offsetTimer?.cancel();
    super.dispose();
  }

  void _onPhaseChanged(String phase, double v) {
    v = round1(v.clamp(0, 30));
    setState(() => _phaseValues[phase] = v);
    _phaseTimers[phase]?.cancel();
    _phaseTimers[phase] = Timer(const Duration(milliseconds: 100), () {
      store.setPhaseLookahead(phase, v);
    });
  }

  void _onOffsetChanged(double v) {
    v = round1(v.clamp(-3.0, 3.0));
    setState(() => _offsetValue = v);
    _offsetTimer?.cancel();
    _offsetTimer = Timer(const Duration(milliseconds: 100), () {
      store.setLookaheadOffset(v);
    });
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final st = store.status;

        // 首次拿到后端阶段配置时初始化滑块（之后本地为准）
        if (!_phaseInitialized && st.phaseLookaheadConfig != null) {
          _phaseInitialized = true;
          _phaseValues['drying'] = st.phaseLookaheadConfig!.drying;
          _phaseValues['maillard'] = st.phaseLookaheadConfig!.maillard;
          _phaseValues['development'] =
              st.phaseLookaheadConfig!.development;
        }

        return Stack(
          children: [
            SafeArea(
              child: Column(
                children: [
                  _TopBar(store: store, clockText: _clockText),
                  _EventTempsBar(status: st, store: store),
                  _EventActionsBar(store: store),
                  _SegmentBar(status: st),
                  Expanded(
                    child: LayoutBuilder(builder: (context, c) {
                      final chart = _ChartArea(store: store);
                      final controls = _ControlPanel(
                        store: store,
                        phaseValues: _phaseValues,
                        offsetValue: _offsetValue,
                        onPhaseChanged: _onPhaseChanged,
                        onOffsetChanged: _onOffsetChanged,
                      );
                      if (c.maxWidth >= 860) {
                        return Row(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Expanded(child: chart),
                            Container(
                              width: 330,
                              decoration: const BoxDecoration(
                                border: Border(
                                    left: BorderSide(
                                        color: RoastColors.border)),
                              ),
                              child: controls,
                            ),
                          ],
                        );
                      }
                      return Column(children: [
                        Expanded(flex: 5, child: chart),
                        const Divider(height: 1),
                        Expanded(flex: 4, child: controls),
                      ]);
                    }),
                  ),
                  _BottomStatusBar(store: store),
                ],
              ),
            ),
            _EStopButton(store: store),
            if (st.state == 'ERROR') _ErrorOverlay(store: store),
          ],
        );
      },
    );
  }
}

// ============ 顶部状态栏 ============

class _TopBar extends StatelessWidget {
  final RoasterStore store;
  final String clockText;
  const _TopBar({required this.store, required this.clockText});

  @override
  Widget build(BuildContext context) {
    final st = store.status;
    return LayoutBuilder(builder: (context, c) {
      final narrow = c.maxWidth < 640;
      return Container(
        color: RoastColors.surface,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(children: [
          if (!narrow) ...[
            const Text("Ganf's咖啡烘焙机",
                style: TextStyle(
                    color: RoastColors.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
          ],
          _StateBadge(state: st.state, label: st.stateLabel),
          const Spacer(),
          _Readout('温度 (°C)', st.pv?.toStringAsFixed(1) ?? '--',
              RoastColors.pv),
          _Readout(
              '设定温度', st.sv?.toStringAsFixed(1) ?? '--', RoastColors.sv),
          _Readout(
              '升温率 (°C/min)', st.ror.toStringAsFixed(1), RoastColors.ror),
          _DeltaReadout(store: store),
          const SizedBox(width: 10),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(formatTime(st.elapsed),
                style: const TextStyle(
                    color: RoastColors.textPrimary,
                    fontSize: 18,
                    fontWeight: FontWeight.w600)),
            Text(clockText,
                style: const TextStyle(
                    color: RoastColors.textMuted, fontSize: 11)),
          ]),
        ]),
      );
    });
  }
}

/// 目标偏差读数（Artisan 风格 ahead/behind）
class _DeltaReadout extends StatelessWidget {
  final RoasterStore store;
  const _DeltaReadout({required this.store});

  @override
  Widget build(BuildContext context) {
    final d = store.targetDelta;
    String text;
    Color color;
    if (d == null) {
      text = '--';
      color = RoastColors.textMuted;
    } else {
      text = '${d >= 0 ? '+' : ''}${d.toStringAsFixed(1)}°C';
      if (d.abs() <= 2) {
        color = RoastColors.development; // 贴着曲线走：绿
      } else {
        color = d > 0 ? RoastColors.dropOrange : RoastColors.drying;
      }
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(children: [
        Text(text,
            style: TextStyle(
                color: color, fontSize: 20, fontWeight: FontWeight.w700)),
        const Text('目标偏差',
            style:
                TextStyle(color: RoastColors.textMuted, fontSize: 10)),
      ]),
    );
  }
}

class _StateBadge extends StatelessWidget {
  final String state;
  final String label;
  const _StateBadge({required this.state, required this.label});

  @override
  Widget build(BuildContext context) {
    final color = switch (state) {
      'ROASTING' => RoastColors.development,
      'COOLING' => RoastColors.drying,
      'ERROR' => RoastColors.danger,
      _ => RoastColors.textMuted,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Text(label,
          style: TextStyle(
              color: color, fontSize: 11, fontWeight: FontWeight.w600)),
    );
  }
}

class _Readout extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  const _Readout(this.label, this.value, this.color);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(children: [
        Text(value,
            style: TextStyle(
                color: color, fontSize: 20, fontWeight: FontWeight.w700)),
        Text(label,
            style: const TextStyle(
                color: RoastColors.textMuted, fontSize: 10)),
      ]),
    );
  }
}

// ============ 关键事件温度条 ============

class _EventTempsBar extends StatelessWidget {
  final RoasterStatus status;
  final RoasterStore store;
  const _EventTempsBar({required this.status, required this.store});

  @override
  Widget build(BuildContext context) {
    RoastEvent? find(String type) {
      for (final e in status.events) {
        if (e.type == type) return e;
      }
      return null;
    }

    String fmt(RoastEvent? e) => (e != null && e.temperature != null)
        ? '${formatTime(e.time)} @ ${e.temperature!.toStringAsFixed(1)}°C'
        : '--';

    String devInfo = '--';
    final fc = find('first_crack');
    if (fc != null) {
      final delta = (status.pv != null && fc.temperature != null)
          ? '+${(status.pv! - fc.temperature!).toStringAsFixed(1)}°C'
          : '';
      devInfo =
          '$delta · ${formatTime((status.elapsed - fc.time).clamp(0, double.infinity))}';
    }

    Widget item(String label, String value, Color color) => Expanded(
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Text('$label ',
                style: TextStyle(color: color, fontSize: 11)),
            Flexible(
              child: Text(value,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      color: RoastColors.textPrimary, fontSize: 11)),
            ),
          ]),
        );

    final tpText = (store.tpTime != null && store.tpTemp != null)
        ? '${formatTimeShort(store.tpTime!)} @ ${store.tpTemp!.toStringAsFixed(1)}°C'
        : '--';

    return Container(
      color: RoastColors.surface,
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        item('回温点', tpText, const Color(0xFF26A69A)),
        item('转黄', fmt(find('yellowing')), RoastColors.maillard),
        item('一爆', fmt(find('first_crack')), RoastColors.danger),
        item('发展期', devInfo, RoastColors.development),
      ]),
    );
  }
}

// ============ 快捷事件按钮栏 ============

class _EventActionsBar extends StatelessWidget {
  final RoasterStore store;
  const _EventActionsBar({required this.store});

  static const buttons = [
    ('yellowing', '转黄'),
    ('first_crack', '一爆'),
    ('first_crack_end', '一爆结束'),
    ('second_crack', '二爆'),
    ('second_crack_end', '二爆结束'),
    ('drop', '出豆'),
  ];

  @override
  Widget build(BuildContext context) {
    final st = store.status;
    final roasting = st.state == 'ROASTING';

    return Container(
      color: RoastColors.surface,
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
      child: Row(children: [
        for (final (type, label) in buttons)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: _EventButton(
                type: type,
                label: label,
                enabled: roasting,
                event: _findEvent(st.events, type),
                isDrop: type == 'drop',
                onTap: () => store.logEvent(type),
              ),
            ),
          ),
      ]),
    );
  }

  RoastEvent? _findEvent(List<RoastEvent> events, String type) {
    for (final e in events) {
      if (e.type == type) return e;
    }
    return null;
  }
}

class _EventButton extends StatelessWidget {
  final String type;
  final String label;
  final bool enabled;
  final RoastEvent? event;
  final bool isDrop;
  final VoidCallback onTap;

  const _EventButton({
    required this.type,
    required this.label,
    required this.enabled,
    required this.event,
    required this.isDrop,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final active = event != null;
    final baseColor = isDrop ? RoastColors.dropOrange : RoastColors.cardHover;
    final bg = active
        ? RoastColors.development.withValues(alpha: 0.25)
        : baseColor.withValues(alpha: enabled ? 1 : 0.4);

    String? badge;
    if (active) {
      final e = event!;
      final tempStr = e.temperature != null
          ? '${e.temperature!.toStringAsFixed(0)}°'
          : '--°';
      badge = '${formatTimeShort(e.time)} · $tempStr';
    }

    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: (enabled && !active) ? onTap : null,
        child: Container(
          constraints: const BoxConstraints(minHeight: 44),
          padding: const EdgeInsets.symmetric(vertical: 4),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
                color: active
                    ? RoastColors.development
                    : RoastColors.border),
          ),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            Text(
              active ? '$label ✓' : label,
              style: TextStyle(
                color: enabled || active
                    ? RoastColors.textPrimary
                    : RoastColors.textMuted,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (badge != null)
              Text(badge,
                  style: const TextStyle(
                      color: RoastColors.textSecondary, fontSize: 9)),
          ]),
        ),
      ),
    );
  }
}

// ============ 阶段颜色条 ============

class _SegmentBar extends StatelessWidget {
  final RoasterStatus status;
  const _SegmentBar({required this.status});

  @override
  Widget build(BuildContext context) {
    final times =
        (status.eventStats['segment_times'] as Map?)?.cast<String, dynamic>() ??
            {};
    final ratios =
        (status.eventStats['segment_ratios'] as Map?)?.cast<String, dynamic>() ??
            {};

    Widget seg(String key, String label, Color color) {
      final t = (times[key] as num?)?.toDouble();
      final r = (ratios[key] as num?)?.toDouble();
      if (t == null || r == null) return const SizedBox.shrink();
      return Expanded(
        flex: t.round().clamp(1, 100000),
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 1),
          padding: const EdgeInsets.symmetric(vertical: 3),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.22),
            borderRadius: BorderRadius.circular(4),
          ),
          child: Text(
            '$label ${formatTime(t)} (${r.toStringAsFixed(0)}%)',
            textAlign: TextAlign.center,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: color, fontSize: 10),
          ),
        ),
      );
    }

    final children = [
      seg('脱水期', '脱水期', RoastColors.drying),
      seg('梅纳期', '梅纳期', RoastColors.maillard),
      seg('发展期', '发展期', RoastColors.development),
    ];
    if (children.every((c) => c is SizedBox)) return const SizedBox.shrink();
    return Container(
      color: RoastColors.surface,
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
      child: Row(children: children),
    );
  }
}

// ============ 图表区（标题+进度条+图例+图表）============

class _ChartArea extends StatelessWidget {
  final RoasterStore store;
  const _ChartArea({required this.store});

  /// 预测线两端点：最新 PV 点 → 60 秒后（按平滑 ROR 外推）
  static List<ChartPoint> _projectionPoints(
      RoasterStore store, RoasterStatus st) {
    final lastPv = store.pvSeries.last;
    final r = store.rorSeries.isNotEmpty ? store.rorSeries.last.y : st.ror;
    final projEnd = (lastPv.y + r).clamp(0.0, 300.0);
    return [lastPv, ChartPoint(lastPv.x + 60, projEnd)];
  }

  @override
  Widget build(BuildContext context) {
    final st = store.status;

    final List<ChartSeriesSpec> series;
    final List<EventAnnotation> annotations;
    String profileLabel = store.profileSeriesName;

    if (store.compareMode) {
      series = [
        ChartSeriesSpec(
            label: '记录A', points: store.compareASeries, color: RoastColors.compareA, width: 2),
        ChartSeriesSpec(
            label: '记录B', points: store.compareBSeries, color: RoastColors.compareB, width: 2),
      ];
      annotations = const [];
    } else {
      final vis = store.legendVisible;
      series = [
        ChartSeriesSpec(
            label: '温度',
            points: store.pvSeries,
            color: RoastColors.pv,
            width: 2.5,
            visible: vis['pv'] ?? true),
        ChartSeriesSpec(
            label: '设定温度',
            points: store.svSeries,
            color: RoastColors.sv,
            dashed: true,
            visible: vis['sv'] ?? true),
        ChartSeriesSpec(
            label: profileLabel,
            points: store.profileSeries,
            color: RoastColors.profile,
            dashed: true,
            visible: vis['profile'] ?? true),
        ChartSeriesSpec(
            label: 'ROR',
            points: store.rorSeries,
            color: RoastColors.ror,
            filled: true,
            fillColor: RoastColors.ror.withValues(alpha: 0.12),
            axis: 1,
            visible: vis['ror'] ?? true),
        ChartSeriesSpec(
            label: 'ROR 预览',
            points: store.profileRorSeries,
            color: RoastColors.rorPreview,
            dashed: true,
            width: 1.5,
            axis: 1,
            visible: vis['rorPreview'] ?? true),
        // Artisan 风格：按当前 ROR 线性外推 60 秒的温度预测线
        if (st.state == 'ROASTING' && store.pvSeries.isNotEmpty)
          ChartSeriesSpec(
            label: '预测',
            points: _projectionPoints(store, st),
            color: RoastColors.pv.withValues(alpha: 0.45),
            dashed: true,
            width: 1.5,
            visible: vis['projection'] ?? true,
          ),
      ];
      annotations = [
        for (final e in st.events)
          EventAnnotation(e.time, e.label,
              RoastColors.event[e.type] ?? RoastColors.maillard),
        if (store.tpTime != null)
          EventAnnotation(
              store.tpTime!, '回温点', const Color(0xFF26A69A)),
      ];
    }

    final profile = store.displayProfile;
    final suggestedXMax =
        (profile != null && profile.totalTime > 0) ? profile.totalTime : 600.0;

    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
        child: Row(children: [
          Text(store.compareMode ? '记录对比' : '实时温度曲线',
              style: const TextStyle(
                  color: RoastColors.textSecondary, fontSize: 13)),
          const SizedBox(width: 16),
          Expanded(child: _ProgressBar(store: store)),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: store.compareMode
            ? const ChartLegend(items: [
                (key: 'a', label: '记录A', color: RoastColors.compareA, visible: true),
                (key: 'b', label: '记录B', color: RoastColors.compareB, visible: true),
              ])
            : ChartLegend(
                items: [
                  (key: 'pv', label: '温度', color: RoastColors.pv, visible: store.legendVisible['pv'] ?? true),
                  (key: 'sv', label: '设定温度', color: RoastColors.sv, visible: store.legendVisible['sv'] ?? true),
                  (key: 'profile', label: profileLabel, color: RoastColors.profile, visible: store.legendVisible['profile'] ?? true),
                  (key: 'ror', label: 'ROR', color: RoastColors.ror, visible: store.legendVisible['ror'] ?? true),
                  (key: 'rorPreview', label: 'ROR 预览', color: RoastColors.rorPreview, visible: store.legendVisible['rorPreview'] ?? true),
                  (key: 'projection', label: '预测', color: RoastColors.pv, visible: store.legendVisible['projection'] ?? true),
                ],
                onToggle: store.toggleLegend,
              ),
      ),
      Expanded(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 4),
          child: RoastChart(
            series: series,
            annotations: annotations,
            suggestedXMax: suggestedXMax,
          ),
        ),
      ),
    ]);
  }
}

// ============ 烘焙进度条（三段拼接 + 指示器）============

class _ProgressBar extends StatelessWidget {
  final RoasterStore store;
  const _ProgressBar({required this.store});

  @override
  Widget build(BuildContext context) {
    final st = store.status;
    final profile = store.displayProfile;
    final total = profile?.totalTime ?? 0;

    const phaseLabels = {
      'drying': '脱水期',
      'maillard': '梅纳期',
      'development': '发展期',
      'cooling': '冷却中',
      'idle': '待机',
    };
    const phaseAlias = {
      'drying': 'drying', '脱水期': 'drying', '脱水': 'drying',
      'maillard': 'maillard', '梅纳期': 'maillard', '美拉德': 'maillard', '梅纳': 'maillard',
      'development': 'development', '发展期': 'development', '发展': 'development',
    };

    if (st.state != 'ROASTING' || total <= 0) {
      final key = st.state == 'COOLING' ? 'cooling' : 'idle';
      return Row(children: [
        Text(phaseLabels[key]!,
            style: const TextStyle(
                color: RoastColors.textMuted, fontSize: 11)),
        const SizedBox(width: 8),
        Expanded(
          child: Container(
            height: 6,
            decoration: BoxDecoration(
                color: RoastColors.border,
                borderRadius: BorderRadius.circular(3)),
          ),
        ),
        const SizedBox(width: 8),
        Text(st.elapsed > 0 ? formatTime(st.elapsed) : '--:--',
            style: const TextStyle(
                color: RoastColors.textMuted, fontSize: 11)),
      ]);
    }

    final events = st.events;
    RoastEvent? find(String t) {
      for (final e in events) {
        if (e.type == t) return e;
      }
      return null;
    }

    final dryingEnd =
        (find('yellowing')?.time ?? total / 3).clamp(0, total);
    final maillardEnd =
        (find('first_crack')?.time ?? total * 2 / 3).clamp(dryingEnd + 0.1, total);
    final elapsed = st.elapsed.clamp(0, double.infinity);

    var phaseKey = phaseAlias[st.currentPhase ?? ''] ?? '';
    if (phaseKey.isEmpty) {
      phaseKey = elapsed < dryingEnd
          ? 'drying'
          : elapsed < maillardEnd
              ? 'maillard'
              : 'development';
    }
    final ratio = (elapsed / total).clamp(0.0, 1.0);

    final widths = [
      dryingEnd,
      maillardEnd - dryingEnd,
      (total - maillardEnd).clamp(0, double.infinity),
    ];
    const colors = [
      RoastColors.drying,
      RoastColors.maillard,
      RoastColors.danger,
    ];

    return Row(children: [
      Text(phaseLabels[phaseKey] ?? phaseKey,
          style: const TextStyle(
              color: RoastColors.textSecondary, fontSize: 11)),
      const SizedBox(width: 8),
      Expanded(
        child: LayoutBuilder(builder: (context, c) {
          return Stack(children: [
            Row(children: [
              for (int i = 0; i < 3; i++)
                Expanded(
                  flex: (widths[i] * 100).round().clamp(1, 100000000),
                  child: Container(
                    height: 6,
                    margin: const EdgeInsets.symmetric(horizontal: 0.5),
                    decoration: BoxDecoration(
                      color: colors[i].withValues(alpha: 0.5),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
            ]),
            Positioned(
              left: (ratio * c.maxWidth - 4).clamp(0.0, c.maxWidth - 8),
              top: -2,
              child: Container(
                width: 8,
                height: 10,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ]);
        }),
      ),
      const SizedBox(width: 8),
      Text('${formatTime(elapsed)} / ${formatTime(total)}',
          style: const TextStyle(
              color: RoastColors.textSecondary, fontSize: 11)),
    ]);
  }
}

// ============ 右侧控制面板 ============

class _ControlPanel extends StatelessWidget {
  final RoasterStore store;
  final Map<String, double> phaseValues;
  final double offsetValue;
  final void Function(String phase, double v) onPhaseChanged;
  final void Function(double v) onOffsetChanged;

  const _ControlPanel({
    required this.store,
    required this.phaseValues,
    required this.offsetValue,
    required this.onPhaseChanged,
    required this.onOffsetChanged,
  });

  @override
  Widget build(BuildContext context) {
    final st = store.status;
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        // 当前曲线
        Row(children: [
          const Text('当前曲线 ',
              style: TextStyle(color: RoastColors.textMuted, fontSize: 12)),
          Expanded(
            child: Text(store.currentProfileDisplayName,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    color: RoastColors.textPrimary,
                    fontSize: 13,
                    fontWeight: FontWeight.w600)),
          ),
        ]),
        const SizedBox(height: 12),

        // 开始按钮 / 冷却提示
        if (st.state == 'IDLE')
          SizedBox(
            height: 48,
            child: FilledButton(
              style: FilledButton.styleFrom(
                  backgroundColor: RoastColors.accent),
              onPressed: store.startRoast,
              child: const Text('开始烘焙',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            ),
          )
        else if (st.state == 'COOLING')
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: RoastColors.drying.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Text('烘焙已结束，正在等待保存确认...',
                textAlign: TextAlign.center,
                style: TextStyle(color: RoastColors.drying, fontSize: 12)),
          ),
        const SizedBox(height: 16),

        // 预计到达结束温度（Artisan 风格 ETA）
        if (store.etaToEndTempSec != null && store.etaToEndTempSec! > 0) ...[
          Row(children: [
            const Icon(Icons.timer_outlined,
                size: 14, color: RoastColors.textMuted),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                '预计 ${formatTimeShort(store.etaToEndTempSec!)} 后到达结束温度'
                ' ${store.displayProfile?.endTemp.toStringAsFixed(0) ?? '--'}°C',
                style: const TextStyle(
                    color: RoastColors.textSecondary, fontSize: 12),
              ),
            ),
          ]),
          const SizedBox(height: 12),
        ],

        // 超前预测阶段设置
        const Text('超前预测阶段设置',
            style: TextStyle(
                color: RoastColors.textPrimary,
                fontSize: 13,
                fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        const Text('读取未来 N 秒的目标温度作为当前 SV，补偿加热系统热滞后。',
            style: TextStyle(color: RoastColors.textMuted, fontSize: 10)),
        for (final (phase, label) in [
          ('drying', '脱水期'),
          ('maillard', '梅纳期'),
          ('development', '发展期'),
        ])
          _PhaseSliderRow(
            label: label,
            value: phaseValues[phase] ?? 0,
            onChanged: (v) => onPhaseChanged(phase, v),
          ),
        const SizedBox(height: 8),
        Row(children: [
          const Text('实际超前量 ',
              style: TextStyle(color: RoastColors.textMuted, fontSize: 11)),
          Text(
            st.lookaheadUsed != null
                ? '${st.lookaheadUsed!.toStringAsFixed(1)} 秒'
                : '--',
            style: const TextStyle(
                color: RoastColors.accent,
                fontSize: 12,
                fontWeight: FontWeight.w600),
          ),
        ]),
        const SizedBox(height: 16),

        // 偏移微调
        Row(children: [
          const Text('偏移微调',
              style: TextStyle(
                  color: RoastColors.textPrimary,
                  fontSize: 13,
                  fontWeight: FontWeight.w600)),
          const Spacer(),
          Text(
            '${offsetValue > 0 ? '+' : offsetValue < 0 ? '−' : '±'}${offsetValue.abs().toStringAsFixed(1)} s',
            style: const TextStyle(
                color: RoastColors.accent,
                fontSize: 13,
                fontWeight: FontWeight.w700)),
        ]),
        Slider(
          value: offsetValue,
          min: -3,
          max: 3,
          divisions: 60,
          onChanged: onOffsetChanged,
        ),
        const Center(
          child: Text('运行时微调，重启归零',
              style: TextStyle(color: RoastColors.textMuted, fontSize: 10)),
        ),
      ],
    );
  }
}

class _PhaseSliderRow extends StatelessWidget {
  final String label;
  final double value;
  final ValueChanged<double> onChanged;
  const _PhaseSliderRow(
      {required this.label, required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Row(children: [
      SizedBox(
          width: 52,
          child: Text(label,
              style: const TextStyle(
                  color: RoastColors.textSecondary, fontSize: 12))),
      Expanded(
        child: Slider(
          value: value.clamp(0.0, 30.0),
          min: 0,
          max: 30,
          divisions: 300,
          onChanged: onChanged,
        ),
      ),
      SizedBox(
        width: 48,
        child: Text('${value.toStringAsFixed(1)}秒',
            style: const TextStyle(
                color: RoastColors.textPrimary, fontSize: 12)),
      ),
    ]);
  }
}

// ============ 底部连接状态栏 ============

class _BottomStatusBar extends StatelessWidget {
  final RoasterStore store;
  const _BottomStatusBar({required this.store});

  @override
  Widget build(BuildContext context) {
    Widget dot(bool online, String label) => Row(children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: online ? RoastColors.development : RoastColors.danger,
            ),
          ),
          const SizedBox(width: 4),
          Text(label,
              style: const TextStyle(
                  color: RoastColors.textMuted, fontSize: 10)),
        ]);
    return Container(
      color: RoastColors.surface,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      child: Row(children: [
        dot(store.wsConnected, 'WS'),
        const SizedBox(width: 10),
        _BackendQuickSwitch(store: store),
        const Spacer(),
        dot(store.status.connected, 'TC4S'),
      ]),
    );
  }
}

/// 后端快速切换：点击弹出预设/历史菜单 + 手动输入
class _BackendQuickSwitch extends StatelessWidget {
  final RoasterStore store;
  const _BackendQuickSwitch({required this.store});

  String get _display {
    final u = store.api.baseUrl;
    return u.replaceFirst(RegExp(r'^https?://'), '');
  }

  PopupMenuItem<String> _presetItem(String value, String title,
      String subtitle, String url, IconData icon) {
    final current = store.api.baseUrl == url;
    return PopupMenuItem<String>(
      value: value,
      height: 44,
      child: Row(children: [
        Icon(icon,
            size: 16,
            color: current ? RoastColors.accent : RoastColors.textMuted),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(title,
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: current
                            ? RoastColors.accent
                            : RoastColors.textPrimary)),
                Text(subtitle,
                    style: const TextStyle(
                        fontSize: 9, color: RoastColors.textMuted)),
              ]),
        ),
        if (current)
          const Icon(Icons.check, size: 14, color: RoastColors.accent),
      ]),
    );
  }

  Future<void> _customInput(BuildContext context) async {
    final ctrl = TextEditingController(text: store.api.baseUrl);
    final url = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: RoastColors.card,
        title: const Text('切换后端地址', style: TextStyle(fontSize: 15)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          keyboardType: TextInputType.url,
          style: const TextStyle(color: RoastColors.textPrimary),
          decoration: const InputDecoration(
            hintText: 'http://192.168.1.50:8000',
            hintStyle: TextStyle(color: RoastColors.textMuted),
          ),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: const Text('切换')),
        ],
      ),
    );
    if (url != null && url.isNotEmpty) {
      await store.switchBackend(url);
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: '切换后端地址',
      color: RoastColors.card,
      offset: const Offset(0, -8),
      onSelected: (v) {
        if (v == '__custom__') {
          _customInput(context);
        } else if (v == '__sim__') {
          store.switchBackend(RoasterStore.simulatorUrl);
        } else if (v == '__real__') {
          store.switchBackend(store.realPresetUrl);
        } else {
          store.switchBackend(v);
        }
      },
      itemBuilder: (context) => [
        // 两个一键预设
        _presetItem('__sim__', '模拟器', '本机模拟后端 · 无需硬件',
            RoasterStore.simulatorUrl, Icons.computer),
        _presetItem('__real__', '实机', '树莓派 · 真实温控器',
            store.realPresetUrl, Icons.precision_manufacturing),
        if (store.backendHistory.isNotEmpty) const PopupMenuDivider(),
        // 历史记录
        for (final url in store.backendHistory)
          PopupMenuItem<String>(
            value: url,
            height: 36,
            child: Row(children: [
              Icon(
                url == store.api.baseUrl
                    ? Icons.radio_button_checked
                    : Icons.radio_button_off,
                size: 14,
                color: url == store.api.baseUrl
                    ? RoastColors.accent
                    : RoastColors.textMuted,
              ),
              const SizedBox(width: 8),
              Text(url, style: const TextStyle(fontSize: 12)),
            ]),
          ),
        const PopupMenuDivider(),
        const PopupMenuItem<String>(
          value: '__custom__',
          height: 36,
          child: Row(children: [
            Icon(Icons.edit, size: 14, color: RoastColors.textMuted),
            SizedBox(width: 8),
            Text('手动输入…', style: TextStyle(fontSize: 12)),
          ]),
        ),
      ],
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: RoastColors.card,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.dns_outlined,
              size: 11, color: RoastColors.textMuted),
          const SizedBox(width: 4),
          Text(_display,
              style: const TextStyle(
                  color: RoastColors.textSecondary, fontSize: 10)),
          const Icon(Icons.arrow_drop_down,
              size: 12, color: RoastColors.textMuted),
        ]),
      ),
    );
  }
}

// ============ 急停按钮（双击确认）============

class _EStopButton extends StatefulWidget {
  final RoasterStore store;
  const _EStopButton({required this.store});

  @override
  State<_EStopButton> createState() => _EStopButtonState();
}

class _EStopButtonState extends State<_EStopButton> {
  bool _confirming = false;
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _tap() {
    if (_confirming) {
      _timer?.cancel();
      setState(() => _confirming = false);
      widget.store.emergencyStop();
    } else {
      setState(() => _confirming = true);
      _timer?.cancel();
      _timer = Timer(const Duration(seconds: 2), () {
        if (mounted) setState(() => _confirming = false);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.store;
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final idle = store.status.state == 'IDLE';
        return Positioned(
          right: 12,
          bottom: 36,
          child: Opacity(
            opacity: idle ? 0.35 : 1,
            child: Material(
              color: _confirming
                  ? RoastColors.danger
                  : RoastColors.danger.withValues(alpha: 0.75),
              borderRadius: BorderRadius.circular(8),
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: idle ? null : _tap,
                child: Container(
                  width: 76,
                  height: 52,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.white24),
                  ),
                  child: Text(
                    _confirming ? '再次确认' : 'E-STOP',
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

// ============ ERROR 全屏阻断 ============

class _ErrorOverlay extends StatelessWidget {
  final RoasterStore store;
  const _ErrorOverlay({required this.store});

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: Container(
        color: RoastColors.danger.withValues(alpha: 0.96),
        child: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.error_outline, color: Colors.white, size: 56),
            const SizedBox(height: 12),
            const Text('系统错误',
                style: TextStyle(
                    color: Colors.white,
                    fontSize: 24,
                    fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(store.status.errorReason ?? '未知错误',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white70, fontSize: 14)),
            ),
            const SizedBox(height: 24),
            FilledButton(
              style: FilledButton.styleFrom(
                  backgroundColor: Colors.white,
                  foregroundColor: RoastColors.danger),
              onPressed: store.emergencyStop,
              child: const Text('复位',
                  style: TextStyle(fontWeight: FontWeight.w700)),
            ),
          ]),
        ),
      ),
    );
  }
}
