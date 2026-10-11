// GP JSON records (Space-Track class gp or gp_history, or CelesTrak
// FORMAT=json) to $OMM records, and the catalog file the runners read: each
// record prefixed by its u32 big-endian length. Record conversion only.
import { gpRecord, initCqrFlatc, publishedSchema } from '../../tests/lib/cqr.mjs';

const TEXT = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'CLASSIFICATION_TYPE'];
const NUMBER = ['NORAD_CAT_ID', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER',
  'MEAN_ANOMALY', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];

/** A converter from one GP JSON record to its $OMM bytes, or null without an epoch or mean motion. */
export async function createOmmEncoder() {
  const flatc = await initCqrFlatc();
  const schema = publishedSchema('OMM');
  return (g) => {
    // Space-Track sends numbers as strings, and fields the OMM schema does not hold.
    const gp = {};
    for (const k of TEXT) if (g[k] != null && g[k] !== '') gp[k] = String(g[k]);
    for (const k of NUMBER) if (g[k] != null && g[k] !== '') gp[k] = Number(g[k]);
    if (!gp.EPOCH || !Number.isFinite(gp.MEAN_MOTION) || !Number.isFinite(gp.NORAD_CAT_ID)) return null;
    return flatc.generateBinary(schema, JSON.stringify(gpRecord(gp)), { sizePrefix: false });
  };
}

/** The catalog file of $OMM records. */
export function catalogFile(records) {
  const parts = [];
  for (const record of records) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(record.length);
    parts.push(length, Buffer.from(record));
  }
  return Buffer.concat(parts);
}
