#!/usr/bin/env node
// E2E (stack #464 and #456; SPEC 16.14): AP's radiation-pressure rates are continuous in the set's own elements, and right.
// 1. The rates against the numerical average, through the module's sdnap_ap_srp_rates: mode 0 the theory's averaged
//    rates on AP's shadow, mode 1 the same sphere in the same cylinder averaged over one revolution of the mean orbit by
//    the Gauss equations (4096 steps of the eccentric longitude, a step the boundary crosses split where it is), the Sun
//    held fixed at 1 AU. AGOM 0.025 m^2/kg. Mean orbits: Galileo-like (n 1.7047 rev/day, e 0.0002, i 56 deg) and
//    geostationary (n 1.00273 rev/day, e 0.0003, i 0.05 deg, which takes section 4's arrangement of the formulas).
//    - Through grazing: the Sun's elevation above the orbit plane swept across the edge of the eclipse season
//      (Galileo-like 11.5 to 13.0 deg, geostationary 7.5 to 9.5 deg, by 0.005 deg; the Sun 30 and 40 deg from the
//      perigee in the plane).
//    - Through a boundary at an apse: the Galileo-like orbit with the Sun 6 deg above the plane, its direction in the
//      plane swept so that the shadow's exit, then its entry, passes the perigee (168.5 to 169.6 and 190.4 to 191.4 deg
//      from the perigee, by 0.002 deg).
//    Asserted for each of the six rates: |theory - average| at most RATE_TOL of the rate's largest |average| on the
//    sweep, and the theory's largest step between neighbors at most STEP_RATIO times the average's plus RATE_TOL of
//    that scale (a step where the average has none is a discontinuity).
// 2. The nudge scan: made-up AP sets (FORCES 31,20, drag off) in an eclipse season, flown 7 days on a 600 s grid (GCRF)
//    as given and with the mean motion moved by 1e-10 and by 2e-10 relative. Their flights must part linearly, as a
//    real change of that size does (0.22 m at day 7): the departure |d2 - 2 d1| (d the position difference against the
//    set as given) at most NUDGE_M at every epoch. The sets: Galileo-like at 2026-01-26 00:00 UTC (n 1.7047 rev/day,
//    e 0.0002, i 56, RAAN 329.65, argp 150, M 10 deg, AGOM 0.025; the Sun about 6 deg above the plane, a shadow boundary
//    passing the perigee within the week) and geostationary at 2026-03-10 00:00 UTC (n 1.00273 rev/day, e 0.0003,
//    i 0.05, RAAN 80, argp 270, M 100 deg, AGOM 0.02).
// Measured 2026-11-11: rates within 7.6e-7 of the scale (largest on n-dot through the apse), steps equal to the
// average's to three digits; the nudge departure 0.29 mm (Galileo-like) and 0.008 mm (geostationary), where 0.6.16's
// closed-form shadow and its 1e-12 test read 13.49 m and 9.86 m.
// Every number comes from the built module's own calls. JS only moves bytes and compares numbers the module produced.
//   node test/radiation-shadow.e2e.mjs
import * as fb from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { wasmPath } from "./lib/module.mjs";
import { seedOcm, flight } from "./lib/ocm.mjs";

const RATE_TOL = 1e-5, STEP_RATIO = 1.01, NUDGE_M = 0.01;
const D = Math.PI / 180, AGOM = 0.025, NAMES = ["af", "ag", "chi", "psi", "lambda", "n"];
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const x = h.instance.exports, pin = x.sdnap_alloc(88), pout = x.sdnap_alloc(48);
const failures = [];

// 1. rates against the numerical average
const ORBITS = {
  "Galileo-like": { n: 1.7047, e: 0.0002, i: 56 },
  geostationary: { n: 1.00273, e: 0.0003, i: 0.05 },
};
const SWEEPS = [
  { name: "grazing", orbit: "Galileo-like", axis: "beta", from: 11.5, to: 13.0, step: 0.005, other: 30 },
  { name: "grazing", orbit: "geostationary", axis: "beta", from: 7.5, to: 9.5, step: 0.005, other: 40 },
  { name: "exit at perigee", orbit: "Galileo-like", axis: "phi", from: 168.5, to: 169.6, step: 0.002, other: 6 },
  { name: "entry at perigee", orbit: "Galileo-like", axis: "phi", from: 190.4, to: 191.4, step: 0.002, other: 6 },
];
const rates = (o, beta, phi, mode) => {
  // native elements (af, ag, chi, psi, lambda deg, n rev/day) with the perigee and node at 0; the Sun on P, Q, W
  new Float64Array(h.memory.buffer, pin, 11).set([o.e, 0, 0, Math.tan((o.i / 2) * D), 0, o.n,
    Math.cos(beta * D) * Math.cos(phi * D), Math.cos(beta * D) * Math.sin(phi * D), Math.sin(beta * D), 1.0, AGOM]);
  const arc = x.sdnap_ap_srp_rates(pin, mode, 4096, pout);
  if (arc < 0) throw new Error(`sdnap_ap_srp_rates refused beta ${beta} phi ${phi}`);
  return { arc, r: Array.from(new Float64Array(h.memory.buffer, pout, 6)) };
};
for (const s of SWEEPS) {
  const o = ORBITS[s.orbit], rows = [];
  const count = Math.round((s.to - s.from) / s.step);
  for (let k = 0; k <= count; k++) {
    const v = s.from + k * s.step, [beta, phi] = s.axis === "beta" ? [v, s.other] : [s.other, v];
    rows.push({ v, t: rates(o, beta, phi, 0), m: rates(o, beta, phi, 1) });
  }
  const row = { sweep: s.name, orbit: s.orbit, points: rows.length, arcs: rows.filter((r) => r.t.arc === 1).length, error: {}, steps: {} };
  NAMES.forEach((name, c) => {
    const scale = Math.max(...rows.map((r) => Math.abs(r.m.r[c])));
    if (!(scale > 0)) { failures.push(`${s.orbit} ${s.name}: the average's ${name} rate is 0 along the sweep`); return; }
    const err = Math.max(...rows.map((r) => Math.abs(r.t.r[c] - r.m.r[c]))) / scale;
    const stepT = Math.max(...rows.slice(1).map((r, k) => Math.abs(r.t.r[c] - rows[k].t.r[c]))) / scale;
    const stepM = Math.max(...rows.slice(1).map((r, k) => Math.abs(r.m.r[c] - rows[k].m.r[c]))) / scale;
    row.error[name] = +err.toExponential(2);
    row.steps[name] = [+stepT.toExponential(3), +stepM.toExponential(3)];
    if (!(err <= RATE_TOL)) failures.push(`${s.orbit} ${s.name}: the ${name} rate departs from the average by ${err.toExponential(2)} of its scale (at most ${RATE_TOL})`);
    if (!(stepT <= STEP_RATIO * stepM + RATE_TOL)) failures.push(`${s.orbit} ${s.name}: the ${name} rate steps by ${stepT.toExponential(3)} of its scale between neighbors, the average by ${stepM.toExponential(3)}`);
  });
  if (s.name === "grazing" && !(row.arcs > 0 && row.arcs < rows.length)) failures.push(`${s.orbit} grazing: the sweep does not cross the season's edge (${row.arcs} of ${rows.length} with an arc)`);
  console.log(JSON.stringify(row));
}

// 2. the nudge scan
const SETS = [
  { name: "Galileo-like", epoch: "2026-01-26T00:00:00.000", n: 1.7047, e: 0.0002, i: 56, raan: 329.65, argp: 150, ma: 10, agom: 0.025 },
  { name: "geostationary", epoch: "2026-03-10T00:00:00.000", n: 1.00273, e: 0.0003, i: 0.05, raan: 80, argp: 270, ma: 100, agom: 0.02 },
];
for (const c of SETS) {
  const t0 = Date.parse(`${c.epoch}Z`), iso = (ms) => new Date(ms).toISOString().replace("Z", "");
  const fly = async (n) => {
    const rec = seedOcm({ epoch: c.epoch, n, e: c.e, i: c.i, raan: c.raan, argp: c.argp, ma: c.ma, agom: c.agom, bterm: 0, norad: 99003, tesseral: 31, zonal: 20 });
    const r = await h.invoke({ methodId: "propagate", inputs: flight([rec], { output: { START_TIME: iso(t0), STOP_TIME: iso(t0 + 7 * 86400000), STEP_SECONDS: 600, FRAME: pcfOutputFrame.GCRF } }) });
    if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
    return OEM.getRootAsOEM(new fb.ByteBuffer(new Uint8Array(r.outputs.find((o) => o.portId === "ephemeris").payload))).unpack()
      .EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.map((l) => [l.X, l.Y, l.Z]);
  };
  const base = await fly(c.n), one = await fly(c.n * (1 + 1e-10)), two = await fly(c.n * (1 + 2e-10));
  let departure = 0, drift = 0;
  for (let k = 0; k < base.length; k++) {
    const d1 = [0, 1, 2].map((z) => one[k][z] - base[k][z]), d2 = [0, 1, 2].map((z) => two[k][z] - base[k][z]);
    departure = Math.max(departure, 1000 * Math.hypot(...[0, 1, 2].map((z) => d2[z] - 2 * d1[z])));
    drift = Math.max(drift, 1000 * Math.hypot(...d1));
  }
  console.log(JSON.stringify({ nudge: c.name, epochs: base.length, departureM: +departure.toExponential(3), driftAt1e10M: +drift.toFixed(4) }));
  if (!(departure <= NUDGE_M)) failures.push(`${c.name}: the flights part non-linearly by ${departure.toFixed(4)} m under a 1e-10 change of the mean motion (at most ${NUDGE_M} m)`);
}

x.sdnap_free(pin);
x.sdnap_free(pout);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`radiation shadow E2E: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("radiation shadow E2E: PASS");
