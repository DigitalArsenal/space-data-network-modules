"""PEP 517 backend: validate/stage the existing SDK artifacts before packaging."""
from setuptools import build_meta as _backend
from hashlib import sha256
import json
from pathlib import Path
from zipfile import ZipFile

from prepare_artifacts import PACKAGE, prepare

get_requires_for_build_wheel = _backend.get_requires_for_build_wheel
get_requires_for_build_sdist = _backend.get_requires_for_build_sdist
prepare_metadata_for_build_wheel = _backend.prepare_metadata_for_build_wheel


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    prepare()
    filename = _backend.build_wheel(wheel_directory, config_settings, metadata_directory)
    # A stale setuptools build directory must never introduce unpinned bytes.
    lock = json.loads((PACKAGE / "artifacts.lock.json").read_text())
    with ZipFile(Path(wheel_directory) / filename) as wheel:
        expected = set()
        for module in lock["modules"]:
            for record in module["files"]:
                member = "spacedatanetwork_astro/" + record["package_path"]
                expected.add(member)
                data = wheel.read(member)
                if len(data) != record["size"] or sha256(data).hexdigest() != record["sha256"]:
                    raise RuntimeError(f"Built wheel artifact mismatch: {member}")
        actual = {name for name in wheel.namelist() if name.startswith("spacedatanetwork_astro/artifacts/")}
        if actual != expected:
            raise RuntimeError(f"Built wheel artifact inventory mismatch: {sorted(actual ^ expected)}")
    return filename


def build_sdist(sdist_directory, config_settings=None):
    prepare()
    return _backend.build_sdist(sdist_directory, config_settings)
