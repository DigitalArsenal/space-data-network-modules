#!/usr/bin/env node
// Records tests/fixtures/ocm-sets/*-sdn-ap-<version>.ocm, the registered sets of tests/ocm-sets-screening.e2e.mjs:
//   ap, xp   the AP and SGP4XP $OCM propagator/sdn-ap `fit` writes on the inputs of its own 0.4.0 fixtures
//            (propagator/sdn-ap test/lib/fixture-inputs.mjs: 24 h of propagator/ffm's 550 km trajectory and daily $SPW
//            rows), under the forces its test/lib/ocm.mjs fits them with (AP: gravity caps 31 and 20, NRLMSISE-00 on the
//            rows; SGP4XP: stock);
//   b, d     an AP set and an SGP4XP set turned across A's plane (RA_OF_ASC_NODE, ARG_OF_PERICENTER and MEAN_ANOMALY
//            offsets through the SDS object API, the covariance removed: an epoch covariance belongs to its elements),
//            each the fit of the other theory's 24 h flight (sdn-ap `propagate`, GCRF, 60 s; sdn-ap `fit` under its own
//            forces): b fits AP to the turned SGP4XP set's flight, d fits SGP4XP to the turned AP set's flight, so each
//            carries a covariance with the residuals of a model mismatch, as A's (an FFM arc fitted by AP) does; a fit
//            of a theory's own flight leaves a covariance the screen reads as singular.
// JS only moves bytes.
//   node tests/record-ocm-sets.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { OCM } from 'spacedatastandards.org/lib/js/OCM/OCM.js';
import { PCFT, PCFOutputT, pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/main.js';
import { createStandaloneHarness } from '../../../propagator/sdn-ap/node_modules/space-data-module-sdk/src/testing/isomorphicHarness.js';
import { AP_FORCES, fixtureSets } from '../../../propagator/sdn-ap/test/lib/ocm.mjs';
import { XP_FORCES, configuration } from '../../../propagator/sdn-ap/test/lib/pcf.mjs';
import { inputs } from '../../../propagator/sdn-ap/test/lib/fixture-inputs.mjs';

/** The turned seeds: the second set reaches the plane intersection du of argument of latitude after the first (tests/ocm-sets-screening.e2e.mjs). */
export const TURNS = Object.freeze({
  b: { raan: 90, argp: -62.213, ma: -0.034, id: '2026-904B', norad: 90401, name: 'AP E2E B' },
  d: { raan: 60, argp: -38.413, ma: -0.021, id: '2026-904D', norad: 90403, name: 'XP E2E D' },
});

const sdnAp = (rel) => fileURLToPath(new URL(`../../../propagator/sdn-ap/${rel}`, import.meta.url));
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name, wireFormat: 'flatbuffer' });
const version = JSON.parse(fs.readFileSync(sdnAp('plugin-manifest.json'), 'utf8')).version;
const h = await createStandaloneHarness('browser', sdnAp('dist/isomorphic/module.wasm'), { surface: 'direct' });
const { ap, xp, rows } = await fixtureSets(h);

export function turned(bytes, { id, norad, name, raan, argp, ma }) {
  const t = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();
  Object.assign(t.METADATA, { INTERNATIONAL_DESIGNATOR: id, OBJECT_DESIGNATOR: String(norad), NORAD_CAT_ID: norad, OBJECT_NAME: name });
  t.MEAN_ELEMENTS.RA_OF_ASC_NODE += raan;
  t.MEAN_ELEMENTS.ARG_OF_PERICENTER += argp;
  t.MEAN_ELEMENTS.MEAN_ANOMALY += ma;
  Object.assign(t, { COVARIANCE_DATA: [], COV_SIZE: 0, COV_PARAMETER_KINDS: [], COV_PROPAGATION: null, COV_REALISM: [], COV_REF_FRAME: null, COV_TYPE: null,
    COV_ORDERING: null, COV_PARAMETERS: [], COV_UNITS: [], COV_CALIBRATION: null });
  const b = new flatbuffers.Builder(8192);
  OCM.finishOCMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}

async function refit(seed, theory) {
  const epoch = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(seed)).unpack().MEAN_ELEMENTS.EPOCH;
  const startMs = Date.parse(`${epoch}Z`);
  const epochs = Array.from({ length: 1441 }, (_, k) => new Date(startMs + k * 60000).toISOString());
  const c = new PCFT();
  c.OUTPUT = new PCFOutputT(pcfOutputFrame.GCRF, 60, 500000, epochs);
  const b = new flatbuffers.Builder(1 << 16);
  b.finish(c.pack(b), '$PCF');
  const flight = await h.invoke({ methodId: 'propagate', inputs: [{ portId: 'ocm', typeRef: T('OCM'), payload: seed }, { portId: 'configuration', typeRef: T('PCF'), payload: b.asUint8Array() }] });
  if (flight.statusCode !== 0) throw new Error(`propagate: ${flight.errorCode} ${flight.errorMessage}`);
  let oem = new Uint8Array(flight.outputs.find((o) => o.portId === 'ephemeris').payload);
  if (String.fromCharCode(...oem.subarray(8, 12)) === '$OEM') oem = oem.subarray(4);
  const fit = await h.invoke({ methodId: 'fit', inputs: [{ portId: 'ephemeris', typeRef: T('OEM'), payload: oem },
    theory === 'AP' ? configuration({ theory: 'AP', forces: AP_FORCES }) : configuration({ theory: 'SGP4XP', forces: XP_FORCES }),
    ...(theory === 'AP' ? [{ portId: 'space_weather', typeRef: T('SPW'), payload: rows.bytes }] : [])] });
  if (fit.statusCode !== 0) throw new Error(`fit: ${fit.errorCode} ${fit.errorMessage}`);
  return new Uint8Array(fit.outputs[0].payload);
}

const sets = { ap, xp, b: await refit(turned(xp, TURNS.b), 'AP'), d: await refit(turned(ap, TURNS.d), 'SGP4XP') };
for (const [name, bytes] of Object.entries(sets)) {
  const out = fileURLToPath(new URL(`fixtures/ocm-sets/${name}-fit-sdn-ap-${version}.ocm`, import.meta.url));
  fs.writeFileSync(out, bytes);
  const o = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();
  console.log(`${out}: ${bytes.length} bytes; ${o.METADATA.OBJECT_NAME} NORAD ${o.METADATA.NORAD_CAT_ID} theory ${o.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY} epoch ${o.MEAN_ELEMENTS.EPOCH} RAAN ${o.MEAN_ELEMENTS.RA_OF_ASC_NODE.toFixed(4)} argp ${o.MEAN_ELEMENTS.ARG_OF_PERICENTER.toFixed(4)} M ${o.MEAN_ELEMENTS.MEAN_ANOMALY.toFixed(4)} COV_SIZE ${o.COV_SIZE} RMS km ${o.ORBIT_DETERMINATION?.FIT_STATISTICS?.FIT_RMS_KM}`);
}
process.exit(0);
