#!/usr/bin/env node
// E2E (modules-ca-screens-ap-ocm-sets-20261105): $OCM element sets screened on their own theory (README, "$OCM element
// sets"). The registered sets, tests/fixtures/ocm-sets/*-fit-sdn-ap-0.5.2.ocm (tests/record-ocm-sets.mjs): the AP and
// SGP4XP $OCM of sdn-ap `fit` on its own fixture inputs, and two sets turned across A's plane and refitted by sdn-ap
// from their own flights, so each carries the covariance of its own fit (an epoch covariance belongs to its elements);
// here, through the SDS object API, an identity, one more turned set with no covariance, a theory retyped, the weather
// rows removed, and one SGP4 $OMM. Every sdn-ap flight here is sdn-ap 0.6.34's dist (git 0e365d3f, its SHA-256 checked):
// from 0.6.36 sdn-ap refuses an AP record that states another gravity field than its own, so the AP sets A and B (and C, F
// and G, made from A) would be refused there; the SGP4XP sets still fly on it. A turn puts the set's plane across A's and its perigee and phase at the crossing
// (the plane intersection of two orbits of one inclination; the sets' own mean motion keeps the crossing each revolution):
//   A  the AP set as recorded (covariance carried);
//   B  the AP set turned by RA_OF_ASC_NODE + 90 deg and refitted: a fast encounter (about 8.6 km/s) each revolution;
//   C  A turned by RA_OF_ASC_NODE - 90 deg, its covariance removed (no refit);
//   D  the SGP4XP set turned by RA_OF_ASC_NODE + 60 deg and refitted (its theory drifts from A's over the day);
//   E  an SGP4 $OMM on A's elements turned by RA_OF_ASC_NODE - 60 deg (the built-in SGP4);
//   F  A retyped MEAN_ELEMENT_THEORY DSST: refused by the flow by name, theory-not-screened:DSST, no flight;
//   G  A with its SPACE_WEATHER rows removed: sdn-ap's refusal passes through by name, weather-rows-missing.
// Three screens over one day from A's epoch, 20 km, FOSTER, TEME:
//   existing way: A-D flown by sdn-ap `propagate` (OUTPUT.EPOCHS: the block of explicit lines the module reads) and
//                 given to screen_catalog as EPHEMERIS sources, E as a MEAN_ELEMENTS source, the request as the
//                 module's tests build one (tests/lib/cqr.mjs, flatc JSON), drained here; once at the flow's 30 s grid
//                 (gated) and once at 10 s (recorded: the arms then differ by the JD double's 40 us resolution at a
//                 sample epoch, 0.3 m at 7.6 km/s, which cancels between two sources on one grid);
//   $OCM path:    the same records through screenOcmSets (flights at OCM_SET_FLIGHT.stepSeconds, 30 s).
// Acceptance: the same encounters (every event of one arm matched by pair to one of the other within 1 s); miss
// distances within CA_PARITY_TOLERANCES.missDistance.aerospaceHardFailM (0.10 m, independent-parity); NLRV TCAs within
// tca.NLRV.hardFailSec (10 ms; LRV and VLRV recorded, not gated, as the tolerance file says); the covariance labels equal
// in both arms and as the sets say: both bases SOURCE_EPHEMERIS where both sets carry covariance and, where the module
// writes a probability, SUPPLIED_COVARIANCE by FOSTER (a probability it cannot represent is omitted, README); basis NONE
// for a set without covariance and MAXIMUM_PROBABILITY_ONLY for its events; at least one covariance-pair event with a
// probability in both arms, the values compared (advisory, as the tolerance file labels Pc); F and G refused by name.
// The $OCM path above lists the sets' producer build (PVN.PRODUCER of the registered sets, sdn-ap's) on
// CONTROLS.VERIFIED_COVARIANCE_PRODUCERS. Covariance producer gate (modules-ca-gate-by-covariance-producer-20261106):
//   the same records through screenOcmSets on an empty list, on a list without the sets' producer, and on no list:
//   A, B (AP) and D (SGP4XP), the sets with covariance, screen without it, each named once in covarianceRefused with
//   pc-covariance-unverified:<PVN.PRODUCER>; all 104 events (every pair holds A) carry that PROBABILITY_REFUSAL, A's,
//   B's and D's COVARIANCE_BASIS NONE, no probability from covariance (the covariance-free maximum only), the miss
//   distance and TCA of the listed screen exactly; A x B's and A x D's 30 events each had a Pc on the list and have
//   none here; the three screens' events byte-identical (eventBytes);
//   hash: A stamped PVN.PRODUCER_SHA256 H and B stamped H', on a list naming another producer string with H and the
//   sets' producer string with a third hash: A passes on the hash, B is refused on it (the hash decides where both
//   state one), D (no hash) passes on its producer string: A x D's events keep their Pc, A x B's carry B's refusal
//   and none;
//   SGP4XP fitted by sdn-ap (tests/record-xp-screen.mjs: xp and d, both with covariance): on no list, both refused by
//   producer, every event refused naming it, no Pc, miss distance and TCA of the events 0.18.1 wrote
//   (tests/fixtures/ocm-sets/xp-screen-ca-0.18.1.events) exactly; on the producer's list, those events byte for byte;
//   SGP4XP without covariance (both sets' covariance removed; no list): the events 0.18.2 wrote, byte for byte
//   (tests/fixtures/ocm-sets/xp-no-covariance-screen-ca-0.18.2.events);
//   dist/build-provenance.json names the shipped dist/isomorphic/module.wasm's sha256.
// No producer stated (modules-ca-no-producer-refusal-20261106):
//   AP: A without PVN.PRODUCER, with B, C, D and E on the producer's list: A alone refused,
//   pc-covariance-unverified:(no producer); every event (each holds A) carries it, no Pc, A's basis NONE, miss distance
//   and TCA of the listed screen exactly;
//   SGP4XP: xp and d without PVN.PRODUCER on the producer's list: both refused "(no producer)", 30 of 30 events, no Pc,
//   miss distance and TCA as 0.18.1 wrote them exactly;
//   PRODUCER_SHA256 alone: A (AP) and D (SGP4XP) and B (AP) stating only a hash, on a list with A's hash: A passes, B
//   and D are refused naming sha256:<hash> (A x B and A x D: 30 of 30 refused, no Pc; A x C and A x E none refused);
//   xp and d stating only a listed hash: 0.18.1's events byte for byte;
//   another theory: U (xp retyped USM, covariance kept, no producer) beside xp and d on no list: refused by name,
//   theory-not-screened:USM, and the events 0.18.3 wrote byte for byte
//   (tests/fixtures/ocm-sets/xp-other-theory-screen-ca-0.18.3.events).
// JS builds records with the SDS object API, moves bytes and compares what the modules produced.
//   node tests/ocm-sets-screening.e2e.mjs
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { OCM } from 'spacedatastandards.org/lib/js/OCM/OCM.js';
import { CQREvent, CQRVerifiedCovarianceProducerT, CelestialFrame, CelestialFrameWrapperT, OMM, OMMT, RFMT, RFMUnion, cqrCovarianceBasis, cqrUncertaintyOrigin, meanElementSource, timingStandard } from 'spacedatastandards.org/lib/js/CQR/main.js';
import { PCFT, PCFOutputT, pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/main.js';
import { createStandaloneHarness as sdnApHarness } from '../../../propagator/sdn-ap/node_modules/space-data-module-sdk/src/testing/isomorphicHarness.js';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { CA_PARITY_TOLERANCES, relVelStratum } from './lib/caParityTolerances.mjs';
import { decodeCqr, earthFrame, encodeCqr, initCqrFlatc, parseFlatcJson, publishedSchema, screeningControls } from './lib/cqr.mjs';
import { COVARIANCE_REFUSAL, NO_PRODUCER, OCM_SET_FLIGHT, screenOcmSets } from '../src/js/ocmSetScreen.mjs';
import { eventBytes, xpScreen } from './record-xp-screen.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name, wireFormat: 'flatbuffer' });
// The sdn-ap build the registered sets fly through: the AP sets are sdn-ap 0.5.2 fits that state GRAVITY_MODEL EGM-96,
// which sdn-ap refuses from 0.6.36 (its field is EGM2008, SPEC 16.2), so the screen flies every set through 0.6.34's dist,
// the newest that flies them, read from git and its SHA-256 checked. Its two SGP4XP byte comparisons against the 0.18.1
// events fail there as on main without the pin (stack #536).
const SDN_AP_PIN = { version: '0.6.34', commit: '0e365d3f730e7c1a77e6b869c8b1e62e26692ba5', sha256: 'a18f1243180471e254da8cb7e692d3d8cae9944821f04f9ba3b3e026be9b65cc' };
const SDN_AP_VERSION = SDN_AP_PIN.version;
const sdnApPinned = (() => {
  const bytes = execFileSync('git', ['-C', here('../../..'), 'show', `${SDN_AP_PIN.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== SDN_AP_PIN.sha256) throw new Error(`sdn-ap ${SDN_AP_PIN.version} pin: sha256 ${got}, expected ${SDN_AP_PIN.sha256}`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-sdn-ap-')), `sdn-ap-${SDN_AP_PIN.version}.wasm`);
  fs.writeFileSync(file, bytes);
  return file;
})();

// The registered sets and their derivations (bytes through the object API; nothing computed).
const fixture = (name) => new Uint8Array(fs.readFileSync(here(`fixtures/ocm-sets/${name}-fit-sdn-ap-0.5.2.ocm`)));
const ocmOf = (bytes) => OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();
function derived(bytes, { id, norad, name, raan = 0, argp = 0, ma = 0, edit = () => {} }) {
  const t = ocmOf(bytes);
  Object.assign(t.METADATA, { INTERNATIONAL_DESIGNATOR: id, OBJECT_DESIGNATOR: String(norad), NORAD_CAT_ID: norad, OBJECT_NAME: name });
  t.MEAN_ELEMENTS.RA_OF_ASC_NODE += raan;
  t.MEAN_ELEMENTS.ARG_OF_PERICENTER += argp;
  t.MEAN_ELEMENTS.MEAN_ANOMALY += ma;
  edit(t);
  const b = new flatbuffers.Builder(8192);
  OCM.finishOCMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}
const withoutCovariance = (t) => Object.assign(t, { COVARIANCE_DATA: [], COV_SIZE: 0, COV_PARAMETER_KINDS: [], COV_PROPAGATION: null, COV_REALISM: [],
  COV_REF_FRAME: null, COV_TYPE: null, COV_ORDERING: null, COV_PARAMETERS: [], COV_UNITS: [], COV_CALIBRATION: null });
// Plane crossings of two orbits of inclination 52.887 deg whose nodes differ by dRAAN: the second set reaches the
// intersection line du of argument of latitude after the first (dRAAN +90: -62.213; -90: +62.213; +60: -38.413; -60:
// +38.413). The turn goes on ARG_OF_PERICENTER, so both sets pass the crossing at one true anomaly and one radius (at
// e 0.0008 a mean-anomaly turn leaves a radial gap of up to 2 a e, 5.7 km); B and D also carry the phase that leaves
// the measured miss (record-ocm-sets.mjs TURNS, tuned once against the module; 0.001 deg is 0.16 s, about 1 km).
const OFFSETS = Object.freeze({
  C: { raan: -90, argp: 62.213 },
  E: { raan: -60, argp: 38.413 },
});
const ap = fixture('ap'), xp = fixture('xp');
const a = ocmOf(ap);
const A = ap;
const B = derived(fixture('b'), { id: '2026-904B', norad: 90401, name: 'AP E2E B' });
const C = derived(ap, { id: '2026-904C', norad: 90402, name: 'AP E2E C', ...OFFSETS.C, edit: withoutCovariance });
const D = derived(fixture('d'), { id: '2026-904D', norad: 90403, name: 'XP E2E D' });
const F = derived(ap, { id: '2026-904F', norad: 90405, name: 'AP E2E F', edit: (t) => { t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = meanElementSource.DSST; } });
const G = derived(ap, { id: '2026-904G', norad: 90406, name: 'AP E2E G', edit: (t) => { t.PERTURBATIONS.SPACE_WEATHER = []; } });
// The producer build lists: the sets' own PVN.PRODUCER (no hash: the registered sets carry none); hashes for the hash screen.
const PRODUCER = a.PROVENANCE.PRODUCER;
const OTHER_PRODUCER = `com.spacedatanetwork.sdn-ap-propagator ${SDN_AP_VERSION}`;
const [H, H_B, H_LISTED] = ['a', 'b', 'c'].map((x) => x.repeat(64));
const listed = (...entries) => entries.map(([producer, sha256]) => new CQRVerifiedCovarianceProducerT(producer, sha256, 'modules-ca-gate-by-covariance-producer-20261106'));
const reprovenanced = (bytes, pvn) => {
  const m = ocmOf(bytes).METADATA;
  return derived(bytes, { id: m.INTERNATIONAL_DESIGNATOR, norad: m.NORAD_CAT_ID, name: m.OBJECT_NAME, edit: (t) => { Object.assign(t.PROVENANCE, pvn); } });
};
const stamped = (bytes, sha256) => reprovenanced(bytes, { PRODUCER_SHA256: sha256 });
const A_H = stamped(A, H), B_H = stamped(B, H_B);
const unnamed = (bytes, sha256 = null) => reprovenanced(bytes, { PRODUCER: null, PRODUCER_SHA256: sha256 });
const E = (() => {
  const me = a.MEAN_ELEMENTS;
  const t = Object.assign(new OMMT(), { OBJECT_NAME: 'SGP4 E2E E', OBJECT_ID: '2026-904E', NORAD_CAT_ID: 90404, CENTER_NAME: 'EARTH', TIME_SYSTEM: timingStandard.UTC,
    REFERENCE_FRAME: new RFMT(RFMUnion.CelestialFrameWrapper, new CelestialFrameWrapperT(CelestialFrame.TEMEOFDATE), 0, 'TEMEOFDATE'),
    MEAN_ELEMENT_THEORY: meanElementSource.SGP4, EPOCH: me.EPOCH, MEAN_MOTION: me.MEAN_MOTION, ECCENTRICITY: me.ECCENTRICITY, INCLINATION: me.INCLINATION,
    RA_OF_ASC_NODE: me.RA_OF_ASC_NODE + OFFSETS.E.raan, ARG_OF_PERICENTER: me.ARG_OF_PERICENTER + OFFSETS.E.argp, MEAN_ANOMALY: me.MEAN_ANOMALY + (OFFSETS.E.ma ?? 0), BSTAR: 1e-4 });
  const b = new flatbuffers.Builder(1024);
  OMM.finishOMMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
})();
const COVARIANCE_SETS = new Set(['2026-904A', '2026-904B', '2026-904D']);
const identity = { '2026-904A': { name: a.METADATA.OBJECT_NAME, norad: a.METADATA.NORAD_CAT_ID }, '2026-904B': { name: 'AP E2E B', norad: 90401 },
  '2026-904C': { name: 'AP E2E C', norad: 90402 }, '2026-904D': { name: 'XP E2E D', norad: 90403 } };

// The window and controls of every screen.
const startJd = Date.parse(`${a.MEAN_ELEMENTS.EPOCH}Z`) / 86400000 + 2440587.5;
const window = { startJd, durationDays: 1 };
const controls = { thresholdKm: 20, coarseStepSec: 60, workers: 4, algorithm: 'FOSTER', fineTolSec: 0.001, combinedRadiusM: 10 };

const sdnAp = await sdnApHarness('browser', sdnApPinned, { surface: 'direct' });
const conjunction = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
const flatc = await initCqrFlatc();
const decodeRecord = (schema, bytes) => parseFlatcJson(flatc.generateJSON(publishedSchema(schema), { path: `/${schema}.bin`, data: bytes }, { defaultsJson: true }));
let frames = 0x0e2e000n;

// The existing way at a step: each set flown by sdn-ap over the window's instants (a RECORDS set flies from the day after
// its first weather row, so not before the window) and given as an EPHEMERIS source; the SGP4 $OMM a MEAN_ELEMENTS
// source; one CATALOG_REQUEST drained here.
function referencePcf(step) {
  const startMs = Math.round((startJd - 2440587.5) * 86400000), count = (window.durationDays * 86400) / step + 1;
  const epochs = Array.from({ length: count }, (_, k) => new Date(startMs + k * step * 1000).toISOString());
  const c = new PCFT();
  c.OUTPUT = new PCFOutputT(pcfOutputFrame.TEME, step, 500000, epochs);
  const b = new flatbuffers.Builder(1 << 18);
  b.finish(c.pack(b), '$PCF');
  return { pcf: b.asUint8Array().slice(), count };
}
async function fly(bytes, pcf) {
  const r = await sdnAp.invoke({ methodId: 'propagate', inputs: [{ portId: 'ocm', typeRef: T('OCM'), payload: bytes }, { portId: 'configuration', typeRef: T('PCF'), payload: pcf }] });
  if (r.statusCode !== 0) return { code: r.errorCode, message: r.errorMessage };
  const u = new Uint8Array(r.outputs.find((o) => o.portId === 'ephemeris').payload);
  const prefixed = String.fromCharCode(...u.subarray(8, 12)) === '$OEM';
  return { oem: decodeRecord('OEM', prefixed ? u.subarray(4) : u) };
}
async function existingWay(step) {
  const { pcf, count } = referencePcf(step), sources = [];
  for (const [id, bytes] of [['2026-904A', A], ['2026-904B', B], ['2026-904C', C], ['2026-904D', D]]) {
    const flown = await fly(bytes, pcf);
    if (!flown.oem) throw new Error(`existing way: ${id}: ${flown.code}: ${flown.message}`);
    const block = flown.oem.EPHEMERIS_DATA_BLOCK[0], cov = (block.COVARIANCE_MATRIX_LINES ?? []).length;
    check(block.EPHEMERIS_DATA_LINES.length === count && cov === (COVARIANCE_SETS.has(id) ? count : 0),
      `existing way at ${step} s: ${id} flown to ${block.EPHEMERIS_DATA_LINES.length} states, ${cov} covariance lines`);
    sources.push({ OBJECT_ID: id, OBJECT_NAME: identity[id].name, NORAD_CATALOG_ID: identity[id].norad, EPHEMERIS: flown.oem });
  }
  sources.push({ OBJECT_ID: '2026-904E', OBJECT_NAME: 'SGP4 E2E E', NORAD_CATALOG_ID: 90404, PROPAGATOR_PORT_ID: 'sgp4', MEAN_ELEMENTS: decodeRecord('OMM', E) });
  const record = { CATALOG_REQUEST: { PRIMARIES: sources, EVALUATION_FRAME: earthFrame('TEME'),
    CONTROLS: { ...screeningControls({ startJd, durationDays: window.durationDays, thresholdKm: controls.thresholdKm, coarseStepSec: controls.coarseStepSec,
      fineTolSec: controls.fineTolSec, combinedRadiusM: controls.combinedRadiusM, numThreads: controls.workers }), ALGORITHM: controls.algorithm } } };
  const inputs = [{ portId: 'request', typeRef: T('CQR'), payload: encodeCqr(flatc, record), frameId: ++frames }];
  const events = [], excluded = [];
  for (;;) {
    const r = await conjunction.invoke({ methodId: 'screen_catalog', inputs });
    if (r.statusCode !== 0) throw new Error(`existing way: screen_catalog: ${r.errorCode}: ${r.errorMessage}`);
    excluded.push(...r.outputs.filter((o) => o.portId === 'excluded'));
    const result = decodeCqr(flatc, new Uint8Array(r.outputs.find((o) => o.portId === 'result').payload)).CATALOG_RESULT;
    events.push(...(result.EVENTS ?? []));
    if (result.FINAL_CHUNK) return { events, excluded, statistics: result.STATISTICS };
  }
}

const t0 = performance.now();
const reference = await existingWay(OCM_SET_FLIGHT.stepSeconds);
const t1 = performance.now();
const flow = await screenOcmSets({ conjunction, sdnAp }, { sets: [A, B, C, D, F, G], catalog: [E], window,
  controls: { ...controls, verifiedCovarianceProducers: listed([PRODUCER, '']) } });
const t2 = performance.now();
const fine = await existingWay(10);
const t3 = performance.now();
console.log(`sdn-ap ${SDN_AP_VERSION}; existing way at ${OCM_SET_FLIGHT.stepSeconds} s ${((t1 - t0) / 1000).toFixed(1)} s, $OCM path ${((t2 - t1) / 1000).toFixed(1)} s, existing way at 10 s ${((t3 - t2) / 1000).toFixed(1)} s`);

// Refusals by name.
const refusedBy = (id) => flow.refused.find((r) => r.objectId === id);
check(flow.flights === 5, `flights attempted: ${flow.flights} (A, B, C, D and G; F never flies)`);
check(refusedBy('2026-904F')?.code === 'theory-not-screened:DSST', `F refused by the flow by name: ${refusedBy('2026-904F')?.code}`);
check(refusedBy('2026-904G')?.code === 'weather-rows-missing', `G refused by sdn-ap by name, passed through: ${refusedBy('2026-904G')?.code}: ${refusedBy('2026-904G')?.message}`);
check(flow.refused.length === 2, `refusals: ${flow.refused.length}`);
check(reference.excluded.length === 0 && flow.excluded.length === 0, `excluded records: ${reference.excluded.length} and ${flow.excluded.length}`);

// The same encounters: each event of one arm matched by pair to one of the other within 1 s, once.
const pairOf = (e) => [e.PRIMARY_ID, e.SECONDARY_ID].sort().join(' x ');
const named = (table, v) => (typeof v === 'string' ? v : table[v ?? 0]);
const ORIGIN = (e) => (e.PROBABILITY ? named(cqrUncertaintyOrigin, e.PROBABILITY.UNCERTAINTY_SOURCE) : 'NONE');
const BASIS = (e, id) => named(cqrCovarianceBasis, e.PRIMARY_ID === id ? e.PRIMARY_COVARIANCE_BASIS : e.SECONDARY_COVARIANCE_BASIS);
const ALGORITHM = (e) => (e.PROBABILITY ? named(cqrProbabilityAlgorithmNames, e.PROBABILITY.ALGORITHM) : 'NONE');
const cqrProbabilityAlgorithmNames = { 0: 'UNSPECIFIED', 1: 'FOSTER', 2: 'PATERA', 3: 'ALFANO_MAXIMUM', 4: 'CHAN', 5: 'ALFRIEND_1999', 6: 'ALFRIEND_1999_MAXIMUM', 7: 'ALFANO_2005', 8: 'LAAS_2015', 9: 'ALFRIEND_2D' };
function matchEvents(from, to) {
  const unmatched = new Set(to.map((_, i) => i)), matches = [];
  for (const e of from) {
    let best = null;
    for (const i of unmatched) {
      const f = to[i];
      if (pairOf(f) !== pairOf(e)) continue;
      const dt = Math.abs(f.TCA.JULIAN_DATE - e.TCA.JULIAN_DATE) * 86400;
      if (dt < 1 && (!best || dt < best.dt)) best = { i, dt, f };
    }
    if (best) { unmatched.delete(best.i); matches.push({ e, ...best }); }
  }
  return { matches, unmatched: unmatched.size };
}
const { matches, unmatched } = matchEvents(reference.events, flow.events);
const pairs = new Map();
for (const e of reference.events) { const p = pairs.get(pairOf(e)) ?? { n: 0, miss: [], speed: [] }; p.n++; p.miss.push(e.MISS_DISTANCE_M); p.speed.push(e.RELATIVE_SPEED_M_S); pairs.set(pairOf(e), p); }
const DESIGNED = ['2026-904A x 2026-904B', '2026-904A x 2026-904C', '2026-904A x 2026-904D', '2026-904A x 2026-904E'];
check(DESIGNED.every((p) => pairs.has(p)), `existing way: ${reference.events.length} events over ${pairs.size} pairs, the four crossings with A among them (AP, AP without covariance, SGP4XP, SGP4)`);
for (const [p, s] of pairs) console.log(`     ${p}: ${s.n} events, miss ${Math.min(...s.miss).toFixed(1)}..${Math.max(...s.miss).toFixed(1)} m, relative speed ${Math.min(...s.speed).toFixed(0)}..${Math.max(...s.speed).toFixed(0)} m/s`);
check(flow.events.length === reference.events.length && matches.length === reference.events.length && unmatched === 0,
  `the same encounters: ${matches.length} matched of ${reference.events.length} (existing way) and ${flow.events.length} ($OCM path)`);

// Miss distances, TCAs by relative-velocity stratum, labels, Pc.
const TOL = CA_PARITY_TOLERANCES;
function deltas(matched) {
  const strata = { NLRV: [], LRV: [], VLRV: [] };
  let maxMiss = 0;
  for (const { e, f, dt } of matched) { maxMiss = Math.max(maxMiss, Math.abs(f.MISS_DISTANCE_M - e.MISS_DISTANCE_M)); strata[relVelStratum(e.RELATIVE_SPEED_M_S / 1000)].push(dt); }
  const maxDt = (k) => (strata[k].length ? Math.max(...strata[k]) : 0);
  return { maxMiss, strata, maxDt };
}
const d30 = deltas(matches);
check(d30.maxMiss <= TOL.missDistance.aerospaceHardFailM, `miss distance: max |delta| ${(d30.maxMiss * 1000).toFixed(3)} mm over ${matches.length} events, within ${TOL.missDistance.aerospaceHardFailM} m (missDistance.aerospaceHardFailM)`);
check(d30.maxDt('NLRV') <= TOL.tca.NLRV.hardFailSec, `TCA, NLRV (${d30.strata.NLRV.length} events): max |delta| ${(d30.maxDt('NLRV') * 1000).toFixed(3)} ms, within ${TOL.tca.NLRV.hardFailSec * 1000} ms (tca.NLRV.hardFailSec)`);
console.log(`     TCA, LRV (${d30.strata.LRV.length} events): max |delta| ${(d30.maxDt('LRV') * 1000).toFixed(3)} ms; VLRV (${d30.strata.VLRV.length}): ${(d30.maxDt('VLRV') * 1000).toFixed(3)} ms (recorded, not gated)`);
const fineMatch = matchEvents(fine.events, flow.events), d10 = deltas(fineMatch.matches);
console.log(`     against the existing way at 10 s: ${fineMatch.matches.length} of ${fine.events.length} events matched; max |delta| miss ${(d10.maxMiss * 1000).toFixed(1)} mm, TCA ${(d10.maxDt('NLRV') * 1000).toFixed(2)} ms (recorded: the sample epochs' JD resolution, not gated)`);

let labelMismatch = 0, labelRule = 0, pcCompared = 0, maxPcRel = 0, pcAbsent = 0;
for (const { e, f } of matches) {
  const [p, s] = [e.PRIMARY_ID, e.SECONDARY_ID];
  if (ORIGIN(e) !== ORIGIN(f) || BASIS(e, p) !== BASIS(f, p) || BASIS(e, s) !== BASIS(f, s) || ALGORITHM(e) !== ALGORITHM(f)) labelMismatch++;
  const both = COVARIANCE_SETS.has(p) && COVARIANCE_SETS.has(s);
  const bases = [p, s].every((id) => BASIS(f, id) === (COVARIANCE_SETS.has(id) ? 'SOURCE_EPHEMERIS' : 'NONE'));
  const origin = both ? (f.PROBABILITY ? ORIGIN(f) === 'SUPPLIED_COVARIANCE' && ALGORITHM(f) === 'FOSTER' : true) : ORIGIN(f) === 'MAXIMUM_PROBABILITY_ONLY';
  if (!(bases && origin)) labelRule++;
  if (both) {
    if (!(e.PROBABILITY?.PROBABILITY > 0) || !(f.PROBABILITY?.PROBABILITY > 0)) pcAbsent++;
    else { pcCompared++; maxPcRel = Math.max(maxPcRel, Math.abs(f.PROBABILITY.PROBABILITY - e.PROBABILITY.PROBABILITY) / e.PROBABILITY.PROBABILITY); }
  }
}
check(labelMismatch === 0, `covariance labels equal in both arms (UNCERTAINTY_SOURCE, ALGORITHM, both COVARIANCE_BASIS): ${labelMismatch} differ`);
check(labelRule === 0, `covariance labels as the sets say (SOURCE_EPHEMERIS and, where written, SUPPLIED_COVARIANCE by FOSTER for covariance pairs; NONE and MAXIMUM_PROBABILITY_ONLY otherwise): ${labelRule} events differ`);
const covariancePairs = [...pairs.keys()].filter((k) => k.split(' x ').every((id) => COVARIANCE_SETS.has(id)));
check(covariancePairs.length === 2 && pcCompared >= 1, `Pc from the carried covariance: ${pcCompared} events of the ${covariancePairs.length} covariance pairs (${covariancePairs.join('; ')}) carry a probability in both arms (${pcAbsent} unrepresentable, omitted)`);
console.log(`     Pc, both arms: max relative difference ${maxPcRel.toExponential(3)} over ${pcCompared} events (advisory: pc.gated false; the existing way's records pass through flatc JSON text)`);
const sample = matches.filter(({ e }) => e.PROBABILITY?.PROBABILITY > 0 && COVARIANCE_SETS.has(e.PRIMARY_ID) && COVARIANCE_SETS.has(e.SECONDARY_ID)).sort((x, y) => y.e.PROBABILITY.PROBABILITY - x.e.PROBABILITY.PROBABILITY)[0];
if (sample) console.log(`     sample ${pairOf(sample.e)}: TCA ${sample.e.TCA.ISO8601 ?? sample.e.TCA.JULIAN_DATE}, miss ${sample.e.MISS_DISTANCE_M.toFixed(3)} m, relative speed ${sample.e.RELATIVE_SPEED_M_S.toFixed(1)} m/s, Pc ${sample.e.PROBABILITY.PROBABILITY.toExponential(6)} (existing way) and ${sample.f.PROBABILITY.PROBABILITY.toExponential(6)} ($OCM path)`);

// The covariance producer gate: every set with covariance here states sdn-ap's producer, AP or SGP4XP alike.
const SUPPLIED = (e) => e.PROBABILITY && ORIGIN(e) === 'SUPPLIED_COVARIANCE';
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const listedBytes = eventBytes(flow.events);
const GATED = new Set(['2026-904A', '2026-904B', '2026-904D']), REFUSAL = `${COVARIANCE_REFUSAL}${PRODUCER}`;
const withGated = (e) => GATED.has(e.PRIMARY_ID) || GATED.has(e.SECONDARY_ID);
check(/^com\.spacedatanetwork\.sdn-ap-propagator \d+\.\d+\.\d+$/.test(PRODUCER) && REFUSAL === `pc-covariance-unverified:${PRODUCER}`,
  `the refusal names the covariance producer, not the theory: "${REFUSAL}"`);
check(flow.covarianceRefused.length === 0 && flow.events.every((e) => !e.PROBABILITY_REFUSAL), `listed producer (${PRODUCER}): ${flow.covarianceRefused.length} sets refused their covariance, ${flow.events.filter((e) => e.PROBABILITY_REFUSAL).length} events refused`);
const pcOf = (events, pair) => events.filter((e) => pairOf(e) === pair && SUPPLIED(e)).length;
const abPc = pcOf(flow.events, '2026-904A x 2026-904B'), adPc = pcOf(flow.events, '2026-904A x 2026-904D');
let gateBytes = null;
for (const [label, list] of [['empty list', []], [`a list without the sets' producer (${OTHER_PRODUCER})`, listed([OTHER_PRODUCER, ''])], ['no list', undefined]]) {
  const run = await screenOcmSets({ conjunction, sdnAp }, { sets: [A, B, C, D, F, G], catalog: [E], window,
    controls: list === undefined ? controls : { ...controls, verifiedCovarianceProducers: list } });
  const ids = run.covarianceRefused.map((x) => x.objectId).sort().join(', ');
  check(ids === '2026-904A, 2026-904B, 2026-904D' && run.covarianceRefused.every((x) => x.code === REFUSAL), `${label}: covariance refused for ${ids} (${[...new Set(run.covarianceRefused.map((x) => x.code))].join(' | ')})`);
  const m = matchEvents(flow.events, run.events);
  const gated = run.events.filter(withGated);
  const refusedEvents = gated.filter((e) => e.PROBABILITY_REFUSAL === REFUSAL).length;
  const otherRefusals = run.events.filter((e) => !withGated(e) && e.PROBABILITY_REFUSAL).length;
  check(m.matches.length === flow.events.length && run.events.length === flow.events.length && refusedEvents === gated.length && otherRefusals === 0,
    `${label}: ${refusedEvents} of ${gated.length} events with A, B or D carry PROBABILITY_REFUSAL "${REFUSAL}" (${run.events.length} events, ${m.matches.length} matched to the listed screen; ${otherRefusals} others refused)`);
  const supplied = gated.filter(SUPPLIED).length;
  const basisNone = gated.every((e) => [e.PRIMARY_ID, e.SECONDARY_ID].filter((id) => GATED.has(id)).every((id) => BASIS(e, id) === 'NONE'));
  const maxOnly = gated.every((e) => !e.PROBABILITY || ORIGIN(e) === 'MAXIMUM_PROBABILITY_ONLY');
  const abNow = pcOf(run.events, '2026-904A x 2026-904B'), adNow = pcOf(run.events, '2026-904A x 2026-904D');
  check(supplied === 0 && basisNone && maxOnly && abPc === 30 && abNow === 0 && adPc === 30 && adNow === 0,
    `${label}: ${supplied} events with A, B or D carry a probability from covariance; A's, B's and D's COVARIANCE_BASIS NONE: ${basisNone}; covariance-free maximum only: ${maxOnly}; events with a Pc listed and here: A x B ${abPc} and ${abNow}, A x D ${adPc} and ${adNow}`);
  let dMiss = 0, dTca = 0;
  for (const { e, f } of m.matches) { dMiss = Math.max(dMiss, Math.abs(f.MISS_DISTANCE_M - e.MISS_DISTANCE_M)); dTca = Math.max(dTca, Math.abs(f.TCA.JULIAN_DATE - e.TCA.JULIAN_DATE) * 86400); }
  check(dMiss === 0 && dTca === 0, `${label}: miss distance and TCA as the listed screen: max |delta| ${dMiss} m and ${dTca} s over ${m.matches.length} events`);
  const bytes = eventBytes(run.events);
  if (gateBytes === null) gateBytes = bytes;
  else check(sameBytes(bytes, gateBytes), `${label}: events byte-identical to the empty list's (${bytes.length} bytes)`);
  check(!sameBytes(bytes, listedBytes), `${label}: events differ from the listed screen's (${bytes.length} and ${listedBytes.length} bytes)`);
}

// The hash decides where both sides state one: A passes on H under another producer string, B fails on H_B under its own.
const hashed = await screenOcmSets({ conjunction, sdnAp }, { sets: [A_H, B_H, C, D], catalog: [E], window,
  controls: { ...controls, verifiedCovarianceProducers: listed([OTHER_PRODUCER, H], [PRODUCER, H_LISTED]) } });
const hRefused = hashed.covarianceRefused.map((x) => `${x.objectId} ${x.producerSha256.slice(0, 4)}...`).join(', ');
check(hashed.covarianceRefused.length === 1 && hashed.covarianceRefused[0].objectId === '2026-904B' && hashed.covarianceRefused[0].code === REFUSAL,
  `hash: covariance refused for ${hRefused} (A, hash H, passes on the hash under ${OTHER_PRODUCER})`);
const hAD = hashed.events.filter((e) => pairOf(e) === '2026-904A x 2026-904D'), hAB = hashed.events.filter((e) => pairOf(e) === '2026-904A x 2026-904B');
const hADpc = hAD.filter(SUPPLIED).length, hABrefused = hAB.filter((e) => e.PROBABILITY_REFUSAL === REFUSAL && !SUPPLIED(e)).length;
const listedAD = flow.events.filter((e) => pairOf(e) === '2026-904A x 2026-904D' && SUPPLIED(e)).length;
check(hAD.length === 30 && hADpc === listedAD && hAB.length === 30 && hABrefused === 30 && hAD.every((e) => !e.PROBABILITY_REFUSAL),
  `hash: A x D ${hADpc} of ${hAD.length} events with a Pc (listed screen ${listedAD}; D, no hash, passes on its producer string); A x B ${hABrefused} of ${hAB.length} refused for B, no Pc`);

// No producer stated: an AP or SGP4XP set's theory names its producer; a hash alone is matched on the hash.
const NO_PRODUCER_REFUSAL = `${COVARIANCE_REFUSAL}${NO_PRODUCER}`;
const geometry = (from, to) => {
  const m = matchEvents(from, to);
  let miss = 0, tca = 0;
  for (const { e, f } of m.matches) { miss = Math.max(miss, Math.abs(f.MISS_DISTANCE_M - e.MISS_DISTANCE_M)); tca = Math.max(tca, Math.abs(f.TCA.JULIAN_DATE - e.TCA.JULIAN_DATE) * 86400); }
  return { matched: m.matches.length, unmatched: m.unmatched, miss, tca };
};
const refusals = (run) => run.covarianceRefused.map((x) => `${x.objectId} ${x.code}`).sort().join(', ');
const np = await screenOcmSets({ conjunction, sdnAp }, { sets: [unnamed(A), B, C, D], catalog: [E], window,
  controls: { ...controls, verifiedCovarianceProducers: listed([PRODUCER, '']) } });
check(NO_PRODUCER_REFUSAL === 'pc-covariance-unverified:(no producer)' && refusals(np) === `2026-904A ${NO_PRODUCER_REFUSAL}`,
  `AP set with covariance and no producer, on the producer's list: covariance refused for ${refusals(np)}`);
const npGeometry = geometry(flow.events, np.events);
const npRefused = np.events.filter((e) => e.PROBABILITY_REFUSAL === NO_PRODUCER_REFUSAL).length, npPc = np.events.filter(SUPPLIED).length;
const npBases = np.events.every((e) => BASIS(e, '2026-904A') === 'NONE' && [e.PRIMARY_ID, e.SECONDARY_ID].filter((id) => id === '2026-904B' || id === '2026-904D').every((id) => BASIS(e, id) === 'SOURCE_EPHEMERIS'));
check(np.events.length === flow.events.length && npGeometry.matched === flow.events.length && npRefused === np.events.length && npPc === 0 && npBases && npGeometry.miss === 0 && npGeometry.tca === 0,
  `AP set with no producer: ${npRefused} of ${np.events.length} events carry "${NO_PRODUCER_REFUSAL}", ${npPc} with a Pc; A's basis NONE, B's and D's SOURCE_EPHEMERIS: ${npBases}; miss distance and TCA as the listed screen: max |delta| ${npGeometry.miss} m and ${npGeometry.tca} s over ${npGeometry.matched} events`);

const H_D = 'd'.repeat(64);
const sha = await screenOcmSets({ conjunction, sdnAp }, { sets: [unnamed(A, H), unnamed(B, H_B), C, unnamed(D, H_D)], catalog: [E], window,
  controls: { ...controls, verifiedCovarianceProducers: listed([OTHER_PRODUCER, H], [PRODUCER, H_LISTED]) } });
const SHA_B = `${COVARIANCE_REFUSAL}sha256:${H_B}`, SHA_D = `${COVARIANCE_REFUSAL}sha256:${H_D}`;
check(refusals(sha) === `2026-904B ${SHA_B}, 2026-904D ${SHA_D}`, `PRODUCER_SHA256 alone: covariance refused for ${refusals(sha)} (A, AP, passes on its listed hash)`);
const shaAB = sha.events.filter((e) => pairOf(e) === '2026-904A x 2026-904B'), shaAD = sha.events.filter((e) => pairOf(e) === '2026-904A x 2026-904D');
const shaRest = sha.events.filter((e) => !shaAB.includes(e) && !shaAD.includes(e));
const shaABrefused = shaAB.filter((e) => e.PROBABILITY_REFUSAL === SHA_B && !SUPPLIED(e)).length, shaADrefused = shaAD.filter((e) => e.PROBABILITY_REFUSAL === SHA_D && !SUPPLIED(e)).length;
const shaABasis = sha.events.every((e) => BASIS(e, '2026-904A') === 'SOURCE_EPHEMERIS');
const shaGeometry = geometry(flow.events, sha.events);
check(shaAB.length === 30 && shaABrefused === 30 && shaAD.length === 30 && shaADrefused === 30 && shaRest.every((e) => !e.PROBABILITY_REFUSAL) && shaABasis
  && sha.events.length === flow.events.length && shaGeometry.matched === flow.events.length && shaGeometry.miss === 0 && shaGeometry.tca === 0,
  `PRODUCER_SHA256 alone: A x B ${shaABrefused} of ${shaAB.length} and A x D (SGP4XP) ${shaADrefused} of ${shaAD.length} refused, no Pc; ${shaRest.filter((e) => e.PROBABILITY_REFUSAL).length} of the other ${shaRest.length} refused; A's basis SOURCE_EPHEMERIS: ${shaABasis}; miss distance and TCA as the listed screen: max |delta| ${shaGeometry.miss} m and ${shaGeometry.tca} s`);

// SGP4XP sets fitted by sdn-ap (xp and d, both with covariance): refused by producer on no list, with 0.18.1's geometry.
const eventsOf = (u) => {
  const out = [];
  for (let at = 0; at < u.length;) {
    const size = new DataView(u.buffer, u.byteOffset + at, 4).getUint32(0, true);
    out.push(CQREvent.getSizePrefixedRootAsCQREvent(new flatbuffers.ByteBuffer(u.slice(at, at + 4 + size))).unpack());
    at += 4 + size;
  }
  return out;
};
const xp018 = new Uint8Array(fs.readFileSync(here('fixtures/ocm-sets/xp-screen-ca-0.18.1.events'))), xp018Events = eventsOf(xp018);
const xpRun = await screenOcmSets({ conjunction, sdnAp }, xpScreen());
const xpIds = xpRun.covarianceRefused.map((x) => x.objectId).sort().join(', ');
const xpRefused = xpRun.events.filter((e) => e.PROBABILITY_REFUSAL === REFUSAL).length, xpPc = xpRun.events.filter(SUPPLIED).length;
const xpBasisNone = xpRun.events.every((e) => BASIS(e, e.PRIMARY_ID) === 'NONE' && BASIS(e, e.SECONDARY_ID) === 'NONE');
check(xpRun.covarianceRefused.length === 2 && xpRun.covarianceRefused.every((x) => x.code === REFUSAL) && xpRun.events.length === 30 && xpRefused === 30 && xpPc === 0 && xpBasisNone,
  `SGP4XP pair fitted by sdn-ap, no list: covariance refused for ${xpIds} (${[...new Set(xpRun.covarianceRefused.map((x) => x.code))].join(' | ')}); ${xpRefused} of ${xpRun.events.length} events refused, ${xpPc} with a Pc, both COVARIANCE_BASIS NONE: ${xpBasisNone}`);
const xm = matchEvents(xp018Events, xpRun.events);
let xpMiss = 0, xpTca = 0;
for (const { e, f } of xm.matches) { xpMiss = Math.max(xpMiss, Math.abs(f.MISS_DISTANCE_M - e.MISS_DISTANCE_M)); xpTca = Math.max(xpTca, Math.abs(f.TCA.JULIAN_DATE - e.TCA.JULIAN_DATE) * 86400); }
check(xp018Events.length === 30 && xm.matches.length === 30 && xm.unmatched === 0 && xpMiss === 0 && xpTca === 0,
  `SGP4XP pair fitted by sdn-ap, no list: miss distance and TCA as 0.18.1 wrote them: max |delta| ${xpMiss} m and ${xpTca} s over ${xm.matches.length} of ${xp018Events.length} events`);
const xpListed = await screenOcmSets({ conjunction, sdnAp }, (() => { const s = xpScreen(); s.controls.verifiedCovarianceProducers = listed([PRODUCER, '']); return s; })());
const xpListedBytes = eventBytes(xpListed.events), xpListedPc = xpListed.events.filter(SUPPLIED).length;
check(sameBytes(xpListedBytes, xp018) && xpListed.covarianceRefused.length === 0 && xpListedPc === 30,
  `SGP4XP pair fitted by sdn-ap, producer listed: ${xpListed.events.length} events (${xpListedPc} with a Pc), ${xpListedBytes.length} bytes, byte-identical to 0.18.1's ${xp018.length}: ${sameBytes(xpListedBytes, xp018)}`);

// SGP4XP sets without covariance: the events 0.18.2 wrote, byte for byte.
const xpBare018 = new Uint8Array(fs.readFileSync(here('fixtures/ocm-sets/xp-no-covariance-screen-ca-0.18.2.events')));
const xpBare = await screenOcmSets({ conjunction, sdnAp }, xpScreen({ covariance: false }));
const xpBareBytes = eventBytes(xpBare.events);
check(sameBytes(xpBareBytes, xpBare018) && xpBare.events.length === 30 && xpBare.covarianceRefused.length === 0 && xpBare.events.every((e) => !e.PROBABILITY_REFUSAL),
  `SGP4XP pair without covariance: ${xpBare.events.length} events, ${xpBare.covarianceRefused.length} refused, ${xpBareBytes.length} bytes, byte-identical to 0.18.2's ${xpBare018.length}: ${sameBytes(xpBareBytes, xpBare018)}`);

// SGP4XP sets with no producer stated: refused by theory on the producer's list; stating only a listed hash: 0.18.1's bytes.
const xpWith = (pvn, list, options) => { const s = xpScreen(options); s.sets = s.sets.map((x, i) => (i < 2 && pvn ? unnamed(x, pvn[i]) : x)); s.controls.verifiedCovarianceProducers = list; return s; };
const xpNp = await screenOcmSets({ conjunction, sdnAp }, xpWith([null, null], listed([PRODUCER, ''])));
const xpNpRefused = xpNp.events.filter((e) => e.PROBABILITY_REFUSAL === NO_PRODUCER_REFUSAL).length, xpNpPc = xpNp.events.filter(SUPPLIED).length;
const xpNpGeometry = geometry(xp018Events, xpNp.events);
check(xpNp.covarianceRefused.length === 2 && xpNp.covarianceRefused.every((x) => x.code === NO_PRODUCER_REFUSAL) && xpNp.events.length === 30 && xpNpRefused === 30 && xpNpPc === 0
  && xpNpGeometry.matched === 30 && xpNpGeometry.unmatched === 0 && xpNpGeometry.miss === 0 && xpNpGeometry.tca === 0,
  `SGP4XP pair with covariance and no producer, on the producer's list: covariance refused for ${refusals(xpNp)}; ${xpNpRefused} of ${xpNp.events.length} events refused, ${xpNpPc} with a Pc; miss distance and TCA as 0.18.1 wrote them: max |delta| ${xpNpGeometry.miss} m and ${xpNpGeometry.tca} s over ${xpNpGeometry.matched} events`);
const xpSha = await screenOcmSets({ conjunction, sdnAp }, xpWith([H, H], listed([OTHER_PRODUCER, H])));
const xpShaBytes = eventBytes(xpSha.events);
check(xpSha.covarianceRefused.length === 0 && xpSha.events.filter(SUPPLIED).length === 30 && sameBytes(xpShaBytes, xp018),
  `SGP4XP pair stating only a listed hash: ${xpSha.covarianceRefused.length} refused, ${xpSha.events.filter(SUPPLIED).length} events with a Pc, ${xpShaBytes.length} bytes, byte-identical to 0.18.1's ${xp018.length}: ${sameBytes(xpShaBytes, xp018)}`);

// Another theory with covariance and no producer (an operator's file): as 0.18.3 screened it, byte for byte.
const other018 = new Uint8Array(fs.readFileSync(here('fixtures/ocm-sets/xp-other-theory-screen-ca-0.18.3.events')));
const other = await screenOcmSets({ conjunction, sdnAp }, xpScreen({ otherTheory: true }));
const otherBytes = eventBytes(other.events), otherU = other.refused.find((r) => r.objectId === '2026-904U');
check(other.refused.length === 1 && otherU?.code === 'theory-not-screened:USM' && other.covarianceRefused.length === 2 && other.covarianceRefused.every((x) => x.code === REFUSAL)
  && other.events.length === 30 && sameBytes(otherBytes, other018),
  `another theory (USM) with covariance and no producer: refused by name ${otherU?.code}; ${other.events.length} events, ${otherBytes.length} bytes, byte-identical to 0.18.3's ${other018.length}: ${sameBytes(otherBytes, other018)}`);

// The shipped dist: build-provenance.json names the module.wasm sha256.
const distSha = crypto.createHash('sha256').update(fs.readFileSync(here('../dist/isomorphic/module.wasm'))).digest('hex');
const provenanceSha = JSON.parse(fs.readFileSync(here('../dist/build-provenance.json'), 'utf8')).wasmSha256;
check(provenanceSha === distSha, `dist/build-provenance.json wasmSha256 ${provenanceSha} equals dist/isomorphic/module.wasm sha256 ${distSha}`);

await conjunction.destroy?.();
sdnAp.destroy?.();
console.log(failures.length ? `FAIL ${failures.length}: ${failures.join(' | ')}` : 'PASS ocm-sets-screening');
process.exit(failures.length ? 1 : 0);
