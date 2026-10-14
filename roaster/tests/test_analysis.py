import asyncio
import math
import sqlite3
import tempfile
import unittest
from pathlib import Path
from datetime import datetime
from src.core.analysis import validate_candidate
from src.core.models import RoastProfile, RoastRecord, RoastContext, CupFeedback
from src.services.data_manager import DataManager


def profile(values):
    return {"name": "测试", "nodes": [{"time": i*60, "temperature": value} for i, value in enumerate(values)], "end_temp": 0}


class CandidateTests(unittest.TestCase):
    def test_spline_overshoot(self):
        p = profile([0, 250, 250, 0])
        self.assertEqual(RoastProfile.model_validate(p).get_target_temp(90), 281.25)
        result = validate_candidate(p, 250)
        self.assertFalse(result["valid"])
        self.assertEqual(result["max_temperature"], 281.25)

    def test_valid_and_nonfinite(self):
        self.assertTrue(validate_candidate(profile([30, 200]), 250)["valid"])
        for field in ["time", "temperature"]:
            p = profile([30, 200]); p["nodes"][1][field] = math.inf
            self.assertFalse(validate_candidate(p, 250)["valid"])
        self.assertFalse(validate_candidate(profile([30, 200]), math.nan)["valid"])

    def test_interpolated_lock(self):
        source = profile([30, 100, 180, 200, 210])
        changed = profile([30, 100, 180, 230, 210])
        self.assertFalse(validate_candidate(changed, 250, source, 120)["valid"])
        self.assertTrue(validate_candidate(source, 250, source, 120)["valid"])

    def test_end_temperature_and_legacy(self):
        p = profile([30, 200]); p["end_temp"] = 210
        self.assertFalse(validate_candidate(p, 250)["valid"])
        old = RoastProfile.model_validate(profile([30, 200]))
        self.assertIsNone(old.roast_context)


class PersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_database_migration_and_context_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = sqlite3.connect(root / "roasts.db")
            db.execute("CREATE TABLE records(session_id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, profile_id TEXT, events_json TEXT, data_json TEXT)")
            db.execute("INSERT INTO records VALUES('old',NULL,NULL,NULL,'[]','[]')")
            db.commit(); db.close()
            dm = DataManager({"paths": {"profiles_dir": str(root / "profiles"), "records_dir": str(root)}})
            await dm.init_db(); await dm.init_db()
            self.assertIsNone((await dm.get_record("old")).roast_context)
            p = RoastProfile.model_validate(profile([30, 200]))
            p.roast_context = RoastContext(bean_name="耶加", charge_weight_g=100)
            await dm.save_profile(p)
            self.assertEqual((await dm.load_profile(p.id)).roast_context.bean_name, "耶加")
            record = RoastRecord(session_id="new", started_at=datetime.now(), ended_at=datetime.now(), profile_id=p.id, events=[], data=[(0,30,30,0)], profile_snapshot=p, roast_context=p.roast_context)
            await dm.save_record(record)
            loaded = await dm.get_record("new")
            self.assertEqual(loaded.roast_context.charge_weight_g, 100)
            await dm.update_record_context("new", loaded.roast_context, CupFeedback(notes="酸甜平衡"))
            self.assertEqual((await dm.get_record("new")).cup_feedback.notes, "酸甜平衡")
            self.assertFalse(await dm.update_record_context("missing", None, None))
            self.assertEqual(len(await dm.list_records()),2)
            self.assertIn("酸甜平衡",await dm.export_json("new"))


if __name__ == "__main__":
    unittest.main()
