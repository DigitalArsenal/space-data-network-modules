// Test-only circular trajectory and canonical wire encoding; production physics
// stays in C++. Circle r=7000 km, period=5400 s, J2000 axes, UTC sample epochs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as fb from 'flatbuffers';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import { EVL, EVLT, EVLEventLocationRequestT, EVLEclipseConfigurationT } from 'spacedatastandards.org/lib/js/EVL/main.js';
import { PCEEvaluationContextT } from 'spacedatastandards.org/lib/js/PCE/main.js';
import { RFMT, CelestialFrameWrapperT } from 'spacedatastandards.org/lib/js/RFM/main.js';
import { OEM, OEMT, ephemerisDataBlockT, ephemerisDataLineT } from 'spacedatastandards.org/lib/js/OEM/main.js';

export const actualKernelPath = new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url);
export function kernelFrame(bytes = readFileSync(actualKernelPath), hashOverride) {
  const b = new fb.Builder(1024);
  const sha = b.createString(hashOverride ?? createHash('sha256').update(bytes).digest('hex'));
  NCD.startNCD(b);
  NCD.addFormat(b, 1); // SPK_DAF, ratified NCD enum
  NCD.addSourceByteLength(b, BigInt(bytes.length));
  NCD.addSourceSha256(b, sha);
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  return Buffer.concat([b.asUint8Array(), bytes]);
}
const type = (family) => ({ schemaName: `${family}.fbs`, fileIdentifier: `$${family}`, rootTypeName: family });
export function eclipseRequest({ kernel = undefined, start = '2026-01-02T00:00:00Z', timeSystem = 11, frame = 1, center = 399 } = {}) {
  const epoch = Date.parse(start);
  const iso = (s) => new Date(epoch + s * 1000).toISOString().replace('Z', '');
  let b = new fb.Builder(1024);
  const request = new EVLEventLocationRequestT();
  request.LOCATOR_CLASS = 1;
  request.CONTEXT = new PCEEvaluationContextT();
  request.CONTEXT.CENTRAL_BODY_ID = 399;
  request.SCAN_START_EPOCH = iso(0);
  request.SCAN_STOP_EPOCH = iso(6000);
  request.EPOCH_TIME_SYSTEM = 'UTC';
  request.SCAN_STEP_SECONDS = 30;
  request.REFINEMENT_TOLERANCE_SECONDS = 1e-6;
  request.ECLIPSE_CONFIGURATION = new EVLEclipseConfigurationT();
  Object.assign(request.ECLIPSE_CONFIGURATION, { OCCULTING_BODY_IDS: [399], ILLUMINATING_BODY_ID: 10, REPORT_UMBRA: true });
  const evl = new EVLT(); evl.LOCATION_REQUEST = request;
  EVL.finishEVLBuffer(b, evl.pack(b));
  const requestBytes = b.asUint8Array().slice();
  b = new fb.Builder(131072);
  const block = new ephemerisDataBlockT();
  block.TIME_SYSTEM = timeSystem;
  block.REFERENCE_FRAME = new RFMT(1, new CelestialFrameWrapperT(frame));
  block.CENTER_NAIF_ID = center;
  block.EPHEMERIS_DATA_LINES = [];
  for (let t = 0; t <= 6000; t += 10) {
    const row = new ephemerisDataLineT();
    const w = 2 * Math.PI / 5400, a = w * t;
    Object.assign(row, { EPOCH: iso(t), X: 7000 * Math.cos(a), Y: 7000 * Math.sin(a), Z: 0,
      X_DOT: -7000 * w * Math.sin(a), Y_DOT: 7000 * w * Math.cos(a), Z_DOT: 0 });
    block.EPHEMERIS_DATA_LINES.push(row);
  }
  const oem = new OEMT(); oem.EPHEMERIS_DATA_BLOCK = [block];
  OEM.finishOEMBuffer(b, oem.pack(b));
  const inputs = [{ portId: 'request', typeRef: type('EVL'), payload: requestBytes },
    { portId: 'ephemeris', typeRef: type('OEM'), payload: b.asUint8Array().slice() }];
  if (kernel !== undefined) inputs.push({ portId: 'kernel', typeRef: type('NCD'), payload: kernel });
  return { methodId: 'locate_events', inputs };
}
