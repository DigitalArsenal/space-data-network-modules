#!/usr/bin/env node
// Nyx Space (nyx-space 2.6.0, ANISE 0.10.6, MPL-2.0) on the engine benchmark
// plan's COMMON tier: writes nyx/src/main.rs's input from plan.json and runs
// the release binary (built by `cargo build --release --offline` in
// tests/evidence/engines/nyx). Settings: nyx/src/main.rs's header.
//
//   node tests/evidence/engines/run-nyx.mjs <nyx binary> <work dir> <pck08.pca> <ITRF93 bpc> [--only TEXT] [--reps 1] [--out nyx.json]
//
// The Earth's orientation is the given ITRF93 BPC (NAIF's
// earth_latest_high_prec.bpc: Nyx's usual JPL orientation, 4.8-6.5 mas from
// the IERS 2010 pole of the plan's EOP rows; docs/cross-validation.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  only: { type: 'string' }, reps: { type: 'string', default: '1' }, out: { type: 'string' },
} });
const [bin, workArg, pca, bpc] = positionals;
const work = path.resolve(workArg);
const plan = JSON.parse(fs.readFileSync(path.join(work, 'plan.json'), 'utf8'));
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const K = plan.constants, sc = plan.spacecraft, w = plan.spaceWeather;
const AU3_DAY2 = (K.auM ** 3) / 86400 ** 2;
const GM_SUN = 2.9591220828411951e-04 * AU3_DAY2, GM_MOON = 8.9970116036316091e-10 * AU3_DAY2 / (1 + 81.3005682214972154);
const cases = plan.cases.filter((c) => c.tier === 'COMMON' && (!o.only || c.id.includes(o.only)));
const input = {
  kernel: plan.data.kernel.path, pca, bpc, gmKm3S2: K.earthGmM3S2 / 1e9, occultingRadiusKm: K.shadowBodyRadiusM / 1000,
  sunRadiusKm: K.sunRadiusM / 1000, sunGmKm3S2: GM_SUN / 1e9, moonGmKm3S2: GM_MOON / 1e9, fluxWm2: K.solarIrradianceAt1AuWM2, reps: Number(o.reps),
  cases: cases.map((c) => ({
    id: c.id, state: [...c.positionM, ...c.velocityMS].map((v) => v / 1000), epochs: plan.sampleEpochsUtc, offsets: plan.sampleOffsetsS, massKg: sc.massKg,
    field: { cof: plan.data.cof.path, degree: c.forces.gravity.degree, order: c.forces.gravity.order, radiusKm: K.fieldRadiusM / 1000 },
    srp: c.forces.srp ? { cr: sc.cr, areaM2: sc.areaM2 } : null,
    drag: c.forces.drag ? { cd: sc.cd, areaM2: sc.areaM2, weather: { f107: w.f107, ap: w.ap, kp: w.kp } } : null,
    integrator: c.settings.kind === 'fixed' ? { kind: 'fixed', stepS: c.settings.stepS }
      : { kind: 'adaptive', tolerance: c.settings.relativeTolerance, minStepS: c.settings.minStepS, maxStepS: c.settings.maxStepS },
  })),
};
const result = JSON.parse(execFileSync(bin, { input: JSON.stringify(input), maxBuffer: 256 << 20, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }));
const results = result.cases.map((r) => {
  const c = cases.find((x) => x.id === r.id), s = c.settings;
  return { engine: 'Nyx', id: c.id, orbit: c.orbit, regime: c.regime, tier: c.tier, integrator: c.integrator,
    method: s.kind === 'fixed' ? `DormandPrince78 (RK8(7)13M) fixed ${s.stepS} s` : `DormandPrince78 (RK8(7)13M) tolerance ${s.relativeTolerance}, RSSCartesianState, max step ${s.maxStepS} s, stops at each hourly sample`,
    cpuS: r.cpuS, wallS: r.wallS, cpuSPerObjectDay: r.cpuS / plan.days, samples: r.samples.map(([t, x, y, z]) => [t, x * 1000, y * 1000, z * 1000]) };
});
const doc = { engine: 'Nyx', version: 'nyx-space 2.6.0, ANISE 0.10.6', runtime: `native release build (${execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim()}), one thread`,
  binarySha256: sha256(bin), bpc: { file: path.basename(bpc), sha256: sha256(bpc) }, pca: { file: path.basename(pca), sha256: sha256(pca) },
  host: { cpu: os.cpus()[0]?.model, loadAverage: os.loadavg() }, planSha256: sha256(path.join(work, 'plan.json')), reps: Number(o.reps), results };
const out = o.out ?? path.join(work, 'nyx.json');
fs.writeFileSync(out, `${JSON.stringify(doc)}\n`);
console.error(`${results.length} cases -> ${out}`);
