// The truth ingest gate (task experiments-truth-ingest-gate-20261025): every truth reader passes the states it read through gate() before any
// experiment scores against them. gate() drops (and records) a state that experiments/truth-gate/flags.json lists for its product and object,
// and any state that fails the inline sanity rule (a position coordinate exactly zero, or a position inside the central body). flags.json is
// written by experiments/truth-gate/scan.mjs, which applies the full rules to every truth set on the machine:
//   - where analysis centers publish the same product: the combination's state more than RULES.centerWrongKm from the centers' median while
//     the centers agree within RULES.centerAgreeKm (found by the Etalon-2 X = 0 fault, experiments/etalon2-anomaly);
//   - elsewhere: the sanity rule, and a jump: a state whose position-velocity consistency with both neighbors (the trapezoid residual
//     |r1 - r0 - (v0 + v1) dt / 2|, or the second difference of equally spaced positions without velocities) exceeds max(RULES.screenFloorKm, RULES.screenFactor x the series' median), confirmed when the full force
//     model carried from the previous good state misses it by more than RULES.jumpKm.
// Readers that hand truth to the modules as $OEM frames call gateOemFrame(), which re-encodes a frame without its dropped states (and returns
// the bytes unchanged when nothing drops). The experiments that study the faults themselves (experiments/etalon2-anomaly, the scan) read raw.
// Reading and counting only; the confirmation's propagation is propagator/ffm's.
import fs from 'node:fs';
import path from 'node:path';
import * as flatbuffers from 'flatbuffers';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/main.js';
import { decodeOemStream } from './records.mjs';

export const RULES = Object.freeze({ centerWrongKm: 1, centerAgreeKm: 0.01, screenFloorKm: 10, screenFactor: 10, jumpKm: 1, maximumGapSeconds: 1200 });
export const BODY_RADIUS_KM = Object.freeze({ EARTH: 6356.752, MOON: 1737.4, SUN: 695700, MARS: 3389.5, JUPITER: 66854 });
const LEDGER = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../experiments/truth-gate/flags.json');
let ledger = null;
const key = (product, norad, ms) => `${product}|${norad}|${ms}`;
function loadLedger() {
  if (ledger) return ledger;
  ledger = new Map();
  if (fs.existsSync(LEDGER)) for (const f of JSON.parse(fs.readFileSync(LEDGER, 'utf8')).flags ?? []) if (f.action === 'drop') ledger.set(key(f.product, f.norad, Date.parse(f.epoch)), f);
  return ledger;
}
export const ledgerEntries = () => [...loadLedger().values()];

/** The sanity rule on one position (km) about `center`: a reason, or null. */
export function sanity(r, center = 'EARTH') {
  if (r.some((x) => x === 0)) return `position coordinate ${['X', 'Y', 'Z'].filter((_, k) => r[k] === 0).join(', ')} exactly zero`;
  if (!r.every(Number.isFinite)) return 'position not finite';
  const radius = Math.hypot(...r);
  if (radius < (BODY_RADIUS_KM[center] ?? 0)) return `position ${radius.toFixed(1)} km from the center, inside ${center.toLowerCase()}`;
  return null;
}

/**
 * The gate a truth reader calls on the states it read: lines of one object of one product, each with an epoch and a position (km). Returns
 * the kept lines and the dropped ones with their reasons; `onDrop` (optional) receives each drop, for the reader's own record.
 */
export function gate(lines, { product, norad, center = 'EARTH', epochOf = (l) => Date.parse(/Z$/.test(l.epoch ?? l.EPOCH) ? (l.epoch ?? l.EPOCH) : `${l.epoch ?? l.EPOCH}Z`), positionOf = (l) => l.r ?? [l.X, l.Y, l.Z], onDrop } = {}) {
  const flags = loadLedger(), kept = [], dropped = [];
  for (const l of lines) {
    const t = epochOf(l), listed = flags.get(key(product, norad, t)), reason = listed ? `${listed.rule}: ${listed.reason}` : sanity(positionOf(l), center);
    if (reason) { const d = { product, norad, epoch: new Date(t).toISOString(), reason }; dropped.push(d); onDrop?.(d); } else kept.push(l);
  }
  return { kept, dropped };
}

/** The screen of the jump rule over one series ([{ ms, r, v }] km and km/s, sorted): the indices of candidate states and the threshold used. */
export function screen(series) {
  const res = new Float64Array(series.length).fill(NaN);
  const withVelocity = series.every((x) => x.v && x.v.some((c) => c !== 0));
  for (let i = 1; i < series.length; i += 1) {
    const a = series[i - 1], b = series[i], dt = (b.ms - a.ms) / 1000;
    if (!(dt > 0) || dt > RULES.maximumGapSeconds) continue;
    if (withVelocity) res[i] = Math.hypot(...[0, 1, 2].map((k) => b.r[k] - a.r[k] - ((a.v[k] + b.v[k]) / 2) * dt));
    else if (i + 1 < series.length && Math.abs((series[i + 1].ms - b.ms) / 1000 - dt) < 1e-3) {
      // positions only, equal spacing: the second difference about the later state, placed so a wrong state spoils the two it enters
      const c = series[i + 1];
      res[i] = Math.hypot(...[0, 1, 2].map((k) => c.r[k] - 2 * b.r[k] + a.r[k]));
    }
  }
  const finite = [...res].filter(Number.isFinite).sort((x, y) => x - y);
  if (!finite.length) return { candidates: [], thresholdKm: null, medianKm: null };
  const median = finite[Math.floor(finite.length / 2)], threshold = Math.max(RULES.screenFloorKm, RULES.screenFactor * median);
  const candidates = [];
  for (let i = 0; i < series.length; i += 1) {
    const before = res[i], after = i + 1 < series.length ? res[i + 1] : NaN;
    const high = (x) => Number.isFinite(x) && x > threshold;
    // a wrong state spoils both residuals it enters; at the ends of a series (or of a gap) one residual is all there is
    if ((high(before) && (high(after) || !Number.isFinite(after))) || (!Number.isFinite(before) && high(after))) candidates.push(i);
  }
  return { candidates, thresholdKm: threshold, medianKm: median };
}

/**
 * The gate on a stream of size-prefixed $OEM records of one product (the converted reference states' files): every block's lines through
 * gate() under the block's NORAD id. The bytes come back unchanged when nothing drops; otherwise each record is re-encoded without its dropped
 * lines (START_TIME and STOP_TIME follow the kept lines). Returns { bytes, dropped }.
 */
export function gateOemFrame(bytes, { product, center = 'EARTH', onDrop } = {}) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const records = decodeOemStream(u), dropped = [];
  for (const oem of records) for (const block of oem.EPHEMERIS_DATA_BLOCK ?? []) {
    const r = gate(block.EPHEMERIS_DATA_LINES ?? [], { product, norad: block.OBJECT?.NORAD_CAT_ID ?? 0, center, onDrop });
    if (r.dropped.length) { dropped.push(...r.dropped); block.EPHEMERIS_DATA_LINES = r.kept; if (r.kept.length) { block.START_TIME = r.kept[0].EPOCH; block.STOP_TIME = r.kept.at(-1).EPOCH; } }
  }
  if (!dropped.length) return { bytes, dropped };
  const parts = records.map((oem) => { const b = new flatbuffers.Builder(1 << 16); b.finishSizePrefixed(oem.pack(b), '$OEM'); return b.asUint8Array().slice(); });
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return { bytes: Buffer.isBuffer(bytes) ? Buffer.from(out) : out, dropped };
}
