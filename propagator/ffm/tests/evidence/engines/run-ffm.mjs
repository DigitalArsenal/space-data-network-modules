#!/usr/bin/env node
// FFM on the engine benchmark plan (plan.mjs): each case as one PRW execution
// request to the shipped dist/isomorphic/module.wasm through the SDK browser
// harness (V8, the console's and the CA farm's runtime), timed on this
// thread's CPU clock.
//
//   node tests/evidence/engines/run-ffm.mjs <work dir> [--only TEXT] [--reps 2] [--algorithms RK78,RKDP87] [--out ffm.json]
//
// The request is FFM-1's catalog request (catalog.mjs fullForceRequest) on the
// plan's spacecraft (mass, area, Cd, Cr) with constant space weather, the
// plan's force tier and integrator, and hourly samples. Each timing is the
// smallest of --reps runs after one warm-up run; the fixed cost of a call
// (decoding the kernel and inputs) is measured by a zero-length request and
// reported apart. Encoding and timing only; the propagation is the module's.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as flatbuffers from 'flatbuffers';
import { fullForceRequest, prw as P } from '../../../catalog.mjs';
import { residentHarness, wasmPath } from '../../lib/residentRuntime.mjs';
import { decodeResult, encodePrw, makeTable, nativeInput, sds, TYPE } from '../../lib/prwCodec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  only: { type: 'string' }, reps: { type: 'string', default: '2' }, algorithms: { type: 'string', default: 'RK78,RKDP87' },
  out: { type: 'string' }, tiers: { type: 'string' },
} });
const work = path.resolve(positionals[0]);
const plan = JSON.parse(fs.readFileSync(path.join(work, 'plan.json'), 'utf8'));
const reps = Number(o.reps);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const kernel = fs.readFileSync(plan.data.kernel.path);
const eop = JSON.parse(fs.readFileSync(plan.data.eop.path, 'utf8'));
const eopRows = (() => {
  const bytes = Buffer.from(eop.payloadBase64, 'base64'), rows = [];
  for (let at = 0; at < bytes.length;) {
    const n = bytes.readUInt32LE(at);
    rows.push(sds.EOP.getSizePrefixedRootAsEOP(new flatbuffers.ByteBuffer(new Uint8Array(bytes.subarray(at, at + 4 + n)))).unpack());
    at += 4 + n;
  }
  return rows;
})();
const inputsFor = (request) => [
  { portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', request) },
  { portId: 'kernel', typeRef: TYPE, payload: nativeInput(kernel) },
  { portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: eopRows })) },
];
const instant = (iso) => Object.assign(new P.TIMInstantT(), { TIME_SYSTEM: P.timingStandard.UTC, EPOCH_FORMAT: P.timEpochRepresentation.ISO8601, ISO8601: iso });
const NAIF = { SUN: 10, MOON: 301, VENUS_BARYCENTER: 2, MARS_BARYCENTER: 4, JUPITER_BARYCENTER: 5 };

// One case as a PRW execution request; `algorithm` names the FFM integrator.
function request(c, algorithm, { span = true } = {}) {
  const s = c.settings, f = c.forces, sc = plan.spacecraft, w = plan.spaceWeather;
  const fixed = s.kind === 'fixed';
  const integrator = fixed
    ? { tolerance: 1, initialStep: s.stepS, minStep: s.stepS, maxStep: s.stepS, maxSteps: 10000000 }
    : { tolerance: s.relativeTolerance, initialStep: s.initialStepS, minStep: s.minStepS, maxStep: s.maxStepS, maxSteps: 10000000 };
  const last = plan.sampleEpochsUtc.at(-1);
  const r = fullForceRequest({ epoch: plan.epochUtc, state: [...c.positionM, ...c.velocityMS], target: span ? last : undefined, integrator, forces: {
    INITIAL_MASS_KG: sc.massKg, AREA_M2: sc.areaM2, DRAG_COEFFICIENT: sc.cd, REFLECTIVITY_COEFFICIENT: sc.cr,
    WEATHER: Object.assign(new P.PCFSpaceWeatherT(), { EPOCH: instant(plan.epochUtc), F107: w.f107, F107_AVERAGE: w.f107a, AP_INDEX: w.ap, KP_INDEX: w.kp }),
    MAXIMUM_DEGREE: f.gravity.degree, MAXIMUM_ORDER: f.gravity.order,
    THIRD_BODY_IDS: f.thirdBodies.map((b) => NAIF[b]),
    ENABLE_DRAG: f.drag,
    SOLID_TIDES: f.solidTides ? P.pcfSolidTideModel.IERS_2010 : P.pcfSolidTideModel.NONE,
    RELATIVITY: f.relativity ? P.pcfRelativityTerms.IERS_2010 : P.pcfRelativityTerms.NONE,
    EARTH_RADIATION: f.earthRadiation ? P.pcfEarthRadiationModel.KNOCKE : P.pcfEarthRadiationModel.NONE,
    OCEAN_TIDES: f.oceanTides ? P.pcfOceanTideModel.FES2004 : P.pcfOceanTideModel.NONE,
  } });
  r.INTEGRATOR.ALGORITHM = P.pcfIntegratorAlgorithm[algorithm];
  // The absolute tolerances are the plan's (FFM: m and m/s, r * 1000).
  r.INTEGRATOR.ABSOLUTE_TOLERANCES = Array(6).fill(fixed ? 1e3 : s.absoluteTolerance);
  if (span) r.SAMPLE_EPOCHS = plan.sampleEpochsUtc.slice(1).map(instant);
  return r;
}

const cpu = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1e6; };
async function timed(harness, inputs) {
  const c0 = cpu(), w0 = performance.now();
  const response = await harness.invoke({ methodId: 'invoke', inputs });
  const cpuS = cpu() - c0, wallS = (performance.now() - w0) / 1000;
  if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
  return { response, cpuS, wallS };
}

const harness = await residentHarness('browser');
const results = [];
const algorithms = o.algorithms.split(',');
const tiers = o.tiers ? new Set(o.tiers.split(',')) : null;
// The fixed cost of one call: a zero-length FFM-1 request, smallest of 5.
const zeroInputs = inputsFor(request(plan.cases[0], 'RK78', { span: false }));
await timed(harness, zeroInputs);
let fixedCostS = Infinity;
for (let i = 0; i < 5; ++i) fixedCostS = Math.min(fixedCostS, (await timed(harness, zeroInputs)).cpuS);
for (const c of plan.cases) {
  if (o.only && !c.id.includes(o.only)) continue;
  if (tiers && !tiers.has(c.tier)) continue;
  for (const algorithm of c.settings.kind === 'fixed' ? ['RKDP87'] : algorithms) {
    const inputs = inputsFor(request(c, algorithm));
    let best = await timed(harness, inputs);
    for (let i = 0; i < reps; ++i) { const t = await timed(harness, inputs); if (t.cpuS < best.cpuS) best = t; }
    const result = decodeResult(best.response);
    const final = result.samples.at(-1);
    const steps = final.integrationSteps, rejected = final.integrationRejections;
    const stages = { RK78: 13, RKDP87: 13 }[algorithm];
    const row = {
      engine: 'FFM', id: c.id, orbit: c.orbit, regime: c.regime, tier: c.tier, integrator: c.integrator,
      method: `${algorithm === 'RK78' ? 'RK78 (Fehlberg 7(8), 13 stages)' : 'RKDP87 (Prince-Dormand 8(7)13M, 13 stages, first same as last)'}${c.settings.kind === 'fixed' ? ` fixed ${c.settings.stepS} s` : ` rel ${c.settings.relativeTolerance} abs ${c.settings.absoluteTolerance} m, m/s, max step ${c.settings.maxStepS} s; error norm: largest component of err/(abs + rel |y|)`}`,
      algorithm, cpuS: best.cpuS, wallS: best.wallS, fixedCostS, propagationCpuS: best.cpuS - fixedCostS,
      cpuSPerObjectDay: (best.cpuS - fixedCostS) / plan.days, steps, rejectedSteps: rejected,
      evaluations: stages ? (steps + rejected) * (algorithm === 'RKDP87' ? stages - 1 : stages) + 1 : null,
      samples: [[0, ...c.positionM], ...result.samples.map((s, i) => [plan.sampleOffsetsS[i + 1], ...s.position.map((x) => x * 1000)])],
    };
    row.usPerEvaluation = row.evaluations ? 1e6 * row.propagationCpuS / row.evaluations : null;
    results.push(row);
    console.error(`${c.id} ${algorithm}: ${row.cpuSPerObjectDay.toFixed(4)} CPU-s/object-day, ${steps}+${rejected} steps, ${row.usPerEvaluation?.toFixed(2)} us/eval`);
  }
}
await harness.destroy();
const manifest = JSON.parse(fs.readFileSync(path.join(here, '../../../plugin-manifest.json'), 'utf8'));
const doc = { engine: 'FFM', version: `${manifest.pluginId} ${manifest.version}`, runtime: `Node.js ${process.version} (V8 ${process.versions.v8}), SDK browser harness, one thread`,
  wasmSha256: sha256(fs.readFileSync(wasmPath)), host: { cpu: os.cpus()[0]?.model, logicalCpus: os.availableParallelism(), loadAverage: os.loadavg() },
  planSha256: sha256(fs.readFileSync(path.join(work, 'plan.json'))), fixedCostS, reps, results };
const out = o.out ?? path.join(work, 'ffm.json');
fs.writeFileSync(out, `${JSON.stringify(doc)}\n`);
console.error(`-> ${out}`);
