// Windows over an ephemeris and small statistics. Window logic follows modules propagator/sgp4-xp tests/measure
// (fit interval from a state, held-out days after it); statistics are counting and ordering only.
export const DAY = 86400000;
export const ms = (iso) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
export const iso = (t) => new Date(Math.round(t)).toISOString();

/** An ephemeris object { lines: [{epoch, r, v}], t: Float64Array } -> lines with fromMs <= t <= toMs. */
export function slice(object, fromMs, toMs) {
  let lo = 0, hi = object.t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (object.t[mid] < fromMs) lo = mid + 1; else hi = mid; }
  const begin = lo;
  hi = object.t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (object.t[mid] <= toMs) lo = mid + 1; else hi = mid; }
  return object.lines.slice(begin, lo);
}

/** Start times of fit windows: every strideSeconds from the first state while minLeadDays after the fit still have states. */
export function windowStarts(object, { fitSeconds, strideSeconds, minLeadDays = 1, offsetSeconds = 0 }) {
  const first = object.t[0] + offsetSeconds * 1000;
  const last = object.t[object.t.length - 1];
  const out = [];
  for (let start = first; start + fitSeconds * 1000 + minLeadDays * DAY <= last + 1; start += strideSeconds * 1000) out.push(start);
  return out;
}

export function withT(object) {
  object.t = Float64Array.from(object.lines, (l) => ms(l.epoch));
  return object;
}

export const quantile = (values, q) => {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
};
export const mean = (values) => { const a = values.filter((v) => Number.isFinite(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
