#!/usr/bin/env node
// Records tests/fixtures/ocm-sets/xp-screen-ca-<version>.events, the SGP4XP reference of tests/ocm-sets-screening.e2e.mjs:
// screenOcmSets on the registered SGP4XP sets alone (xp as recorded and d, the turned SGP4XP set; both carry covariance)
// over one day from xp's epoch, 20 km, FOSTER, TEME, with this package's dist and propagator/sdn-ap's. Each event
// (CQREvent through the SDS object API) is written size-prefixed, in the order the screen returns them, its embedded
// message's wall-clock CREATION_DATE and MESSAGE_ID left out (eventBytes). Recorded once
// with conjunction-assessment 0.18.1 (dist module.wasm sha256
// daeb52c798a0cea6098cfb6a65cef51ecd49663a621586ec5de07ac1a5885133, propagator/sdn-ap 0.6.2), before the AP covariance
// gate: an SGP4XP pair's events stay these bytes. JS only moves bytes.
//   node tests/record-xp-screen.mjs [out]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { OCM } from 'spacedatastandards.org/lib/js/OCM/OCM.js';
import { createStandaloneHarness as sdnApHarness } from '../../../propagator/sdn-ap/node_modules/space-data-module-sdk/src/testing/isomorphicHarness.js';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { screenOcmSets } from '../src/js/ocmSetScreen.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const version = JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8')).version;
const fixture = (name) => new Uint8Array(fs.readFileSync(here(`fixtures/ocm-sets/${name}-fit-sdn-ap-0.5.2.ocm`)));

/** The SGP4XP screen: its sets, window and controls (tests/ocm-sets-screening.e2e.mjs screens the same). */
export function xpScreen() {
  const xp = fixture('xp'), d = fixture('d');
  const epoch = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(xp)).MEAN_ELEMENTS().EPOCH();
  return { sets: [xp, d], window: { startJd: Date.parse(`${epoch}Z`) / 86400000 + 2440587.5, durationDays: 1 },
    controls: { thresholdKm: 20, coarseStepSec: 60, workers: 4, algorithm: 'FOSTER', fineTolSec: 0.001, combinedRadiusM: 10 } };
}

/**
 * The events as bytes: each CQREvent packed and size-prefixed, concatenated. The embedded message's CREATION_DATE (the
 * wall clock at the screen) and MESSAGE_ID (built from it) are left out: two screens of one input differ only there.
 */
export function eventBytes(events) {
  const parts = events.map((e) => {
    if (e.CONJUNCTION_MESSAGE) Object.assign(e.CONJUNCTION_MESSAGE, { CREATION_DATE: null, MESSAGE_ID: null });
    const b = new flatbuffers.Builder(4096);
    b.finishSizePrefixed(e.pack(b));
    return b.asUint8Array().slice();
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? here(`fixtures/ocm-sets/xp-screen-ca-${version}.events`);
  const sdnAp = await sdnApHarness('browser', here('../../../propagator/sdn-ap/dist/isomorphic/module.wasm'), { surface: 'direct' });
  const conjunction = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  const flow = await screenOcmSets({ conjunction, sdnAp }, xpScreen());
  const bytes = eventBytes(flow.events);
  fs.writeFileSync(out, bytes);
  console.log(`${out}: ${flow.events.length} events, ${bytes.length} bytes, ${flow.refused.length} refused`);
  await conjunction.destroy?.();
  sdnAp.destroy?.();
}
