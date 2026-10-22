"""Build a self-contained offline engine; rebuild when any source changes."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "roaster" / "src" / "workbench"
RUNTIME = ROOT / "desktop" / "runtime"
OUT = RUNTIME / "workbench"
BUILD = ROOT / "desktop" / "build" / "workbench"


def main():
    files = sorted(p for p in SOURCE.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    files.extend([Path(__file__), ROOT / "desktop/tools/workbench-worker.py"])
    digest = hashlib.sha256()
    for item in files:
        digest.update(str(item.relative_to(ROOT)).encode("utf-8"))
        digest.update(item.read_bytes())
    fingerprint = digest.hexdigest()
    stamp = OUT / "source-manifest.json"
    if stamp.exists() and (OUT / "RoasterWorkbenchEngine.exe").exists():
        previous = json.loads(stamp.read_text("utf-8"))
        if previous.get("source_sha256") == fingerprint:
            print("Offline workbench engine is current")
            return
    BUILD.mkdir(parents=True, exist_ok=True)
    if not BUILD.resolve().is_relative_to(ROOT.resolve()) or not OUT.resolve().is_relative_to(ROOT.resolve()):
        raise RuntimeError("Build/runtime directory escaped workspace")
    args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--console",
            "--name", "RoasterWorkbenchEngine", "--paths", str(ROOT / "roaster"),
            "--add-data", str(SOURCE / "native/resources") + ";src/workbench/native/resources",
            "--distpath", str(BUILD / "dist"), "--workpath", str(BUILD / "temp"), "--specpath", str(BUILD)]
    for module in ("PySide6", "PyQt6", "PyQt5", "pyqtgraph", "scipy", "matplotlib", "pytest", "serial", "fastapi", "pydantic"):
        args.extend(["--exclude-module", module])
    args.append(str(ROOT / "desktop/tools/workbench-worker.py"))
    subprocess.run(args, cwd=ROOT, check=True)
    if OUT.exists():
        if not OUT.resolve().is_relative_to(ROOT.resolve()) or OUT.resolve().name != "workbench":
            raise RuntimeError("Runtime path escaped workspace")
        shutil.rmtree(OUT)
    shutil.copytree(BUILD / "dist/RoasterWorkbenchEngine", OUT)
    shutil.copy2(SOURCE / "NOTICE.md", OUT / "NOTICE.md")
    licenses = OUT / "licenses"
    licenses.mkdir(exist_ok=True)
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if not python_license.is_file():
        raise RuntimeError("Python runtime license is missing")
    shutil.copy2(python_license, licenses / "Python-LICENSE.txt")
    metadata = importlib.metadata.distribution("pyinstaller")
    for item in metadata.files or []:
        if "licenses" in item.parts:
            source = Path(metadata.locate_file(item))
            if source.is_file():
                destination = licenses / "PyInstaller" / Path(*item.parts[item.parts.index("licenses")+1:])
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
    stamp.write_text(json.dumps({"source_sha256": fingerprint, "python": sys.version,
                                "executable_sha256": hashlib.sha256((OUT / "RoasterWorkbenchEngine.exe").read_bytes()).hexdigest()}, indent=2), "utf-8")
    print("Offline workbench engine prepared")


if __name__ == "__main__":
    main()
