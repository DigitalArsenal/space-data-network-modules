import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

test("native estimation conformance", () => {
  const compiler = process.env.CXX || "c++";
  const binary = path.join(os.tmpdir(), `estimation-conformance-${process.pid}`);
  execFileSync(compiler, [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I",
    path.join(root, "src"),
    path.join(root, "src", "estimation.cpp"),
    path.join(root, "tests", "native_conformance.cpp"),
    "-o",
    binary,
  ], { stdio: "inherit" });
  try {
    const report = JSON.parse(execFileSync(binary, { encoding: "utf8" }));
    assert.ok(report.batch_position_error_m < 1, JSON.stringify(report));
    assert.ok(report.residual_orthogonality < 1e-6, JSON.stringify(report));
    assert.equal(report.edited_count, 1, JSON.stringify(report));
    assert.ok(report.filter_position_error_m < 1, JSON.stringify(report));
    assert.ok(report.smoother_position_error_m < 0.5, JSON.stringify(report));
    assert.ok(report.ukf_covariance_difference > 0, JSON.stringify(report));
    assert.ok(report.snc_growth_ratio > 1, JSON.stringify(report));
    assert.ok(report.dmc_growth_ratio > 1, JSON.stringify(report));
    assert.ok(report.average_nees >= 5.3402 && report.average_nees <= 6.6977,
      JSON.stringify(report));
    assert.ok(report.simulator_coverage >= 0.95, JSON.stringify(report));
    assert.ok(Math.abs(report.recovered_noise_sigma - 2.0) / 2.0 <= 0.05,
      JSON.stringify(report));
    assert.ok(report.orekit_measurement_max_relative <= 1e-6, JSON.stringify(report));
    assert.ok(report.orekit_angle_max_rad <= 1e-6, JSON.stringify(report));
    assert.ok(report.orekit_saastamoinen_relative <= 1e-4, JSON.stringify(report));
    assert.ok(report.orekit_marini_relative <= 1e-4, JSON.stringify(report));
    assert.equal(Number(report.p531_table3_range_m.toFixed(4)), 40.3221,
      JSON.stringify(report));
    assert.ok(report.vallado_gauss_max_error_si < 1e-6, JSON.stringify(report));
    assert.ok(report.vallado_laplace_max_error_si < 1e-6, JSON.stringify(report));
    assert.ok(report.vallado_gibbs_max_error_mps < 1e-9, JSON.stringify(report));
    assert.ok(report.vallado_herrick_max_error_mps < 1e-9, JSON.stringify(report));
  } finally {
    fs.rmSync(binary, { force: true });
  }
});
