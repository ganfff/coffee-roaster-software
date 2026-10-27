"""One controller, explicit transport switching, and separate device/simulation records."""
import asyncio
import copy
import json
import os
from pathlib import Path
import re
import shutil

from pydantic import BaseModel, Field, field_validator
from serial.tools import list_ports

from src.core.roaster_controller import RoasterController
from src.hardware.simulator import SimulatedTC4SCommunicator
from src.services.data_manager import DataManager


class ConnectionSettings(BaseModel):
    mode: str = "device"
    port: str = Field("", max_length=256)
    baudrate: int = 9600
    slave_id: int = Field(1, ge=1, le=247)

    @field_validator("mode")
    @classmethod
    def mode_valid(cls, value):
        if value not in ("device", "simulator"):
            raise ValueError("连接模式无效")
        return value

    @field_validator("port")
    @classmethod
    def port_valid(cls, value):
        value = value.strip()
        if value and not re.fullmatch(r"COM[1-9][0-9]*|/dev/tty(?:USB|ACM|AMA|S)[0-9]+|/dev/serial/by-id/[A-Za-z0-9_.:+-]+", value, re.I):
            raise ValueError("请选择 COM 串口或 /dev 下的设备串口")
        return value

    @field_validator("baudrate")
    @classmethod
    def baudrate_valid(cls, value):
        if value not in (1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200):
            raise ValueError("不支持此波特率")
        return value


def serial_ports():
    return [{"device":p.device,"description":p.description,"usb":p.vid is not None,
             "serial_number":p.serial_number} for p in sorted(list_ports.comports(), key=lambda p:p.device)]


class DeviceRuntime:
    def __init__(self, app, config, data_dir, presets=None):
        self.app, self.config = app, copy.deepcopy(config)
        self.data_dir, self.presets = Path(data_dir), presets
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.settings_file = self.data_dir / "connection.json"
        serial = dict(config.get("serial", {}))
        if os.name == "nt" and str(serial.get("port", "")).startswith("/dev/"):
            serial["port"] = ""
        try:
            serial.update(json.loads(self.settings_file.read_text("utf-8")))
        except FileNotFoundError:
            pass
        # A prior simulation session never becomes the next startup's default.
        self.settings = ConnectionSettings(**{**serial,"mode":"device"})
        self._heartbeat = None
        self._lock = asyncio.Lock()
        self._stopped = False
        self._install_controller()

    def resolve_port(self):
        if self.settings.port:
            return self.settings.port
        candidates = [p["device"] for p in serial_ports() if p["usb"]]
        return candidates[0] if len(candidates) == 1 else ""

    def _install_controller(self):
        mode = self.settings.mode
        config = copy.deepcopy(self.config)
        config["serial"] = self.settings.model_dump(exclude={"mode"})
        config["connection_mode"] = mode
        directory = self.data_dir if mode == "device" else self.data_dir / "simulator"
        config["paths"] = {"profiles_dir":str(directory / "profiles"),"records_dir":str(directory / "records")}
        dm = DataManager(config)
        if self.presets and not any(dm.profiles_dir.glob("*.json")):
            for source in Path(self.presets).glob("*.json"):
                shutil.copy2(source, dm.profiles_dir / source.name)
        controller = RoasterController(config, dm)
        if mode == "simulator":
            controller.tc4s = SimulatedTC4SCommunicator()
            controller.tc4s.register_callback(controller._on_tc4s_data)
            controller.tc4s.register_status_callback(controller._on_connection_status)
        else:
            controller.tc4s.resolve_port = self.resolve_port
        self.app.state.controller, self.app.state.dm = controller, dm
        self.app.state.config = config

    async def start(self, broadcast):
        self.broadcast = broadcast
        await self.app.state.dm.init_db()
        controller = self.app.state.controller
        controller.set_broadcast_callback(broadcast)
        if os.environ.get("ROASTER_DISABLE_AUTO_CONNECT") != "1":
            await controller.connect_hardware()
        self._heartbeat = asyncio.create_task(self._publish_status())

    async def _publish_status(self):
        while not self._stopped:
            controller = self.app.state.controller
            if controller.state.value == "ROASTING" and not bool(getattr(controller.tc4s,"ready",False)):
                await controller._enter_error_state("TC4S 遥测超时，已停止曲线控制")
            await self.broadcast(self.app.state.controller.get_state_payload())
            await asyncio.sleep(1)

    def status(self):
        controller = self.app.state.controller
        return {**controller.connection_info(),"settings":self.settings.model_dump(),"ports":serial_ports()}

    async def configure(self, value):
        settings = ConnectionSettings.model_validate(value)
        async with self._lock:
            previous = self.app.state.controller
            async with previous._state_lock:
                if getattr(previous,"_connection_changing",False):
                    raise RuntimeError("控制服务正在退出，请重新打开软件")
                if previous.state.value != "IDLE":
                    raise RuntimeError("请先 End 并保存或放弃本锅，再切换设备或模式")
                saved = settings.model_dump(exclude={"mode"})
                temporary = self.settings_file.with_suffix(".tmp")
                temporary.write_text(json.dumps(saved,ensure_ascii=False,indent=2),"utf-8")
                temporary.replace(self.settings_file)
                previous._connection_changing = True
                await previous.disconnect_hardware()
                self.settings = settings
                self._install_controller()
                await self.app.state.dm.init_db()
                controller = self.app.state.controller
                controller.set_broadcast_callback(self.broadcast)
                if settings.mode == "simulator" or os.environ.get("ROASTER_DISABLE_AUTO_CONNECT") != "1":
                    await controller.connect_hardware()
                await self.broadcast(controller.get_state_payload())
        return self.status()

    async def stop(self):
        if self._stopped:
            return
        self._stopped = True
        if self._heartbeat:
            self._heartbeat.cancel()
            try:
                await self._heartbeat
            except asyncio.CancelledError:
                pass
        await self.app.state.controller.disconnect_hardware()
