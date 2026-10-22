"""Stateless native workbench API shared by FastAPI and the desktop sidecar.

Documents cross the boundary as base64 bytes, never server-side paths. The
original lines remain the only storage truth. Each edit returns a new snapshot;
failed edits cannot mutate the caller's document or the controller.
"""
from __future__ import annotations

import base64
import csv
from dataclasses import asdict
import hashlib
import io
import json
import math
from pathlib import Path
import sys

import numpy as np

from .native import core
from .native.catalog import load_catalog, parameter_info
from .native.overlays import cross_plot_points
from .native.phases import calculate_profile_phases, temperature_from_level
from . import analysis as native_analysis

MAX_BYTES = 8 * 1024 * 1024


def number(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("请输入有限数值")
    return result


def seconds(value):
    text = str(value).strip().replace("−", "-")
    if ":" not in text:
        return number(text)
    parts = text.split(":")
    if len(parts) != 2 or not number(parts[0]).is_integer() or not 0 <= number(parts[1]) < 60:
        raise ValueError("时间请输入秒数或 分:秒，秒部分应小于 60")
    return (-1 if parts[0].startswith("-") else 1) * (abs(number(parts[0])) * 60 + number(parts[1]))


def decode(payload):
    if not isinstance(payload, dict) or payload.get("kind") not in {"profile", "log"}:
        raise ValueError("请选择 .kpro 曲线或 .klog 日志")
    encoded = payload.get("data", "")
    if not isinstance(encoded, str) or len(encoded) > (MAX_BYTES * 4 // 3 + 8):
        raise ValueError("文件过大（最多 8 MiB）")
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > MAX_BYTES:
        raise ValueError("文件过大（最多 8 MiB）")
    return core.parse_document_bytes(raw, payload["kind"], Path(str(payload.get("name", "untitled"))).name)


def encode(document):
    raw = document.to_bytes()
    return {"kind": document.kind, "name": document.path.name if document.path else ("untitled.klog" if document.kind == "log" else "untitled.kpro"),
            "data": base64.b64encode(raw).decode("ascii"), "sha256": hashlib.sha256(raw).hexdigest()}


def pairs(xs, ys):
    # Plot every native sample. No decimation enters calculations or exports.
    return [[float(x), float(y) if math.isfinite(float(y)) else None] for x, y in zip(xs, ys)]


def view(document, preferences=None):
    prefs = preferences or {}
    result = {"document": encode(document), "readonly": document.readonly,
              "warnings": list(document.warnings), "metadata": document.metadata,
              "curves": {}, "axes": {}, "channels": [], "events": [], "event_records": []}
    if document.get("console_temperature_only") == "1":
        result["warnings"].append("由控制台温度曲线生成。风扇曲线与设备参数使用新建原生文件的默认参考；实测数据见记录通道。")
    for key in ("roast_profile", "fan_profile"):
        try:
            curve = document.get_curve(key).resolved()
            coords, _, _ = curve.studio_points(adaptive=True)
            result["curves"][key] = {"points": [list(p.native_values()) for p in curve.points], "samples": coords.tolist(),
                                     "ror": [[float(x), float(curve.ror_at(x))] for x in np.linspace(curve.points[0].x, curve.points[-1].x, 400)]}
            native_values = np.asarray([p.native_values() for p in curve.points])[:, [1, 3, 5]].flatten()
            native_values = native_values[native_values != 0]
            if not native_values.size:
                native_values = np.asarray([0.0])
            low, high = min(float(native_values.min()), float(coords[:, 1].min())), max(float(native_values.max()), float(coords[:, 1].max()))
            if key == "fan_profile":
                low, high = math.floor(low*.1/50)*500, math.ceil(high*.1/50)*500
            else:
                high = math.ceil(high/50)*50
            result["axes"][key] = {"y0": low, "y1": max(high, low+1), "x0": min(0, curve.points[0].x), "x1": max(curve.points[-1].x, math.ceil(float(coords[-1, 0]))+30)}
        except (ValueError, KeyError) as error:
            result["warnings"].append(str(error))
    try:
        result["phases"] = asdict(calculate_profile_phases(document))
    except (ValueError, KeyError, IndexError, OverflowError):
        result["phases"] = None
    # Preserve original mapping on unzoomed ranges, including cumulative steps.
    if len(result["curves"]) == 2:
        try:
            fan, roast = result["axes"]["fan_profile"], result["axes"]["roast_profile"]
            fan_range, roast_range = (fan["y0"]*.1, fan["y1"]*.1), (roast["y0"], roast["y1"])
            x, y = cross_plot_points(document, "fan_profile", fan_range, roast_range, apply_steps=bool(prefs.get("fan_steps")))
            result["fan_overlay"] = pairs(x, y)
            x, y = cross_plot_points(document, "roast_profile", roast_range, fan_range)
            result["temperature_overlay"] = pairs(x, y * 10)
            x, y = cross_plot_points(document, "fan_profile", fan_range, fan_range, apply_steps=True)
            result["fan_adjusted"] = pairs(x, y * 10)
        except (ValueError, OverflowError):
            pass
    if isinstance(document, core.LogDocument):
        for header in document.headers[1:]:
            values = core.get_display_series(document, header, prefs.get("smoothing", 1), prefs.get("multiplier", 1))
            if values is not None:
                result["channels"].append({"name": header, "data": pairs(document.get_series_time(header), values)})
        ror = core.calculate_ror(document)
        if ror is not None:
            result["channels"].append({"name": "独立重算 RoR", "data": pairs(document.get_series_time("temperature"), ror)})
        result["events"] = [asdict(e) | {"temperature": document.event_temperature(e.kind, e.time)} for e in document.events]
        result["event_records"] = [asdict(e) for e in document.event_records]
        result["metrics"] = core.calculate_metrics(document)
        metrics = result["metrics"]
        start_temp = result["curves"].get("roast_profile", {}).get("points", [[None, None]])[0][1]
        for name, first, last in (("drying", start_temp, metrics["colour_change_temperature"]),
                                  ("maillard", metrics["colour_change_temperature"], metrics["first_crack_temperature"]),
                                  ("development", metrics["first_crack_temperature"], metrics["final_temperature"])):
            metrics[name+"_increase"] = last-first if first is not None and last is not None else None
        result["sample_count"] = len(document.time)
        result["offsets"] = document.offsets.tolist()
    return result


def set_parameters(document, values, unit="C"):
    catalog = load_catalog()
    for key, value in values.items():
        info = parameter_info(key)
        if key not in catalog["parameters"] or info.get("readonly") or key in {"profile_schema_version", "native_schema_version", "roast_profile", "fan_profile"}:
            raise ValueError(f"{key} 是只读字段")
        if document.kind == "log" and key not in {"tasting_notes", "roast_date"}:
            raise ValueError("日志仅允许修改品尝笔记和烘焙日期")
        if document.kind == "profile" and not info.get("saved_in_profile", True):
            raise ValueError(f"{key} 不属于可写曲线参数")
        text = str(value)
        if info["type"] == "multiline":
            delimiter = "\v" if "\v" in document.get(key) and "\\v" not in document.get(key) else "\\v"
            text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", delimiter)
        elif text.strip():
            if info["type"] == "time":
                text = format(seconds(text), ".12g")
            elif info.get("temperature") or info.get("temperature_delta"):
                value = number(text)
                keep_zero = value == 0 and key in catalog.get("metadata", {}).get("keepZeroParameters", [])
                if unit == "F" and not keep_zero:
                    value = (value - (0 if info.get("temperature_delta") else 32)) / 1.8
                text = format(value, ".12g")
            elif info["type"] == "number":
                text = format(number(text), ".12g")
        document.set(key, text)


def target(nodes, time):
    if time <= nodes[0]["time"]:
        return nodes[0]["temperature"]
    for i in range(1, len(nodes)):
        a, b = nodes[i-1], nodes[i]
        if time <= b["time"]:
            t = (time-a["time"])/(b["time"]-a["time"])
            if len(nodes) < 4 or i in (1, len(nodes)-1):
                return a["temperature"]+(b["temperature"]-a["temperature"])*t
            p0, p1, p2, p3 = [p["temperature"] for p in nodes[i-2:i+2]]
            return .5*(2*p1+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)
    return nodes[-1]["temperature"]


def from_app(profile):
    nodes = profile["nodes"]
    if not 2 <= len(nodes) <= 64:
        raise ValueError("曲线需要 2–64 个节点")
    if len(nodes) == 2:
        nodes = [nodes[0], {"time": (number(nodes[0]["time"])+number(nodes[1]["time"]))/2,
                             "temperature": (number(nodes[0]["temperature"])+number(nodes[1]["temperature"]))/2}, nodes[1]]
    points = [core.CurvePoint(number(n["time"]), number(n["temperature"])) for n in nodes]
    # Exact Catmull-Rom -> cubic Bezier conversion, including linear edge spans.
    for i in range(1, len(points)):
        a, b = points[i-1], points[i]
        dt = b.x-a.x
        if dt <= 0:
            raise ValueError("节点时间必须严格递增")
        d0 = d1 = b.y-a.y
        if len(points) >= 4 and i not in (1, len(points)-1):
            d0 = (points[i].y-points[i-2].y)/2
            d1 = (points[i+1].y-points[i-1].y)/2
        a.right_x, a.right_y = a.x+dt/3, a.y+d0/3
        b.left_x, b.left_y = b.x-dt/3, b.y-d1/3
    document = core.new_profile()
    document.path = Path("console-profile.kpro")
    document.set("profile_short_name", "Console profile")
    document.set("console_profile_name", str(profile.get("name", "")).replace("\r", " ").replace("\n", " "))
    document.set("console_temperature_only", "1")
    document.set("expect_fc", "0")
    document.set("expect_colrchange", "0")
    document.set("profile_description", str(profile.get("description") or profile.get("name", "")).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\v"))
    document.set_curve("roast_profile", core.Curve(points))
    end = number(profile.get("end_temp") or nodes[-1]["temperature"])
    document.set("roast_levels", ",".join(format(end+i, ".12g") for i in range(-3, 4)))
    document.set("recommended_level", "3")
    return document


def from_record(record):
    """Expose existing console telemetry in the same offline analysis workspace."""
    snapshot = record.get("profile_snapshot")
    document = from_app(snapshot) if snapshot and snapshot.get("nodes") else core.new_profile()
    lines = document.to_bytes().decode("utf-8-sig").rstrip("\r\n").splitlines()
    if not snapshot:
        # Missing historic targets must not become an invented embedded profile.
        lines = ["profile_schema_version:1.8", "profile_short_name:Console log"]
    lines += ["native_schema_version:1.8", "roast_date:" + str(record.get("started_at") or ""),
              "tasting_notes:" + str((record.get("cup_feedback") or {}).get("notes", "")).replace("\n", "\\v"),
              "offsets\t0\t0\t0", "time\t#=temp\t=profile\t=actual_ROR"]
    samples = record.get("data") or []
    if not samples:
        raise ValueError("这份记录没有采样数据")
    for row in samples:
        if len(row) < 4:
            raise ValueError("记录采样缺少时间、温度、目标或 RoR")
        lines.append("\t".join(format(number(value), ".12g") for value in row[:4]) + "\t")
    mapping = {"yellowing": "colour_change", "drop": "roast_end"}
    for event in record.get("events", []):
        kind = mapping.get(event.get("type"), event.get("type"))
        if kind in core.TIME_EVENT_KINDS:
            lines.append(f"!{kind}:{number(event['time']):.12g}")
    return core.parse_document_bytes(("\r\n".join(lines) + "\r\n").encode("utf-8"), "log", "console-record.klog")


def to_app(document, name=None):
    source_name = name or document.get("console_profile_name") or document.get("profile_short_name") or "原生曲线副本"
    if isinstance(document, core.LogDocument):
        old_name = document.path.stem if document.path else "extracted"
        document = core.extract_profile(document)
        document.path = Path(old_name + ".kpro")
    curve = document.get_curve("roast_profile").resolved()
    first, last = curve.points[0].x, curve.points[-1].x
    if first != 0 or not 0 < last <= 7200:
        raise ValueError("导入控制曲线需从 0 秒开始，时长不超过 2 小时")
    # Adapt to the existing controller's interpolation, measure the error, and
    # refuse shapes that cannot be represented. Native bytes remain untouched.
    probe = np.unique(np.concatenate((np.linspace(0, last, max(1001, int(last*4)+1)), [p.x for p in curve.points])))
    desired = [curve.value_at(float(x)) for x in probe]
    times = sorted(set(float(x) for x in np.linspace(0, last, 12)))
    error = math.inf
    while len(times) <= 64:
        nodes = [{"time": t, "temperature": curve.value_at(t)} for t in times]
        errors = [abs(target(nodes, float(t))-y) for t, y in zip(probe, desired)]
        error = max(errors)
        if error <= .25:
            break
        worst = float(probe[int(np.argmax(errors))])
        if len(times) == 64 or worst in times:
            raise ValueError(f"现有控制曲线在 64 节点下误差为 {error:.3f}°C，超过 0.25°C；请先简化曲线")
        times = sorted([*times, worst])
    recommended = temperature_from_level(document.get("recommended_level"), document.get("roast_levels"))
    end_temp = recommended if recommended is not None and 0 < recommended <= max(desired) else nodes[-1]["temperature"]
    return {"name": source_name,
            "description": document.get("profile_description").replace("\\v", "\n"),
            "nodes": nodes, "end_temp": end_temp,
            "native_source": encode(document), "native_conversion": {"max_sample_error_c": error, "probe_count": len(probe), "tolerance_c": .25}}


def dispatch(request):
    if not isinstance(request, dict):
        raise ValueError("请求格式错误")
    action = request.get("action", "view")
    if action == "catalog":
        cat = load_catalog()
        return {key: cat[key] for key in ("parameters", "settings_categories", "about_categories", "metadata")}
    if action == "time":
        value = seconds(request["value"])
        return {"seconds": value, "time": f"{'-' if value < 0 else ''}{int(abs(value))//60}:{abs(value)%60:05.2f}"}
    if action == "new":
        document = core.new_profile()
    elif action == "from_record":
        document = from_record(request["record"])
    elif action == "from_app":
        document = from_app(request["profile"])
    else:
        document = decode(request.get("document"))
    if action == "analysis_context":
        return {"native": native_analysis.analysis_context(document, request.get("identity"))}
    if action == "analysis_samples":
        return native_analysis.analysis_samples(document, request)
    if action == "preview_native_proposal":
        candidate, proposal = native_analysis.preview_native_proposal(document, request.get("proposal"), request.get("identity"))
        return {"candidate": view(candidate, request.get("preferences")), "proposal": proposal}
    if action in {"curve", "parameters", "event", "merge", "extract"}:
        document._ensure_writable()
    if action == "curve":
        if document.kind != "profile":
            raise ValueError("日志曲线只读；请先提取曲线")
        key = request.get("curve", "roast_profile")
        if key not in {"roast_profile", "fan_profile"}:
            raise ValueError("无效曲线")
        curve = document.get_curve(key).resolved()
        op, index = request["operation"], int(request.get("index", 0))
        if op == "move":
            if index == 0 and number(request["x"]) != curve.points[0].x:
                raise ValueError("首节点时间锁定")
            curve.move_point(index, number(request["x"]), number(request["y"]))
        elif op == "handle":
            curve.move_handle(index, request["side"], number(request["x"]), number(request["y"]), bool(request.get("linked", True)))
        elif op == "insert":
            index = curve.insert_point(number(request["x"]), number(request["y"]))
        elif op == "delete":
            if index == 0 or len(curve.points) <= 3:
                raise ValueError("保留首节点及至少三个节点")
            curve.remove_point(index)
        elif op == "smooth":
            curve.smooth_point(index)
        elif op == "smooth_all":
            curve.smooth_all()
        elif op == "transform":
            curve = curve.transformed(**{k: number(request.get(k, default)) for k, default in (("time_scale", 1), ("time_offset", 0), ("value_scale", 1), ("value_offset", 0))})
        else:
            raise ValueError("未知曲线操作")
        if key == "fan_profile":
            core._validate_fan_limits(curve)
        document.set_curve(key, curve)
    elif action == "parameters":
        set_parameters(document, request["values"], request.get("unit", "C"))
    elif action == "event":
        if not isinstance(document, core.LogDocument):
            raise ValueError("事件编辑需要日志")
        if request.get("value") is None:
            document.remove_event(request["kind"])
        else:
            document.set_event(request["kind"], seconds(request["value"]))
    elif action == "merge":
        document = core.merge_profile(document, decode(request["source"]), request["groups"])
    elif action == "extract":
        document = core.extract_profile(document)
        document.path = Path("extracted.kpro")
    elif action == "area":
        args = {k: number(v) for k, v in request.get("range", {}).items() if v != ""}
        return {"area": core.curve_area(document.get_curve(request.get("curve", "roast_profile")), **args)}
    elif action == "to_app":
        return {"profile": to_app(document, request.get("name"))}
    elif action == "export":
        if request.get("format") == "csv":
            if not isinstance(document, core.LogDocument):
                raise ValueError("CSV 导出需要日志")
            output = io.StringIO(newline="")
            writer = csv.writer(output)
            writer.writerow([core._normal_header(h) for h in document.headers])
            writer.writerows(document._samples)
            return {"data": base64.b64encode(output.getvalue().encode("utf-8-sig")).decode("ascii"), "mime": "text/csv", "suffix": ".csv"}
        document._ensure_writable()
        if request.get("changed", True):
            document._validate_for_save()
        return {"data": encode(document)["data"], "mime": "application/octet-stream", "suffix": ".klog" if document.kind == "log" else ".kpro"}
    elif action not in {"view", "new", "from_app", "from_record"}:
        raise ValueError("未知工作台操作")
    result = view(document, request.get("preferences"))
    if action == "curve":
        result["selected_index"] = min(index, len(curve.points)-1)
    return result


def main():
    # UTF-8 JSON lines, one response per request; no file or network operations.
    for line in sys.stdin.buffer:
        try:
            if len(line) > MAX_BYTES * 3:
                raise ValueError("请求过大")
            response = {"ok": True, "result": dispatch(json.loads(line))}
        except Exception as error:
            response = {"ok": False, "error": str(error)}
        sys.stdout.write(json.dumps(response, ensure_ascii=True, allow_nan=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
