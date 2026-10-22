"""Lossless native Kaffelogic documents and UI-independent roast calculations.

Native lines are the source of truth.  Only an explicitly edited line is
regenerated; importing and exporting an untouched document preserves every byte.
The numerical model is deliberately separate from the Qt application.
"""

from __future__ import annotations

import csv
import hashlib
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP, localcontext
import io
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Iterable

import numpy as np


class NativeFormatError(ValueError):
    """A malformed native record, with its original file and one-based line."""

    def __init__(self, message: str, path: Path | str | None = None, line: int | None = None):
        self.path = Path(path) if path is not None else None
        self.line = line
        location = str(self.path) if self.path is not None else "文档"
        if line is not None:
            location += f":{line}"
        super().__init__(f"{location}: {message}")


class ReadOnlyFormatError(NativeFormatError):
    """Writing an unverified schema is forbidden."""


@dataclass
class CurvePoint:
    x: float
    y: float
    left_x: float | None = None
    left_y: float | None = None
    right_x: float | None = None
    right_y: float | None = None

    def __post_init__(self) -> None:
        self.x, self.y = float(self.x), float(self.y)
        for field in ("left_x", "left_y", "right_x", "right_y"):
            setattr(self, field, float(0.0 if getattr(self, field) is None else getattr(self, field)))

    def native_values(self) -> tuple[float, ...]:
        return (self.x, self.y, self.left_x, self.left_y, self.right_x, self.right_y)

    def copy(self) -> "CurvePoint":
        return CurvePoint(*self.native_values())


@dataclass(frozen=True)
class BezierValue:
    x: float
    y: float
    gradient: float
    second_derivative: float


def _gradient(a: tuple[float, float], b: tuple[float, float]) -> float:
    return (b[1] - a[1]) / (b[0] - a[0]) if b[0] != a[0] else float.fromhex("0x1.fffffffffffffp+1023")


def _line_point(origin: tuple[float, float], gradient: float, distance: float, left: bool) -> tuple[float, float]:
    dx = math.sqrt(distance * distance / (1 + gradient * gradient))
    dy = dx * gradient
    if left:
        dx, dy = -dx, -dy
    return origin[0] + dx, origin[1] + dy


def _bezier_value(t: float, a, b, c, d) -> BezierValue:
    # Coefficient and arithmetic order follow the recovered reference bytecode.
    c1x, c1y = d[0] - 3.0 * c[0] + 3.0 * b[0] - a[0], d[1] - 3.0 * c[1] + 3.0 * b[1] - a[1]
    c2x, c2y = 3.0 * c[0] - 6.0 * b[0] + 3.0 * a[0], 3.0 * c[1] - 6.0 * b[1] + 3.0 * a[1]
    c3x, c3y = 3.0 * b[0] - 3.0 * a[0], 3.0 * b[1] - 3.0 * a[1]
    x = c1x * t * t * t + c2x * t * t + c3x * t + a[0]
    y = c1y * t * t * t + c2y * t * t + c3y * t + a[1]
    dx = 3.0 * c1x * t * t + 2.0 * c2x * t + c3x
    dy = 3.0 * c1y * t * t + 2.0 * c2y * t + c3y
    if dx == 0:
        dx = 1e-7
        gradient = c1y / c1x if dy == 0 and c1x != 0 else dy / dx
    else:
        gradient = dy / dx
    divisor = (t * (3 * c1x * t + 2 * c2x) + c3x) ** 2
    if divisor == 0:
        divisor = 1e-8
    derivative = (6.0 * c1y * c2x * t * t + 6.0 * c1y * c3x * t
                  - 6.0 * c2y * c1x * t * t + 2.0 * c2y * c3x
                  - 6.0 * c3y * c1x * t - 2.0 * c3y * c2x) / divisor
    return BezierValue(x, y, gradient, derivative / dx)


def _legacy_round(value: float, digits: int = 0) -> float:
    """Python 2 round's halfway-away-from-zero rule used by Studio."""
    exact = Decimal.from_float(float(value))
    with localcontext() as context:
        context.prec = max(28, abs(exact.adjusted()) + abs(digits) + 20)
        return float(exact.quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


class Curve:
    """Cubic Bézier anchors and their incoming/outgoing control points."""

    def __init__(self, points: Iterable[CurvePoint]):
        self.points = [point.copy() for point in points]
        self.validate()

    def copy(self) -> "Curve":
        return Curve(self.points)

    def resolved(self) -> "Curve":
        """Fill native (0,0) control sentinels with Studio's 0.3 geometry."""
        curve = self.copy()
        points = curve.points
        for i in range(1, len(points) - 1):
            a, b, c = points[i - 1], points[i], points[i + 1]
            ab = math.hypot(b.x - a.x, b.y - a.y)
            bc = math.hypot(c.x - b.x, c.y - b.y)
            distance_ratio = bc / ab if ab else 0.0
            cprime = (b.x - (b.x - a.x) * distance_ratio, b.y - (b.y - a.y) * distance_ratio)
            midpoint = ((c.x + cprime[0]) / 2, (c.y + cprime[1]) / 2)
            if math.hypot(midpoint[0] - b.x, midpoint[1] - b.y) < 0.001:
                dividend = _gradient((a.x, a.y), (c.x, c.y))
                bisector = -1 / dividend if dividend != 0 else float("inf")
            else:
                bisector = _gradient(midpoint, (b.x, b.y))
            left = (a.x, a.y) if bisector == 0 else _line_point((b.x, b.y), -1 / bisector, ab * .3, True)
            right = (b.x, b.y) if bisector == 0 else _line_point((b.x, b.y), -1 / bisector, bc * .3, False)
            left_was_zero = (b.left_x, b.left_y) == (0, 0)
            if left_was_zero:
                b.left_x, b.left_y = left
            if (b.right_x, b.right_y) == (0, 0):
                b.right_x, b.right_y = right
                if not left_was_zero:
                    distance = math.hypot(b.right_x - b.x, b.right_y - b.y)
                    b.right_x, b.right_y = _line_point((b.x, b.y), _gradient((b.left_x, b.left_y), (b.x, b.y)), distance, b.left_x >= b.x)
        first, second = points[:2]
        if (first.right_x, first.right_y) == (0, 0):
            control = (second.left_x, second.left_y)
            other = (second.x, second.y) if control[0] < first.x else control
            first.right_x, first.right_y = _line_point((first.x, first.y), _gradient((first.x, first.y), other), math.hypot(second.x - first.x, second.y - first.y) * .3, False)
        penultimate, last = points[-2:]
        if (last.left_x, last.left_y) == (0, 0):
            control = (penultimate.right_x, penultimate.right_y)
            other = (penultimate.x, penultimate.y) if control[0] > last.x else control
            last.left_x, last.left_y = _line_point((last.x, last.y), _gradient(other, (last.x, last.y)), math.hypot(last.x - penultimate.x, last.y - penultimate.y) * .3, True)
        first.left_x = first.left_y = 0.0
        last.right_x = last.right_y = 0.0
        return curve

    def validate_for_save(self, min_time_interval: float = 1.0) -> None:
        self.validate()
        for i, point in enumerate(self.points):
            if point.x < 0:
                raise ValueError("节点时间不能小于零")
            if i and _legacy_round(point.x, 1) - _legacy_round(self.points[i - 1].x, 1) < min_time_interval:
                raise ValueError(f"节点 {i + 1} 与前一节点至少需间隔 {min_time_interval:g} 秒")
            if (point.left_x, point.left_y) != (0, 0):
                minimum = 5.0 if i == len(self.points) - 1 else .1
                if point.x - point.left_x + .01 < minimum:
                    raise ValueError(f"节点 {i + 1} 的左控制点需至少提前 {minimum - .01:g} 秒")
            if (point.right_x, point.right_y) != (0, 0) and point.right_x - point.x + .01 < .1:
                raise ValueError(f"节点 {i + 1} 的右控制点需至少延后 0.09 秒")

    def _segment_controls(self, index: int):
        first, last = self.points[index:index + 2]
        a, d = (first.x, first.y), (last.x, last.y)
        b, c = (first.right_x, first.right_y), (last.left_x, last.left_y)
        return a, a if b == (0, 0) else b, d if c == (0, 0) else c, d

    def evaluate(self, time: float, segment: int | None = None) -> BezierValue:
        """Exact reference x-to-t bisection (32 iterations, 1e-6 x tolerance)."""
        time = _finite_number(time)
        if not self.points[0].x <= time <= self.points[-1].x:
            raise ValueError("查询时间超出曲线范围")
        if segment is None:
            segment = max(0, min(len(self.points) - 2, int(np.searchsorted([p.x for p in self.points], time, side="left")) - 1))
        a, b, c, d = self._segment_controls(segment)
        if not a[0] <= time <= d[0]:
            raise ValueError("查询时间超出所选曲线段")
        if time == a[0]:
            t = 0.0
        elif time == d[0]:
            t = 1.0
        else:
            low, high, t = 0.0, 1.0, .5
            c1 = d[0] - 3.0 * c[0] + 3.0 * b[0] - a[0]
            c2 = 3.0 * c[0] - 6.0 * b[0] + 3.0 * a[0]
            c3 = 3.0 * b[0] - 3.0 * a[0]
            for _ in range(32):
                t = (low + high) / 2.0
                t2, t3 = t * t, t * t * t
                result = c1 * t3 + c2 * t2 + c3 * t + a[0]
                if abs(result - time) < 1e-6:
                    break
                if result < time:
                    low = t
                else:
                    high = t
        return _bezier_value(t, a, b, c, d)

    def value_at(self, time: float) -> float:
        return self.evaluate(time).y

    def ror_at(self, time: float) -> float:
        return self.evaluate(time).gradient * 60

    def studio_points(self, *, adaptive: bool = False) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Original editor's integer-second display interpolation (100 t steps).

        Arrays contain (time,value), (time,°C/min), (time,°C/min²) pairs.
        The final anchor is drawn separately, as in the original editor.
        """
        coordinates, rates, derivatives = [], [], []
        for segment in range(len(self.points) - 1):
            a, b, c, d = self._segment_controls(segment)
            steps = max(20, int(math.hypot(d[0] - a[0], d[1] - a[1]))) if adaptive else 100
            precalculated = [_bezier_value(i / float(steps), a, b, c, d) for i in range(steps + 1)]
            start, end = int(_legacy_round(a[0])), int(_legacy_round(d[0]))
            if start >= end:
                p = precalculated[0]
                coordinates.append((p.x, p.y))
                rates.append((p.x, p.gradient * 60))
                derivatives.append((p.x, p.second_derivative * 3600))
                continue
            index = 0
            for x in range(start, end):
                while index + 1 < len(precalculated) and precalculated[index + 1].x < x:
                    index += 1
                first, last = precalculated[index:index + 2]
                ratio = (x - first.x) / (last.x - first.x) if last.x != first.x else 0.0
                y = first.y + ratio * (last.y - first.y)
                gradient = first.gradient + ratio * (last.gradient - first.gradient)
                derivative = first.second_derivative + ratio * (last.second_derivative - first.second_derivative)
                coordinates.append((x, y))
                rates.append((x, gradient * 60))
                derivatives.append((x, derivative * 3600))
        return (np.asarray(coordinates, dtype=float).reshape((-1, 2)),
                np.asarray(rates, dtype=float).reshape((-1, 2)),
                np.asarray(derivatives, dtype=float).reshape((-1, 2)))

    def validate(self) -> None:
        if len(self.points) < 2:
            raise ValueError("曲线至少需要两个节点")
        values = np.asarray([p.native_values() for p in self.points], dtype=float)
        if not np.isfinite(values).all():
            raise ValueError("曲线坐标必须是有限数值")
        if np.any(np.diff(values[:, 0]) <= 0):
            raise ValueError("节点时间必须严格递增")

    def move_point(self, index: int, x: float, y: float) -> None:
        x, y = _finite_number(x), _finite_number(y)
        if x < 0:
            raise ValueError("节点时间不能小于零")
        if index and x <= self.points[index - 1].x:
            raise ValueError("节点时间必须晚于前一个节点")
        if index + 1 < len(self.points) and x >= self.points[index + 1].x:
            raise ValueError("节点时间必须早于后一个节点")
        point = self.points[index]
        dx, dy = x - point.x, y - point.y
        # The unused end handles are native zero sentinels and must stay zero.
        if index != 0:
            point.left_x += dx
            point.left_y += dy
        if index != len(self.points) - 1:
            point.right_x += dx
            point.right_y += dy
        point.x, point.y = x, y

    def insert_point(self, x: float, y: float) -> int:
        x, y = _finite_number(x), _finite_number(y)
        if x < 0:
            raise ValueError("节点时间不能小于零")
        position = int(np.searchsorted([p.x for p in self.points], x))
        if position < len(self.points) and abs(self.points[position].x - x) < 1e-9:
            raise ValueError("节点时间不能重复")
        left = self.points[position - 1] if position else None
        right = self.points[position] if position < len(self.points) else None
        incoming = ((x - left.x) / 3) if left else 0
        outgoing = ((right.x - x) / 3) if right else 0
        point = CurvePoint(x, y, x - incoming if left else 0, y if left else 0,
                           x + outgoing if right else 0, y if right else 0)
        if left is None:
            old = self.points[0]
            old.left_x, old.left_y = old.x - (old.x - x) / 3, old.y
        if right is None:
            old = self.points[-1]
            old.right_x, old.right_y = old.x + (x - old.x) / 3, old.y
        self.points.insert(position, point)
        self.validate()
        return position

    def remove_point(self, index: int) -> None:
        if len(self.points) <= 2:
            raise ValueError("曲线至少需要保留两个节点")
        self.points.pop(index)
        self.points[0].left_x = self.points[0].left_y = 0.0
        self.points[-1].right_x = self.points[-1].right_y = 0.0

    def move_handle(self, index: int, side: str, x: float, y: float, linked: bool = True) -> None:
        """Move a native control point, matching Studio's continuous-point balance.

        The opposite handle keeps its length and rotates onto the same tangent.
        Studio's 0.1/5 second endpoint guards and handle swapping are retained.
        ``linked=False`` represents the original non-continuous-point mode.
        """
        if side not in ("left", "right"):
            raise ValueError("控制点方向应为 left 或 right")
        if not 0 <= index < len(self.points):
            raise IndexError(index)
        if (index == 0 and side == "left") or (index == len(self.points) - 1 and side == "right"):
            raise ValueError("端点外侧的零占位控制点不能编辑")
        p = self.points[index].copy()
        setattr(p, side + "_x", _finite_number(x))
        setattr(p, side + "_y", _finite_number(y))
        if linked:
            other = "right" if side == "left" else "left"
            ox, oy = getattr(p, other + "_x"), getattr(p, other + "_y")
            if (ox, oy) != (0, 0):
                dy = abs(p.y - oy)
                ratio = abs(p.y - getattr(p, side + "_y")) / dy if dy else 1.0
                threshold = .1 * max(1.0, ratio)
                hx, hy = getattr(p, side + "_x"), getattr(p, side + "_y")
                if abs(p.x - hx) < threshold:
                    hx = p.x - threshold if side == "left" else p.x + threshold
                    setattr(p, side + "_x", hx)
                distance = math.hypot(p.x - ox, p.y - oy)
                gradient = _gradient((hx, hy), (p.x, p.y)) if side == "left" else _gradient((p.x, p.y), (hx, hy))
                opposite_left = hx >= p.x if side == "left" else hx > p.x
                bx, by = _line_point((p.x, p.y), gradient, distance, opposite_left)
                setattr(p, other + "_x", bx)
                setattr(p, other + "_y", by)
                if (side == "left" and hx > p.x) or (side == "right" and hx < p.x):
                    p.left_x, p.right_x = p.right_x, p.left_x
                    p.left_y, p.right_y = p.right_y, p.left_y
            elif side == "left":
                p.left_x = min(p.left_x, p.x - 5.0)
            else:
                p.right_x = max(p.right_x, p.x + .1)
        if not all(math.isfinite(v) for v in p.native_values()):
            raise ValueError("控制点坐标必须是有限数值")
        self.points[index] = p

    def smooth_point(self, index: int) -> None:
        """Rebuild the selected tangent with the recovered 0.3 geometry."""
        if not 0 <= index < len(self.points):
            raise IndexError(index)
        candidate = self.copy()
        p = candidate.points[index]
        p.left_x = p.left_y = p.right_x = p.right_y = 0.0
        self.points[index] = candidate.resolved().points[index]

    def smooth_all(self) -> None:
        """Reset all control points, then run Studio's automatic geometry."""
        self.points = Curve(CurvePoint(p.x, p.y) for p in self.points).resolved().points

    def transformed(self, time_scale: float = 1.0, time_offset: float = 0.0,
                    value_scale: float = 1.0, value_offset: float = 0.0) -> "Curve":
        """Return an affine transform, retaining unused native zero handles."""
        mx, cx, my, cy = map(_finite_number, (time_scale, time_offset, value_scale, value_offset))
        if mx <= 0:
            raise ValueError("时间缩放必须大于零")
        points = []
        for original in self.points:
            p = original.copy()
            p.x, p.y = p.x * mx + cx, p.y * my + cy
            for side in ("left", "right"):
                x, y = getattr(p, side + "_x"), getattr(p, side + "_y")
                if (x, y) != (0, 0):
                    setattr(p, side + "_x", x * mx + cx)
                    setattr(p, side + "_y", y * my + cy)
            points.append(p)
        transformed = Curve(points)
        if transformed.points[0].x < 0:
            raise ValueError("变换后的节点时间不能小于零")
        return transformed

    def sample(self, count: int = 500) -> tuple[np.ndarray, np.ndarray]:
        """Sample each cubic segment in its actual parametric coordinates."""
        self.validate()
        effective = self.resolved()
        if count < 2:
            raise ValueError("采样数至少为二")
        # Allocate exactly count samples when count can contain every anchor.
        durations = np.diff([p.x for p in self.points])
        interval_total = max(count, len(self.points)) - 1
        extra = interval_total - len(durations)
        weights = durations / durations.sum() * extra
        intervals = np.ones(len(durations), dtype=int) + np.floor(weights).astype(int)
        remaining = interval_total - int(intervals.sum())
        if remaining:
            order = np.argsort(-(weights - np.floor(weights)), kind="stable")
            intervals[order[:remaining]] += 1
        xs, ys = [], []
        for index, (first, last) in enumerate(zip(effective.points, effective.points[1:])):
            t = np.linspace(0.0, 1.0, int(intervals[index]) + 1)
            a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3
            sx = a * first.x + b * first.right_x + c * last.left_x + d * last.x
            sy = a * first.y + b * first.right_y + c * last.left_y + d * last.y
            if index:
                sx, sy = sx[1:], sy[1:]
            xs.append(sx)
            ys.append(sy)
        return np.concatenate(xs), np.concatenate(ys)


@dataclass(frozen=True)
class RoastEvent:
    kind: str
    time: float

    @property
    def time_seconds(self) -> float:
        return self.time


@dataclass
class _Line:
    text: str
    ending: str


def _finite_number(value: str | float) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("数值必须是有限值")
    return number


def _number_text(value: float) -> str:
    return format(_finite_number(value), ".12g")


def _validate_fan_limits(curve: Curve) -> None:
    values = np.append(curve.studio_points()[0][:, 1], curve.points[-1].y)
    if not np.isfinite(values).all() or np.min(values) < 8000 or np.max(values) > 18000:
        raise ValueError("整条风扇曲线必须保持在 8000 至 18000 RPM")


def _normal_header(value: str) -> str:
    return value.lstrip("#=@&~^").strip()


def _atomic_write(path: Path, data: bytes) -> None:
    """Replace only after flushing a complete same-directory temporary file."""
    path = path.absolute()
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class NativeDocument:
    kind = "native"

    def __init__(self, lines: list[_Line], path: Path | str | None = None, bom: bool = False):
        self.path = Path(path) if path is not None else None
        self._lines = lines
        self._bom = bom
        self.warnings: list[str] = []
        self.readonly = False
        self._read_metadata()
        self._original_fan_field = self.get("fan_profile")

    @property
    def newline(self) -> str:
        return next((line.ending for line in self._lines if line.ending), "\r\n")

    def _read_metadata(self) -> None:
        self._metadata: dict[str, str] = {}
        self._metadata_indices: dict[str, list[int]] = {}
        for index, line in enumerate(self._lines):
            if ":" in line.text and not line.text.startswith("!") and "\t" not in line.text.split(":", 1)[0]:
                key, value = line.text.split(":", 1)
                if key:
                    self._metadata[key] = value
                    self._metadata_indices.setdefault(key, []).append(index)

    @property
    def metadata(self) -> dict[str, str]:
        return dict(self._metadata)

    def get(self, key: str, default: str = "") -> str:
        return self._metadata.get(key, default)

    def _ensure_writable(self) -> None:
        # A metadata edit may have changed a version after construction. Never
        # let an outdated readonly flag permit unverified native writes.
        self._check_versions()
        if self.readonly:
            raise ReadOnlyFormatError("此格式版本尚未验证；只能查看和导出采样 CSV", self.path)

    def _validate_for_save(self) -> None:
        self.validate()

    def _insert_line(self, index: int, text: str) -> None:
        newline = self.newline
        at_end_without_newline = bool(index == len(self._lines) and self._lines and not self._lines[-1].ending)
        if at_end_without_newline:
            self._lines[-1].ending = newline
        self._lines.insert(index, _Line(text, "" if at_end_without_newline else newline))
        self._read_metadata()

    def set(self, key: str, value: object) -> None:
        self._ensure_writable()
        value = str(value)
        if not key or any(c in key for c in ":\r\n\t") or key.startswith("!"):
            raise ValueError("无效的字段名")
        if any(c in value for c in "\r\n"):
            raise ValueError("字段值不能包含换行；原生描述使用 \\v")
        indices = self._metadata_indices.get(key, [])
        if indices:
            self._lines[indices[-1]].text = f"{key}:{value}"
            self._read_metadata()
        else:
            index = next((i for i, line in enumerate(self._lines)
                          if not line.text or line.text.startswith(("time\t", "offsets\t", "!"))), len(self._lines))
            self._insert_line(index, f"{key}:{value}")

    def _check_versions(self) -> None:
        # All three profiles have passed the original shipped parser oracle.
        checks = [("profile_schema_version", {"1.4", "1.6", "1.8"})]
        if self.kind == "log":
            checks.append(("native_schema_version", {"1.8"}))
        for key, supported in checks:
            value = self.get(key)
            if value and value not in supported:
                self.readonly = True
                message = f"{key}={value} 尚未通过兼容验证，文档以只读方式打开。"
                if message not in self.warnings:
                    self.warnings.append(message)
        if not self.get("profile_schema_version"):
            self.readonly = True
            message = "缺少 profile_schema_version，文档以只读方式打开。"
            if message not in self.warnings:
                self.warnings.append(message)
        if self.kind == "log" and not self.get("native_schema_version"):
            self.readonly = True
            message = "缺少 native_schema_version，文档以只读方式打开。"
            if message not in self.warnings:
                self.warnings.append(message)

    def to_bytes(self) -> bytes:
        self.validate()
        text = "".join(line.text + line.ending for line in self._lines)
        return (b"\xef\xbb\xbf" if self._bom else b"") + text.encode("utf-8")

    def validate(self) -> None:
        """Subclasses validate their edited state before serialization."""

    def save(self, path: Path | str | None = None) -> Path:
        self._ensure_writable()
        target = Path(path) if path is not None else self.path
        if target is None:
            raise ValueError("请指定保存路径")
        self._validate_for_save()
        _atomic_write(target, self.to_bytes())
        self.path = target
        return target

    def _parse_curve(self, key: str) -> Curve:
        value = self.get(key)
        if not value:
            raise NativeFormatError(f"缺少曲线字段 {key}", self.path)
        line = self._metadata_indices[key][-1] + 1
        try:
            values = [_finite_number(item) for item in value.split(",")]
            if len(values) < 12 or len(values) % 6:
                raise ValueError("每个节点应包含六个数值，且曲线至少包含两个节点")
            return Curve(CurvePoint(*values[i:i + 6]) for i in range(0, len(values), 6))
        except ValueError as error:
            raise NativeFormatError(f"{key}: {error}", self.path, line) from error

    def get_curve(self, key: str) -> Curve:
        if key not in ("roast_profile", "fan_profile"):
            raise KeyError(key)
        return self._parse_curve(key).resolved()

    def set_curve(self, key: str, curve: Curve) -> None:
        if key not in ("roast_profile", "fan_profile"):
            raise KeyError(key)
        self._ensure_writable()
        if self.kind == "profile" and len(curve.points) < 3:
            raise ValueError("原生曲线至少需要三个节点")
        curve.validate_for_save()
        old_points = self.get_curve(key).points
        if key == "fan_profile" and [p.native_values() for p in curve.points] != [p.native_values() for p in old_points]:
            # Reject invalid edits before they can enter undo snapshots, while
            # retaining the ability to archive an untouched historical curve.
            _validate_fan_limits(curve)
        old_tokens = self.get(key).split(",")
        old_by_anchor = {(point.x, point.y): (point, old_tokens[i * 6:(i + 1) * 6])
                         for i, point in enumerate(old_points)}
        result = []
        for i, point in enumerate(curve.points):
            old = (old_points[i], old_tokens[i * 6:(i + 1) * 6]) if len(curve.points) == len(old_points) else old_by_anchor.get((point.x, point.y))
            if old is None:
                result.extend(_number_text(value) for value in point.native_values())
            else:
                previous, tokens = old
                result.extend(token if value == previous_value else _number_text(value)
                              for value, previous_value, token in zip(point.native_values(), previous.native_values(), tokens))
        self.set(key, ",".join(result))


class ProfileDocument(NativeDocument):
    kind = "profile"

    def __init__(self, lines: list[_Line], path: Path | str | None = None, bom: bool = False):
        super().__init__(lines, path, bom)
        self._check_versions()
        self.validate()

    def validate(self) -> None:
        for index, line in enumerate(self._lines):
            if line.text.strip() and ":" not in line.text and not line.text.startswith("#"):
                raise NativeFormatError("应为 key:value 字段", self.path, index + 1)
        self._parse_curve("roast_profile")
        self._parse_curve("fan_profile")

    def _validate_for_save(self) -> None:
        self.validate()
        for key in ("roast_profile", "fan_profile"):
            curve = self.get_curve(key)
            if len(curve.points) < 3:
                raise NativeFormatError(f"{key}: 原生曲线至少需要三个节点", self.path)
            try:
                curve.validate_for_save()
            except ValueError as error:
                raise NativeFormatError(f"{key}: {error}", self.path) from error
        if not self.get("profile_short_name").isascii():
            raise NativeFormatError("原版要求曲线短名称仅使用 ASCII 字符；文件路径可以使用中文", self.path)
        if self.get("profile_schema_version") == "1.4" and not self.get("profile_short_name").strip():
            raise NativeFormatError("schema 1.4 必须填写曲线短名称；空名称需要至少 schema 1.5，当前不自动升版", self.path)
        # These checks apply only to fields actually present in the document;
        # reading/to_bytes never fills defaults or rewrites historical files.
        for key, lower, upper in (("roast_end_by_time_ratio", 0.0, 1.0), ("reference_load_size", 50.0, 200.0)):
            if key in self._metadata:
                try:
                    number = _finite_number(self.get(key))
                except ValueError as error:
                    raise NativeFormatError(f"{key}: 应为有限数值", self.path) from error
                if not lower <= number <= upper:
                    raise NativeFormatError(f"{key}: 必须在 {lower:g} 至 {upper:g} 之间", self.path)
        for zone in range(1, 4):
            start, end = f"zone{zone}_time_start", f"zone{zone}_time_end"
            if start in self._metadata or end in self._metadata:
                try:
                    first, last = _finite_number(self.get(start, "0")), _finite_number(self.get(end, "0"))
                except ValueError as error:
                    raise NativeFormatError(f"zone{zone}: 区域时间应为有限秒数", self.path) from error
                if last < first:
                    raise NativeFormatError(f"{end}: 结束时间不能早于 {start}", self.path)
        if "roast_levels" in self._metadata:
            try:
                levels = [_finite_number(token) for token in self.get("roast_levels").split(",")]
            except ValueError as error:
                raise NativeFormatError("roast_levels: 应为逗号分隔的有限温度值", self.path) from error
            if len(levels) != 7:
                raise NativeFormatError("roast_levels: 原版 Kaffelogic 等级需要七个温度值", self.path)
            if any(right - left < 1.0 - 2e-13 for left, right in zip(levels, levels[1:])):
                raise NativeFormatError("roast_levels: 温度必须严格递增，相邻至少间隔 1°C", self.path)
        # Studio validates the plotted Bézier samples, not just anchor values.
        # Include the physical final anchor; virtual GUI endpoint extensions
        # are outside this offline document model.
        if self.get("fan_profile") != self._original_fan_field:
            try:
                _validate_fan_limits(self.get_curve("fan_profile"))
            except ValueError as error:
                raise NativeFormatError(f"fan_profile: {error}", self.path) from error


# Numeric event records such as !roasting_level and !development_percent are
# retained as source lines, and must never be interpreted as timestamps.
TIME_EVENT_KINDS = frozenset({"colour_change", "first_crack", "first_crack_end", "second_crack", "second_crack_end", "roast_end"})


class LogDocument(NativeDocument):
    kind = "log"

    def __init__(self, lines: list[_Line], path: Path | str | None = None, bom: bool = False):
        super().__init__(lines, path, bom)
        self._check_versions()
        self._parse_table()

    def _parse_table(self) -> None:
        self.headers: list[str] = []
        self.offsets = np.asarray([], dtype=float)
        self._samples: list[list[float]] = []
        self._sample_line_indices: list[int] = []
        self._events: list[RoastEvent] = []
        self._event_indices: dict[str, list[int]] = {}
        self._event_values: dict[str, list[str]] = {}
        offsets_index = None
        offsets_values: list[float] | None = None
        for index, line in enumerate(self._lines):
            text = line.text
            if not text.strip():
                continue
            if text.startswith("!"):
                if ":" not in text:
                    raise NativeFormatError("事件应为 !key:value", self.path, index + 1)
                key, value = text[1:].split(":", 1)
                if not key:
                    raise NativeFormatError("事件名不能为空", self.path, index + 1)
                self._event_indices.setdefault(key, []).append(index)
                self._event_values.setdefault(key, []).append(value)
                if key in TIME_EVENT_KINDS:
                    try:
                        self._events.append(RoastEvent(key, _finite_number(value)))
                    except ValueError as error:
                        raise NativeFormatError(f"{key} 时间不是有效数值", self.path, index + 1) from error
                continue
            if text.startswith("offsets\t"):
                offsets_index = index
                try:
                    offsets_values = [_finite_number(value) for value in text.split("\t")[1:] if value != ""]
                except ValueError as error:
                    raise NativeFormatError("offsets 包含无效数值", self.path, index + 1) from error
                continue
            if text.startswith("time\t"):
                if self.headers:
                    raise NativeFormatError("存在重复的采样表头", self.path, index + 1)
                self.headers = text.rstrip("\t").split("\t")
                continue
            if ":" in text and "\t" not in text.split(":", 1)[0]:
                key, value = text.split(":", 1)
                if key in TIME_EVENT_KINDS:
                    self._event_indices.setdefault(key, []).append(index)
                    self._event_values.setdefault(key, []).append(value)
                    try:
                        self._events.append(RoastEvent(key, _finite_number(value)))
                    except ValueError as error:
                        raise NativeFormatError(f"{key} 时间不是有效数值", self.path, index + 1) from error
                continue
            if not self.headers:
                if text.startswith("#"):
                    continue
                raise NativeFormatError("采样表头前出现无效行", self.path, index + 1)
            values = text.split("\t")
            while values and values[-1] == "":
                values.pop()
            if len(values) != len(self.headers):
                raise NativeFormatError(f"采样应有 {len(self.headers)} 列，实际 {len(values)} 列", self.path, index + 1)
            try:
                row = [_finite_number(value) for value in values]
            except ValueError as error:
                raise NativeFormatError("采样包含无效或非有限数值", self.path, index + 1) from error
            self._samples.append(row)
            self._sample_line_indices.append(index)
        if not self.headers:
            raise NativeFormatError("缺少 time 采样表头", self.path)
        if offsets_values is not None:
            if len(offsets_values) != len(self.headers) - 1:
                raise NativeFormatError(f"offsets 应有 {len(self.headers) - 1} 个通道值", self.path, offsets_index + 1)
            self.offsets = np.asarray([0.0, *offsets_values], dtype=float)
        else:
            self.offsets = np.zeros(len(self.headers), dtype=float)
        self._data = np.asarray(self._samples, dtype=float).reshape((-1, len(self.headers)))
        self.time = self._data[:, 0].copy()
        if len(self.time) > 1 and np.any(np.diff(self.time) <= 0):
            self.readonly = True
            message = "采样时间存在倒序或重复；保留原始数据并以只读方式打开。"
            if message not in self.warnings:
                self.warnings.append(message)
        effective: dict[str, RoastEvent] = {}
        for event in self._events:
            if self.event_temperature(event.kind, event.time) is None:
                continue
            effective.pop(event.kind, None)
            if event.time != 0:
                effective[event.kind] = event
        self._effective_events = list(effective.values())

    @property
    def events(self) -> list[RoastEvent]:
        return list(self._effective_events)

    @property
    def event_records(self) -> list[RoastEvent]:
        """All timestamp records in source order, including superseded values."""
        return list(self._events)

    @property
    def data(self) -> np.ndarray:
        return self._data.copy()

    def _series_column(self, name: str) -> int | None:
        name = _normal_header(name)
        aliases = {
            "temperature": ("Bean_temperature", "Bean_temp", "BT", "mean_temp", "temp", "spot_temp"),
            "target": ("profile",),
            "ror": ("actual_ROR",),
            "fan": ("actual_fan_RPM", "fan_RPM", "fan"),
            "power": ("power_kW",),
        }
        names = [_normal_header(header) for header in self.headers]
        if name == "temperature":
            masters = [index for index, column in enumerate(names)
                       if column in {"mean_temp", "BT", "Bean_temp", "Bean_temperature"}]
            if masters:
                return masters[-1]
        for candidate in aliases.get(name, (name,)):
            if candidate in names:
                return names.index(candidate)
        return None

    def get_series(self, name: str) -> np.ndarray | None:
        index = self._series_column(name)
        return self._data[:, index].copy() if index is not None else None

    def get_series_time(self, name: str) -> np.ndarray | None:
        """Each native offset translates that channel's time axis in seconds."""
        index = self._series_column(name)
        return self.time + self.offsets[index] if index is not None else None

    series_time = get_series_time

    def event_temperature(self, kind: str, seconds: float) -> float | None:
        """Match Studio's first eligible master-temperature sample selection."""
        index = self._series_column("temperature")
        if index is None or not len(self.time):
            return None
        master = _normal_header(self.headers[index])
        threshold = seconds - (3.5 if kind == "roast_end" and master == "mean_temp" else 0.0)
        eligible = np.flatnonzero(self.time + self.offsets[index] >= threshold)
        # The reference Celsius conversion rounds temperature samples to 0.1°C
        # before update_events consumes them. Raw stored samples stay intact.
        return _legacy_round(float(self._data[int(eligible[0]), index]), 1) if len(eligible) else None

    def set(self, key: str, value: object) -> None:
        super().set(key, value)
        self._parse_table()

    def event_value(self, kind: str, default: str | None = None) -> str | None:
        values = self._event_values.get(kind)
        return values[-1] if values else default

    def set_event(self, kind: str, time_seconds: float) -> None:
        self._ensure_writable()
        if kind not in TIME_EVENT_KINDS:
            raise ValueError("未知的原生时间事件类型")
        seconds = _finite_number(time_seconds)
        if seconds < 0 or (len(self.time) and seconds > max(0.0, float(self.time[-1]))):
            raise ValueError("事件时间必须在零至日志结束时间之间")
        text = f"!{kind}:{_number_text(seconds)}"
        indices = self._event_indices.get(kind, [])
        if indices:
            index = indices[-1]
            self._lines[index].text = text if self._lines[index].text.startswith("!") else text[1:]
        else:
            after = np.flatnonzero(self.time >= seconds)
            index = self._sample_line_indices[int(after[0])] + 1 if len(after) else len(self._lines)
            self._insert_line(index, text)
        self._read_metadata()
        self._parse_table()

    def remove_event(self, kind: str) -> None:
        self._ensure_writable()
        if kind not in TIME_EVENT_KINDS:
            raise ValueError("未知的原生时间事件类型")
        for index in reversed(self._event_indices.get(kind, [])):
            del self._lines[index]
        self._read_metadata()
        self._parse_table()

    def validate(self) -> None:
        # Reparse from original line records rather than rewriting numeric data.
        self._parse_table()

    def export_csv(self, path: Path | str) -> Path:
        """Export raw sample values with plain channel names as CSV headings.

        Native display prefixes are retained by .klog saves; a plain heading
        also lets spreadsheet apps display names such as mean_temp as text.
        Time offsets stay in the native document rather than altering samples.
        """
        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer, lineterminator="\r\n")
        writer.writerow([_normal_header(header) for header in self.headers])
        for row in self._samples:
            writer.writerow([_number_text(value) for value in row])
        target = Path(path)
        _atomic_write(target, buffer.getvalue().encode("utf-8-sig"))
        return target


def _decode_lines(data: bytes, path: Path | str | None) -> tuple[list[_Line], bool]:
    bom = data.startswith(b"\xef\xbb\xbf")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        line = data[:error.start].count(b"\n") + 1
        raise NativeFormatError("文件不是有效的 UTF-8 文本", path, line) from error
    lines = []
    # str.splitlines also splits vertical tabs and Unicode separators, which
    # belong to text fields rather than the native physical-line grammar.
    for raw in re.findall(r"[^\r\n]*(?:\r\n|\r|\n|$)", text):
        if not raw:
            continue
        if raw.endswith("\r\n"):
            lines.append(_Line(raw[:-2], "\r\n"))
        elif raw.endswith(("\n", "\r")):
            lines.append(_Line(raw[:-1], raw[-1:]))
        else:
            lines.append(_Line(raw, ""))
    return lines, bom


def parse_document_bytes(data: bytes, kind: str, path: Path | str | None = None) -> NativeDocument:
    lines, bom = _decode_lines(data, path)
    if kind in ("profile", "kpro", ".kpro"):
        return ProfileDocument(lines, path, bom)
    if kind in ("log", "klog", ".klog"):
        return LogDocument(lines, path, bom)
    raise ValueError(f"不支持的文档类型 {kind}")


def load_profile(path: Path | str) -> ProfileDocument:
    path = Path(path)
    return parse_document_bytes(path.read_bytes(), "profile", path)


def load_log(path: Path | str) -> LogDocument:
    path = Path(path)
    return parse_document_bytes(path.read_bytes(), "log", path)


def load_document(path: Path | str) -> NativeDocument:
    path = Path(path)
    kind = {".kpro": "profile", ".klog": "log"}.get(path.suffix.lower())
    if kind is None:
        raise NativeFormatError("请选择 .kpro 或 .klog 文件", path)
    return parse_document_bytes(path.read_bytes(), kind, path)


def new_profile() -> ProfileDocument:
    """Load the default recovered from the reference application's defaults."""
    from importlib.resources import files
    resource = files(__package__).joinpath("resources/default.kpro")
    return parse_document_bytes(resource.read_bytes(), "profile")


def calculate_ror(log: LogDocument) -> np.ndarray | None:
    """Numerical derivative in °C/min; independent of the recorded actual_ROR.

    This is an explicitly separate, unsmoothed calculation until the reference
    Studio display-smoothing algorithm has been independently verified.
    """
    temperature = log.get_series("temperature")
    if temperature is None or len(temperature) < 2 or np.any(np.diff(log.time) <= 0):
        return None
    return np.gradient(temperature, log.time) * 60.0


def calculate_metrics(log: LogDocument) -> dict[str, float | None]:
    """Evidence-backed event arithmetic; unavailable quantities stay absent."""
    end_events = [event.time for event in log.events if event.kind == "roast_end" and event.time >= 0]
    end = end_events[-1] if end_events else None
    first_events = [event.time for event in log.events if event.kind == "first_crack" and event.time >= 0]
    first = first_events[-1] if first_events else None
    duration = end
    final = log.event_temperature("roast_end", end) if end is not None else None
    development = (end - first) if end is not None and first is not None and 0 <= first <= end else None
    colour_events = [event.time for event in log.events if event.kind == "colour_change" and event.time >= 0]
    colour = colour_events[-1] if colour_events else None
    drying = colour if colour is not None and end is not None and 0 <= colour <= end else None
    maillard = first - colour if colour is not None and first is not None and end is not None and 0 <= colour <= first <= end else None
    return {
        "duration": duration,
        "end_time": end,
        "recording_duration": float(log.time[-1] - log.time[0]) if len(log.time) else None,
        "final_temperature": final,
        "first_crack": first,
        "first_crack_temperature": log.event_temperature("first_crack", first) if first is not None else None,
        "development_time": development,
        "development_ratio": development / end if development is not None and end and end > 0 else None,
        "colour_change": colour,
        "colour_change_temperature": log.event_temperature("colour_change", colour) if colour is not None else None,
        "drying_time": drying,
        "drying_ratio": drying / end if drying is not None and end and end > 0 else None,
        "maillard_time": maillard,
        "maillard_ratio": maillard / end if maillard is not None and end and end > 0 else None,
    }


def get_display_series(log: LogDocument, name: str, smoothing: int = 1,
                       multiplier: float = 1) -> np.ndarray | None:
    """Display recorded data using Studio's endpoint-padded moving means.

    Only actual_ROR is smoothed; all three native RoR channels support the
    display multiplier. Samples and their offset-adjusted time axes stay intact.
    The even-window asymmetry deliberately matches ``applyMovingMeans`` rather
    than replacing it with a different centered filter or a numerical derivative.
    """
    try:
        window = _finite_number(smoothing)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("平滑窗口必须是大于零的整数采样数") from error
    if isinstance(smoothing, bool) or int(window) != window or window < 1:
        raise ValueError("平滑窗口必须是大于零的整数采样数")
    smoothing = int(window)
    factor = _finite_number(multiplier)
    values = log.get_series(name)
    if values is None:
        return None
    index = log._series_column(name)
    channel = _normal_header(log.headers[index])
    if channel in {"actual_ROR", "profile_ROR", "desired_ROR"}:
        values = values * factor
    if channel != "actual_ROR" or smoothing == 1 or not len(values):
        return values
    half = int(smoothing) // 2
    padded = [float(values[0])] * half + values.tolist() + [float(values[-1])] * half
    # Python's ordered accumulation matches averagePoint in the Python 2 code.
    return np.asarray([sum(padded[i:i + int(smoothing)]) / int(smoothing)
                       for i in range(len(values))], dtype=float)


def curve_area(curve: Curve, start: float | None = None, end: float | None = None,
               baseline: float = 0.0) -> float:
    """Studio's displayed AUC, in value-units × minutes, over native time.

    The original tool averages displayed integer-second curve samples in the
    interval, subtracts the baseline, and multiplies by interval duration. This
    is intentionally a display statistic, not an analytic Bézier integral.
    Only the actual curve domain is supported; no virtual endpoint is invented.
    """
    curve.validate()
    start = curve.points[0].x if start is None else _finite_number(start)
    end = curve.points[-1].x if end is None else _finite_number(end)
    baseline = _finite_number(baseline)
    if not curve.points[0].x <= start < end <= curve.points[-1].x:
        raise ValueError("面积区间必须在曲线内，且结束时间晚于开始时间")
    points = curve.resolved().studio_points()[0]
    values = [float(y) for x, y in points if start <= _legacy_round(float(x)) <= end]
    if not values:
        raise ValueError("所选区间没有原版绘图采样点")
    return (sum(values) / len(values) - baseline) * (end - start) / 60.0


_PROFILE_ABOUT_KEYS = frozenset({"profile_short_name", "profile_designer", "profile_description"})
_PROFILE_EVENT_KEYS = frozenset({"recommended_level", "expect_fc", "expect_colrchange"})


def _profile_keys() -> set[str]:
    """Known configuration vocabulary, without telemetry/event root fields."""
    keys = set(new_profile().metadata)
    keys.add("profile_modified")
    keys.update({"fc_zone_time_start", "fc_zone_time_end"})
    for step in range(1, 11):
        keys.update({f"fan_step{step}_{suffix}" for suffix in ("time", "adjust")})
    return keys


def extract_profile(log: LogDocument) -> ProfileDocument:
    """Extract only embedded profile fields, keeping original field spelling.

    No default schema or missing curve is synthesized. Unsupported embedded
    profile versions therefore stay read-only in the extracted document.
    Log measurements, events and machine identity never enter the profile.
    """
    if not isinstance(log, LogDocument):
        raise TypeError("请选择烘焙日志")
    allowed = _profile_keys()
    lines = [_Line(line.text, line.ending) for line in log._lines
             if ":" in line.text and not line.text.startswith("!")
             and line.text.split(":", 1)[0] in allowed]
    return ProfileDocument(lines, bom=log._bom)


def merge_profile(target: ProfileDocument, source: NativeDocument,
                  groups: Iterable[str]) -> ProfileDocument:
    """Return a selective merge; inputs and unselected target fields are intact.

    Groups are ``roast_profile``, ``fan_profile``, ``metadata`` (name, designer,
    description), ``events`` (recommended level/expected event temperatures),
    ``zones`` and ``other_settings``. The legacy ``settings`` group continues
    to include all known non-curve settings, including events and zones.
    Format versions never transfer implicitly between documents.
    """
    if not isinstance(target, ProfileDocument):
        raise TypeError("合并目标必须是曲线文档")
    selected = {groups} if isinstance(groups, str) else set(groups)
    allowed_groups = {"roast_profile", "fan_profile", "metadata", "settings", "events", "zones", "other_settings"}
    if selected - allowed_groups:
        raise ValueError("未知的合并分组：" + ", ".join(sorted(selected - allowed_groups)))
    target._ensure_writable()
    source._ensure_writable()
    if isinstance(source, LogDocument):
        source = extract_profile(source)
    if not isinstance(source, ProfileDocument):
        raise TypeError("合并来源必须是曲线或包含曲线的日志")
    source._ensure_writable()
    result = parse_document_bytes(target.to_bytes(), "profile", target.path)
    fields: set[str] = set()
    fields.update(selected & {"roast_profile", "fan_profile"})
    if "metadata" in selected:
        fields.update(_PROFILE_ABOUT_KEYS)
    all_settings = (_profile_keys() - _PROFILE_ABOUT_KEYS
                    - {"roast_profile", "fan_profile", "profile_schema_version", "profile_modified"})
    zone_keys = {key for key in all_settings if key.startswith(("zone", "fc_zone", "corner"))}
    if "settings" in selected:
        fields.update(all_settings)
    if "events" in selected:
        fields.update(_PROFILE_EVENT_KEYS)
    if "zones" in selected:
        fields.update(zone_keys)
    if "other_settings" in selected:
        fields.update(all_settings - _PROFILE_EVENT_KEYS - zone_keys)
    for key, value in source.metadata.items():
        if key in fields:
            result.set(key, value)
    result._validate_for_save()
    return result


@dataclass(frozen=True)
class DocumentDiagnostic:
    path: Path
    status: str
    message: str
    kind: str | None = None
    readonly: bool = True
    warnings: tuple[str, ...] = ()
    sample_count: int = 0
    sha256: str = ""

    @property
    def ok(self) -> bool:
        """Whether the document can be opened, including read-only cases."""
        return self.status in {"ok", "unknown_schema", "time_anomaly"}


def diagnose_document(path: Path | str) -> DocumentDiagnostic:
    """Classify a source document without changing it or repairing its grammar."""
    path = Path(path)
    kind = {".kpro": "profile", ".klog": "log"}.get(path.suffix.lower())
    try:
        data = path.read_bytes()
    except OSError as error:
        return DocumentDiagnostic(path, "unreadable", str(error), kind)
    digest = hashlib.sha256(data).hexdigest()
    if not data:
        return DocumentDiagnostic(path, "empty", "文件为空，没有可分析的曲线或采样。", kind, sha256=digest)
    if kind is None:
        return DocumentDiagnostic(path, "invalid", "请选择 .kpro 或 .klog 文件。", sha256=digest)
    try:
        document = parse_document_bytes(data, kind, path)
    except (NativeFormatError, ValueError) as error:
        text = str(error)
        # A headerless data fragment must never silently inherit a guessed
        # channel layout; its original bytes remain available for investigation.
        truncated = ("缺少 time 采样表头" in text or "采样表头前出现无效行" in text
                     or "缺少曲线字段" in text)
        status = "truncated" if truncated else "invalid"
        return DocumentDiagnostic(path, status, text, kind, sha256=digest)
    status = "ok"
    if isinstance(document, LogDocument) and len(document.time) > 1 and np.any(np.diff(document.time) <= 0):
        status = "time_anomaly"
    elif document.readonly:
        status = "unknown_schema"
    message = "可读取" if status == "ok" else "；".join(document.warnings)
    return DocumentDiagnostic(path, status, message, kind, document.readonly,
                              tuple(document.warnings), len(document.time) if kind == "log" else 0, digest)
