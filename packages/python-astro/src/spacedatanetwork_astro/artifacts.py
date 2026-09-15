"""Access the byte-identical module artifacts and their provenance."""
from dataclasses import dataclass
from hashlib import sha256
from importlib.resources import files
import json


class ArtifactIntegrityError(ValueError):
    """An installed artifact differs from the reviewed artifact lock."""


def _lock():
    return json.loads(files("spacedatanetwork_astro").joinpath("artifacts.lock.json").read_text())


@dataclass(frozen=True)
class Artifact:
    """A selected SDK artifact. Identifiers use e.g. ``propagator/sgp4``."""

    identifier: str

    def __post_init__(self):
        self._entry()

    def _entry(self):
        for entry in _lock()["modules"]:
            if entry["id"] == self.identifier:
                return entry
        raise KeyError(f"Unknown module {self.identifier!r}; choose from {list_artifacts()}")

    def _read(self, name):
        entry = self._entry()
        record = next(record for record in entry["files"] if record["name"] == name)
        payload = files("spacedatanetwork_astro").joinpath(record["package_path"]).read_bytes()
        if len(payload) != record["size"] or sha256(payload).hexdigest() != record["sha256"]:
            raise ArtifactIntegrityError(f"{self.identifier}/{name} does not match artifacts.lock.json")
        return payload

    @property
    def sha256(self) -> str:
        return next(record["sha256"] for record in self._entry()["files"] if record["name"] == "module.wasm")

    @property
    def source_revision(self) -> str:
        return _lock()["source_revision"]

    @property
    def manifest(self) -> dict:
        """Authoring manifest metadata; the embedded PLG remains authoritative."""
        return json.loads(self._read("plugin-manifest.json"))

    def read_bytes(self) -> bytes:
        """Read and verify the original SDK ``dist/isomorphic/module.wasm``."""
        return self._read("module.wasm")

    def verify(self) -> None:
        """Verify all files, including any upstream build-provenance record."""
        for record in self._entry()["files"]:
            self._read(record["name"])


def list_artifacts() -> tuple[str, ...]:
    return tuple(entry["id"] for entry in _lock()["modules"])


def get_artifact(identifier: str) -> Artifact:
    return Artifact(identifier)
