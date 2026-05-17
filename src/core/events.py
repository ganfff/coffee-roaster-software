from enum import Enum


class RoasterState(Enum):
    """烘焙机运行状态枚举"""

    IDLE = "IDLE"              # 待机：未开始任何操作
    ROASTING = "ROASTING"      # 烘焙中：按曲线正常跟随
    COOLING = "COOLING"        # 冷却/保存：加热停止，等待用户保存记录
    ERROR = "ERROR"            # 错误状态
