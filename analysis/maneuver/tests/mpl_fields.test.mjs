/**
 * The amended $MPL fields, end to end through the built module:
 * co-orbital tolerance with its basis, HAS_MAX_DELTA_V, STM_DYNAMICS beside
 * DYNAMICS, DA_DOT_PER_S and the drag columns' unit, and the HAS_* flags
 * that let a real zero be requested.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createStandaloneHarnessOrSkip } from "space-data-module-sdk/testing/isomorphic";
import { M, encodeRequest, probePlan } from "./mpl_client.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const A = 6778137;
const CHIEF = { semiMajorAxis: A, eccentricity: 0.001, inclination: 0.9, raan: 0.2, argumentOfPerigee: 0.3, meanAnomaly: 0.4 };

function typed(operation, params, edit = () => {}) {
  const { plan } = encodeRequest(operation, params);
  edit(plan);
  return plan;
}

async function solved(harness, plan) {
  const out = await probePlan(harness, plan);
  assert.equal(out.trapped, false, out.error);
  assert.equal(out.statusCode, 0, `${out.errorCode} ${out.plan?.ERROR_MESSAGE}`);
  return out.plan;
}

test("amended $MPL fields reach the planner with their stated meaning", async (t) => {
  const harness = await createStandaloneHarnessOrSkip("browser", WASM_PATH, t, { enableThreads: true });
  if (!harness) return;

  const pair = { chaser: { ...CHIEF }, target: { ...CHIEF, semiMajorAxis: A + 3000, meanAnomaly: 0.5 } };

  await t.test("co-orbital tolerance: AbsoluteKm is converted with the chaser's semi-major axis", async () => {
    const abs = await solved(harness, typed("phasingFromTargetState", structuredClone(pair), (p) => {
      Object.assign(p.REQUEST.PHASING, { HAS_CO_ORBITAL_TOLERANCE: true, CO_ORBITAL_TOLERANCE: 5,
        CO_ORBITAL_TOLERANCE_BASIS: M.mplToleranceBasis.AbsoluteKm });
    }));
    const g = abs.PHASING;
    assert.equal(g.CO_ORBITAL_TOLERANCE_KM, 5);
    assert.equal(g.CO_ORBITAL_TOLERANCE_FRACTION, 5000 / A);
    assert.equal(g.CO_ORBITAL, true); // 3 km apart, within 5 km
    const rel = await solved(harness, typed("phasingFromTargetState", structuredClone(pair), (p) => {
      Object.assign(p.REQUEST.PHASING, { HAS_CO_ORBITAL_TOLERANCE: true, CO_ORBITAL_TOLERANCE: 1e-4,
        CO_ORBITAL_TOLERANCE_BASIS: M.mplToleranceBasis.RelativeToChaserSemiMajorAxis });
    }));
    assert.equal(rel.PHASING.CO_ORBITAL_TOLERANCE_FRACTION, 1e-4);
    assert.equal(rel.PHASING.CO_ORBITAL, false); // 0.68 km threshold, 3 km apart
    const dflt = await solved(harness, typed("phasingFromTargetState", structuredClone(pair)));
    assert.equal(dflt.PHASING.CO_ORBITAL_TOLERANCE_FRACTION, 1e-3);
  });

  await t.test("HAS_MAX_DELTA_V: unstated = 10 m/s default, stated 0 = unlimited", async () => {
    const cam = { chief: { ...CHIEF }, initialState: { position: [10, 50, 5], velocity: [0, 0, 0] },
      config: { minMissDistance: 50000, timeToTCA: 600 } };
    const dflt = await solved(harness, typed("computeCAM", structuredClone(cam)));
    assert.ok(dflt.TOTAL_DELTA_V_KM_S > 0.01, `the probe needs a burn above 10 m/s (got ${dflt.TOTAL_DELTA_V_KM_S} km/s)`);
    assert.equal(dflt.RELATIVE.FEASIBLE, false);
    const unlimited = await solved(harness, typed("computeCAM", structuredClone(cam), (p) => {
      p.REQUEST.RELATIVE.HAS_MAX_DELTA_V = true;
      p.REQUEST.RELATIVE.MAX_DELTA_V_KM_S = 0;
    }));
    assert.equal(unlimited.RELATIVE.FEASIBLE, true);
    assert.equal(unlimited.TOTAL_DELTA_V_KM_S, dflt.TOTAL_DELTA_V_KM_S);
    const tight = await solved(harness, typed("computeCAM", structuredClone(cam), (p) => {
      p.REQUEST.RELATIVE.HAS_MAX_DELTA_V = true;
      p.REQUEST.RELATIVE.MAX_DELTA_V_KM_S = dflt.TOTAL_DELTA_V_KM_S * 2;
    }));
    assert.equal(tight.RELATIVE.FEASIBLE, true);
  });

  await t.test("STM_DYNAMICS picks the matrix, DYNAMICS the propagation, DA_DOT_PER_S passes as 1/s", async () => {
    const roe = [1e-5, 2e-5, 1e-5, -1e-5, 2e-5, 0];
    const plan = await solved(harness, typed("computeRoeStateTransition",
      { chief: { ...CHIEF, eccentricity: 0.06 }, deltaTime: 3000, model: "keplerian", initialRoe: roe, includeJ2: true,
        includeDrag: true, dragConfig: { type: "eccentric", daDotDrag: 1e-9 } }, (p) => {
        p.REQUEST.RELATIVE.STM_DYNAMICS = M.mplRelativeDynamics.Keplerian;
      }));
    const r = plan.RELATIVE;
    assert.equal(r.STM_DYNAMICS, M.mplRelativeDynamics.Keplerian);
    assert.equal(r.DYNAMICS, M.mplRelativeDynamics.J2DragEccentric);
    // Drag on da: da(t) = da0 + daDot * t under the eccentric model's da row.
    assert.ok(Math.abs(r.PROPAGATED_ROE[0] - (roe[0] + 1e-9 * 3000)) < 1e-12, `da ${r.PROPAGATED_ROE[0]}`);
    const cols = await solved(harness, typed("computeRoeStateTransition",
      { chief: { ...CHIEF, eccentricity: 0.06 }, deltaTime: 3000, model: "j2-drag-eccentric" }));
    assert.equal(cols.RELATIVE.DRAG_COLUMN_COUNT, 1);
    assert.equal(cols.RELATIVE.DRAG_COLUMNS[0], 3000); // seconds: entry (0,0) = DURATION_S
  });

  await t.test("HAS_* flags: a stated zero is a real zero", async () => {
    const orbit = { elements: { semiMajorAxis: A, eccentricity: 0.01, inclination: 0.5, raan: 0, argumentOfPeriapsis: 0, trueAnomaly: 0.3 } };
    const coast = await solved(harness, typed("evaluateOrbitGeometry", structuredClone(orbit), (p) => {
      p.REQUEST.GEOMETRY.HAS_ELAPSED = true;
      p.REQUEST.GEOMETRY.ELAPSED_S = 0;
    }));
    const plain = await solved(harness, typed("evaluateOrbitGeometry", structuredClone(orbit)));
    // A stated zero coast really runs (through the propagator, so last bits move); unstated does not.
    for (const k of ["X", "Y", "Z", "X_DOT", "Y_DOT", "Z_DOT"]) {
      assert.ok(Math.abs(coast.GEOMETRY.STATE[k] - plain.GEOMETRY.STATE[k]) <= 1e-12 * Math.abs(plain.GEOMETRY.STATE[k]) + 1e-12, k);
    }
    const full = await solved(harness, typed("sampleOrbitGeometry", { ...structuredClone(orbit), count: 3 }));
    const zero = await solved(harness, typed("sampleOrbitGeometry", { ...structuredClone(orbit), count: 3 }, (p) => {
      p.REQUEST.GEOMETRY.HAS_SWEEP = true;
      p.REQUEST.GEOMETRY.SWEEP_DEG = 0;
    }));
    const st = zero.TRAJECTORY.STATES;
    assert.deepEqual(st.slice(0, 3), st.slice(6, 9)); // a zero sweep samples one point three times
    assert.notDeepEqual(full.TRAJECTORY.STATES.slice(0, 3), full.TRAJECTORY.STATES.slice(3, 6));
    const tol = await solved(harness, typed("phasingFromTargetState", structuredClone(pair), (p) => {
      Object.assign(p.REQUEST.PHASING, { HAS_ECCENTRICITY_TOLERANCE: true, ECCENTRICITY_TOLERANCE: 0,
        HAS_COPLANAR_TOLERANCE: true, COPLANAR_TOLERANCE_DEG: 0 });
    }));
    assert.equal(tol.PHASING.ECCENTRICITY_TOLERANCE, 0);
    assert.equal(tol.PHASING.NEAR_CIRCULAR, false);
    assert.equal(tol.PHASING.COPLANAR_TOLERANCE_DEG, 0);
  });
});
