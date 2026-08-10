/// 样条插值与工具函数测试 —— 数值基准与网页版 utils.js 对齐
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:roaster_app/spline.dart';

void main() {
  group('catmullRom', () {
    test('端点处通过控制点', () {
      expect(catmullRom(10, 20, 30, 40, 0), closeTo(20, 1e-9));
      expect(catmullRom(10, 20, 30, 40, 1), closeTo(30, 1e-9));
    });
    test('线性数据插值为线性', () {
      // 等差数列的 Catmull-Rom 退化为直线
      expect(catmullRom(0, 10, 20, 30, 0.5), closeTo(15, 1e-9));
    });
  });

  group('getSplineTemp', () {
    final nodes = [
      ProfileNode(0, 30),
      ProfileNode(60, 100),
      ProfileNode(120, 135),
      ProfileNode(180, 155),
      ProfileNode(270, 188),
      ProfileNode(360, 203),
      ProfileNode(435, 212),
    ];

    test('起点前返回首节点温度', () {
      expect(getSplineTemp(nodes, -5), 30);
      expect(getSplineTemp(nodes, 0), 30);
    });
    test('终点后返回末节点温度', () {
      expect(getSplineTemp(nodes, 500), 212);
    });
    test('恰好命中控制点', () {
      for (final n in nodes) {
        expect(getSplineTemp(nodes, n.time), closeTo(n.temperature, 1e-6),
            reason: 't=${n.time}');
      }
    });
    test('空表与单节点', () {
      expect(getSplineTemp([], 10), 0);
    });
    test('两节点线性插值', () {
      final two = [ProfileNode(0, 100), ProfileNode(100, 200)];
      expect(getSplineTemp(two, 50), closeTo(150, 1e-9));
    });
    test('首段使用虚拟点（与网页版一致，不是线性）', () {
      // 首段 i=0: p0=p1=30（虚拟点），结果应与线性不同但端点收敛
      final v = getSplineTemp(nodes, 30);
      expect(v, greaterThan(30));
      expect(v, lessThan(100));
      // 与手算 Catmull-Rom(p0=30,p1=30,p2=100,p3=135,t=0.5) 一致
      final expected = catmullRom(30, 30, 100, 135, 0.5);
      expect(v, closeTo(expected, 1e-9));
    });
  });

  group('splineInterpolate', () {
    test('步长与端点补齐', () {
      final nodes = [ProfileNode(0, 100), ProfileNode(97, 200)];
      final pts = splineInterpolate(nodes, 5);
      expect(pts.first.x, 0);
      expect(pts.last.x, 97); // 末尾补齐到终点
      expect(pts.last.y, closeTo(200, 1e-9));
    });
    test('少于2节点原样映射', () {
      final pts = splineInterpolate([ProfileNode(10, 150)], 5);
      expect(pts.length, 1);
      expect(pts.first.x, 10);
      expect(pts.first.y, 150);
    });
  });

  group('buildRORDataset / computeSegmentROR', () {
    test('分段差分：中点与斜率', () {
      final nodes = [
        ProfileNode(0, 100),
        ProfileNode(60, 160), // +60°C/60s = 60 °C/min
        ProfileNode(120, 160), // 0
      ];
      final ror = buildRORDataset(nodes);
      expect(ror.length, 2);
      expect(ror[0].x, 30);
      expect(ror[0].y, closeTo(60, 1e-9));
      expect(ror[1].x, 90);
      expect(ror[1].y, closeTo(0, 1e-9));

      final seg = computeSegmentROR(nodes);
      expect(seg, [closeTo(60, 1e-9), closeTo(0, 1e-9)]);
    });
    test('零时距防守', () {
      final nodes = [ProfileNode(60, 100), ProfileNode(60, 200)];
      expect(buildRORDataset(nodes).first.y, 0);
    });
  });

  group('格式化与吸附', () {
    test('formatTime / formatTimeShort', () {
      expect(formatTime(0), '00:00');
      expect(formatTime(65), '01:05');
      expect(formatTime(600), '10:00');
      expect(formatTimeShort(65), '1:05');
      expect(formatTimeShort(435), '7:15');
    });
    test('snapValue', () {
      expect(snapValue(102.3, 5), 100);
      expect(snapValue(103.0, 5), 105);
      expect(snapValue(100.26, 0.5), closeTo(100.5, 1e-9));
    });
    test('round1', () {
      expect(round1(100.26), closeTo(100.3, 1e-9));
      expect(round1(-3.05), closeTo(-3.1, 1e-9));
    });
  });
}
