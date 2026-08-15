/// 烘焙记录页 —— 列表（复选对比）/ 详情（统计 + 事件 + 双轴图表含背景曲线）/ 对比图
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../models.dart';
import '../spline.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/roast_chart.dart';

class RecordsPage extends StatefulWidget {
  final RoasterStore store;
  const RecordsPage({super.key, required this.store});

  @override
  State<RecordsPage> createState() => _RecordsPageState();
}

class _RecordsPageState extends State<RecordsPage> {
  List<RecordSummary>? _records;
  final Set<String> _selected = {};
  String? _detailId;
  bool _loading = false;

  RoasterStore get store => widget.store;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final list = await store.api.listRecords();
      if (mounted) setState(() => _records = list);
    } catch (_) {
      if (mounted) setState(() => _records = []);
      _toast('加载记录失败');
    }
    if (mounted) setState(() => _loading = false);
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _startCompare() async {
    if (_selected.length < 2) return;
    final sids = _selected.toList();
    await store.enterCompare(sids[0], sids[1]);
    if (!mounted) return;
    if (store.compareMode) {
      // 跳到主图表查看对比（对齐网页版在主图表叠加）
      await showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: RoastColors.card,
          title: const Text('对比模式已开启'),
          content: const Text('两条记录已叠加到「烘焙」页主图表（记录A 橙色 / 记录B 紫色）。'),
          actions: [
            TextButton(
              onPressed: () {
                store.exitCompareMode();
                Navigator.pop(ctx);
              },
              child: const Text('取消对比'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('去查看'),
            ),
          ],
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: _detailId != null
          ? _RecordDetailView(
              store: store,
              sessionId: _detailId!,
              onBack: () => setState(() => _detailId = null),
              onToast: _toast,
            )
          : Column(children: [
              Padding(
                padding: const EdgeInsets.all(10),
                child: Row(children: [
                  const Text('烘焙记录',
                      style: TextStyle(
                          color: RoastColors.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.w700)),
                  const Spacer(),
                  if (_selected.length >= 2)
                    FilledButton.icon(
                      onPressed: _startCompare,
                      icon: const Icon(Icons.compare_arrows, size: 18),
                      label: const Text('对比选中'),
                    ),
                  const SizedBox(width: 8),
                  IconButton(
                      onPressed: _loading ? null : _load,
                      icon: const Icon(Icons.refresh),
                      tooltip: '刷新'),
                ]),
              ),
              Expanded(child: _buildList()),
            ]),
    );
  }

  Widget _buildList() {
    final records = _records;
    if (records == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (records.isEmpty) {
      return const Center(
          child: Text('暂无记录', style: TextStyle(color: RoastColors.textMuted)));
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      itemCount: records.length,
      itemBuilder: (context, i) {
        final r = records[i];
        final started = r.startedAt != null
            ? _formatDate(r.startedAt!)
            : '--';
        return Card(
          margin: const EdgeInsets.only(bottom: 6),
          child: ListTile(
            leading: Checkbox(
              value: _selected.contains(r.sessionId),
              onChanged: (v) {
                setState(() {
                  if (v == true) {
                    if (_selected.length >= 2) {
                      _toast('最多选择2条记录进行对比');
                      return;
                    }
                    _selected.add(r.sessionId);
                  } else {
                    _selected.remove(r.sessionId);
                  }
                });
              },
            ),
            title: Text(r.name,
                style: const TextStyle(
                    color: RoastColors.textPrimary,
                    fontWeight: FontWeight.w600)),
            subtitle: Text(
              '$started · ${formatTime(r.durationSec)} · ${r.profileName ?? '未命名'}',
              style: const TextStyle(
                  color: RoastColors.textMuted, fontSize: 11),
            ),
            onTap: () => setState(() => _detailId = r.sessionId),
          ),
        );
      },
    );
  }

  String _formatDate(String iso) {
    try {
      final d = DateTime.parse(iso).toLocal();
      return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')} '
          '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return iso;
    }
  }
}

/// 记录详情视图
class _RecordDetailView extends StatefulWidget {
  final RoasterStore store;
  final String sessionId;
  final VoidCallback onBack;
  final void Function(String) onToast;

  const _RecordDetailView({
    required this.store,
    required this.sessionId,
    required this.onBack,
    required this.onToast,
  });

  @override
  State<_RecordDetailView> createState() => _RecordDetailViewState();
}

class _RecordDetailViewState extends State<_RecordDetailView> {
  RoastRecord? _record;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await widget.store.api.getRecord(widget.sessionId);
    if (!mounted) return;
    if (r == null) {
      widget.onToast('加载记录详情失败');
      widget.onBack();
      return;
    }
    setState(() => _record = r);
  }

  Future<void> _exportFile(String kind) async {
    try {
      final store = widget.store;
      final isCsv = kind == 'csv';
      final content = isCsv
          ? await store.api.exportRecordCsv(widget.sessionId)
          : await store.api.exportRecordJson(widget.sessionId);
      final name = _record?.name ?? widget.sessionId;
      final path = await FilePicker.platform.saveFile(
        dialogTitle: '导出记录',
        fileName: '$name.$kind',
        bytes: Uint8List.fromList(utf8.encode(content)),
      );
      if (path != null) widget.onToast('已导出');
    } catch (_) {
      widget.onToast('导出失败');
    }
  }

  @override
  Widget build(BuildContext context) {
    final record = _record;
    if (record == null) {
      return const Center(child: CircularProgressIndicator());
    }

    final events = record.events;
    RoastEvent? find(String t) {
      for (final e in events) {
        if (e.type == t) return e;
      }
      return null;
    }

    // 统计信息（对齐网页版 detail-stats）
    final stats = <String>['总时长: ${formatTime(record.duration)}'];
    // 回温点：入豆后前 120 秒内 PV 最低点（Artisan TP）
    if (record.data.isNotEmpty) {
      double? minPv;
      double? minT;
      for (final d in record.data) {
        if (d.isNotEmpty && d[0] <= 120) {
          if (minPv == null || d[1] < minPv) {
            minPv = d[1];
            minT = d[0];
          }
        }
      }
      if (minPv != null && minT != null) {
        stats.add(
            '回温点: ${formatTime(minT)} @ ${minPv.toStringAsFixed(1)}°C');
      }
    }
    final charge = find('charge');
    final firstCrack = find('first_crack');
    final drop = find('drop');
    final yellowing = find('yellowing');
    if (firstCrack != null && charge != null) {
      final dtr = drop != null
          ? (drop.time - firstCrack.time) / (drop.time - charge.time) * 100
          : (record.duration - firstCrack.time) /
              (record.duration - charge.time) *
              100;
      stats.add('DTR: ${dtr.toStringAsFixed(1)}%');
    }
    if (yellowing != null && charge != null) {
      stats.add('脱水期: ${formatTime(yellowing.time - charge.time)}');
    }
    if (firstCrack != null && yellowing != null) {
      stats.add('梅纳期: ${formatTime(firstCrack.time - yellowing.time)}');
    }
    if (firstCrack != null) {
      final devEnd = drop?.time ?? record.duration;
      stats.add('发展期: ${formatTime(devEnd - firstCrack.time)}');
    }
    final endTemp = record.actualEndTemp;
    stats.add(
        '终温: ${endTemp != null ? endTemp.toStringAsFixed(1) : '--'}°C');
    final snap = record.profileSnapshot;
    if (snap != null && snap.nodes.isNotEmpty) {
      stats.add('节点数: ${snap.nodes.length}');
    }

    // 图表数据
    final pvData =
        record.data.map((d) => ChartPoint(d[0], d[1])).toList();
    final svData =
        record.data.map((d) => ChartPoint(d[0], d[2])).toList();
    final rorData =
        record.data.map((d) => ChartPoint(d[0], d[3])).toList();
    final bgData = (snap != null && snap.nodes.length >= 2)
        ? splineInterpolate(snap.nodes, 5)
        : <ChartPoint>[];

    final series = [
      ChartSeriesSpec(label: '温度', points: pvData, color: RoastColors.pv),
      ChartSeriesSpec(
          label: '设定温度',
          points: svData,
          color: RoastColors.sv,
          dashed: true,
          width: 1.5),
      ChartSeriesSpec(
          label: 'ROR',
          points: rorData,
          color: RoastColors.ror,
          filled: true,
          fillColor: RoastColors.ror.withValues(alpha: 0.08),
          width: 1.5,
          axis: 1),
      if (bgData.isNotEmpty)
        ChartSeriesSpec(
            label: '背景曲线',
            points: bgData,
            color: RoastColors.axisLabel,
            dashed: true,
            width: 1.5),
    ];
    final annotations = [
      for (final e in events)
        EventAnnotation(e.time, e.label,
            RoastColors.event[e.type] ?? RoastColors.maillard),
    ];

    final title = record.displayName ?? record.name;

    return Column(children: [
      Padding(
        padding: const EdgeInsets.all(10),
        child: Row(children: [
          IconButton(
              onPressed: widget.onBack,
              icon: const Icon(Icons.arrow_back),
              tooltip: '返回列表'),
          Expanded(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(
                          color: RoastColors.textPrimary,
                          fontSize: 15,
                          fontWeight: FontWeight.w700)),
                  Text(record.profileName ?? record.profileId ?? '未命名',
                      style: const TextStyle(
                          color: RoastColors.textMuted, fontSize: 11)),
                ]),
          ),
          OutlinedButton(
              onPressed: () => _exportFile('csv'),
              child: const Text('CSV')),
          const SizedBox(width: 6),
          OutlinedButton(
              onPressed: () => _exportFile('json'),
              child: const Text('JSON')),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10),
        child: Wrap(
          spacing: 12,
          runSpacing: 4,
          children: [
            for (final s in stats)
              Text(s,
                  style: const TextStyle(
                      color: RoastColors.textSecondary, fontSize: 11)),
          ],
        ),
      ),
      const SizedBox(height: 6),
      Expanded(
        flex: 3,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6),
          child: RoastChart(
            series: series,
            annotations: annotations,
            suggestedXMax: record.duration > 0 ? record.duration : 600,
          ),
        ),
      ),
      // 事件列表
      Expanded(
        flex: 2,
        child: ListView(
          padding: const EdgeInsets.all(10),
          children: [
            for (final e in events)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: RoastColors.event[e.type] ??
                          RoastColors.textSecondary,
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                      width: 48,
                      child: Text(formatTime(e.time),
                          style: const TextStyle(
                              color: RoastColors.textMuted, fontSize: 12))),
                  Text(
                    e.label +
                        (e.temperature != null
                            ? ' @ ${e.temperature!.toStringAsFixed(1)}°C'
                            : ''),
                    style: const TextStyle(
                        color: RoastColors.textPrimary, fontSize: 12),
                  ),
                ]),
              ),
          ],
        ),
      ),
    ]);
  }
}
