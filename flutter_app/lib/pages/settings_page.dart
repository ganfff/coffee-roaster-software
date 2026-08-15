import 'package:flutter/material.dart';

import '../models.dart';
import '../state.dart';
import '../theme.dart';

class SettingsPage extends StatefulWidget {
  final RoasterStore store;
  const SettingsPage({super.key, required this.store});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late final TextEditingController _controller;
  late final TextEditingController _realPresetController;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.store.api.baseUrl);
    _realPresetController =
        TextEditingController(text: widget.store.realPresetUrl);
  }

  @override
  void dispose() {
    _controller.dispose();
    _realPresetController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    var url = _controller.text.trim();
    while (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      _toast('地址需以 http:// 或 https:// 开头');
      return;
    }
    setState(() => _saving = true);
    await widget.store.switchBackend(url);
    if (mounted) {
      setState(() => _saving = false);
      _toast('已保存并重连');
    }
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListenableBuilder(
        listenable: widget.store,
        builder: (context, _) {
          final st = widget.store.status;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const Text('后端连接',
                  style: TextStyle(
                      color: RoastColors.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700)),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(
                  child: _PresetCard(
                    icon: Icons.computer,
                    title: '模拟器',
                    subtitle: '本机模拟后端',
                    url: RoasterStore.simulatorUrl,
                    current: widget.store.api.baseUrl ==
                        RoasterStore.simulatorUrl,
                    onTap: () =>
                        widget.store.switchBackend(RoasterStore.simulatorUrl),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: _PresetCard(
                    icon: Icons.precision_manufacturing,
                    title: '实机',
                    subtitle: '树莓派 · 真实温控器',
                    url: widget.store.realPresetUrl,
                    current: widget.store.api.baseUrl ==
                        widget.store.realPresetUrl,
                    onTap: () => widget.store
                        .switchBackend(widget.store.realPresetUrl),
                  ),
                ),
              ]),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(
                  child: TextField(
                    controller: _realPresetController,
                    style: const TextStyle(
                        color: RoastColors.textPrimary, fontSize: 13),
                    decoration: InputDecoration(
                      labelText: '实机地址（树莓派 IP）',
                      labelStyle:
                          const TextStyle(color: RoastColors.textMuted),
                      isDense: true,
                      filled: true,
                      fillColor: RoastColors.card,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide:
                            const BorderSide(color: RoastColors.border),
                      ),
                    ),
                    keyboardType: TextInputType.url,
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: () async {
                    await widget.store
                        .setRealPreset(_realPresetController.text);
                    if (mounted) _toast('实机预设已保存');
                  },
                  child: const Text('保存预设'),
                ),
              ]),
              const Divider(height: 24),
              TextField(
                controller: _controller,
                style: const TextStyle(color: RoastColors.textPrimary),
                decoration: InputDecoration(
                  labelText: '手动指定后端地址',
                  hintText: 'http://192.168.1.50:8000',
                  hintStyle:
                      const TextStyle(color: RoastColors.textMuted),
                  filled: true,
                  fillColor: RoastColors.card,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide:
                        const BorderSide(color: RoastColors.border),
                  ),
                ),
                keyboardType: TextInputType.url,
              ),
              const SizedBox(height: 12),
              Row(children: [
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: Text(_saving ? '保存中...' : '保存并重连'),
                ),
                const SizedBox(width: 12),
                TextButton(
                  onPressed: () {
                    _controller.text = RoasterStore.simulatorUrl;
                  },
                  child: const Text('恢复默认'),
                ),
              ]),
              if (widget.store.backendHistory.isNotEmpty) ...[
                const SizedBox(height: 16),
                const Text('最近使用',
                    style: TextStyle(
                        color: RoastColors.textSecondary,
                        fontSize: 13,
                        fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final url in widget.store.backendHistory)
                      _HistoryChip(
                        url: url,
                        current: url == widget.store.api.baseUrl,
                        onTap: () async {
                          _controller.text = url;
                          await widget.store.switchBackend(url);
                          if (mounted) _toast('已切换到 $url');
                        },
                      ),
                  ],
                ),
              ],
              const SizedBox(height: 24),
              _AutoMarkSection(store: widget.store),
              const SizedBox(height: 24),
              _AlarmsSection(store: widget.store),
              const SizedBox(height: 24),
              const Text('连接状态',
                  style: TextStyle(
                      color: RoastColors.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              _statusRow('WebSocket（前端 ↔ 后端）', widget.store.wsConnected),
              _statusRow('TC4S（后端 ↔ 硬件串口）', st.connected),
              const SizedBox(height: 24),
              const Text("Ganf's 咖啡烘焙机控制台 Flutter 客户端 v0.1.0",
                  style: TextStyle(
                      color: RoastColors.textMuted, fontSize: 12)),
            ],
          );
        },
      ),
    );
  }

  Widget _statusRow(String label, bool online) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: online ? RoastColors.development : RoastColors.danger,
          ),
        ),
        const SizedBox(width: 8),
        Text(label,
            style: const TextStyle(
                color: RoastColors.textSecondary, fontSize: 13)),
        const Spacer(),
        Text(online ? '在线' : '离线',
            style: TextStyle(
                color: online
                    ? RoastColors.development
                    : RoastColors.danger,
                fontSize: 12)),
      ]),
    );
  }
}

class _AutoMarkSection extends StatefulWidget {
  final RoasterStore store;
  const _AutoMarkSection({required this.store});

  @override
  State<_AutoMarkSection> createState() => _AutoMarkSectionState();
}

class _AutoMarkSectionState extends State<_AutoMarkSection> {
  late final TextEditingController _dryCtrl;
  late final TextEditingController _fcsCtrl;

  @override
  void initState() {
    super.initState();
    _dryCtrl = TextEditingController(
        text: widget.store.autoDryTemp.toStringAsFixed(0));
    _fcsCtrl = TextEditingController(
        text: widget.store.autoFCsTemp.toStringAsFixed(0));
  }

  @override
  void dispose() {
    _dryCtrl.dispose();
    _fcsCtrl.dispose();
    super.dispose();
  }

  double _parseTemp(String s, double fallback) {
    final v = double.tryParse(s);
    if (v == null) return fallback;
    return v.clamp(0.0, 300.0);
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.store;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('自动标记',
          style: TextStyle(
              color: RoastColors.textPrimary,
              fontSize: 16,
              fontWeight: FontWeight.w700)),
      const SizedBox(height: 4),
      const Text('温度到达阈值时自动记录事件（对齐 Artisan autoDRY / autoFCs）',
          style: TextStyle(color: RoastColors.textMuted, fontSize: 11)),
      _autoRow(
        label: '自动标记转黄',
        unit: '°C',
        enabled: store.autoDryEnabled,
        ctrl: _dryCtrl,
        onToggle: (v) =>
            store.setAutoDry(v, _parseTemp(_dryCtrl.text, store.autoDryTemp)),
        onTempCommit: () => store.setAutoDry(
            store.autoDryEnabled, _parseTemp(_dryCtrl.text, store.autoDryTemp)),
      ),
      _autoRow(
        label: '自动标记一爆',
        unit: '°C',
        enabled: store.autoFCsEnabled,
        ctrl: _fcsCtrl,
        onToggle: (v) =>
            store.setAutoFCs(v, _parseTemp(_fcsCtrl.text, store.autoFCsTemp)),
        onTempCommit: () => store.setAutoFCs(
            store.autoFCsEnabled, _parseTemp(_fcsCtrl.text, store.autoFCsTemp)),
      ),
    ]);
  }

  Widget _autoRow({
    required String label,
    required String unit,
    required bool enabled,
    required TextEditingController ctrl,
    required ValueChanged<bool> onToggle,
    required VoidCallback onTempCommit,
  }) {
    return Row(children: [
      Switch(value: enabled, onChanged: onToggle),
      Text(label,
          style: const TextStyle(
              color: RoastColors.textSecondary, fontSize: 13)),
      const Spacer(),
      SizedBox(
        width: 76,
        child: TextField(
          controller: ctrl,
          keyboardType: TextInputType.number,
          onEditingComplete: onTempCommit,
          onTapOutside: (_) => onTempCommit(),
          style: const TextStyle(color: RoastColors.textPrimary, fontSize: 13),
          decoration: InputDecoration(
            isDense: true,
            suffixText: unit,
            suffixStyle: const TextStyle(color: RoastColors.textMuted),
            filled: true,
            fillColor: RoastColors.card,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(6),
              borderSide: const BorderSide(color: RoastColors.border),
            ),
          ),
        ),
      ),
    ]);
  }
}

class _AlarmsSection extends StatefulWidget {
  final RoasterStore store;
  const _AlarmsSection({required this.store});

  @override
  State<_AlarmsSection> createState() => _AlarmsSectionState();
}

class _AlarmsSectionState extends State<_AlarmsSection> {
  final Map<RoastAlarm, String> _pendingValues = {};

  void _persist() => widget.store.setAlarms(widget.store.alarms);

  void _commitValue(RoastAlarm a) {
    final raw = _pendingValues[a];
    if (raw != null) {
      final v = double.tryParse(raw);
      if (v != null) a.value = v.clamp(0.0, 100000.0);
      _pendingValues.remove(a);
    }
    _persist();
  }

  String _fmtValue(RoastAlarm a) => a.value == a.value.roundToDouble()
      ? a.value.toStringAsFixed(0)
      : a.value.toStringAsFixed(1);

  @override
  Widget build(BuildContext context) {
    final alarms = widget.store.alarms;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        const Text('报警',
            style: TextStyle(
                color: RoastColors.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w700)),
        const SizedBox(width: 8),
        const Text('烘焙中触发，提示音 + 弹窗，每锅每条一次',
            style: TextStyle(color: RoastColors.textMuted, fontSize: 11)),
        const Spacer(),
        IconButton(
          onPressed: () {
            alarms.add(RoastAlarm());
            _persist();
          },
          icon: const Icon(Icons.add_circle_outline),
          tooltip: '添加报警',
        ),
      ]),
      if (alarms.isEmpty)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 8),
          child: Text('暂无报警，点右上角 + 添加',
              style: TextStyle(color: RoastColors.textMuted, fontSize: 12)),
        ),
      for (int i = 0; i < alarms.length; i++) _alarmRow(alarms[i]),
    ]);
  }

  Widget _alarmRow(RoastAlarm a) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [
        Switch(
          value: a.enabled,
          onChanged: (v) {
            a.enabled = v;
            _persist();
          },
        ),
        DropdownButton<AlarmType>(
          value: a.type,
          dropdownColor: RoastColors.card,
          underline: const SizedBox.shrink(),
          items: const [
            DropdownMenuItem(
                value: AlarmType.temp,
                child: Text('温度≥', style: TextStyle(fontSize: 12))),
            DropdownMenuItem(
                value: AlarmType.time,
                child: Text('时间≥', style: TextStyle(fontSize: 12))),
          ],
          onChanged: (v) {
            if (v != null) {
              a.type = v;
              _persist();
            }
          },
        ),
        const SizedBox(width: 6),
        SizedBox(
          width: 64,
          child: TextFormField(
            key: ObjectKey(a),
            initialValue: _fmtValue(a),
            keyboardType: TextInputType.number,
            onChanged: (s) => _pendingValues[a] = s,
            onEditingComplete: () => _commitValue(a),
            onTapOutside: (_) => _commitValue(a),
            style:
                const TextStyle(color: RoastColors.textPrimary, fontSize: 12),
            decoration: InputDecoration(
              isDense: true,
              suffixText: a.type == AlarmType.temp ? '°C' : '秒',
              suffixStyle:
                  const TextStyle(color: RoastColors.textMuted, fontSize: 10),
              filled: true,
              fillColor: RoastColors.card,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(6),
                borderSide: const BorderSide(color: RoastColors.border),
              ),
            ),
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: TextFormField(
            initialValue: a.note,
            onChanged: (s) => a.note = s,
            onEditingComplete: _persist,
            style:
                const TextStyle(color: RoastColors.textPrimary, fontSize: 12),
            decoration: InputDecoration(
              isDense: true,
              hintText: '备注（如：检查脱水）',
              hintStyle:
                  const TextStyle(color: RoastColors.textMuted, fontSize: 11),
              filled: true,
              fillColor: RoastColors.card,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(6),
                borderSide: const BorderSide(color: RoastColors.border),
              ),
            ),
          ),
        ),
        IconButton(
          onPressed: () {
            widget.store.alarms.remove(a);
            _persist();
          },
          icon: const Icon(Icons.delete_outline,
              size: 18, color: RoastColors.danger),
          tooltip: '删除',
        ),
      ]),
    );
  }
}

class _PresetCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final String url;
  final bool current;
  final VoidCallback onTap;

  const _PresetCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.url,
    required this.current,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: current
          ? RoastColors.accent.withValues(alpha: 0.12)
          : RoastColors.card,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: current ? RoastColors.accent : RoastColors.border,
              width: current ? 1.5 : 1,
            ),
          ),
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Icon(icon,
                      size: 18,
                      color: current
                          ? RoastColors.accent
                          : RoastColors.textSecondary),
                  const SizedBox(width: 6),
                  Text(title,
                      style: TextStyle(
                          color: current
                              ? RoastColors.accent
                              : RoastColors.textPrimary,
                          fontSize: 14,
                          fontWeight: FontWeight.w700)),
                  const Spacer(),
                  if (current)
                    const Icon(Icons.check_circle,
                        size: 16, color: RoastColors.accent),
                ]),
                const SizedBox(height: 4),
                Text(subtitle,
                    style: const TextStyle(
                        color: RoastColors.textMuted, fontSize: 10)),
                Text(url,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        color: RoastColors.textSecondary, fontSize: 10)),
              ]),
        ),
      ),
    );
  }
}

class _HistoryChip extends StatelessWidget {
  final String url;
  final bool current;
  final VoidCallback onTap;
  const _HistoryChip(
      {required this.url, required this.current, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: current
          ? RoastColors.accent.withValues(alpha: 0.2)
          : RoastColors.card,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: current ? null : onTap,
        child: Container(
          padding:
              const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
                color:
                    current ? RoastColors.accent : RoastColors.border),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (current) ...[
              const Icon(Icons.check,
                  size: 13, color: RoastColors.accent),
              const SizedBox(width: 4),
            ],
            Text(url,
                style: TextStyle(
                    color: current
                        ? RoastColors.accent
                        : RoastColors.textSecondary,
                    fontSize: 12)),
          ]),
        ),
      ),
    );
  }
}
