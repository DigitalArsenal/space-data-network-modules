"""Inspect the artifact distribution without claiming runtime availability."""
import argparse
import json

from . import __version__, get_artifact, list_artifacts


def main():
    parser = argparse.ArgumentParser(description="Pinned SDN WASM artifact distribution (execution blocked)")
    parser.add_argument("command", choices=("list", "verify", "doctor"))
    args = parser.parse_args()
    if args.command == "doctor":
        print("BLOCKED: this prerelease provides artifact access only.")
        print("PyPI wasmedge==0.0.1 is an empty package, not a Python SDK.")
        print("Published SDS Python bindings lack required schemas and legacy OrbPro types.")
        print("See README.md and docs/dependencies.md. No Python physics or runtime fallback is provided.")
        return 2
    if args.command == "list":
        print(json.dumps({"version": __version__, "modules": [
            {"id": identifier, "sha256": get_artifact(identifier).sha256}
            for identifier in list_artifacts()
        ]}, indent=2))
    else:
        for identifier in list_artifacts():
            get_artifact(identifier).verify()
        print(f"PASS: {len(list_artifacts())} module artifacts match the lock ({__version__})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
