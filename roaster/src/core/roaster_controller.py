import asyncio
import logging
from datetime import datetime
from typing import Optional, Callable, Any, Coroutine

from src.hardware.tc4s_async import AsyncTC4SCommunicator
from src.services.data_manager import DataManager
from src.core.events import RoasterState
from src.core.models import (
    RoastProfile,
    RoastEvent,
    RoastRecord,
    RoasterStatus,
    PIDParams,
    PhaseLookaheadConfig,
)


logger = logging.getLogger(__name__)

BASE_LOOKAHEAD_MIN_SEC = 0.0
BASE_LOOKAHEAD_MAX_SEC = 30.0


class RoasterController:
    """烘焙机核心控制器：状态机、ROR 计算、曲线追踪、事件统计"""

    @staticmethod
    def _clamp_base_lookahead(value: Any) -> float:
        return max(
            BASE_LOOKAHEAD_MIN_SEC,
            min(BASE_LOOKAHEAD_MAX_SEC, float(value)),
        )

    def __init__(self, config: dict, data_manager: DataManager):
        self.config = config
        self.dm = data_manager
        self.state = RoasterState.IDLE
        self.tc4s = AsyncTC4SCommunicator(
            port=config["serial"]["port"],
            baudrate=config["serial"]["baudrate"],
            slave_id=config["serial"]["slave_id"],
        )
        self.tc4s.register_callback(self._on_tc4s_data)
        self.tc4s.register_status_callback(self._on_connection_status)
        self._state_lock = asyncio.Lock()
        self._broadcast_callback: Optional[
            Callable[[dict], Coroutine[Any, Any, None]]
        ] = None

        # SV 写入失败计数器（连续 3 次失败进入 ERROR）
        self._sv_write_failures: int = 0

        # PID 参数
        pid_cfg = config.get("pid", {})
        self.pid = PIDParams(
            kp=pid_cfg.get("kp", 60.0),
            ki=pid_cfg.get("ki", 0.01),
            kd=pid_cfg.get("kd", 20.0),
        )

        # 运行时数据
        self.current_pv: Optional[float] = None
        self.current_sv: Optional[float] = None
        self.ror: float = 0.0
        self.roast_start_time: Optional[datetime] = None
        self.profile: Optional[RoastProfile] = None
        self.session_id: Optional[str] = None
        self.event_log: list[RoastEvent] = []
        self._temp_history: list[tuple[float, float]] = []  # (elapsed_sec, temp)
        self._session_data: list[tuple[float, float, float, float]] = []  # (elapsed, pv, sv, ror)
        self._last_broadcast: Optional[datetime] = None
        self.error_reason: Optional[str] = None

        # 超前预测：当前实际使用的提前秒数（含自适应），UI 反馈用
        pc_cfg = config.get("predictive_control", {})
        self.current_lookahead: float = self._clamp_base_lookahead(
            pc_cfg.get("lookahead_sec", 15.0)
        )
        self._lookahead_offset: float = 0.0

    def set_broadcast_callback(self, callback):
        """注册 WebSocket 广播回调"""
        self._broadcast_callback = callback

    def _create_logged_task(self, coro: Coroutine[Any, Any, Any], context: str):
        """创建后台任务，并在任务异常结束时记录日志。"""
        task = asyncio.create_task(coro)
        task.add_done_callback(
            lambda done_task: self._log_task_exception(done_task, context)
        )
        return task

    def _log_task_exception(self, task, context: str):
        """记录后台任务异常，正常取消不视为错误。"""
        if task.cancelled():
            return
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.exception("读取后台任务异常状态失败 (%s): %s", context, e)
            return
        if exc is not None:
            logger.error("后台任务异常 (%s)", context, exc_info=exc)

    async def connect_hardware(self) -> bool:
        """连接 TC4S 硬件并启动监控轮询"""
        ok = await self.tc4s.connect()
        if ok:
            await self.tc4s.start_monitoring(
                interval=self.config.get("poll_interval", 0.5)
            )
        return ok

    async def disconnect_hardware(self):
        """断开硬件连接，取消所有后台任务"""
        await self.tc4s.stop_monitoring()
        await self.tc4s.disconnect()

    async def _on_connection_status(self, status: str, reason: str = ""):
        """硬件连接状态回调（接收两个位置参数，与 tc4s_async._notify_status 匹配）"""
        if status == "disconnected":
            await self._enter_error_state(f"硬件通信断开: {reason}")
        elif status == "error":
            # 仅记录日志，不进入 ERROR，因为可能恢复
            logger.warning("硬件通信错误: %s", reason)
        elif status == "connected":
            # 不自动从 ERROR 恢复，需用户手动 emergency_stop
            pass

    async def _enter_error_state(self, reason: str):
        """进入 ERROR 状态：强制关闭加热并广播。外部调用时使用。"""
        async with self._state_lock:
            await self._enter_error_state_locked(reason)

    async def _enter_error_state_locked(self, reason: str):
        """进入 ERROR 状态（调用方必须已持有 _state_lock）。"""
        if self.state in (RoasterState.ERROR, RoasterState.IDLE):
            return
        self.state = RoasterState.ERROR
        self.error_reason = reason
        # 强制关闭加热，失败时将失败信息附加到 error_reason
        shutdown_ok = False
        try:
            shutdown_ok = await self.tc4s.set_sv(0)
        except Exception as e:
            logger.warning("进入 ERROR 时关闭加热器异常: %s", e)
        if not shutdown_ok:
            self.error_reason = f"{reason} (加热器关闭失败)"
        self._last_broadcast = None
        await self._broadcast_state()

    async def _on_tc4s_data(self, data: dict):
        """TC4S 数据回调：每轮 polling 触发。
        所有对状态敏感的操作在 _state_lock 保护下进行，防止并发竞态。"""
        pv = data.get("pv")
        sv = data.get("sv")

        async with self._state_lock:
            self.current_pv = pv
            self.current_sv = sv

            # 过温硬限制检查
            max_temp = self.config.get("max_safe_temperature", 250.0)
            if self.current_pv is not None and self.current_pv > max_temp:
                await self._enter_error_state_locked(
                    f"过温保护触发: {self.current_pv:.1f}°C > {max_temp}°C"
                )
                return

            # 仅在烘焙活跃阶段更新 ROR、自动结束、SV 调整与数据记录，
            # 防止 IDLE 下 _temp_history 无限制增长
            if self.current_pv is not None and self.state == RoasterState.ROASTING:
                elapsed = self._get_elapsed_seconds()
                self._update_ror(elapsed)
                self._maybe_auto_end(elapsed)
                await self._maybe_adjust_sv_locked(elapsed)
                self._record_sample(elapsed)

            await self._broadcast_state()

    def _get_elapsed_seconds(self) -> float:
        """计算从入豆时刻起经过的秒数"""
        if self.roast_start_time is None:
            return 0.0
        return (datetime.now() - self.roast_start_time).total_seconds()

    def _update_ror(self, elapsed: float):
        """根据温度历史，使用滑动线性回归计算 ROR（°C/min）"""
        self._temp_history.append((elapsed, self.current_pv))
        window_sec = self.config.get("ror_window_sec", 15.0)
        # 保留比窗口略多一点的历史，防止边缘截断
        cutoff = elapsed - (window_sec + 10.0)
        self._temp_history = [(t, v) for t, v in self._temp_history if t >= cutoff]
        self.ror = self._compute_regression_ror(elapsed, window_sec)

    def _compute_regression_ror(self, elapsed: float, window_sec: float = 15.0) -> float:
        """在 [elapsed - window_sec, elapsed] 回溯窗口内对温度历史做线性回归，
        返回斜率 * 60 (°C/min)。这是 delta-span 滑动回归算法。"""
        if len(self._temp_history) < 2:
            return 0.0

        half = window_sec / 2.0
        # 收集窗口内的有效数据点（过滤 None）
        window = []
        for t, v in self._temp_history:
            if v is None:
                continue
            if abs(t - elapsed) <= half:
                window.append((t, v))

        if len(window) < 2:
            # 退化为最近两点差分
            if len(self._temp_history) >= 2:
                t0, v0 = self._temp_history[-2]
                t1, v1 = self._temp_history[-1]
                if v0 is not None and v1 is not None and t1 > t0:
                    return (v1 - v0) / (t1 - t0) * 60.0
            return 0.0

        # OLS 线性回归: T = a + b*t，使用中心化时间轴以提高数值稳定性
        sum_t = sum_v = sum_tv = sum_t2 = 0.0
        for t, v in window:
            tc = t - elapsed
            sum_t += tc
            sum_v += v
            sum_tv += tc * v
            sum_t2 += tc * tc
        n = len(window)
        denominator = n * sum_t2 - sum_t * sum_t

        if abs(denominator) < 1e-12:
            return 0.0

        slope = (n * sum_tv - sum_t * sum_v) / denominator
        return slope * 60.0

    async def _maybe_adjust_sv(self, elapsed: float):
        """根据当前状态决定是否调整设定温度 SV。外部调用时使用（自行获取锁）。"""
        async with self._state_lock:
            await self._maybe_adjust_sv_locked(elapsed)

    def _get_current_phase(self, elapsed: float) -> Optional[str]:
        """根据事件日志判断当前烘焙阶段。

        - charge 之前或没有 charge → None
        - charge 已记录、yellowing 未记录 → "drying"
        - yellowing 已记录、first_crack 未记录 → "maillard"
        - first_crack 已记录、drop 未记录 → "development"
        - drop 已记录 → None
        """
        has_charge = any(e.type == "charge" for e in self.event_log)
        if not has_charge:
            return None
        has_yellowing = any(e.type == "yellowing" for e in self.event_log)
        has_first_crack = any(e.type == "first_crack" for e in self.event_log)
        has_drop = any(e.type == "drop" for e in self.event_log)

        if has_drop:
            return None
        if has_first_crack:
            return "development"
        if has_yellowing:
            return "maillard"
        return "drying"

    async def _maybe_adjust_sv_locked(self, elapsed: float):
        """根据当前状态决定是否调整设定温度 SV（调用方必须已持有 _state_lock）。"""
        target: Optional[float] = None
        if self.state == RoasterState.ROASTING:
            # 正常烘焙：按曲线插值（含超前预测 + 自适应修正 + 偏移微调）
            if not self.profile:
                return
            pc = self.config.get("predictive_control", {})
            phase = self._get_current_phase(elapsed)
            base_la = None
            if phase is not None:
                phase_cfg = pc.get("phase_lookahead", {})
                if phase in phase_cfg:
                    base_la = self._clamp_base_lookahead(phase_cfg[phase])
            if base_la is None:
                base_la = self._clamp_base_lookahead(pc.get("lookahead_sec", 15.0))
            extra_la = 0.0
            if pc.get("adaptive_enabled", True) and self.current_pv is not None:
                nominal = self.profile.get_target_temp(elapsed)
                err = nominal - self.current_pv          # 正 = PV 落后
                thresh = float(pc.get("adaptive_error_threshold", 3.0))
                if err > thresh:
                    ratio = min(1.0, (err - thresh) / max(thresh, 1.0))
                    # ROR 越低越要前看 (factor 0.5~1.5)
                    ror_factor = max(0.5, min(1.5, 1.5 - max(self.ror, 0) / 30.0))
                    extra_la = ratio * ror_factor * float(pc.get("adaptive_max_extra_sec", 10.0))
            # current_lookahead 显示"基础+自适应"，不含实时 offset
            self.current_lookahead = base_la + extra_la
            # 实际 SV 计算叠加 offset
            target = self.profile.get_target_temp(
                elapsed + base_la + extra_la + self._lookahead_offset
            )
        else:
            # IDLE / COOLING / ERROR 不主动调整 SV
            return

        if self.current_sv is None or abs(target - self.current_sv) > 0.5:
            ok = await self.tc4s.set_sv(target)
            if ok:
                self._sv_write_failures = 0
            else:
                self._sv_write_failures += 1
                if self._sv_write_failures >= 3:
                    await self._enter_error_state_locked("TC4S 设定温度写入失败")

    def _maybe_auto_end(self, elapsed: float):
        """自动结束检测：到达曲线结束温度时自动触发 end_roast"""
        if self.state != RoasterState.ROASTING:
            return
        if not self.profile or self.profile.end_temp <= 0:
            return
        if self.current_pv is not None and self.current_pv >= self.profile.end_temp:
            self._create_logged_task(self.end_roast(), "自动结束烘焙")

    def _record_sample(self, elapsed: float):
        """记录采样数据，仅在 ROASTING 状态下写入"""
        if self.state != RoasterState.ROASTING:
            return
        pv = self.current_pv if self.current_pv is not None else 0.0
        sv = self.current_sv if self.current_sv is not None else 0.0
        self._session_data.append((elapsed, pv, sv, round(self.ror, 2)))

    async def _broadcast_state(self):
        """通过 WebSocket 广播当前状态（带节流）"""
        if not self._broadcast_callback:
            return
        now = datetime.now()
        interval = self.config.get("broadcast_interval", 0.5)
        if self._last_broadcast and (now - self._last_broadcast).total_seconds() < interval:
            return
        self._last_broadcast = now
        payload = self.get_state_payload()
        try:
            await self._broadcast_callback(payload)
        except Exception as e:
            logger.exception("广播错误: %s", e)

    def get_state_payload(self) -> dict:
        """组装当前状态为可序列化字典"""
        elapsed = self._get_elapsed_seconds()
        pc = self.config.get("predictive_control", {})
        phase_cfg = pc.get("phase_lookahead", {})
        fallback_la = self._clamp_base_lookahead(pc.get("lookahead_sec", 15.0))
        phase_lookahead_config = PhaseLookaheadConfig(
            drying=self._clamp_base_lookahead(phase_cfg.get("drying", fallback_la)),
            maillard=self._clamp_base_lookahead(phase_cfg.get("maillard", fallback_la)),
            development=self._clamp_base_lookahead(phase_cfg.get("development", fallback_la)),
        )
        return RoasterStatus(
            state=self.state.value,
            pv=self.current_pv,
            sv=self.current_sv,
            ror=round(self.ror, 2),
            elapsed=elapsed,
            profile_id=self.profile.id if self.profile else None,
            profile_name=self.profile.name if self.profile else None,
            session_id=self.session_id,
            events=list(self.event_log),
            event_stats=self._calc_event_stats(),
            connected=self.tc4s.connected,
            error_reason=self.error_reason,
            lookahead_used=getattr(self, "current_lookahead", None),
            lookahead_offset=getattr(self, "_lookahead_offset", None),
            current_phase=self._get_current_phase(elapsed),
            phase_lookahead_config=phase_lookahead_config,
        ).model_dump()

    # --- 状态机动作 ---

    def _check_error_state(self, action_name: str):
        """如果当前处于 ERROR 状态，抛出异常阻止操作"""
        if self.state == RoasterState.ERROR:
            raise RuntimeError(
                f"当前处于 ERROR 状态，无法执行 {action_name}，请先 emergency_stop"
            )

    async def start_roast(self, profile_id: Optional[str] = None):
        """开始烘焙：IDLE -> ROASTING（无中间态）。
        立即启动计时，自动追加 charge 事件，并把 SV 设到曲线起点温度。
        """
        async with self._state_lock:
            self._check_error_state("start_roast")
            if self.state != RoasterState.IDLE:
                raise RuntimeError("必须在待机状态下才能开始烘焙")
            if not self.tc4s.connected:
                raise RuntimeError("硬件未连接，无法开始烘焙")
            if profile_id:
                profile = await self.dm.load_profile(profile_id)
                if profile is None:
                    raise ValueError(f"未找到曲线: {profile_id}")
                self.profile = profile
            if not self.profile:
                raise RuntimeError("开始烘焙前必须先选择一条曲线")

            # 状态切换 + 会话初始化
            self.state = RoasterState.ROASTING
            self.session_id = self.dm.new_session_id()
            self.event_log = []
            self._temp_history = []
            self._session_data = []
            self.roast_start_time = datetime.now()

            # 自动 append 一条 charge 事件 @ 0:00（带当前温度）
            self.event_log.append(
                RoastEvent(time=0.0, type="charge", note="", temperature=self.current_pv)
            )

            # 立即设 SV 到曲线第一节点温度（拿不到则 fallback 到 config 默认 sv 或 0）
            try:
                initial_sv = self.profile.get_target_temp(0.0)
            except Exception:
                initial_sv = None
            if initial_sv is None or initial_sv <= 0:
                initial_sv = float(self.config.get("default_sv", 0))
            ok = await self.tc4s.set_sv(initial_sv)
            if not ok:
                reason = f"初始 SV 写入失败，无法开始烘焙: {initial_sv:.1f}°C"
                await self._enter_error_state_locked(reason)
                raise RuntimeError(self.error_reason or reason)

            await self._broadcast_state()

    async def log_event(self, event_type: str, note: str = ""):
        """记录烘焙事件，同时记录当前温度。
        如果是 drop 事件且当前正在烘焙，自动触发结束烘焙。
        """
        trigger_end = False
        async with self._state_lock:
            if self.state != RoasterState.ROASTING:
                return
            elapsed = self._get_elapsed_seconds()
            event = RoastEvent(
                time=elapsed,
                type=event_type,
                note=note,
                temperature=self.current_pv
            )
            self.event_log.append(event)
            await self._broadcast_state()
            # drop 兼任结束烘焙
            if event_type == "drop":
                trigger_end = True

        if trigger_end:
            # 在锁外调度，避免锁内嵌套触发 end_roast
            self._create_logged_task(self.end_roast(), "drop 结束烘焙")

    async def end_roast(self):
        """结束烘焙：关闭加热成功后 ROASTING -> COOLING；失败进入 ERROR。"""
        async with self._state_lock:
            self._check_error_state("end_roast")
            if self.state != RoasterState.ROASTING:
                return
            ok = await self.tc4s.set_sv(0)
            if not ok:
                await self._enter_error_state_locked("结束烘焙时加热器关闭失败")
                return
            self.state = RoasterState.COOLING
            await self._broadcast_state()

    async def save_and_clear(self):
        """保存当前烘焙记录并清屏回到待机：COOLING -> IDLE"""
        async with self._state_lock:
            self._check_error_state("save_and_clear")
            if self.state != RoasterState.COOLING:
                return
            await self._save_session()
            self._reset_to_idle()
            await self._broadcast_state()

    async def discard_and_clear(self):
        """丢弃当前烘焙记录并清屏回到待机：COOLING -> IDLE，不保存"""
        async with self._state_lock:
            self._check_error_state("discard_and_clear")
            if self.state != RoasterState.COOLING:
                return
            self._reset_to_idle()
            await self._broadcast_state()

    async def emergency_stop(self):
        """紧急停止：优先关闭加热；活跃状态关闭失败时进入 ERROR。"""
        async with self._state_lock:
            previous_state = self.state
            ok = await self.tc4s.set_sv(0)
            if not ok:
                reason = "紧急停止时加热器关闭失败"
                if previous_state not in (RoasterState.ERROR, RoasterState.IDLE):
                    await self._enter_error_state_locked(reason)
                    return
                logger.warning("%s；为保留复位语义，继续重置到 IDLE", reason)
            self._reset_to_idle()
            await self._broadcast_state()

    def _reset_to_idle(self):
        """重置所有运行时状态到待机"""
        self.state = RoasterState.IDLE
        self.error_reason = None
        self.profile = None
        self.session_id = None
        self.roast_start_time = None
        self.event_log = []
        self._temp_history = []
        self._session_data = []
        self.ror = 0.0
        self.current_lookahead = 0.0
        self._sv_write_failures = 0

    def _calc_event_stats(self) -> dict:
        """计算事件阶段统计：脱水期、梅纳期、发展期"""
        stats = {
            "total_time": 0.0,
            "dtr": 0.0,
            "segment_times": {},
            "segment_ratios": {},
            "segment_colors": {
                "脱水期": "#3b82f6",
                "梅纳期": "#f59e0b",
                "发展期": "#22c55e",
            },
        }
        charge = next((e for e in self.event_log if e.type == "charge"), None)
        yellowing = next((e for e in self.event_log if e.type == "yellowing"), None)
        first_crack = next((e for e in self.event_log if e.type == "first_crack"), None)
        drop = next((e for e in self.event_log if e.type == "drop"), None)

        if not charge:
            return stats

        end_time = drop.time if drop else self._get_elapsed_seconds()
        stats["total_time"] = round(end_time - charge.time, 1)

        # DTR：发展时间比率
        if first_crack and drop:
            stats["dtr"] = round((drop.time - first_crack.time) / (drop.time - charge.time) * 100, 1)
        elif first_crack:
            stats["dtr"] = round((self._get_elapsed_seconds() - first_crack.time) / (self._get_elapsed_seconds() - charge.time) * 100, 1)

        # 三段划分
        segments = []
        if yellowing:
            drying_time = yellowing.time - charge.time
            segments.append(("脱水期", drying_time))
            if first_crack:
                maillard_time = first_crack.time - yellowing.time
                segments.append(("梅纳期", maillard_time))
                dev_end = drop.time if drop else self._get_elapsed_seconds()
                dev_time = dev_end - first_crack.time
                segments.append(("发展期", dev_time))
            else:
                # 已转黄但未一爆
                remaining = end_time - yellowing.time
                segments.append(("梅纳期", remaining))
        elif first_crack:
            # 未记录转黄，直接到一爆：全部算脱水期
            drying_time = first_crack.time - charge.time
            segments.append(("脱水期", drying_time))
            dev_end = drop.time if drop else self._get_elapsed_seconds()
            dev_time = dev_end - first_crack.time
            segments.append(("发展期", dev_time))
        else:
            # 只有入豆，尚无后续事件
            segments.append(("脱水期", end_time - charge.time))

        total_seg = sum(t for _, t in segments)
        for name, t in segments:
            stats["segment_times"][name] = round(t, 1)
            if total_seg > 0:
                stats["segment_ratios"][name] = round(t / total_seg * 100, 1)

        return stats

    async def _save_session(self):
        """将当前 session 持久化到数据库"""
        if not self.session_id:
            return
        record = RoastRecord(
            session_id=self.session_id,
            started_at=self.roast_start_time,
            ended_at=datetime.now(),
            profile_id=self.profile.id if self.profile else None,
            events=list(self.event_log),
            data=list(self._session_data),
            profile_snapshot=self.profile,
        )
        await self.dm.save_record(record)

    def get_pid(self) -> PIDParams:
        """获取当前 PID 参数（启动加载用，运行时不可改）"""
        return self.pid

    def update_phase_lookahead(self, phase: str, value: float):
        """更新指定阶段的超前预测秒数（运行时生效，不持久化到文件）。"""
        if phase not in ("drying", "maillard", "development"):
            raise ValueError(f"无效阶段: {phase}")
        v = self._clamp_base_lookahead(value)
        pc = self.config.setdefault("predictive_control", {})
        phase_cfg = pc.setdefault("phase_lookahead", {})
        phase_cfg[phase] = v

    def update_lookahead_offset(self, value: float):
        """更新超前预测偏移微调（纯运行时，不持久化）。"""
        self._lookahead_offset = max(-3.0, min(3.0, float(value)))

    def update_lookahead(self, value: float):
        """向后兼容：更新所有阶段值并同步 fallback lookahead_sec。"""
        v = self._clamp_base_lookahead(value)
        pc = self.config.setdefault("predictive_control", {})
        pc["lookahead_sec"] = v
        phase_cfg = pc.setdefault("phase_lookahead", {})
        for phase in ("drying", "maillard", "development"):
            phase_cfg[phase] = v
        # 立即更新 UI 反馈值（自适应额外项下次循环再计算）
        self.current_lookahead = v
