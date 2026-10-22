"""Verify the packed engine in an isolated directory without development paths."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "desktop/runtime/workbench"
REPORT = Path(os.environ.get("WORKBENCH_PACKAGE_REPORT") or ROOT / "docs/qa/ai-workspace-v3.24/workbench-package-report.json")


def main():
    checks = []
    with tempfile.TemporaryDirectory(prefix="roaster-offline-") as temporary:
        target = Path(temporary) / "workbench"
        shutil.copytree(SOURCE, target)
        environment = {key: value for key, value in os.environ.items()
                       if key not in {"PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"}}
        windows = Path(environment.get("SystemRoot", r"C:\Windows"))
        environment["PATH"] = os.pathsep.join([str(windows / "System32"), str(windows)])
        def call(request, failure=False):
            result = subprocess.run([str(target / "RoasterWorkbenchEngine.exe")],
                                    input=(json.dumps(request)+"\n").encode(), capture_output=True,
                                    cwd=temporary, env=environment, timeout=30, check=True)
            output = json.loads(result.stdout)
            assert output["ok"] is not failure, output
            return output.get("result")
        cat = call({"action": "catalog"})
        assert len(cat["parameters"]) == 144
        checks.append("bundled catalog: 144 parameters; no source paths")
        profile = call({"action": "new"})
        assert abs(profile["fan_overlay"][0][1]-215.5) < 1e-9
        checks.append("new dual curves and original fan-overlay baseline")
        modified = call({"action": "curve", "document": profile["document"], "operation": "move", "index": 1, "x": 70, "y": 110})
        assert modified["curves"]["roast_profile"]["points"][1][1] == 110
        checks.append("native curve edit")
        modified = call({"action": "parameters", "document": modified["document"], "values": {"expect_colrchange": "160", "expect_fc": "205"}})
        assert abs(sum(p["percent"] for p in modified["phases"]["phases"].values())-100) < 1e-9
        checks.append("ABC phases")
        output = call({"action": "export", "document": modified["document"], "changed": True})
        assert output["data"] == modified["document"]["data"]
        reopened = call({"document": {**modified["document"], "data": output["data"]}})
        assert reopened["document"]["data"] == modified["document"]["data"]
        checks.append("save/reopen byte fidelity")
        analysis = call({"action": "analysis_context", "document": profile["document"]})["native"]
        assert analysis["kind"] == "profile" and analysis["can_propose"]
        points = [list(point) for point in profile["curves"]["roast_profile"]["points"]]
        for point in points:
            point[1] += 1
            for index in (2, 4):
                if point[index] or point[index+1]:
                    point[index+1] += 1
        preview = call({"action": "preview_native_proposal", "document": profile["document"],
                        "proposal": {"temperature": points, "rationale": "isolated package check"}})
        assert preview["candidate"]["document"]["data"] != profile["document"]["data"]
        assert preview["proposal"]["changes"]["temperature"]["max_sample_change"] > .99
        assert call({"document": profile["document"]})["document"]["data"] == profile["document"]["data"]
        checks.append("packaged AI analysis and non-mutating native proposal")
        app_profile = call({"action": "to_app", "document": profile["document"]})["profile"]
        assert app_profile["native_conversion"]["max_sample_error_c"] <= .25
        assert app_profile["end_temp"] == 218
        checks.append("controller conversion bounds and recommended end temperature")
        log = call({"action": "from_record", "record": {"data": [[0,20,21,1],[1,30,31,2],[2,40,41,3]], "events": [{"type":"drop","time":2}]}})
        assert log["sample_count"] == 3 and not log["curves"]
        checks.append("console record bridge without fabricated targets")
        output = call({"action": "export", "format": "csv", "document": log["document"]})
        assert base64.b64decode(output["data"]).startswith(b"\xef\xbb\xbftime,temp,profile,actual_ROR")
        checks.append("UTF-8 BOM raw CSV")
        call({"action": "time", "value": "nan"}, failure=True)
        call({"action": "parameters", "document": profile["document"], "values": {"native_schema_version": "1.9"}}, failure=True)
        checks.append("invalid requests return structured errors")
        assert not list(target.rglob("*Qt*"))
        checks.append("no Qt runtime or physical-device modules")
    report = {"checks": checks, "passed": len(checks), "isolated": True,
              "executable_sha256": hashlib.sha256((SOURCE/"RoasterWorkbenchEngine.exe").read_bytes()).hexdigest(),
              "manifest": json.loads((SOURCE/"source-manifest.json").read_text("utf-8"))}
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"passed": len(checks), "isolated": True}))


if __name__ == "__main__":
    main()
