// modules-sdn-ap-drag-high-eccentricity-20261103, step 1: the isolation table from the jobs of drag-isolation-job.mjs.
// node drag-isolation-report.mjs <jobs dir>
// err_on - err_off = (AP_on - AP_off) - (FFM_on - FFM_off): the drag theory's own error with the gravity residuals
// (which the two runs share) cancelled. Per pass: the point-mass specific energy E = v^2/2 - mu/r at the apogee samples
// on either side of each perigee, (E_on - E_off) differenced across the pass, AP against FFM (the drag work of the pass
// as the orbit carries it away); the same for the specific angular momentum |r x v|. Measurement arithmetic only.
import fs from 'node:fs';
import path from 'node:path';
const MU = 398600.4418;
const dir = process.argv[2], prefix = process.argv[3] ?? 'iso';
const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const energy = (s) => 0.5 * (s[3] ** 2 + s[4] ** 2 + s[5] ** 2) - MU / norm(s);
const hmom = (s) => norm([s[1] * s[5] - s[2] * s[4], s[2] * s[3] - s[0] * s[5], s[0] * s[4] - s[1] * s[3]]);
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const dayRms = (profile, d, key) => rms(profile.filter((q) => q.h > (d - 1) * 24 && q.h <= d * 24).map((q) => q[key]));
const load = (name) => { const f = path.join(dir, name + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null; };
const f1 = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

function passes(on, off) {
  // sample 0 of each series is the state at the grid's first step; seed runs add the epoch state as the base
  const mk = (r) => (r.fixture.initialGcrfKm && r.profile[0].h < 1 ? [r.fixture.initialGcrfKm] : []).concat(r.reference);
  const refOn = on.reference, n = refOn.length;
  const rad = refOn.map(norm);
  const apo = [];
  const w = 30; // +-5 h on the 10 minute grid
  for (let k = 1; k < n - 1; k++) {
    let top = true;
    for (let j = Math.max(0, k - w); j <= Math.min(n - 1, k + w); j++) if (rad[j] > rad[k]) { top = false; break; }
    if (top && rad[k] > 0.5 * (Math.max(...rad) + Math.min(...rad))) apo.push(k);
  }
  const rows = [];
  const dEon = (k) => energy(on.reference[k]), dEoff = (k) => energy(off.reference[k]);
  const E = (k) => ({ ffm: energy(on.reference[k]) - energy(off.reference[k]), ap: energy(on.flown[k]) - energy(off.flown[k]) });
  const H = (k) => ({ ffm: hmom(on.reference[k]) - hmom(off.reference[k]), ap: hmom(on.flown[k]) - hmom(off.flown[k]) });
  const D = (k) => ['t', 'r', 'n'].map((a) => on.profile[k][a] - off.profile[k][a]);
  for (let i = 0; i + 1 < apo.length; i++) {
    const a = apo[i], b = apo[i + 1];
    let p = a; for (let k = a; k <= b; k++) if (rad[k] < rad[p]) p = k;
    // the osculating perigee radius of the apogee state before the pass (the 10 minute grid does not sample the perigee itself)
    const sa = on.reference[a], ra = norm(sa), Ea = energy(sa), aa = -MU / (2 * Ea), ea = Math.sqrt(Math.max(0, 1 - hmom(sa) ** 2 / (MU * aa)));
    const e0 = E(a), e1 = E(b), h0 = H(a), h1 = H(b), d0 = D(a), d1 = D(b);
    rows.push({ pass: i + 1, hour: on.profile[p].h, perigeeKm: aa * (1 - ea) - 6378.137,
      dE_ffm: e1.ffm - e0.ffm, dE_ap: e1.ap - e0.ap, dH_ffm: h1.ffm - h0.ffm, dH_ap: h1.ap - h0.ap,
      ddT: d1[0] - d0[0], ddR: d1[1] - d0[1], ddN: d1[2] - d0[2] });
  }
  return rows;
}

const out = [];
for (const fx of ['Molniya', 'GTO', 'GTO-500']) {
  for (const mode of ['seed', 'pinned']) {
    const j = load(`${prefix}-${fx}-${mode}`);
    if (!j) continue;
    const { on, off } = j;
    const dd = on.profile.map((q, k) => ({ h: q.h, t: q.t - off.profile[k].t, r: q.r - off.profile[k].r, n: q.n - off.profile[k].n }));
    const day = (p, d) => ['t', 'r', 'n'].map((a) => f1(dayRms(p, d, a))).join(' / ');
    out.push(`\n## ${fx}, BTERM ${mode === 'seed' ? 'seeded at 0.044 (no fit, FFM from AP epoch state)' : 'pinned at 0.044 (fit, sigma 1e-7)'}; perigee ${on.perigeeKm.toFixed(0)} km; Sun and Moon off both sides`);
    out.push('whole-day RMS along-track / radial / cross-track, m');
    out.push('| day | drag on | drag off | on minus off (drag theory) |\n|---|---|---|---|');
    for (const d of [1, 3, 7]) out.push(`| ${d} | ${day(on.profile, d)} | ${day(off.profile, d)} | ${day(dd, d)} |`);
    out.push(`fitted BTERM ${on.fitted.bterm}; ${on.fitted.bModel ?? ''}`);
    const rows = passes(on, off);
    out.push('per perigee pass (apogee to apogee; dE, dH are AP and FFM changes of (on - off) specific energy, km^2/s^2, and angular momentum, km^2/s; dd the growth of the on-minus-off error, m)');
    out.push('| pass | hour | osculating perigee km | dE FFM | dE AP | AP/FFM | dH FFM | dH AP | AP/FFM | dd T | dd R | dd N |\n|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) out.push(`| ${r.pass} | ${r.hour.toFixed(1)} | ${r.perigeeKm.toFixed(1)} | ${r.dE_ffm.toExponential(4)} | ${r.dE_ap.toExponential(4)} | ${(r.dE_ap / r.dE_ffm).toFixed(4)} | ${r.dH_ffm.toExponential(3)} | ${r.dH_ap.toExponential(3)} | ${(r.dH_ap / r.dH_ffm).toFixed(4)} | ${f1(r.ddT)} | ${f1(r.ddR)} | ${f1(r.ddN)} |`);
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    out.push(`all ${rows.length} passes: dE AP/FFM ${(sum('dE_ap') / sum('dE_ffm')).toFixed(4)}; dH AP/FFM ${(sum('dH_ap') / sum('dH_ffm')).toFixed(4)}`);
  }
}
// BTERM scan: the day-7 whole-day RMS with BTERM pinned at b, per fixture and Sun/Moon arm
const scans = fs.readdirSync(dir).filter((n) => /^scan-.*\.json$/.test(n)).sort();
if (scans.length) {
  out.push('\n## BTERM scan (pinned at b; truth 0.044), day-7 whole-day RMS along-track / radial / cross-track, m');
  for (const file of scans) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, file)));
    const w = j.run.wholeDay[7];
    out.push(`${file.replace('.json', '')}: b ${j.job.b} (${(100 * (j.job.b / 0.044 - 1)).toFixed(2)} %): ${f1(w.t)} / ${f1(w.r)} / ${f1(w.n)}`);
  }
}
// the fits: every fit-* (release module, Sun and Moon on both sides) and nb-fit-<build>-* (a test build with the Sun and Moon off, FFM without)
for (const file of fs.readdirSync(dir).filter((n) => /^(nb-)?fit-.*\.json$/.test(n)).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, file)));
  const w = j.run.wholeDay, last = Math.max(...Object.keys(w).map(Number)), fm = j.run.fitted.bModel ?? '';
  const post = /posterior ([0-9.eE+-]+) \+- ([0-9.eE+-]+) m/.exec(fm), sig = /posterior sigma of the log ([0-9.eE+-]+)/.exec(fm)?.[1];
  const b = j.run.fitted.bterm;
  out.push(`${file.replace('.json', '')}: BTERM ${b.toPrecision(6)} (${(100 * (b / 0.044 - 1)).toFixed(2)} % from 0.044); posterior ${post ? `${post[1]} +- ${post[2]} (${(100 * post[2] / post[1]).toFixed(2)} %; bias ${((b - 0.044) / post[2]).toFixed(1)} sigma)` : `sigma of the log ${sig}`}; day ${last} T / R / N ${f1(w[last].t)} / ${f1(w[last].r)} / ${f1(w[last].n)} m`);
}
console.log(out.join('\n'));
