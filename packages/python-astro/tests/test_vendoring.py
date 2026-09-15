"""Generated-binding provenance and marshalling tests, without physics claims."""
import hashlib
import importlib
from importlib.resources import files
import json
import sys
import unittest

import flatbuffers
import numpy as np


class VendoringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = files("spacedatanetwork_astro")
        cls.lock = json.loads(cls.root.joinpath("bindings.lock.json").read_text())

    def test_immutable_sds_source_and_compiler_are_pinned(self):
        self.assertEqual(self.lock["sds"]["revision"], "b76da41467e260c83b3432ba7f34a1eb05cc7ac7")
        self.assertEqual(self.lock["sds"]["version"].split("+")[0], "1.217.0")
        self.assertEqual(self.lock["invoke"]["flatc_wasm_version"], "26.1.32")
        source_manifest = (json.dumps(self.lock["sds"]["lib_py_sha256"], sort_keys=True, indent=2) + "\n").encode()
        self.assertEqual(hashlib.sha256(source_manifest).hexdigest(), self.lock["sds"]["lib_py_manifest_sha256"])
        self.assertGreaterEqual(len(self.lock["sds"]["lib_py_sha256"]), 4505)
        self.assertEqual(self.lock["unresolved_imports"], [])
        self.assertIn("Apache License", self.root.joinpath("sds/LICENSE.txt").read_text())
        self.assertIn("Copyright 2024 Digital Arsenal, Inc.", self.root.joinpath("invoke/SDK-LICENSE.txt").read_text())
        self.assertIn("Imports have been rewritten", self.root.joinpath("sds/NOTICE.txt").read_text())

    def test_every_generated_file_matches_manifest_and_imports(self):
        for name, digest in self.lock["generated_sha256"].items():
            with self.subTest(file=name):
                self.assertEqual(hashlib.sha256(self.root.joinpath(name).read_bytes()).hexdigest(), digest)
                if name.endswith(".py"):
                    importlib.import_module("spacedatanetwork_astro." + name[:-3].replace("/", "."))
        for forbidden in ("orbpro", "RFM", "CelestialFrameWrapper", "PIVRequest"):
            self.assertNotIn(forbidden, sys.modules, "vendoring must not mutate the global import namespace")

    def test_rfm_cross_module_union_object_roundtrip(self):
        from spacedatanetwork_astro.sds.RFM.RFM import RFMT
        from spacedatanetwork_astro.sds.RFM.RFMUnion import RFMUnion
        from spacedatanetwork_astro.sds.RFM.CelestialFrameWrapper import CelestialFrameWrapperT
        value = RFMT(REFERENCE_FRAME_type=RFMUnion.CelestialFrameWrapper,
                     REFERENCE_FRAME=CelestialFrameWrapperT(frame=1), NAME="roundtrip")
        builder = flatbuffers.Builder(128)
        builder.Finish(value.Pack(builder), file_identifier=b"$RFM")
        decoded = RFMT.InitFromPackedBuf(builder.Output())
        self.assertEqual(decoded.REFERENCE_FRAME.frame, 1)
        self.assertEqual(decoded.NAME, b"roundtrip")

    def test_sgp4_batch_numpy_roundtrip_is_separate_from_sdk_state_abi(self):
        from spacedatanetwork_astro.invoke.legacy.orbpro.propagator.PropagatorBatchRequest import PropagatorBatchRequestT
        from spacedatanetwork_astro.invoke.orbpro.propagator.StateVector import StateVector as CurrentState
        from spacedatanetwork_astro.invoke.legacy.orbpro.propagator.StateVector import StateVector as LegacyState
        value = PropagatorBatchRequestT()
        value.epoch = 2451545.0
        value.entityHandles = np.asarray([0, 1, 17], dtype=np.uint32)
        value.maxCount = 3
        builder = flatbuffers.Builder(128)
        builder.Finish(value.Pack(builder), file_identifier=b"PROP")
        decoded = PropagatorBatchRequestT.InitFromPackedBuf(builder.Output())
        np.testing.assert_array_equal(decoded.entityHandles, value.entityHandles)
        self.assertEqual(decoded.epoch, value.epoch)
        self.assertEqual(decoded.maxCount, 3)
        self.assertIsNot(CurrentState, LegacyState)

    def test_artifact_provenance_matches_distribution(self):
        artifact_lock = json.loads(self.root.joinpath("artifacts.lock.json").read_text())
        expected = {module["id"]: next(file["sha256"] for file in module["files"] if file["name"] == "module.wasm")
                    for module in artifact_lock["modules"]}
        self.assertEqual({module["id"]: module["wasm_sha256"] for module in self.lock["artifacts"]}, expected)


if __name__ == "__main__":
    unittest.main()
