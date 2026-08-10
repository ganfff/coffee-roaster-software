/// 样条插值与格式化工具 —— 从 roaster/static/js/utils.js 逐行移植。
/// 行为必须与网页版完全一致（同一曲线的渲染形状、ROR 数值）。
library;

/// 曲线节点（时间秒, 温度°C）
class ProfileNode {
  double time;
  double temperature;
  ProfileNode(this.time, this.temperature);

  factory ProfileNode.fromJson(Map<String, dynamic> j) => ProfileNode(
        (j['time'] as num).toDouble(),
        (j['temperature'] as num).toDouble(),
      );

  Map<String, dynamic> toJson() => {'time': time, 'temperature': temperature};

  ProfileNode clone() => ProfileNode(time, temperature);
}

/// 图表数据点（x=秒, y=数值）
class ChartPoint {
  final double x;
  final double y;
  const ChartPoint(this.x, this.y);
}

/// Catmull-Rom 样条插值核心公式
double catmullRom(double p0, double p1, double p2, double p3, double t) {
  return 0.5 *
      ((2 * p1) +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * (t * t) +
          (-p0 + 3 * p1 - 3 * p2 + p3) * (t * t * t));
}

/// 计算任意时刻的样条温度值。
/// 控制点不足4个时退化为线性插值；边界段使用虚拟点保持样条连续性。
double getSplineTemp(List<ProfileNode> nodes, double elapsed) {
  if (nodes.isEmpty) return 0;
  if (elapsed <= nodes[0].time) return nodes[0].temperature;
  final n = nodes.length;
  for (int i = 0; i < n - 1; i++) {
    final prev = nodes[i];
    final curr = nodes[i + 1];
    if (prev.time <= elapsed && elapsed <= curr.time) {
      if (n < 4) {
        final ratio = (elapsed - prev.time) / (curr.time - prev.time);
        return prev.temperature + ratio * (curr.temperature - prev.temperature);
      }
      double p0, p3;
      final p1 = prev.temperature;
      final p2 = curr.temperature;
      if (i == 0) {
        p0 = p1;
        p3 = nodes[i + 2].temperature;
      } else if (i == n - 2) {
        p0 = nodes[i - 1].temperature;
        p3 = p2;
      } else {
        p0 = nodes[i - 1].temperature;
        p3 = nodes[i + 2].temperature;
      }
      final t = (elapsed - prev.time) / (curr.time - prev.time);
      return catmullRom(p0, p1, p2, p3, t);
    }
  }
  return nodes[n - 1].temperature;
}

/// 对控制点进行密集样条插值，生成渲染用数据点（默认每5秒一个点）
List<ChartPoint> splineInterpolate(List<ProfileNode> nodes, [double stepSec = 5]) {
  if (nodes.length < 2) {
    return nodes.map((n) => ChartPoint(n.time, n.temperature)).toList();
  }
  final result = <ChartPoint>[];
  final lastTime = nodes[nodes.length - 1].time;
  for (double t = 0; t <= lastTime; t += stepSec) {
    result.add(ChartPoint(t, getSplineTemp(nodes, t)));
  }
  if (result.isEmpty || result.last.x < lastTime) {
    result.add(ChartPoint(lastTime, nodes[nodes.length - 1].temperature));
  }
  return result;
}

/// 从温度节点构建 ROR 数据集（简单分段差分法）
/// 每两个控制点之间计算 dT/dt×60，取该段中点作为 ROR 数据点。
List<ChartPoint> buildRORDataset(List<ProfileNode> nodes) {
  if (nodes.length < 2) return [];
  final data = <ChartPoint>[];
  for (int i = 0; i < nodes.length - 1; i++) {
    final dt = nodes[i + 1].time - nodes[i].time;
    final dT = nodes[i + 1].temperature - nodes[i].temperature;
    final ror = dt > 0 ? (dT / dt * 60) : 0.0;
    data.add(ChartPoint(nodes[i].time + dt / 2, ror));
  }
  return data;
}

/// 每段 ROR 值（编辑器右侧面板用）
List<double> computeSegmentROR(List<ProfileNode> nodes) {
  final ror = <double>[];
  for (int i = 0; i < nodes.length - 1; i++) {
    final dt = nodes[i + 1].time - nodes[i].time;
    final dT = nodes[i + 1].temperature - nodes[i].temperature;
    ror.add(dt > 0 ? dT / dt * 60 : 0.0);
  }
  return ror;
}

/// 秒数 → MM:SS（补零）
String formatTime(num seconds) {
  final m = (seconds / 60).floor();
  final s = (seconds % 60).floor();
  return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
}

/// 秒数 → m:ss（分钟不补零）
String formatTimeShort(num seconds) {
  final m = (seconds / 60).floor();
  final s = (seconds % 60).floor();
  return '$m:${s.toString().padLeft(2, '0')}';
}

/// 值吸附到指定粒度
double snapValue(double value, double granularity) {
  return (value / granularity).round() * granularity;
}

double round1(double v) => (v * 10).round() / 10;
