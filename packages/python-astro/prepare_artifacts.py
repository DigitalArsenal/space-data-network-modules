"""Copy hash-pinned SDK outputs, preserving every byte (including REC trailers).

No compiler, schema generator, network download, or physics runs at wheel build.
The resulting sdist carries the same assets and builds outside a git checkout.
"""
import hashlib
import json
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PACKAGE = ROOT / "src" / "spacedatanetwork_astro"


def prepare():
    lock = json.loads((PACKAGE / "artifacts.lock.json").read_text())
    digest = hashlib.sha256(json.dumps(lock["modules"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    expected_version = f"0.1.0.dev0+modules.{lock['source_revision'][:12]}.a{digest[:12]}"
    version_tree = ast.parse((PACKAGE / "_version.py").read_text())
    actual_version = next(ast.literal_eval(statement.value) for statement in version_tree.body
                          if isinstance(statement, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == "__version__"
                                  for target in statement.targets))
    if digest != lock["artifact_set_sha256"] or lock["version"] != expected_version or actual_version != expected_version:
        raise RuntimeError("Artifact set digest/version mismatch; review lock and _version.py together")
    allowed = {file["package_path"] for module in lock["modules"] for file in module["files"]}
    unexpected = {path.relative_to(PACKAGE).as_posix() for path in (PACKAGE / "artifacts").rglob("*")
                  if path.is_file()} - allowed
    if unexpected:
        raise RuntimeError(f"Unpinned staged artifact files: {sorted(unexpected)}")
    for module in lock["modules"]:
        for file in module["files"]:
            target = PACKAGE / file["package_path"]
            source = ROOT.parents[1] / file["source_path"]
            # In a modules checkout, a changed source must fail even if the
            # previous build left a valid staging copy. In an sdist use assets.
            candidate = source if (ROOT.parents[1] / "AGENTS.md").is_file() else target
            if not candidate.is_file():
                raise RuntimeError(f"Missing pinned SDK artifact: {candidate}")
            data = candidate.read_bytes()
            if len(data) != file["size"] or hashlib.sha256(data).hexdigest() != file["sha256"]:
                raise RuntimeError(f"Artifact lock mismatch: {candidate}; review the artifact update before repinning")
            target.parent.mkdir(parents=True, exist_ok=True)
            if candidate != target:
                target.write_bytes(data)
    print(f"PASS: staged {len(lock['modules'])} hash-pinned SDK module artifacts")


if __name__ == "__main__":
    prepare()
