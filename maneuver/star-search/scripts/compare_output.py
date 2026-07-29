#!/usr/bin/env python3
"""Compare native STAR JSONL output with the Python reference oracle."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable


EXACT_FIELDS = ("traj_id", "body_ids", "t_et_s", "leg_ils", "flyby_ifs")
FLOAT_FIELDS = (
    "t_et_s",
    "vinfD_km_s",
    "vinfA_km_s",
    "dv_lev_km_s",
    "eta_lev",
    "dv_patch_km_s",
    "dv_total_km_s",
    "tof_total_days",
    "dv_escape_km_s",
    "dv_insertion_km_s",
)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: expected a JSON object")
            rows.append(value)
    return rows


def flatten(value: Any, path: str = "") -> Iterable[tuple[str, float]]:
    if isinstance(value, list):
        for index, child in enumerate(value):
            yield from flatten(child, f"{path}[{index}]")
        return
    yield path, float(value)


def compare(
    reference: list[dict[str, Any]],
    candidate: list[dict[str, Any]],
    *,
    relative_tolerance: float,
    absolute_tolerance: float,
) -> tuple[str, bool]:
    lines = [
        f"reference_rows={len(reference)}",
        f"candidate_rows={len(candidate)}",
    ]
    passed = len(reference) == len(candidate)
    row_count = min(len(reference), len(candidate))

    for field in EXACT_FIELDS:
        mismatches = sum(
            1
            for row in range(row_count)
            if reference[row].get(field) != candidate[row].get(field)
        )
        mismatches += abs(len(reference) - len(candidate))
        lines.append(f"{field}: exact_mismatches={mismatches}")
        passed = passed and mismatches == 0

    for field in FLOAT_FIELDS:
        max_absolute = 0.0
        max_relative = 0.0
        worst_absolute = "none"
        worst_relative = "none"
        shape_mismatches = 0
        tolerance_failures = 0
        for row in range(row_count):
            reference_values = list(flatten(reference[row].get(field), field))
            candidate_values = list(flatten(candidate[row].get(field), field))
            if [item[0] for item in reference_values] != [item[0] for item in candidate_values]:
                shape_mismatches += 1
                continue
            for (path, expected), (_, observed) in zip(reference_values, candidate_values):
                absolute = abs(observed - expected)
                relative = absolute / abs(expected) if expected != 0.0 else absolute
                if absolute > max_absolute:
                    max_absolute = absolute
                    worst_absolute = f"row={row} {path}"
                if relative > max_relative:
                    max_relative = relative
                    worst_relative = f"row={row} {path}"
                if (
                    not math.isfinite(observed)
                    or absolute > absolute_tolerance + relative_tolerance * abs(expected)
                ):
                    tolerance_failures += 1
        lines.append(
            f"{field}: max_abs={max_absolute:.17g} ({worst_absolute}), "
            f"max_rel={max_relative:.17g} ({worst_relative}), "
            f"shape_mismatches={shape_mismatches}, tolerance_failures={tolerance_failures}"
        )
        passed = passed and shape_mismatches == 0 and tolerance_failures == 0

    lines.append(f"result={'PASS' if passed else 'FAIL'}")
    return "\n".join(lines) + "\n", passed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--relative-tolerance", type=float, default=1e-9)
    parser.add_argument("--absolute-tolerance", type=float, default=1e-12)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    report, passed = compare(
        load_jsonl(args.reference),
        load_jsonl(args.candidate),
        relative_tolerance=args.relative_tolerance,
        absolute_tolerance=args.absolute_tolerance,
    )
    print(report, end="")
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report, encoding="utf-8")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
