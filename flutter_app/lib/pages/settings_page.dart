/// 设置页 —— 后端地址配置 + 连接状态
library;

import 'package:flutter/material.dart';

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
              // 两个一键预设
              Row(children: [
                Expanded(
                  child: _PresetCard(
                    icon: Icons.computer,
                    title: '模拟器',
                    subtitle: '本机模拟后端 · 无需硬件',
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
              // 实机地址修改
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
              const Text('手动指定',
                  style: TextStyle(
                      color: RoastColors.textSecondary,
                      fontSize: 13,
                      fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              const Text('烘焙机后端（FastAPI）地址，例如 http://192.168.1.50:8000',
                  style: TextStyle(
                      color: RoastColors.textMuted, fontSize: 12)),
              const SizedBox(height: 8),
              TextField(
                controller: _controller,
                style: const TextStyle(color: RoastColors.textPrimary),
                decoration: InputDecoration(
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
              // 最近使用：一键切换
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
              const Text('连接状态',
                  style: TextStyle(
                      color: RoastColors.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              _statusRow('WebSocket（前端 ↔ 后端）', widget.store.wsConnected),
              _statusRow('TC4S（后端 ↔ 硬件串口）', st.connected),
              const SizedBox(height: 24),
              const Text('关于',
                  style: TextStyle(
                      color: RoastColors.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              const Text("Ganf's 咖啡烘焙机控制台 Flutter 客户端 v0.1.0\n"
                  '与网页版共用同一后端（REST + WebSocket）。',
                  style: TextStyle(
                      color: RoastColors.textMuted,
                      fontSize: 12,
                      height: 1.5)),
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

/// 后端预设选择卡片（模拟器 / 实机）
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

/// 最近使用地址芯片
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
