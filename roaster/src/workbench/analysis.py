"""Bounded, hardware-free AI views and proposals for native documents.

The model sees named numerical channels and known configuration, never the
lossless byte attachment. A proposal is data: preview builds a separate
document and has no access to files, a controller, or an active profile.
"""
from __future__ import annotations

from dataclasses import asdict
import hashlib
import math
from pathlib import Path

import numpy as np

from .native import core
from .native.catalog import load_catalog
from .native.phases import calculate_profile_phases

MAX_AI_POINTS = 64
MAX_SAMPLES = 600
CURVE_NAMES = {"temperature": "roast_profile", "fan": "fan_profile"}


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("候选曲线坐标必须是有限数字")
    return float(value)


def identity(document, value=None):
    """Bind a request to bytes; UI also checks its session and monotonic revision."""
    digest = hashlib.sha256(document.to_bytes()).hexdigest()
    result = {"sha256": digest}
    if value is not None:
        if not isinstance(value, dict) or value.get("sha256") != digest:
            raise ValueError("原生文件快照已变化，请重新分析")
        session = value.get("document_session_id")
        if not isinstance(session, str) or not session or len(session) > 128:
            raise ValueError("原生文件会话标识无效")
        result["document_session_id"] = session
        for key in ("generation", "revision"):
            number = value.get(key)
            if type(number) is not int or number < 0:
                raise ValueError("原生文件修订标识无效")
            result[key] = number
    return result


def _unit(channel):
    name = core._normal_header(channel).lower()
    if "ror" in name or "rate_of_rise" in name:
        return "°C/min"
    if "temp" in name or name in {"bt", "et", "profile"}:
        return "°C"
    if "fan" in name or "rpm" in name:
        return "RPM"
    if "volt" in name:
        return "V"
    return "原始文件单位"


def _series(document, channel):
    if not isinstance(document, core.LogDocument):
        raise ValueError("原始采样需要 .klog 日志")
    if channel == "recomputed_ror":
        values = core.calculate_ror(document)
        if values is None:
            raise ValueError("此日志缺少有效温度或时间顺序，不能独立重算 RoR")
        return document.get_series_time("temperature"), values
    if channel not in document.headers[1:]:
        raise ValueError("请选择快照中实际存在的通道")
    return document.get_series_time(channel), document.get_series(channel)


def analysis_samples(document, request):
    source_identity = identity(document, request.get("identity"))
    channel = request.get("channel")
    xs, ys = _series(document, channel)
    start = _finite(request.get("from", float(np.min(xs)) if len(xs) else 0))
    end = _finite(request.get("to", float(np.max(xs)) if len(xs) else start))
    if end < start:
        raise ValueError("采样时间窗结束不能早于开始")
    limit = request.get("limit", MAX_SAMPLES)
    if type(limit) is not int or not 1 <= limit <= MAX_SAMPLES:
        raise ValueError("一次可读取 1–600 个原始采样")
    selected = np.flatnonzero((xs >= start) & (xs <= end))
    rows = [[float(xs[i]), float(ys[i])] for i in selected[:limit]]
    return {"identity": source_identity, "channel": channel, "unit": _unit(channel),
            "samples": rows, "matching_count": len(selected), "truncated": len(selected) > limit,
            "time_axis": "原始通道时间加该通道 offsets，单位秒；未排序、未平滑、未乘显示倍率"}


def _summary(xs, ys):
    if not len(xs):
        return {"count": 0, "buckets": []}
    # Contiguous, bounded groups retain extrema and their exact channel times.
    # Do not sort anomalous input or imply that it was repaired.
    groups = np.array_split(np.arange(len(xs)), min(48, len(xs)))
    buckets = []
    for indexes in groups:
        low = indexes[int(np.argmin(ys[indexes]))]
        high = indexes[int(np.argmax(ys[indexes]))]
        buckets.append({"from": float(xs[indexes[0]]), "to": float(xs[indexes[-1]]),
                        "min": [float(xs[low]), float(ys[low])],
                        "max": [float(xs[high]), float(ys[high])],
                        "last": [float(xs[indexes[-1]]), float(ys[indexes[-1]])]})
    return {"count": len(xs), "from": float(xs[0]), "to": float(xs[-1]),
            "min": float(np.min(ys)), "max": float(np.max(ys)), "buckets": buckets}


def _phases(document):
    try:
        return asdict(calculate_profile_phases(document))
    except (ValueError, KeyError, IndexError, OverflowError):
        return None


def analysis_context(document, source_identity=None):
    catalog = load_catalog()
    # Configuration categories contain known roast settings, not machine IDs,
    # paths, calibration blobs, arbitrary user keys, or runtime credentials.
    allowed = {key for group in catalog["settings_categories"] for key in group["keys"]}
    allowed.update({"profile_short_name", "profile_designer", "profile_description", "recommended_level",
                    "expect_fc", "expect_colrchange", "tasting_notes", "roast_date"})
    parameters = {key: {"value": value[:2000], "label": catalog["parameters"].get(key, {}).get("label", key),
                        "unit": catalog["parameters"].get(key, {}).get("unit", "")}
                  for key, value in document.metadata.items() if key in allowed}
    result = {"kind": document.kind, "identity": identity(document, source_identity),
              "readonly": document.readonly, "warnings": list(document.warnings),
              "can_propose": document.kind == "log" or not document.readonly,
              "parameters": parameters, "curves": {}, "channels": [], "events": [],
              "units": {"time": "s", "temperature": "°C", "fan": "RPM", "ror": "°C/min"},
              "proposal_limits": {"min_points": 3, "max_points": MAX_AI_POINTS,
                                  "max_end_sec": 7200, "temperature_c": [0, 300], "fan_rpm": [8000, 18000]},
              "boundary": "仅离线分析与候选；AI 温度设计范围不代表设备许可。进入控制曲线库另按实际设备上限校验。"}
    for label, key in CURVE_NAMES.items():
        try:
            curve = document.get_curve(key).resolved()
            result["curves"][label] = {"points": [list(p.native_values()) for p in curve.points[:256]],
                                      "point_count": len(curve.points), "points_truncated": len(curve.points) > 256,
                                      "duration_sec": curve.points[-1].x - curve.points[0].x,
                                      "range": curve_extrema(curve)}
        except (ValueError, KeyError):
            continue
    result["phases"] = _phases(document)
    if isinstance(document, core.LogDocument):
        result["channel_count"] = len(document.headers)-1
        result["channels_truncated"] = len(document.headers)-1 > 64
        for index, header in enumerate(document.headers[1:65], 1):
            if len(header) > 128:
                result["warnings"].append("过长的原生通道名称未发送给 AI；原始文件保留。")
                continue
            xs, ys = _series(document, header)
            result["channels"].append({"id": header, "unit": _unit(header), "source": "recorded",
                                       "offset_sec": float(document.offsets[index]), **_summary(xs, ys)})
        derived = core.calculate_ror(document)
        if derived is not None:
            result["channels"].append({"id": "recomputed_ror", "unit": "°C/min", "source": "derived",
                                       **_summary(document.get_series_time("temperature"), derived)})
        result["events"] = [asdict(event) | {"temperature_c": document.event_temperature(event.kind, event.time)}
                            for event in document.events]
        result["event_records"] = [asdict(event) for event in document.event_records[:512]]
        result["event_record_count"] = len(document.event_records)
        result["event_records_truncated"] = len(document.event_records) > 512
        result["metrics"] = core.calculate_metrics(document)
        result["time_order_valid"] = bool(len(document.time) < 2 or np.all(np.diff(document.time) > 0))
        result["sample_policy"] = "通道独立 offsets；记录 RoR 与独立重算分开。缺失事件留空，显示平滑和倍率不进入原始采样。"
    return result


def _roots(a, b, c):
    if abs(a) < 1e-12:
        return [] if abs(b) < 1e-12 else [-c / b]
    discriminant = b*b - 4*a*c
    if discriminant < 0:
        return []
    root = math.sqrt(discriminant)
    return [(-b-root)/(2*a), (-b+root)/(2*a)]


def _coefficients(a, b, c, d):
    return -a+3*b-3*c+d, 3*a-6*b+3*c, -3*a+3*b, a


def curve_extrema(curve):
    """Exact cubic y extrema in parameter t, including both physical anchors."""
    values = []
    for index in range(len(curve.points)-1):
        a, b, c, d = curve._segment_controls(index)
        aa, bb, cc, dd = _coefficients(a[1], b[1], c[1], d[1])
        values.extend([a[1], d[1]])
        values.extend(((aa*t+bb)*t+cc)*t+dd for t in _roots(3*aa, 2*bb, cc) if 0 < t < 1)
    return {"min": min(values), "max": max(values)}


def validate_native_curve(points, name, first_time=0):
    if not isinstance(points, list) or not 3 <= len(points) <= MAX_AI_POINTS:
        raise ValueError("AI 原生候选需要 3–64 个六参数节点")
    if any(not isinstance(point, list) or len(point) != 6 for point in points):
        raise ValueError("每个原生节点需包含时间、数值、左柄时间/数值、右柄时间/数值")
    curve = core.Curve(core.CurvePoint(*[_finite(v) for v in point]) for point in points)
    if curve.points[-1].x > 7200 or any(abs(v) > 100000 for point in points for v in point):
        raise ValueError("AI 原生候选时长不超过 7200 秒，坐标绝对值不超过 100000")
    if curve.points[0].x != first_time:
        raise ValueError("AI 候选必须保留首节点时间")
    if curve.points[0].left_x != 0 or curve.points[0].left_y != 0 or curve.points[-1].right_x != 0 or curve.points[-1].right_y != 0:
        raise ValueError("曲线端点外侧控制柄必须保留零占位")
    curve = curve.resolved()
    curve.validate_for_save()
    for index in range(len(curve.points)-1):
        a, b, c, d = curve._segment_controls(index)
        aa, bb, cc, _ = _coefficients(a[0], b[0], c[0], d[0])
        times = [0., 1.]
        if abs(aa) > 1e-12:
            vertex = -bb/(3*aa)
            if 0 < vertex < 1:
                times.append(vertex)
        if min((3*aa*t+2*bb)*t+cc for t in times) < -1e-8:
            raise ValueError("候选控制柄使曲线时间倒退，不能可靠求解")
    bounds = curve_extrema(curve)
    low, high = (8000, 18000) if name == "fan" else (0, 300)
    if bounds["min"] < low-1e-8 or bounds["max"] > high+1e-8:
        raise ValueError(f"{name} 整段贝塞尔范围 {bounds['min']:.3f}–{bounds['max']:.3f} 超出 AI 设计范围 {low}–{high}")
    return curve, bounds


def preview_native_proposal(document, proposal, source_identity=None):
    source_identity = identity(document, source_identity)
    if document.kind == "profile" and document.readonly:
        raise ValueError("只读原生曲线仅支持分析；请使用受支持的可写 .kpro 设计候选")
    if not isinstance(proposal, dict) or not any(key in proposal for key in CURVE_NAMES):
        raise ValueError("候选至少包含温度或风扇曲线")
    if set(proposal) - {"temperature", "fan", "rationale"}:
        raise ValueError("AI 原生候选仅允许温度、风扇和调整说明")
    rationale = proposal.get("rationale", "")
    if not isinstance(rationale, str) or len(rationale) > 4000:
        raise ValueError("候选说明最多 4000 字符")
    warnings = []
    separate = document.kind == "log" or document.readonly
    if separate:
        result = None
        if not document.readonly and isinstance(document, core.LogDocument):
            try:
                result = core.extract_profile(document)
                result._validate_for_save()
            except (ValueError, KeyError):
                result = None
        if result is None:
            result = core.new_profile()
            warnings.append("新建受支持的 .kpro；未提出的曲线和参数使用默认参考，不补造历史目标或采样。")
        result.path = Path("ai-next-roast.kpro")
        warnings.append("来源文件保留；采用后是独立曲线草稿，不修改日志或解除原文件只读。")
    else:
        result = core.parse_document_bytes(document.to_bytes(), "profile", document.path)
    changes = {}
    for label, key in CURVE_NAMES.items():
        if label not in proposal:
            continue
        before = result.get_curve(key).resolved()
        curve, bounds = validate_native_curve(proposal[label], label, before.points[0].x)
        result.set_curve(key, curve)
        overlap_end = min(before.points[-1].x, curve.points[-1].x)
        overlap_start = max(before.points[0].x, curve.points[0].x)
        probes = np.linspace(overlap_start, overlap_end, 201)
        deviations = [abs(before.value_at(float(x))-curve.value_at(float(x))) for x in probes]
        changes[label] = {"before_points": len(before.points), "after_points": len(curve.points),
                          "before_end_sec": before.points[-1].x, "after_end_sec": curve.points[-1].x,
                          "range": bounds, "max_sample_change": max(deviations), "probe_count": len(probes)}
    result._validate_for_save()
    before_phases, after_phases = _phases(document), _phases(result)
    phase_changes = {key: {"before": (before_phases or {}).get("phases", {}).get(key),
                           "after": (after_phases or {}).get("phases", {}).get(key)}
                     for key in ("drying", "maillard", "development")}
    return result, {"identity": source_identity, "separate_document": separate,
                    "changes": changes, "phase_changes": phase_changes, "warnings": warnings, "rationale": rationale,
                    "boundary": "仅更新原生草稿；保存与进入曲线库须单独操作，不应用到控制器。"}
