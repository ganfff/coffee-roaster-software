"""AI-only security/process contracts. These tests never import the hardware backend."""
import asyncio
import base64
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from src.ai.api import NonAiCORSMiddleware, router
from src.ai.auth import PairStore
from src.ai.host import AiHost


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = PairStore(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_pair_code_is_single_use_and_secrets_are_hashed(self):
        code = self.store.create_code()
        client = self.store.pair(code, "桌面")
        persisted = Path(self.temporary.name, "pairing.json").read_text("utf-8")
        self.assertNotIn(client["token"], persisted)
        self.assertNotIn(code, persisted)
        self.assertEqual(self.store.authenticate(client["token"])["id"], client["id"])
        with self.assertRaises(PermissionError):
            self.store.pair(code, "重放")
        self.store.revoke(client["id"])
        self.assertIsNone(self.store.authenticate(client["token"]))

    def test_five_failed_attempts_invalidate_code(self):
        code = self.store.create_code()
        for _ in range(5):
            with self.assertRaises(PermissionError):
                self.store.pair("invalid", "测试")
        with self.assertRaises(PermissionError):
            self.store.pair(code, "正确但锁定")

    def test_expired_code_cannot_pair(self):
        code = self.store.create_code(lifetime=-1)
        with self.assertRaises(PermissionError):
            self.store.pair(code, "测试")


class FakeHost:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.available = True
        self.process = None
        self.requests = []

    async def request(self, method, params):
        self.requests.append((method, params))
        return [{"id": "test", "name": "测试"}]

    async def poll(self, after, timeout):
        await asyncio.sleep(0.01)
        return {"cursor": 4, "events": [{"id": "run", "type": "text", "data": "测试", "cursor": 4}], "replay_required": False}


class AiApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = PairStore(self.temporary.name)
        self.app = FastAPI()
        self.app.add_middleware(NonAiCORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
        self.app.include_router(router)
        self.app.state.ai_host = FakeHost(self.temporary.name)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://host")

    async def asyncTearDown(self):
        await self.client.aclose()
        self.temporary.cleanup()

    async def pair(self, native=False):
        code = self.store.create_code()
        headers = {"X-Roaster-Native": "1"} if native else {"Origin": "http://host"}
        return await self.client.post("/api/v1/ai/pair", json={"code": code, "name": "测试", "native": native}, headers=headers)

    async def test_unpaired_client_cannot_read_or_mutate_ai(self):
        self.assertFalse((await self.client.get("/api/v1/ai/status")).json()["paired"])
        for path in ("clients", "events?timeout_ms=0"):
            self.assertEqual((await self.client.get("/api/v1/ai/" + path)).status_code, 401)
        self.assertEqual((await self.client.post("/api/v1/ai/rpc", json={"method": "providers"})).status_code, 401)
        self.assertEqual(self.app.state.ai_host.requests, [])

    async def test_browser_cookie_http_only_and_authenticated_rpc(self):
        response = await self.pair()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("token", response.json())
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertIn("SameSite=strict", response.headers["set-cookie"])
        self.assertTrue((await self.client.get("/api/v1/ai/status")).json()["paired"])
        rpc = await self.client.post("/api/v1/ai/rpc", json={"method": "providers", "params": {}}, headers={"Origin": "http://host"})
        self.assertEqual(rpc.status_code, 200)
        self.assertEqual(self.app.state.ai_host.requests, [("providers", {})])

    async def test_cross_origin_ai_does_not_inherit_wildcard_cors(self):
        await self.pair()
        for origin in ("https://evil.test", "http://host.evil.test", "null", "http://host:9999"):
            response = await self.client.post("/api/v1/ai/rpc", json={"method": "providers"}, headers={"Origin": origin})
            self.assertEqual(response.status_code, 403)
            self.assertNotIn("access-control-allow-origin", response.headers)
        response = await self.client.options("/api/v1/ai/rpc", headers={"Origin": "https://evil.test", "Access-Control-Request-Method": "POST"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.app.state.ai_host.requests, [])

    async def test_native_pair_bearer_and_revocation(self):
        response = await self.pair(native=True)
        token = response.json()["token"]
        identity = response.json()["id"]
        self.client.cookies.clear()
        headers = {"Authorization": "Bearer " + token}
        self.assertEqual((await self.client.get("/api/v1/ai/events?timeout_ms=0", headers=headers)).json()["cursor"], 4)
        self.assertEqual((await self.client.delete("/api/v1/ai/clients/" + identity, headers=headers)).status_code, 200)
        self.assertEqual((await self.client.get("/api/v1/ai/clients", headers=headers)).status_code, 401)

    async def test_browser_cannot_request_native_bearer(self):
        code = self.store.create_code()
        response = await self.client.post("/api/v1/ai/pair", json={"code": code, "native": True}, headers={"Origin": "http://host", "X-Roaster-Native": "1"})
        self.assertNotIn("token", response.json())


class AiWebSocketTests(unittest.TestCase):
    def test_websocket_requires_same_origin_pairing_and_replays_events(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = FastAPI()
            app.add_middleware(NonAiCORSMiddleware, allow_origins=["*"])
            app.include_router(router)
            app.state.ai_host = FakeHost(temporary)
            with TestClient(app) as client:
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect("/api/v1/ai/ws", headers={"Origin": "http://testserver"}):
                        pass
                code = PairStore(temporary).create_code()
                response = client.post("/api/v1/ai/pair", json={"code": code}, headers={"Origin": "http://testserver"})
                self.assertEqual(response.status_code, 200)
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect("/api/v1/ai/ws", headers={"Origin": "https://evil.test"}):
                        pass
                with client.websocket_connect("/api/v1/ai/ws?after=2", headers={"Origin": "http://testserver"}) as socket:
                    batch = socket.receive_json()
                    self.assertEqual(batch["cursor"], 4)
                    self.assertEqual(batch["events"][0]["type"], "text")


@unittest.skipUnless(shutil.which("node"), "Node required for safe fixture")
class HostProcessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        entry = self.directory / "fixture.mjs"
        entry.write_text('''import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
for await(const line of lines){const r=JSON.parse(line);let data=[];
if(r.method==='initialize')data={ready:true};
if(r.method==='runs.start')data={id:'run-1'};
process.stdout.write(JSON.stringify({id:r.id,type:'result',data})+'\\n');
if(r.method==='runs.start')setTimeout(()=>process.stdout.write(JSON.stringify({id:'run-1',type:'text',data:'ok',sequence:1})+'\\n'),10);
}''', encoding="utf-8")
        self.host = AiHost({"data_dir": str(self.directory / "data"), "node_path": shutil.which("node"), "service_path": str(entry)})
        self.key = patch("src.ai.host.master_key", return_value=base64.b64encode(b"x" * 32).decode())
        self.key.start()

    async def asyncTearDown(self):
        await self.host.close()
        self.key.stop()
        self.temporary.cleanup()

    async def test_rpc_and_async_events_share_persistent_process(self):
        self.assertEqual(await self.host.request("providers"), [])
        pid = self.host.process.pid
        self.assertEqual((await self.host.request("runs.start"))["id"], "run-1")
        batch = await self.host.poll(timeout=1)
        self.assertEqual(batch["events"][0]["data"], "ok")
        self.assertEqual(self.host.process.pid, pid)

    async def test_unavailable_runtime_and_unknown_method_do_not_start_process(self):
        with self.assertRaises(ValueError):
            await self.host.request("controller.start")
        self.host.node = str(self.directory / "missing-node")
        with self.assertRaises(RuntimeError):
            await self.host.request("providers")
        self.assertIsNone(self.host.process)

    async def test_child_exit_can_restart_only_for_a_new_request(self):
        await self.host.request("providers")
        old = self.host.process
        old.kill()
        await old.wait()
        await asyncio.sleep(0.05)
        self.assertIsNone(self.host.process)
        await self.host.request("providers")
        self.assertNotEqual(self.host.process.pid, old.pid)

    async def test_event_cursor_recovers_after_backend_restart(self):
        batch = await self.host.poll(after=80, timeout=20)
        self.assertEqual(batch["cursor"], 0)
        self.assertTrue(batch["replay_required"])
        await self.host._publish({"id": "new", "type": "text", "data": "restored"})
        batch = await self.host.poll(after=80, timeout=20)
        self.assertEqual(batch["events"][0]["data"], "restored")
        self.assertTrue(batch["replay_required"])

    async def test_default_runtime_uses_backend_layout_and_really_runs_packaged_service(self):
        await self.host.close()
        self.host = AiHost({"data_dir": str(self.directory / "real-default-host")})
        backend = Path(__file__).resolve().parents[1]
        runtime = backend / "runtime"
        if not runtime.exists():
            runtime = backend.parent / "desktop/runtime"
        self.assertEqual(Path(self.host.service), runtime / "ai/service.mjs")
        if not self.host.available:
            self.skipTest("prepare:ai required for packaged default runtime check")
        providers = await self.host.request("providers")
        self.assertEqual(len([p for p in providers if p["subscription"]]), 5)

    async def test_default_ai_directory_and_cli_pairing_use_same_backend_root(self):
        backend = Path(__file__).resolve().parents[1]
        with patch("src.ai.host.private_directory", side_effect=lambda path: Path(path)):
            self.assertEqual(AiHost().directory, backend / "data/ai")
        from src.ai.__main__ import main
        with patch("sys.argv", ["ai", "clients"]), patch("src.ai.__main__.PairStore") as store:
            store.return_value.clients.return_value = []
            main()
            store.assert_called_once_with(str(backend / "data/ai"))


if __name__ == "__main__":
    unittest.main()
