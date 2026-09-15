"""A wheel build must reject accidental version drift and leftover artifacts."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare_artifacts


class BuildGateTests(unittest.TestCase):
    def test_changed_lock_digest_cannot_build(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            lock = json.loads((prepare_artifacts.PACKAGE / "artifacts.lock.json").read_text())
            lock["artifact_set_sha256"] = "0" * 64
            (package / "artifacts.lock.json").write_text(json.dumps(lock))
            (package / "_version.py").write_text((prepare_artifacts.PACKAGE / "_version.py").read_text())
            with patch.object(prepare_artifacts, "PACKAGE", package):
                with self.assertRaisesRegex(RuntimeError, "digest/version mismatch"):
                    prepare_artifacts.prepare()

    def test_unpinned_staging_files_cannot_build(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            for name in ("artifacts.lock.json", "_version.py"):
                (package / name).write_bytes((prepare_artifacts.PACKAGE / name).read_bytes())
            extra = package / "artifacts/stale-module/module.wasm"
            extra.parent.mkdir(parents=True)
            extra.write_bytes(b"unreviewed")
            with patch.object(prepare_artifacts, "PACKAGE", package):
                with self.assertRaisesRegex(RuntimeError, "Unpinned staged artifact"):
                    prepare_artifacts.prepare()


if __name__ == "__main__":
    unittest.main()
