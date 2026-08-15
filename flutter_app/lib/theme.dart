/// 主题 —— 对齐网页版苹果风深色配色（style.css + Chart.js 配置里的色板）
library;

import 'package:flutter/material.dart';

/// 全局字体（用户指定宋体；其他平台回退到各自的宋体系/衬线字体）
const String kFontFamily = 'SimSun';
const List<String> kFontFallback = [
  'NSimSun', // Windows 新宋体
  'Songti SC', // macOS
  'Noto Serif CJK SC', // Linux/Android 衬线
  'Source Han Serif SC',
];

class RoastColors {
  // 背景层级
  static const bg = Color(0xFF0A0A0A);
  static const surface = Color(0xFF141414);
  static const card = Color(0xFF1C1C1E);
  static const cardHover = Color(0xFF2C2C2E);
  static const border = Color(0xFF2A2A2A);

  // 文字
  static const textPrimary = Color(0xFFE5E5E5);
  static const textSecondary = Color(0xFFA3A3A3);
  static const textMuted = Color(0xFF737373);

  // 数据线（与 Chart.js 配置一致）
  static const pv = Color(0xFF00E676); // 温度
  static const sv = Color(0xFFFF5252); // 设定温度
  static const profile = Color(0xFF9E9E9E); // 目标曲线
  static const ror = Color(0xFF448AFF); // ROR
  static const rorPreview = Color(0xFF82B1FF); // ROR 预览

  // 网格/坐标轴
  static const grid = Color(0xFF1F1F1F);
  static const axisLabel = Color(0xFFA3A3A3);
  static const rorAxisLabel = Color(0xFF60A5FA);

  // 阶段
  static const drying = Color(0xFF3B82F6);
  static const maillard = Color(0xFFF59E0B);
  static const development = Color(0xFF22C55E);

  // 操作
  static const accent = Color(0xFF0A84FF);
  static const danger = Color(0xFFEF4444);
  static const dropOrange = Color(0xFFF97316);

  // 对比模式
  static const compareA = Color(0xFFFF9800);
  static const compareB = Color(0xFFE040FB);

  // 事件颜色（对齐 app.js eventColors）
  static const Map<String, Color> event = {
    'charge': Color(0xFF22C55E),
    'yellowing': Color(0xFFF59E0B),
    'first_crack': Color(0xFFEF4444),
    'first_crack_end': Color(0xFFEF4444),
    'second_crack': Color(0xFFA855F7),
    'second_crack_end': Color(0xFFA855F7),
    'drop': Color(0xFF3B82F6),
  };
}

ThemeData buildRoastTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: RoastColors.bg,
    colorScheme: const ColorScheme.dark(
      primary: RoastColors.accent,
      surface: RoastColors.surface,
      error: RoastColors.danger,
    ),
    textTheme: base.textTheme.apply(
      fontFamily: kFontFamily,
      fontFamilyFallback: kFontFallback,
    ),
    primaryTextTheme: base.primaryTextTheme.apply(
      fontFamily: kFontFamily,
      fontFamilyFallback: kFontFallback,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: RoastColors.surface,
      foregroundColor: RoastColors.textPrimary,
      elevation: 0,
    ),
    cardColor: RoastColors.card,
    dividerColor: RoastColors.border,
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: RoastColors.cardHover,
      contentTextStyle: TextStyle(color: RoastColors.textPrimary),
      behavior: SnackBarBehavior.floating,
    ),
    sliderTheme: base.sliderTheme.copyWith(
      activeTrackColor: RoastColors.accent,
      thumbColor: RoastColors.accent,
      inactiveTrackColor: RoastColors.border,
    ),
  );
}
