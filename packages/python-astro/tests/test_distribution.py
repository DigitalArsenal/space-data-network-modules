"""Packaging/integrity tests only; these are not numerical conformance tests."""
import hashlib
from importlib.resources import files
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import spacedatanetwork_astro as astro
import spacedatanetwork_astro.artifacts as artifacts


class DistributionTests(unittest.TestCase):
    def test_nine_pinned_modules(self):
        expected = {"propagator/sgp4", "propagator/hpop", "analysis/estimation",
                    "analysis/conjunction-assessment", "analysis/access", "propagator/events",
                    "analysis/lambert-izzo", "foundation/time", "foundation/frames"}
        self.assertEqual(set(astro.list_artifacts()), expected)
        for name in expected:
            with self.subTest(module=name):
                artifact = astro.get_artifact(name)
                artifact.verify()
                self.assertEqual(artifact.read_bytes()[:8], b"\0asm\x01\0\0\0")
                self.assertTrue(artifact.manifest["methods"])

    def test_version_pins_complete_artifact_set(self):
        lock = artifacts._lock()
        digest = hashlib.sha256(json.dumps(lock["modules"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(lock["artifact_set_sha256"], digest)
        self.assertEqual(astro.__version__, f"0.1.0.dev0+modules.{lock['source_revision'][:12]}.a{digest[:12]}")
        self.assertEqual(astro.__version__, lock["version"])

    def test_unknown_and_traversal_ids_rejected(self):
        for identifier in ("../module.wasm", "sgp4", "foundation/time/../frames"):
            with self.assertRaises(KeyError):
                astro.get_artifact(identifier)

    def test_tampered_artifact_rejected(self):
        lock = artifacts._lock()
        entry = next(m for m in lock["modules"] if m["id"] == "propagator/sgp4")
        record = next(f for f in entry["files"] if f["name"] == "module.wasm")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "artifacts.lock.json").write_text(json.dumps(lock))
            wasm = root / record["package_path"]
            wasm.parent.mkdir(parents=True)
            # Keep the same length: the checksum must detect this corruption.
            original = astro.get_artifact(entry["id"]).read_bytes()
            wasm.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
            with patch.object(artifacts, "files", return_value=root):
                with self.assertRaises(astro.ArtifactIntegrityError):
                    astro.get_artifact(entry["id"]).read_bytes()


if __name__ == "__main__":
    unittest.main()
