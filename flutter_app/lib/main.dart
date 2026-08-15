/// 应用入口：主题、路由骨架、全局 toast / 保存确认订阅
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'pages/main_page.dart';
import 'pages/profiles_page.dart';
import 'pages/records_page.dart';
import 'pages/settings_page.dart';
import 'socket.dart';
import 'state.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final baseUrl =
      prefs.getString('backend_url') ?? 'http://localhost:8000';
  final api = RoasterApi(baseUrl);
  final socket = RoasterSocket(baseUrl);
  final store = RoasterStore(api: api, socket: socket, prefs: prefs);
  store.initBackendConfig();
  runApp(RoastApp(store: store, prefs: prefs));
}

class RoastApp extends StatelessWidget {
  final RoasterStore store;
  final SharedPreferences prefs;
  const RoastApp({super.key, required this.store, required this.prefs});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '咖啡烘焙机控制台',
      debugShowCheckedModeBanner: false,
      theme: buildRoastTheme(),
      // 全局字号放大（Text 控件统一缩放；图表手绘文字在 painter 里单独放大）
      builder: (context, child) {
        final mq = MediaQuery.of(context);
        return MediaQuery(
          data: mq.copyWith(textScaler: const TextScaler.linear(kFontScale)),
          child: child!,
        );
      },
      home: AppShell(store: store, prefs: prefs),
    );
  }
}

class AppShell extends StatefulWidget {
  final RoasterStore store;
  final SharedPreferences prefs;
  const AppShell({super.key, required this.store, required this.prefs});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _tab = 0;
  StreamSubscription? _toastSub;
  StreamSubscription? _saveSub;

  RoasterStore get store => widget.store;

  @override
  void initState() {
    super.initState();
    store.attach();
    store.refreshProfiles();

    _toastSub = store.toasts.listen((msg) {
      if (!mounted) return;
      final messenger = ScaffoldMessenger.maybeOf(context);
      messenger?.hideCurrentSnackBar();
      messenger?.showSnackBar(SnackBar(
        content: Text(msg),
        duration: const Duration(milliseconds: 1500),
      ));
    });

    // COOLING → 保存确认（对齐网页版 confirm 弹窗）
    _saveSub = store.saveConfirmRequests.listen((sid) async {
      if (!mounted) return;
      final save = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          backgroundColor: RoastColors.card,
          title: const Text('烘焙结束'),
          content: const Text('是否保存此锅烘焙记录？'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('不保存'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('保存'),
            ),
          ],
        ),
      );
      if (save == true) {
        store.saveAndClear();
      } else {
        store.discardAndClear();
      }
    });
  }

  @override
  void dispose() {
    _toastSub?.cancel();
    _saveSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      MainPage(store: store),
      ProfilesPage(store: store),
      RecordsPage(store: store),
      SettingsPage(store: store),
    ];

    return LayoutBuilder(builder: (context, constraints) {
      final wide = constraints.maxWidth >= 720;
      const destinations = [
        (Icons.local_fire_department, '烘焙'),
        (Icons.show_chart, '曲线'),
        (Icons.history, '记录'),
        (Icons.settings, '设置'),
      ];
      final body = IndexedStack(index: _tab, children: pages);

      if (wide) {
        return Scaffold(
          body: Row(children: [
            NavigationRail(
              backgroundColor: RoastColors.surface,
              selectedIndex: _tab,
              onDestinationSelected: (i) => setState(() => _tab = i),
              labelType: NavigationRailLabelType.all,
              destinations: [
                for (final d in destinations)
                  NavigationRailDestination(
                      icon: Icon(d.$1), label: Text(d.$2)),
              ],
            ),
            const VerticalDivider(width: 1, color: RoastColors.border),
            Expanded(child: body),
          ]),
        );
      }
      return Scaffold(
        body: body,
        bottomNavigationBar: NavigationBar(
          backgroundColor: RoastColors.surface,
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          destinations: [
            for (final d in destinations)
              NavigationDestination(icon: Icon(d.$1), label: d.$2),
          ],
        ),
      );
    });
  }
}
