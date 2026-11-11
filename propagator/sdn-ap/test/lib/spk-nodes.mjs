// The states an SPK series holds, without its straight-line fill. The TESS definitive kernels' 60 s records are solution
// states only at minutes 0 mod 10; the nine records between are chords between those states, up to about 1 km inside the
// orbit near perigee (stack #479, comment 6808033865). The experiments' reader has kept the states alone since c8e5bedf
// (sdn-gp-starlink-ffm-match/lib/spk-sources.mjs nodeRows); the vendored copy (c89f2bc) predates it, so the suite applies
// the same rule here.

/**
 * A record whose position and velocity second differences vanish (under 1 mm and 1 um/s on every axis, against its two
 * neighbors) lies on a chord. The other records are the nodes; their commonest spacing and phase in time name the grid that
 * is kept. A series with no chord records is returned whole. `lines`: [{epoch, r: [km], v: [km/s]}], evenly spaced and in
 * time order.
 */
export function nodeLines(lines) {
  const t = lines.map((l) => Math.round(Date.parse(/Z$/.test(l.epoch) ? l.epoch : `${l.epoch}Z`) / 1000) * 1000);
  const flat = (i, key, eps) => [0, 1, 2].every((k) => Math.abs(lines[i + 1][key][k] - 2 * lines[i][key][k] + lines[i - 1][key][k]) < eps);
  const nodes = [];
  let lined = 0;
  for (let i = 1; i < lines.length - 1; i += 1) if (flat(i, 'r', 1e-6) && flat(i, 'v', 1e-9)) lined += 1; else nodes.push(t[i]);
  if (!lined || nodes.length < 2) return lines;
  const mode = (xs) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0];
  const cadence = mode(nodes.slice(1).map((n, j) => n - nodes[j]));
  const phaseOf = (x) => ((x % cadence) + cadence) % cadence, phase = mode(nodes.map(phaseOf));
  return lines.filter((_, i) => phaseOf(t[i]) === phase);
}
