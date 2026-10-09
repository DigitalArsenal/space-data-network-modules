// Prepares the GPS radiation-pressure experiment on E3's test window: the
// E3 HPOP-URA requests (same seed, forces, integrator, epochs), the ultra-rapid
// observed half for the fits, and the ESA final reference states. Reading,
// selection and framing only; time conversion is foundation/time's, EOP
// parsing data-source/eop-parser's (exactly as E3 step 10).
//   node tests/gps-srp-accuracy-prepare.mjs <orbit-accuracy-experiments checkout with E3> <modules root (canonical)> <hpop dir> <SINEX> <out dir> [--days N] [--wasm]
import fs from 'node:fs';
import path from 'node:path';

const [e3, modulesRoot, hpopDir, sinexFile, outDir] = process.argv.slice(2);
const daysLimit = process.argv.includes('--days') ? Number(process.argv[process.argv.indexOf('--days') + 1]) : Infinity;
const runWasm = process.argv.includes('--wasm');
const imp = (p) => import(path.join(e3, p));
const { loadModule, sha256 } = await imp('harness/modules.mjs');
const { executionFrame, kernelFrame, decodeExecution } = await imp('harness/prw.mjs');
const { eopFrame } = await imp('harness/eop.mjs');
const { convertIso } = await imp('harness/time.mjs');
const { Products } = await imp('experiments/e3-combined-catalog/truth.mjs');
const { finalsRecords } = await imp('experiments/e3-combined-catalog/eop-finals.mjs');
const config = JSON.parse(fs.readFileSync(path.join(e3, 'experiments/e3-combined-catalog/config.json'), 'utf8'));

const DAY = 86400000;
fs.mkdirSync(path.join(outDir, 'req'), { recursive: true });
const referenceDir = config.inputs.reference;
const iso = (ms) => new Date(ms).toISOString();
const isoUtc = (ms) => iso(ms).replace('Z', '');

// ── GPS block and mass by NORAD number (IGS satellite metadata SINEX) ──
const sinex = fs.readFileSync(sinexFile, 'latin1').split('\n');
const blockOf = new Map(), svnOf = new Map(), massRows = [];
let section = '';
for (const l of sinex) {
  if (l.startsWith('+')) { section = l.slice(1).trim(); continue; }
  if (l.startsWith('-') || l.startsWith('*')) continue;
  if (section === 'SATELLITE/IDENTIFIER' && l.startsWith(' G')) {
    const svn = l.slice(1, 5), norad = Number(l.slice(16, 22)), block = l.slice(22, 38).trim();
    svnOf.set(norad, svn); blockOf.set(svn, block);
  }
  if (section === 'SATELLITE/MASS' && l.startsWith(' G')) massRows.push({ svn: l.slice(1, 5), from: l.slice(6, 20), mass: Number(l.slice(36, 46)) });
}
const blockName = (b) => ({ 'GPS-IIR': 'IIR', 'GPS-IIR-A': 'IIR', 'GPS-IIR-B': 'IIR', 'GPS-IIR-M': 'IIR-M', 'GPS-IIF': 'IIF', 'GPS-IIIA': 'III', 'GPS-IIIF': 'III' }[b] ?? b);
const massOf = (svn) => massRows.filter((r) => r.svn === svn).at(-1)?.mass;

// ── Products (as E3 step 10) ──
const gpsTruth = new Products(referenceDir, [config.regimes.GPS.truthPrefix]);
const objects = gpsTruth.objects().filter((n) => gpsTruth.entries(n).some((e) => e.comment.includes(`SP3 satellite ${config.regimes.GPS.sp3System}`)));
const startOf = (product) => {
  const m = /_(\d{4})(\d{3})(\d{2})(\d{2})_/.exec(product);
  return Date.UTC(Number(m[1]), 0, 1) + (Number(m[2]) - 1) * DAY + Number(m[3]) * 3600000 + Number(m[4]) * 60000;
};
const spec = config.sources.URA;
const ura = new Products(referenceDir, [spec.productPrefix]);
const issues = ura.products.map((x) => ({ product: x.product, start: startOf(x.product) })).sort((a, b) => a.start - b.start);
const newestIssue = (t) => issues.filter((x) => x.start + spec.availableAfterStartHours * 3600000 <= t).at(-1) ?? null;

const window = config.windows.test;
let issueTimes = [];
for (let t = Date.parse(`${window[0]}T${config.issueTimeUtc}Z`); t <= Date.parse(`${window[1]}T${config.issueTimeUtc}Z`); t += DAY) issueTimes.push(t);
issueTimes = issueTimes.slice(0, daysLimit);

const time = await loadModule(modulesRoot, 'foundation/time');
const parser = await loadModule(modulesRoot, 'data-source/eop-parser');
const eop = await finalsRecords(parser, config.inputs.eopFinals);
await parser.destroy?.();
const kernelBytes = fs.readFileSync(path.join(modulesRoot, config.inputs.kernel));
const kernel = kernelFrame(kernelBytes);
fs.writeFileSync(path.join(outDir, 'kernel.bin'), kernel.payload);
const tdbCache = new Map();
const tdb = async (s) => { if (!tdbCache.has(s)) tdbCache.set(s, await convertIso(time, s, 'UTC', 'TDB')); return tdbCache.get(s); };
const hpop = runWasm ? await loadModule(path.dirname(path.dirname(hpopDir)), path.relative(path.dirname(path.dirname(hpopDir)), hpopDir)) : null;

const offsetMs = config.issueOffsetSeconds * 1000, tolMs = config.targetToleranceSeconds * 1000;
const horizons = config.horizonsDays.filter((h) => h > 0);
const jobs = [], lines = [`kernel ${path.join(outDir, 'kernel.bin')}`], eopFiles = new Map(), wasm = [];
for (const day of issueTimes) {
  const T = day + offsetMs;
  for (const n of objects) {
    const targets = horizons.map((h) => ({ h, state: gpsTruth.firstAtOrAfter(n, T + h * DAY, tolMs) })).filter((t) => t.state);
    const issue = newestIssue(T);
    const entry = issue && ura.entries(n).find((e) => e.product === issue.product);
    const seed = entry && ura.stateAt(entry, T);
    if (!seed || !targets.length) continue;
    // The issue's observed half: its first 24 h.
    const { epochs, lines: rows } = ura.load(entry);
    const obs = [];
    for (let i = 0; i < epochs.length; ++i) if (epochs[i] >= issue.start && epochs[i] < issue.start + 24 * 3600000) obs.push({ ms: epochs[i], r: [rows[i].X, rows[i].Y, rows[i].Z], v: [rows[i].X_DOT, rows[i].Y_DOT, rows[i].Z_DOT] });
    if (obs.length < 48) continue;
    const svn = svnOf.get(n), block = blockName(blockOf.get(svn)), mass = massOf(svn);
    const id = `${n}_${iso(T).slice(0, 10)}`;
    const epoch = await tdb(isoUtc(seed.ms));
    const obsEpochs = []; for (const o of obs) obsEpochs.push(await tdb(isoUtc(o.ms)));
    const targetEpochs = []; for (const t of targets) targetEpochs.push(await tdb(isoUtc(t.state.ms)));
    const mjd = Math.floor(seed.ms / DAY) + 40587;
    const base = { epoch, timeScale: 'TDB', position: seed.r, velocity: seed.v, integrator: config.hpop.integrator, forces: { ...config.hpop.forces, ...config.hpop.gps }, kernel: true };
    // The fits start two days before the issue time: Earth orientation from mjd - 3.
    const range = `${mjd - 3}_${mjd + Math.max(...config.horizonsDays) + 2}`;
    if (!eopFiles.has(range)) {
      const file = path.join(outDir, 'req', `eop_${range}.bin`);
      fs.writeFileSync(file, eopFrame(eop.records, mjd - 3, mjd + Math.max(...config.horizonsDays) + 2).payload);
      eopFiles.set(range, file);
    }
    const reqFile = path.join(outDir, 'req', `${id}.bin`);
    fs.writeFileSync(reqFile, executionFrame({ ...base, samples: [...obsEpochs, ...targetEpochs], target: targetEpochs.at(-1) }).payload);
    lines.push(`job ${id} ${block} ${mass} ${reqFile} ${eopFiles.get(range)} ${obs.length} ${targets.length}`);
    for (const o of obs) lines.push(`o ${o.r.join(' ')}`);
    lines.push(`v ${obs[0].v.join(' ')}`);
    jobs.push({ id, norad: n, svn, block, mass, T: iso(T), product: issue.product, observed: obs.length, targets: targets.map((t) => ({ h: t.h, epoch: t.state.epoch, r: t.state.r, v: t.state.v })) });
    if (hpop) {
      // E3's own request and Earth orientation, through the WASM module.
      const out = decodeExecution(await hpop.invoke('invoke', [executionFrame({ ...base, samples: targetEpochs, target: targetEpochs.at(-1) }), kernel, eopFrame(eop.records, mjd - 1, mjd + Math.max(...config.horizonsDays) + 2)]));
      wasm.push({ id, positions: out.samples.map((p) => p.position) });
    }
  }
  process.stderr.write(`\r${iso(T).slice(0, 10)} jobs ${jobs.length}`);
}
process.stderr.write('\n');
fs.writeFileSync(path.join(outDir, 'input.txt'), `${lines.join('\n')}\n`);
fs.writeFileSync(path.join(outDir, 'jobs.json'), JSON.stringify({ window: 'test', config: { hpop: config.hpop, sources: { URA: spec } }, eopSha256: eop.sha256, kernelSha256: sha256(kernelBytes), jobs }));
if (hpop) fs.writeFileSync(path.join(outDir, 'wasm.json'), JSON.stringify({ wasmSha256: hpop.provenance.wasmSha256, results: wasm }));
console.log(`${jobs.length} jobs; blocks ${JSON.stringify(jobs.reduce((m, j) => ((m[j.block] = (m[j.block] ?? 0) + 1), m), {}))}`);
await time.destroy?.();
await hpop?.destroy?.();
