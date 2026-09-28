// Real-catalog screen with reentering objects (opt-in, needs local data).
//
// Source: a full CelesTrak GP catalog as size-prefixed SDS $OMM records, e.g.
// OrbPro's sandcastle gallery sgp4-propagation/omm-cache.fb (31,814 objects,
// epochs 2026-06-07..2026-07-10). Point CQR_REAL_CATALOG_OMM_FB at it or copy
// it to tests/data/omm-cache.fb; the test skips when neither exists.
//
// CelesTrak GP elements are SGP4 mean elements in TEME of date, UTC. Records
// published before celestrak-parser declared that frame carry no
// REFERENCE_FRAME; this test gives exactly those records the frame their
// source contract defines (Earth, TEMEOFDATE), which is what the parser now
// writes. Records that declare a frame are passed through unchanged.
//
// The request has OrbPro's Live-catalog shape: a few primaries (EXPLORER 7 and
// other LEO objects) against the whole catalog as secondaries, two days from
// 2026-07-06T00:00Z, 60 s coarse steps, 5 km threshold. Before objects that
// SGP4 cannot propagate were excluded, this request failed with 422
// "screening-failed: Satellite has decayed" (NORAD 8301, THORAD DELTA 1 DEB).
// It must now complete, list 8301 among the excluded objects and report no
// failed pairs. Exact assertions only; no numerical tolerance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as flatbuffers from 'flatbuffers';
import { CelestialFrame, CelestialFrameWrapperT, OMM, RFMT, RFMUnion } from 'spacedatastandards.org/lib/js/OMM/main.js';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, initCqrFlatc, screeningControls } from './lib/cqr.mjs';

const CATALOG = [process.env.CQR_REAL_CATALOG_OMM_FB, fileURLToPath(new URL('./data/omm-cache.fb', import.meta.url))]
  .find((file) => file && fs.existsSync(file));
const PRIMARIES = [22, 25544, 20580, 43013, 48274, 33591, 27424, 28654, 37849];

function records(bytes) {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.byteLength;) {
    const length = view.getUint32(offset, true);
    out.push(bytes.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return out;
}

function withSourceFrame(record) {
  const omm = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(Uint8Array.from(record))).unpack();
  if (!omm.REFERENCE_FRAME) {
    omm.CENTER_NAME = 'EARTH';
    omm.REFERENCE_FRAME = new RFMT(RFMUnion.CelestialFrameWrapper, new CelestialFrameWrapperT(CelestialFrame.TEMEOFDATE));
  }
  const builder = new flatbuffers.Builder(1024);
  builder.finish(omm.pack(builder), '$OMM');
  return { norad: omm.NORAD_CAT_ID, bytes: builder.asUint8Array().slice() };
}

test('a real catalog with reentering objects screens to completion and lists the excluded objects',
  { skip: CATALOG ? false : 'no local catalog (CQR_REAL_CATALOG_OMM_FB or tests/data/omm-cache.fb)', timeout: 900000 },
  async (t) => {
    const flatc = await initCqrFlatc();
    const catalog = records(new Uint8Array(fs.readFileSync(CATALOG))).map(withSourceFrame);
    const primaryIndices = PRIMARIES.map((norad) => catalog.findIndex((entry) => entry.norad === norad)).filter((index) => index >= 0);
    assert.ok(primaryIndices.length > 0 && catalog.some((entry) => entry.norad === 8301));
    const n = catalog.length;
    const request = encodeCqr(flatc, { CATALOG_REQUEST: {
      CONTROLS: screeningControls({ startJd: Date.parse('2026-07-06T00:00:00Z') / 86400000 + 2440587.5, durationDays: 2, numThreads: 8 }),
      EVALUATION_FRAME: earthFrame('TEME'),
      ORDERED_CATALOG_INDICES: [...primaryIndices, ...catalog.map((_, index) => index)],
      START_ORDER_INDEX: 0, HAS_START_ORDER_INDEX: true, END_ORDER_INDEX: primaryIndices.length, HAS_END_ORDER_INDEX: true,
      SECONDARY_START_ORDER_INDEX: primaryIndices.length, HAS_SECONDARY_START_ORDER_INDEX: true,
      SECONDARY_END_ORDER_INDEX: primaryIndices.length + n, HAS_SECONDARY_END_ORDER_INDEX: true,
    } });
    const inputs = [{ portId: 'request', payload: request }, ...catalog.map((entry) => ({ portId: 'catalog', payload: entry.bytes }))];
    const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
    t.after(() => harness.destroy());

    let result;
    const excluded = [];
    for (;;) {
      const response = await harness.invoke({ methodId: 'screen_catalog', inputs });
      assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
      for (const frame of response.outputs) {
        if (frame.portId === 'result') result = decodeCqr(flatc, frame.payload).CATALOG_RESULT;
        if (frame.portId === 'excluded') excluded.push(OMM.getRootAsOMM(new flatbuffers.ByteBuffer(Uint8Array.from(frame.payload))).unpack());
      }
      if (result.FINAL_CHUNK) break;
    }
    console.log(`${n} objects, ${excluded.length} excluded: ${excluded.map((o) => `${o.NORAD_CAT_ID} ${o.OBJECT_NAME} [${o.COMMENT.split('First failure at ')[1]}]`).join('; ')}`);
    console.log(`statistics ${JSON.stringify(result.STATISTICS)}`);
    assert.equal(result.STATISTICS.FAILED_PAIRS, 0);
    assert.equal(result.OBJECTS_PARSED - result.STATISTICS.TOTAL_OBJECTS, excluded.length);
    const thorad = excluded.find((o) => o.NORAD_CAT_ID === 8301);
    assert.ok(thorad, 'THORAD DELTA 1 DEB is listed as excluded');
    assert.match(thorad.COMMENT, /First failure at 2026-07-0[67]T\d\d:\d\d:\d\d\.\d{3}Z: Satellite has decayed$/);
    for (const omm of excluded) {
      assert.equal(omm.CENTER_NAME, 'EARTH');
      assert.equal(omm.REFERENCE_FRAME.REFERENCE_FRAME.frame, CelestialFrame.TEMEOFDATE);
      assert.match(omm.COMMENT, /^Excluded from conjunction screening: SGP4 cannot propagate this object over the screening window\. First failure at /);
    }
  });
