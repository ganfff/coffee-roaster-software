"""Local pairing and OS-owned host key storage, independent of the controller."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import tempfile
import time


def private_directory(path: str | Path) -> Path:
    directory = Path(path).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        directory.chmod(0o700)
    return directory


def write_private(path: Path, value: dict) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".ai-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            path.chmod(0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _windows_key(name: str) -> str:
    import ctypes
    from ctypes import wintypes

    class Credential(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                    ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                    ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                    ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
                    ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD),
                    ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
                    ("UserName", wintypes.LPWSTR)]
    api = ctypes.WinDLL("Advapi32", use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                              ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredReadW.restype = wintypes.BOOL
    api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    api.CredWriteW.restype = wintypes.BOOL
    api.CredFree.argtypes = [ctypes.c_void_p]
    pointer = ctypes.POINTER(Credential)()
    if api.CredReadW(name, 1, 0, ctypes.byref(pointer)):
        try:
            return ctypes.string_at(pointer.contents.CredentialBlob,
                                    pointer.contents.CredentialBlobSize).decode("ascii")
        finally:
            api.CredFree(pointer)
    if ctypes.get_last_error() != 1168:
        raise OSError(ctypes.get_last_error(), "Windows AI 凭据读取失败")
    value = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
    raw = (ctypes.c_ubyte * len(value)).from_buffer_copy(value.encode("ascii"))
    entry = Credential(Type=1, TargetName=name, CredentialBlobSize=len(value),
                       CredentialBlob=raw, Persist=2, UserName="RoasterAI")
    if not api.CredWriteW(ctypes.byref(entry), 0):
        raise OSError(ctypes.get_last_error(), "Windows AI 凭据保存失败")
    return value


def master_key(directory: Path) -> str:
    if os.name == "nt":
        identity = hashlib.sha256(str(directory).encode()).hexdigest()[:24]
        value = _windows_key("RoasterAI:host-master:" + identity)
    else:
        path = directory / "master-key.json"
        if path.exists():
            if path.stat().st_mode & 0o077:
                raise PermissionError("AI master-key.json 权限必须是 0600")
            value = json.loads(path.read_text("utf-8"))["key"]
        else:
            value = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
            write_private(path, {"key": value})
    if len(base64.b64decode(value, validate=True)) != 32:
        raise ValueError("AI 主密钥格式错误")
    return value


class PairStore:
    """Only hashes of pairing codes and client bearer tokens are persisted."""
    def __init__(self, directory: str | Path):
        self.directory = private_directory(directory)
        self.path = self.directory / "pairing.json"

    def _read(self):
        return json.loads(self.path.read_text("utf-8")) if self.path.exists() else {"clients": []}

    @staticmethod
    def _digest(value):
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    def create_code(self, lifetime: int = 600) -> str:
        state = self._read()
        code = f"{secrets.randbelow(100_000_000):08d}"
        state["pairing"] = {"hash": self._digest(code), "expires": time.time() + lifetime,
                            "attempts": 0}
        write_private(self.path, state)
        return code

    def pair(self, code: str, name: str) -> dict:
        state = self._read()
        pending = state.get("pairing", {})
        if pending.get("expires", 0) < time.time() or pending.get("attempts", 5) >= 5:
            raise PermissionError("配对码已失效，请在 AI 宿主上生成新码")
        pending["attempts"] += 1
        valid = hmac.compare_digest(pending.get("hash", ""), self._digest(str(code)))
        write_private(self.path, state)
        if not valid:
            raise PermissionError("配对码不正确")
        token = secrets.token_urlsafe(32)
        client = {"id": secrets.token_hex(16), "name": str(name).strip()[:100] or "浏览器",
                  "created_at": time.time(), "expires_at": time.time() + 30 * 86400,
                  "token_hash": self._digest(token)}
        state.setdefault("clients", []).append(client)
        state.pop("pairing", None)
        write_private(self.path, state)
        return {**self.public_client(client), "token": token}

    @staticmethod
    def public_client(client):
        return {k: v for k, v in client.items() if k != "token_hash"}

    def authenticate(self, token: str | None):
        if not token:
            return None
        digest = self._digest(token)
        for client in self._read().get("clients", []):
            if client.get("expires_at", 0) > time.time() and hmac.compare_digest(client["token_hash"], digest):
                return self.public_client(client)
        return None

    def clients(self):
        return [self.public_client(c) for c in self._read().get("clients", [])
                if c.get("expires_at", 0) > time.time()]

    def revoke(self, identity: str):
        state = self._read()
        state["clients"] = [c for c in state.get("clients", []) if c["id"] != identity]
        write_private(self.path, state)
