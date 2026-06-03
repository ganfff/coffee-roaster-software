import json
import csv
import io
import logging
from pathlib import Path
from typing import List, Optional
from uuid import uuid4
from datetime import datetime
import aiosqlite
import aiofiles

from src.core.models import (
    RoastProfile,
    ProfileSummary,
    RoastRecord,
    RecordSummary,
    RoastEvent,
)


logger = logging.getLogger(__name__)


class DataManager:
    def __init__(self, config: dict):
        self.profiles_dir = Path(config["paths"]["profiles_dir"])
        self.records_dir = Path(config["paths"]["records_dir"])
        self.db_path = self.records_dir / "roasts.db"

        self.profiles_dir.mkdir(parents=True, exist_ok=True)
        self.records_dir.mkdir(parents=True, exist_ok=True)

    def _profile_path(self, profile_id: str) -> Optional[Path]:
        if not profile_id or "/" in profile_id or "\\" in profile_id:
            logger.warning("拒绝不安全的 profile_id: %r", profile_id)
            return None
        try:
            base = self.profiles_dir.resolve()
            path = (self.profiles_dir / f"{profile_id}.json").resolve()
            path.relative_to(base)
        except Exception as e:
            logger.warning("拒绝解析 profile_id=%r 的路径: %s", profile_id, e)
            return None
        return path

    async def init_db(self):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS records (
                    session_id TEXT PRIMARY KEY,
                    started_at TEXT,
                    ended_at TEXT,
                    profile_id TEXT,
                    events_json TEXT,
                    data_json TEXT
                )
                """
            )
            # 向后兼容的列追加：老 db 上 ALTER 已有列会抛 OperationalError，吞掉
            for col_def in (
                "ALTER TABLE records ADD COLUMN seq_no INTEGER",
                "ALTER TABLE records ADD COLUMN display_name TEXT",
                "ALTER TABLE records ADD COLUMN profile_snapshot_json TEXT",
                "ALTER TABLE records ADD COLUMN duration_sec REAL",
            ):
                try:
                    await db.execute(col_def)
                except Exception:
                    pass
            await db.commit()

    async def load_profile(self, profile_id: str) -> Optional[RoastProfile]:
        path = self._profile_path(profile_id)
        if path is None or not path.exists():
            return None
        async with aiofiles.open(path, "r", encoding="utf-8") as f:
            content = await f.read()
        try:
            return RoastProfile.model_validate_json(content)
        except Exception as e:
            logger.warning("曲线 JSON 解析失败: %s (%s)", path.name, e)
            return None

    async def save_profile(self, profile: RoastProfile) -> None:
        path = self._profile_path(profile.id)
        if path is None:
            raise ValueError(f"不安全的曲线 ID: {profile.id}")
        async with aiofiles.open(path, "w", encoding="utf-8") as f:
            await f.write(profile.model_dump_json(indent=2))

    async def delete_profile(self, profile_id: str) -> bool:
        path = self._profile_path(profile_id)
        if path is not None and path.exists():
            path.unlink()
            return True
        return False

    async def list_profiles(self) -> List[ProfileSummary]:
        summaries = []
        for p in sorted(self.profiles_dir.glob("*.json")):
            try:
                async with aiofiles.open(p, "r", encoding="utf-8") as f:
                    content = await f.read()
                profile = RoastProfile.model_validate_json(content)
                summaries.append(
                    ProfileSummary(
                        id=profile.id, name=profile.name, node_count=len(profile.nodes)
                    )
                )
            except Exception as e:
                logger.warning("跳过无法解析的曲线文件: %s (%s)", p.name, e)
                continue
        return summaries

    def new_session_id(self) -> str:
        return str(uuid4())

    async def save_record(self, record: RoastRecord) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            # 分配自增 seq_no（与 PRIMARY KEY 解耦，老记录 seq_no 为 NULL 也不影响）
            async with db.execute(
                "SELECT COALESCE(MAX(seq_no), 0) + 1 FROM records"
            ) as cursor:
                row = await cursor.fetchone()
                seq_no = int(row[0]) if row and row[0] is not None else 1
            display_name = f"log{seq_no:03d}"
            duration_sec = float(record.data[-1][0]) if record.data else 0.0
            snapshot_json = (
                record.profile_snapshot.model_dump_json()
                if record.profile_snapshot is not None
                else None
            )
            await db.execute(
                """
                INSERT OR REPLACE INTO records
                (session_id, started_at, ended_at, profile_id, events_json, data_json,
                 seq_no, display_name, profile_snapshot_json, duration_sec)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.session_id,
                    record.started_at.isoformat() if record.started_at else None,
                    record.ended_at.isoformat() if record.ended_at else None,
                    record.profile_id,
                    json.dumps([e.model_dump() for e in record.events]),
                    json.dumps(record.data),
                    seq_no,
                    display_name,
                    snapshot_json,
                    duration_sec,
                ),
            )
            await db.commit()
        # 写回到内存对象，方便调用方读到刚生成的标识
        record.seq_no = seq_no
        record.display_name = display_name

    async def get_record(self, session_id: str) -> Optional[RoastRecord]:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute(
                """
                SELECT session_id, started_at, ended_at, profile_id, events_json, data_json,
                       seq_no, display_name, profile_snapshot_json
                FROM records WHERE session_id = ?
                """,
                (session_id,),
            ) as cursor:
                row = await cursor.fetchone()
                if not row:
                    return None
                return self._row_to_record(row)

    async def list_records(self, limit: int = 50, offset: int = 0) -> List[RecordSummary]:
        """单次 SELECT 取出展示所需字段，避免 N+1。
        老记录无 seq_no/display_name/duration_sec 时透传 None/0.0；profile_name
        优先来自数据库 profile_id 对应的当前曲线（删除后即为 None）。"""
        summaries: List[RecordSummary] = []
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute(
                """
                SELECT session_id, started_at, profile_id, seq_no, display_name, duration_sec
                FROM records
                ORDER BY started_at DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ) as cursor:
                rows = await cursor.fetchall()

        # profile_name 仍按需查（不再每行打开一次记录全文）
        profile_name_cache: dict[str, Optional[str]] = {}
        for session_id, started_at_str, profile_id, seq_no, display_name, duration_sec in rows:
            started_at = datetime.fromisoformat(started_at_str) if started_at_str else None
            profile_name: Optional[str] = None
            if profile_id:
                if profile_id not in profile_name_cache:
                    p = await self.load_profile(profile_id)
                    profile_name_cache[profile_id] = p.name if p else None
                profile_name = profile_name_cache[profile_id]
            summaries.append(
                RecordSummary(
                    session_id=session_id,
                    started_at=started_at,
                    profile_name=profile_name,
                    duration_sec=float(duration_sec) if duration_sec is not None else 0.0,
                    seq_no=seq_no,
                    display_name=display_name,
                )
            )
        return summaries

    async def export_csv(self, session_id: str) -> Optional[str]:
        record = await self.get_record(session_id)
        if not record:
            return None
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["elapsed_sec", "pv", "sv", "ror"])
        for row in record.data:
            writer.writerow(row)
        return output.getvalue()

    async def export_json(self, session_id: str) -> Optional[str]:
        record = await self.get_record(session_id)
        if not record:
            return None
        return record.model_dump_json(indent=2)

    def _row_to_record(self, row) -> RoastRecord:
        (
            session_id,
            started_at_str,
            ended_at_str,
            profile_id,
            events_json,
            data_json,
            seq_no,
            display_name,
            profile_snapshot_json,
        ) = row
        started_at = datetime.fromisoformat(started_at_str) if started_at_str else None
        ended_at = datetime.fromisoformat(ended_at_str) if ended_at_str else None
        events = [RoastEvent(**e) for e in json.loads(events_json or "[]")]
        data = [tuple(item) for item in json.loads(data_json or "[]")]
        snapshot: Optional[RoastProfile] = None
        if profile_snapshot_json:
            try:
                snapshot = RoastProfile.model_validate_json(profile_snapshot_json)
            except Exception as e:
                logger.warning("记录 %s 的曲线快照 JSON 解析失败: %s", session_id, e)
                snapshot = None
        return RoastRecord(
            session_id=session_id,
            started_at=started_at,
            ended_at=ended_at,
            profile_id=profile_id,
            events=events,
            data=data,
            seq_no=seq_no,
            display_name=display_name,
            profile_snapshot=snapshot,
        )
