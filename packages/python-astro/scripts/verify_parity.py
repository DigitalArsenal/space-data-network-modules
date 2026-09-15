"""Run the SDK's three-runtime error-path fixture on the packaged WASM bytes.

This checks command-surface parity only, NOT authoritative numerical results.
The SDK owns the fixture, runtime pins, browser launch and comparisons.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--wasmedge-binary", required=True)
    args = parser.parse_args()
    package = Path(__file__).resolve().parents[1]
    sdk = package.parents[1] / "node_modules/space-data-module-sdk"
    data = package / "src/spacedatanetwork_astro"
    lock = json.loads((data / "artifacts.lock.json").read_text())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    reports = []
    for module in lock["modules"]:
        file = next(file for file in module["files"] if file["name"] == "module.wasm")
        wasm = data / file["package_path"]
        if hashlib.sha256(wasm.read_bytes()).hexdigest() != file["sha256"]:
            raise RuntimeError(f"Packaged artifact lock mismatch: {wasm}")
        command = ["node", str(sdk / "bin/space-data-module.js"), "parity",
                   "--wasm", str(wasm), "--fixture", str(sdk / "parity/sdk-command.json"),
                   "--wasmedge-binary", args.wasmedge_binary,
                   "--lanes", "browser,wasmedge,docker-wasmedge", "--json", "--timeout-sec", "15"]
        try:
            run = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, timeout=180)
            code, output = run.returncode, run.stdout
        except subprocess.TimeoutExpired as error:
            code, output = 124, error.stdout or b""
            if isinstance(output, bytes):
                output = output.decode(errors="replace")
            output += "\nTIMEOUT: 180 seconds\n"
        logfile = module["id"].replace("/", "-") + ".log"
        (args.output_dir / logfile).write_text(output)
        reports.append({"module": module["id"], "command": command, "exit_code": code,
                        "artifact_sha256": file["sha256"], "log": logfile})
        print(f"{module['id']} [SDK three-runtime error paths]: exit {code}", flush=True)
    (args.output_dir / "parity-checks.json").write_text(json.dumps({
        "scope": "SDK error-path command fixture only; no numerical/Python parity claim",
        "checks": reports}, indent=2) + "\n")
    return int(any(report["exit_code"] != 0 for report in reports))


if __name__ == "__main__":
    raise SystemExit(main())
