// Starlink study (PLAN-2026-10, descriptive, the live window): SpaceX's public
// MEME ephemerides as operator truth, read in memory and dropped.
//
//   node study/starlink.mjs <work> --gp-dir <dir of gp/<norad>.json> --variants <variants.json> --sample 20
//        [--registry /opt/data/sdn-archive/operator-ephemerides/derived-supgp/registry]
//
// Versions: every file name the saved manifests and the current manifest list
// for each satellite (superseded files stay downloadable by name for about a
// day), fetched at least 5 s apart and read by data-source/spacex-starlink-
// source (WASM). compare_ephemerides gives, between consecutive versions, the
// newer orbit determination against the older forecast (executed minus
// planned), and, within each version, the change of orbit-averaged SMA from
// one revolution to the next (a rise is thrust: drag only lowers it).
import fs from 'node:fs';
import path from 'node:path';
import { loadModule, config, TYPES, iso, seconds, outputsOf, reportFrom, OEM, flatbuffers, MODULES } from './lib/host.mjs';
import { detectHistories, scoreVariants, writeJson, log } from './lib/run.mjs';

const [work, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
fs.mkdirSync(work, { recursive: true });
const BASE = 'https://api.starlink.com/public-files/ephemerides/';
const registry = flag('registry', '/opt/data/sdn-archive/operator-ephemerides/derived-supgp/registry');
const { loadMemeReader } = await import('./lib/meme.mjs');
const reader = await loadMemeReader();
const sample = JSON.parse(fs.readFileSync('/opt/data/sdn-archive/e14-covariance-realism/starlink-sample.json', 'utf8')).norads
  .filter((n) => fs.existsSync(path.join(flag('gp-dir'), `${n}.json`))).slice(0, Number(flag('sample', 20)));

let last = 0;
async function polite(url) {
  const wait = last + 5000 - Date.now();
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  last = Date.now();
  const r = await fetch(url);
  return { status: r.status, body: r.ok ? Buffer.from(await r.arrayBuffer()) : null };
}

// Names per NORAD from the saved manifests and the current one.
const names = new Map();
const addNames = (text) => { for (const n of text.split(/\s+/).filter((x) => /^MEME_\d+_/.test(x))) { const k = Number(n.split('_')[1]); if (!names.has(k)) names.set(k, new Set()); names.get(k).add(n); } };
for (const f of fs.readdirSync(registry).filter((f) => /^starlink-names-.*\.txt$/.test(f))) addNames(fs.readFileSync(path.join(registry, f), 'utf8'));
const manifest = await polite(`${BASE}MANIFEST.txt`);
if (manifest.body) addNames(manifest.body.toString('utf8'));

const compare = await loadModule('analysis/maneuver-detection');
const satellites = [];
for (const norad of sample) {
  const list = [...(names.get(norad) ?? [])].sort((a, b) => Number(a.split('_')[5]) - Number(b.split('_')[5]));
  const versions = [];
  for (const name of list) {
    const r = await polite(BASE + name);
    if (!r.body) continue;
    const bytes = await reader.read(name, r.body);
    if (!bytes) continue;
    const raw = new Uint8Array(bytes);
    const prefixed = raw.length >= 12 && Buffer.from(raw.subarray(8, 12)).toString('latin1') === '$OEM';
    const oem = (prefixed ? OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(raw)) : OEM.OEM.getRootAsOEM(new flatbuffers.ByteBuffer(raw))).unpack();
    const block = oem.EPHEMERIS_DATA_BLOCK[0];
    // The file's first state is its orbit determination; it stands as the issue time.
    oem.CREATION_DATE = block.START_TIME;
    const b = new flatbuffers.Builder(1 << 20);
    OEM.OEM.finishOEMBuffer(b, oem.pack(b));
    versions.push({ name, start: seconds(block.START_TIME), bytes: b.asUint8Array() });
  }
  if (versions.length < 2) { log(`${norad}: ${versions.length} version(s)`); continue; }
  const res = await compare.invoke('compare_ephemerides', [...versions.map((v) => ({ portId: 'versions', payload: v.bytes, typeRef: TYPES.OEM })),
    config({ within_version: true, unplanned_threshold_km: 0 })]);
  const report = (await reportFrom(res)).objects[0];
  const changes = report.changes.filter((c) => c.mode === 'overlap').map((c) => ({ window: c.window, in_track_mps: c.in_track_mps, delta_sma_km: c.delta_sma_km }));
  // Within each version, its first 8 h (its own orbit determination's reach).
  const rises = [], falls = [];
  for (const c of report.changes.filter((x) => x.within)) {
    const v = versions.find((x) => c.within.includes(iso(x.start)));
    if (!v || seconds(c.window[0]) > v.start + 8 * 3600) continue;
    (c.delta_sma_km > 0 ? rises : falls).push(c.delta_sma_km * 1000);
  }
  satellites.push({ norad, versions: versions.map((v) => ({ start: iso(v.start) })), changes, revolutions: rises.length + falls.length,
    rising: rises.length, rise_m: rises, fall_m: falls });
  log(`${norad}: ${versions.length} versions, version changes ${changes.map((c) => c.in_track_mps.toFixed(3)).join(' ')} m/s; revolutions rising ${rises.length}/${rises.length + falls.length}`);
}
await compare.destroy();

// GP side over 2026-09-01 to the present for the same satellites.
const variants = JSON.parse(fs.readFileSync(flag('variants'), 'utf8'));
const to = iso(Date.now() / 1000).slice(0, 10);
const histories = satellites.map((s) => ({ history: path.join(flag('gp-dir'), `${s.norad}.json`), from: '2026-09-01', to }));
const { sets, events } = await detectHistories(histories, variants, { workers: 6, marginSets: 10 });
const years = histories.length * (seconds(`${to}T00:00:00`) - seconds('2026-09-01T00:00:00')) / (365.25 * 86400);
const rates = Object.fromEntries(Object.entries(events).map(([k, v]) => [k, { events: v.length, per_object_year: v.length / years }]));
log(`GP events per object-year over ${histories.length} satellites from 2026-09-01: ${Object.entries(rates).map(([k, r]) => `${k} ${r.per_object_year.toFixed(1)}`).join(', ')}`);
writeJson(work, 'starlink.json', { satellites, sets, rates, events });
