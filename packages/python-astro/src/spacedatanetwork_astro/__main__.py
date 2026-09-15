"""Inspect the pinned artifact set and native runtime."""
import argparse
import json

from . import __version__, get_artifact, list_artifacts


def main():
    parser = argparse.ArgumentParser(description="SDN astrodynamics through WasmEdge")
    parser.add_argument("command", choices=("list", "verify", "doctor"))
    args = parser.parse_args()
    if args.command == "doctor":
        from .runtime import Module
        try:
            with Module("foundation/time"):
                pass
        except RuntimeError as error:
            print(f"FAIL: {error}")
            return 2
        print("PASS: WasmEdge 0.16.4 C API loaded the pinned foundation/time artifact")
        return 0
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
