"""Profile phase column and calculations recovered from Studio's phases.py.

Expected event temperatures are native Celsius values.  Time inversion follows
the original curve solver, including its last-handle tangent extrapolation.
The widget owns no document edits: its owner applies ``parameterChanged`` via
the normal undo controller and calls ``set_document`` after curve edits.
"""

from __future__ import annotations

from dataclasses import dataclass
import math



from . import core



EXPECTED_KEYS = {"colour_change": "expect_colrchange", "first_crack": "expect_fc"}


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (ValueError, TypeError):
        return None
    return number if math.isfinite(number) else None


def temperature_from_level(level, thresholds: str) -> float | None:
    """Studio core_studio.py:267: interpolate the recommended roast level."""
    level = _finite(level)
    try:
        values = [float(item) for item in thresholds.split(",")]
    except (AttributeError, TypeError, ValueError):
        return None
    if level is None or not values or not all(math.isfinite(value) for value in values):
        return None
    fraction, integer = math.modf(level)
    index = math.trunc(integer)
    if index == len(values) - 1:
        return values[index]
    if index < 0 or index > len(values) - 1:
        return None
    return values[index] + fraction * (values[index + 1] - values[index])


def profile_time_from_temperature(curve: core.Curve, temperature: float | None,
                                  emulation_mode: int = 0) -> float | None:
    """Replay phases.timeFromTemperature on the document's resolved curve.

    The original searches ascending anchor intervals, solves cubic Y directly
    (32 bisections, 1e-6 tolerance), then extrapolates from the last left handle.
    Non-Kaffelogic emulation uses straight anchor-to-anchor segments.
    """
    target = _finite(temperature)
    if target is None:
        return None
    for index in range(len(curve.points) - 1):
        a, b, c, d = curve._segment_controls(index)
        if target == a[1]:
            return a[0]
        if target == d[1]:
            return d[0]
        if a[1] < target < d[1]:
            if emulation_mode != 0:
                return a[0] + (target - a[1]) / ((d[1] - a[1]) / (d[0] - a[0]))
            low, high, guess = 0.0, 1.0, 0.5
            c1 = d[1] - 3.0 * c[1] + 3.0 * b[1] - a[1]
            c2 = 3.0 * c[1] - 6.0 * b[1] + 3.0 * a[1]
            c3 = 3.0 * b[1] - 3.0 * a[1]
            for _ in range(32):
                guess = (low + high) / 2.0
                t2, t3 = guess * guess, guess * guess * guess
                result = c1 * t3 + c2 * t2 + c3 * guess + a[1]
                if abs(result - target) < 1e-6:
                    break
                if result < target:
                    low = guess
                else:
                    high = guess
            return core._bezier_value(guess, a, b, c, d).x
    last = curve.points[-1]
    gradient = core._gradient((last.left_x, last.left_y), (last.x, last.y))
    return last.x if gradient == 0 else last.x + (target - last.y) / gradient


@dataclass(frozen=True)
class ExpectedEvent:
    time: float | None
    temperature: float | None


@dataclass(frozen=True)
class ExpectedPhase:
    duration: float
    percent: float | None
    increase: float


@dataclass(frozen=True)
class ProfilePhases:
    events: dict[str, ExpectedEvent]
    phases: dict[str, ExpectedPhase | None]


def calculate_profile_phases(document: core.NativeDocument,
                             overrides: dict[str, str] | None = None) -> ProfilePhases:
    """Calculate A/B/C durations, end-relative percentages and temperature rises.

    Like the reference, absent CC hides A/B and absent FC hides B/C.  Predicted
    events may occur beyond the last anchor: they use the final tangent rather
    than a sampled-curve approximation or the curve's last anchor as roast end.
    """
    curve = document.get_curve("roast_profile")
    values = dict(document.metadata)
    values.update(overrides or {})
    mode = _finite(values.get("emulation_mode", "0"))
    mode = int(core._legacy_round(mode)) if mode is not None else 0
    temperatures = {}
    for kind, key in EXPECTED_KEYS.items():
        value = _finite(values.get(key))
        temperatures[kind] = value if value != 0 else None
    temperatures["roast_end"] = temperature_from_level(values.get("recommended_level"),
                                                       values.get("roast_levels", ""))
    events = {kind: ExpectedEvent(profile_time_from_temperature(curve, value, mode), value)
              for kind, value in temperatures.items()}
    start = ExpectedEvent(0.0, curve.points[0].y)
    cc, fc, end = (events[kind] for kind in ("colour_change", "first_crack", "roast_end"))
    phases = {}
    for name, first, last in (("drying", start, cc), ("maillard", cc, fc),
                               ("development", fc, end)):
        required = (first.time, first.temperature, last.time, last.temperature, end.time)
        if any(value is None for value in required):
            phases[name] = None
        else:
            duration = last.time - first.time
            phases[name] = ExpectedPhase(duration,
                                          duration / end.time * 100.0 if end.time != 0 else None,
                                          last.temperature - first.temperature)
    return ProfilePhases(events, phases)


