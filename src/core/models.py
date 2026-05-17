from pydantic import BaseModel, Field, ConfigDict
from datetime import datetime
from typing import List, Optional
from uuid import uuid4


class ProfileNode(BaseModel):
    """温度曲线节点：时间点与目标温度"""

    time: float = Field(..., ge=0, description="距离起点的秒数")
    temperature: float = Field(..., ge=0, le=300, description="目标温度 °C")


class RoastProfile(BaseModel):
    """烘焙曲线：一组节点定义的温度-时间目标"""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    description: str = ""
    nodes: List[ProfileNode] = []              # 温度曲线（向后兼容字段名）
    end_temp: float = Field(0, ge=0, le=300, description="结束温度 °C，到达后自动结束烘焙")
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)

    @staticmethod
    def _catmull_rom_spline(p0: float, p1: float, p2: float, p3: float, t: float) -> float:
        """Catmull-Rom样条插值，t∈[0,1]。
        曲线通过所有控制点，一阶导数连续，ROR自然平滑。
        """
        return 0.5 * (
            (2 * p1) +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * (t ** 2) +
            (-p0 + 3 * p1 - 3 * p2 + p3) * (t ** 3)
        )

    def get_target_temp(self, elapsed_sec: float) -> float:
        """根据已过时间，Catmull-Rom样条插值计算目标温度。
        控制点不足4个或位于边界段时退化为线性插值。
        """
        if not self.nodes:
            return 0.0

        # 第一段之前
        if elapsed_sec <= self.nodes[0].time:
            return self.nodes[0].temperature

        n = len(self.nodes)
        # 节点之间插值
        for i in range(1, n):
            prev, curr = self.nodes[i - 1], self.nodes[i]
            if prev.time <= elapsed_sec <= curr.time:
                # 控制点不足4个或边界段：退化为线性插值
                if n < 4 or i == 1 or i == n - 1:
                    ratio = (elapsed_sec - prev.time) / (curr.time - prev.time)
                    return prev.temperature + ratio * (curr.temperature - prev.temperature)

                # Catmull-Rom 样条插值
                p0 = self.nodes[i - 2].temperature
                p1 = prev.temperature
                p2 = curr.temperature
                p3 = self.nodes[i + 1].temperature
                t = (elapsed_sec - prev.time) / (curr.time - prev.time)
                return self._catmull_rom_spline(p0, p1, p2, p3, t)

        # 最后一段之后
        return self.nodes[-1].temperature


class ProfileSummary(BaseModel):
    """曲线列表摘要"""

    id: str
    name: str
    node_count: int


class RoastEvent(BaseModel):
    """烘焙事件：入豆、转黄、一爆等关键节点"""

    time: float
    type: str
    note: str = ""
    temperature: Optional[float] = None


class PIDParams(BaseModel):
    """PID 控制参数"""

    kp: float = 60.0
    ki: float = 0.01
    kd: float = 20.0


class RoastRecord(BaseModel):
    """单次烘焙完整记录"""

    session_id: str
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    profile_id: Optional[str]
    events: List[RoastEvent]
    # (elapsed_sec, pv, sv, ror)
    data: List[tuple[float, float, float, float]]
    seq_no: Optional[int] = None
    display_name: Optional[str] = None
    profile_snapshot: Optional[RoastProfile] = None


class RecordSummary(BaseModel):
    """烘焙记录列表摘要"""

    session_id: str
    started_at: Optional[datetime]
    profile_name: Optional[str]
    duration_sec: float
    seq_no: Optional[int] = None
    display_name: Optional[str] = None


class PhaseLookaheadConfig(BaseModel):
    """分阶段超前预测配置"""

    drying: float = Field(1.0, ge=0.0, le=30.0, description="脱水期超前预测秒数")
    maillard: float = Field(0.5, ge=0.0, le=30.0, description="梅纳期超前预测秒数")
    development: float = Field(1.0, ge=0.0, le=30.0, description="发展期超前预测秒数")


class RoasterStatus(BaseModel):
    """向外广播的实时状态快照"""

    state: str
    pv: Optional[float]
    sv: Optional[float]
    ror: float
    elapsed: float
    profile_id: Optional[str]
    profile_name: Optional[str]
    session_id: Optional[str] = None
    events: List[RoastEvent]
    event_stats: dict
    connected: bool
    error_reason: Optional[str] = None  # ERROR 状态时的错误原因描述
    lookahead_used: Optional[float] = None  # 实际使用的超前预测秒数（含自适应）
    lookahead_offset: Optional[float] = None  # 当前实际超前偏移秒数
    current_phase: Optional[str] = None  # 当前阶段: drying/maillard/development
    phase_lookahead_config: Optional[PhaseLookaheadConfig] = None
