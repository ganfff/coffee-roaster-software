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
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.store.api.baseUrl);
  }

  @override
  void dispose() {
    _controller.dispose();
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
              const SizedBox(height: 6),
              const Text('烘焙机后端（FastAPI）地址。本机调试填 localhost；'
                  '连接局域网树莓派填其 IP，例如 http://192.168.1.50:8000',
                  style: TextStyle(
                      color: RoastColors.textMuted, fontSize: 12)),
              const SizedBox(height: 12),
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
                    _controller.text = 'http://localhost:8000';
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
