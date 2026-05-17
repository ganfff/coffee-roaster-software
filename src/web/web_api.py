import json
import re
import urllib.parse
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Response, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import PlainTextResponse, JSONResponse, FileResponse

from src.core.roaster_controller import RoasterController
from src.services.data_manager import DataManager
from src.core.models import RoastProfile


_PROFILE_ID_RE = re.compile(r"^[0-9a-fA-F-]{1,64}$")


def _check_profile_id(profile_id: str) -> str:
    """对外部传入的 profile_id 做严格白名单校验,防路径穿越。"""
    if not isinstance(profile_id, str) or not _PROFILE_ID_RE.match(profile_id):
        raise HTTPException(status_code=400, detail="非法的曲线 ID")
    return profile_id


def _sanitize_filename(name: str) -> str:
    """清理 Content-Disposition filename:去掉控制字符、引号、CRLF,长度上限 100。"""
    safe = re.sub(r"[\x00-\x1f\x7f\"\\/]", "_", name or "profile")
    return safe[:100] or "profile"


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
        if cmd == "__ping":
            # 心跳保活:前端定期发送,服务端直接 ack,不触碰 controller
            await websocket.send_json({"ok": True})
            return
        if cmd == "start":
            await controller.start_roast(data.get("profile_id"))
        elif cmd == "save_and_clear":
            await controller.save_and_clear()
        elif cmd == "discard_and_clear":
            await controller.discard_and_clear()
        elif cmd == "emergency_stop":
            await controller.emergency_stop()
        elif cmd == "event":
            await controller.log_event(data.get("type", ""), data.get("note", ""))
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
        # 不回显原生异常细节,避免泄漏内部路径/堆栈
        await websocket.send_json({"error": "命令处理失败"})


# ========== REST API ==========

@app.get("/api/v1/status")
async def api_status():
    controller: RoasterController = app.state.controller
    return controller.get_state_payload()


# --- 控制 ---
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
    _check_profile_id(profile_id)
    dm: DataManager = app.state.dm
    profile = await dm.load_profile(profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="曲线不存在")
    return profile.model_dump()


@app.get("/api/v1/profiles/{profile_id}/export")
async def api_export_profile(profile_id: str):
    """导出曲线为 JSON 附件下载"""
    _check_profile_id(profile_id)
    dm: DataManager = app.state.dm
    profile = await dm.load_profile(profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="曲线不存在")
    # filename 走 RFC 5987 UTF-8 编码 + ASCII fallback,避免曲线名中的特殊字符注入响应头
    fallback = _sanitize_filename(profile.name)
    encoded = urllib.parse.quote(f"{profile.name}.json", safe="")
    return Response(
        content=profile.model_dump_json(indent=2),
        media_type="application/json",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{fallback}.json"; '
                f"filename*=UTF-8''{encoded}"
            ),
        },
    )


@app.post("/api/v1/profiles")
async def api_save_profile(payload: dict):
    dm: DataManager = app.state.dm
    # 防御:不允许客户端任意指定 id,统一在服务端生成,避免路径穿越
    if isinstance(payload, dict) and "id" in payload:
        payload = {k: v for k, v in payload.items() if k != "id"}
    try:
        profile = RoastProfile.model_validate(payload)
    except Exception:
        raise HTTPException(status_code=400, detail="曲线数据格式错误")
    try:
        await dm.save_profile(profile)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "id": profile.id}


@app.delete("/api/v1/profiles/{profile_id}")
async def api_delete_profile(profile_id: str):
    _check_profile_id(profile_id)
    dm: DataManager = app.state.dm
    ok = await dm.delete_profile(profile_id)
    if not ok:
        raise HTTPException(status_code=404, detail="曲线不存在")
    return {"success": True}


@app.post("/api/v1/profiles/import")
async def api_import_profile(payload: dict):
    dm: DataManager = app.state.dm
    try:
        if isinstance(payload, dict) and "id" in payload:
            payload = {k: v for k, v in payload.items() if k != "id"}
        profile = RoastProfile.model_validate(payload)
        await dm.save_profile(profile)
        return {"success": True, "id": profile.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        raise HTTPException(status_code=400, detail="曲线数据格式错误")


# --- 记录 ---
@app.get("/api/v1/records")
async def api_list_records(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=100000),
):
    dm: DataManager = app.state.dm
    records = await dm.list_records(limit=limit, offset=offset)
    return [r.model_dump() for r in records]


@app.get("/api/v1/records/{session_id}")
async def api_get_record(session_id: str):
    _check_profile_id(session_id)  # 同一格式(UUID-like)校验,防路径穿越
    dm: DataManager = app.state.dm
    record = await dm.get_record(session_id)
    if not record:
        raise HTTPException(status_code=404, detail="记录不存在")
    return JSONResponse(content=json.loads(record.model_dump_json()))


@app.get("/api/v1/records/{session_id}/export/csv")
async def api_export_csv(session_id: str):
    _check_profile_id(session_id)
    dm: DataManager = app.state.dm
    csv_data = await dm.export_csv(session_id)
    if csv_data is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    return PlainTextResponse(content=csv_data, media_type="text/csv")


@app.get("/api/v1/records/{session_id}/export/json")
async def api_export_json(session_id: str):
    _check_profile_id(session_id)
    dm: DataManager = app.state.dm
    json_data = await dm.export_json(session_id)
    if json_data is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    return JSONResponse(content=json.loads(json_data))
