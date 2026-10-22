"""Optional AI teardown never delays or skips the deterministic device teardown."""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from src.web.web_api import lifespan


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def check_lifecycle(self, body_failure=False):
        calls = []

        async def mark(text):
            calls.append(text)

        async def ai_failure(app):
            calls.append("ai-close")
            raise RuntimeError("optional AI failed")

        controller = SimpleNamespace(
            connect_hardware=AsyncMock(side_effect=lambda: mark("connect")),
            disconnect_hardware=AsyncMock(side_effect=lambda: mark("disconnect")),
            set_broadcast_callback=lambda callback: None,
        )
        # AsyncMock does not await a coroutine returned by a synchronous side effect.
        async def connect():
            await mark("connect")
        async def disconnect():
            await mark("disconnect")
        controller.connect_hardware.side_effect = connect
        controller.disconnect_hardware.side_effect = disconnect
        app = SimpleNamespace(state=SimpleNamespace(
            controller=controller, dm=SimpleNamespace(init_db=AsyncMock())))
        with patch("src.web.web_api.close_ai_host", ai_failure):
            if body_failure:
                with self.assertRaisesRegex(ValueError, "body failure"):
                    async with lifespan(app):
                        calls.append("body")
                        raise ValueError("body failure")
            else:
                async with lifespan(app):
                    calls.append("body")
        self.assertEqual(calls, ["connect", "body", "disconnect", "ai-close"])

    async def test_ai_failure_happens_after_device_disconnect(self):
        await self.check_lifecycle()

    async def test_body_failure_still_disconnects_before_ai_and_keeps_original_error(self):
        await self.check_lifecycle(body_failure=True)
