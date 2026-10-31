// XM7's independent reference, input preparation: GFZ's definitive rows for 2025-12-01..2026-02-28 in the layout of the CSSI file Orekit reads (the layout of
// propagator/ffm/tests/fixtures/orekit/make-synthetic-weather.mjs), and the data directory: orekit-data with that file in place of its CSSI directory.
// Data preparation only; everything stays local (scratchpad).
import fs from 'node:fs';
import path from 'node:path';

const [out, gfzFile, orekitData] = process.argv.slice(2);
const days = new Map();
for (const line of fs.readFileSync(gfzFile, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const t = line.trim().split(/\s+/);
  if (t.length < 28) continue;
  days.set(`${t[0]}-${t[1].padStart(2, '0')}-${t[2].padStart(2, '0')}`, { bsr: Number(t[5]), db: Number(t[6]), kp: t.slice(7, 15).map(Number), ap: t.slice(15, 23).map(Number), Ap: Number(t[23]), sn: Number(t[24]), fobs: Number(t[25]), fadj: Number(t[26]) });
}
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const flux = (t, k) => days.get(iso(t))?.[k];
const mean = (t, k, a, b) => { let s = 0, n = 0; for (let i = a; i <= b; i += 1) { const v = flux(t + i * DAY, k); if (v > 0) { s += v; n += 1; } } return s / n; };
const fmt = (v, w) => String(v).padStart(w);
const f1 = (v, w) => v.toFixed(1).padStart(w);
const rows = [];
for (let t = Date.parse('2025-12-01T00:00:00Z'); t <= Date.parse('2026-02-28T00:00:00Z'); t += DAY) {
  const d = days.get(iso(t));
  if (!(d?.fobs > 0)) throw new Error(`no F10.7 on ${iso(t)}`);
  const y = new Date(t);
  const kp10 = d.kp.map((v) => Math.round(v * 10));
  rows.push(`${fmt(y.getUTCFullYear(), 4)} ${String(y.getUTCMonth() + 1).padStart(2, '0')} ${String(y.getUTCDate()).padStart(2, '0')} ${fmt(d.bsr, 4)} ${fmt(d.db, 2)} ${kp10.map((v) => fmt(v, 2)).join(' ')} ${fmt(kp10.reduce((a, b) => a + b, 0), 3)} ${d.ap.map((v) => fmt(v, 3)).join(' ')} ${fmt(d.Ap, 3)} 0.0 0 ${fmt(Math.max(0, d.sn), 3)} ${f1(d.fadj, 5)} 0 ${f1(mean(t, 'fadj', -40, 40), 5)} ${f1(mean(t, 'fadj', -80, 0), 5)} ${f1(d.fobs, 5)} ${f1(mean(t, 'fobs', -40, 40), 5)} ${f1(mean(t, 'fobs', -80, 0), 5)}`);
}
// The last rows as predictions, as make-synthetic-weather.mjs writes them.
const observed = rows.slice(0, -3), predicted = rows.slice(-3);
fs.mkdirSync(out, { recursive: true });
for (const e of fs.readdirSync(orekitData)) {
  if (e === 'CSSI-Space-Weather-Data' || e.startsWith('_') || e.endsWith('.md') || e.endsWith('.sh') || e.endsWith('.toml')) continue;
  const link = path.join(out, e);
  if (!fs.existsSync(link)) fs.symlinkSync(path.join(orekitData, e), link);
}
fs.mkdirSync(path.join(out, 'CSSI-Space-Weather-Data'), { recursive: true });
fs.writeFileSync(path.join(out, 'CSSI-Space-Weather-Data/SpaceWeather-All-v1.2.txt'), [
  'DATATYPE CssiSpaceWeather', 'VERSION 1.2 ', 'UPDATED 2026 Oct 09 00:00:00.00',
  '# GFZ Kp, ap, Ap, F10.7 (CC BY 4.0, Matzka et al. 2021) in the layout of the CSSI Space Weather file, not CSSI/CelesTrak data. Local test input.',
  '# FORMAT(I4,I3,I3,I5,I3,8I3,I4,8I4,I4,F4.1,I2,I4,F6.1,I2,5F6.1)',
  '# yy mm dd BSRN ND Kp Kp Kp Kp Kp Kp Kp Kp Sum Ap  Ap  Ap  Ap  Ap  Ap  Ap  Ap  Avg Cp C9 ISN F10.7 Q Ctr81 Lst81 F10.7 Ctr81 Lst81',
  `NUM_OBSERVED_POINTS ${observed.length}`, 'BEGIN OBSERVED', ...observed, 'END OBSERVED', '',
  `NUM_DAILY_PREDICTED_POINTS ${predicted.length}`, 'BEGIN DAILY_PREDICTED', ...predicted, 'END DAILY_PREDICTED', '',
  'NUM_MONTHLY_PREDICTED_POINTS 0', 'BEGIN MONTHLY_PREDICTED', 'END MONTHLY_PREDICTED', '',
  'NUM_MONTHLY_FIT_POINTS 0', 'BEGIN MONTHLY_FIT', 'END MONTHLY_FIT', ''].join('\n'));
console.log(`wrote ${rows.length} days to ${out}`);
