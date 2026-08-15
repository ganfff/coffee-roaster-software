/// 曲线编辑器 —— 对齐 editor.html + editor.js：
/// 拖拽节点（1s/0.1°C 量化，吸附开关=5s/0.5°C 网格）、撤销/重做（50 步）、
/// 节点列表（行内插入）、ROR 预览、精确编辑、键盘快捷键（桌面）。
library;

import 'dart:async';
import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models.dart';
import '../spline.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/roast_chart.dart';

class EditorPage extends StatefulWidget {
  final RoasterStore store;
  const EditorPage({super.key, required this.store});

  @override
  State<EditorPage> createState() => _EditorPageState();
}

class _EditCommand {
  final List<ProfileNode> prev;
  final List<ProfileNode> next;
  _EditCommand(this.prev, this.next);
}

class _EditorPageState extends State<EditorPage> {
  static const int maxHistory = 50;
  static const double snapTime = 5;
  static const double snapTemp = 0.5;

  // 默认模板（对齐 editor.js：7 节点耶加雪菲浅焙）
  List<ProfileNode> _nodes = [
    ProfileNode(0, 30),
    ProfileNode(60, 100),
    ProfileNode(120, 135),
    ProfileNode(180, 155),
    ProfileNode(270, 188),
    ProfileNode(360, 203),
    ProfileNode(435, 212),
  ];

  int _selectedIndex = -1;
  int _dragIndex = -1;
  bool _snap = false; // 触摸端吸附开关（桌面 Shift 键等效）
  Offset? _dragPointer; // 拖拽提示位置
  bool _saving = false;

  final List<_EditCommand> _undoStack = [];
  final List<_EditCommand> _redoStack = [];

  final _nameCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  final _endTempCtrl = TextEditingController();
  final _minCtrl = TextEditingController();
  final _secCtrl = TextEditingController();
  final _tempCtrl = TextEditingController();

  final _focusNode = FocusNode();

  @override
  void dispose() {
    _nameCtrl.dispose();
    _descCtrl.dispose();
    _endTempCtrl.dispose();
    _minCtrl.dispose();
    _secCtrl.dispose();
    _tempCtrl.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  // ============ 撤销/重做（对齐 pushHistory/finalize 模式）============

  List<ProfileNode> _snapshot() => _nodes.map((n) => n.clone()).toList();

  /// 操作前取快照，返回 finalize 闭包；状态未变则不落历史
  VoidCallback _pushHistory() {
    final prev = _snapshot();
    return () {
      final next = _snapshot();
      if (jsonEncode(prev.map((n) => n.toJson()).toList()) ==
          jsonEncode(next.map((n) => n.toJson()).toList())) {
        return;
      }
      _undoStack.add(_EditCommand(prev, next));
      if (_undoStack.length > maxHistory) _undoStack.removeAt(0);
      _redoStack.clear();
    };
  }

  void _undo() {
    if (_undoStack.isEmpty) return;
    final cmd = _undoStack.removeLast();
    _redoStack.add(cmd);
    setState(() {
      _nodes = cmd.prev.map((n) => n.clone()).toList();
      _selectedIndex = -1;
      _syncSelectionInputs();
    });
    _toast('已撤销');
  }

  void _redo() {
    if (_redoStack.isEmpty) return;
    final cmd = _redoStack.removeLast();
    _undoStack.add(cmd);
    setState(() {
      _nodes = cmd.next.map((n) => n.clone()).toList();
      _selectedIndex = -1;
      _syncSelectionInputs();
    });
    _toast('已重做');
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
          content: Text(msg),
          duration: const Duration(milliseconds: 1200)));
  }

  // ============ 节点操作 ============

  void _sortNodes() => _nodes.sort((a, b) => a.time.compareTo(b.time));

  void _addNode() {
    final last = _nodes[_nodes.length - 1];
    final prev = _nodes.length >= 2 ? _nodes[_nodes.length - 2] : last;
    final dt = last.time - prev.time;
    final dT = last.temperature - prev.temperature;
    var t = (last.time + dt).roundToDouble();
    final v = (last.temperature + dT).clamp(0.0, 300.0);
    if (_nodes.any((n) => n.time == t)) t += 1;

    final finalize = _pushHistory();
    setState(() {
      _nodes.add(ProfileNode(t, round1(v.toDouble())));
      _sortNodes();
      _selectedIndex =
          _nodes.indexWhere((n) => n.time == t && (n.temperature - v).abs() < 0.01);
      _syncSelectionInputs();
    });
    finalize();
  }

  void _deleteSelected() {
    if (_selectedIndex < 0 || _nodes.length <= 2) {
      _toast('至少需要保留两个节点');
      return;
    }
    final finalize = _pushHistory();
    setState(() {
      _nodes.removeAt(_selectedIndex);
      _selectedIndex = -1;
      _syncSelectionInputs();
    });
    finalize();
  }

  void _insertAfter(int index) {
    if (index < 0 || index >= _nodes.length - 1) return;
    final finalize = _pushHistory();
    final curr = _nodes[index];
    final next = _nodes[index + 1];
    final midTime = snapValue((curr.time + next.time) / 2, snapTime);
    final midTemp = round1(getSplineTemp(_nodes, midTime));
    setState(() {
      _nodes.insert(index + 1, ProfileNode(midTime, midTemp));
      _selectedIndex = index + 1;
      _syncSelectionInputs();
    });
    finalize();
  }

  void _duplicateSelected() {
    if (_selectedIndex < 0) return;
    final finalize = _pushHistory();
    final orig = _nodes[_selectedIndex];
    var newTime = orig.time + 30;
    if (_selectedIndex < _nodes.length - 1) {
      final nextTime = _nodes[_selectedIndex + 1].time;
      if (newTime >= nextTime) {
        newTime = snapValue((orig.time + nextTime) / 2, snapTime);
      }
    }
    setState(() {
      _nodes.insert(
          _selectedIndex + 1, ProfileNode(newTime, orig.temperature));
      _sortNodes();
      _selectedIndex = _nodes.indexWhere((n) => n.time == newTime);
      _syncSelectionInputs();
    });
    finalize();
  }

  /// 键盘微调（↑↓ 温度 ±0.5/±5，←→ 时间 ±1/±10）
  void _nudge(String key, bool shift) {
    if (_selectedIndex < 0) return;
    final finalize = _pushHistory();
    setState(() {
      final node = _nodes[_selectedIndex];
      final timeStep = shift ? 10.0 : 1.0;
      final tempStep = shift ? 5.0 : 0.5;
      switch (key) {
        case 'up':
          node.temperature =
              round1((node.temperature + tempStep).clamp(0.0, 300.0));
        case 'down':
          node.temperature =
              round1((node.temperature - tempStep).clamp(0.0, 300.0));
        case 'right':
          final maxT = _selectedIndex < _nodes.length - 1
              ? _nodes[_selectedIndex + 1].time - 1
              : double.infinity;
          node.time = (node.time + timeStep).clamp(0.0, maxT);
        case 'left':
          final minT =
              _selectedIndex > 0 ? _nodes[_selectedIndex - 1].time + 1 : 0.0;
          node.time = (node.time - timeStep).clamp(minT, double.infinity);
      }
      if (_selectedIndex == 0) node.time = 0;
      _sortNodes();
      _syncSelectionInputs();
    });
    finalize();
  }

  // ============ 拖拽（对齐 updateNodeDrag 的量化与夹紧规则）============

  int _hitTest(ChartTransform t, Offset pos) {
    double minDist = double.infinity;
    int idx = -1;
    for (int i = 0; i < _nodes.length; i++) {
      final p = t.toPixel(_nodes[i].time, _nodes[i].temperature, 0);
      final d = (p - pos).distance;
      if (d < minDist) {
        minDist = d;
        idx = i;
      }
    }
    return minDist < 24 ? idx : -1;
  }

  bool get _shiftPressed {
    final keys = HardwareKeyboard.instance.logicalKeysPressed;
    return keys.contains(LogicalKeyboardKey.shiftLeft) ||
        keys.contains(LogicalKeyboardKey.shiftRight);
  }

  void _onPanStart(ChartTransform t, DragStartDetails d) {
    final idx = _hitTest(t, d.localPosition);
    if (idx < 0) return;
    _dragFinalize = _pushHistory();
    setState(() {
      _dragIndex = idx;
      _selectedIndex = idx;
      _dragPointer = d.localPosition;
      _syncSelectionInputs();
    });
  }

  VoidCallback? _dragFinalize;

  void _onPanUpdate(ChartTransform t, DragUpdateDetails d) {
    if (_dragIndex < 0) return;
    var newTime = t.pixelToTime(d.localPosition.dx);
    var newTemp = t.pixelToTemp(d.localPosition.dy);

    final useSnap = _snap || _shiftPressed;
    if (useSnap) {
      newTime = snapValue(newTime, snapTime);
      newTemp = snapValue(newTemp, snapTemp);
    } else {
      newTime = newTime.roundToDouble();
      newTemp = round1(newTemp);
    }
    newTemp = newTemp.clamp(0.0, 300.0);

    setState(() {
      final i = _dragIndex;
      if (i > 0) {
        final prevTime = _nodes[i - 1].time;
        if (newTime <= prevTime) newTime = prevTime + 1;
      }
      if (i < _nodes.length - 1) {
        final nextTime = _nodes[i + 1].time;
        if (newTime >= nextTime) newTime = nextTime - 1;
      }
      if (i == 0) newTime = 0;
      _nodes[i].time = newTime;
      _nodes[i].temperature = newTemp;
      _dragPointer = d.localPosition;
    });
  }

  void _onPanEnd(DragEndDetails _) {
    if (_dragIndex < 0) return;
    setState(() {
      _sortNodes();
      // 排序后找回选中节点
      if (_dragIndex >= 0 && _selectedIndex >= 0) {
        // 拖拽中未排序，索引仍有效；此处仅在排序后校正
      }
      _dragIndex = -1;
      _dragPointer = null;
      _syncSelectionInputs();
    });
    _dragFinalize?.call();
    _dragFinalize = null;
  }

  // ============ 选中与精确编辑 ============

  void _selectNode(int idx) {
    setState(() {
      _selectedIndex = idx;
      _syncSelectionInputs();
    });
  }

  void _syncSelectionInputs() {
    if (_selectedIndex >= 0 && _selectedIndex < _nodes.length) {
      final n = _nodes[_selectedIndex];
      _minCtrl.text = (n.time / 60).floor().toString();
      _secCtrl.text = (n.time % 60).round().toString();
      _tempCtrl.text = n.temperature.toStringAsFixed(1);
    } else {
      _minCtrl.text = '';
      _secCtrl.text = '';
      _tempCtrl.text = '';
    }
  }

  void _applyPreciseEdit() {
    if (_selectedIndex < 0) return;
    var m = int.tryParse(_minCtrl.text) ?? 0;
    var s = int.tryParse(_secCtrl.text) ?? 0;
    if (m < 0) m = 0;
    if (s < 0) s = 0;
    var t = (m * 60 + s).toDouble();
    var v = (double.tryParse(_tempCtrl.text) ?? 0).clamp(0.0, 300.0);

    final finalize = _pushHistory();
    setState(() {
      final i = _selectedIndex;
      if (i > 0 && t <= _nodes[i - 1].time) t = _nodes[i - 1].time + 1;
      if (i < _nodes.length - 1 && t >= _nodes[i + 1].time) {
        t = _nodes[i + 1].time - 1;
      }
      if (i == 0) t = 0;
      _nodes[i].time = t;
      _nodes[i].temperature = round1(v.toDouble());
      _sortNodes();
      _selectedIndex = _nodes.indexWhere(
          (n) => n.time == t && (n.temperature - v).abs() < 0.05);
      _syncSelectionInputs();
    });
    finalize();
  }

  // ============ 保存与导出 ============

  RoastProfile _buildProfile() => RoastProfile(
        name: _nameCtrl.text.trim(),
        description: _descCtrl.text.trim(),
        nodes: _nodes.map((n) => n.clone()).toList(),
        endTemp: double.tryParse(_endTempCtrl.text) ?? 0,
      );

  Future<void> _save() async {
    if (_nameCtrl.text.trim().isEmpty) {
      _toast('请输入曲线名称');
      return;
    }
    setState(() => _saving = true);
    final id = await widget.store.api.saveProfile(_buildProfile());
    if (!mounted) return;
    setState(() => _saving = false);
    if (id != null) {
      _toast('保存成功');
      await widget.store.refreshProfiles();
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } else {
      _toast('保存失败');
    }
  }

  Future<void> _export() async {
    final p = _buildProfile();
    p.name = p.name.isEmpty ? '未命名曲线' : p.name;
    final json = const JsonEncoder.withIndent('  ').convert(p.toJson());
    final path = await FilePicker.platform.saveFile(
      dialogTitle: '导出曲线',
      fileName: '${p.name}.json',
      bytes: Uint8List.fromList(utf8.encode(json)),
    );
    if (path != null) _toast('导出成功');
  }

  // ============ 键盘快捷键 ============

  KeyEventResult _onKey(KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final ctrl = HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isMetaPressed;
    final shift = HardwareKeyboard.instance.isShiftPressed;
    final key = event.logicalKey;

    if (ctrl && key == LogicalKeyboardKey.keyZ && !shift) {
      _undo();
      return KeyEventResult.handled;
    }
    if (ctrl && (key == LogicalKeyboardKey.keyY ||
        (shift && key == LogicalKeyboardKey.keyZ))) {
      _redo();
      return KeyEventResult.handled;
    }
    if ((key == LogicalKeyboardKey.delete ||
            key == LogicalKeyboardKey.backspace) &&
        _selectedIndex >= 0) {
      _deleteSelected();
      return KeyEventResult.handled;
    }
    if (ctrl && key == LogicalKeyboardKey.keyD && _selectedIndex >= 0) {
      _duplicateSelected();
      return KeyEventResult.handled;
    }
    if (ctrl && key == LogicalKeyboardKey.keyN) {
      _addNode();
      return KeyEventResult.handled;
    }
    if (ctrl && key == LogicalKeyboardKey.keyS) {
      _save();
      return KeyEventResult.handled;
    }
    if (_selectedIndex >= 0) {
      if (key == LogicalKeyboardKey.arrowUp) {
        _nudge('up', shift);
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.arrowDown) {
        _nudge('down', shift);
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.arrowLeft) {
        _nudge('left', shift);
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.arrowRight) {
        _nudge('right', shift);
        return KeyEventResult.handled;
      }
    }
    if (key == LogicalKeyboardKey.escape) {
      _selectNode(-1);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  // ============ UI ============

  @override
  Widget build(BuildContext context) {
    final curvePoints = splineInterpolate(_nodes, 5);
    final rorPoints = buildRORDataset(_nodes);
    final xMax = _nodes.isEmpty ? 600.0 : _nodes.last.time;

    final series = [
      ChartSeriesSpec(
          label: '温度曲线',
          points: curvePoints,
          color: const Color(0xFF9CA3AF),
          width: 2),
      ChartSeriesSpec(
          label: '预测 ROR',
          points: rorPoints,
          color: RoastColors.drying,
          dashed: true,
          axis: 1),
    ];

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: const Text('曲线编辑器', style: TextStyle(fontSize: 15)),
        actions: [
          IconButton(
            onPressed: _undoStack.isEmpty ? null : _undo,
            icon: const Icon(Icons.undo),
            tooltip: '撤销 (Ctrl+Z)',
          ),
          IconButton(
            onPressed: _redoStack.isEmpty ? null : _redo,
            icon: const Icon(Icons.redo),
            tooltip: '重做 (Ctrl+Y)',
          ),
          TextButton(onPressed: _export, child: const Text('导出 JSON')),
          const SizedBox(width: 4),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: FilledButton(
              onPressed: _saving ? null : _save,
              child: Text(_saving ? '保存中...' : '保存曲线'),
            ),
          ),
        ],
      ),
      body: KeyboardListener(
        focusNode: _focusNode,
        autofocus: true,
        onKeyEvent: _onKey,
        child: Column(children: [
          // 名称/描述/结束温度
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
            child: Row(children: [
              Expanded(
                flex: 3,
                child: _headerInput(_nameCtrl, '曲线名称'),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 3,
                child: _headerInput(_descCtrl, '描述（可选）'),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 2,
                child: _headerInput(_endTempCtrl, '结束温度 °C',
                    number: true),
              ),
            ]),
          ),
          Expanded(
            child: LayoutBuilder(builder: (context, c) {
              final chart = _buildChart(series, xMax);
              final panel = _buildSidePanel();
              if (c.maxWidth >= 720) {
                return Row(children: [
                  Expanded(child: chart),
                  Container(
                    width: 280,
                    decoration: const BoxDecoration(
                        border: Border(
                            left: BorderSide(color: RoastColors.border))),
                    child: panel,
                  ),
                ]);
              }
              return Column(children: [
                Expanded(flex: 3, child: chart),
                const Divider(height: 1),
                Expanded(flex: 2, child: panel),
              ]);
            }),
          ),
        ]),
      ),
    );
  }

  Widget _headerInput(TextEditingController ctrl, String hint,
      {bool number = false}) {
    return TextField(
      controller: ctrl,
      keyboardType: number ? TextInputType.number : TextInputType.text,
      style: const TextStyle(color: RoastColors.textPrimary, fontSize: 13),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: RoastColors.textMuted),
        isDense: true,
        filled: true,
        fillColor: RoastColors.card,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: RoastColors.border),
        ),
      ),
    );
  }

  Widget _buildChart(List<ChartSeriesSpec> series, double xMax) {
    return LayoutBuilder(builder: (context, c) {
      final size = Size(c.maxWidth, c.maxHeight);
      final transform = RoastChart.computeTransform(
        plotRect: RoastChart.plotRectOf(size),
        series: series,
        suggestedXMax: xMax,
      );
      return Stack(children: [
        Positioned.fill(child: RoastChart(series: series, suggestedXMax: xMax)),
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onPanStart: (d) => _onPanStart(transform, d),
            onPanUpdate: (d) => _onPanUpdate(transform, d),
            onPanEnd: _onPanEnd,
            child: CustomPaint(
              painter: _ControlPointsPainter(
                nodes: _nodes,
                selectedIndex: _selectedIndex,
                transform: transform,
                dragPointer: _dragPointer,
                dragging: _dragIndex >= 0,
              ),
            ),
          ),
        ),
        // 吸附开关（触摸端等效 Shift）
        Positioned(
          right: 56,
          bottom: 32,
          child: FilterChip(
            label: const Text('网格吸附', style: TextStyle(fontSize: 11)),
            selected: _snap,
            onSelected: (v) => setState(() => _snap = v),
            selectedColor: RoastColors.accent.withValues(alpha: 0.3),
            backgroundColor: RoastColors.card,
          ),
        ),
      ]);
    });
  }

  Widget _buildSidePanel() {
    final ror = computeSegmentROR(_nodes);
    return ListView(padding: const EdgeInsets.all(10), children: [
      Row(children: [
        Expanded(
          child: OutlinedButton.icon(
              onPressed: _addNode,
              icon: const Icon(Icons.add, size: 16),
              label: const Text('添加', style: TextStyle(fontSize: 12))),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: OutlinedButton.icon(
              onPressed: _selectedIndex >= 0 ? _deleteSelected : null,
              icon: const Icon(Icons.delete_outline, size: 16),
              label: const Text('删除', style: TextStyle(fontSize: 12))),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: OutlinedButton.icon(
              onPressed: _selectedIndex >= 0 ? _duplicateSelected : null,
              icon: const Icon(Icons.copy, size: 16),
              label: const Text('复制', style: TextStyle(fontSize: 12))),
        ),
      ]),
      const SizedBox(height: 10),
      const Text('选中节点',
          style: TextStyle(
              color: RoastColors.textSecondary,
              fontSize: 12,
              fontWeight: FontWeight.w600)),
      const SizedBox(height: 6),
      Row(children: [
        Expanded(
            child: _editInput(_minCtrl, '分',
                enabled: _selectedIndex > 0)),
        const SizedBox(width: 4),
        Expanded(
            child: _editInput(_secCtrl, '秒',
                enabled: _selectedIndex > 0)),
        const SizedBox(width: 4),
        Expanded(
            child: _editInput(_tempCtrl, '温度',
                enabled: _selectedIndex >= 0)),
      ]),
      const SizedBox(height: 12),
      const Text('节点列表',
          style: TextStyle(
              color: RoastColors.textSecondary,
              fontSize: 12,
              fontWeight: FontWeight.w600)),
      const SizedBox(height: 4),
      for (int i = 0; i < _nodes.length; i++)
        _nodeRow(i, i < ror.length ? ror[i] : null),
      const SizedBox(height: 12),
      const Text('ROR 预览',
          style: TextStyle(
              color: RoastColors.textSecondary,
              fontSize: 12,
              fontWeight: FontWeight.w600)),
      const SizedBox(height: 4),
      for (int i = 0; i < ror.length; i++)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(children: [
            Expanded(
              child: Text(
                '${formatTimeShort(_nodes[i].time)} ~ ${formatTimeShort(_nodes[i + 1].time)}',
                style: const TextStyle(
                    color: RoastColors.textMuted, fontSize: 11),
              ),
            ),
            Text('${ror[i].toStringAsFixed(1)} °C/min',
                style: TextStyle(
                    color: ror[i] >= 0
                        ? RoastColors.development
                        : RoastColors.danger,
                    fontSize: 11)),
          ]),
        ),
    ]);
  }

  Widget _editInput(TextEditingController ctrl, String hint,
      {required bool enabled}) {
    return TextField(
      controller: ctrl,
      enabled: enabled,
      keyboardType: TextInputType.number,
      onSubmitted: (_) => _applyPreciseEdit(),
      onTapOutside: (_) => _applyPreciseEdit(),
      style: const TextStyle(color: RoastColors.textPrimary, fontSize: 12),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: RoastColors.textMuted),
        isDense: true,
        filled: true,
        fillColor: RoastColors.card,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: RoastColors.border),
        ),
      ),
    );
  }

  Widget _nodeRow(int i, double? rorValue) {
    final n = _nodes[i];
    final selected = i == _selectedIndex;
    return GestureDetector(
      onTap: () => _selectNode(i),
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 1),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        decoration: BoxDecoration(
          color: selected
              ? RoastColors.accent.withValues(alpha: 0.18)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(children: [
          SizedBox(
              width: 44,
              child: Text(formatTimeShort(n.time),
                  style: const TextStyle(
                      color: RoastColors.textSecondary, fontSize: 11))),
          Expanded(
              child: Text(n.temperature.toStringAsFixed(1),
                  style: const TextStyle(
                      color: RoastColors.textPrimary, fontSize: 11))),
          Text(rorValue != null ? rorValue.toStringAsFixed(1) : '--',
              style: const TextStyle(
                  color: RoastColors.textMuted, fontSize: 10)),
          if (i < _nodes.length - 1)
            GestureDetector(
              onTap: () => _insertAfter(i),
              child: const Padding(
                padding: EdgeInsets.only(left: 6),
                child: Icon(Icons.add_circle_outline,
                    size: 16, color: RoastColors.textMuted),
              ),
            ),
        ]),
      ),
    );
  }
}

/// 控制点 + 拖拽提示绘制层
class _ControlPointsPainter extends CustomPainter {
  final List<ProfileNode> nodes;
  final int selectedIndex;
  final ChartTransform transform;
  final Offset? dragPointer;
  final bool dragging;

  _ControlPointsPainter({
    required this.nodes,
    required this.selectedIndex,
    required this.transform,
    required this.dragPointer,
    required this.dragging,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final t = transform;
    for (int i = 0; i < nodes.length; i++) {
      final p = t.toPixel(nodes[i].time, nodes[i].temperature, 0);
      final selected = i == selectedIndex;
      canvas.drawCircle(
          p,
          selected ? 8 : 6,
          Paint()..color = RoastColors.maillard);
      if (selected) {
        canvas.drawCircle(
            p,
            8,
            Paint()
              ..color = Colors.white
              ..style = PaintingStyle.stroke
              ..strokeWidth = 2);
      }
    }
    // 拖拽提示（对齐网页版 drag-tooltip）
    if (dragging && dragPointer != null && selectedIndex >= 0) {
      final n = nodes[selectedIndex];
      final text =
          '${formatTimeShort(n.time)} / ${n.temperature.toStringAsFixed(1)}°C';
      final tp = TextPainter(
        text: TextSpan(
            text: text,
            style: const TextStyle(
                color: Colors.white,
                fontSize: 12.5,
                fontFamily: kFontFamily,
                fontFamilyFallback: kFontFallback)),
        textDirection: TextDirection.ltr,
      )..layout();
      var dx = dragPointer!.dx + 15;
      var dy = dragPointer!.dy - 34;
      dx = dx.clamp(0, size.width - tp.width - 12);
      dy = dy.clamp(0, size.height - 24);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
            Rect.fromLTWH(dx, dy, tp.width + 12, 20),
            const Radius.circular(4)),
        Paint()..color = const Color(0xE6141414),
      );
      tp.paint(canvas, Offset(dx + 6, dy + 3));
    }
  }

  @override
  bool shouldRepaint(_ControlPointsPainter old) => true;
}
