"""Packaged/source entry point. Startup connects for telemetry and never starts a roast."""
import argparse
import logging
import os
from pathlib import Path
import sys

import uvicorn
import yaml


def resource_root():
    return Path(getattr(sys,"_MEIPASS",Path(__file__).resolve().parent))


def create_app(config_path=None, data_dir=None, shutdown_token=""):
    from src.web.web_api import app
    from src.services.device_runtime import DeviceRuntime
    source = Path(config_path) if config_path else resource_root() / "config.yaml"
    config = yaml.safe_load(source.read_text("utf-8"))
    directory = Path(data_dir) if data_dir else source.parent / "data"
    runtime = DeviceRuntime(app, config, directory, resource_root() / "presets" if getattr(sys,"frozen",False) else resource_root() / "data/profiles")
    app.state.runtime = runtime
    app.state.shutdown_token = shutdown_token
    return app


def run():
    parser = argparse.ArgumentParser(description="Ganf's 咖啡烘焙机控制服务")
    parser.add_argument("--host",default="127.0.0.1")
    parser.add_argument("--port",type=int,default=8000)
    parser.add_argument("--config")
    parser.add_argument("--data-dir")
    parser.add_argument("--shutdown-token",default="")
    parser.add_argument("--no-auto-connect",action="store_true")
    args = parser.parse_args()
    if args.no_auto_connect:
        os.environ["ROASTER_DISABLE_AUTO_CONNECT"] = "1"
    logging.basicConfig(level=logging.INFO)
    app = create_app(args.config,args.data_dir,args.shutdown_token)
    server = uvicorn.Server(uvicorn.Config(app,host=args.host,port=args.port,log_level="info"))
    app.state.server = server
    server.run()


if __name__ == "__main__":
    run()
