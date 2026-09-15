"""Run existing module checks without altering tests, expected values or WASM.

These are baseline module checks, not Python integration tests. Missing
compatibility suites are recorded as unavailable, never counted as passes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

CHECKS = [
    ("sdk", "propagator/sgp4", "tests/sdk_compat.test.mjs", None),
    ("sdk", "propagator/hpop", "tests/sdk_compat.test.mjs", None),
    ("sdk", "analysis/conjunction-assessment", "tests/sdk_compat.test.mjs", None),
    ("sdk", "foundation/time", "tests/sdk_compat.test.mjs", None),
    ("sdk", "foundation/frames", "tests/sdk_compat.test.mjs", None),
    ("sdk", "analysis/lambert-izzo", "tests/sdk-compat.test.mjs", None),
    ("sdk", "analysis/access", "test/manifestContract.test.mjs", None),
    ("evidence", "analysis/estimation", "tests/conformance.test.mjs", None),
    ("numerical", "propagator/sgp4", "tests/tudat_wasm_derived.test.mjs", "tudat vallado sgp4 benchmark"),
    ("numerical", "propagator/hpop", "tests/tudat_wasm_derived.test.mjs", "tudat two-body samples"),
    ("numerical-native", "analysis/estimation", "tests/native.test.mjs", None),
    ("numerical", "analysis/conjunction-assessment", "tests/socratesScreenCatalogParity.test.mjs", None),
    ("numerical", "analysis/access", "test/accessAnalyzer.test.mjs", "inverse azimuth/elevation/range"),
    ("numerical", "propagator/events", "tests/events.test.mjs", "node crossings land"),
    ("numerical", "analysis/lambert-izzo", "tests/sdk-compat.test.mjs", "closed-form circular quarter-orbit"),
    ("numerical", "foundation/time", "tests/time_conversion.test.mjs", "converts Orekit TAIScaleTest.testAAS06134"),
    ("numerical", "foundation/frames", "tests/frame_transform.test.mjs", "matches Basilisk GeodeticConversion.testPCI2PCPF"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--modules-root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--runtime-bin", type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    if args.runtime_bin:
        env["PATH"] = str(args.runtime_bin) + os.pathsep + env.get("PATH", "")
    reports = []
    for phase, module, test, pattern in CHECKS:
        command = ["node", "--test", "--test-reporter=tap"]
        if pattern:
            command += ["--test-name-pattern", pattern]
        command.append(test)
        artifact = args.modules_root / module / "dist/isomorphic/module.wasm"
        before = hashlib.sha256(artifact.read_bytes()).hexdigest()
        try:
            run = subprocess.run(command, cwd=args.modules_root / module, env=env,
                                 text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
            code, output = run.returncode, run.stdout
        except subprocess.TimeoutExpired as error:
            code, output = 124, error.stdout or b""
            if isinstance(output, bytes):
                output = output.decode(errors="replace")
            output += "\nTIMEOUT: 180 seconds\n"
        after = hashlib.sha256(artifact.read_bytes()).hexdigest()
        log_name = f"{phase}-{module.replace('/', '-')}.log"
        (args.output_dir / log_name).write_text(output)
        summary = re.findall(r"^# (?:tests|pass|fail|skipped|cancelled) .*$", output, re.M)
        counts = {key: int(value) for key, value in re.findall(r"^# (tests|pass|fail|skipped|cancelled) (\d+)$", output, re.M)}
        report = {"phase": phase, "module": module, "cwd": module, "command": command,
                  "exit_code": code, "summary": summary, "log": log_name,
                  "coverage_complete": counts.get("pass", 0) > 0 and counts.get("skipped", 0) == 0,
                  "artifact_sha256": before, "artifact_unchanged": before == after}
        reports.append(report)
        print(f"{module} [{phase}]: exit {code}; {'; '.join(summary)}", flush=True)
    result = {"purpose": "Existing module baseline; not Python wrapper validation",
              "runtime_bin": str(args.runtime_bin) if args.runtime_bin else None,
              "missing_sdk_compat_suites": ["analysis/estimation", "propagator/events"],
              "checks": reports}
    (args.output_dir / "existing-module-checks.json").write_text(json.dumps(result, indent=2) + "\n")
    return int(any(r["exit_code"] != 0 or not r["artifact_unchanged"] or not r["coverage_complete"] for r in reports))


if __name__ == "__main__":
    raise SystemExit(main())
