// Space-Track `gp`, `gp_history` and `satcat` JSON in the form the REST API serves it (every value text, null for
// an empty value), built here from SYNTHETIC element sets and catalog entries: no value in this file or in the
// tests comes from a Space-Track response, because Space-Track's data is not ours to reproduce (data licence
// policy). The two-line set of a record is formatted from the same numbers (columns as the two-line element
// format fixes them); this is text formatting for the fixtures, not orbit mathematics.

const ALPHA5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// 100000..339999 -> letter and four digits (A0000 = 100000), as the two-line element format writes it.
export function catalogCell(norad) {
  if (norad < 100000) return String(norad).padStart(5, '0');
  const letter = Math.floor(norad / 10000) - 10;
  return `${ALPHA5[letter]}${String(norad % 10000).padStart(4, '0')}`;
}

const checksum = (line) => {
  let sum = 0;
  for (const c of line.slice(0, 68)) sum += c >= '0' && c <= '9' ? Number(c) : c === '-' ? 1 : 0;
  return sum % 10;
};

// " 51268-3": sign, five digits of the mantissa without its decimal point, exponent.
function implied(x) {
  if (x === 0) return ' 00000-0';
  const sign = x < 0 ? '-' : ' ';
  let exponent = Math.floor(Math.log10(Math.abs(x))) + 1;
  let digits = Math.round((Math.abs(x) / 10 ** exponent) * 1e5);
  if (digits >= 1e5) { digits = Math.round(digits / 10); exponent += 1; }
  return `${sign}${String(digits).padStart(5, '0')}${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
}

// `set.cell` writes the catalog cell literally (a test that pins the Alpha-5 rule names the published text, here A0123,
// instead of computing it with the rule under test); otherwise the cell is computed from `set.norad`.
export function twoLine(set) {
  const cell = set.cell ?? catalogCell(set.norad);
  const date = new Date(`${set.epoch}Z`);
  const dayOfYear = (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + 1;
  const designator = set.objectId ? `${set.objectId.slice(2, 4)}${set.objectId.slice(5)}`.padEnd(8) : ' '.repeat(8);
  const l1 = `1 ${cell}U ${designator} ${String(date.getUTCFullYear() % 100).padStart(2, '0')}${dayOfYear.toFixed(8).padStart(12, '0')} `
    + `${set.ndot < 0 ? '-' : ' '}${Math.abs(set.ndot).toFixed(8).slice(1)} ${implied(set.nddot)} ${implied(set.bstar)} 0 ${String(set.elset).padStart(4)}`;
  const l2 = `2 ${cell} ${set.inc.toFixed(4).padStart(8)} ${set.raan.toFixed(4).padStart(8)} ${set.ecc.toFixed(7).slice(2)} `
    + `${set.argp.toFixed(4).padStart(8)} ${set.ma.toFixed(4).padStart(8)} ${set.meanMotion.toFixed(8).padStart(11)}${String(set.rev).padStart(5, '0')}`;
  return [`${l1}${checksum(l1)}`, `${l2}${checksum(l2)}`];
}

// One synthetic element set as a gp / gp_history record. `overrides` replaces fields of the JSON record after it is built.
export function gpRecord(set, overrides = {}) {
  const [line1, line2] = twoLine(set);
  const text = (x, digits) => x.toFixed(digits);
  return {
    CCSDS_OMM_VERS: '3.0',
    COMMENT: 'GENERATED VIA SPACE-TRACK.ORG API',
    CREATION_DATE: set.creation,
    ORIGINATOR: '18 SPCS',
    OBJECT_NAME: set.name,
    OBJECT_ID: set.objectId,
    CENTER_NAME: 'EARTH',
    REF_FRAME: 'TEME',
    TIME_SYSTEM: 'UTC',
    MEAN_ELEMENT_THEORY: 'SGP4',
    EPOCH: set.epoch,
    MEAN_MOTION: text(set.meanMotion, 8),
    ECCENTRICITY: text(set.ecc, 8),
    INCLINATION: text(set.inc, 4),
    RA_OF_ASC_NODE: text(set.raan, 4),
    ARG_OF_PERICENTER: text(set.argp, 4),
    MEAN_ANOMALY: text(set.ma, 4),
    EPHEMERIS_TYPE: '0',
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: String(set.norad),
    ELEMENT_SET_NO: String(set.elset),
    REV_AT_EPOCH: String(set.rev),
    BSTAR: text(set.bstar, 14),
    MEAN_MOTION_DOT: text(set.ndot, 8),
    MEAN_MOTION_DDOT: text(set.nddot, 13),
    SEMIMAJOR_AXIS: '6800.000',
    PERIOD: '92.000',
    APOAPSIS: '430.000',
    PERIAPSIS: '420.000',
    OBJECT_TYPE: 'PAYLOAD',
    RCS_SIZE: 'MEDIUM',
    COUNTRY_CODE: 'US',
    LAUNCH_DATE: '2026-01-02',
    SITE: 'AFETR',
    DECAY_DATE: null,
    FILE: String(1000000 + set.gpId),
    GP_ID: String(set.gpId),
    TLE_LINE0: `0 ${set.name}`,
    TLE_LINE1: line1,
    TLE_LINE2: line2,
    ...overrides,
  };
}

export const synthetic = (over = {}) => ({
  name: 'SYNTH 1', objectId: '2026-901A', norad: 99001, epoch: '2026-10-10T10:16:55.343712', creation: '2026-10-10T17:33:11', gpId: 900000001,
  meanMotion: 15.49512345, ecc: 0.0006789, inc: 51.6123, raan: 123.4567, argp: 87.6543, ma: 272.5432, bstar: 0.00034567, ndot: 0.00001234, nddot: 0, elset: 999, rev: 12345,
  ...over,
});

// A satcat record as the REST API serves it.
export function satcatRecord(over = {}) {
  return {
    INTLDES: '2026-901A', NORAD_CAT_ID: '99001', OBJECT_TYPE: 'PAYLOAD', SATNAME: 'SYNTH 1', COUNTRY: 'US', LAUNCH: '2026-01-02', SITE: 'AFETR', DECAY: null,
    PERIOD: '92.10', INCLINATION: '51.60', APOGEE: '430', PERIGEE: '420', COMMENT: null, COMMENTCODE: null, RCSVALUE: '0', RCS_SIZE: 'MEDIUM', FILE: '1',
    LAUNCH_YEAR: '2026', LAUNCH_NUM: '901', LAUNCH_PIECE: 'A', CURRENT: 'Y', OBJECT_NAME: 'SYNTH 1', OBJECT_ID: '2026-901A', OBJECT_NUMBER: '99001', ...over,
  };
}
