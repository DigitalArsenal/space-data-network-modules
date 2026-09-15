"""PEP 517 backend: validate/stage the existing SDK artifacts before packaging."""
from setuptools import build_meta as _backend
from hashlib import sha256
import json
from pathlib import Path
from zipfile import ZipFile

from prepare_artifacts import PACKAGE, prepare


def verify_bindings():
    """Build only the reviewed generated code, including from an unpacked sdist."""
    lock = json.loads((PACKAGE / "bindings.lock.json").read_text())
    for name, expected in lock["generated_sha256"].items():
        if sha256((PACKAGE / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"Generated binding differs from lock: {name}")
    artifact_lock = json.loads((PACKAGE / "artifacts.lock.json").read_text())
    for stamp in lock["artifacts"]:
        module = next(m for m in artifact_lock["modules"] if m["id"] == stamp["id"])
        wasm = next(f for f in module["files"] if f["name"] == "module.wasm")
        if wasm["sha256"] != stamp["wasm_sha256"]:
            raise RuntimeError(f"Binding artifact stamp is stale: {stamp['id']}")

get_requires_for_build_wheel = _backend.get_requires_for_build_wheel
get_requires_for_build_sdist = _backend.get_requires_for_build_sdist
prepare_metadata_for_build_wheel = _backend.prepare_metadata_for_build_wheel


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    prepare()
    verify_bindings()
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
        binding_lock = json.loads((PACKAGE / "bindings.lock.json").read_text())
        for name, digest in binding_lock["generated_sha256"].items():
            if sha256(wheel.read("spacedatanetwork_astro/" + name)).hexdigest() != digest:
                raise RuntimeError(f"Built wheel binding mismatch: {name}")
    return filename


def build_sdist(sdist_directory, config_settings=None):
    prepare()
    verify_bindings()
    return _backend.build_sdist(sdist_directory, config_settings)
