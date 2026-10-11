// Aggregates over windows: the median, mean and 90th percentile of the RMS at day 0 (the fit) and at each lead day, for each fitter,
// and the paired comparison (the share of windows in which SGP4-XP is closer, the ratio of the medians).
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const stats = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  return { n: v.length, median: quantile(v, 0.5), mean: v.reduce((a, b) => a + b, 0) / v.length, p90: quantile(v, 0.9), rmsOfRms: Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length) };
};
export function summarize(rows, leads, minCoverage = 0.5) {
  const out = {};
  const usable = rows.filter((r) => !r.xp.error && r.sgp4 && !r.sgp4.error);
  const pick = (r, who, lead) => {
    if (lead === 0) return r[who].fit;
    const d = r[who].days[lead];
    const full = Math.max(...Object.values(r.xp.days ?? {}).map((x) => x.n), 0);
    return d && d.n >= minCoverage * (r.xp.days[lead]?.n ?? d.n) ? d.rms : undefined;
  };
  out.windows = { total: rows.length, xpFailed: rows.filter((r) => r.xp.error).length, sgp4Failed: rows.filter((r) => r.sgp4?.error).length, paired: usable.length };
  for (const lead of [0, ...leads]) {
    const pairs = usable.map((r) => [pick(r, 'xp', lead), pick(r, 'sgp4', lead)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    out[`day${lead}`] = {
      xp: stats(pairs.map((p) => p[0])), sgp4: stats(pairs.map((p) => p[1])),
      xpCloser: pairs.length ? pairs.filter(([a, b]) => a < b).length / pairs.length : null,
      medianRatio: pairs.length ? stats(pairs.map((p) => p[0])).median / stats(pairs.map((p) => p[1])).median : null,
    };
  }
  const xpOnly = rows.filter((r) => !r.xp.error);
  out.xpOnly = Object.fromEntries([0, ...leads].map((lead) => [`day${lead}`, stats(xpOnly.map((r) => (lead === 0 ? r.xp.fit : r.xp.days[lead]?.rms)))]));
  return out;
}
