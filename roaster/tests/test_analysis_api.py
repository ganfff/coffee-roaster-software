"""ASGI tests deliberately do not run FastAPI's hardware lifespan."""
import asyncio
import tempfile
import unittest
from unittest.mock import AsyncMock
from src.core.models import RoastRecord
from src.core.events import RoasterState
from src.services.data_manager import DataManager
from src.core.roaster_controller import RoasterController
from src.web.web_api import app
import httpx


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.dm = DataManager({"paths": {"profiles_dir": self.directory.name+"/profiles", "records_dir": self.directory.name}})
        await self.dm.init_db()
        self.controller = type("FakeController", (), {})()
        self.controller.config = {"max_safe_temperature": 240}
        self.controller.state = RoasterState.IDLE
        self.controller.connect_hardware = AsyncMock(side_effect=AssertionError("No hardware allowed"))
        self.controller.get_analysis_context = AsyncMock(return_value={"status":{"state":"IDLE"},"active_profile":None,"samples":[],"limits":{"max_safe_temperature_c":240}})
        app.state.controller = self.controller; app.state.dm = self.dm
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        self.controller.connect_hardware.assert_not_called()
        await self.client.aclose(); self.directory.cleanup()

    async def test_context_and_effective_limits(self):
        self.assertEqual((await self.client.get("/api/v1/analysis/context")).json()["limits"]["max_safe_temperature_c"],240)
        payload={"profile":{"name":"test","nodes":[{"time":0,"temperature":30},{"time":60,"temperature":245}],"end_temp":245}}
        self.assertFalse((await self.client.post("/api/v1/analysis/profiles/validate",json=payload)).json()["valid"])
        self.assertEqual((await self.client.post("/api/v1/analysis/profiles",json=payload)).status_code,422)
        self.assertEqual(await self.dm.list_profiles(),[])

    async def test_copy_save_never_overwrites_or_changes_active_state(self):
        profile={"id":"original","name":"test","nodes":[{"time":0,"temperature":30},{"time":60,"temperature":200}],"end_temp":200}
        from src.core.models import RoastProfile
        await self.dm.save_profile(RoastProfile.model_validate(profile))
        response=await self.client.post("/api/v1/analysis/profiles",json={"profile":profile})
        self.assertEqual(response.status_code,200)
        self.assertNotEqual(response.json()["id"],"original")
        self.assertEqual(len(await self.dm.list_profiles()),2)
        self.controller.state=RoasterState.ROASTING
        self.assertEqual((await self.client.post("/api/v1/analysis/profiles",json={"profile":profile})).status_code,409)
        self.assertEqual(self.controller.state,RoasterState.ROASTING)

    async def test_record_context_validation_and_roundtrip(self):
        record=RoastRecord(session_id="record",started_at=None,ended_at=None,profile_id=None,events=[],data=[])
        await self.dm.save_record(record)
        response=await self.client.patch("/api/v1/records/record/context",json={"roast_context":{"bean_name":"耶加","charge_weight_g":100},"cup_feedback":{"notes":"果酸清晰"}})
        self.assertEqual(response.status_code,200)
        value=(await self.client.get("/api/v1/records/record")).json()
        self.assertEqual(value["cup_feedback"]["notes"],"果酸清晰")
        self.assertEqual((await self.client.patch("/api/v1/records/record/context",json={"roast_context":{"charge_weight_g":-1}})).status_code,422)

    async def test_real_snapshot_method_copies_before_serialization(self):
        from src.core.models import RoastProfile
        controller=RoasterController.__new__(RoasterController)
        controller._state_lock=asyncio.Lock()
        controller.session_id="test"
        controller.profile=RoastProfile(name="original",nodes=[{"time":0,"temperature":30},{"time":60,"temperature":200}])
        controller._session_data=[(0,30,30,0)]
        controller.config={"max_safe_temperature":240}
        controller.get_state_payload=lambda:{"state":"ROASTING","session_id":"test"}
        snapshot=await controller.get_analysis_context()
        controller._session_data.append((1,31,31,1));controller.profile.name="changed"
        self.assertEqual(len(snapshot["samples"]),1)
        self.assertEqual(snapshot["active_profile"]["name"],"original")
        self.assertFalse(controller._state_lock.locked())
