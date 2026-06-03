import logging

import yaml
import uvicorn

from src.web.web_api import app
from src.core.roaster_controller import RoasterController
from src.services.data_manager import DataManager


def load_config(path: str = "config.yaml") -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


config = load_config()
if "preheat" in config:
    logging.warning(
        "config.yaml 中的 'preheat' 节已废弃 (v3.11 起不再使用)，将被忽略。"
        "可手动从配置文件中删除该节。"
    )
dm = DataManager(config)
controller = RoasterController(config, dm)

app.state.config = config
app.state.dm = dm
app.state.controller = controller

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=config.get("host", "0.0.0.0"),
        port=config.get("port", 8000),
        reload=False,
    )
