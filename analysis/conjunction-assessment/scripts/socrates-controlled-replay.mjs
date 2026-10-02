#!/usr/bin/env node
// Controlled SGP4 replay against SOCRATES (ASO catalog paper section 12,
// baseline 1): the report and the exact GP input editions SOCRATES used
// (data.php returns the element sets of each pair's computation), each pair
// reassessed by this module at the reported TCA, every input and the report
// hashed.
//
//   node scripts/socrates-controlled-replay.mjs [--top 50] [--sort maxProb]
//     [--out <dir>] [--rate 2500] [--via <ssh host>]
//
// --via fetches through that host (the designated acquisition path is the
// celestrak.eth node), one curl per URL, under the same pacing and ledger.
//
// FETCH POLICY (CELESTRAK_FETCH_POLICY.md): serial, >= 2.5 s apart; never the
// same URL twice in 3 hours (ledger tests/data/.celestrak-fetch-ledger); halt
// after 30 consecutive failures. Cached responses make no request.
//
// Replay settings: SGP4 (WGS-72) on the GP records as delivered, the module's
// pair method around each reported TCA (+-10 min, 5 s coarse step, 1 ms
// tolerance), ALFANO_MAXIMUM with 5 m + 5 m radii. SOCRATES computes with
// STK/CAT; its object radii and solver settings are not published, so the
// maximum-probability comparison is a ratio, not a parity check.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultCelestrakCacheDir, fetchCachedText, writeCachedText } from './lib/celestrakFetchCache.mjs';
import { FetchPolicy, sleep } from './lib/celestrakFetchPolicy.mjs';
import { parseSocratesCsv } from './lib/socratesReplayHarness.mjs';
import { createConjunctionCommandHarness } from '../tests/lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpSource, initCqrFlatc, screeningControls } from '../tests/lib/cqr.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: o } = parseArgs({ options: {
  top: { type: 'string', default: '50' }, sort: { type: 'string', default: 'maxProb' },
  out: { type: 'string', default: path.join(root, 'tests/data/socrates-replay') },
  rate: { type: 'string', default: '2500' }, via: { type: 'string' },
} });
const rateMs = FetchPolicy.clampInterval(o.rate);
const policy = new FetchPolicy(path.join(root, 'tests/data/.celestrak-fetch-ledger'));
const cacheDir = defaultCelestrakCacheDir();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const headers = { 'user-agent': 'SDN-SOCRATES-Controlled-Replay/1.0' };

// Cached text, or one paced network fetch allowed by the ledger.
async function get(url, extension) {
  try {
    const cached = await fetchCachedText(url, { cacheDir, extension, fetchImpl: () => { throw new Error('cache miss'); } });
    return { text: cached.text, fetched: false };
  } catch { /* not cached */ }
  if (!policy.allowed(url)) throw new Error(`3-hour rule: ${url} was fetched within 3 hours and is not cached`);
  try {
    let text;
    if (o.via) {
      text = execFileSync('ssh', ['-o', 'BatchMode=yes', o.via, 'curl', '-sS', '--fail', '-m', '120', '-A', `'${headers['user-agent']}'`, `'${url}'`],
        { encoding: 'utf8', maxBuffer: 1 << 28 });
      await writeCachedText(url, text, { cacheDir, extension });
    } else {
      ({ text } = await fetchCachedText(url, { cacheDir, extension, headers, timeoutMs: 120000 }));
    }
    policy.record(url);
    policy.noteSuccess();
    await sleep(rateMs);
    return { text, fetched: true };
  } catch (error) {
    policy.noteFailure(url);
    await sleep(rateMs);
    throw error;
  }
}

const csvUrl = `https://celestrak.org/SOCRATES/sort-${o.sort === 'minRange' ? 'minRange' : 'maxProb'}.csv`;
const report = await get(csvUrl, 'csv');
const rows = parseSocratesCsv(report.text);
const top = rows.slice(0, Number(o.top));
const flatc = await initCqrFlatc();
const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
const pairs = [];
try {
  for (const row of top) {
    const url = `https://celestrak.org/SOCRATES/data.php?CATNR=${row.obj1Norad},${row.obj2Norad}&FORMAT=json`;
    const record = { socrates: row, gpUrl: url };
    try {
      const { text } = await get(url, 'json');
      record.gpSha256 = sha256(text);
      const gp = JSON.parse(text);
      const g1 = gp.find((g) => Number(g.NORAD_CAT_ID) === row.obj1Norad), g2 = gp.find((g) => Number(g.NORAD_CAT_ID) === row.obj2Norad);
      if (!g1 || !g2) throw new Error(`data.php returned ${gp.length} records without both objects`);
      record.epochs = [g1.EPOCH, g2.EPOCH];
      const request = encodeCqr(flatc, { PAIR_REQUEST: { PRIMARY: gpSource(g1), SECONDARY: gpSource(g2),
        CONTROLS: { ...screeningControls({ startJd: row.tcaJd - 600 / 86400, durationSeconds: 1200, coarseStepSec: 5,
          fineTolSec: 0.001, thresholdKm: 5 }), ALGORITHM: 'ALFANO_MAXIMUM' },
        PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME') } });
      const r = await harness.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: request }] });
      if (r.statusCode !== 0) throw new Error(`${r.errorCode}: ${r.errorMessage}`);
      const e = decodeCqr(flatc, r.outputs[0].payload).EVENT_RESULT;
      record.replay = { tcaJd: e.TCA.JULIAN_DATE, tcaIso: e.TCA.ISO8601, missM: e.MISS_DISTANCE_M, speedMS: e.RELATIVE_SPEED_M_S,
        maxProbability: e.PROBABILITY.MAXIMUM_PROBABILITY, dilutionM: e.DILUTION_THRESHOLD_M,
        dse: [e.PRIMARY_DAYS_SINCE_EPOCH, e.SECONDARY_DAYS_SINCE_EPOCH] };
      record.delta = {
        tcaS: (e.TCA.JULIAN_DATE - row.tcaJd) * 86400,
        missM: e.MISS_DISTANCE_M - row.minRangeKm * 1000,
        speedMS: e.RELATIVE_SPEED_M_S - row.relSpeedKmS * 1000,
        dseDays: [e.PRIMARY_DAYS_SINCE_EPOCH - row.obj1Dse, e.SECONDARY_DAYS_SINCE_EPOCH - row.obj2Dse],
        maxProbabilityRatio: row.maxProb > 0 && e.PROBABILITY.MAXIMUM_PROBABILITY > 0 ? e.PROBABILITY.MAXIMUM_PROBABILITY / row.maxProb : null,
      };
    } catch (error) {
      record.error = String(error.message ?? error);
    }
    pairs.push(record);
    process.stderr.write(`\r${pairs.length}/${top.length}`);
  }
} finally {
  await harness.destroy?.();
}
process.stderr.write('\n');

const ok = pairs.filter((p) => p.delta);
const stat = (values) => {
  const v = values.map(Math.abs).sort((a, b) => a - b);  // absolute values
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return v.length ? { median: q(0.5), p95: q(0.95), max: v.at(-1) } : null;
};
// Short-term encounter (the linear encounter-plane model both Pc and maximum
// probability assume) needs a fast relative pass; below 10 m/s it does not hold.
const fastPass = (p) => p.socrates.relSpeedKmS * 1000 > 10;
const group = (list) => ({ rows: list.length, pairs: new Set(list.map((p) => `${p.socrates.obj1Norad},${p.socrates.obj2Norad}`)).size,
  tcaS: stat(list.map((p) => p.delta.tcaS)), missM: stat(list.map((p) => p.delta.missM)), speedMS: stat(list.map((p) => p.delta.speedMS)),
  dseDays: stat(list.flatMap((p) => p.delta.dseDays)),
  log10MaxProbabilityRatio: stat(list.filter((p) => p.delta.maxProbabilityRatio).map((p) => Math.log10(p.delta.maxProbabilityRatio))),
  // Maximum probability scales with the combined radius squared while it is
  // far below the miss, so 10 m * sqrt(SOCRATES / ours) is the radius that
  // would reproduce SOCRATES (rows with SOCRATES maximum probability < 0.05).
  impliedCombinedRadiusM: stat(list.filter((p) => p.socrates.maxProb < 0.05 && p.replay.maxProbability > 0)
    .map((p) => 10 * Math.sqrt(p.socrates.maxProb / p.replay.maxProbability))) });
const out = {
  kind: 'socrates-controlled-replay', version: 1, createdAt: new Date().toISOString(),
  report: { url: csvUrl, sha256: sha256(report.text), rows: rows.length, fetchedNow: report.fetched, acquiredVia: o.via ?? 'direct' },
  settings: { propagator: 'SGP4 (WGS-72) on the delivered GP records', window: 'reported TCA +- 600 s', coarseStepS: 5, toleranceS: 0.001,
    probability: 'ALFANO_MAXIMUM, radii 5 m + 5 m', unavailable: 'SOCRATES object radii and STK/CAT solver settings are not published' },
  summary: { pairs: pairs.length, replayed: ok.length, errors: pairs.length - ok.length,
    tcaS: stat(ok.map((p) => p.delta.tcaS)), missM: stat(ok.map((p) => p.delta.missM)), speedMS: stat(ok.map((p) => p.delta.speedMS)),
    dseDays: stat(ok.flatMap((p) => p.delta.dseDays)),
    maxProbabilityRatio: stat(ok.filter((p) => p.delta.maxProbabilityRatio).map((p) => Math.log10(p.delta.maxProbabilityRatio))),
    fast: group(ok.filter(fastPass)), slow: group(ok.filter((p) => !fastPass(p))),
    fastNumberedBelow100000: group(ok.filter((p) => fastPass(p) && Math.max(p.socrates.obj1Norad, p.socrates.obj2Norad) < 100000)),
    fastNumbered100000Up: group(ok.filter((p) => fastPass(p) && Math.max(p.socrates.obj1Norad, p.socrates.obj2Norad) >= 100000)) },
  pairs,
};
fs.mkdirSync(o.out, { recursive: true });
const file = path.join(o.out, `socrates-replay-${out.createdAt.slice(0, 10)}.json`);
fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${file}: ${ok.length}/${pairs.length} replayed; report sha256 ${out.report.sha256}`);
console.log(JSON.stringify(out.summary, null, 1));
