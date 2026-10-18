// SVG figures of the E2E's series, laid out like OEL's (history panels with
// the maneuver brackets shaded; I-R, I-C and C-R projections colored by
// time; the coast with its 1-sigma band). Plotting only: every number comes
// from the module's records.
import fs from 'node:fs';
import path from 'node:path';

const W = 520, H = 190, PAD = { l: 62, r: 12, t: 26, b: 28 };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const viridis = (f) => {
  const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const x = Math.min(0.9999, Math.max(0, f)) * (stops.length - 1), i = Math.floor(x), u = x - i;
  return `rgb(${stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * u)).join(',')})`;
};
function ticks(lo, hi, n = 5) {
  const span = hi - lo || 1, step = 10 ** Math.floor(Math.log10(span / n)), m = [1, 2, 5, 10].find((k) => span / (k * step) <= n) * step;
  const out = [];
  for (let v = Math.ceil(lo / m) * m; v <= hi + 1e-9; v += m) out.push(+v.toFixed(10));
  return out;
}
function panel(x0, y0, title, xs, ys, { xLabel = '', shade = [], color = null, band = null, xTicks = null, breakAt = null } = {}) {
  const finite = (a) => a.filter(Number.isFinite);
  const yAll = band ? [...finite(ys), ...finite(band.lo), ...finite(band.hi)] : finite(ys);
  let [ylo, yhi] = [Math.min(...yAll), Math.max(...yAll)];
  if (ylo === yhi) { ylo -= 1; yhi += 1; }
  const pad = (yhi - ylo) * 0.05;
  ylo -= pad; yhi += pad;
  const [xlo, xhi] = [Math.min(...xs), Math.max(...xs)];
  const px = (x) => x0 + PAD.l + (x - xlo) / (xhi - xlo || 1) * (W - PAD.l - PAD.r);
  const py = (y) => y0 + PAD.t + (yhi - y) / (yhi - ylo) * (H - PAD.t - PAD.b);
  let s = `<g font-family="sans-serif" font-size="10" fill="#cbd5e1"><text x="${x0 + W / 2}" y="${y0 + 15}" text-anchor="middle" font-size="12">${esc(title)}</text>`;
  s += `<rect x="${x0 + PAD.l}" y="${y0 + PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" fill="#111827" stroke="#475569"/>`;
  for (const [a, b] of shade) {
    const xa = Math.max(px(a), x0 + PAD.l), xb = Math.min(px(b), x0 + W - PAD.r);
    if (xb > xa) s += `<rect x="${xa}" y="${y0 + PAD.t}" width="${xb - xa}" height="${H - PAD.t - PAD.b}" fill="#b08d3a" fill-opacity="0.35"/>`;
  }
  for (const v of ticks(ylo, yhi)) s += `<text x="${x0 + PAD.l - 4}" y="${py(v) + 3}" text-anchor="end">${v}</text><line x1="${x0 + PAD.l}" x2="${x0 + W - PAD.r}" y1="${py(v)}" y2="${py(v)}" stroke="#1f2937"/>`;
  for (const [v, label] of xTicks ?? ticks(xlo, xhi).map((v) => [v, v])) s += `<text x="${px(v)}" y="${y0 + H - 12}" text-anchor="middle">${esc(label)}</text>`;
  s += `<text x="${x0 + W / 2}" y="${y0 + H - 1}" text-anchor="middle">${esc(xLabel)}</text>`;
  if (band) {
    let d = '';
    xs.forEach((x, i) => { if (Number.isFinite(band.hi[i])) d += `${d ? 'L' : 'M'}${px(x).toFixed(1)},${py(band.hi[i]).toFixed(1)}`; });
    for (let i = xs.length - 1; i >= 0; i--) if (Number.isFinite(band.lo[i])) d += `L${px(xs[i]).toFixed(1)},${py(band.lo[i]).toFixed(1)}`;
    if (d) s += `<path d="${d}Z" fill="#7dd3fc" fill-opacity="0.25"/>`;
  }
  if (color) {
    for (let i = 1; i < xs.length; i++) {
      if (breakAt && breakAt[i]) continue;
      s += `<line x1="${px(xs[i - 1]).toFixed(1)}" y1="${py(ys[i - 1]).toFixed(1)}" x2="${px(xs[i]).toFixed(1)}" y2="${py(ys[i]).toFixed(1)}" stroke="${color[i]}" stroke-width="1"/>`;
    }
  } else {
    let d = '';
    xs.forEach((x, i) => { d += `${!d || (breakAt && breakAt[i]) ? 'M' : 'L'}${px(x).toFixed(1)},${py(ys[i]).toFixed(1)}`; });
    s += `<path d="${d}" fill="none" stroke="#7dd3fc" stroke-width="0.8"/>`;
  }
  return `${s}</g>`;
}
const svg = (w, h, title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#0a1020"/>` +
  `<text x="${w / 2}" y="20" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#e2e8f0">${esc(title)}</text>${body}</svg>`;

export function writeFigures(out, { hist, coast, cosmosBrackets, targetBrackets, start, stop }) {
  const day = (t) => (t - start) / 86400;
  const shade = [...cosmosBrackets, ...targetBrackets].map(([a, b]) => [day(a), day(b)]);
  const breaks = hist.map((r, i) => i > 0 && (r.segment !== hist[i - 1].segment));
  const dayTicks = [];
  for (let t = start; t <= stop; t += 3 * 86400) dayTicks.push([day(t), new Date(t * 1000).toISOString().slice(5, 10)]);
  const x = hist.map((r) => day(r.t));
  const series = [['R (km)', 'R_KM'], ['I, wrapped arc (km)', 'I_KM'], ['C (km)', 'C_KM'], ['Separation (km)', 'SEPARATION_KM'],
    ['Range rate (m/s)', 'RANGE_RATE_KM_S', 1000], ['Orbital-plane angle (deg)', 'PLANE_ANGLE_DEG']];
  let body = '';
  series.forEach(([title, key, k = 1], i) => {
    const wrapBreaks = breaks.map((b, j) => b || (key === 'I_KM' && j > 0 && Math.abs(hist[j].I_KM - hist[j - 1].I_KM) > 1000));
    body += panel((i % 2) * W, 30 + Math.floor(i / 2) * H, title, x, hist.map((r) => r[key] * k), { shade, breakAt: wrapBreaks, xTicks: dayTicks });
  });
  fs.writeFileSync(path.join(out, 'history_timeseries.svg'), svg(2 * W, 30 + 3 * H, 'Cosmos 2612 relative to ICEYE-X36: history (analysis/rpo-history, SDN GP archive); shaded = maneuver brackets', body));

  const post = hist.filter((r) => r.t >= start + 0 && r.t >= Date.parse('2026-10-13T00:00:00Z') / 1000);
  const t0 = post[0]?.t ?? 0, t1 = post.at(-1)?.t ?? 1;
  const col = post.map((r) => viridis((r.t - t0) / (t1 - t0 || 1)));
  const pb = post.map((r, i) => i > 0 && r.segment !== post[i - 1].segment);
  body = panel(0, 30, 'I-R', post.map((r) => r.I_KM), post.map((r) => r.R_KM), { color: col, breakAt: pb, xLabel: 'I (km)' }) +
    panel(W, 30, 'I-C', post.map((r) => r.I_KM), post.map((r) => r.C_KM), { color: col, breakAt: pb, xLabel: 'I (km)' }) +
    panel(2 * W, 30, 'C-R', post.map((r) => r.C_KM), post.map((r) => r.R_KM), { color: col, breakAt: pb, xLabel: 'C (km)' });
  fs.writeFileSync(path.join(out, 'ric_2d_post_oct12.svg'), svg(3 * W, 30 + H, 'Cosmos 2612 in ICEYE-X36\'s curvilinear RIC frame, Oct 13 00:00 - Oct 17 12:00 UTC (purple -> yellow)', body));

  if (coast.length) {
    const c0 = coast[0].t, c1 = coast.at(-1).t, cc = coast.map((r) => viridis((r.t - c0) / (c1 - c0 || 1)));
    const h = coast.map((r) => (r.t - c0) / 3600);
    body = panel(0, 30, 'I-R', coast.map((r) => r.I_KM), coast.map((r) => r.R_KM), { color: cc, xLabel: 'I (km)' }) +
      panel(W, 30, 'I-C', coast.map((r) => r.I_KM), coast.map((r) => r.C_KM), { color: cc, xLabel: 'I (km)' }) +
      panel(2 * W, 30, 'C-R', coast.map((r) => r.C_KM), coast.map((r) => r.R_KM), { color: cc, xLabel: 'C (km)' }) +
      ['R_KM', 'I_KM', 'C_KM'].map((k, i) => panel(i * W, 30 + H, `${k[0]} (km) with 1-sigma`, h, coast.map((r) => r[k]), {
        xLabel: 'hours after projection start', band: { lo: coast.map((r) => r[k] - r[`SIGMA_${k[0]}_KM`]), hi: coast.map((r) => r[k] + r[`SIGMA_${k[0]}_KM`]) } })).join('');
    fs.writeFileSync(path.join(out, 'ric_2d_coast.svg'), svg(3 * W, 30 + 2 * H, 'Conditional 24 h coast projection, no future maneuvers; bands from the GP error model', body));
  }
}
