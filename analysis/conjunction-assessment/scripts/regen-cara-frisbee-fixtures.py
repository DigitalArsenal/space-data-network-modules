#!/usr/bin/env python3
"""Regenerate small NASA CARA maximum-Pc vectors, offline with .oracle/venv.

Run from the worktree root:
  .oracle/venv/bin/python analysis/conjunction-assessment/scripts/regen-cara-frisbee-fixtures.py

Only numbers/provenance are exported. No MATLAB source, CDMs, or PDFs are
copied. Expected Frisbee values/tolerances come from CARA's unit tests;
the independent reference ports only the published math using NumPy/SciPy.
"""
import argparse
import csv
import math
import re
from pathlib import Path

import numpy as np
from scipy.integrate import quad
from scipy.optimize import minimize_scalar
from scipy.special import erf, erfc


ROOT = Path(__file__).resolve().parents[3]
MODULE = Path(__file__).resolve().parents[1]
NUM = r"[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?"


def normal_interval(low, high):
    if low > 0:
        return (erfc(low / np.sqrt(2)) - erfc(high / np.sqrt(2))) / 2
    if high < 0:
        return (erfc(-high / np.sqrt(2)) - erfc(-low / np.sqrt(2))) / 2
    return (erf(high / np.sqrt(2)) - erf(low / np.sqrt(2))) / 2


def disk_pc(miss, covariance, radius):
    """Independent normal conditioning integral, scipy adaptive QUADPACK."""
    eigenvalues, vectors = np.linalg.eigh(covariance)
    sx, sz = np.sqrt(eigenvalues)
    mx, mz = vectors.T @ miss
    lo = max((-radius - mx) / sx, -12.0)
    hi = min((radius - mx) / sx, 12.0)
    if lo >= hi:
        return 0.0

    def density(t):
        x = mx + sx * t
        half = math.sqrt(max(0, radius * radius - x * x))
        return math.exp(-t * t / 2) / math.sqrt(2 * math.pi) * normal_interval(
            (-half - mz) / sz, (half - mz) / sz)

    return quad(density, lo, hi, epsabs=1e-14, epsrel=1e-11, limit=300,
                points=[x for x in (-8, -4, 0, 4, 8) if lo < x < hi])[0]


def read_cdm(path):
    head, objects, lines = {}, [], {}
    target = head
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        if "=" not in line:
            continue
        key, value = [piece.strip() for piece in line.split("=", 1)]
        value = value.split()[0]
        if key == "OBJECT":
            target = {}
            objects.append(target)
        target[key] = value
        if key in ("X", "CN_N"):
            lines[(len(objects), key)] = line_number
    states, covariances = [], []
    for obj in objects:
        if obj["REF_FRAME"] != "EME2000":
            raise ValueError(f"Only EME2000 vectors can be regenerated: {path}")
        r = np.array([float(obj[x]) for x in ("X", "Y", "Z")])
        v = np.array([float(obj[x]) for x in ("X_DOT", "Y_DOT", "Z_DOT")])
        radial = r / np.linalg.norm(r)
        normal = np.cross(r, v)
        normal /= np.linalg.norm(normal)
        transform = np.column_stack((radial, np.cross(normal, radial), normal))
        rr, tr, tt, nr, nt, nn = [float(obj[x]) for x in
            ("CR_R", "CT_R", "CT_T", "CN_R", "CN_T", "CN_N")]
        ric = np.array([[rr, tr, nr], [tr, tt, nt], [nr, nt, nn]]) * 1e-6
        states.append((r, v))
        covariances.append(transform @ ric @ transform.T)
    r = states[0][0] - states[1][0]
    v = states[0][1] - states[1][1]
    along = v / np.linalg.norm(v)
    normal = np.cross(r, v)
    normal /= np.linalg.norm(normal)
    plane = np.array([np.cross(along, normal), normal])
    return (np.array([np.linalg.norm(r), 0]),
            [plane @ c @ plane.T for c in covariances], head["TCA"], lines)


def scalar(block, name):
    return float(re.search(rf"\b{name}\s*=\s*({NUM})", block).group(1))


def generate(cara, destination):
    test_path = Path("DistributedMatlab/Maximum2DPc/UnitTests/FrisbeeMaxPc_UnitTest.m")
    text = (cara / test_path).read_text()
    tests = list(re.finditer(r"function test(\d+)\(testCase\)", text))
    rows = []
    for index, match in enumerate(tests):
        number = int(match.group(1))
        if number < 12:
            continue
        block = text[match.end():tests[index + 1].start() if index + 1 < len(tests) else len(text)]
        file_name = re.search(r"FileName\s*=\s*'[^']*/([^/']+)'", block).group(1)
        cdm_path = Path("DataFiles/SampleCDMs") / file_name
        miss, covs, epoch, source_lines = read_cdm(cara / cdm_path)
        tolerance = scalar(block, "AbsTol" if number < 14 else "RelTol")
        expected_match = re.search(r"expSolution\s*=\s*([^;]+);", block)
        expected_text = expected_match.group(1)
        expected_line = text[:match.end() + expected_match.start()].count("\n") + 1
        expected = [float(x) for x in re.findall(NUM, expected_text)]
        cases = [(scalar(block, "HBR") / 1000, 0, expected[0])] if number < 14 else [
            (radius / 1000, 1 - column, expected[2 * row + column])
            for row, radius in enumerate((70, 20)) for column in (0, 1)]
        for radius, known, reference in cases:
            cov = covs[known]
            md2 = miss @ np.linalg.solve(cov, miss)
            combined = cov + max(0, 1 - 1 / md2) * np.outer(miss, miss)
            if number < 14:
                oracle = disk_pc(miss, combined, radius)
                populated = disk_pc(miss, covs[0] + covs[1], radius)
            else:
                eigenvalues, vectors = np.linalg.eigh(combined)
                transformed = vectors.T @ miss
                half = radius * math.sqrt(math.pi / 4)
                oracle = math.prod(normal_interval((m - half) / math.sqrt(var),
                    (m + half) / math.sqrt(var)) for m, var in zip(transformed, eigenvalues))
                populated = 0
            assert abs(oracle - reference) <= tolerance * (1 if number < 14 else reference), (
                number, known, radius, oracle, reference)
            if number < 14:
                assert abs(oracle / populated - 1) <= scalar(block, "RelTol")
            rows.append([f"Frisbee{number:02d}_known{known + 1}_R{radius * 1000:g}",
                         *miss, cov[0, 0], cov[0, 1], cov[1, 1], radius,
                         "circle" if number < 14 else "equal_area_square", reference,
                         tolerance if number < 14 else 0, 0 if number < 14 else tolerance,
                         oracle, populated, epoch,
                         f"{test_path}:{expected_line};"
                         f"{cdm_path}:{source_lines[(known + 1, 'X')]}-{source_lines[(known + 1, 'CN_N')]}"])
    destination.mkdir(parents=True, exist_ok=True)
    with (destination / "cara_frisbee.csv").open("w", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(["case", "xi_km", "zeta_km", "cxx_km2", "cxz_km2", "czz_km2",
                         "hbr_km", "region", "expected", "abs_tol", "rel_tol",
                         "python_reference", "populated_covariance_reference", "epoch_utc", "source"])
        writer.writerows(rows)
    print(f"Frisbee CARA vectors: {len(rows)}; max relative error against rounded published values: "
          f"{max(abs(row[11] / row[8] - 1) for row in rows):.9g}")

    maximum_rows = []
    for aspect in (3, 10, 100, 1000):
        for angle in (0.0, 0.731):
            c, s = math.cos(angle), math.sin(angle)
            rotation = np.array([[c, -s], [s, c]])
            covariance = rotation @ np.diag([1, 1 / aspect**2]) @ rotation.T
            miss = rotation @ np.array([1.0, 0.0])
            radius = 0.01
            objective = lambda log_scale: -disk_pc(miss, covariance * math.exp(log_scale), radius)
            result = minimize_scalar(objective, bounds=(-5, 5), method="bounded",
                                     options={"xatol": 1e-10})
            maximum_rows.append([f"aspect{aspect}_angle{angle:g}", aspect, *miss,
                covariance[0, 0], covariance[0, 1], covariance[1, 1], radius,
                -result.fun, math.exp(result.x)])
    with (destination / "pc_scaled_maximum_reference.csv").open("w", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(["case", "aspect", "xi_km", "zeta_km", "cxx_km2", "cxz_km2",
                         "czz_km2", "hbr_km", "expected", "covariance_scale"])
        writer.writerows(maximum_rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cara-root", type=Path, default=ROOT / ".oracle/CARA_Analysis_Tools")
    parser.add_argument("--output-dir", type=Path, default=MODULE / "src/cpp/tests/fixtures")
    args = parser.parse_args()
    generate(args.cara_root, args.output_dir)


if __name__ == "__main__":
    main()
