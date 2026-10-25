// The small-eccentricity rule at its boundary (modules-sgp4-str3-ecc-boundary-20261025). STR#3 computes C3 and the
// delta-M coefficient for every e; AIAA 2006-6753 drops them for set 28057 (e = 8.84e-5, "< 1.0e-4"); neither text
// says what happens at e = 1e-4, and the reference drops them there too, so the base drops them for e <= 1e-4. The
// base, built natively without -ffast-math (states.cpp, clang++), reproduces the reference's states
// (ecc-boundary-vectors.json, recorded from the reference run as a black box) for one sun-synchronous set at
// e = 0.00009, 0.0001 and 0.00011 over a day: within 1 µm and 1 µm/s at every time. Keeping the terms at e = 1e-4
// puts it 11.7 mm off.
//   node --test foundation/sgp4-str3/tests/ecc-boundary.e2e.mjs   (needs clang++)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.join(here, "ecc-boundary-vectors.json"), "utf8"));
const rad = Math.PI / 180;

test("the base drops C3 and the delta-M term at e <= 1e-4, as the reference does", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sgp4-str3-ecc-"));
  try {
    const driver = path.join(work, "states");
    execFileSync("clang++", ["-std=c++17", "-O2", `-I${path.join(here, "..", "include")}`, path.join(here, "states.cpp"), "-o", driver]);
    const v = vectors;
    const input = v.sets.map((s) => [v.epochDays1950, (v.meanMotionRevPerDay * 2 * Math.PI) / 1440, s.eccentricity, v.inclinationDeg * rad,
      v.raanDeg * rad, v.argPerigeeDeg * rad, v.meanAnomalyDeg * rad, v.bstar, v.minutes.length, ...v.minutes].map((x) => (Number.isInteger(x) ? String(x) : x.toPrecision(17))).join(" "));
    const blocks = execFileSync(driver, { input: `${input.join("\n")}\n`, encoding: "utf8" }).split("X\n").slice(0, -1);
    v.sets.forEach((s, k) => {
      const rows = blocks[k].trim().split("\n").map((l) => l.split(" ").map(Number));
      assert.equal(rows.length, s.states.length);
      let worst = 0;
      s.states.forEach((ref, j) => {
        const [t, status, ...rv] = rows[j];
        assert.equal(t, ref.minutes);
        assert.equal(status, 0, `e = ${s.eccentricity} at ${t} min`);
        const dr = Math.hypot(...[0, 1, 2].map((i) => rv[i] - ref.rKm[i])) * 1e3;
        const dv = Math.hypot(...[0, 1, 2].map((i) => rv[i + 3] - ref.vKmS[i])) * 1e3;
        assert.ok(dr <= 1e-6 && dv <= 1e-6, `e = ${s.eccentricity} at ${t} min: ${dr} m, ${dv} m/s from the reference`);
        worst = Math.max(worst, dr);
      });
      console.log(`e = ${s.eccentricity}: ${s.states.length} states, worst ${worst.toExponential(2)} m from the reference`);
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
