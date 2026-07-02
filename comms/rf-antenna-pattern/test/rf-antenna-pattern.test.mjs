// rf-antenna-pattern Node native-test-runner harness.
//
// Parity fixtures in ./fixtures.json were generated FROM the JS
// evaluator (packages/engine/Source/Scene/AntennaPattern.js) — the JS
// is the semantic spec. Every analytic family × parameter variant ×
// angle case, the sampled-grid cases (wrap + clamp), and the geometry
// cases (including the degenerate up-parallel-boresight fallback) are
// asserted at 1e-12 relative against the WASM kernel.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createRfAntennaPatternPlugin,
  AntennaPatternType,
} from "../index.js";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"),
);

const D2R = Math.PI / 180.0;
const RELATIVE_TOLERANCE = 1.0e-12;

function assertClose(actual, expected, label) {
  assert.ok(Number.isFinite(actual), `${label}: not finite (${actual})`);
  if (expected === 0) {
    assert.equal(actual, 0, `${label}: expected exactly 0, got ${actual}`);
    return;
  }
  const relativeError = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(
    relativeError <= RELATIVE_TOLERANCE,
    `${label}: expected ${expected}, got ${actual} (relative error ${relativeError})`,
  );
}

let plugin;

test.before(async () => {
  plugin = await createRfAntennaPatternPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-antenna-pattern");
});

test("analytic families match the JS evaluator at 1e-12 relative", () => {
  for (const family of fixtures.analytic) {
    const pattern = { patternType: family.patternType, ...family.params };
    const patternWithRef = { ...pattern, referenceGainDb: 12.0 };
    for (const c of family.cases) {
      const cone = c.coneDeg * D2R;
      const clock = c.clockDeg * D2R;
      const label = `${family.patternType}/${family.variant} cone=${c.coneDeg} clock=${c.clockDeg}`;
      assertClose(plugin.gain(pattern, cone, clock), c.gain, `${label} gain`);
      assertClose(
        plugin.gainDb(patternWithRef, cone, clock),
        c.gainDb_ref12,
        `${label} gainDb(ref=12)`,
      );
    }
  }
});

test("string and numeric pattern types agree; unknown falls back to RINGED", () => {
  const cone = 33 * D2R;
  const clock = 70 * D2R;
  const byString = plugin.gain({ patternType: "dish" }, cone, clock);
  const byEnum = plugin.gain(
    { patternType: AntennaPatternType.DISH },
    cone,
    clock,
  );
  assert.equal(byString, byEnum);

  const unknown = plugin.gain({ patternType: "mystery-horn" }, cone, clock);
  const ringed = plugin.gain(
    { patternType: AntennaPatternType.RINGED },
    cone,
    clock,
  );
  assert.equal(unknown, ringed);

  // PARABOLIC and DISH share the same formula in the JS spec.
  const parabolic = plugin.gain({ patternType: "parabolic" }, cone, clock);
  assert.equal(parabolic, byString);
});

test("analytic gainDb floors at referenceGainDb - 120 (EPSILON12 clamp)", () => {
  // pencil @ 90° cone evaluates to exactly 0 → floor applies.
  const db = plugin.gainDb(
    { patternType: "pencil", referenceGainDb: 12.0 },
    90 * D2R,
    0,
  );
  assertClose(db, -108, "pencil 90° floor");
});

test("sampled grid matches the JS evaluator (wrap + clamp cases)", () => {
  const handle = plugin.loadSampledPattern(fixtures.sampled.pattern);
  assert.ok(handle >= 1);
  try {
    for (const c of fixtures.sampled.cases) {
      const cone = c.coneDeg * D2R;
      const clock = c.clockDeg * D2R;
      const label = `sampled cone=${c.coneDeg} clock=${c.clockDeg}`;
      assertClose(
        plugin.evaluateSampledGainDb(handle, cone, clock),
        c.gainDb,
        `${label} gainDb`,
      );
      assertClose(
        plugin.evaluateSampledGain(handle, cone, clock),
        c.gain,
        `${label} unit gain`,
      );
    }
  } finally {
    plugin.freePattern(handle);
  }
});

test("sampled pattern accepts alias keys (thetaAnglesDegrees/phiAnglesDegrees/gainsDb)", () => {
  const p = fixtures.sampled.pattern;
  const aliasHandle = plugin.loadSampledPattern({
    thetaAnglesDegrees: p.coneAnglesDegrees,
    phiAnglesDegrees: p.clockAnglesDegrees,
    gainsDb: p.gainDbValues,
    clockWrap: p.clockWrap,
  });
  try {
    const c = fixtures.sampled.cases[1];
    assertClose(
      plugin.evaluateSampledGainDb(aliasHandle, c.coneDeg * D2R, c.clockDeg * D2R),
      c.gainDb,
      "alias-loaded sampled gainDb",
    );
  } finally {
    plugin.freePattern(aliasHandle);
  }
});

test("sampled handle lifecycle: free invalidates, slots are reused", () => {
  const p = fixtures.sampled.pattern;
  const first = plugin.loadSampledPattern(p);
  plugin.freePattern(first);
  assert.ok(Number.isNaN(plugin.evaluateSampledGainDb(first, 0.1, 0.1)));
  assert.throws(() => plugin.freePattern(first));

  const second = plugin.loadSampledPattern(p);
  assert.equal(second, first, "freed slot should be reused");
  plugin.freePattern(second);
});

test("sampled pattern validation mirrors normalizeSampledPattern", () => {
  assert.throws(() =>
    plugin.loadSampledPattern({
      coneAnglesDegrees: [0],
      clockAnglesDegrees: [0, 90],
      gainDbValues: [1, 2],
    }),
  );
  assert.throws(() =>
    plugin.loadSampledPattern({
      coneAnglesDegrees: [0, 90],
      clockAnglesDegrees: [0, 90],
      gainDbValues: [1, 2, 3],
    }),
  );
  assert.throws(() =>
    plugin.loadSampledPattern({
      coneAnglesDegrees: [0, 90],
      clockAnglesDegrees: [0, 90],
      gainDbValues: [1, 2, 3, Number.NaN],
    }),
  );
});

test("geometry bridge matches the fixture rule (incl. degenerate up ∥ boresight)", () => {
  for (const c of fixtures.geometry.cases) {
    const { cone, clock } = plugin.computeConeClock(
      c.antPos,
      c.boresight,
      c.up,
      c.target,
    );
    assertClose(cone, c.expected.cone, `${c.name} cone`);
    assertClose(clock, c.expected.clock, `${c.name} clock`);
  }
});

test("geometry bridge accepts {x, y, z} vector objects", () => {
  const c = fixtures.geometry.cases[0];
  const toObj = (v) => ({ x: v[0], y: v[1], z: v[2] });
  const { cone, clock } = plugin.computeConeClock(
    toObj(c.antPos),
    toObj(c.boresight),
    toObj(c.up),
    toObj(c.target),
  );
  assertClose(cone, c.expected.cone, "object-vector cone");
  assertClose(clock, c.expected.clock, "object-vector clock");
});
