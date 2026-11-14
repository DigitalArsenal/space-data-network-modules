#!/usr/bin/env node
// E2E (task feature-entity-sensors-defaults-20261105): the roster's real source documents, recorded in
// tests/fixtures/cassette.json.gz (WMO OSCAR pages and satellite documents, the MediaWiki extracts of the ground-sensor pages, the
// CelesTrak SATCAT rows of the roster; provenance.json), through plan_sources and build_sensors in the SDK's browser harness, then
// every $SNR read back from the lane streams with the published bindings (spacedatastandards.org 1.279.0).
//   a. plan_sources plans each source document once;
//   b. every OSCAR channel table is read independently here (its own regexes) and the module's bands must equal it, for every
//      instrument on every platform; the record count equals platforms x instruments OSCAR lists;
//   c. Sentinel-1C (a SAR), MODIS on Terra (an imager with 36 bands) and the AN/FPS-85 (a ground radar) are decoded field by field;
//      the NORAD join is the SATCAT row's; the SAR look angles, the band centre and the radar numbers equal their quotes;
//   d. UNKNOWN IS ABSENT: every number of a ground record appears in a quote of its NOTES; unset positive quantities are 0, signed NaN;
//   e. a stale quote, a mistyped join (SATCAT launch date), a failed fetch each stop exactly the values that depend on them;
//   f. the lane metadata (IngestRequest), the provenance records and the report count what was emitted; no USER_DEFINED anywhere.
// Expected values come from the fixture documents and the SATCAT, never from the module's output.
//   cd data-source/sensor-definitions && node tests/sensor-definitions.e2e.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { build, cassette, frames, harness, here, itemMap, metas, notices, PEER, plan, pvns, records } from './run-module.mjs';

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };
const near = (a, b, label, rel = 1e-9) => check(Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-30), `${label}: ${a} vs ${b}`);
const C = 299792458;

const roster = fs.readFileSync(here('../src/roster.hpp'), 'utf8');
const platformBlock = roster.slice(roster.indexOf('kPlatforms[]'), roster.indexOf('// ---- Ground sensors'));
const platforms = [...platformBlock.matchAll(/\{"([a-z0-9_]+)", (\d+), (nullptr|"[A-Z-]+"), \{([^}]*)\}\}/g)].map((m) => ({
  oscar: m[1], norad: Number(m[2]), prefix: m[3] === 'nullptr' ? null : m[3].slice(1, -1), instruments: [...m[4].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]),
}));
check(platforms.length === 33, `roster parsed: ${platforms.length} platforms`);

const OSCAR = 'https://space.oscar.wmo.int/';
const satelliteDoc = (slug) => JSON.parse(cassette[`${OSCAR}api/v1/satellites/${slug}`].body).satellite[0];
const pageHtml = (slug) => cassette[`${OSCAR}instruments/view/${slug}`].body;
const satcat = (() => {
  const lines = cassette['https://celestrak.org/pub/satcat.csv'].body.trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => { const f = l.split(','); return Object.fromEntries(head.map((h, i) => [h, f[i]])); });
})();

// ---- a. The plan.
const host = await harness();
const planned = await plan(host);
check(planned.result.statusCode === 0, `plan_sources: ${planned.result.errorCode} ${planned.result.errorMessage}`);
const urls = planned.urls;
check(new Set(urls).size === urls.length, 'a URL is planned twice');
check(!urls.some(u => u.includes('celestrak.org')), 'SATCAT identity is read from stored CAT records, with no second CelesTrak request');
const instrumentSlugs = new Set(platforms.flatMap((p) => p.instruments));
check(urls.filter((u) => u.startsWith(`${OSCAR}api/v1/satellites/`)).length === platforms.length, 'one OSCAR satellite document per platform');
check(urls.filter((u) => u.startsWith(`${OSCAR}instruments/view/`)).length === instrumentSlugs.size, 'one OSCAR page per instrument');
check(urls.filter((u) => u.startsWith('https://en.wikipedia.org/w/api.php')).length === 6, 'six MediaWiki pages');
check(urls.every((u) => Object.hasOwn(cassette, u)), 'a planned URL is missing from the cassette');

// ---- b. Independent reading of the channel tables.
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&micro;|&mu;/g, 'µ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const UNIT = { nm: 1e-9, 'µm': 1e-6, 'μm': 1e-6, um: 1e-6 };
const wl = (s) => { const m = /^([\d.]+)\s*(nm|µm|μm|um)\b/.exec(s); return m ? Number(m[1]) * UNIT[m[2]] : null; };
const interval = (s) => { const m = /^([\d.]+)\s*-\s*([\d.]+)\s*(nm|µm|μm|um)\b/.exec(s); return m ? [Number(m[1]) * UNIT[m[3]], Number(m[2]) * UNIT[m[3]]] : null; };
function oracleBands(slug) {
  const table = /class="frequencytable">([\s\S]*?)<\/div>/.exec(pageHtml(slug));
  if (!table) return null;
  const trs = table[1].match(/<tr>[\s\S]*?<\/tr>/g);
  if (!trs) return null;
  const rows = trs.map((r) => [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => strip(c[1])));
  const first = rows.findIndex((r) => /^(\d|N\/A)/.test(r[0]));
  const header = rows[0].map((_, c) => rows.slice(0, first).map((r) => r[c] ?? '').join(' '));
  if (!header.some((h) => h.includes('Central'))) return null;  // a SAR mode table, not a channel table
  const out = [];
  for (const r of rows.slice(first)) {
    if (header[0] === 'No.') {  // ATMS: centre GHz and bandwidth MHz; offsets from f0 are not plain numbers
      if (!/^[\d.]+$/.test(r[1])) continue;
      const c = Number(r[1]) * 1e9, w = Number(r[2]) * 1e6;
      out.push({ low: c - w / 2, high: c + w / 2 });
      continue;
    }
    const centre = wl(r[0]);
    const iv = interval(r[1]) ?? (header[1].includes('Bandwidth') || header[1].includes('interval') ? null : null);
    const ivBw = interval(r[1]);
    const bw = header[1].includes('Bandwidth') ? wl(r[1]) : null;
    if (ivBw) out.push({ name: r[0], low: C / ivBw[1], high: C / ivBw[0] });
    else if (centre && bw) out.push({ name: r[0], low: C / (centre + bw / 2), high: C / (centre - bw / 2) });
    else if (centre) out.push({ name: r[0], low: C / centre, high: C / centre });
    void iv;
  }
  return out;
}

// ---- Run.
const result = await build(host, urls);
check(result.statusCode === 0, `build_sensors: ${result.errorCode} ${result.errorMessage}`);
const space = records(frames(result, 'space_records')[0]);
const ground = records(frames(result, 'ground_records')[0]);
const report = notices(result);
const info = itemMap(report.find((n) => n.reason === 'sensor-counts'));

// The record count: members x instruments OSCAR lists on the platform.
let expected = 0;
for (const p of platforms) {
  const listed = new Set(satelliteDoc(p.oscar)['satellite-instruments'].map((i) => i.instrument.slug));
  const members = p.prefix ? satcat.filter((r) => r.OBJECT_NAME.startsWith(p.prefix) && r.OBJECT_TYPE === 'PAY' && r.DECAY_DATE === '').length : satcat.filter((r) => Number(r.NORAD_CAT_ID) === p.norad).length;
  expected += members * p.instruments.filter((i) => listed.has(i)).length;
}
check(space.length === expected, `space records ${space.length} vs ${expected} (members x instruments OSCAR lists)`);
check(ground.length === 9, `ground records ${ground.length}`);
check(Number(info['records.space']) === space.length && Number(info['records.ground']) === ground.length, 'the report counts the records');
check(new Set([...space, ...ground].map((r) => r.snr.SENSOR_ID)).size === space.length + ground.length, 'SENSOR_ID is unique');
check(info['platforms.refused'] === '0' && info['claims.refused'] === '0', `refusals ${info['platforms.refused']}/${info['claims.refused']} on the recorded day`);
check(!notices(result).some((n) => n.reason === 'refused'), 'a Missing notice on the recorded day');

let tableBands = 0, tablesChecked = 0;
for (const slug of instrumentSlugs) {
  const bands = oracleBands(slug);
  if (!bands) continue;
  const mine = space.filter((r) => r.snr.SENSOR_ID.startsWith(`oscar:${slug}:`));
  check(mine.length > 0, `${slug}: no record`);
  for (const r of mine) {
    const got = r.snr.SPECTRAL_BANDS;
    check(got.length === bands.length, `${slug} ${r.snr.NORAD_CAT_ID}: ${got.length} bands vs ${bands.length} in the table`);
    got.forEach((b, i) => {
      if (!bands[i]) return;
      near(b.FREQ_LOW_HZ, bands[i].low, `${slug} band ${i} low`);
      near(b.FREQ_HIGH_HZ, bands[i].high, `${slug} band ${i} high`);
      check(b.FREQ_LOW_HZ > 0 && b.FREQ_LOW_HZ <= b.FREQ_HIGH_HZ, `${slug} band ${i}: low <= high, in Hz`);
      if (bands[i].name) check(b.NAME === bands[i].name, `${slug} band ${i} NAME ${b.NAME} vs ${bands[i].name}`);
    });
  }
  tableBands += bands.length * mine.length;
  tablesChecked += 1;
}
check(tablesChecked === 12, `${tablesChecked} channel-table instruments checked, expected 12`);
check(Number(info['bands.space']) >= tableBands, 'band count in the report');

// ---- c. Three records, field by field.
const byId = (id) => [...space, ...ground].find((r) => r.snr.SENSOR_ID === id)?.snr;
const sar = byId('oscar:sar_c_sentinel_1:62261');
check(!!sar, 'Sentinel-1C SAR record');
if (sar) {
  const row = satcat.find((r) => r.NORAD_CAT_ID === '62261');
  check(sar.NORAD_CAT_ID === 62261 && sar.OBJECT_ID === row.OBJECT_ID && sar.OBJECT_ID === '2024-235A', `SAR join ${sar.NORAD_CAT_ID} ${sar.OBJECT_ID}`);
  check(sar.TYPE === 19 && sar.EMISSION === 1, 'SAR type SAR, ACTIVE');
  check(sar.SPECTRAL_BANDS.length === 1 && sar.SPECTRAL_BANDS[0].DESIGNATION === 'C' && sar.SPECTRAL_BANDS[0].FREQ_LOW_HZ === 5.405e9 && sar.SPECTRAL_BANDS[0].FREQ_HIGH_HZ === 5.405e9, 'SAR band: C, 5.405 GHz (a centre only)');
  check(sar.FIELD_OF_VIEW.SHAPE_KIND === 3 && sar.FIELD_OF_VIEW.INNER_LOOK_ANGLE_DEG === 15 && sar.FIELD_OF_VIEW.OUTER_LOOK_ANGLE_DEG === 45, 'SAR look angles 15 to 45 degrees off-nadir');
  check(sar.RF === null && sar.OPTICAL === null && sar.MOUNTING === null && sar.SITE_ID === null, 'SAR: RF, optical, mounting, site absent');
  check(sar.PROVENANCE.SOURCE === 'WMO OSCAR/Space' && sar.PROVENANCE.SOURCE_URL === `${OSCAR}instruments/view/sar_c_sentinel_1` && /redistributed freely/.test(sar.PROVENANCE.LICENSE) && /WMO/.test(sar.PROVENANCE.ATTRIBUTION), 'SAR provenance and license');
  check(sar.PROVENANCE.RETRIEVED_AT === new Date(cassette[`${OSCAR}instruments/view/sar_c_sentinel_1`].retrievedMs).toISOString(), 'SAR RETRIEVED_AT is the fetch time');
  check(sar.PROVENANCE.SOURCE_SHA256 === createHash('sha256').update(cassette[`${OSCAR}instruments/view/sar_c_sentinel_1`].body).digest('hex'), 'SAR SOURCE_SHA256 is the page body\'s');
  check(/C-band SAR, frequency 5\.405 GHz/.test(sar.NOTES) && /15-45/.test(sar.NOTES), 'the quotes are in NOTES');
}
const modis = byId('oscar:modis:25994');
check(!!modis && modis.NAME === 'MODIS on TERRA' && modis.SPECTRAL_BANDS.length === 36 && modis.TYPE === 17 && modis.EMISSION === 2, 'MODIS on Terra: 36 bands, multispectral, passive');
if (modis) {
  const b0 = modis.SPECTRAL_BANDS[0];
  near(b0.FREQ_LOW_HZ, C / 670e-9, 'MODIS band 1 low (645 nm +25 nm)');
  near(b0.FREQ_HIGH_HZ, C / 620e-9, 'MODIS band 1 high (645 nm -25 nm)');
  check(b0.NAME === '645 nm' && b0.DESIGNATION === null && b0.DIRECTION === 1, 'MODIS band 1: named as the table, no designation the source does not state, RECEIVE');
  check(/derived/.test(modis.NOTES) && modis.OPTICAL === null && modis.FIELD_OF_VIEW === null, 'derived edges said in NOTES; no optical or field-of-view value invented');
  check(modis.NORAD_CAT_ID === 25994 && modis.OBJECT_ID === '1999-068A', 'MODIS join: SATCAT');
}
const eglin = byId('ground:3a24a663:an-fps-85');
check(!!eglin, 'AN/FPS-85 record');
if (eglin) {
  check(eglin.SITE_ID === '3a24a663' && eglin.NORAD_CAT_ID === 0 && eglin.OBJECT_ID === null, 'radar is on its site, not a satellite');
  check(eglin.TYPE === 3 && eglin.EMISSION === 1, 'AN/FPS-85: RADAR_AESA (each element has its own transmitter module), ACTIVE');
  const band = eglin.SPECTRAL_BANDS[0];
  near(band.FREQ_LOW_HZ, 437e6, 'AN/FPS-85 low'); near(band.FREQ_HIGH_HZ, 447e6, 'AN/FPS-85 high'); check(band.DESIGNATION === 'UHF', 'designation UHF');
  check(eglin.RF.PEAK_POWER_W === 32e6 && eglin.RF.BANDWIDTH_HZ === 10e6 && eglin.RF.BEAMWIDTH_AZIMUTH_DEG === 0 && Number.isNaN(eglin.RF.ANTENNA_GAIN_DBI), 'RF: 32 MW, 10 MHz; the beamwidths and gain are absent (0 and NaN)');
  check(eglin.MOUNTING.FRAME === 3 && eglin.MOUNTING.BORESIGHT_AZIMUTH_DEG === 180 && eglin.MOUNTING.BORESIGHT_ELEVATION_DEG === 45 && eglin.MOUNTING.POINTING === 2 && eglin.MOUNTING.ELEVATION_LIMIT_MIN_DEG === 0 && Number.isNaN(eglin.MOUNTING.AZIMUTH_LIMIT_MIN_DEG), 'mounting: south 180, elevation 45, fixed, horizon');
  check(eglin.FIELD_OF_VIEW.SHAPE_KIND === 0 && eglin.FIELD_OF_VIEW.OUTER_HALF_ANGLE_DEG === 60 && eglin.FIELD_OF_VIEW.MAX_RANGE_M === 41e6, 'field of view: cone 60 degrees, 41,000 km');
  check(eglin.PROVENANCE.LICENSE === 'CC-BY-SA-4.0' && /Eglin AFB Site C-6/.test(eglin.PROVENANCE.ATTRIBUTION) && /oldid=\d+/.test(eglin.PROVENANCE.SOURCE_URL), 'ground provenance: CC BY-SA, page and revision');
}

// ---- d. UNKNOWN IS ABSENT: every number of a ground record traces to a quote in NOTES.
const numbersOf = (text) => [...text.matchAll(/\d[\d,]*\.?\d*/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
for (const g of ground) {
  const s = g.snr;
  const quoted = new Set(numbersOf([...s.NOTES.matchAll(/"([^"]+)"/g)].slice(1).map((m) => m[1]).join(' ')));
  // A number is a quoted number times a unit, 180 (the azimuth of "south"), or the edge a quoted centre and width give.
  const q = [...quoted], scales = [1, 1e3, 1e6, 1e9];
  const derived = new Set(q.flatMap((c) => q.flatMap((w) => scales.flatMap((k) => [(c - w / 2) * k, (c + w / 2) * k]))));
  const traces = (v, label) => { if (!v || Number.isNaN(v)) return; const ok = scales.some((k) => quoted.has(v / k)) || v === 180 || [...derived].some((d) => Math.abs(d - v) < 1e-3); check(ok, `${s.SENSOR_ID} ${label}=${v} is in no quote`); };
  for (const b of s.SPECTRAL_BANDS) { traces(b.FREQ_LOW_HZ, 'low'); traces(b.FREQ_HIGH_HZ, 'high'); }
  if (s.RF) { traces(s.RF.PEAK_POWER_W, 'power'); traces(s.RF.BANDWIDTH_HZ, 'bandwidth'); }
  if (s.OPTICAL) traces(s.OPTICAL.APERTURE_M, 'aperture');
  if (s.FIELD_OF_VIEW) { traces(s.FIELD_OF_VIEW.OUTER_HALF_ANGLE_DEG, 'cone'); traces(s.FIELD_OF_VIEW.MAX_RANGE_M, 'range'); }
  if (s.MOUNTING) { traces(s.MOUNTING.BORESIGHT_ELEVATION_DEG, 'el'); }
}
const maui = ['aeos', 'motif', 'msss-1-6m'].map((id) => byId(`ground:4b5cefa0:${id}`));
check(maui.every(Boolean) && maui.map((m) => m.OPTICAL.APERTURE_M).join() === '3.67,1.2,1.6' && maui.every((m) => m.TYPE === 16 && m.EMISSION === 2), 'Maui: AEOS 3.67 m, MOTIF 1.2 m, MSSS 1.6 m telescopes, passive');
check(maui[1].SPECTRAL_BANDS[0].DESIGNATION === 'LWIR' && maui[1].SPECTRAL_BANDS[0].FREQ_LOW_HZ === 0 && maui[1].SPECTRAL_BANDS[0].FREQ_HIGH_HZ === 0, 'MOTIF band LWIR is a designation only: the source states no edges, so none');
const globus = [byId('ground:a8fe5809:globus-s-band'), byId('ground:a8fe5809:globus-x-band')];
check(globus.every((g) => g && g.TYPE === 29 && g.EMISSION === 1 && g.SPECTRAL_BANDS[0].FREQ_LOW_HZ === 0) && globus[0].SPECTRAL_BANDS[0].DESIGNATION === 'S' && globus[1].SPECTRAL_BANDS[0].DESIGNATION === 'X', 'GLOBUS S and X: designations only, type UNSPECIFIED because the page does not classify them');
const parcs = byId('ground:76433a1e:an-fpq-16-parcs');
check(parcs && parcs.TYPE === 4 && parcs.SPECTRAL_BANDS[0].DESIGNATION === 'UHF' && parcs.FIELD_OF_VIEW === null && /3,200 km/.test(parcs.NOTES), 'PARCS: PESA, UHF designation, no field of view invented (the range is in the quote)');
for (const r of space) {
  const s = r.snr;
  check(s.TYPE !== 29 && s.NORAD_CAT_ID > 0 && s.OBJECT_ID && !s.SITE_ID && s.PROVENANCE.RETRIEVED_AT && s.PROVENANCE.LICENSE && s.PROVENANCE.SOURCE_URL, `${s.SENSOR_ID}: type, join, provenance`);
  check(r.size < 8192, `${s.SENSOR_ID}: ${r.size} bytes`);
  check(s.OPTICAL === null && (s.RF === null) === !s.SENSOR_ID.startsWith('oscar:umbra_sar:'), `${s.SENSOR_ID}: an OSCAR record carries no RF or optical value it does not state`);
}
for (const r of ground) check(r.size < 8192 && r.snr.SITE_ID && r.snr.PROVENANCE.RETRIEVED_AT, `${r.snr.SENSOR_ID}: size and site`);
const umbra = space.find((r) => r.snr.SENSOR_ID.startsWith('oscar:umbra_sar:'))?.snr;
check(umbra && umbra.RF.BANDWIDTH_HZ === 1200e6 && umbra.SPECTRAL_BANDS[0].DESIGNATION === 'X' && umbra.SPECTRAL_BANDS[0].FREQ_LOW_HZ === 0, 'Umbra: X band with 1200 MHz bandwidth, and no centre the source does not give');
const members = (prefix) => satcat.filter((r) => r.OBJECT_NAME.startsWith(prefix) && r.OBJECT_TYPE === 'PAY' && r.DECAY_DATE === '').map((r) => Number(r.NORAD_CAT_ID)).sort((a, b) => a - b);
for (const [prefix, slug] of [['ICEYE-', 'iceye_sar'], ['CAPELLA-', 'capella_sar'], ['UMBRA-', 'umbra_sar']]) {
  const got = space.filter((r) => r.snr.SENSOR_ID.startsWith(`oscar:${slug}:`)).map((r) => r.snr.NORAD_CAT_ID).sort((a, b) => a - b);
  check(got.length > 5 && got.join() === members(prefix).join(), `${slug}: members are the SATCAT payloads named ${prefix}* still in orbit (${got.length})`);
}

// ---- e. Stops: exactly the values that depend on what changed.
const run = async (mutate) => { const r = await build(host, urls, mutate); return { r, space: records(frames(r, 'space_records')[0]), ground: records(frames(r, 'ground_records')[0]), missing: notices(r).filter((n) => n.reason === 'refused').flatMap((n) => n.items), info: itemMap(notices(r).find((n) => n.reason === 'sensor-counts')) }; };
{ // the Sentinel-1 page no longer says 5.405 GHz: the centre is not published, the C designation (another quote) still is
  const m = await run((u, e) => (u.endsWith('/sar_c_sentinel_1') ? { ...e, body: e.body.replace('frequency 5.405 GHz', 'frequency 5.4 GHz') } : e));
  const s1 = m.space.filter((r) => r.snr.SENSOR_ID.startsWith('oscar:sar_c_sentinel_1:'));
  check(s1.length === 4 && s1.every((r) => r.snr.SPECTRAL_BANDS[0].FREQ_LOW_HZ === 0 && r.snr.SPECTRAL_BANDS[0].DESIGNATION === null), 'a stale SAR quote: no centre, no designation');
  check(s1.every((r) => r.snr.FIELD_OF_VIEW.INNER_LOOK_ANGLE_DEG === 15), 'a stale SAR quote does not stop the look angles, whose quote is intact');
  check(m.missing.some((x) => /5\.405 GHz/.test(x)) && Number(m.info['claims.refused']) >= 2, 'the stale quote is reported');
  check(m.space.length === space.length - 0, 'no record is lost');
}
{ // the SATCAT launch date of Landsat 8 is wrong by a month: the join is refused, nothing else
  const m = await run((u, e) => (u.endsWith('satcat.csv') ? { ...e, body: e.body.replace('2013-02-11', '2013-03-11') } : e));
  check(!m.space.some((r) => r.snr.NORAD_CAT_ID === 39084) && m.space.length === space.length - 2, 'a SATCAT row that does not match OSCAR\'s launch date: Landsat 8 and its two instruments are not published');
  check(m.missing.some((x) => /39084/.test(x)) && m.info['platforms.refused'] === '1', 'the refused join is reported');
}
{ // OSCAR fails for MODIS: the MODIS records stop; the rest stand
  const m = await run((u, e) => (u.endsWith('/instruments/view/modis') ? { ...e, status: 503, body: 'down' } : e));
  check(!m.space.some((r) => r.snr.SENSOR_ID.startsWith('oscar:modis:')) && m.space.length === space.length - 2, 'a failed MODIS page stops the two MODIS records only');
  check(m.missing.some((x) => /HTTP 503/.test(x)), 'the failed fetch is reported');
}
{ // a Wikipedia extract that no longer holds the 442 MHz quote: the centre and the edges are not published
  const m = await run((u, e) => {
    if (!u.includes('en.wikipedia.org')) return e;
    const j = JSON.parse(e.body); const p = Object.values(j.query.pages)[0];
    if (!p.extract.includes('442 MHz')) return e;
    p.extract = p.extract.replace('442 MHz', '440 MHz');
    return { ...e, body: JSON.stringify(j) };
  });
  const g = m.ground.find((r) => r.snr.SENSOR_ID === 'ground:3a24a663:an-fps-85')?.snr;
  check(g && g.SPECTRAL_BANDS[0].FREQ_LOW_HZ === 0 && g.SPECTRAL_BANDS[0].DESIGNATION === 'UHF' && g.RF.PEAK_POWER_W === 32e6, 'a changed number in the page: the dependent edges are not published, the rest stands');
  check(m.missing.some((x) => /442 MHz/.test(x)), 'reported');
}
{ // no SATCAT at all: no satellite sensor is published (a join needs it); the ground sensors are
  const m = await run((u, e) => (u.endsWith('satcat.csv') ? { ...e, status: 503, body: '' } : e));
  check(m.space.length === 0 && m.ground.length === 9, 'no SATCAT: no satellite sensor, ground sensors unaffected');
}

// ---- f. Lane metadata, provenance, report.
const sha = (frame) => createHash('sha256').update(Buffer.from(frame.payload)).digest('hex');
const [spaceMeta] = metas(result, 'space_meta'), [groundMeta] = metas(result, 'ground_meta');
check(spaceMeta.schema === 'SNR.fbs' && spaceMeta.reconcile === 'current' && spaceMeta.tags.sourcePeer === PEER && spaceMeta.tags.batchId === sha(frames(result, 'space_records')[0]) && Number(spaceMeta.provenance.normalizedCount) === space.length, `space lane IngestRequest ${JSON.stringify(spaceMeta?.tags)}`);
check(groundMeta.schema === 'SNR.fbs' && groundMeta.tags.license === 'CC-BY-SA-4.0' && groundMeta.tags.shareAlike === true && spaceMeta.tags.shareAlike === false && Number(groundMeta.provenance.normalizedCount) === 9 && groundMeta.tags.batchId === sha(frames(result, 'ground_records')[0]), 'ground lane IngestRequest');
const p = pvns(result);
check(p.map((x) => x.SOURCE_ID).join() === 'wmo-oscar-space,celestrak-satcat,wikipedia-extracts' && p.map((x) => x.LICENSE_CLASS).join() === '1,1,3', `PVN ${p.map((x) => `${x.SOURCE_ID}/${x.LICENSE_CLASS}`)}`);
const userDefined = (o) => o && typeof o === 'object' && Object.entries(o).some(([k, v]) => (/USER_DEFINED/i.test(k) && v) || userDefined(v));
check(![...space, ...ground].some((r) => r.snr.PROVENANCE.METHOD === 7 || userDefined(r.snr)), 'USER_DEFINED in a published record');
const unset = [...space, ...ground].filter((r) => r.snr.SPECTRAL_BANDS.some((b) => Number.isNaN(b.FREQ_LOW_HZ)));
check(unset.length === 0, 'a NaN frequency');
await host.destroy();

const types = Object.entries(info).filter(([k]) => k.startsWith('type.')).map(([k, v]) => `${k.slice(5)}=${v}`).join(' ');
console.log(`space ${space.length} + ground ${ground.length} records (${info['bands.space']} bands); ${types}; ${tablesChecked} channel tables equal an independent reading on every platform; join: SATCAT; Sentinel-1C ${sar?.SPECTRAL_BANDS[0].FREQ_LOW_HZ / 1e9} GHz C-band look ${sar?.FIELD_OF_VIEW.INNER_LOOK_ANGLE_DEG}-${sar?.FIELD_OF_VIEW.OUTER_LOOK_ANGLE_DEG} deg; AN/FPS-85 ${eglin?.SPECTRAL_BANDS[0].FREQ_LOW_HZ / 1e6}-${eglin?.SPECTRAL_BANDS[0].FREQ_HIGH_HZ / 1e6} MHz ${eglin?.RF.PEAK_POWER_W / 1e6} MW`);
if (failures.length) {
  console.error(`SENSOR DEFINITIONS: FAIL (${failures.length})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('SENSOR DEFINITIONS: PASS');
