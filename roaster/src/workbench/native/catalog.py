"""Read the standalone, measured original terminology and settings catalog."""

from __future__ import annotations

from functools import lru_cache
from importlib.resources import files
import json


@lru_cache(maxsize=1)
def load_catalog() -> dict:
    """Return the bundled catalog. Treat the returned object as read-only."""
    return json.loads(files(__package__).joinpath("resources/studio_catalog.json").read_text("utf-8"))


def translate(text: str) -> str:
    """Translate an exact original message; retain unknown text unchanged."""
    return load_catalog()["translations"].get(text, text)


def parameter_info(key: str) -> dict:
    """Describe a native key, keeping unknown user fields visible."""
    return load_catalog()["parameters"].get(key, {
        "key": key, "label": key.replace("_", " "), "label_en": key.replace("_", " "),
        "help": "", "help_en": "", "unit": "", "type": "text", "default": None,
        "difficulty": "engineer", "difficulty_level": 4, "readonly": False,
        "group": None, "order": None,
    })


def setting_categories() -> list[dict]:
    return load_catalog()["settings_categories"]


def about_categories() -> list[dict]:
    return load_catalog()["about_categories"]
