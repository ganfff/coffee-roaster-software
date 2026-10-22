"""Original cross-plot sampling and unzoomed-axis affine mapping."""
from __future__ import annotations

import numpy as np

from . import core


def fan_steps(document):
    result = []
    for number in range(1, 11):
        try:
            adjust = float(document.get(f"fan_step{number}_adjust", "0") or "0")
            when = float(document.get(f"fan_step{number}_time", "0") or "0")
        except ValueError:
            continue
        if np.isfinite(adjust) and np.isfinite(when) and adjust:
            result.append((when, adjust))
    return result


def cross_plot_points(document, source_name, source_range, destination_range,
                      *, temperature_unit="C", apply_steps=False):
    curve = document.get_curve(source_name).resolved()
    if source_name == "fan_profile":
        curve = curve.transformed(value_scale=.1)
    elif temperature_unit == "F":
        curve = curve.transformed(value_scale=1.8, value_offset=32)
    coordinates = curve.studio_points(adaptive=True)[0]
    x, y = coordinates[:, 0], coordinates[:, 1]
    if apply_steps and source_name == "fan_profile":
        multiplier = np.ones_like(y)
        for when, adjust in fan_steps(document):
            multiplier[x >= when] += adjust
        y = y * multiplier
    low, high = source_range
    bottom, top = destination_range
    if high == low:
        raise ValueError("叠加曲线的原比例尺范围不能为零")
    scale = float(top - bottom) / float(high - low)
    # Keep the operation order of original convertFanRPMtoFitTemperatureScale.
    offset = bottom - scale * low
    return x, y * scale + offset
