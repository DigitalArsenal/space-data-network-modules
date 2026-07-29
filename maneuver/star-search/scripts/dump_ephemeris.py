#!/usr/bin/env python3
"""Dump Star encounter-grid ephemerides without changing the upstream tree.

The output is the temporary, port-local binary representation of the future
typed SDS $OEM input. It intentionally contains ephemeris only; the problem
definition remains a separate input.
"""

from __future__ import annotations

import argparse
import importlib
import os
from pathlib import Path
import struct
import sys


MAGIC = b"STAREPH\0"
VERSION = 1
SECONDS_PER_DAY = 86400.0


def _f64(value: float) -> str:
    return format(float(value), ".17g")


def _list(values: object) -> str:
    return ",".join(_f64(value) for value in values)


def _write_problem(path: Path, problem_module: object, cfg: object) -> None:
    """Write the separate, native-harness-only normalized problem fixture."""

    combo_dv_cap_km_s = (
        float("inf") if cfg.combo_dv_cap_km_s is None else cfg.combo_dv_cap_km_s
    )
    lines = [
        "STAR_PROBLEM 1",
        f"stage_count = {int(cfg.n_stages)}",
        f"leg_count = {int(cfg.n_legs)}",
        f"central_mu_km3_s2 = {_f64(cfg.flyby_cfg.central_mu_km3_s2)}",
        f"dv_total_max_km_s = {_f64(combo_dv_cap_km_s)}",
        f"tfilter_enabled = {1 if cfg.tfilter_dt_s is not None else 0}",
        f"tfilter_preemptive = {1 if cfg.dt_filter_preemptive else 0}",
        f"escape_altitude_km = {_f64(getattr(problem_module, 'escape_alt_km', 0.0))}",
        f"insertion_altitude_km = {_f64(getattr(problem_module, 'joi_alt_km', 0.0))}",
        "null_legs = " + ",".join("1" if value else "0" for value in cfg.null_flags),
        "resonant_legs = " + ",".join("1" if value else "0" for value in cfg.resonant_enabled),
        "dv_lev_max_km_s = " + _list(cfg.dvlev_max_km_s),
        "delta_dv_lev_km_s = " + _list(cfg.delta_dvlev_km_s),
        "lambert_nrev_max = " + ",".join(str(int(value)) for value in cfg.lambert_nrev),
        "lambert_hz = " + ",".join(str(int(value)) for value in cfg.lambert_hz),
        "vinf_margin_pre_filter_km_s = " + _list(cfg.vinf_margin_pre_filter_km_s),
        "row_cap = 1000000",
        "memory_cap_bytes = 1500000000",
        "work_chunk_rows = 20000",
    ]
    if cfg.tfilter_dt_s is not None:
        lines.insert(6, f"tfilter_dt_s = {_list(cfg.tfilter_dt_s)}")

    for stage in cfg.encounter_cfg.stages:
        sid = int(stage.stage_id)
        lines.extend(
            [
                f"stage.{sid}.bodies = " + ",".join(str(int(value)) for value in stage.bodies),
                f"stage.{sid}.t_min_et_s = {_f64(stage.t_min_et)}",
                f"stage.{sid}.t_max_et_s = {_f64(stage.t_max_et)}",
                f"stage.{sid}.dt_et_s = {_f64(stage.dt_et)}",
                f"stage.{sid}.altitude_km = "
                + ",".join(_f64(stage.amin_km[int(body)]) for body in stage.bodies),
                f"stage.{sid}.vinf_min_km_s = {_f64(cfg.vlim[0, sid])}",
                f"stage.{sid}.vinf_max_km_s = {_f64(cfg.vlim[1, sid])}",
            ]
        )

    for dep in range(int(cfg.n_stages)):
        for arr in range(int(cfg.n_stages)):
            lines.append(
                f"tof.{dep}.{arr}.min_s = {_f64(float(cfg.tof_min_days[dep, arr]) * SECONDS_PER_DAY)}"
            )
            lines.append(
                f"tof.{dep}.{arr}.max_s = {_f64(float(cfg.tof_max_days[dep, arr]) * SECONDS_PER_DAY)}"
            )

    for stage in range(1, int(cfg.n_stages) - 1):
        trip_bounds = cfg.flyby_cfg.trip_tof_bounds_s_by_stage.get(stage, (-float("inf"), float("inf")))
        patch_cap = cfg.flyby_cfg.dv_patch_max_km_s_by_stage.get(stage, float("inf"))
        lines.append(f"flyby.{stage}.trip_tof_min_s = {_f64(trip_bounds[0])}")
        lines.append(f"flyby.{stage}.trip_tof_max_s = {_f64(trip_bounds[1])}")
        lines.append(f"flyby.{stage}.dv_patch_max_km_s = {_f64(patch_cap)}")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-root", required=True, type=Path)
    parser.add_argument("--problem", default="test2_EMEJ")
    parser.add_argument("--metakernel", default="star/METAKERN.tm", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--problem-output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    script_path = Path(__file__).resolve()
    root = args.upstream_root.resolve()
    output_path = args.output.resolve()
    problem_output_path = (
        None if args.problem_output is None else args.problem_output.resolve()
    )
    if not (root / "star" / "pipeline.py").is_file():
        print(f"invalid upstream root: {root}", file=sys.stderr)
        return 2

    if os.environ.get("STAR_EPHEMERIS_IN_UPSTREAM_UV") != "1":
        metakernel_path = args.metakernel
        if not metakernel_path.is_absolute():
            metakernel_path = root / metakernel_path
        command = [
            "uv",
            "run",
            "python",
            str(script_path),
            "--upstream-root",
            str(root),
            "--problem",
            args.problem,
            "--metakernel",
            str(metakernel_path),
            "--output",
            str(output_path),
        ]
        if problem_output_path is not None:
            command.extend(["--problem-output", str(problem_output_path)])
        environment = os.environ.copy()
        environment["STAR_EPHEMERIS_IN_UPSTREAM_UV"] = "1"
        os.chdir(root)
        os.execvpe(command[0], command, environment)

    sys.path.insert(0, str(root))
    os.chdir(root)

    import spiceypy as spice
    from star.constants import get_gm, get_radii
    from star.encounter_database import make_time_grid
    from star.pipeline import _resolve_problem_config

    metakernel = args.metakernel
    if not metakernel.is_absolute():
        metakernel = root / metakernel
    spice.kclear()
    spice.furnsh(str(metakernel))

    problem_module = importlib.import_module(f"example.{args.problem}")
    cfg = _resolve_problem_config(problem_module)

    epochs_by_body: dict[int, set[float]] = {}
    encounter_count = 0
    for stage in cfg.encounter_cfg.stages:
        epochs = make_time_grid(stage.t_min_et, stage.t_max_et, stage.dt_et)
        for body in stage.bodies:
            body_epochs = epochs_by_body.setdefault(int(body), set())
            for epoch in epochs:
                body_epochs.add(float(epoch))
                encounter_count += 1

    tables: list[tuple[int, float, float, list[tuple[float, tuple[float, ...]]]]] = []
    for body in sorted(epochs_by_body):
        body_name = str(body)
        samples: list[tuple[float, tuple[float, ...]]] = []
        for epoch in sorted(epochs_by_body[body]):
            state6, _ = spice.spkezr(
                body_name,
                epoch,
                cfg.encounter_cfg.frame,
                "NONE",
                cfg.encounter_cfg.observer,
            )
            samples.append((epoch, tuple(float(value) for value in state6)))
        tables.append(
            (
                body,
                float(get_gm(body_name)[0]),
                float(get_radii(body_name)[0]),
                samples,
            )
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as stream:
        stream.write(MAGIC)
        stream.write(struct.pack("<IIQ", VERSION, len(tables), sum(len(row[3]) for row in tables)))
        for body, gm, radius, samples in tables:
            stream.write(struct.pack("<iIddQ", body, 0, gm, radius, len(samples)))
            for epoch, state6 in samples:
                stream.write(struct.pack("<7d", epoch, *state6))

    if problem_output_path is not None:
        _write_problem(problem_output_path, problem_module, cfg)

    print(f"problem={args.problem}")
    print(f"encounter_entries={encounter_count}")
    print(f"body_tables={len(tables)}")
    print(f"ephemeris_samples={sum(len(row[3]) for row in tables)}")
    print(f"ephemeris_output={output_path}")
    if problem_output_path is not None:
        print(f"problem_output={problem_output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
