#!/usr/bin/env node
// Synthetic orbit-determination fixtures, written from SGP4 truth.
//
// Why: operator ephemerides and CelesTrak SupGP fits are not licensed for
// redistribution, so this repository carries no copy of them. These files have
// the same formats and the same checks apply to them, but every number is
// invented here: an element set is chosen, propagate_state of propagator/sgp4
// (Vallado 2020-07-13, WGS-72, opsmode i) turns it into states, and the states
// are written in the provider's layout.
//
// Frames. The MEME files hold EME2000 axes. propagate_state answers in GCRF
// (TEME to GCRF by the vendored ERFA, checked against pyerfa in
// propagator/sgp4/tests/gcrfOutput.test.mjs); GCRF and EME2000 differ by the
// 23 mas frame bias, 0.8 m at LEO, which is far below every tolerance that
// reads these files. analysis/od rotates EME2000 to TEME itself with the
// IAU-76/FK5 chain, so a reader that took these states for TEME would be about
// 35 km out, the same error the real operator files expose.
//
// Reference elements. synthetic_reference_elements.csv stands in for a
// third-party fit of the same ephemeris (the role CelesTrak SupGP plays in the
// real suite): the truth elements with the mean anomaly moved by a fixed
// amount, about 2 to 3 km along track. Its RMS column is that element set
// scored against the truth states with the same SGP4.
//
// Run from the repository root; it overwrites the files it owns:
//   node analysis/od/scripts/synthetic-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { invokePiv, loadRawSgp4Module } from '../../../propagator/sgp4/tests/lib/pivInvokeHelper.mjs';
import {
  ReferenceFrame, decodePropagatorState, encodeOmmPayload, encodePropagatorBatchRequest,
} from '../../../propagator/sgp4/tests/lib/payloadEncoders.mjs';

const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const OMM_TYPE = { schemaName: 'orbpro.sds.omm', fileIdentifier: '$OMM', rootTypeName: 'OMM' };
const PROP_TYPE = { schemaName: 'orbpro.propagator.PropagatorBatchRequest', fileIdentifier: 'PROP', rootTypeName: 'PropagatorBatchRequest' };

const jdOf = (iso) => 2440587.5 + Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`) / 86400000;

// Km and km/s states of one element set at the given ISO epochs, in GCRF
// ("gcrf": EME2000 to 23 mas), TEME and the Earth-fixed frame ("ecef").
export async function sgp4States(elements, epochs) {
  const module = await loadRawSgp4Module();
  try {
    const ingest = invokePiv(module, { methodId: 'ingest_omm', inputs: [{ portId: 'omm', typeRef: OMM_TYPE, payload: encodeOmmPayload(elements) }] });
    if (ingest.response.STATUS_CODE !== 0) throw new Error(ingest.response.ERROR_MESSAGE);
    const at = (iso, outputFrame) => {
      const result = invokePiv(module, { methodId: 'propagate_state', outputStreamCap: 1, inputs: [{ portId: 'request', typeRef: PROP_TYPE,
        payload: encodePropagatorBatchRequest({ epoch: jdOf(iso), catalogNumbers: [elements.noradId], outputFrame }) }] });
      if (result.response.STATUS_CODE !== 0) throw new Error(result.response.ERROR_MESSAGE);
      const s = decodePropagatorState(result.outputPayloads[0].bytes);
      return [...s.position, ...s.velocity].map((v, i) => v / 1000);   // module units are m and m/s
    };
    return epochs.map((iso) => ({ iso, gcrf: at(iso, ReferenceFrame.ICRF), teme: at(iso, ReferenceFrame.TEME), ecef: at(iso, ReferenceFrame.ECEF) }));
  } finally {
    module.destroy?.();
  }
}

// ----- deterministic numbers ------------------------------------------------

// mulberry32: small, and the xor-shift steps keep nearby seeds apart.
function lcg(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '');
const epochsOf = (startIso, count, stepSeconds) => {
  const t0 = Date.parse(`${startIso}Z`);
  return Array.from({ length: count }, (_, k) => isoSeconds(t0 + k * stepSeconds * 1000));
};

// ----- MEME (SpaceX layout) --------------------------------------------------

const fixed = (v, d) => v.toFixed(d);
const sci = (v) => v.toExponential(10);
function dayOfYear(ms) {
  const d = new Date(ms), start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((ms - start) / 86400000) + 1;
}
const memeStamp = (iso) => {
  const ms = Date.parse(`${iso}Z`), d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(dayOfYear(ms), 3)}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.000`;
};
const headerStamp = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

// A positive semidefinite 6 x 6 covariance in UVW, lower triangle by rows, that
// grows with the age of the prediction. C = s(t)^2 L L^T for a fixed lower
// triangular L, so it is PSD whatever the numbers.
const L = [
  [6.4e-4, 0, 0, 0, 0, 0],
  [-5.0e-4, 5.3e-4, 0, 0, 0, 0],
  [2.1e-4, 1.2e-4, 9.0e-4, 0, 0, 0],
  [-1.0e-8, 1.5e-7, 2.0e-8, 3.4e-5, 0, 0],
  [2.0e-7, 4.0e-7, 3.0e-8, 1.1e-5, 3.1e-5, 0],
  [3.0e-8, 2.0e-8, 6.0e-7, 5.0e-6, 4.0e-6, 2.0e-6],
];
function covarianceRow(ageSeconds) {
  const s2 = (1 + ageSeconds / 3600) ** 2;
  const out = [];
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let c = 0;
      for (let k = 0; k <= j; k += 1) c += L[i][k] * L[j][k];
      out.push(c * s2);
    }
  }
  return out;
}

export function memeText({ createdIso, startIso, stepSeconds, states }) {
  const lines = [
    `created:${headerStamp(createdIso)}`,
    `ephemeris_start:${headerStamp(states[0].iso)} ephemeris_stop:${headerStamp(states.at(-1).iso)} step_size:${stepSeconds}`,
    'ephemeris_source:synthetic',
    'UVW',
  ];
  const t0 = Date.parse(`${startIso}Z`);
  for (const s of states) {
    const [x, y, z, vx, vy, vz] = s.gcrf;
    lines.push(`${memeStamp(s.iso)} ${[x, y, z].map((v) => fixed(v, 10)).join(' ')} ${[vx, vy, vz].map((v) => fixed(v, 10)).join(' ')}`);
    const cov = covarianceRow((Date.parse(`${s.iso}Z`) - t0) / 1000).map(sci);
    lines.push(cov.slice(0, 7).join(' '), cov.slice(7, 14).join(' '), cov.slice(14, 21).join(' '));
  }
  return `${lines.join('\n')}\n`;
}

// The ten objects of the Starlink-style suite. File names follow the operator's
// layout (MEME_<NORAD>_<NAME>_<designator>_Operational_<unix>_UNCLASSIFIED.txt);
// the numbers behind them are invented.
const STARLINK = [
  [67850, 'STARLINK-36840', '2026-034A', '1340142', '1463017380', '2026-05-14T01:42:42', '2026-05-14T02:02:54', 0.0200],
  [67851, 'STARLINK-36348', '2026-034B', '1340149', '1463017800', '2026-05-14T01:49:42', '2026-05-14T02:03:30', -0.0240],
  [67852, 'STARLINK-36276', '2026-034C', '1340141', '1463017320', '2026-05-14T01:41:42', '2026-05-14T02:03:34', 0.0270],
  [67853, 'STARLINK-36785', '2026-034D', '1340147', '1463017680', '2026-05-14T01:47:42', '2026-05-14T02:02:58', -0.0190],
  [67854, 'STARLINK-36608', '2026-034E', '1340145', '1463017560', '2026-05-14T01:45:42', '2026-05-14T02:03:11', 0.0220],
  [67855, 'STARLINK-36838', '2026-034F', '1340149', '1463017800', '2026-05-14T01:49:42', '2026-05-14T02:02:54', 0.0260],
  [67856, 'STARLINK-36843', '2026-034G', '1340142', '1463017380', '2026-05-14T01:42:42', '2026-05-14T02:02:54', -0.0210],
  [67857, 'STARLINK-36828', '2026-034H', '1340150', '1463017860', '2026-05-14T01:50:42', '2026-05-14T02:02:55', 0.0240],
  [67858, 'STARLINK-36837', '2026-034J', '1340140', '1463017260', '2026-05-14T01:40:42', '2026-05-14T02:02:54', -0.0250],
  [67859, 'STARLINK-36393', '2026-034K', '1340146', '1463017620', '2026-05-14T01:46:42', '2026-05-14T02:03:26', 0.0230],
].map(([noradId, name, objectId, designator, unix, startIso, createdIso, anomalyOffsetDeg], index) => {
  const r = lcg(1000 + index);
  return {
    file: `MEME_${noradId}_${name}_${designator}_Operational_${unix}_UNCLASSIFIED.txt`,
    startIso, createdIso, anomalyOffsetDeg,
    elements: {
      noradId, objectName: name, objectId, epoch: startIso,
      meanMotion: 15.2 + 0.1 * r(), eccentricity: 0.0001 + 0.00012 * r(), inclination: 53.0 + 0.2 * r(),
      raan: 250 + 12 * r(), argPericenter: 80 + 40 * r(), meanAnomaly: 360 * r(),
      bstar: 0.0002 + 0.0003 * r(), meanMotionDot: 0.0001 + 0.0002 * r(), meanMotionDdot: 0,
    },
  };
});

// ----- GLONASS-style SP3 (position only, Earth-fixed, GPS time) --------------

const GPS_MINUS_UTC_S = 18;   // leap seconds since 2017-01-01, in force in 2026
const GLONASS_SLOTS = [...Array.from({ length: 24 }, (_, i) => i + 1), 26];

export function glonassElements(slot, index, epochUtcIso) {
  const r = lcg(5000 + slot);
  const plane = Math.floor((slot - 1) / 8) % 3, inPlane = (slot - 1) % 8;
  return {
    noradId: 99100 + slot, objectName: `SYN-R${pad(slot)}`, objectId: `2026-997${String.fromCharCode(65 + (index % 26))}`, epoch: epochUtcIso,
    meanMotion: 2.1310 + 0.0004 * r(), eccentricity: 0.0003 + 0.0020 * r(), inclination: 64.7 + 0.2 * r(),
    raan: (30 + 120 * plane + 0.5 * r()) % 360, argPericenter: 360 * r(), meanAnomaly: (45 * inPlane + 15 * plane) % 360,
    bstar: 0, meanMotionDot: 0, meanMotionDdot: 0,
  };
}

// SP3-d, as the header description lays it out: 17 satellites per "+" line and
// per "++" line, five lines of each, "  0" in the unused cells.
export async function glonassSp3({ gpsStartIso = '2026-07-11T00:00:00', epochCount = 3, stepSeconds = 900 } = {}) {
  const gpsEpochs = epochsOf(gpsStartIso, epochCount, stepSeconds);
  const utcEpochs = gpsEpochs.map((iso) => isoSeconds(Date.parse(`${iso}Z`) - GPS_MINUS_UTC_S * 1000));
  const rows = [];
  for (const [index, slot] of GLONASS_SLOTS.entries()) {
    rows.push({ slot, states: await sgp4States(glonassElements(slot, index, utcEpochs[0]), utcEpochs) });
  }
  const start = new Date(`${gpsStartIso}Z`);
  const f6 = (v, w) => v.toFixed(6).padStart(w);
  const satIds = GLONASS_SLOTS.map((n) => `R${pad(n)}`);
  const plusLines = [], accLines = [];
  for (let k = 0; k < 5; k += 1) {
    const ids = satIds.slice(k * 17, (k + 1) * 17);
    const unused = Array(17 - ids.length).fill('  0');
    plusLines.push(`${k === 0 ? `+   ${String(satIds.length).padStart(2)}   ` : '+        '}${[...ids, ...unused].join('')}`);
    accLines.push(`++       ${[...ids.map(() => '  6'), ...unused].join('')}`);
  }
  const header = [
    `#dP${start.getUTCFullYear()} ${String(start.getUTCMonth() + 1).padStart(2)} ${String(start.getUTCDate()).padStart(2)} ${String(start.getUTCHours()).padStart(2)} ${String(start.getUTCMinutes()).padStart(2)} ${String(start.getUTCSeconds()).padStart(2)}.00000000 ${String(epochCount).padStart(7)} __u+U IGS20 FIT  SYN`,
    `## 2426 ${(518400).toFixed(8).padStart(15)} ${stepSeconds.toFixed(8).padStart(14)} 61231 0.0000000000000`,
    ...plusLines, ...accLines,
    '%c R  cc GPS ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
    '%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
    '%f  0.0000000  0.000000000  0.00000000000  0.000000000000000',
    '%f  0.0000000  0.000000000  0.00000000000  0.000000000000000',
    '%i    0    0    0    0      0      0      0      0         0',
    '%i    0    0    0    0      0      0      0      0         0',
    '/* SYNTHETIC GLONASS-STYLE ORBIT FILE: SGP4 TRUTH, NOT A PRODUCT OF ANY CENTRE',
    '/* POSITIONS ARE EARTH-FIXED (LABELLED IGS20), CLOCKS ARE INVENTED               ',
    '/* WRITTEN BY analysis/od/scripts/synthetic-fixtures.mjs                        ',
    '/* NO REAL GNSS DATA IN THIS FILE                                               ',
  ];
  const body = [];
  for (let k = 0; k < epochCount; k += 1) {
    const t = new Date(Date.parse(`${gpsEpochs[k]}Z`));
    body.push(`*  ${t.getUTCFullYear()} ${pad(t.getUTCMonth() + 1)} ${pad(t.getUTCDate())} ${String(t.getUTCHours()).padStart(2)} ${String(t.getUTCMinutes()).padStart(2)} ${String(t.getUTCSeconds()).padStart(2)}.00000000`);
    for (const { slot, states } of rows) {
      const [x, y, z] = states[k].ecef;
      // R01 keeps the SP3 absent-clock sentinel at the first epoch.
      const clock = slot === 1 && k === 0 ? '999999.999999' : f6(((slot * 37 + k * 11) % 400) / 10 - 12, 13);
      body.push(`PR${pad(slot)}${f6(x, 14)}${f6(y, 14)}${f6(z, 14)} ${clock}`);
    }
  }
  return { text: `${[...header, ...body, 'EOF'].join('\r\n')}\r\n`, rows };
}

// ----- Intelsat-style ECF ephemeris text ------------------------------------

export async function intelsatEcf() {
  const startUtc = '2026-07-10T23:53:00';
  const epochs = epochsOf(startUtc, 12, 1800);
  const e = { noradId: 99201, objectName: 'SYN-GEO-1', objectId: '2026-996A', epoch: startUtc, meanMotion: 1.002711, eccentricity: 0.00021,
    inclination: 0.062, raan: 148.0, argPericenter: 251.0, meanAnomaly: 0, bstar: 0, meanMotionDot: 0, meanMotionDdot: 0 };
  // Move the mean anomaly so the sub-satellite longitude is 302.00 E at the first epoch.
  const lon = (state) => (Math.atan2(state.ecef[1], state.ecef[0]) * 180 / Math.PI + 360) % 360;
  for (let pass = 0; pass < 2; pass += 1) {
    const [probe] = await sgp4States(e, epochs.slice(0, 1));
    e.meanAnomaly = (e.meanAnomaly + (302.0 - lon(probe)) + 360) % 360;
  }
  const states = await sgp4States(e, epochs);
  const stamp = (iso) => `${iso.slice(0, 10).replace(/-/g, '/')} ${iso.slice(11)}.000`;
  const cell = (v) => String(Number(v.toPrecision(9))).padStart(16);
  const lines = [
    'ECF Ephemeris for Intelsat SYN-GEO-1 / 302.00 deg E /  58.00 deg W',
    '',
    '                    UTC       ECF Pos.X       ECF Pos.Y       ECF Pos.Z',
    '                                 meters          meters          meters',
    '',
    ...states.map((s) => `${stamp(s.iso)}${s.ecef.slice(0, 3).map((v) => cell(v * 1000)).join('')}`),
  ];
  return { text: `${lines.join('\n')}\n`, states, elements: e };
}

// ----- OneWeb-style LTEF rows -------------------------------------------------
// The LTEF encoding is undecoded (the adapter's own summary says so): the
// columns after the three time fields are invented integers; the constant
// fields (4096, the zero run, the closing 16) keep the row's shape.
export function ltefRows() {
  const r = lcg(7000);
  const n = (span) => Math.floor(r() * span) - Math.floor(span / 3);
  const ids = [[7, 1467981201], [8, 1467981243], [10, 1467981260], [12, 1467981278], [15, 1467981294]];
  return `${ids.map(([id, t]) => [id, t, 1467979199, n(900), n(40), 1890 + n(12), 4096, 80000 + n(120000), n(260000), n(100), n(300), 2 + Math.floor(r() * 2), 0, 0, 0, 0, 16].join(',')).join('\n')}\n`;
}

const rms = (a, b) => Math.sqrt(a.reduce((sum, s, i) => sum + (s.teme[0] - b[i].teme[0]) ** 2 + (s.teme[1] - b[i].teme[1]) ** 2 + (s.teme[2] - b[i].teme[2]) ** 2, 0) / a.length);

const CSV_HEADER = 'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT,RMS,DATA_SOURCE';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`wrote ${path.relative(root, file)} (${text.length} bytes)`);
}

async function main() {
  const suite = path.join(root, 'analysis/od/tests/data/supgp-reference/starlink-synthetic');
  const csv = [CSV_HEADER];
  for (const object of STARLINK) {
    const epochs = epochsOf(object.startIso, 241, 60);
    const truth = await sgp4States(object.elements, epochs);
    write(path.join(suite, 'meme', object.file), memeText({ createdIso: object.createdIso, startIso: object.startIso, stepSeconds: 60, states: truth }));
    const e = object.elements;
    const reference = { ...e, meanAnomaly: (e.meanAnomaly + object.anomalyOffsetDeg + 360) % 360 };
    const scored = await sgp4States(reference, epochs);
    csv.push([
      e.objectName, e.objectId, `${e.epoch}.000000`, e.meanMotion.toFixed(8), e.eccentricity.toFixed(7), e.inclination.toFixed(4),
      e.raan.toFixed(4), e.argPericenter.toFixed(4), reference.meanAnomaly.toFixed(4), 0, 'U', e.noradId, 1, 1,
      e.bstar.toExponential(5), e.meanMotionDot.toExponential(5), 0, rms(scored, truth).toFixed(3), 'SpaceX-E',
    ].join(','));
  }
  write(path.join(suite, 'synthetic_reference_elements.csv'), `${csv.join('\n')}\n`);

  // analysis/catalog-synthesis reads element rows in the same layout: the first
  // two Starlink-style rows, an ISS-like row and a GLONASS-like row (invented
  // elements under the real catalog numbers, as the Vanguard rows there are).
  const row = (e, source, rmsKm) => [e.objectName, e.objectId, `${e.epoch}.000000`, e.meanMotion.toFixed(8), e.eccentricity.toFixed(7), e.inclination.toFixed(4),
    e.raan.toFixed(4), e.argPericenter.toFixed(4), e.meanAnomaly.toFixed(4), 0, 'U', e.noradId, 1, 1, e.bstar.toExponential(5), e.meanMotionDot.toExponential(5), 0, rmsKm, source].join(',');
  const iss = { noradId: 25544, objectName: 'SYN-ISS-LIKE', objectId: '1998-067A', epoch: '2026-07-13T12:00:00', meanMotion: 15.4891, eccentricity: 0.000612,
    inclination: 51.6312, raan: 170.2417, argPericenter: 291.4402, meanAnomaly: 21.1873, bstar: 0.00021, meanMotionDot: 0.00012, meanMotionDdot: 0 };
  const glonass = { noradId: 32393, objectName: 'SYN-GLONASS-LIKE', objectId: '2007-052A', epoch: '2026-07-11T23:59:42', meanMotion: 2.1310, eccentricity: 0.00231,
    inclination: 64.8302, raan: 73.1128, argPericenter: 232.5406, meanAnomaly: 250.1177, bstar: 0, meanMotionDot: 0, meanMotionDdot: 0 };
  const starlinkRows = STARLINK.slice(0, 2).map((o) => row(o.elements, 'SpaceX-E', '0.2'));
  write(path.join(root, 'analysis/catalog-synthesis/test/fixtures/reference-elements.csv'),
    `${[CSV_HEADER, ...starlinkRows, row(iss, 'ISS-E', '0.1'), row(glonass, 'GLONASS-RE', '0.3')].join('\n')}\n`);

  // GLONASS-style SP3: the OD native/wasm tests and the glonass source adapter.
  const sp3 = await glonassSp3();
  write(path.join(root, 'analysis/od/tests/data/glonass/synthetic_glonass.sp3.glo'), sp3.text);
  write(path.join(root, 'data-source/glonass-source/test/fixtures/synthetic_glonass.sp3.glo'), sp3.text);
  const r03 = sp3.rows.find((row) => row.slot === 3).states.map((s) => s.ecef.map((v) => v.toFixed(6)).join(' '));
  console.log('R03 ECEF km (paste into analysis/od/tests/test_wasm.mjs):', r03);
  // Intelsat-style ECF text, OneWeb-style LTEF rows.
  write(path.join(root, 'data-source/intelsat-source/test/fixtures/i_aor_e_302.00_is-21_20260710_235300.sample.txt'), (await intelsatEcf()).text);
  write(path.join(root, 'data-source/oneweb-source/test/fixtures/ltef.sample.csv'), ltefRows());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
