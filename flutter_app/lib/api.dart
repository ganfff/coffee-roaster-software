/// REST API 客户端 —— 对齐 roaster/src/web/web_api.py 的端点
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

class RoasterApi {
  String baseUrl; // 例如 http://192.168.1.50:8000
  RoasterApi(this.baseUrl);

  Uri _u(String path) => Uri.parse('$baseUrl$path');

  Future<RoasterStatus> getStatus() async {
    final r = await http.get(_u('/api/v1/status')).timeout(const Duration(seconds: 5));
    return RoasterStatus.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  // ---- 控制 ----
  Future<void> saveAndClear() => _post('/api/v1/control/save_and_clear');
  Future<void> discardAndClear() => _post('/api/v1/control/discard_and_clear');

  Future<void> _post(String path, [Object? body]) async {
    await http
        .post(_u(path),
            headers: {'Content-Type': 'application/json'},
            body: body == null ? null : jsonEncode(body))
        .timeout(const Duration(seconds: 5));
  }

  // ---- 曲线库 ----
  Future<List<RoastProfile>> listProfiles() async {
    final r = await http.get(_u('/api/v1/profiles')).timeout(const Duration(seconds: 5));
    return (jsonDecode(r.body) as List)
        .map((p) => RoastProfile.fromJson(Map<String, dynamic>.from(p as Map)))
        .toList();
  }

  Future<RoastProfile?> getProfile(String id) async {
    final r = await http
        .get(_u('/api/v1/profiles/${Uri.encodeComponent(id)}'))
        .timeout(const Duration(seconds: 5));
    if (r.statusCode != 200) return null;
    return RoastProfile.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  Future<bool> deleteProfile(String id) async {
    final r = await http
        .delete(_u('/api/v1/profiles/${Uri.encodeComponent(id)}'))
        .timeout(const Duration(seconds: 5));
    return r.statusCode == 200;
  }

  /// 保存曲线（新建）。返回新曲线 id，失败返回 null。
  Future<String?> saveProfile(RoastProfile p) async {
    final r = await http
        .post(_u('/api/v1/profiles'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(p.toJson()))
        .timeout(const Duration(seconds: 8));
    if (r.statusCode != 200) return null;
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    return j['success'] == true ? j['id']?.toString() : null;
  }

  /// 导入曲线 JSON（后端自动去 id）
  Future<String?> importProfile(Map<String, dynamic> json) async {
    final r = await http
        .post(_u('/api/v1/profiles/import'),
            headers: {'Content-Type': 'application/json'}, body: jsonEncode(json))
        .timeout(const Duration(seconds: 8));
    if (r.statusCode != 200) return null;
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    return j['success'] == true ? j['id']?.toString() : null;
  }

  Future<String> exportProfileJson(String id) async {
    final r = await http
        .get(_u('/api/v1/profiles/${Uri.encodeComponent(id)}/export'))
        .timeout(const Duration(seconds: 5));
    return r.body;
  }

  // ---- 记录 ----
  Future<List<RecordSummary>> listRecords() async {
    final r = await http.get(_u('/api/v1/records')).timeout(const Duration(seconds: 8));
    return (jsonDecode(r.body) as List)
        .map((e) => RecordSummary.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<RoastRecord?> getRecord(String sessionId) async {
    final r = await http
        .get(_u('/api/v1/records/${Uri.encodeComponent(sessionId)}'))
        .timeout(const Duration(seconds: 8));
    if (r.statusCode != 200) return null;
    return RoastRecord.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  Future<String> exportRecordCsv(String sessionId) async {
    final r = await http
        .get(_u('/api/v1/records/${Uri.encodeComponent(sessionId)}/export/csv'))
        .timeout(const Duration(seconds: 8));
    return r.body;
  }

  Future<String> exportRecordJson(String sessionId) async {
    final r = await http
        .get(_u('/api/v1/records/${Uri.encodeComponent(sessionId)}/export/json'))
        .timeout(const Duration(seconds: 8));
    return r.body;
  }
}
