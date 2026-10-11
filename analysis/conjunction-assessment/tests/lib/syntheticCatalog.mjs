// Invented element sets for continuous-screening checks: circular orbits in
// crossing planes near one altitude, so short windows hold close approaches,
// and one set with its perigee below the Earth's surface, which SGP4 refuses
// (an excluded object). No real object or catalog: free to commit and share.

/** A deterministic generator of numbers in [0, 1) (Park-Miller). */
export function seeded(seed) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
}

/**
 * GP JSON records (Space-Track field names) for `planes` x `perPlane` objects
 * plus one SGP4 cannot propagate.
 * @param {{planes?: number, perPlane?: number, epoch?: string, seed?: number}} [o]
 */
export function syntheticGp({ planes = 6, perPlane = 40, epoch = '2026-10-01T00:00:00.000000', seed = 20261011 } = {}) {
  const random = seeded(seed), out = [];
  let norad = 90000;
  const record = (name, elements) => ({ OBJECT_NAME: name, OBJECT_ID: name, NORAD_CAT_ID: ++norad, EPOCH: epoch, ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 1, CLASSIFICATION_TYPE: 'U', BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0, ARG_OF_PERICENTER: 0, ...elements });
  for (let p = 0; p < planes; p++) {
    for (let s = 0; s < perPlane; s++) {
      out.push(record(`SYN-${p}-${s}`, { MEAN_MOTION: 15.05 + 0.002 * random(), ECCENTRICITY: 0.0001 + 0.0004 * random(),
        INCLINATION: p % 2 ? 97.6 : 53, RA_OF_ASC_NODE: (p * 360) / planes + random(), MEAN_ANOMALY: 360 * random() }));
    }
  }
  out.push(record('SYN-DOWN', { MEAN_MOTION: 16.2, ECCENTRICITY: 0.08, INCLINATION: 51.6, RA_OF_ASC_NODE: 10, MEAN_ANOMALY: 0 }));
  return out;
}

/** The same objects with new element sets for `count` of them (every `stride`-th): mean anomaly moved. */
export function updatedGp(records, { count, stride = 7, seed = 7 } = {}) {
  const random = seeded(seed), out = records.map((r) => ({ ...r })), rows = [];
  for (let i = 0; rows.length < count && i < out.length - 1; i += stride) {
    out[i].MEAN_ANOMALY = (out[i].MEAN_ANOMALY + 0.5 + 2 * random()) % 360;
    rows.push(i);
  }
  return { records: out, rows };
}
