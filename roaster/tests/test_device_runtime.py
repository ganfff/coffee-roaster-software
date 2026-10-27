"""Device defaults, transport transitions and RTU validation without physical I/O."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import pytest

from device_main import create_app
from src.hardware.tc4s_async import AsyncTC4SCommunicator
from src.services import device_runtime


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ROASTER_DISABLE_AUTO_CONNECT","1")
    monkeypatch.setattr(device_runtime,"serial_ports",lambda:[])
    # Test guards prevent opening even an absent or configured physical port.
    monkeypatch.setattr(AsyncTC4SCommunicator,"connect",AsyncMock(return_value=False))
    monkeypatch.setattr(AsyncTC4SCommunicator,"set_sv",AsyncMock(side_effect=AssertionError("physical SV write in test")))
    app=create_app(data_dir=tmp_path)
    with TestClient(app) as value:
        yield value


def test_default_device_has_no_samples_or_heat(client):
    status=client.get("/api/v1/status").json()
    assert status["connection"]["mode"]=="device"
    assert status["connected"] is False
    assert status["pv"] is status["sv"] is None
    assert status["events"]==[]
    assert client.get("/api/v1/records").json()==[]
    response=client.post("/api/v1/control/start",json={})
    assert response.status_code==400
    assert "硬件未连接" in response.json()["detail"]
    AsyncTC4SCommunicator.set_sv.assert_not_called()


def test_switching_is_idle_only_and_histories_are_separate(client):
    settings={"mode":"simulator","port":"","baudrate":9600,"slave_id":1}
    assert client.post("/api/v1/connection",json=settings).status_code==200
    profile=client.get("/api/v1/profiles").json()[0]
    assert client.post("/api/v1/control/start",json={"profile_id":profile["id"]}).status_code==200
    assert client.post("/api/v1/connection",json={**settings,"mode":"device"}).status_code==409
    assert client.post("/api/v1/events",json={"type":"yellowing"}).status_code==200
    assert client.post("/api/v1/control/end").status_code==200
    assert client.post("/api/v1/control/save_and_clear").status_code==200
    assert len(client.get("/api/v1/records").json())==1
    assert client.post("/api/v1/connection",json={**settings,"mode":"device"}).status_code==200
    assert client.get("/api/v1/records").json()==[]
    status=client.get("/api/v1/status").json()
    assert status["pv"] is None and status["events"]==[] and not status["connected"]
    assert client.post("/api/v1/connection",json=settings).status_code==200
    assert len(client.get("/api/v1/records").json())==1


def test_parameters_validated_and_simulator_not_saved_as_startup(client,tmp_path):
    settings={"mode":"simulator","port":"COM99","baudrate":19200,"slave_id":2}
    assert client.post("/api/v1/connection",json={**settings,"port":"socket://host:1234"}).status_code==422
    assert client.post("/api/v1/connection",json={**settings,"slave_id":0}).status_code==422
    assert client.post("/api/v1/connection",json={**settings,"baudrate":123}).status_code==422
    assert client.post("/api/v1/connection",json=settings).status_code==200
    saved=json.loads((tmp_path/"connection.json").read_text("utf-8"))
    assert "mode" not in saved
    runtime=device_runtime.DeviceRuntime(SimpleNamespace(state=SimpleNamespace()),client.app.state.config,tmp_path)
    assert runtime.settings.mode=="device"
    assert runtime.settings.port=="COM99"
    assert runtime.settings.baudrate==19200
    assert runtime.settings.slave_id==2


def test_shutdown_requires_owned_token_and_idle(client):
    assert client.post("/api/v1/runtime/shutdown").status_code==403
    assert client.get("/api/v1/runtime/health").json()["application"]=="ganf-roaster"


def test_untrusted_browser_cannot_send_device_commands(client):
    for path in ("/api/v1/control/start","/api/v1/connection"):
        assert client.post(path,json={},headers={"Origin":"https://untrusted.example"}).status_code==403
        assert client.post(path,json={},headers={"Sec-Fetch-Site":"cross-site"}).status_code==403
    assert client.get("/api/v1/status").status_code==200
    # Native WebView remains an explicit supported UI origin.
    response=client.post("/api/v1/control/start",json={},headers={"Origin":"http://tauri.localhost"})
    assert response.status_code==400 and "硬件未连接" in response.json()["detail"]


def test_rtu_fragments_and_foreign_frames_are_not_telemetry():
    async def run():
        for slave,function,valid in [(1,3,True),(2,3,False),(1,4,False)]:
            communicator=AsyncTC4SCommunicator(port="TEST")
            communicator.connected=True
            communicator._flush_input_buffer=AsyncMock()
            communicator.reader=asyncio.StreamReader()
            request_writes=[]
            class Writer:
                def write(self,data):
                    request_writes.append(data)
                    frame=bytes([slave,function,2,0,142])
                    frame+=communicator.calculate_crc(frame)
                    communicator.reader.feed_data(frame[:2])
                    asyncio.get_running_loop().call_later(0.001,communicator.reader.feed_data,frame[2:])
                async def drain(self):
                    pass
            communicator.writer=Writer()
            result=await communicator.read_pv()
            assert result==142.0 if valid else result is None
            assert communicator.ready is False  # A serial handle / single reply is not a validated PV+SV cycle.
            assert all(request[1]==3 and request[2:4]==b'\x00\x00' for request in request_writes)
        communicator=AsyncTC4SCommunicator()
        communicator.write_register=AsyncMock()
        for value in (-1,301,float('nan'),float('inf')):
            assert await communicator.set_sv(value) is False
        communicator.write_register.assert_not_called()
    asyncio.run(run())
