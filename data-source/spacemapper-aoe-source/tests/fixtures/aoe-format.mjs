// SpaceMapper AOE catalog records in the form the archiver stores them (one JSON object per element set, the fields the
// site's pages embed), built here from SYNTHETIC element sets: no value in this file or in the tests comes from SpaceMapper,
// which states no licence for the data (audit: none; local use only, never published). The two-line set is formatted from the
// same numbers with AOE's habits: element set number 0, revolution number 0 and a zero checksum on every line, which is
// why 99 % of AOE's real lines fail their checksum. Times are on China Standard Time (+0800), as AOE writes them.
import { twoLine } from '../../../spacetrack-source/tests/fixtures/spacetrack-format.mjs';

const cst = (isoUtc) => `${new Date(Date.parse(`${isoUtc}Z`) + 8 * 3600 * 1000).toISOString().slice(0, 19)}+0800`;

export function aoeLines(set) {
  const [l1, l2] = twoLine({ ...set, elset: 0, rev: 0 });
  return [`${l1.slice(0, 68)}0`, `${l2.slice(0, 68)}0`];
}

// `set` as spacetrack-format's synthetic(): name, objectId, norad, epoch (whole seconds, UTC), elements. `over` replaces record fields.
export function aoeRecord(set, over = {}) {
  const [line1, line2] = aoeLines(set);
  return {
    id: set.recordId, channel: 'ky', channelId: '1357150609735704', catId: set.catId ?? set.norad, noradId: set.norad, ctime: cst(set.created ?? '2026-10-11T10:04:12'),
    line0: set.name, line1, line2, epoch: cst(set.epoch), launchYear: 2026, launchNumber: 901, launchPiece: 'A', classification: 'U', ephemerisType: 0, revolutionNumber: 0,
    inclination: Number(set.inc.toFixed(3)), raan: Number(set.raan.toFixed(4)), eccentricity: Number(set.ecc.toFixed(7)), perigeeArgument: Number(set.argp.toFixed(3)),
    meanAnomaly: Number(set.ma.toFixed(4)), meanMotion: Number(set.meanMotion.toFixed(6)), meanMotionFirst: 0, meanMotionSecond: 0, elementNumber: 0, bstar: set.bstar,
    semimajorAxis: 6800, apogee: 430, perigee: 420, period: 92, revAtEpoch: 0, lastUpdateId: `2026test${set.recordId}`, name: set.name, launchDate: '2026-01-02T00:00:00+0000',
    satId: set.satId === undefined ? set.catId ?? set.norad : set.satId, objectId: set.objectId, objectType: 'PAYLOAD', ...over,
  };
}
