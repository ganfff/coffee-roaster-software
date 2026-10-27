"""Reject browser-origin control writes while permitting same-origin and native clients."""
from urllib.parse import urlsplit
from starlette.responses import JSONResponse


class DeviceOriginMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path=scope.get("path","")
        controls=(path=="/ws" or path.startswith("/api/")) and not path.startswith("/api/v1/ai/")
        mutation=scope["type"]=="websocket" or scope.get("method") not in ("GET","HEAD","OPTIONS")
        if controls and mutation:
            headers={key.decode().lower():value.decode() for key,value in scope.get("headers",[])}
            origin=headers.get("origin")
            if origin:
                parsed=urlsplit(origin)
                trusted=(origin in ("http://tauri.localhost","https://tauri.localhost","tauri://localhost") or
                         (parsed.scheme in ("http","https") and parsed.netloc.lower()==headers.get("host","").lower()
                          and parsed.path in ("", "/") and not parsed.query and not parsed.fragment and not parsed.username))
            else:
                trusted=headers.get("sec-fetch-site","none") in ("none","same-origin")
            if not trusted:
                if scope["type"]=="websocket":
                    await send({"type":"websocket.close","code":4403})
                else:
                    await JSONResponse({"detail":"设备操作仅接受当前控制台或本机桌面客户端"},status_code=403)(scope,receive,send)
                return
        await self.app(scope,receive,send)
