"""Authenticated AI-only routes. No controller object is accepted or imported."""
from __future__ import annotations

import asyncio
import json
from ipaddress import ip_address
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from .auth import PairStore
from .host import AiHost

COOKIE = "roaster_ai_client"
PREFIX = "/api/v1/ai"
router = APIRouter(prefix=PREFIX)


def same_origin(scope):
    headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
    origin = headers.get("origin")
    if not origin:
        return headers.get("sec-fetch-site", "none") not in ("cross-site", "same-site")
    parsed = urlsplit(origin)
    scheme = "https" if scope.get("scheme") in ("https", "wss") else "http"
    return (parsed.scheme == scheme and parsed.netloc.lower() == headers.get("host", "").lower()
            and parsed.path in ("", "/") and not parsed.query and not parsed.fragment)


class NonAiCORSMiddleware(CORSMiddleware):
    """Keep the existing controller CORS policy away from credential-bearing AI."""
    async def __call__(self, scope, receive, send):
        if scope.get("path", "").startswith(PREFIX):
            if scope["type"] in ("http", "websocket") and not same_origin(scope):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4403})
                else:
                    await JSONResponse({"detail": "AI 仅接受同源浏览器或已配对的原生客户端"}, status_code=403)(scope, receive, send)
                return
            if scope["type"] == "http" and scope.get("method") == "OPTIONS":
                await JSONResponse({"detail": "AI 不提供跨源浏览器访问"}, status_code=403)(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return
        await super().__call__(scope, receive, send)


def host_for(app):
    if not getattr(app.state, "ai_host", None):
        config = getattr(app.state, "config", {}).get("ai", {})
        app.state.ai_host = AiHost(config)
    return app.state.ai_host


def store_for(app):
    return PairStore(host_for(app).directory)


def client_for(connection):
    # A same-origin browser on this machine needs no cross-device pairing.
    # Check both peer address and Host: loopback alone would permit DNS rebinding.
    try:
        local_peer = connection.client and ip_address(connection.client.host).is_loopback
        local_host = urlsplit("http://" + connection.headers.get("host", "")).hostname in {
            "localhost", "127.0.0.1", "::1"
        }
        if local_peer and local_host and same_origin(connection.scope):
            return {"id": "local-machine", "name": "本机浏览器"}
    except ValueError:
        pass
    bearer = connection.headers.get("authorization", "")
    token = bearer[7:] if bearer.startswith("Bearer ") else connection.cookies.get(COOKIE)
    return store_for(connection.app).authenticate(token)


def require_client(connection):
    client = client_for(connection)
    if not client:
        raise HTTPException(401, "请先使用宿主生成的配对码连接 AI")
    return client


@router.get("/status")
async def status(request: Request):
    host = host_for(request.app)
    client = client_for(request)
    return {"available": host.available, "paired": client is not None,
            "client": client, "host": "backend", "running": host.process is not None}


@router.post("/pair")
async def pair(request: Request, response: Response):
    try:
        payload = await request.json()
        if not isinstance(payload, dict) or len(str(payload.get("code", ""))) > 64:
            raise ValueError("配对请求格式错误")
        paired = store_for(request.app).pair(payload.get("code", ""), payload.get("name", "浏览器"))
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc))
    token = paired.pop("token")
    response.set_cookie(COOKIE, token, max_age=30 * 86400, path=PREFIX,
                        httponly=True, secure=request.url.scheme == "https", samesite="strict")
    # Browser sessions retain only an HttpOnly cookie. The native proxy holds its bearer in CredMan.
    if (payload.get("native") is True and request.headers.get("x-roaster-native") == "1"
            and not request.headers.get("origin") and not request.headers.get("sec-fetch-mode")):
        paired["token"] = token
    return paired


@router.get("/clients")
async def clients(request: Request):
    require_client(request)
    return store_for(request.app).clients()


@router.delete("/clients/{identity}")
async def revoke(request: Request, identity: str):
    require_client(request)
    store_for(request.app).revoke(identity)
    return {"deleted": True}


@router.post("/rpc")
async def rpc(request: Request):
    require_client(request)
    raw = await request.body()
    if len(raw) > 16_000_000:
        raise HTTPException(413, "AI 请求过大")
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict) or not isinstance(payload.get("params", {}), dict):
            raise ValueError("AI 请求格式错误")
        return await host_for(request.app).request(payload.get("method"), payload.get("params", {}))
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc))
    except (RuntimeError, OSError, asyncio.TimeoutError) as exc:
        raise HTTPException(503, str(exc) or "AI 服务请求超时")


@router.get("/events")
async def events(request: Request, after: int = 0, timeout_ms: int = 20000):
    require_client(request)
    return await host_for(request.app).poll(max(0, after), min(25, max(0, timeout_ms) / 1000))


@router.websocket("/ws")
async def websocket(socket: WebSocket):
    if not same_origin(socket.scope) or not client_for(socket):
        await socket.close(code=4401)
        return
    await socket.accept()
    host = host_for(socket.app)
    try:
        after = max(0, int(socket.query_params.get("after", "0")))
    except ValueError:
        after = 0
    try:
        while True:
            # A revoked/expired session stops receiving events even on an existing socket.
            if not client_for(socket):
                await socket.close(code=4401)
                return
            batch = await host.poll(after, 20)
            after = batch["cursor"]
            await socket.send_json(batch)
    except (WebSocketDisconnect, RuntimeError):
        return


async def close_host(app):
    host = getattr(app.state, "ai_host", None)
    if host:
        await host.close()
