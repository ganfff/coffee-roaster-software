"""Local browser access must not turn into LAN access or a rebinding bypass."""
import unittest
from unittest.mock import patch

from fastapi import FastAPI
import httpx
from src.ai.api import router, NonAiCORSMiddleware


class LocalBrowserTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.add_middleware(NonAiCORSMiddleware, allow_origins=["*"])
        self.app.state.ai_host = type("Host", (), {
            "available": True, "process": None,
            "request": staticmethod(self.request),
        })()

    @staticmethod
    async def request(method, params):
        return {"method": method}

    async def test_local_same_origin_browser_can_configure_without_pairing(self):
        for origin, peer in [("http://localhost", "127.0.0.1"),
                             ("http://127.0.0.1:8000", "127.0.0.1"),
                             ("http://[::1]:8000", "::1")]:
            with self.subTest(origin=origin):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=(peer, 1234)), base_url=origin) as client:
                    self.assertTrue((await client.get("/api/v1/ai/status")).json()["paired"])
                    result = await client.post("/api/v1/ai/rpc", headers={"Origin": origin}, json={"method": "providers"})
                    self.assertEqual(result.json(), {"method": "providers"})

    async def test_remote_peer_rebinding_host_and_foreign_origin_do_not_gain_access(self):
        for origin, peer, header in [
            ("http://localhost", "192.168.1.23", "http://localhost"),
            ("http://attacker.example", "127.0.0.1", "http://attacker.example"),
            ("http://localhost", "127.0.0.1", "https://attacker.example"),
        ]:
            with self.subTest(origin=origin, peer=peer), patch("src.ai.api.store_for") as store:
                store.return_value.authenticate.return_value = None
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=(peer, 1234)), base_url=origin) as client:
                    result = await client.post("/api/v1/ai/rpc", headers={"Origin": header}, json={"method": "providers"})
                    self.assertIn(result.status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
