"""Offline ASGI contracts. Hardware lifespan is never executed."""
import tempfile
import unittest
from unittest.mock import AsyncMock

import httpx

from src.core.events import RoasterState
from src.services.data_manager import DataManager
from src.web.web_api import app
from src.workbench.engine import dispatch


class WorkbenchApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.dm = DataManager({"paths": {"profiles_dir": self.directory.name+"/profiles", "records_dir": self.directory.name}})
        await self.dm.init_db()
        self.controller = type("FakeController", (), {})()
        self.controller.config = {"max_safe_temperature": 240}
        self.controller.state = RoasterState.IDLE
        self.controller.connect_hardware = AsyncMock(side_effect=AssertionError("Hardware forbidden"))
        app.state.controller = self.controller
        app.state.dm = self.dm
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        self.controller.connect_hardware.assert_not_called()
        await self.client.aclose()
        self.directory.cleanup()

    async def test_offline_engine_errors_are_visible(self):
        response = await self.client.post("/api/v1/workbench", json={"action": "new"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["curves"]), 2)
        self.assertEqual((await self.client.post("/api/v1/workbench", json={"document": {"kind": "log", "data": "bad"}})).status_code, 422)

    async def test_native_save_new_ids_preserve_source_and_never_apply(self):
        document = dispatch({"action": "new"})["document"]
        ids = []
        for _ in range(2):
            response = await self.client.post("/api/v1/workbench/profiles", json={"document": document})
            self.assertEqual(response.status_code, 200, response.text)
            ids.append(response.json()["id"])
            saved = await self.dm.load_profile(ids[-1])
            self.assertEqual(saved.native_source, document)
        self.assertNotEqual(ids[0], ids[1])
        self.assertEqual(len(await self.dm.list_profiles()), 2)
        self.assertEqual(self.controller.state, RoasterState.IDLE)
        self.controller.state = RoasterState.ROASTING
        self.assertEqual((await self.client.post("/api/v1/workbench/profiles", json={"document": document})).status_code, 409)
        self.assertEqual(self.controller.state, RoasterState.ROASTING)

    async def test_device_temperature_limit_rejects_native_conversion(self):
        self.controller.config["max_safe_temperature"] = 180
        response = await self.client.post("/api/v1/workbench/profiles", json={"document": dispatch({"action": "new"})["document"]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(await self.dm.list_profiles(), [])
