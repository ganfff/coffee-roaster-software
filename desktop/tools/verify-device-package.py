"""Check delivery digests, runtime parity, ARM64 binary identity and safe archive paths."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import posixpath
import tarfile

ROOT=Path(__file__).resolve().parents[2]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def main():
    version=json.loads((ROOT/"desktop/package.json").read_text("utf-8"))["version"]
    dist=ROOT/"dist"
    installer=dist/f"RoasterDesktop_{version}_x64-setup.exe"
    built=ROOT/f"desktop/src-tauri/target/release/bundle/nsis/{installer.name}"
    assert installer.read_bytes()[:2]==b"MZ"
    assert digest(installer)==digest(built),"Installer delivery does not match completed NSIS output"
    runtime=ROOT/"desktop/runtime/device"
    manifest=json.loads((runtime/"source-manifest.json").read_text("utf-8"))
    executable=runtime/"RoasterDevice.exe"
    assert digest(executable)==manifest["executable_sha256"]
    assert digest(executable)==digest(ROOT/"desktop/src-tauri/target/release/device/RoasterDevice.exe")
    archive=dist/f"RoasterDevice_{version}_linux_arm64.tar.gz"
    expected=(archive.with_name(archive.name+".sha256")).read_text("utf-8").split()[0]
    assert digest(archive)==expected
    with tarfile.open(archive,"r:gz") as bundle:
        members={item.name.removeprefix("./"):item for item in bundle.getmembers()}
        required=["main.py","device_main.py","config.example.yaml","README.md","DEVICE-SETUP.md",
                  "install-roaster.sh","start-roaster.sh","open-roaster.sh","data/profiles/default-light-roast.json",
                  "src/hardware/tc4s_async.py","src/services/device_runtime.py","src/web/device_origin.py",
                  "static/js/device-connection.js","runtime/node/bin/node","runtime/ai/service.mjs"]
        assert all(name in members for name in required),"Device package is incomplete"
        for name,item in members.items():
            assert not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts
            assert not any(part in (".git",".venv","__pycache__") for part in PurePosixPath(name).parts)
            assert not name.startswith(("data/records/","data/ai/")),"Private runtime data included"
            if item.issym() or item.islnk():
                target=posixpath.normpath(posixpath.join(posixpath.dirname(name),item.linkname))
                assert not target.startswith(("../","/")),"Archive link leaves bundle"
        for name in ("install-roaster.sh","start-roaster.sh","open-roaster.sh","runtime/node/bin/node"):
            assert members[name].mode & 0o111,"Linux executable bit missing"
        start=bundle.extractfile(members["start-roaster.sh"]).read()
        assert b"--host 127.0.0.1" in start and b"0.0.0.0" not in start
        assert b"\r\n" not in start,"POSIX launcher has Windows line endings"
        node=bundle.extractfile(members["runtime/node/bin/node"]).read(20)
        assert node[:4]==b"\x7fELF" and node[4]==2 and int.from_bytes(node[18:20],"little")==183,"Node is not Linux ARM64"
        assert bundle.extractfile(members["README.md"]).read()==(ROOT/"docs/guides/real-device-setup.md").read_bytes()
    artifacts=[{"name":path.name,"bytes":path.stat().st_size,"sha256":digest(path)} for path in (installer,archive)]
    for artifact in artifacts:
        (dist/(artifact["name"]+".sha256")).write_text(artifact["sha256"]+"  "+artifact["name"]+"\n","utf-8")
    report={"version":version,"artifacts":artifacts,"device_runtime_source_sha256":manifest["source_sha256"],
            "scope":"NSIS output parity and bundle integrity; Windows runtime checked separately; target Pi and physical TC4S not validated"}
    (dist/"device-delivery.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),"utf-8")
    print(json.dumps(report,ensure_ascii=False))


if __name__=="__main__":
    main()
