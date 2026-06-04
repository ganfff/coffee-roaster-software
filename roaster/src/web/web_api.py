import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Response, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import PlainTextResponse, JSONResponse, FileResponse

from src.core.roaster_controller import RoasterController
from src.services.data_manager import (
    DataManager,
    RECORD_LIST_DEFAULT_LIMIT,
    RECORD_LIST_LIMIT_MAX,
    RECORD_LIST_LIMIT_MIN,
)
from src.core.models import RoastProfile


class ConnectionManager:
    """WebSocket 连接管理器：维护所有活跃连接并提供广播能力"""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        if not self.active_connections:
            return
        text = json.dumps(message, default=str)
        disconnected = []
        for conn in self.active_connections:
            try:
                await conn.send_text(text)
            except Exception:
                disconnected.append(conn)
        for conn in disconnected:
            self.disconnect(conn)


manager = ConnectionManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    dm: DataManager = app.state.dm
    await dm.init_db()
    controller: RoasterController = app.state.controller
    await controller.connect_hardware()
    controller.set_broadcast_callback(manager.broadcast)
    yield
    await controller.disconnect_hardware()


app = FastAPI(lifespan=lifespan)

# 静态文件服务
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/editor.html")
async def editor_page():
    return FileResponse("static/editor.html")


# ========== WebSocket ==========
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    controller: RoasterController = app.state.controller
    # 发送当前状态快照
    await websocket.send_json(controller.get_state_payload())
    try:
        while True:
            data = await websocket.receive_json()
            await _handle_ws_command(data, controller, websocket)
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)


async def _handle_ws_command(data: dict, controller: RoasterController, websocket: WebSocket):
    cmd = data.get("cmd")
    try:
        if cmd == "start":
            await controller.start_roast(data.get("profile_id"))
        elif cmd == "end":
            # 兼容入口：出豆事件会自动触发 end_roast，此处保留供老客户端/测试调用。
            await controller.end_roast()
        elif cmd == "save_and_clear":
            await controller.save_and_clear()
        elif cmd == "discard_and_clear":
            await controller.discard_and_clear()
        elif cmd == "emergency_stop":
            await controller.emergency_stop()
        elif cmd == "event":
            await controller.log_event(data.get("type", ""), data.get("note", ""))
        elif cmd == "set_lookahead":
            params = data.get("params") or {}
            value = params.get("value", data.get("value"))
            if value is None:
                await websocket.send_json({"error": "set_lookahead 缺少 value"})
                return
            controller.update_lookahead(float(value))
            await websocket.send_json({"ok": True})
        elif cmd == "set_phase_lookahead":
            params = data.get("params") or {}
            phase = params.get("phase", data.get("phase"))
            value = params.get("value", data.get("value"))
            if phase is None or value is None:
                await websocket.send_json({"error": "set_phase_lookahead 缺少 phase 或 value"})
                return
            controller.update_phase_lookahead(str(phase), float(value))
            await websocket.send_json({"ok": True})
        elif cmd == "set_lookahead_offset":
            params = data.get("params") or {}
            value = params.get("value", data.get("value"))
            if value is None:
                await websocket.send_json({"error": "set_lookahead_offset 缺少 value"})
                return
            controller.update_lookahead_offset(float(value))
            await websocket.send_json({"ok": True})
        else:
            await websocket.send_json({"error": f"未知命令: {cmd}"})
    except Exception as e:
        await websocket.send_json({"error": str(e)})


# ========== REST API ==========

@app.get("/api/v1/status")
async def api_status():
    controller: RoasterController = app.state.controller
    return controller.get_state_payload()


# --- 控制 ---
@app.post("/api/v1/control/start")
async def api_start(payload: dict = None):
    controller: RoasterController = app.state.controller
    try:
        profile_id = (payload or {}).get("profile_id")
        await controller.start_roast(profile_id)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/v1/control/end")
async def api_end():
    # 兼容入口：出豆事件会自动触发 end_roast，此处保留供老客户端/测试调用。
    controller: RoasterController = app.state.controller
    await controller.end_roast()
    return {"success": True}


@app.post("/api/v1/control/save_and_clear")
async def api_save_and_clear():
    controller: RoasterController = app.state.controller
    await controller.save_and_clear()
    return {"success": True}


@app.post("/api/v1/control/discard_and_clear")
async def api_discard_and_clear():
    controller: RoasterController = app.state.controller
    await controller.discard_and_clear()
    return {"success": True}


@app.post("/api/v1/control/emergency_stop")
async def api_emergency_stop():
    controller: RoasterController = app.state.controller
    await controller.emergency_stop()
    return {"success": True}


# --- 事件 ---
@app.post("/api/v1/events")
async def api_log_event(payload: dict):
    controller: RoasterController = app.state.controller
    event_type = payload.get("type", "")
    note = payload.get("note", "")
    await controller.log_event(event_type, note)
    return {"success": True}


# --- 曲线库 ---
@app.get("/api/v1/profiles")
async def api_list_profiles():
    dm: DataManager = app.state.dm
    profiles = await dm.list_profiles()
    return [p.model_dump() for p in profiles]


@app.get("/api/v1/profiles/{profile_id}")
async def api_get_profile(profile_id: str):
    dm: DataManager = app.state.dm
    profile = await dm.load_profile(profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="曲线不存在")
    return profile.model_dump()


@app.get("/api/v1/profiles/{profile_id}/export")
async def api_export_profile(profile_id: str):
    """导出曲线为 JSON 附件下载"""
    dm: DataManager = app.state.dm
    profile = await dm.load_profile(profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="曲线不存在")
    return Response(
        content=profile.model_dump_json(indent=2),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{profile.name}.json"'
        },
    )


@app.post("/api/v1/profiles")
async def api_save_profile(payload: dict):
    dm: DataManager = app.state.dm
    try:
        profile = RoastProfile.model_validate(payload)
        await dm.save_profile(profile)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"数据格式错误: {e}")
    return {"success": True, "id": profile.id}


@app.delete("/api/v1/profiles/{profile_id}")
async def api_delete_profile(profile_id: str):
    dm: DataManager = app.state.dm
    ok = await dm.delete_profile(profile_id)
    if not ok:
        raise HTTPException(status_code=404, detail="曲线不存在")
    return {"success": True}


@app.post("/api/v1/profiles/import")
async def api_import_profile(payload: dict):
    dm: DataManager = app.state.dm
    try:
        if "id" in payload:
            del payload["id"]
        profile = RoastProfile.model_validate(payload)
        await dm.save_profile(profile)
        return {"success": True, "id": profile.id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"数据格式错误: {e}")


# --- PID ---


# --- 记录 ---
@app.get("/api/v1/records")
async def api_list_records(
    limit: int = Query(
        RECORD_LIST_DEFAULT_LIMIT,
        ge=RECORD_LIST_LIMIT_MIN,
        le=RECORD_LIST_LIMIT_MAX,
    ),
    offset: int = Query(0, ge=0),
):
    dm: DataManager = app.state.dm
    records = await dm.list_records(limit=limit, offset=offset)
    return [r.model_dump() for r in records]


@app.get("/api/v1/records/{session_id}")
async def api_get_record(session_id: str):
    dm: DataManager = app.state.dm
    record = await dm.get_record(session_id)
    if not record:
        raise HTTPException(status_code=404, detail="记录不存在")
    return JSONResponse(content=json.loads(record.model_dump_json()))


@app.get("/api/v1/records/{session_id}/export/csv")
async def api_export_csv(session_id: str):
    dm: DataManager = app.state.dm
    csv_data = await dm.export_csv(session_id)
    if csv_data is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    return PlainTextResponse(content=csv_data, media_type="text/csv")


@app.get("/api/v1/records/{session_id}/export/json")
async def api_export_json(session_id: str):
    dm: DataManager = app.state.dm
    json_data = await dm.export_json(session_id)
    if json_data is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    return JSONResponse(content=json.loads(json_data))
