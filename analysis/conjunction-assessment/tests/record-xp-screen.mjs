#!/usr/bin/env node
// Records tests/fixtures/ocm-sets/xp-screen-ca-<version>.events, the SGP4XP reference of tests/ocm-sets-screening.e2e.mjs:
// screenOcmSets on the registered SGP4XP sets alone (xp as recorded and d, the turned SGP4XP set; both carry covariance)
// over one day from xp's epoch, 20 km, FOSTER, TEME, with this package's dist and propagator/sdn-ap's. Each event
// (CQREvent through the SDS object API) is written size-prefixed, in the order the screen returns them, its embedded
// message's wall-clock CREATION_DATE and MESSAGE_ID left out (eventBytes). Recorded once
// with conjunction-assessment 0.18.1 (dist module.wasm sha256
// daeb52c798a0cea6098cfb6a65cef51ecd49663a621586ec5de07ac1a5885133, propagator/sdn-ap 0.6.2), before the AP covariance
// gate: an SGP4XP pair's events stay these bytes.
// With --no-covariance, both sets with their covariance removed: tests/fixtures/ocm-sets/xp-no-covariance-screen-ca-0.18.2.events,
// recorded once with conjunction-assessment 0.18.2 (dist module.wasm sha256
// 863b6372f80837fa992c71ebd1d906546069e286e0dbbfcbd223a9d82bdcb451, propagator/sdn-ap 0.6.2), before the covariance
// producer gate: a pair without covariance stays these bytes.
// With --other-theory, the pair with covariance and a third set, U (xp retyped MEAN_ELEMENT_THEORY USM, its covariance
// kept, no PVN.PRODUCER: an operator's file), on no list: tests/fixtures/ocm-sets/xp-other-theory-screen-ca-0.18.3.events,
// recorded once with conjunction-assessment 0.18.3 (dist module.wasm sha256
// 1d406d23b8a393169d1207507729e5b84cf91cc341ff52391b7c57822b8cde5e, propagator/sdn-ap 0.6.2), before the no-producer
// gate: a set of another theory with no producer stays as 0.18.3 screened it. JS only moves bytes.
//   node tests/record-xp-screen.mjs [--no-covariance | --other-theory] [out]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { OCM } from 'spacedatastandards.org/lib/js/OCM/OCM.js';
import { meanElementSource } from 'spacedatastandards.org/lib/js/CQR/main.js';
import { createStandaloneHarness as sdnApHarness } from '../../../propagator/sdn-ap/node_modules/space-data-module-sdk/src/testing/isomorphicHarness.js';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { screenOcmSets } from '../src/js/ocmSetScreen.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const version = JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8')).version;
const fixture = (name) => new Uint8Array(fs.readFileSync(here(`fixtures/ocm-sets/${name}-fit-sdn-ap-0.5.2.ocm`)));

/** A set with its covariance removed through the SDS object API (identity and elements unchanged). */
export function withoutCovariance(bytes) {
  const t = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();
  Object.assign(t, { COVARIANCE_DATA: [], COV_SIZE: 0, COV_PARAMETER_KINDS: [], COV_PROPAGATION: null, COV_REALISM: [],
    COV_REF_FRAME: null, COV_TYPE: null, COV_ORDERING: null, COV_PARAMETERS: [], COV_UNITS: [], COV_CALIBRATION: null });
  const b = new flatbuffers.Builder(8192);
  OCM.finishOCMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}

/** U: xp as another theory's set (MEAN_ELEMENT_THEORY USM) with its covariance and no producer, its own identity. */
export function otherTheorySet(bytes) {
  const t = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();
  Object.assign(t.METADATA, { INTERNATIONAL_DESIGNATOR: '2026-904U', OBJECT_DESIGNATOR: '90407', NORAD_CAT_ID: 90407, OBJECT_NAME: 'USM E2E U' });
  t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = meanElementSource.USM;
  Object.assign(t.PROVENANCE, { PRODUCER: null, PRODUCER_SHA256: null });
  const b = new flatbuffers.Builder(8192);
  OCM.finishOCMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}

/**
 * The SGP4XP screen: its sets, window and controls (tests/ocm-sets-screening.e2e.mjs screens the same). covariance
 * false: both sets with their covariance removed (withoutCovariance). otherTheory: U (otherTheorySet) as a third set.
 */
export function xpScreen({ covariance = true, otherTheory = false } = {}) {
  const xp = fixture('xp'), d = fixture('d');
  const epoch = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(xp)).MEAN_ELEMENTS().EPOCH();
  const sets = covariance ? [xp, d] : [xp, d].map(withoutCovariance);
  if (otherTheory) sets.push(otherTheorySet(xp));
  return { sets, window: { startJd: Date.parse(`${epoch}Z`) / 86400000 + 2440587.5, durationDays: 1 },
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
  const covariance = !process.argv.includes('--no-covariance'), otherTheory = process.argv.includes('--other-theory');
  const out = process.argv.slice(2).find((x) => !x.startsWith('--'))
    ?? here(`fixtures/ocm-sets/xp-${covariance ? '' : 'no-covariance-'}${otherTheory ? 'other-theory-' : ''}screen-ca-${version}.events`);
  const sdnAp = await sdnApHarness('browser', here('../../../propagator/sdn-ap/dist/isomorphic/module.wasm'), { surface: 'direct' });
  const conjunction = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  const flow = await screenOcmSets({ conjunction, sdnAp }, xpScreen({ covariance, otherTheory }));
  const bytes = eventBytes(flow.events);
  fs.writeFileSync(out, bytes);
  console.log(`${out}: ${flow.events.length} events, ${bytes.length} bytes, ${flow.refused.length} refused`);
  for (const r of flow.refused) console.log(`  refused ${r.objectId} ${r.theory}: ${r.code}: ${r.message}`);
  for (const r of flow.covarianceRefused) console.log(`  covariance refused ${r.objectId}: ${r.code}`);
  await conjunction.destroy?.();
  sdnAp.destroy?.();
}
