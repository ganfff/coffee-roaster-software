"""Pure analysis/validation. No hardware access or controller mutations."""
import math
from .models import RoastProfile


def validate_candidate(payload: dict, max_temperature: float, source=None, locked_until=None):
    errors = []
    try:
        profile = RoastProfile.model_validate(payload)
        maximum = float(max_temperature)
        if not math.isfinite(maximum) or maximum <= 0:
            raise ValueError("设备温度限制无效")
        maximum = min(300.0, maximum)
        if not profile.name.strip():
            raise ValueError("请输入曲线名称")
        if len(profile.nodes) > 64 or profile.nodes[0].time != 0:
            raise ValueError("曲线需从 0 秒开始，且不超过 64 个节点")
        if any(not math.isfinite(n.time) or not math.isfinite(n.temperature) for n in profile.nodes):
            raise ValueError("节点必须为有限数值")
        if not math.isfinite(profile.end_temp):
            raise ValueError("结束温度必须为有限数值")
        values = [n.temperature for n in profile.nodes]
        for i in range(2, len(profile.nodes) - 1):
            p0, p1, p2, p3 = [n.temperature for n in profile.nodes[i-2:i+2]]
            a = .5 * (-p0 + 3*p1 - 3*p2 + p3)
            b = .5 * (2*p0 - 5*p1 + 4*p2 - p3)
            c = .5 * (-p0 + p2)
            roots = []
            if abs(a) < 1e-12:
                if abs(b) > 1e-12:
                    roots.append(-c / (2*b))
            else:
                disc = 4*b*b - 12*a*c
                if disc >= 0:
                    roots.extend([(-2*b + math.sqrt(disc))/(6*a), (-2*b - math.sqrt(disc))/(6*a)])
            values.extend(((a*u+b)*u+c)*u+p1 for u in roots if 0 < u < 1)
        minimum, peak = min(values), max(values)
        if minimum < -1e-8 or peak > maximum + 1e-8:
            errors.append(f"插值温度范围 {minimum:.2f}–{peak:.2f}°C 超出 0–{maximum:g}°C")
        if profile.end_temp > maximum or (profile.end_temp > 0 and profile.end_temp > peak):
            errors.append("自动结束温度超出设备限制或目标曲线范围")
        if locked_until is not None:
            bound = float(locked_until)
            if not math.isfinite(bound) or bound < 0 or source is None:
                raise ValueError("锁定区段需有效来源曲线与时间")
            original = RoastProfile.model_validate(source)
            if len(original.nodes)>64:
                raise ValueError("锁定来源曲线不超过 64 个节点")
            if bound > original.nodes[-1].time or bound > profile.nodes[-1].time:
                raise ValueError("锁定时间超出曲线时长")
            cuts = sorted({0., bound, *[n.time for n in original.nodes + profile.nodes if n.time <= bound]})
            if abs(original.get_target_temp(0)-profile.get_target_temp(0))>1e-6:
                errors.append("候选改变了锁定起点")
            # Each union interval contains two cubics; equality at four points proves equality.
            for left, right in zip(cuts, cuts[1:]):
                if any(abs(original.get_target_temp(left+(right-left)*u)-profile.get_target_temp(left+(right-left)*u)) > 1e-6 for u in (0, 1/3, 2/3, 1)):
                    errors.append("候选改变了锁定区段（含样条插值）")
                    break
        return {"valid": not errors, "errors": errors, "min_temperature": minimum, "max_temperature": peak, "max_safe_temperature_c": maximum}
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        return {"valid": False, "errors": [str(exc)]}
