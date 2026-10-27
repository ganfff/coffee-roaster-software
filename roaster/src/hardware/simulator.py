"""Settings-only in-memory transport. Never opens a serial device."""
import asyncio
from datetime import datetime
import time


class SimulatedTC4SCommunicator:
    port, baudrate, slave_id = "", 9600, 1
    last_error, last_seen = "", None

    def __init__(self):
        self.connected = False
        self.pv, self.sv = 24.0, 0.0
        self._callbacks, self._task = [], None
        self._last = time.monotonic()

    @property
    def ready(self):
        return self.connected

    async def connect(self):
        self.connected = True
        return True

    def register_callback(self, callback):
        self._callbacks.append(callback)

    def register_status_callback(self, callback):
        pass

    async def set_sv(self, temperature):
        self.sv = float(temperature)
        return True

    async def start_monitoring(self, interval=0.5):
        if not self._task:
            self._task = asyncio.create_task(self._monitor(interval))

    async def _monitor(self, interval):
        while self.connected:
            now = time.monotonic()
            dt, self._last = now-self._last, now
            target = max(24.0, self.sv)
            self.pv += max(-2*dt, min(1.5*dt, (target-self.pv)*dt/12))
            self.last_seen = datetime.now().isoformat()
            for callback in self._callbacks:
                await callback({"pv":round(self.pv,1),"sv":self.sv,"timestamp":self.last_seen})
            await asyncio.sleep(interval)

    async def stop_monitoring(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def disconnect(self):
        self.connected = False
        await self.stop_monitoring()
