#!/usr/bin/env node
// E2E (DigitalArsenal/spacedatanetwork-stack#446): AP's Sun and Moon (SPEC 16.17) against DE440. The stored samples
// (test/fixtures/de440-bodies-2010-2035.json: NAIF de440s.bsp, geocentric, GCRF, every 23.37 days from 2010 to 2035,
// tools/ap-bodies-fit.mjs samples) are turned to TEME of date by the module (sdnap_frame_probe, gcrf_to_teme) and
// compared with what AP's flights read (sdnap_bodies_probe mode 2, the quintic through the series' 8 h nodes).
// - Moon: direction at most 8 arcsec and RMS at most 2.5 arcsec; distance at most 6 km and RMS at most 1.5 km.
// - Sun: direction at most 2 arcsec; distance at most 600 km.
// - The cache against the series at the same instants (mode 2 against mode 1): at most 0.01 arcsec and 1 m (measured
//   0.0025 arcsec and 0.34 m; the largest differences sit on days with a leap second, whose UTC day is 86,401 s long).
// - Smooth in time through the cache (the Sun also sets the shadow and the radiation terms): at 200 node boundaries the
//   second difference of the unit vector (60 s apart) differs from the same 30 min away by at most 1e-6 arcsec for the
//   Sun and 1e-4 arcsec for the Moon (measured 1.5e-9 and 1.2e-5, the Moon's mostly its own change of curvature).
// Printed for the record, not tested: SPEC 5's Sun and Moon (SGP4XP, mode 0) on the same samples, read as AP read
// them through 0.6.21 (UTC as the time argument, mean equator of date taken for TEME): about 90 arcsec for the Moon.
// JS only moves bytes and measures angles between vectors the module and the stored samples give.
//   node test/ap-bodies.e2e.mjs
import fs from "node:fs";
import { openModule } from "./lib/module.mjs";
import { rotate } from "./lib/frames.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/de440-bodies-2010-2035.json", import.meta.url), "utf8"));
const m = await openModule();
const x = m.x;
const p = x.sdnap_alloc(64);
const probe = (whole, frac, mode) => {
  if (x.sdnap_bodies_probe(whole, frac, mode, p) !== 0) throw new Error(`sdnap_bodies_probe refused mode ${mode}`);
  const o = new Float64Array(m.harness.memory.buffer, p, 8);
  return { sun: [o[0], o[1], o[2]], sunKm: o[3], moon: [o[4], o[5], o[6]], moonKm: o[7] };
};
const ARCSEC = Math.PI / 180 / 3600;
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const angle = (a, b) => {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(norm(c), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ARCSEC;
};
const rows = { ap: { moonDir: [], moonKm: [], sunDir: [], sunKm: [] }, xp: { moonDir: [], moonKm: [], sunDir: [], sunKm: [] }, cacheDir: [], cacheM: [] };
for (const s of fixture.rows) {
  const teme = (v) => { const { status, out } = rotate(m, s.whole, s.frac, [...v, 0, 0, 0], 0); if (status < 0) throw new Error(`frame probe refused ${s.utc}`); return out.slice(0, 3); };
  const moon = teme(s.moon), sun = teme(s.sun);
  for (const [arm, mode] of [["ap", 2], ["xp", 0]]) {
    const b = probe(s.whole, s.frac, mode);
    rows[arm].moonDir.push(angle(b.moon, moon));
    rows[arm].moonKm.push(b.moonKm - norm(moon));
    rows[arm].sunDir.push(angle(b.sun, sun));
    rows[arm].sunKm.push(b.sunKm - norm(sun));
  }
  const exact = probe(s.whole, s.frac, 1), cached = probe(s.whole, s.frac, 2);
  rows.cacheDir.push(Math.max(angle(exact.moon, cached.moon), angle(exact.sun, cached.sun)));
  rows.cacheM.push(1000 * Math.max(Math.abs(exact.moonKm - cached.moonKm), Math.abs(exact.sunKm - cached.sunKm)));
}
// Smooth through the cache: at 200 node boundaries (0, 8 and 16 h UTC, one every 56 h from the first sample), the
// second difference of each unit vector at 60 s spacing centered on the boundary against the same 30 min away (inside
// a node interval), arcsec; the quintic changes at a node but stays continuous, so only its slope may step there.
const smooth = { sun: [], moon: [] };
{
  const d = 60 / 86400;
  const d2 = (whole, frac, body) => {
    const u = [-1, 0, 1].map((k) => probe(whole, frac + k * d, 2)[body]);
    return norm([0, 1, 2].map((c) => u[0][c] - 2 * u[1][c] + u[2][c])) / ARCSEC;
  };
  const w0 = fixture.rows[0].whole;
  for (let k = 0; k < 200; k++) {
    const hours = k * 56 + 8, whole = w0 + Math.floor(hours / 24), frac = (hours % 24) / 24;
    for (const body of ["sun", "moon"]) smooth[body].push(Math.abs(d2(whole, frac, body) - d2(whole, frac + 0.5 / 24, body)));
  }
}
const max = (v) => Math.max(...v.map(Math.abs)), rms = (v) => Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);
const summary = (r) => ({
  moonDirectionArcsec: { rms: +rms(r.moonDir).toFixed(3), max: +max(r.moonDir).toFixed(3) },
  moonDistanceKm: { rms: +rms(r.moonKm).toFixed(3), max: +max(r.moonKm).toFixed(3) },
  sunDirectionArcsec: { rms: +rms(r.sunDir).toFixed(3), max: +max(r.sunDir).toFixed(3) },
  sunDistanceKm: { rms: +rms(r.sunKm).toFixed(1), max: +max(r.sunKm).toFixed(1) },
});
const ap = summary(rows.ap), xp = summary(rows.xp);
console.log(JSON.stringify({ samples: fixture.rows.length, span: [fixture.rows[0].utc, fixture.rows.at(-1).utc], ap, spec5AsAPReadIt: xp,
  cache: { directionArcsec: +max(rows.cacheDir).toFixed(5), distanceM: +max(rows.cacheM).toFixed(4) },
  secondDifferenceStepAtNodeArcsec: { sun: +max(smooth.sun).toExponential(2), moon: +max(smooth.moon).toExponential(2) } }, null, 1));
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
check(ap.moonDirectionArcsec.max <= 8, `Moon direction ${ap.moonDirectionArcsec.max} arcsec at worst (bound 8)`);
check(ap.moonDirectionArcsec.rms <= 2.5, `Moon direction RMS ${ap.moonDirectionArcsec.rms} arcsec (bound 2.5)`);
check(ap.moonDistanceKm.max <= 6, `Moon distance ${ap.moonDistanceKm.max} km at worst (bound 6)`);
check(ap.moonDistanceKm.rms <= 1.5, `Moon distance RMS ${ap.moonDistanceKm.rms} km (bound 1.5)`);
check(ap.sunDirectionArcsec.max <= 2, `Sun direction ${ap.sunDirectionArcsec.max} arcsec at worst (bound 2)`);
check(ap.sunDistanceKm.max <= 600, `Sun distance ${ap.sunDistanceKm.max} km at worst (bound 600)`);
check(max(rows.cacheDir) <= 0.01, `cache against series ${max(rows.cacheDir)} arcsec (bound 0.01)`);
check(max(rows.cacheM) <= 1, `cache against series ${max(rows.cacheM)} m (bound 1)`);
check(max(smooth.sun) <= 1e-6, `the Sun's second difference steps by ${max(smooth.sun)} arcsec at a node (bound 1e-6)`);
check(max(smooth.moon) <= 1e-4, `the Moon's second difference steps by ${max(smooth.moon)} arcsec at a node (bound 1e-4)`);
x.sdnap_free(p);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log("PASS ap-bodies: AP's Sun and Moon within their bounds of DE440 over 2010-2035");
