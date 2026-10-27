"""Package the real controller with Python and its dependencies for desktop delivery."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "desktop/build/device"
OUT = ROOT / "desktop/runtime/device"


def main():
    sources = [p for directory in (ROOT/"roaster/src",ROOT/"roaster/static",ROOT/"roaster/data/profiles")
               for p in directory.rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"]
    sources += [ROOT/"roaster/device_main.py",ROOT/"roaster/config.yaml",Path(__file__)]
    digest = hashlib.sha256()
    for source in sorted(sources):
        digest.update(str(source.relative_to(ROOT)).encode());digest.update(source.read_bytes())
    fingerprint = digest.hexdigest()
    name = "RoasterDevice.exe" if sys.platform == "win32" else "RoasterDevice"
    stamp = OUT / "source-manifest.json"
    if stamp.exists() and (OUT/name).exists() and json.loads(stamp.read_text("utf-8")).get("source_sha256") == fingerprint:
        print("Device service is current");return
    BUILD.mkdir(parents=True,exist_ok=True)
    args = [sys.executable,"-m","PyInstaller","--noconfirm","--clean","--onedir","--console","--name","RoasterDevice",
            "--paths",str(ROOT/"roaster"),"--distpath",str(BUILD/"dist"),"--workpath",str(BUILD/"temp"),"--specpath",str(BUILD),
            "--add-data",str(ROOT/"roaster/static")+":static","--add-data",str(ROOT/"roaster/config.yaml")+":.",
            "--add-data",str(ROOT/"roaster/data/profiles")+":presets",
            "--add-data",str(ROOT/"roaster/src/workbench/native/resources")+":src/workbench/native/resources",
            "--hidden-import","serial.tools.list_ports","--hidden-import","uvicorn.logging","--hidden-import","uvicorn.loops.auto",
            "--hidden-import","uvicorn.protocols.http.auto","--hidden-import","uvicorn.protocols.websockets.auto","--hidden-import","uvicorn.lifespan.on"]
    for module in ("PySide6","PyQt6","PyQt5","pyqtgraph","scipy","matplotlib","pytest","IPython"):
        args.extend(["--exclude-module",module])
    args.append(str(ROOT/"roaster/device_main.py"))
    subprocess.run(args,cwd=ROOT,check=True)
    if OUT.exists():
        if not OUT.resolve().is_relative_to((ROOT/"desktop/runtime").resolve()):
            raise RuntimeError("Device runtime path escaped workspace")
        shutil.rmtree(OUT)
    shutil.copytree(BUILD/"dist/RoasterDevice",OUT)
    licenses = OUT/"licenses";licenses.mkdir()
    python_license=Path(sys.base_prefix)/"LICENSE.txt"
    if python_license.exists():shutil.copy2(python_license,licenses/"Python-LICENSE.txt")
    for distribution in importlib.metadata.distributions():
        for item in distribution.files or []:
            if any(part.lower() in ("licenses","license","license.txt","license.md","copying") for part in item.parts):
                source=Path(distribution.locate_file(item))
                if source.is_file():
                    target=licenses/distribution.metadata["Name"]/Path(*item.parts)
                    target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
    stamp.write_text(json.dumps({"source_sha256":fingerprint,"python":sys.version,"executable_sha256":hashlib.sha256((OUT/name).read_bytes()).hexdigest()},indent=2),"utf-8")
    print("Packaged device service prepared")


if __name__ == "__main__":
    main()
