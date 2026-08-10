/// 双轴烘焙图表 —— CustomPainter 实现，视觉对齐网页版 Chart.js 配置：
/// 左轴温度 0~300°C，右轴 ROR，X 轴秒（m:ss 刻度），虚线/填充/事件垂直标注。
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../spline.dart';
import '../theme.dart';

/// 一条数据线
class ChartSeriesSpec {
  final String label;
  final List<ChartPoint> points;
  final Color color;
  final bool dashed;
  final double width;
  final bool filled;
  final Color? fillColor;

  /// 0 = 左轴（温度），1 = 右轴（ROR）
  final int axis;
  final bool visible;

  const ChartSeriesSpec({
    required this.label,
    required this.points,
    required this.color,
    this.dashed = false,
    this.width = 2,
    this.filled = false,
    this.fillColor,
    this.axis = 0,
    this.visible = true,
  });
}

/// 事件垂直标注
class EventAnnotation {
  final double time;
  final String label;
  final Color color;
  const EventAnnotation(this.time, this.label, this.color);
}

/// 图表坐标变换（编辑器拖拽命中测试也要用）
class ChartTransform {
  final Rect plotRect;
  final double xMin, xMax, yMin, yMax, rorMin, rorMax;

  const ChartTransform({
    required this.plotRect,
    required this.xMin,
    required this.xMax,
    required this.yMin,
    required this.yMax,
    required this.rorMin,
    required this.rorMax,
  });

  Offset toPixel(double x, double y, int axis) {
    final px = plotRect.left + (x - xMin) / (xMax - xMin) * plotRect.width;
    final lo = axis == 0 ? yMin : rorMin;
    final hi = axis == 0 ? yMax : rorMax;
    final py = plotRect.bottom - (y - lo) / (hi - lo) * plotRect.height;
    return Offset(px, py);
  }

  double pixelToTime(double px) =>
      xMin + (px - plotRect.left) / plotRect.width * (xMax - xMin);
  double pixelToTemp(double py) =>
      yMin + (plotRect.bottom - py) / plotRect.height * (yMax - yMin);
}

class RoastChart extends StatelessWidget {
  final List<ChartSeriesSpec> series;
  final List<EventAnnotation> annotations;

  /// X 轴建议最大值（网页版 suggestedMax：600/900/1200）
  final double suggestedXMax;

  /// 绘图区内边距（编辑器命中测试复用）
  static const double leftAxisW = 46;
  static const double rightAxisW = 46;
  static const double topPad = 10;
  static const double bottomPad = 26;

  static Rect plotRectOf(Size size) => Rect.fromLTRB(
      leftAxisW, topPad, size.width - rightAxisW, size.height - bottomPad);

  const RoastChart({
    super.key,
    required this.series,
    this.annotations = const [],
    this.suggestedXMax = 600,
  });

  /// 由数据与建议值计算真实坐标范围（含 ROR 轴自适应）
  static ChartTransform computeTransform({
    required Rect plotRect,
    required List<ChartSeriesSpec> series,
    double suggestedXMax = 600,
  }) {
    double xMax = suggestedXMax;
    double rorLo = -5, rorHi = 25; // 网页版 suggestedMin/Max
    for (final s in series) {
      if (!s.visible) continue;
      for (final p in s.points) {
        if (p.x > xMax) xMax = p.x;
        if (s.axis == 1) {
          if (p.y < rorLo) rorLo = p.y;
          if (p.y > rorHi) rorHi = p.y;
        }
      }
    }
    // X 向上取整到 300 的倍数（网页版 600/900/1200 档位的推广）
    xMax = math.max(300, (xMax / 300).ceil() * 300).toDouble();
    // ROR 轴留 1 格余量并取整
    rorLo = (rorLo - 1).floorToDouble();
    rorHi = (rorHi + 1).ceilToDouble();
    if (rorHi - rorLo < 10) rorHi = rorLo + 10;
    return ChartTransform(
      plotRect: plotRect,
      xMin: 0,
      xMax: xMax,
      yMin: 0,
      yMax: 300,
      rorMin: rorLo,
      rorMax: rorHi,
    );
  }

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _RoastChartPainter(
        series: series,
        annotations: annotations,
        suggestedXMax: suggestedXMax,
      ),
      child: const SizedBox.expand(),
    );
  }
}

class _RoastChartPainter extends CustomPainter {
  final List<ChartSeriesSpec> series;
  final List<EventAnnotation> annotations;
  final double suggestedXMax;

  _RoastChartPainter({
    required this.series,
    required this.annotations,
    required this.suggestedXMax,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final plotRect = RoastChart.plotRectOf(size);
    final t = RoastChart.computeTransform(
      plotRect: plotRect,
      series: series,
      suggestedXMax: suggestedXMax,
    );

    _paintGridAndAxes(canvas, size, t);
    for (final s in series) {
      if (s.visible && s.points.isNotEmpty) _paintSeries(canvas, t, s);
    }
    _paintAnnotations(canvas, t);
  }

  void _paintGridAndAxes(Canvas canvas, Size size, ChartTransform t) {
    final gridPaint = Paint()
      ..color = RoastColors.grid
      ..strokeWidth = 1;
    const textStyle = TextStyle(color: RoastColors.axisLabel, fontSize: 10);

    // 横向网格 + 左轴温度刻度（每 50°C）
    for (int temp = 0; temp <= 300; temp += 50) {
      final y = t.toPixel(0, temp.toDouble(), 0).dy;
      canvas.drawLine(
          Offset(t.plotRect.left, y), Offset(t.plotRect.right, y), gridPaint);
      _drawText(canvas, textStyle, '$temp',
          Offset(t.plotRect.left - 6, y), alignRight: true);
    }
    // 右轴 ROR 刻度（约 5 格）
    final rorStep = _niceStep(t.rorMax - t.rorMin, 5);
    const rorStyle = TextStyle(color: RoastColors.rorAxisLabel, fontSize: 10);
    for (double v = (t.rorMin / rorStep).ceil() * rorStep;
        v <= t.rorMax;
        v += rorStep) {
      final y = t.plotRect.bottom -
          (v - t.rorMin) / (t.rorMax - t.rorMin) * t.plotRect.height;
      _drawText(canvas, rorStyle, v.toStringAsFixed(0),
          Offset(t.plotRect.right + 6, y), alignRight: false);
    }
    // 纵向网格 + X 轴时间刻度
    final xStep = _niceTimeStep(t.xMax);
    for (double x = 0; x <= t.xMax; x += xStep) {
      final px = t.toPixel(x, 0, 0).dx;
      canvas.drawLine(
          Offset(px, t.plotRect.top), Offset(px, t.plotRect.bottom), gridPaint);
      _drawText(canvas, textStyle, formatTimeShort(x),
          Offset(px, t.plotRect.bottom + 14), center: true);
    }
    // 轴标题
    _drawText(canvas, textStyle, '温度 (°C)',
        Offset(4, t.plotRect.top - 2));
    _drawText(canvas, rorStyle, 'ROR (°C/min)',
        Offset(size.width - 4, t.plotRect.top - 2), alignRight: true);
  }

  double _niceStep(double range, int targetCount) {
    final raw = range / targetCount;
    final mag = math.pow(10, (math.log(raw) / math.ln10).floor()).toDouble();
    final norm = raw / mag;
    final step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  double _niceTimeStep(double xMax) {
    for (final step in [60.0, 120.0, 180.0, 300.0, 600.0]) {
      if (xMax / step <= 11) return step;
    }
    return 900;
  }

  void _paintSeries(Canvas canvas, ChartTransform t, ChartSeriesSpec s) {
    final path = Path();
    bool started = false;
    for (final p in s.points) {
      if (p.x < t.xMin || p.x > t.xMax) continue;
      final px = t.toPixel(p.x, p.y.clamp(
          s.axis == 0 ? t.yMin : t.rorMin, s.axis == 0 ? t.yMax : t.rorMax), s.axis);
      if (!started) {
        path.moveTo(px.dx, px.dy);
        started = true;
      } else {
        path.lineTo(px.dx, px.dy);
      }
    }
    if (!started) return;

    if (s.filled) {
      // 填充到该轴 0 值线（网页版 fill:'origin'）
      final zeroY = t
          .toPixel(0, (s.axis == 0 ? 0.0 : 0.0)
              .clamp(s.axis == 0 ? t.yMin : t.rorMin, s.axis == 0 ? t.yMax : t.rorMax), s.axis)
          .dy;
      final fillPath = Path.from(path)
        ..lineTo(t.toPixel(s.points.last.x.clamp(t.xMin, t.xMax), 0, s.axis).dx, zeroY)
        ..lineTo(t.toPixel(s.points.first.x.clamp(t.xMin, t.xMax), 0, s.axis).dx, zeroY)
        ..close();
      canvas.drawPath(
          fillPath,
          Paint()
            ..color = s.fillColor ?? s.color.withValues(alpha: 0.12)
            ..style = PaintingStyle.fill);
    }

    final paint = Paint()
      ..color = s.color
      ..strokeWidth = s.width
      ..style = PaintingStyle.stroke
      ..strokeJoin = StrokeJoin.round
      ..strokeCap = StrokeCap.round;
    if (s.dashed) {
      canvas.drawPath(_dashPath(path), paint);
    } else {
      canvas.drawPath(path, paint);
    }
  }

  /// 虚线化（对齐 Chart.js borderDash [6,4] 视觉）
  Path _dashPath(Path source, {List<double> pattern = const [6, 4]}) {
    final out = Path();
    for (final metric in source.computeMetrics()) {
      double dist = 0;
      int i = 0;
      bool draw = true;
      while (dist < metric.length) {
        final len = pattern[i % pattern.length];
        if (draw) {
          out.addPath(metric.extractPath(dist, dist + len), Offset.zero);
        }
        dist += len;
        i++;
        draw = !draw;
      }
    }
    return out;
  }

  void _paintAnnotations(Canvas canvas, ChartTransform t) {
    for (final ann in annotations) {
      if (ann.time < t.xMin || ann.time > t.xMax) continue;
      final x = t.toPixel(ann.time, 0, 0).dx;
      final linePaint = Paint()
        ..color = ann.color
        ..strokeWidth = 1.5;
      // 垂直虚线
      double y = t.plotRect.top;
      bool draw = true;
      while (y < t.plotRect.bottom) {
        final len = draw ? 5.0 : 4.0;
        if (draw) {
          canvas.drawLine(
              Offset(x, y), Offset(x, math.min(y + len, t.plotRect.bottom)), linePaint);
        }
        y += len;
        draw = !draw;
      }
      // 标签（深色底 + 彩色字，对齐网页版）
      final tp = TextPainter(
        text: TextSpan(
            text: ann.label,
            style: TextStyle(color: ann.color, fontSize: 11)),
        textDirection: TextDirection.ltr,
      )..layout();
      final labelX = math.min(x + 4, t.plotRect.right - tp.width - 8);
      final labelY = t.plotRect.top + 6;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
            Rect.fromLTWH(labelX, labelY, tp.width + 8, 16),
            const Radius.circular(3)),
        Paint()..color = const Color(0xCC0A0A0A),
      );
      tp.paint(canvas, Offset(labelX + 4, labelY + 2));
    }
  }

  void _drawText(Canvas canvas, TextStyle style, String text, Offset at,
      {bool alignRight = false, bool center = false}) {
    final tp = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: TextDirection.ltr,
    )..layout();
    double dx = at.dx;
    if (alignRight) dx -= tp.width;
    if (center) dx -= tp.width / 2;
    tp.paint(canvas, Offset(dx, at.dy - tp.height / 2));
  }

  @override
  bool shouldRepaint(_RoastChartPainter old) => true; // 数据帧高频，直接重绘
}

/// 图例行（可点击切换显隐，对齐 Chart.js legend 行为）
class ChartLegend extends StatelessWidget {
  final List<({String key, String label, Color color, bool visible})> items;
  final void Function(String key)? onToggle;

  const ChartLegend({super.key, required this.items, this.onToggle});

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 16,
      runSpacing: 4,
      alignment: WrapAlignment.center,
      children: [
        for (final item in items)
          GestureDetector(
            onTap: onToggle == null ? null : () => onToggle!(item.key),
            child: Opacity(
              opacity: item.visible ? 1 : 0.35,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 20,
                    height: 10,
                    decoration: BoxDecoration(
                      color: item.color,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(item.label,
                      style: const TextStyle(
                          color: RoastColors.textPrimary, fontSize: 12)),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
