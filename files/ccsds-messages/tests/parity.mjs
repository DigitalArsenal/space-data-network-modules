// Tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of files/ccsds-messages 0.2.0: every one of
// its twenty methods on every message it reads and writes, in both syntaxes, plus the requests it must
// refuse. Identical request bytes must give byte-identical outputs, and the same exit class, in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
//
// The requests are the fixtures of tests/ndm_module.test.mjs: the KVN of each message and its NDM/XML twin
// (read_<m>), and the record each one reads to, written as KVN and as NDM/XML (write_<m>; the record is the
// module's own read in this process, so the write requests carry the very bytes the read lanes produce).
// The Blue Books' own text is not in the repository; these are the synthetic messages and the two AEM and
// three TDM figures the fixtures hold (fixtures/PROVENANCE.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createFlatc from 'flatc-wasm/module';
import { createBrowserModuleHarness, formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';

import { FORMAT, PORT, ncdInput, read as readRequest, recordInput, write as writeRequest } from './lib/ndm_frames.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const wasmPath = path.join(root, 'dist', 'isomorphic', 'module.wasm');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin-manifest.json'), 'utf8'));
const FIXTURES = path.join(root, 'fixtures');
const STANDARDS = path.join(root, 'node_modules', 'spacedatastandards.org', 'schema');

// [message, KVN fixture, NDM/XML twin or null]
const FIXTURE_MESSAGES = [
  ['OMM', 'ndm/ndm-omm-sgp4-covariance.kvn', 'ndm/ndm-omm-sgp4-covariance.xml'],
  ['OMM', 'ndm/ndm-omm-sgp4xp.kvn', 'ndm/ndm-omm-sgp4xp.xml'],
  ['OEM', 'ndm/ndm-oem-two-segments.kvn', 'ndm/ndm-oem-two-segments.xml'],
  ['OPM', 'ndm/ndm-opm-two-maneuvers.kvn', 'ndm/ndm-opm-two-maneuvers.xml'],
  ['OCM', 'ndm/ndm-ocm-blocks.kvn', 'ndm/ndm-ocm-blocks.xml'],
  ['CDM', 'ndm/ndm-cdm-full-covariance.kvn', 'ndm/ndm-cdm-full-covariance.xml'],
  ['APM', 'ndm/ndm-apm-states.kvn', 'ndm/ndm-apm-states.xml'],
  ['ACM', 'ndm/ndm-acm-blocks.kvn', 'ndm/ndm-acm-blocks.xml'],
  ['RDM', 'ndm/ndm-rdm-prediction.kvn', 'ndm/ndm-rdm-prediction.xml'],
  ['AEM', 'ccsds-504.0-B-2-figure-G-4-aem.txt', 'ccsds-504.0-B-2-figure-G-4-aem.xml'],
  ['AEM', 'ccsds-504.0-B-2-figure-G-5-aem-spinner.txt', 'ccsds-504.0-B-2-figure-G-5-aem-spinner.xml'],
  ['TDM', 'ccsds-503.0-B-2-figure-E-16-tdm-optical.txt', null],
  ['TDM', 'ccsds-503.0-B-2-figure-E-17-tdm-radar.txt', 'ccsds-503.0-B-2-figure-E-17-tdm-radar.xml'],
  ['TDM', 'ccsds-503.0-B-2-figure-E-18-tdm-phase.txt', 'ccsds-503.0-B-2-figure-E-18-tdm-phase.xml'],
];

// The module in this process (V8), only to make the records the write requests carry.
const local = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
async function readRecord(type, bytes) {
  const r = await local.invoke(readRequest(type, bytes, undefined));
  if (r.statusCode !== 0) throw new Error(`${type}: ${r.errorCode}: ${r.errorMessage}`);
  return r.outputs.find((o) => o.portId === PORT[type]).payload;
}

// flatc, for the two records no message reads to: an OMM with its object name emptied and a compact-form OEM.
const flatc = await createFlatc();
{
  const closure = [];
  const visit = (family) => {
    if (closure.includes(family)) return;
    closure.push(family);
    const text = fs.readFileSync(path.join(STANDARDS, family, 'main.fbs'), 'utf8');
    for (const m of text.matchAll(/^\s*include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs"/gm)) visit(m[1]);
  };
  visit('OMM'); visit('OEM');
  for (const dir of ['/schemas', '/in', '/out']) { try { flatc.FS.mkdir(dir); } catch { /* present */ } }
  for (const f of closure) {
    try { flatc.FS.mkdir(`/schemas/${f}`); } catch { /* present */ }
    flatc.FS.writeFile(`/schemas/${f}/main.fbs`, fs.readFileSync(path.join(STANDARDS, f, 'main.fbs'), 'utf8'));
  }
}
function decode(type, record) {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  flatc.FS.writeFile('/in/record.bin', view.getUint32(0, true) === record.length - 4 ? record.subarray(4) : record);
  if (flatc.callMain(['--no-warnings', '--json', '--strict-json', '--raw-binary', '--defaults-json', '-o', '/out', '-I', '/schemas', `/schemas/${type}/main.fbs`, '--', '/in/record.bin']) !== 0) throw new Error('flatc decode');
  return JSON.parse(flatc.FS.readFile('/out/record.json', { encoding: 'utf8' }).replace(/\bnan\b/g, 'null').replace(/\binf\b/g, 'null'));
}
function build(type, json) {
  flatc.FS.writeFile('/in/build.json', JSON.stringify(json));
  if (flatc.callMain(['--no-warnings', '--binary', '-o', '/out', '-I', '/schemas', `/schemas/${type}/main.fbs`, '/in/build.json']) !== 0) throw new Error('flatc build');
  return flatc.FS.readFile('/out/build.bin');
}

const cases = [];
const add = (id, request) => cases.push({ id, request });
for (const [type, kvnFile, xmlFile] of FIXTURE_MESSAGES) {
  const stem = path.basename(kvnFile).replace(/\.(kvn|txt)$/, '');
  const kvn = fs.readFileSync(path.join(FIXTURES, kvnFile));
  const record = await readRecord(type, kvn);
  add(`read-${stem}-kvn`, readRequest(type, kvn, FORMAT[type][0]));
  add(`write-${stem}-kvn`, writeRequest(type, record));
  if (xmlFile) {
    add(`read-${stem}-xml`, readRequest(type, fs.readFileSync(path.join(FIXTURES, xmlFile)), FORMAT[type][1]));
    add(`write-${stem}-xml`, writeRequest(type, record, FORMAT[type][1]));
  }
}

// What the module refuses: the error code and message are part of the output, so a lane that refused for another
// reason, or in other words, fails the comparison.
{
  const ommKvn = fs.readFileSync(path.join(FIXTURES, 'ndm/ndm-omm-sgp4-covariance.kvn'), 'utf8');
  const ommXml = fs.readFileSync(path.join(FIXTURES, 'ndm/ndm-omm-sgp4-covariance.xml'), 'utf8');
  const ommRecord = await readRecord('OMM', Buffer.from(ommKvn));
  add('refused-read-wrong-message-kvn', readRequest('OEM', Buffer.from(ommKvn), undefined));
  add('refused-read-wrong-message-xml', readRequest('OEM', Buffer.from(ommXml), undefined));
  add('refused-read-malformed-xml', readRequest('OMM', Buffer.from(ommXml.replace('</header>', '</heder>')), undefined));
  add('refused-read-bad-number', readRequest('OMM', Buffer.from(ommKvn.replace('ECCENTRICITY = 0.0003416', 'ECCENTRICITY = O.0003416')), undefined));
  add('refused-read-unknown-keyword', readRequest('OMM', Buffer.from(ommKvn.replace('OBJECT_ID', 'UNHEARD_OF = 1\nOBJECT_ID')), undefined));
  add('refused-read-duplicate-keyword', readRequest('OMM', Buffer.from(ommKvn.replace('CENTER_NAME = EARTH', 'CENTER_NAME = EARTH\nCENTER_NAME = MOON')), undefined));
  add('refused-read-missing-mandatory-keyword', readRequest('OMM', Buffer.from(ommKvn.replace(/^REF_FRAME = .*\n/m, '')), undefined));
  add('refused-read-two-messages', readRequest('OMM', Buffer.from(`${ommKvn}\n${ommKvn}`), undefined));
  add('refused-read-lone-stop-marker', readRequest('OMM', Buffer.from(ommKvn.replace('MEAN_ELEMENT_THEORY = SGP/SGP4\n', 'MEAN_ELEMENT_THEORY = SGP/SGP4\nMETA_STOP\n')), undefined));
  add('refused-read-descriptor-for-another-format', readRequest('OMM', Buffer.from(ommKvn), FORMAT.OEM[0]));
  add('refused-write-record-without-object-name', writeRequest('OMM', build('OMM', { ...decode('OMM', ommRecord), OBJECT_NAME: '' })));
  add('refused-write-compact-oem', writeRequest('OEM', build('OEM', {
    CCSDS_OEM_VERS: 3.0, CREATION_DATE: '2026-10-11T00:00:00', ORIGINATOR: 'TEST',
    EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: 'EARTH', START_TIME: '2026-10-11T00:00:00', STOP_TIME: '2026-10-11T00:02:00', STEP_SIZE: 60, STATE_VECTOR_SIZE: 6,
      EPHEMERIS_DATA: [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6] }],
  })));
  add('refused-write-descriptor-for-another-message', writeRequest('OMM', ommRecord, FORMAT.OEM[1]));
}
await local.destroy();

const plan = await normalizeParityFixture({
  name: 'files/ccsds-messages 0.2.0 methods',
  cases: cases.map((c) => ({ ...c, expect: 'ok', request: { ...c.request,
    inputs: c.request.inputs.map(({ payload, ...p }) => ({ ...p, payloadHex: Buffer.from(payload).toString('hex') })) } })),
});
const report = await runParityHarness({ wasmPath, plan, timeoutMs: 600000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(path.join(root, 'conformance'), { recursive: true });
fs.writeFileSync(path.join(root, 'conformance', 'parity.json'), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
