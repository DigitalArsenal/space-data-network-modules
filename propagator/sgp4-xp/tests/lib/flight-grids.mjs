// The grids tests/flight-parity-real-sets.e2e.mjs flies each real set on, and the digest of a flown block; shared
// with tests/fixtures/record-flight.mjs, which records the module's answers on them.
import { createHash } from 'node:crypto';
import { oemBytes } from './sds.mjs';

const DAY = 86400000;
// Minutes from the text's epoch, the experiments' way: from 1 January of its year, less the day field.
export const epochOf = (l1) => { const yy = Number(l1.slice(18, 20)); return { jan1: Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1), day: Number(l1.slice(20, 32)) }; };
const iso = (us) => `${new Date(Math.floor(us / 1000)).toISOString().slice(0, 19)}.${String(us % 1000000).padStart(6, '0')}Z`;
const epochMicros = (l1) => { const { jan1, day } = epochOf(l1); return Math.round((jan1 + (day - 1) * DAY) * 1000); };

/** The last hour of each lead day 1 to 7 after the window's cutoff, every 5 minutes: 91 epochs, as grid lines. */
export function leadGrid(set) {
  const cutoff = Date.parse(set.cutoff), { jan1, day } = epochOf(set.lines[0]);
  const times = [];
  for (let k = 1; k <= 7; k += 1) for (let j = 0; j <= 12; j += 1) times.push(cutoff + k * DAY - (60 - 5 * j) * 60000);
  const minutes = times.map((t) => (t - jan1) / 60000 - (day - 1) * 1440);
  // The grid's epochs are the instants the oracle is given in minutes: the text's epoch plus those minutes.
  const epoch = epochMicros(set.lines[0]);
  const grid = oemBytes({ blocks: [{ frame: 'TEMEOFDATE', lines: minutes.map((m) => ({ epoch: iso(epoch + Math.round(m * 60e6)) })) }] });
  return { minutes, grid };
}

/** The week: 2,016 states every 5 minutes from 5 minutes after the set's epoch to 7 days after it (START/STOP/STEP). */
export function weekGrid(set) {
  const epoch = epochMicros(set.lines[0]);
  return oemBytes({ blocks: [{ frame: 'TEMEOFDATE', start: iso(epoch + 300e6), stop: iso(epoch + 7 * DAY * 1000), step: 300, data: [] }] });
}
export const WEEK_STATES = 2016;

/** SHA-256 of a flown block's states: x, y, z, x_dot, y_dot, z_dot of every line, in order, as little-endian doubles. */
export function statesDigest(lines) {
  const doubles = new Float64Array(lines.length * 6);
  lines.forEach((l, i) => { doubles.set(l.r, 6 * i); doubles.set(l.v, 6 * i + 3); });
  return createHash('sha256').update(new Uint8Array(doubles.buffer)).digest('hex');
}
