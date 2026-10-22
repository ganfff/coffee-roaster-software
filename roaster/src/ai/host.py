"""Async JSON-lines host for the optional Node AI process. Never imports hardware."""
from __future__ import annotations

import asyncio
from collections import deque
import json
import os
from pathlib import Path
import secrets

from .auth import master_key, private_directory


METHODS = frozenset("providers profiles.list profiles.save profiles.delete models test auth.login auth.respond auth.cancel auth.logout conversations.list conversations.create conversations.get conversations.update conversations.delete runs.start runs.cancel runs.events tools.respond attachments.add attachments.get attachments.delete legacy.import".split())


class AiHost:
    def __init__(self, config: dict | None = None):
        config = config or {}
        base = Path(__file__).resolve().parents[2]
        runtime = Path(config.get("runtime_dir") or base / "runtime")
        fallback = base.parent / "desktop" / "runtime"
        if not runtime.exists() and fallback.exists():
            runtime = fallback
        self.directory = private_directory(config.get("data_dir") or base / "data" / "ai")
        self.node = str(config.get("node_path") or (runtime / ("ai-node-x86_64-pc-windows-msvc.exe" if os.name == "nt" else "node/bin/node")))
        self.service = str(config.get("service_path") or runtime / "ai/service.mjs")
        self.enabled = config.get("enabled", True)
        self.process = None
        self.pending = {}
        self.start_lock = asyncio.Lock()
        self.write_lock = asyncio.Lock()
        self.condition = asyncio.Condition()
        self.events = deque(maxlen=2000)
        self.sequence = 0
        self.reader_task = None
        self.stderr_task = None
        self.closing = False

    @property
    def available(self):
        return bool(self.enabled and Path(self.node).is_file() and Path(self.service).is_file())

    async def _publish(self, event):
        async with self.condition:
            self.sequence += 1
            self.events.append({**event, "cursor": self.sequence})
            self.condition.notify_all()

    async def _read(self, process):
        try:
            while raw := await process.stdout.readline():
                message = json.loads(raw)
                identity = str(message.get("id", ""))
                if message.get("type") in ("result", "error") and identity in self.pending:
                    future = self.pending.pop(identity)
                    if not future.done():
                        if message["type"] == "error":
                            future.set_exception(ValueError(message.get("data", {}).get("message", "AI 请求失败")))
                        else:
                            future.set_result(message.get("data"))
                else:
                    await self._publish(message)
        except (OSError, ValueError, asyncio.LimitOverrunError):
            pass
        finally:
            if self.process is process:
                for future in list(self.pending.values()):
                    if not future.done():
                        future.set_exception(RuntimeError("AI 服务已停止；进行中的请求不会自动重发"))
                self.pending.clear()
                self.process = None
            if not self.closing:
                await self._publish({"id": "host", "type": "host_error", "data": {"message": "AI 服务已停止，可重新发起请求"}})

    async def _drain_stderr(self, stream):
        # Drain without forwarding potentially provider-specific diagnostics to clients/logs.
        while await stream.read(4096):
            pass

    async def _start(self):
        async with self.start_lock:
            if self.process and self.process.returncode is None:
                return
            if self.closing or not self.available:
                raise RuntimeError("AI 运行时未安装；烘焙控制仍可正常使用")
            kwargs = {"creationflags": 0x08000000} if os.name == "nt" else {}
            process = await asyncio.create_subprocess_exec(self.node, self.service,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=20_000_000, **kwargs)
            self.process = process
            self.reader_task = asyncio.create_task(self._read(process))
            self.stderr_task = asyncio.create_task(self._drain_stderr(process.stderr))
            key = await asyncio.to_thread(master_key, self.directory)
            try:
                await self._request("initialize", {"data_dir": str(self.directory), "master_key": key})
            except Exception:
                process.kill()
                await process.wait()
                self.process = None
                raise

    async def _request(self, method, params):
        identity = secrets.token_hex(16)
        future = asyncio.get_running_loop().create_future()
        self.pending[identity] = future
        payload = json.dumps({"id": identity, "method": method, "params": params}, ensure_ascii=False).encode() + b"\n"
        if len(payload) > 16_000_000:
            self.pending.pop(identity, None)
            raise ValueError("AI 请求过大")
        try:
            async with self.write_lock:
                if self.process is None:
                    raise RuntimeError("AI 服务已停止")
                self.process.stdin.write(payload)
                await self.process.stdin.drain()
            return await asyncio.wait_for(future, 60)
        finally:
            self.pending.pop(identity, None)

    async def request(self, method, params=None):
        if method not in METHODS:
            raise ValueError("未知 AI 方法")
        await self._start()
        return await self._request(method, params or {})

    async def poll(self, after=0, timeout=20):
        async with self.condition:
            reset = after > self.sequence
            if reset:
                after = 0
            result = [event for event in self.events if event["cursor"] > after]
            if not result and timeout and not reset:
                try:
                    await asyncio.wait_for(self.condition.wait(), min(timeout, 25))
                except asyncio.TimeoutError:
                    pass
                result = [event for event in self.events if event["cursor"] > after]
            return {"events": result, "cursor": self.sequence,
                    "replay_required": reset or bool(self.events and after and after < self.events[0]["cursor"] - 1)}

    async def close(self):
        self.closing = True
        process = self.process
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        for task in (self.reader_task, self.stderr_task):
            if task and not task.done():
                task.cancel()
        self.process = None
