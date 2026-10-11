// JSC Vimpel's public files in the form the site serves them, built here from SYNTHETIC objects: no value in this
// file or in the tests comes from a Vimpel file, because Vimpel's data is behind a user agreement and not ours to
// reproduce (data licence policy; audit id `vimpel`, reproduce no). The layouts are those of
// files/orbit-products/src/vimpel.hpp (read from the provider's format description, 2026-09-21) and
// analysis/catalog-composer/docs/vimpel-normalization.md.

// Orbit table row, 15 comma-separated columns:
//  1 row ordinal  2 Vimpel number  3 first observation DDMMYYYY  4 reference epoch "DDMMYYYY HHMMSS" UTC
//  5 days since orbit update  6 a km  7 i deg  8 RAAN deg  9 e  10 argument of latitude deg  11 argument of perigee deg
// 12 area/mass m2/kg  13 magnitude  14 along-track timing uncertainty, minutes, 50 %  15 transverse position uncertainty, km, 50 %
export function orbitRow(o, ordinal = 1) {
  const p = (x, width) => String(x).padStart(width);
  return [p(ordinal, 4), p(o.id, 6), o.first ?? '16072020', o.epoch, p(o.age ?? 5, 4), p(o.a.toFixed(1), 9), p(o.inc.toFixed(3), 7), p(o.raan.toFixed(3), 7), p(o.e.toFixed(6), 8),
    p(o.u.toFixed(1), 5), p(o.w.toFixed(3), 7), o.am ?? '1.73e-02', p(o.mag ?? '16.0', 5), p(o.along ?? '34.3', 5), p(o.pos ?? '385', 4)].join(',');
}
export const orbitTable = (rows, eol = '\n') => rows.map((o, k) => orbitRow(o, k + 1)).join(eol) + eol;

// datefirst: header, then Nvym t_det_v Nnor t_det_n (a six-digit Vimpel number, a date, a NORAD number, a date)
export const datefirst = (rows) => ` Nvym  t_det_v  Nnor  t_det_n  \n${rows.map(([v, tv, n, tn]) => `${String(v).padStart(6, '0')} ${tv} ${String(n).padStart(5, ' ')} ${tn}`).join('\n')}\n           \n`;

// A rectangular ephemeris file: index, x, y, z (km, J2000), one sample every 600 s
export const ephemerisFile = (positions) => positions.map((r, k) => `${k},${r[0].toFixed(1)},${r[1].toFixed(1)},${r[2].toFixed(1)}`).join('\n') + '\n';

// The synthetic objects of the tests: closed cases whose state is known without the module's rotation.
export const objects = {
  // equatorial circular orbit at the synchronous radius, 90 degrees along from the node: r on +y, v on -x
  geo: { id: 40001, epoch: '21092026 000000', a: 42164.2, inc: 0, raan: 0, e: 0, u: 90, w: 0 },
  // polar circular orbit through the node: r on +x, v on +z
  polar: { id: 40002, epoch: '21092026 060000', a: 7000, inc: 90, raan: 0, e: 0, u: 0, w: 0 },
  // eccentric equatorial orbit at perigee: r on +x at a(1-e), v on +y at the perigee speed
  perigee: { id: 40003, epoch: '21092026 120000', a: 26000, inc: 0, raan: 0, e: 0.7, u: 0, w: 0 },
  // a general orbit (the shape of the provider's HEO objects): checked through the two-body invariants
  heo: { id: 40004, epoch: '21092026 183045', a: 13066.1, inc: 29.651, raan: 10.073, e: 0.466925, u: 359.7, w: 294.952, am: '3.89e-01', mag: '18.8', along: '0.3', pos: '54', age: -3 },
};

// A two-body arc of synthetic positions (km, J2000), one every 600 s: the closed-form Kepler ellipse (Newton on Kepler's
// equation, then the perifocal rotation). TEST FIXTURE GENERATOR ONLY, never imported by shipped code: it makes the
// numbers of a Vimpel-format ephemeris file for a synthetic object; the module's output is never compared with it.
export function keplerArc({ a, e, inc, raan, w, M0 }, samples = 1008, step = 600) {
  const mu = 398600.4418, d2r = Math.PI / 180, n = Math.sqrt(mu / a ** 3);
  const [cO, sO, ci, si, cw, sw] = [Math.cos(raan * d2r), Math.sin(raan * d2r), Math.cos(inc * d2r), Math.sin(inc * d2r), Math.cos(w * d2r), Math.sin(w * d2r)];
  return Array.from({ length: samples }, (_, k) => {
    const M = (M0 * d2r + n * step * k) % (2 * Math.PI);
    let E = M;
    for (let i = 0; i < 60; ++i) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const x = a * (Math.cos(E) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E);
    return [x * (cO * cw - sO * ci * sw) - y * (cO * sw + sO * ci * cw), x * (sO * cw + cO * ci * sw) - y * (sO * sw - cO * ci * cw), x * si * sw + y * si * cw];
  });
}
