"""Lossless file migration, edit isolation, and controller conversion tests."""
import base64
import hashlib
import json
from pathlib import Path
import unittest

import numpy as np

from src.workbench.engine import dispatch, decode, encode, from_app, target
from src.workbench.native import core
from src.workbench.native.overlays import cross_plot_points
from src.workbench.native.phases import calculate_profile_phases

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = ROOT / "kaffelogic逆向"
LOG = (b"profile_schema_version:1.8\r\nnative_schema_version:1.8\r\nunknown:keep:colons\r\n"
       b"offsets\t0\t0\t-0.5\r\ntime\t#=temp\t=profile\t=actual_ROR\r\n"
       b"0\t20\t21\t1.25\t\r\n!unknown:tag:keep\r\n1\t22\t23\t2.5\t\r\n"
       b"!first_crack:1\r\n2\t24\t25\t3.75\t\r\n!roast_end:2\r\n")


def payload(data, kind="log", name="中文文件.klog"):
    return {"kind": kind, "name": name, "data": base64.b64encode(data).decode("ascii")}


class WorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.profile = dispatch({"action": "new"})["document"]

    def test_untouched_bytes_unknown_offsets_and_display_isolation(self):
        source = payload(LOG)
        result = dispatch({"document": source, "preferences": {"smoothing": 2, "multiplier": 3}})
        self.assertEqual(base64.b64decode(result["document"]["data"]), LOG)
        self.assertEqual(result["sample_count"], 3)
        self.assertEqual(result["offsets"], [0, 0, 0, -.5])
        self.assertEqual(result["channels"][2]["data"][0][0], -.5)
        self.assertEqual(dispatch({"action": "export", "document": source, "changed": False})["data"], source["data"])

    def test_edits_are_new_snapshots_and_errors_leave_input_unchanged(self):
        before = self.profile.copy()
        result = dispatch({"action": "curve", "document": self.profile, "operation": "move", "index": 1, "x": 70, "y": 110})
        self.assertNotEqual(result["document"]["data"], before["data"])
        self.assertEqual(self.profile, before)
        with self.assertRaises(ValueError):
            dispatch({"action": "curve", "document": self.profile, "operation": "move", "index": 1, "x": -1, "y": 110})
        self.assertEqual(self.profile, before)
        self.assertEqual(dispatch({"document": before})["document"]["data"], before["data"])

    def test_handle_insert_smooth_transform_and_merge(self):
        doc = dispatch({"action": "curve", "document": self.profile, "operation": "insert", "x": 45, "y": 85})["document"]
        for operation, args in [("handle", {"index": 1, "side": "right", "x": 52, "y": 95}), ("smooth_all", {}), ("transform", {"time_scale": 1.1, "value_offset": 1})]:
            doc = dispatch({"action": "curve", "document": doc, "operation": operation, **args})["document"]
        source = dispatch({"action": "parameters", "document": self.profile, "values": {"profile_designer": "迁移测试"}})["document"]
        result = dispatch({"action": "merge", "document": doc, "source": source, "groups": ["metadata"]})
        self.assertEqual(result["metadata"]["profile_designer"], "迁移测试")
        self.assertEqual(result["curves"]["roast_profile"]["points"], dispatch({"document": doc})["curves"]["roast_profile"]["points"])

    def test_readonly_version_unknown_parameters_and_schema_changes_rejected(self):
        document = self.profile.copy()
        data = base64.b64decode(document["data"]).replace(b"profile_schema_version:1.8", b"profile_schema_version:1.5")
        readonly = payload(data, "profile", "readonly.kpro")
        self.assertTrue(dispatch({"document": readonly})["readonly"])
        for source, values in [(readonly, {"profile_designer": "x"}), (self.profile, {"profile_schema_version": "1.6"}), (self.profile, {"arbitrary": "value"})]:
            with self.assertRaises(ValueError):
                dispatch({"action": "parameters", "document": source, "values": values})
        with self.assertRaises(ValueError):
            dispatch({"action": "export", "document": readonly})

    def test_log_events_notes_and_raw_csv(self):
        source = payload(LOG)
        changed = dispatch({"action": "event", "document": source, "kind": "first_crack", "value": "0:01.5"})
        self.assertEqual(next(e["time"] for e in changed["events"] if e["kind"] == "first_crack"), 1.5)
        removed = dispatch({"action": "event", "document": changed["document"], "kind": "first_crack", "value": None})
        self.assertFalse(any(e["kind"] == "first_crack" for e in removed["events"]))
        self.assertIsNone(removed["metrics"]["development_time"])
        notes = dispatch({"action": "parameters", "document": source, "values": {"tasting_notes": "甜感\n清晰"}})
        self.assertIn("甜感", notes["metadata"]["tasting_notes"])
        with self.assertRaises(ValueError):
            dispatch({"action": "parameters", "document": source, "values": {"preheat_power": 900}})
        csv = base64.b64decode(dispatch({"action": "export", "document": changed["document"], "format": "csv"})["data"]).decode("utf-8-sig")
        self.assertTrue(csv.startswith("time,temp,profile,actual_ROR"))
        self.assertIn("1.25", csv)
        self.assertNotIn("first_crack", csv)

    def test_fahrenheit_zero_sentinels_and_phase_calculation(self):
        result = dispatch({"action": "parameters", "document": self.profile, "unit": "F", "values": {"expect_fc": "401", "expect_colrchange": "320"}})
        self.assertEqual(float(result["metadata"]["expect_fc"]), 205)
        self.assertAlmostEqual(sum(v["percent"] for v in result["phases"]["phases"].values()), 100)
        self.assertAlmostEqual(sum(v["duration"] for v in result["phases"]["phases"].values()), result["phases"]["events"]["roast_end"]["time"])

    def test_exact_existing_controller_curve_to_bezier(self):
        nodes = [{"time": x, "temperature": y} for x, y in [(0, 30), (70, 90), (120, 150), (200, 165), (300, 200)]]
        document = from_app({"nodes": nodes, "name": "本机"})
        self.assertEqual(document.get("expect_fc"), "0")
        self.assertEqual(document.get("console_temperature_only"), "1")
        curve = document.get_curve("roast_profile")
        self.assertLess(max(abs(curve.value_at(float(t))-target(nodes, float(t))) for t in np.linspace(0, 300, 501)), .002)

    def test_native_controller_conversion_measured_and_preserves_source(self):
        result = dispatch({"action": "to_app", "document": self.profile})["profile"]
        self.assertLessEqual(len(result["nodes"]), 64)
        self.assertLessEqual(result["native_conversion"]["max_sample_error_c"], .25)
        self.assertEqual(result["native_source"], self.profile)

    def test_console_log_conversion_does_not_invent_missing_profile(self):
        record = {"data": [[0, 20, 21, 1], [1, 30, 31, 2], [2, 40, 41, 3]], "events": [{"type": "drop", "time": 2}]}
        result = dispatch({"action": "from_record", "record": record})
        self.assertEqual(result["curves"], {})
        self.assertEqual(result["metrics"]["final_temperature"], 40)
        self.assertEqual(result["sample_count"], 3)

    def test_invalid_requests_and_time_area(self):
        for value in ("nan", "1:80", "1:2:3"):
            with self.assertRaises(ValueError): dispatch({"action": "time", "value": value})
        self.assertEqual(dispatch({"action": "time", "value": "3:30.5"})["seconds"], 210.5)
        self.assertGreater(dispatch({"action": "area", "document": self.profile})["area"], 0)
        with self.assertRaises(ValueError): decode({"kind": "profile", "data": "not base64"})
        with self.assertRaises(ValueError): dispatch({"action": "curve", "document": self.profile, "curve": "anything", "operation": "smooth_all"})

    @unittest.skipUnless(REFERENCE.exists(), "Optional local reference corpus")
    def test_complete_418_file_corpus_hashes_and_expected_diagnostics(self):
        manifest = json.loads((REFERENCE / "analysis/project_corpus_manifest.json").read_text("utf-8"))
        valid = rejected = readonly = 0
        for entry in manifest["files"]:
            path = REFERENCE / entry["path"]
            raw = path.read_bytes()
            before = hashlib.sha256(raw).hexdigest()
            self.assertEqual(before, entry["sha256"])
            try:
                document = decode(payload(raw, "log" if path.suffix == ".klog" else "profile", path.name))
            except ValueError:
                self.assertIn(entry["expected"], {"empty", "truncated"})
                rejected += 1
            else:
                self.assertEqual(entry["expected"], "valid")
                self.assertEqual(document.to_bytes(), raw)
                readonly += int(document.readonly)
                valid += 1
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        self.assertEqual((valid, rejected, readonly), (403, 15, 32))

    @unittest.skipUnless(REFERENCE.exists(), "Optional original-runtime overlay oracle")
    def test_original_overlay_coordinates(self):
        records = json.loads((REFERENCE / "analysis/validation/reference-gui/fan-overlay-oracle.json").read_text("utf-8"))
        for record in records:
            document = core.new_profile()
            for name, key, factor in (("roast_profile", "roast_points", 1), ("fan_profile", "fan_points_display_scaled_0_1", 10)):
                document.set(name, ",".join(repr(value*factor if i%2 else value) for point in record[key] for i,value in enumerate(point)))
            for n,step in enumerate(record["steps"],1):
                document.set(f"fan_step{n}_time", str(step["time"]))
                document.set(f"fan_step{n}_adjust", str(step["adjust"]))
            for name, source, destination, expected, stepped in (("fan_profile", "fan_y_range", "roast_y_range", "fan_on_roast", False), ("fan_profile", "fan_y_range", "roast_y_range", "fan_steps_on_roast", True), ("roast_profile", "roast_y_range", "fan_y_range", "roast_on_fan", False)):
                x,y = cross_plot_points(document,name,record[source],record[destination],apply_steps=stepped)
                np.testing.assert_allclose(np.column_stack((x,y)),record[expected],rtol=1e-11,atol=1e-9)
        self.assertAlmostEqual(dispatch({"action": "new"})["fan_overlay"][0][1], 215.5)


if __name__ == "__main__":
    unittest.main()
