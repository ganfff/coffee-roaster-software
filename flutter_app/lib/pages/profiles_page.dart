/// 曲线管理页 —— 卡片网格库（sparkline 缩略图、应用/导出/删除、导入）
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../models.dart';
import '../spline.dart';
import '../state.dart';
import '../theme.dart';
import 'editor_page.dart';

class ProfilesPage extends StatefulWidget {
  final RoasterStore store;
  const ProfilesPage({super.key, required this.store});

  @override
  State<ProfilesPage> createState() => _ProfilesPageState();
}

class _ProfilesPageState extends State<ProfilesPage> {
  bool _loading = false;

  RoasterStore get store => widget.store;

  @override
  void initState() {
    super.initState();
    store.refreshProfiles();
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    await store.refreshProfiles();
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _import() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['json'],
      withData: true,
    );
    if (result == null || result.files.isEmpty) return;
    try {
      final bytes = result.files.first.bytes;
      if (bytes == null) throw StateError('no data');
      final json = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
      final newId = await store.api.importProfile(json);
      if (newId != null) {
        await _refresh();
        if (!store.status.isRoastActive) {
          await store.selectAndApplyProfile(newId);
        }
      } else {
        _toast('导入失败');
      }
    } catch (_) {
      _toast('文件格式错误');
    }
  }

  Future<void> _export(RoastProfile p) async {
    try {
      final json = await store.api.exportProfileJson(p.id);
      final path = await FilePicker.platform.saveFile(
        dialogTitle: '导出曲线',
        fileName: '${p.name}.json',
        bytes: Uint8List.fromList(utf8.encode(json)),
      );
      if (path != null) _toast('已导出');
    } catch (_) {
      _toast('导出失败');
    }
  }

  Future<void> _delete(RoastProfile p) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: RoastColors.card,
        title: const Text('删除曲线'),
        content: Text('确定要删除曲线「${p.name}」吗？'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: RoastColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok == true) await store.deleteProfile(p.id);
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _openEditor() async {
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => EditorPage(store: store)),
    );
    if (saved == true) await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final locked = store.status.isRoastActive;
        final profiles = store.profileMap.values.toList();
        final activeId = locked
            ? store.status.profileId
            : store.selectedProfileId;

        return SafeArea(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.all(10),
              child: Row(children: [
                FilledButton.icon(
                  onPressed: _openEditor,
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('新建曲线'),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: _import,
                  icon: const Icon(Icons.upload_file, size: 18),
                  label: const Text('导入曲线'),
                ),
                const SizedBox(width: 8),
                IconButton(
                  onPressed: _loading ? null : _refresh,
                  icon: _loading
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.refresh),
                  tooltip: '刷新',
                ),
              ]),
            ),
            Expanded(
              child: profiles.isEmpty
                  ? const Center(
                      child: Text('暂无曲线，点击「新建曲线」创建',
                          style:
                              TextStyle(color: RoastColors.textMuted)))
                  : GridView.builder(
                      padding: const EdgeInsets.all(10),
                      gridDelegate:
                          const SliverGridDelegateWithMaxCrossAxisExtent(
                        maxCrossAxisExtent: 260,
                        mainAxisExtent: 168,
                        crossAxisSpacing: 10,
                        mainAxisSpacing: 10,
                      ),
                      itemCount: profiles.length,
                      itemBuilder: (context, i) => _ProfileCard(
                        profile: profiles[i],
                        active: profiles[i].id == activeId,
                        locked: locked,
                        onApply: () =>
                            store.selectAndApplyProfile(profiles[i].id),
                        onExport: () => _export(profiles[i]),
                        onDelete: () => _delete(profiles[i]),
                      ),
                    ),
            ),
          ]),
        );
      },
    );
  }
}

class _ProfileCard extends StatelessWidget {
  final RoastProfile profile;
  final bool active;
  final bool locked;
  final VoidCallback onApply;
  final VoidCallback onExport;
  final VoidCallback onDelete;

  const _ProfileCard({
    required this.profile,
    required this.active,
    required this.locked,
    required this.onApply,
    required this.onExport,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final total = profile.totalTime;
    final meta =
        '${profile.nodes.length} 节点 · ${formatTimeShort(total)}';

    return Material(
      color: RoastColors.card,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: locked ? null : onApply,
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: active ? RoastColors.accent : RoastColors.border,
              width: active ? 1.5 : 1,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(profile.name,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      color: RoastColors.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w600)),
              Text(meta,
                  style: const TextStyle(
                      color: RoastColors.textMuted, fontSize: 10)),
              const SizedBox(height: 6),
              Expanded(child: _Sparkline(nodes: profile.nodes)),
              const SizedBox(height: 6),
              Row(children: [
                _CardBtn('应用',
                    color: RoastColors.accent,
                    onTap: locked ? null : onApply),
                const SizedBox(width: 6),
                _CardBtn('导出', onTap: onExport),
                const SizedBox(width: 6),
                _CardBtn('删除',
                    color: RoastColors.danger,
                    onTap: locked ? null : onDelete),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}

class _CardBtn extends StatelessWidget {
  final String label;
  final Color color;
  final VoidCallback? onTap;
  const _CardBtn(this.label, {this.color = RoastColors.textSecondary, this.onTap});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          height: 26,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: color.withValues(alpha: onTap == null ? 0.05 : 0.15),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Text(label,
              style: TextStyle(
                  color: onTap == null ? RoastColors.textMuted : color,
                  fontSize: 11,
                  fontWeight: FontWeight.w600)),
        ),
      ),
    );
  }
}

/// 曲线缩略图（对齐网页版 200x50 SVG sparkline）
class _Sparkline extends StatelessWidget {
  final List<ProfileNode> nodes;
  const _Sparkline({required this.nodes});

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _SparklinePainter(nodes),
      child: const SizedBox.expand(),
    );
  }
}

class _SparklinePainter extends CustomPainter {
  final List<ProfileNode> nodes;
  _SparklinePainter(this.nodes);

  @override
  void paint(Canvas canvas, Size size) {
    if (nodes.length < 2) return;
    final tMin = nodes.first.time, tMax = nodes.last.time;
    double yMin = nodes.first.temperature, yMax = yMin;
    for (final n in nodes) {
      if (n.temperature < yMin) yMin = n.temperature;
      if (n.temperature > yMax) yMax = n.temperature;
    }
    final tSpan = (tMax - tMin) == 0 ? 1 : (tMax - tMin);
    final ySpan = (yMax - yMin) == 0 ? 1 : (yMax - yMin);
    const pad = 2.0;

    final path = Path();
    for (int i = 0; i < nodes.length; i++) {
      final x = pad + (nodes[i].time - tMin) / tSpan * (size.width - 2 * pad);
      final y = (size.height - pad) -
          (nodes[i].temperature - yMin) / ySpan * (size.height - 2 * pad);
      if (i == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = RoastColors.pv
        ..strokeWidth = 1.5
        ..style = PaintingStyle.stroke
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(_SparklinePainter old) => old.nodes != nodes;
}
