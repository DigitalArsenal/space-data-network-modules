// The space weather of PLAN.md (Conditions): daily $SPW rows for a cutoff.
//   GFZ   the file Kp_ap_Ap_SN_F107 since 1932 of the local archive (CC BY 4.0, Matzka et al. 2021; retrieved
//         2026-10-09, Kp definitive through the period and E13's own source): per day the observed F10.7 (DRAO
//         Penticton), the daily Ap, the eight Kp and the definitive flag.
//   RSGA  NOAA SWPC's Report and Forecast of Solar and Geophysical Activity: its Issued time, the observed F10.7 of
//         its day and the predicted F10.7 of the next three; the observed Ap of the day before, the estimated Ap of
//         its day and the predicted Ap of the next three.
// Condition O at a cutoff takes the most recent RSGA issued at or before the cutoff (ruling 19); condition M the
// observed values through the horizon. Data preparation only: dates, values and means.
import fs from 'node:fs';
import path from 'node:path';
import { config, dateOf, DAY, HOUR, sha256 } from '../common.mjs';

const W = config.spaceWeather;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// ---- GFZ --------------------------------------------------------------------------------------------------------------
function parseGfz(text, into) {
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const t = line.trim().split(/\s+/);
    if (t.length < 28) continue;
    const date = `${t[0]}-${t[1].padStart(2, '0')}-${t[2].padStart(2, '0')}`;
    const kp = t.slice(7, 15).map(Number), ap = Number(t[23]), f107 = Number(t[25]), flag = Number(t[27]);
    const day = into.get(date) ?? {};
    if (Number.isFinite(ap) && ap >= 0) day.ap = ap;
    if (Number.isFinite(f107) && f107 > 0) day.f107 = f107;
    if (kp.every((k) => Number.isFinite(k) && k >= 0)) day.kp = kp;
    if (Number.isFinite(flag)) day.definitive = flag >= 1;
    into.set(date, day);
  }
}
let gfzCache = null;
/** The days (Map date -> { f107, ap, kp[8], definitive }) of the history file, with its SHA-256. */
export function gfzDays() {
  if (gfzCache) return gfzCache;
  const text = fs.readFileSync(W.gfzHistory, 'utf8');
  const days = new Map();
  parseGfz(text, days);
  gfzCache = { days, provenance: [{ file: W.gfzHistory, sha256: sha256(Buffer.from(text)) }] };
  return gfzCache;
}

/** A storm day (screening sensitivity): Ap >= 50 or any of its eight Kp >= 6. */
export function stormDay(date) {
  const d = gfzDays().days.get(date);
  return !!d && ((d.ap ?? 0) >= 50 || (d.kp ?? []).some((k) => k >= 6 - 1e-9));
}

// ---- RSGA -------------------------------------------------------------------------------------------------------------
/** A day "DD Mon" of an RSGA issued at `issuedMs`: the year that puts it nearest the issue. */
function dayOf(dd, mon, issuedMs) {
  const y = new Date(issuedMs).getUTCFullYear();
  const options = [y - 1, y, y + 1].map((year) => Date.UTC(year, MONTHS[mon], Number(dd)));
  return options.reduce((best, t) => (Math.abs(t - issuedMs) < Math.abs(best - issuedMs) ? t : best));
}
/** One RSGA text: { issuedMs, f107: { observed: {day, value}, predicted: [{day, value}] }, ap: { observed, estimated, predicted } }, or null. */
export function parseRsga(text) {
  const issued = /^:Issued:\s+(\d{4}) (\w{3}) (\d{2}) (\d{2})(\d{2}) UTC/m.exec(text);
  if (!issued) return null;
  const issuedMs = Date.UTC(Number(issued[1]), MONTHS[issued[2]], Number(issued[3]), Number(issued[4]), Number(issued[5]));
  const fObs = /^Observed\s+(\d{2}) (\w{3})\s+(\d+)\s*$/m.exec(text);
  const fPre = /^Predicted\s+(\d{2}) (\w{3})-(\d{2}) (\w{3})\s+(\d+)\/(\d+)\/(\d+)\s*$/m.exec(text);
  const aObs = /^Observed Afr\/Ap\s+(\d{2}) (\w{3})\s+(\d+)\/(\d+)\s*$/m.exec(text);
  const aEst = /^Estimated Afr\/Ap\s+(\d{2}) (\w{3})\s+(\d+)\/(\d+)\s*$/m.exec(text);
  const aPre = /^Predicted Afr\/Ap\s+(\d{2}) (\w{3})-(\d{2}) (\w{3})\s+(\d+)\/(\d+)-(\d+)\/(\d+)-(\d+)\/(\d+)\s*$/m.exec(text);
  if (!fObs || !fPre || !aObs || !aEst || !aPre) return null;
  const f0 = dayOf(fPre[1], fPre[2], issuedMs), a0 = dayOf(aPre[1], aPre[2], issuedMs);
  return {
    issuedMs,
    f107: { observed: { day: dayOf(fObs[1], fObs[2], issuedMs), value: Number(fObs[3]) }, predicted: [5, 6, 7].map((k, i) => ({ day: f0 + i * DAY, value: Number(fPre[k]) })) },
    ap: {
      observed: { day: dayOf(aObs[1], aObs[2], issuedMs), value: Number(aObs[4]) },
      estimated: { day: dayOf(aEst[1], aEst[2], issuedMs), value: Number(aEst[4]) },
      predicted: [6, 8, 10].map((k, i) => ({ day: a0 + i * DAY, value: Number(aPre[k]) })),
    },
  };
}
let rsgaCache = null;
/** Every RSGA of the archive, newest issue last: [{ file, sha256, ...parseRsga }] (a file that does not parse is counted). */
export function rsgas() {
  if (rsgaCache) return rsgaCache;
  const byName = new Map();
  for (const dir of W.rsgaDirs) {
    if (!fs.existsSync(dir)) continue;
    const visit = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) visit(path.join(d, e.name));
      else if (/^\d{8}RSGA\.txt$/.test(e.name) && !byName.has(e.name)) byName.set(e.name, path.join(d, e.name));
    } };
    visit(dir);
  }
  const list = [], unparsed = [];
  for (const [name, file] of [...byName].sort()) {
    const bytes = fs.readFileSync(file);
    const r = parseRsga(bytes.toString('utf8'));
    if (r) list.push({ name, file, sha256: sha256(bytes), ...r });
    else unparsed.push(name);
  }
  list.sort((a, b) => a.issuedMs - b.issuedMs);
  rsgaCache = { list, unparsed };
  return rsgaCache;
}
/** The most recent RSGA issued at or before `cutoffMs` and within the registered maximum age, or null. */
export function rsgaAt(cutoffMs) {
  const { list } = rsgas();
  let best = null;
  for (const r of list) if (r.issuedMs <= cutoffMs) best = r;
  return best && cutoffMs - best.issuedMs <= W.rsgaMaximumAgeHours * HOUR ? best : null;
}

// ---- rows -------------------------------------------------------------------------------------------------------------
/** The 81-day centered mean of the observed flux of day t (GFZ), over the days with a value. */
function center81(days, t) {
  let sum = 0, n = 0;
  for (let k = -W.center81Days; k <= W.center81Days; k += 1) {
    const v = days.get(dateOf(t + k * DAY))?.f107;
    if (Number.isFinite(v)) { sum += v; n += 1; }
  }
  return n ? sum / n : null;
}

/** Condition M: the rows of the UTC days [fromMs, toMs]: observed F10.7, definitive Ap, the true centered mean. */
export function rowsM(fromMs, toMs) {
  const { days } = gfzDays();
  const rows = [];
  for (let t = Date.parse(`${dateOf(fromMs)}T00:00:00Z`); t <= toMs; t += DAY) {
    const d = days.get(dateOf(t));
    if (!d || !Number.isFinite(d.f107) || !Number.isFinite(d.ap)) continue;
    const c81 = center81(days, t);
    if (!(c81 > 0)) continue;
    rows.push({ date: dateOf(t), f107: d.f107, c81, ap: Math.round(d.ap) });
  }
  return { rows };
}

/** Condition O at a cutoff on UTC day D0 (cutoffMs its 00:00, or ISS's E: the inputs of a 00:00 cutoff on E's day): the
 *  rows of [fromMs, D0 + 2] built from the most recent RSGA issued at or before D0 00:00 (PLAN.md, ruling 19), or
 *  { excluded } when none was issued in the 72 h before. */
export function rowsO(fromMs, cutoffMs) {
  const { days } = gfzDays();
  const D0 = Date.parse(`${dateOf(cutoffMs)}T00:00:00Z`);
  const R = rsgaAt(D0);
  if (!R) return { excluded: 'no RSGA issued in the 72 h before the cutoff' };
  // F10.7 of a day: <= D0-2 DRAO (GFZ); the RSGA's observed day takes its Observed line, its predicted days their values,
  // later days hold the last predicted value
  const f107Of = (t) => {
    if (t <= D0 - 2 * DAY) return { value: days.get(dateOf(t))?.f107, role: 'GFZ observed' };
    if (t === R.f107.observed.day) return { value: R.f107.observed.value, role: 'RSGA observed' };
    const p = R.f107.predicted.find((x) => x.day === t);
    if (p) return { value: p.value, role: 'RSGA predicted' };
    if (t > R.f107.predicted.at(-1).day) return { value: R.f107.predicted.at(-1).value, role: 'RSGA predicted (held)' };
    return { value: days.get(dateOf(t))?.f107, role: 'GFZ observed' };
  };
  // Ap of a day: <= D0-3 GFZ definitive; then the RSGA's observed, estimated or predicted day; later days hold the last
  const apOf = (t) => {
    if (t <= D0 - 3 * DAY) return { value: days.get(dateOf(t))?.ap, role: 'GFZ definitive' };
    if (t === R.ap.observed.day) return { value: R.ap.observed.value, role: 'RSGA observed' };
    if (t === R.ap.estimated.day) return { value: R.ap.estimated.value, role: 'RSGA estimated' };
    const p = R.ap.predicted.find((x) => x.day === t);
    if (p) return { value: p.value, role: 'RSGA predicted' };
    if (t > R.ap.predicted.at(-1).day) return { value: R.ap.predicted.at(-1).value, role: 'RSGA predicted (held)' };
    return { value: days.get(dateOf(t))?.ap, role: 'GFZ definitive' };
  };
  // the trailing 81-day mean of the observed F10.7 ending on the last day observed by the cutoff, every row: the rows'
  // own observed values (DRAO through D0-2, the RSGA's Observed line for D0-1 when it is D0-1's)
  const lastObserved = R.f107.observed.day === D0 - DAY ? D0 - DAY : D0 - 2 * DAY;
  let sum = 0, n = 0;
  for (let k = 0; k < 81; k += 1) {
    const t = lastObserved - k * DAY;
    const v = t === D0 - DAY ? R.f107.observed.value : days.get(dateOf(t))?.f107;
    if (Number.isFinite(v) && v > 0) { sum += v; n += 1; }
  }
  const c81 = n ? sum / n : null;
  const rows = [], roles = [];
  for (let t = Date.parse(`${dateOf(fromMs)}T00:00:00Z`); t <= D0 + 2 * DAY; t += DAY) {
    const f = f107Of(t), a = apOf(t);
    if (!(f.value > 0) || !Number.isFinite(a.value) || !(c81 > 0)) continue;
    rows.push({ date: dateOf(t), f107: f.value, c81, ap: Math.round(a.value) });
    roles.push({ date: dateOf(t), f107: f.role, ap: a.role });
  }
  return { rows, roles, rsga: { name: R.name, issued: new Date(R.issuedMs).toISOString(), sha256: R.sha256 }, c81, lastObserved: dateOf(lastObserved) };
}
