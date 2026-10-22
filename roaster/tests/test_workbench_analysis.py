"""Native AI snapshots/proposals stay bounded, lossless, and hardware-free."""
import base64
from copy import deepcopy
import json
import unittest

from src.workbench.engine import dispatch, decode, encode
from src.workbench.analysis import curve_extrema, validate_native_curve
from src.workbench.native import core


def payload(raw, kind="log"):
    return {"kind": kind, "name": "source.klog" if kind == "log" else "source.kpro",
            "data": base64.b64encode(raw).decode("ascii")}


LOG = (b"profile_schema_version:1.8\r\nnative_schema_version:1.8\r\nunknown_secret:never-send\r\n"
       b"calibration_data:machine-identity\r\nprofile_file_name:C:\\private\\source.kpro\r\n"
       b"tasting_notes:sweet\r\noffsets\t2\t0\t-0.5\r\n"
       b"time\t#=mean_temp\t=profile\t=actual_ROR\r\n"
       b"0\t20\t21\t1.25\t\r\n1\t22\t23\t2.5\t\r\n!first_crack:1\r\n"
       b"2\t24\t25\t3.75\t\r\n!roast_end:2\r\n")


class NativeAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.view = dispatch({"action": "new"})
        self.document = self.view["document"]
        self.identity = {"document_session_id": "unit-test", "generation": 1, "revision": 2,
                         "sha256": self.document["sha256"]}

    def propose(self, value, document=None, identity=None):
        return dispatch({"action": "preview_native_proposal", "document": document or self.document,
                         "identity": identity or self.identity, "proposal": value})

    def test_analysis_whitelist_offsets_and_recorded_vs_derived(self):
        source = payload(LOG)
        native = dispatch({"action": "analysis_context", "document": source})["native"]
        encoded = json.dumps(native)
        for forbidden in ("never-send", "machine-identity", "private", "native_document", "data\":"):
            self.assertNotIn(forbidden, encoded)
        self.assertEqual(native["parameters"]["tasting_notes"]["value"], "sweet")
        recorded = next(c for c in native["channels"] if c["id"] == "=actual_ROR")
        derived = next(c for c in native["channels"] if c["id"] == "recomputed_ror")
        self.assertEqual((recorded["from"], recorded["source"]), (-.5, "recorded"))
        self.assertEqual((derived["from"], derived["source"]), (2, "derived"))
        values = dispatch({"action": "analysis_samples", "document": source,
                           "channel": "#=mean_temp", "from": 2, "to": 3})
        self.assertEqual(values["samples"], [[2, 20], [3, 22]])
        self.assertEqual(decode(source).to_bytes(), LOG)

    def test_analysis_window_is_bounded_and_preserves_anomalous_order(self):
        raw = LOG.replace(b"1\t22", b"0\t22")
        source = payload(raw)
        native = dispatch({"action": "analysis_context", "document": source})["native"]
        self.assertTrue(native["readonly"])
        self.assertFalse(native["time_order_valid"])
        self.assertFalse(any(c["id"] == "recomputed_ror" for c in native["channels"]))
        samples = dispatch({"action": "analysis_samples", "document": source,
                            "channel": "#=mean_temp", "from": 0, "to": 10, "limit": 1})
        self.assertEqual(samples["matching_count"], 3)
        self.assertTrue(samples["truncated"])
        self.assertEqual(samples["samples"], [[2, 20]])
        for args in ({"channel": "missing"}, {"channel": "recomputed_ror"},
                     {"channel": "#=mean_temp", "from": 2, "to": 1},
                     {"channel": "#=mean_temp", "limit": 601}):
            with self.assertRaises(ValueError):
                dispatch({"action": "analysis_samples", "document": source, **args})

    def test_identity_is_bound_to_actual_bytes(self):
        native = dispatch({"action": "analysis_context", "document": self.document,
                           "identity": self.identity})["native"]
        self.assertEqual(native["identity"], self.identity)
        for changed in ({"sha256": "wrong"}, {"revision": -1}, {"generation": True}, {"document_session_id": ""}):
            with self.assertRaises(ValueError):
                dispatch({"action": "analysis_context", "document": self.document,
                          "identity": {**self.identity, **changed}})

    def test_readonly_profile_is_analysis_only_and_sampling_is_bounded(self):
        raw = base64.b64decode(self.document["data"]).replace(b"profile_schema_version:1.8", b"profile_schema_version:1.5")
        source = dispatch({"document": payload(raw, "profile")})["document"]
        context = dispatch({"action": "analysis_context", "document": source})["native"]
        self.assertTrue(context["readonly"])
        self.assertFalse(context["can_propose"])
        with self.assertRaises(ValueError):
            self.propose({"temperature": self.view["curves"]["roast_profile"]["points"]}, source,
                         {**self.identity, "sha256": source["sha256"]})
        rows = "".join(f"{i}\t{i/10}\t\n" for i in range(2000))
        source = payload(("profile_schema_version:1.8\nnative_schema_version:1.8\ntime\t#=mean_temp\n"+rows).encode())
        context = dispatch({"action": "analysis_context", "document": source})["native"]
        self.assertEqual(len(context["channels"][0]["buckets"]), 48)
        self.assertEqual(context["channels"][0]["count"], 2000)
        samples = dispatch({"action": "analysis_samples", "document": source, "channel": "#=mean_temp"})
        self.assertEqual(len(samples["samples"]), 600)
        self.assertTrue(samples["truncated"])

    def test_temperature_candidate_preserves_unselected_fields_and_source(self):
        raw = base64.b64decode(self.document["data"])
        raw = b"\xef\xbb\xbfunknown:keep:colons\r\n" + raw
        source = payload(raw, "profile")
        source = dispatch({"document": source})["document"]
        identity = {**self.identity, "sha256": source["sha256"]}
        points = deepcopy(self.view["curves"]["roast_profile"]["points"])
        for point in points:
            point[1] += 1
            for offset in (2, 4):
                if point[offset:offset+2] != [0, 0]:
                    point[offset+1] += 1
        result = self.propose({"temperature": points, "rationale": "test"}, source, identity)
        candidate = decode(result["candidate"]["document"])
        original = decode(source)
        self.assertEqual(candidate.get("fan_profile"), original.get("fan_profile"))
        self.assertEqual(candidate.get("unknown"), "keep:colons")
        self.assertTrue(candidate.to_bytes().startswith(b"\xef\xbb\xbfunknown:keep:colons\r\n"))
        self.assertEqual(original.to_bytes(), raw)
        self.assertAlmostEqual(result["proposal"]["changes"]["temperature"]["max_sample_change"], 1, places=5)
        self.assertFalse(result["proposal"]["separate_document"])

    def test_log_candidate_is_separate_supported_profile_without_telemetry(self):
        for raw in (LOG, LOG.replace(b"native_schema_version:1.8", b"native_schema_version:1.9")):
            source = dispatch({"document": payload(raw)})["document"]
            result = self.propose({"temperature": self.view["curves"]["roast_profile"]["points"]},
                                  source, {**self.identity, "sha256": source["sha256"]})
            candidate = decode(result["candidate"]["document"])
            self.assertEqual(candidate.kind, "profile")
            self.assertEqual(candidate.get("profile_schema_version"), "1.8")
            for field in ("native_schema_version", "calibration_data", "unknown_secret"):
                self.assertEqual(candidate.get(field), "")
            self.assertNotIn(b"time\t", candidate.to_bytes())
            self.assertTrue(result["proposal"]["separate_document"])
            self.assertTrue(result["proposal"]["warnings"])
            self.assertEqual(decode(source).to_bytes(), raw)

    def test_atomic_two_curve_failure_cannot_change_source(self):
        before = deepcopy(self.document)
        bad_fan = deepcopy(self.view["curves"]["fan_profile"]["points"])
        bad_fan[1][1] = 19000
        with self.assertRaises(ValueError):
            self.propose({"temperature": self.view["curves"]["roast_profile"]["points"], "fan": bad_fan})
        self.assertEqual(self.document, before)

    def test_full_bezier_extrema_detect_hidden_fan_overshoot(self):
        # Anchors are legal. Interior controls create a narrow cubic overshoot.
        points = [[0, 17000, 0, 0, 1, 22000],
                  [20, 17000, 19, 22000, 25, 17000],
                  [40, 17000, 35, 17000, 0, 0]]
        curve = core.Curve(core.CurvePoint(*p) for p in points)
        self.assertGreater(curve_extrema(curve)["max"], 18000)
        with self.assertRaises(ValueError):
            validate_native_curve(points, "fan")

    def test_bad_time_geometry_nonfinite_and_arbitrary_fields_rejected(self):
        original = self.view["curves"]["roast_profile"]["points"]
        bad = []
        points = deepcopy(original); points[0][0] = 1; bad.append(points)
        points = deepcopy(original); points[1][1] = float("nan"); bad.append(points)
        points = deepcopy(original); points[0][2] = 1; bad.append(points)
        points = deepcopy(original); points[0][4] = 4000; points[1][2] = -4000; bad.append(points)
        points = deepcopy(original); points[-1][0] = 7201; bad.append(points)
        for points in bad:
            with self.assertRaises(ValueError):
                self.propose({"temperature": points})
        for proposal in ({}, {"temperature": original, "profile_schema_version": "1.9"},
                         {"temperature": original, "rationale": "x"*4001}):
            with self.assertRaises(ValueError):
                self.propose(proposal)


if __name__ == "__main__":
    unittest.main()
