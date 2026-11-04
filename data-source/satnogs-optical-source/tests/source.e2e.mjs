#!/usr/bin/env node
// E2E (task modules-satnogs-optical-source-20261104): SatNOGS Optical session 2026-09-21, Sentinel-6B (NORAD 66514), the first
// night of its six-night arc, through read_station_night in the SDK's browser harness. The fixture is that object's rows cut
// from the captured measurements.parquet with every column (tests/fixtures/PROVENANCE.md), and the night's station file.
// - the harness reads the Parquet rows at run time (tests/parquet.mjs, a format reader) and converts them, as the SDN host flow
//   does, into the station-night's $TDM (angles, epochs, epoch convention) and one $EOO per row (name, sigma, site, bias);
// - the module's $TDM observations for 66514 number exactly the Parquet rows for 66514 (counted here, never hard-coded), and
//   so do its $EOO; the first observation's RA and Dec equal the first row's to 1e-9 degrees, its sigma is the row's;
// - every epoch is the row's moved by the declared epoch_refers_to offset (exposure-mid: 0 ns), TIMETAG_REF RECEIVE; with
//   the same rows declared exposure-start with a 1 s exposure, every epoch moves by +0.5 s exactly;
// - the IngestRequest tags equal the licence strings, the $PVN is Observation / ShareAlike / CC-BY-SA-4.0;
// - a quarantined row is refused with its name (and with quarantine fail, the night is refused naming it);
// - no USER_DEFINED anywhere: common/tests/no-user-defined.mjs decodes only $OMM and $OCM, so every record here is checked for
//   a USER_DEFINED field in its pinned schema and in its unpacked object.
// JS only moves bytes, formats calendar epochs and compares numbers the module produced.
//   cd data-source/satnogs-optical-source && node tests/source.e2e.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, ByteBuffer } from 'flatbuffers';
import { TDM, TDMT } from 'spacedatastandards.org/lib/js/TDM/TDM.js';
import { TDMSegmentT } from 'spacedatastandards.org/lib/js/TDM/TDMSegment.js';
import { TDMObservationT } from 'spacedatastandards.org/lib/js/TDM/TDMObservation.js';
import { EOO, EOOT } from 'spacedatastandards.org/lib/js/EOO/EOO.js';
import { GST } from 'spacedatastandards.org/lib/js/GST/GST.js';
import { PVN } from 'spacedatastandards.org/lib/js/PVN/PVN.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { decodeFlowNotice, decodeIngestRequest, encodeModuleConfig } from 'space-data-module-sdk/runtime-contracts';
import { readParquet } from './parquet.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8'));
const standards = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const NORAD = 66514;
const SESSION = '2026-09-21';
const CREDIT = 'SatNOGS Optical contributors - https://optical.satnogs.org - CC BY-SA 4.0';
const type = (schemaName, fileIdentifier, rootTypeName) => ({ schemaName, fileIdentifier, rootTypeName, wireFormat: 'flatbuffer' });
const TDM_T = type('TDM.fbs', '$TDM', 'TDM'), EOO_T = type('EOO.fbs', '$EOO', 'EOO'), MCFG = type('ModuleConfig.fbs', 'MCFG', 'ModuleConfig');

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x));

// The rows, read at run time.
const parquet = readParquet(here('./fixtures/satnogs-optical-2026-09-21-66514.parquet'));
const station = JSON.parse(fs.readFileSync(here('./fixtures/station-11.json'), 'utf8'));
const C = parquet.columns;
check(parquet.units.t_utc === 'us', `t_utc unit ${parquet.units.t_utc}`);
const rows = [...Array(parquet.rows).keys()]
  .filter((i) => C.correlation_object_norad_id[i] === NORAD && C.session[i] === SESSION)
  .map((i) => Object.fromEntries(Object.keys(C).map((k) => [k, C[k][i]])))
  .sort((a, b) => (a.t_utc < b.t_utc ? -1 : a.t_utc > b.t_utc ? 1 : 0));

// Calendar formatting: microseconds since 1970 (UTC) as "YYYY-MM-DDTHH:MM:SS.ffffff"; and an epoch back to nanoseconds.
const iso = (us) => `${new Date(Number(us / 1000n)).toISOString().slice(0, 19)}.${String(us % 1000000n).padStart(6, '0')}`;
const nanos = (s) => BigInt(Date.parse(`${s.slice(0, 19)}Z`)) * 1000000n + BigInt((s.slice(20) || '0').padEnd(9, '0'));
const REF = { 'exposure-mid': 'MIDDLE', 'exposure-start': 'START' };

// The SDN host flow's conversion of a station-night's rows: one segment per run of rows sharing track, epoch convention and
// quarantine flag; one $EOO per row in the same order.
function batch(input, { exposureSeconds = 0 } = {}) {
  const tdm = new TDMT();
  tdm.CREATION_DATE = station.generated_utc.replace(/Z$/, '');
  tdm.ORIGINATOR = 'LIBRE_SPACE_FOUNDATION';
  const eoos = [];
  let seg = null, key = '';
  for (const r of input) {
    const k = `${r.track_id}|${r.epoch_refers_to}|${r.quarantined}`;
    if (k !== key) {
      seg = new TDMSegmentT();
      Object.assign(seg, { TIME_SYSTEM: 'UTC', PARTICIPANT_1: `SATNOGS-OPTICAL-${String(r.station_id).padStart(4, '0')}`, PARTICIPANT_2: String(r.correlation_object_norad_id ?? r.correlation_unk_designation),
        MODE: 'SEQUENTIAL', PATH: '2,1', ANGLE_TYPE: 'RADEC', REFERENCE_FRAME: r.frame === 'ICRS' ? 'ICRF' : r.frame, TRACK_ID: String(r.track_id),
        INTEGRATION_REF: REF[r.epoch_refers_to] ?? null, INTEGRATION_INTERVAL: exposureSeconds, DATA_QUALITY: r.quarantined ? 'DEGRADED' : 'RAW' });
      tdm.SEGMENTS.push(seg);
      key = k;
    }
    const epoch = iso(r.t_utc);
    seg.OBSERVATIONS.push(new TDMObservationT('ANGLE_1', epoch, r.ra_deg), new TDMObservationT('ANGLE_2', epoch, r.dec_deg));
    const e = new EOOT();
    Object.assign(e, { ID: r.measurement_client_uuid, OB_TIME: epoch, IMAGE_SET_ID: String(r.track_id), SENSOR_ID: String(r.station_id), ORIG_SENSOR_ID: station.station.name,
      NORAD_CAT_ID: r.correlation_object_norad_id ?? 0, UCT: r.correlation_object_norad_id === null, RA: r.ra_deg, DECLINATION: r.dec_deg,
      RA_UNC: r.sigma_ra_arcsec / 3600, DECLINATION_UNC: r.sigma_dec_arcsec / 3600, SENLAT: station.station.site.lat, SENLON: station.station.site.lon,
      SENALT: station.station.site.height_m / 1000, TIMING_BIAS: r.bias_applied_ms / 1000, EXP_DURATION: exposureSeconds, SNR: r.snr ?? 0 });
    const b = new Builder(1024);
    EOO.finishEOOBuffer(b, e.pack(b));
    eoos.push({ portId: 'measurements', typeRef: EOO_T, payload: b.asUint8Array() });
  }
  const b = new Builder(1 << 16);
  TDM.finishTDMBuffer(b, tdm.pack(b));
  return [{ portId: 'angles', typeRef: TDM_T, payload: b.asUint8Array() }, ...eoos];
}

const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(here('../dist/isomorphic/module.wasm')), manifest, surface: 'direct' });
const run = (inputs) => host.invoke({ methodId: 'read_station_night', inputs });
const quarantinedRow = rows[10];
const withQuarantine = rows.map((r) => (r === quarantinedRow ? { ...r, quarantined: true } : r));
const startRows = rows.map((r) => ({ ...r, epoch_refers_to: 'exposure-start' }));
const result = await run(batch(rows));
const quarantined = await run(batch(withQuarantine));
const strict = await run([...batch(withQuarantine), { portId: 'config', typeRef: MCFG, payload: encodeModuleConfig({ quarantine: 'fail' }) }]);
const started = await run(batch(startRows, { exposureSeconds: 1 }));
await host.destroy();
for (const [name, r] of Object.entries({ result, quarantined, started })) {
  if (r.statusCode !== 0) {
    console.error(`SATNOGS OPTICAL SOURCE: FAIL (${name} invoke ${r.statusCode}: ${r.errorMessage})`);
    process.exit(1);
  }
}
const frames = (r, port) => r.outputs.filter((f) => f.portId === port).map((f) => new Uint8Array(f.payload));
const tdms = (r) => frames(r, 'observations').map((b) => TDM.getRootAsTDM(new ByteBuffer(b)).unpack());
const angles = (list, keyword) => list.filter((t) => t.SEGMENTS[0].PARTICIPANT_2 === String(NORAD)).flatMap((t) => t.SEGMENTS[0].OBSERVATIONS.filter((o) => o.KEYWORD === keyword));

const out = tdms(result);
const ra = angles(out, 'ANGLE_1'), dec = angles(out, 'ANGLE_2');
const eoo = frames(result, 'uncertainty').map((b) => EOO.getRootAsEOO(new ByteBuffer(b)).unpack());
check(rows.length > 0, 'no Parquet rows for the object and night');
check(ra.length === rows.length && dec.length === rows.length, `$TDM observations ${ra.length} RA / ${dec.length} Dec vs ${rows.length} Parquet rows`);
check(eoo.length === rows.length, `$EOO ${eoo.length} vs ${rows.length} Parquet rows`);
check(Math.abs(ra[0].VALUE - rows[0].ra_deg) <= 1e-9 && Math.abs(dec[0].VALUE - rows[0].dec_deg) <= 1e-9, `first RA/Dec ${ra[0]?.VALUE} ${dec[0]?.VALUE} vs ${rows[0].ra_deg} ${rows[0].dec_deg}`);
check(eoo[0].ID === rows[0].measurement_client_uuid && Math.abs(eoo[0].RA_UNC * 3600 - rows[0].sigma_ra_arcsec) < 1e-3 && Math.abs(eoo[0].DECLINATION_UNC * 3600 - rows[0].sigma_dec_arcsec) < 1e-3,
  `first $EOO ${eoo[0]?.ID} sigma ${eoo[0]?.RA_UNC * 3600} ${eoo[0]?.DECLINATION_UNC * 3600} arcsec vs ${rows[0].sigma_ra_arcsec} ${rows[0].sigma_dec_arcsec}`);
const declared = { 'exposure-mid': 0n };
const shifts = new Set(ra.map((o, i) => String(nanos(o.EPOCH) - nanos(iso(rows[i].t_utc)) - declared[rows[i].epoch_refers_to])));
check(shifts.size === 1 && shifts.has('0'), `epochs differ from the rows' plus the declared offset by ${[...shifts].join(', ')} ns`);
check(eoo.every((e, i) => e.OB_TIME === ra[i].EPOCH), 'an $EOO epoch is not its observation epoch');
check(out.every((t) => t.SEGMENTS[0].TIMETAG_REF === 'RECEIVE' && t.SEGMENTS[0].ANGLE_TYPE === 'RADEC' && [t.OBSERVER_X, t.OBSERVER_Y, t.OBSERVER_Z].every(Number.isFinite)), 'TIMETAG_REF, ANGLE_TYPE or OBSERVER_X/Y/Z');
const moved = angles(tdms(started), 'ANGLE_1');
const startShift = new Set(moved.map((o, i) => String(nanos(o.EPOCH) - nanos(iso(rows[i].t_utc)))));
check(moved.length === rows.length && startShift.size === 1 && startShift.has('500000000'), `exposure-start with a 1 s exposure moved by ${[...startShift].join(', ')} ns, not 500000000`);

const ingest = frames(result, 'ingest').map(decodeIngestRequest);
const tags = ingest[0]?.tags ?? {};
check(ingest.length === 1 && ingest[0].schema === 'TDM.fbs', `${ingest.length} IngestRequest, schema ${ingest[0]?.schema}`);
check(tags.license === 'CC-BY-SA-4.0' && tags.licenseUrl === 'https://creativecommons.org/licenses/by-sa/4.0/' && tags.citation === CREDIT && tags.sourceName === 'satnogs-optical' && tags.shareAlike === true,
  `IngestRequest tags ${json(tags)}`);
check(tags.citation === station.licence.credit && tags.license === station.licence.spdx && tags.licenseUrl === station.licence.url, 'IngestRequest tags differ from the station file licence');
check(ingest[0]?.provenance?.attributes.some((a) => a.name === 'class' && a.value === 'publish-with-credit'), 'IngestRequest provenance class publish-with-credit');
const pvn = frames(result, 'provenance').map((b) => PVN.getRootAsPVN(new ByteBuffer(b)).unpack());
check(pvn.length === 1 && pvn[0].SOURCE_ID === 'satnogs-optical' && pvn[0].SOURCE_KIND === 3 && pvn[0].ORIGINATOR === 'SATNOGS-OPTICAL-0011' && pvn[0].LICENSE_CLASS === 3 && pvn[0].LICENSE_ID === 'CC-BY-SA-4.0',
  `PVN ${json(pvn[0])}`);
const gst = frames(result, 'stations').map((b) => GST.getRootAsGST(new ByteBuffer(b)).unpack());
check(gst.length === 1 && gst[0].CLOCK_OFFSET_S === rows[0].bias_applied_ms / 1000 && gst[0].POSITION_X === out[0].OBSERVER_X && gst[0].POSITION_Z === out[0].OBSERVER_Z && gst[0].NAME === station.station.name,
  `station record ${json(gst[0])}`);

const refusedNotice = decodeFlowNotice(frames(quarantined, 'report')[0]);
const name = quarantinedRow.measurement_client_uuid;
check(refusedNotice.items.some((s) => s.startsWith(`refused.${name}=quarantined`)), `quarantined row ${name} not refused by name`);
check(angles(tdms(quarantined), 'ANGLE_1').length === rows.length - 1 && tdms(quarantined).length === 1, 'the quarantined row was emitted, or its track split');
check(strict.statusCode !== 0 && strict.errorMessage.includes(name), `quarantine fail: ${strict.statusCode} ${strict.errorMessage}`);

// No USER_DEFINED anywhere: not in the pinned schemas of what is emitted, not in any record.
for (const family of ['TDM', 'EOO', 'GST', 'PVN']) check(!/USER_DEFINED/.test(fs.readFileSync(path.join(standards, 'schema', family, 'main.fbs'), 'utf8')), `${family} schema has a USER_DEFINED field`);
const userDefined = (o) => o && typeof o === 'object' && Object.entries(o).some(([k, v]) => /USER_DEFINED/i.test(k) || userDefined(v));
const records = [...out, ...eoo, ...gst, ...pvn, ...ingest];
for (const [i, record] of records.entries()) check(!userDefined(record), `record ${i} carries USER_DEFINED`);

console.log(`session ${SESSION} NORAD ${NORAD}: Parquet rows ${rows.length}, $TDM observations ${ra.length} in ${out.length} track(s), $EOO ${eoo.length}; first RA ${ra[0]?.VALUE} Dec ${dec[0]?.VALUE} (row ${rows[0].ra_deg} ${rows[0].dec_deg}); epoch shift ${[...shifts].join(',')} ns (${rows[0].epoch_refers_to}), exposure-start 1 s ${[...startShift].join(',')} ns; tags ${tags.license} ${tags.citation}; quarantined ${name} refused; USER_DEFINED none in ${records.length} records`);
if (failures.length) {
  console.error(`SATNOGS OPTICAL SOURCE: FAIL (${failures.length})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('SATNOGS OPTICAL SOURCE: PASS');
