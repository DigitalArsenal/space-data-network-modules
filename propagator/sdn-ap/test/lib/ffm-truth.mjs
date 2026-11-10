// Controlled numerical truth from the project's own full-force propagator (propagator/ffm): EGM96 to the degree asked,
// the Sun and Moon from the DE440 excerpt in files/orbit-products, no drag, no radiation pressure; GCRF states (km, km/s)
// at the asked UTC times. Cached under the test scratch root by the FFM build, the request and the kernel.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { requestFor, decodeResult, encodePrw, makeTable, TYPE } from '../../../ffm/tests/lib/prwCodec.mjs';
import { scratchDir } from './scratch.mjs';

export const ffmPath = new URL('../../../ffm/dist/isomorphic/module.wasm', import.meta.url).pathname;
export const kernelPath = new URL('../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url).pathname;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The GCRF states of `state0` ([x, y, z, vx, vy, vz] at epochMs, UTC) at `timesMs` under EGM96 `degree` x `degree`,
 * the Sun and the Moon: [[x, y, z, vx, vy, vz]] in km and km/s. */
export async function ffmTruth(state0, epochMs, timesMs, degree) {
  const kernel = fs.readFileSync(kernelPath);
  const jd = (ms) => ms / 86400000 + 2440587.5;
  const params = { epochJD: jd(epochMs), epochTimeScale: 'UTC', targetJD: jd(timesMs.at(-1)), targetTimeScale: 'UTC', position: state0.slice(0, 3), velocity: state0.slice(3),
    frame: 'GCRF', sampleEpochsJD: timesMs.map((ms) => ({ jd: jd(ms), scale: 'UTC' })),
    forces: { gravityMode: 'EGM96', maxDegree: degree, maxOrder: degree, thirdBody: true, srp: false, drag: false, massKg: 1000, areaM2: 10, cd: 2.2 },
    integrator: { tolerance: 1e-12, minStep: 0.01, maxStep: 300 }, ephemerisSource: 'JPL_SPK' };
  const key = createHash('sha256').update(fs.readFileSync(ffmPath)).update(JSON.stringify(params)).update(kernel).digest('hex');
  const file = path.join(scratchDir('ffm-truth'), `${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const h = await createStandaloneHarness('browser', ffmPath, { surface: 'command' });
  const req = requestFor('propagate', params, kernel);
  // Earth orientation as AP assumes it: the pole at its mean position, UT1 = UTC (daily rows with TAI - UTC alone)
  const DAY = 86400000, first = Math.floor(epochMs / DAY) * DAY - DAY, days = Math.ceil((timesMs.at(-1) - first) / DAY) + 3;
  req.inputs.push({ portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', {
    ROWS: Array.from({ length: days }, (_, k) => makeTable('EOP', { DATE: new Date(first + k * DAY).toISOString().replace('.000', ''),
      MJD: (first + k * DAY) / DAY + 40587, TAI_MINUS_UTC_SECONDS: 37 })) })) });
  const r = await h.invoke(req);
  if (r.statusCode !== 0) throw new Error(`FFM: ${r.errorCode} ${r.errorMessage}`);
  const states = decodeResult(r).samples.map((s) => [...s.position, ...s.velocity]);
  if (states.length !== timesMs.length) throw new Error(`FFM returned ${states.length} of ${timesMs.length} states`);
  fs.writeFileSync(file, JSON.stringify(states));
  await h.close?.();
  return states;
}

/** The provenance of the truth: the FFM build's and the kernel's SHA-256. */
export const ffmProvenance = () => ({ ffmSha256: sha(fs.readFileSync(ffmPath)), kernelSha256: sha(fs.readFileSync(kernelPath)) });
