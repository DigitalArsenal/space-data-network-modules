// ISS reboost study: the module against NASA's executed-burn truth.
//
//   python3 study/nasa_iss_truth.py <work>
//   python3 study/gp_history.py <sdn-archive> 25544 2021-01-01 <work>/gp.json
//   node study/iss_reboost_study.mjs <work> [--python <python3 with sgp4 + numpy>] [--from 2021-03] [--to 2026-10]
//
// Month by month (with a 5-day margin each side), the element-set history is
// propagated by gp_trajectories.py, packed as one $OEM (TEME, 60 s) and run
// through the built module with default options. An event matches a burn when
// it falls between 3 h before and 36 h after the TIG (GP element sets lag a
// burn). Writes <work>/study-results.json and prints the summary.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const work = args[0];
const flag = (name, fallback) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : fallback; };
const python = flag('--python', 'python3');
const from = flag('--from', '2021-03');
const to = flag('--to', '2026-10');
const options = JSON.parse(flag('--options', '{}'));

const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const OEM = await import(pathToFileURL(path.join(root, 'lib/js/OEM/main.js')));
const MNV = await import(pathToFileURL(path.join(root, 'lib/js/MNV/main.js')));
const wasm = fs.readFileSync(path.join(here, '../dist/isomorphic/module.wasm'));
const manifest = JSON.parse(fs.readFileSync(path.join(here, '../plugin-manifest.json')));
const truth = JSON.parse(fs.readFileSync(path.join(work, 'iss-truth.json')));
const iso = (s) => new Date(Math.round(s * 1000)).toISOString();
const sec = (text) => Date.parse(text.endsWith('Z') ? text : `${text}Z`) / 1000;

function teme() {
  const w = new OEM.CelestialFrameWrapperT();
  w.frame = OEM.CelestialFrame.TEMEOFDATE;
  const f = new OEM.RFMT();
  f.REFERENCE_FRAME_type = OEM.RFMUnion.CelestialFrameWrapper;
  f.REFERENCE_FRAME = w;
  return f;
}
function pack(meta, states) {
  const blocks = [];
  let row = 0;
  for (const s of meta.sets) {
    const b = new OEM.ephemerisDataBlockT();
    const object = new OEM.CATT();
    object.NORAD_CAT_ID = s.norad;
    object.OBJECT_ID = s.object_id;
    b.OBJECT = object;
    b.COMMENT = s.comment;
    b.CENTER_NAME = 'EARTH';
    b.REFERENCE_FRAME = teme();
    b.TIME_SYSTEM = OEM.timingStandard.UTC;
    b.START_TIME = iso(s.start);
    b.STEP_SIZE = meta.step;
    b.EPHEMERIS_DATA = Array.from(states.subarray(row * 6, (row + s.count) * 6));
    row += s.count;
    blocks.push(b);
  }
  const m = new OEM.OEMT();
  m.CREATION_DATE = new Date().toISOString();
  m.EPHEMERIS_DATA_BLOCK = blocks;
  const builder = new flatbuffers.Builder(1 << 24);
  OEM.OEM.finishOEMBuffer(builder, m.pack(builder));
  return builder.asUint8Array();
}

const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
const events = [];
const scratch = path.join(work, 'chunk');
for (let month = new Date(`${from}-01T00:00:00Z`); month < new Date(`${to}-01T00:00:00Z`); month.setUTCMonth(month.getUTCMonth() + 1)) {
  const next = new Date(month); next.setUTCMonth(next.getUTCMonth() + 1);
  const lo = iso(month.getTime() / 1000 - 5 * 86400).slice(0, 19), hi = iso(next.getTime() / 1000 + 5 * 86400).slice(0, 19);
  execFileSync(python, [path.join(here, 'gp_trajectories.py'), path.join(work, 'gp.json'), lo, hi, '60', scratch]);
  const meta = JSON.parse(fs.readFileSync(`${scratch}.json`));
  const buf = fs.readFileSync(`${scratch}.bin`);
  const states = new Float64Array(buf.buffer, buf.byteOffset, buf.length / 8);
  const inputs = [{ portId: 'ephemerides', payload: Buffer.from(pack(meta, states)), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } }];
  if (Object.keys(options).length) inputs.push({ portId: 'options', payload: Buffer.from(JSON.stringify(options)) });
  const result = await harness.invoke({ methodId: 'detect_maneuvers', inputs });
  if (result.statusCode !== 0) throw new Error(`${month.toISOString().slice(0, 7)}: ${result.errorMessage}`);
  for (const f of result.outputs.filter((o) => o.portId === 'maneuvers')) {
    const e = MNV.MNV.getRootAsMNV(new flatbuffers.ByteBuffer(new Uint8Array(f.payload))).unpack();
    const t = sec(e.EVENT_START_TIME);
    if (t >= month.getTime() / 1000 && t < next.getTime() / 1000) events.push(e);
  }
  process.stderr.write(`${month.toISOString().slice(0, 7)}: ${meta.sets.length} sets, ${events.length} events so far\n`);
}
harness.destroy();

const lo = sec(`${from}-01T00:00:00`), hi = sec(`${to}-01T00:00:00`);
const burns = truth.burns.filter((b) => b.executed && sec(b.tig) >= lo && sec(b.tig) < hi);
const used = new Set();
const matches = [];
for (const b of burns) {
  const tig = sec(b.tig);
  let best = -1;
  events.forEach((e, k) => {
    const d = sec(e.EVENT_START_TIME) - tig;
    if (!used.has(k) && d > -3 * 3600 && d < 36 * 3600 && (best < 0 || Math.abs(d) < Math.abs(sec(events[best].EVENT_START_TIME) - tig))) best = k;
  });
  if (best < 0) { matches.push({ tig: b.tig, dv_mps: b.dv_mps, nasa_da_km: b.nasa_actual_da_km, detected: false }); continue; }
  used.add(best);
  const e = events[best];
  matches.push({ tig: b.tig, dv_mps: b.dv_mps, nasa_da_km: b.nasa_actual_da_km, detected: true, event_time: e.EVENT_START_TIME,
    time_error_min: (sec(e.EVENT_START_TIME) - tig) / 60, gp_da_km: e.POST_EVENT.SMA - e.PRE_EVENT.SMA,
    in_track_mps: e.DELTA_VEL_U * 1000, characterization: MNV.maneuverCharacterization[e.CHARACTERIZATION] });
}
const coverage = truth.coverage.map(([c, s]) => [sec(c), sec(s)]);
const listed = truth.listed_events.map(sec);
const unmatched = events.filter((_, k) => !used.has(k)).map((e) => {
  const t = sec(e.EVENT_START_TIME);
  const planned = coverage.some(([c, s]) => c <= t && t <= s && t - c <= 86400);
  return { time: e.EVENT_START_TIME, in_track_mps: e.DELTA_VEL_U * 1000, cross_track_mps: e.DELTA_VEL_V * 1000,
    nasa_plan_issued_within_1d: planned, nasa_event_within_1_5d: listed.some((x) => Math.abs(x - t) < 1.5 * 86400) };
});
const hits = matches.filter((m) => m.detected);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const summary = {
  window: [from, to], options, events: events.length, executed_burns: burns.length, detected: hits.length,
  recall: hits.length / burns.length,
  time_error_abs_min: { median: q(hits.map((m) => Math.abs(m.time_error_min)), 0.5), p90: q(hits.map((m) => Math.abs(m.time_error_min)), 0.9) },
  da_ratio_gp_over_nasa: { median: q(hits.map((m) => m.gp_da_km / m.nasa_da_km), 0.5),
    p10: q(hits.map((m) => m.gp_da_km / m.nasa_da_km), 0.1), p90: q(hits.map((m) => m.gp_da_km / m.nasa_da_km), 0.9) },
  unmatched_events: unmatched.length,
  unmatched_with_fresh_nasa_plan_and_no_listed_event: unmatched.filter((u) => u.nasa_plan_issued_within_1d && !u.nasa_event_within_1_5d).length,
};
fs.writeFileSync(path.join(work, 'study-results.json'), `${JSON.stringify({ summary, matches, unmatched }, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
