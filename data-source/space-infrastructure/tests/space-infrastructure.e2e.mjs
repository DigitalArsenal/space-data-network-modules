#!/usr/bin/env node
// E2E (task feature-space-infrastructure-catalog-20261104): the roster's real source documents, recorded in tests/fixtures/cassette.json.gz
// (Wikidata wbgetentities, the MediaWiki extracts and page coordinates of the Wikipedia articles, one Overpass query; provenance.json), through
// plan_sources and build_infrastructure in the SDK's browser harness, then every $SIT and $SNR read back from the lane streams with the
// published bindings (spacedatastandards.org 1.279.0).
//   a. plan_sources plans each source document once and the cassette holds exactly the planned requests; the embedded roster is roster.json;
//   b. every site position is re-derived here from the fixture documents (its own JSON and coordinate readers) and equals the record; every
//      cross-check distance is recomputed here and is within the roster's tolerance;
//   c. UNKNOWN IS ABSENT: every number of every $SNR is the number of a roster claim times its scale, read here from the roster and found
//      in the claim's quote, and every claim value appears in the record; unset positive quantities are 0, signed NaN;
//   d. three records are decoded field by field: a US UEWR (Cape Cod), a Russian Voronezh (Lekhtusi), a Chinese LPAR (Yiyuan);
//   e. a stale quote, a failed fetch, a moved position, a missing OSM element stop exactly the values that depend on them;
//   f. the lane metadata (IngestRequest: one attribute per record, its sha256), the provenance records and the report count what was emitted;
//      two runs are byte-identical.
// Expected values come from the fixture documents and the roster, never from the module's output.
//   cd data-source/space-infrastructure && node tests/space-infrastructure.e2e.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { build, cassette, frames, harness, here, itemMap, metas, notices, PEER, plan, pvns, records, SIT, SNR } from './run-module.mjs';

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };
const near = (a, b, label, tol = 1e-6) => check(Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)), `${label}: ${a} vs ${b}`);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ---- The roster, and the embedded copy.
const rosterText = fs.readFileSync(here('../src/roster.json'), 'utf8');
const roster = JSON.parse(rosterText);
check(fs.readFileSync(here('../src/roster_data.hpp'), 'utf8').includes(rosterText), 'src/roster_data.hpp embeds roster.json (run node build.mjs)');
const ids = roster.sites.map((s) => s.id);
check(new Set(ids).size === ids.length, 'site ids are unique');
check(roster.sites.every((s) => s.sensors.length && s.sensors.every((x) => x.claims.length)), 'every site has a sensor and every sensor a claim');

// ---- The fixture documents, read independently.
const collapse = (s) => s.replace(/[\s  -  ]+/g, ' ').trim();
const wikidata = {}; // QID -> entity
const wikipedia = {}; // title -> { extract, coordinates, revid }
let overpass = {}; // key -> element
for (const [url, entry] of Object.entries(cassette)) {
  if (url.startsWith('https://www.wikidata.org/')) {
    const j = JSON.parse(entry.body);
    for (const [q, e] of Object.entries(j.entities)) if (!e.missing) wikidata[q] = e;
  } else if (url.startsWith('https://en.wikipedia.org/')) {
    const page = Object.values(JSON.parse(entry.body).query.pages)[0];
    wikipedia[page.title] = { extract: collapse(page.extract), coordinates: page.coordinates?.find((c) => 'primary' in c), all: (page.coordinates ?? []).map((c) => ({ lat: c.lat, lon: c.lon })), revid: String(page.revisions[0].revid) };
    const requested = decodeURIComponent(url.split('titles=')[1]);
    wikipedia[requested] = wikipedia[page.title]; // a redirect is requested by the roster's title
  } else if (url.startsWith('https://overpass-api.de/')) {
    for (const el of JSON.parse(entry.body).elements) overpass[`${el.type[0]}${el.id}`] = el;
  }
}
const docText = (doc) => {
  const [scheme, ...rest] = doc.split(':');
  const ref = rest.join(':');
  if (scheme === 'wp') return wikipedia[ref]?.extract;
  if (scheme === 'wd') { const e = wikidata[ref]; return e ? collapse(`label=${e.labels?.en?.value ?? ''} description=${e.descriptions?.en?.value ?? ''}`) : undefined; }
  if (scheme === 'osm') { const e = overpass[ref]; return e ? collapse(Object.entries(e.tags ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n')) : undefined; }
  return undefined;
};
const dms = (text) => {
  const out = {};
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(?:°(?:(\d+(?:\.\d+)?)′(?:(\d+(?:\.\d+)?)″)?)?)?\s*([NSEW])/g)) {
    const v = Number(m[1]) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600;
    const key = 'NS'.includes(m[4]) ? 'lat' : 'lon';
    if (!(key in out)) out[key] = 'SW'.includes(m[4]) ? -v : v;
  }
  return out;
};
const position = (src, ref, q, near) => {
  if (src === 'wikidata') {
    const claims = (wikidata[ref]?.claims?.P625 ?? []).filter((c) => c.rank !== 'deprecated');
    const c = claims.find((x) => x.rank === 'preferred') ?? claims[0];
    return c ? { lat: c.mainsnak.datavalue.value.latitude, lon: c.mainsnak.datavalue.value.longitude } : undefined;
  }
  if (src === 'wikipedia') { const c = wikipedia[ref]?.coordinates; return c ? { lat: c.lat, lon: c.lon } : undefined; }
  if (src === 'wikipedia-near') {
    const anchor = position(near.src, near.ref);
    const within = (wikipedia[ref]?.all ?? []).filter((c) => anchor && haversine(anchor, c) <= near.km);
    check(within.length === 1, `exactly one coordinate tag of ${ref} within ${near.km} km of ${near.ref}: ${within.length}`);
    return within.length === 1 ? within[0] : undefined;
  }
  if (src === 'osm') { const e = overpass[ref]; const c = e?.center ?? e; return c?.lat === undefined ? undefined : { lat: c.lat, lon: c.lon }; }
  if (src === 'text') { check(docText(ref)?.includes(collapse(q)), `coordinate text in ${ref}`); const v = dms(q); return 'lat' in v && 'lon' in v ? v : undefined; }
  return undefined;
};
const haversine = (a, b) => {
  const r = Math.PI / 180, dlat = (b.lat - a.lat) * r, dlon = (b.lon - a.lon) * r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
};

// ---- a. The plan.
const host = await harness();
const { result: planned, urls } = await plan(host);
check(planned.statusCode === 0, 'plan_sources succeeds');
check(new Set(urls).size === urls.length, 'each source document is requested once');
check(urls.every((u) => cassette[u]) && Object.keys(cassette).length === urls.length, 'the cassette holds exactly the planned requests');
const wikiTitles = new Set(), qids = new Set(), osmKeys = new Set();
const note = (doc) => { if (!doc) return; const [scheme, ...rest] = doc.split(':'); const ref = rest.join(':'); if (scheme === 'wp') wikiTitles.add(ref); if (scheme === 'wd') qids.add(ref); if (scheme === 'osm') osmKeys.add(ref); };
const noteRef = (src, ref) => { if (src === 'wikidata') qids.add(ref); if (src === 'wikipedia' || src === 'wikipedia-near') wikiTitles.add(ref); if (src === 'osm') osmKeys.add(ref); if (src === 'text') note(ref); };
for (const s of roster.sites) {
  noteRef(s.pos.src, s.pos.ref);
  if (s.pos.near) noteRef(s.pos.near.src, s.pos.near.ref);
  for (const c of s.checks ?? []) noteRef(c.src, c.ref);
  for (const k of ['wikidata', 'enwiki', 'osm']) if (s.refs?.[k]) noteRef(k === 'enwiki' ? 'wikipedia' : k, s.refs[k]);
  for (const c of s.claims) note(c.doc);
  for (const x of s.sensors) for (const c of x.claims) note(c.doc);
}
for (const p of roster.platforms ?? []) for (const c of p.claims) note(c.doc);
const wikiUrls = urls.filter((u) => u.startsWith('https://en.wikipedia.org/')), wdUrls = urls.filter((u) => u.startsWith('https://www.wikidata.org/')), osmUrls = urls.filter((u) => u.startsWith('https://overpass-api.de/'));
check(wikiUrls.length === wikiTitles.size, `one MediaWiki request per article: ${wikiUrls.length} vs ${wikiTitles.size}`);
check(wdUrls.length === Math.ceil(qids.size / 40), `Wikidata ids are requested 40 at a time: ${wdUrls.length} vs ${qids.size} ids`);
check(osmUrls.length === 1, 'one Overpass request');
check([...osmKeys].every((k) => decodeURIComponent(osmUrls[0]).includes(k.slice(1))), 'the Overpass request names every OSM element');
check(urls.every((u) => !u.includes('//www.leolabs') && u.startsWith('https://')), 'only the three surveyed sources are requested');

// ---- Run.
const run = await build(host, urls);
check(run.statusCode === 0, `build_infrastructure succeeds: ${run.errorCode} ${run.errorMessage}`);
const report = notices(run);
const counts = itemMap(report.find((n) => n.reason === 'infrastructure-counts'));
const refused = report.find((n) => n.reason === 'refused');
check(!refused, `nothing is refused on the recorded day: ${refused?.items.join(' | ')}`);
const sites = records(frames(run, 'site_records')[0], SIT);
const sensors = records(frames(run, 'sensor_records')[0], SNR);
check(sites.length === roster.sites.length, `a site record per roster site: ${sites.length} vs ${roster.sites.length}`);
const rosterSensors = roster.sites.reduce((n, s) => n + s.sensors.length, 0) + (roster.platforms ?? []).length;
check(sensors.length === rosterSensors, `a sensor record per roster sensor: ${sensors.length} vs ${rosterSensors}`);
check(Number(counts['records.sites']) === sites.length && Number(counts['records.sensors']) === sensors.length, 'the report counts the records');
check(sites.every((s) => s.size <= 8191) && sensors.every((s) => s.size <= 8191), 'every record is under the 8 KiB bound');

// ---- b. Positions and cross-checks.
const siteById = new Map(sites.map((s) => [s.rec.ID, s]));
let corroborated = 0, single = 0;
for (const s of roster.sites) {
  const rec = siteById.get(`sdn-infra:${s.id}`)?.rec;
  check(!!rec, `site ${s.id} published`);
  if (!rec) continue;
  const expected = position(s.pos.src, s.pos.ref, s.pos.q, s.pos.near);
  check(!!expected, `site ${s.id}: position derivable from the fixture`);
  if (!expected) continue;
  near(rec.LATITUDE, expected.lat, `${s.id} latitude`, 1e-6);
  near(rec.LONGITUDE, expected.lon, `${s.id} longitude`, 1e-6);
  check(rec.NAME === s.name && rec.CTR_ID === s.ctr, `${s.id} name and country`);
  for (const c of s.checks ?? []) {
    const other = position(c.src, c.ref, c.q);
    check(!!other && haversine(expected, other) <= c.km, `${s.id}: ${c.src} ${c.ref} within ${c.km} km (${other ? haversine(expected, other).toFixed(3) : 'none'})`);
  }
  if ((s.checks ?? []).length) corroborated += 1; else single += 1;
  check(rec.POSITION_CITATION?.PROVENANCE?.RETRIEVED_AT && rec.POSITION_CITATION.SOURCE_RECORD_ID, `${s.id}: the position names its record and retrieval time`);
  check(rec.PROVENANCE?.LICENSE_ID && rec.PROVENANCE.LICENSE_CLASS !== 0, `${s.id}: the record carries licence terms`);
  // The description states what the position denotes.
  check(rec.DESCRIPTION.includes(s.pos.denotes), `${s.id}: DESCRIPTION states what the position denotes`);
}
check(Number(counts['positions.corroborated']) === corroborated && Number(counts['positions.single']) === single, `positions: ${counts['positions.corroborated']}/${counts['positions.single']} vs ${corroborated}/${single}`);

// ---- c. Unknown is absent: every number is a claim's number.
const numberOf = (c) => {
  if (c.n !== undefined) return Number(c.n.replace(/,/g, '')) * (c.s ?? 1);
  return c.v;
};
const quoteOk = (c) => { const text = docText(c.doc); return text !== undefined && text.includes(collapse(c.q)) && (c.n === undefined || collapse(c.q).includes(c.n)); };
const allClaims = [...roster.sites.flatMap((s) => s.claims), ...roster.sites.flatMap((s) => s.sensors.flatMap((x) => x.claims)), ...(roster.platforms ?? []).flatMap((p) => p.claims)];
check(allClaims.every(quoteOk), `every roster quote is in its fixture document and its number in the quote: ${allClaims.filter((c) => !quoteOk(c)).map((c) => c.q.slice(0, 60)).join(' | ')}`);
const sensorById = new Map(sensors.map((s) => [s.rec.SENSOR_ID, s]));
const typeNames = Object.fromEntries(Object.entries({ RADAR_PULSE: 0, RADAR_DOPPLER: 1, RADAR_CW: 2, RADAR_AESA: 3, RADAR_PESA: 4, OPTICAL_TELESCOPE: 16, PHASED_ARRAY_EARLY_WARNING: 28, UNSPECIFIED: 29 }));
const nonDefault = (v) => v !== 0 && !Number.isNaN(v);
let numbersChecked = 0;
for (const s of roster.sites) {
  for (const x of s.sensors) {
    const rec = sensorById.get(`infra:${s.id}:${x.id}`)?.rec;
    check(!!rec, `sensor ${s.id}/${x.id} published`);
    if (!rec) continue;
    check(rec.SITE_ID === `sdn-infra:${s.id}` && siteById.has(rec.SITE_ID), `${x.id}: SITE_ID resolves to a published $SIT`);
    const expected = new Map(); // quantity name -> value
    const bands = [];
    for (const c of x.claims) {
      const i = c.i ?? 0;
      if (c.f.startsWith('band')) bands[i] ??= {};
      const v = numberOf(c);
      if (c.f === 'type') check(rec.TYPE === typeNames[c.e], `${x.id}: TYPE ${c.e}`);
      if (c.f === 'band') { bands[i].name = c.name; bands[i].des = c.des; }
      if (c.f === 'band_low_hz') bands[i].low = v;
      if (c.f === 'band_high_hz') bands[i].high = v;
      if (c.f === 'band_center_hz') bands[i].centre = v;
      if (c.f === 'band_width_hz') bands[i].width = v;
      if (['rf_bandwidth_hz', 'peak_power_w', 'max_range_m', 'aperture_m', 'limiting_magnitude', 'cone_half_angle_deg', 'boresight_az_deg', 'boresight_el_deg', 'el_limit_min_deg', 'el_limit_max_deg'].includes(c.f)) expected.set(c.f, v);
    }
    const populated = bands.map((b, i) => [b, i]).filter(([b]) => b);
    check(rec.SPECTRAL_BANDS.length === populated.length, `${x.id}: ${populated.length} bands, record has ${rec.SPECTRAL_BANDS.length}`);
    populated.forEach(([b], k) => {
      const r = rec.SPECTRAL_BANDS[k];
      if (!r) return;
      check(r.NAME === b.name && (r.DESIGNATION ?? '') === (b.des ?? ''), `${x.id} band ${k}: name and designation`);
      let low = 0, high = 0;
      if (b.low !== undefined && b.high !== undefined) { low = b.low; high = b.high; }
      else if (b.centre !== undefined && b.width !== undefined) { low = b.centre - b.width / 2; high = b.centre + b.width / 2; }
      else if (b.centre !== undefined) { low = high = b.centre; }
      near(r.FREQ_LOW_HZ, low, `${x.id} band ${k} low`); near(r.FREQ_HIGH_HZ, high, `${x.id} band ${k} high`);
      numbersChecked += 2;
    });
    near(rec.RF?.PEAK_POWER_W ?? 0, expected.get('peak_power_w') ?? 0, `${x.id} peak power`);
    near(rec.RF?.BANDWIDTH_HZ ?? 0, expected.get('rf_bandwidth_hz') ?? 0, `${x.id} rf bandwidth`);
    near(rec.OPTICAL?.APERTURE_M ?? 0, expected.get('aperture_m') ?? 0, `${x.id} aperture`);
    const mag = rec.OPTICAL?.LIMITING_MAGNITUDE;
    if (expected.has('limiting_magnitude')) near(mag, expected.get('limiting_magnitude'), `${x.id} limiting magnitude`); else check(mag === undefined || Number.isNaN(mag), `${x.id}: limiting magnitude unset`);
    // The range only travels in NOTES; the cone and mounting are set only when claimed.
    check(!rec.FIELD_OF_VIEW || expected.has('cone_half_angle_deg'), `${x.id}: no field of view without a cone half angle`);
    if (expected.has('cone_half_angle_deg')) near(rec.FIELD_OF_VIEW.OUTER_HALF_ANGLE_DEG, expected.get('cone_half_angle_deg'), `${x.id} cone`);
    for (const [field, claim] of [['BORESIGHT_AZIMUTH_DEG', 'boresight_az_deg'], ['BORESIGHT_ELEVATION_DEG', 'boresight_el_deg'], ['ELEVATION_LIMIT_MIN_DEG', 'el_limit_min_deg'], ['ELEVATION_LIMIT_MAX_DEG', 'el_limit_max_deg']]) {
      const v = rec.MOUNTING?.[field];
      if (expected.has(claim)) near(v, expected.get(claim), `${x.id} ${field}`); else check(v === undefined || Number.isNaN(v), `${x.id}: ${field} unset (${v})`);
    }
    if (expected.has('max_range_m')) check(rec.NOTES.includes(`Stated range: ${(expected.get('max_range_m') / 1000).toFixed(1)} km.`), `${x.id}: stated range in NOTES`);
    for (const c of x.claims) check(rec.NOTES.includes(collapse(c.q)), `${x.id}: NOTES quotes "${c.q.slice(0, 50)}"`);
    check(rec.PROVENANCE?.SOURCE && rec.PROVENANCE.RETRIEVED_AT && rec.PROVENANCE.LICENSE && rec.PROVENANCE.METHOD === 0, `${x.id}: SOURCE, RETRIEVED_AT, LICENSE, METHOD present`);
    check(rec.NORAD_CAT_ID === 0 && !rec.ENTITY_ID, `${x.id}: a ground sensor has a SITE_ID and no platform ids`);
  }
}
for (const p of roster.platforms ?? []) {
  const rec = sensorById.get(`infra:platform:${p.id}`)?.rec;
  check(!!rec && rec.ENTITY_ID === `infra:platform:${p.id}` && !rec.SITE_ID, `platform ${p.id}: ENTITY_ID and no SITE_ID`);
}

// ---- d. Three decoded examples.
const decode = (id) => sensorById.get(id)?.rec;
{
  const cape = decode('infra:cape-cod-sfs:an-fps-132'), site = siteById.get('sdn-infra:cape-cod-sfs')?.rec;
  check(cape?.TYPE === 28 && cape.EMISSION === 1 && cape.SPECTRAL_BANDS.length === 1 && cape.SPECTRAL_BANDS[0].DESIGNATION === 'UHF' && cape.SPECTRAL_BANDS[0].FREQ_LOW_HZ === 0 && cape.SPECTRAL_BANDS[0].FREQ_HIGH_HZ === 0, 'Cape Cod UEWR: PHASED_ARRAY_EARLY_WARNING, active, UHF by designation with no invented edges');
  check(site?.PARTIES[0]?.NAME === '6th Space Warning Squadron' && site.ESTABLISHMENT_DATE === '1980-04-04' && site.LIFECYCLE_STATUS === 4 && site.STATUS_EVIDENCE.length === 1 && site.NETWORK === 'SSPARS', 'Cape Cod site: operator, establishment date, OPERATING with evidence, network');
  near(site.LATITUDE, 41.7532, 'Cape Cod latitude', 1e-5); near(site.LONGITUDE, -70.5385, 'Cape Cod longitude', 1e-5);
  const lek = decode('infra:lekhtusi:voronezh-m'), lsite = siteById.get('sdn-infra:lekhtusi')?.rec;
  check(lek?.TYPE === 28 && lek.SPECTRAL_BANDS[0].DESIGNATION === 'VHF' && lek.NOTES.includes('Voronezh-M, a VHF radar with a stated range of 4,200 kilometres') && lek.NOTES.includes('Stated range: 4200.0 km.'), 'Lekhtusi Voronezh-M: VHF, 4,200 km in the quote');
  check(lsite?.CTR_ID === '643' && lsite.PARTIES[0].NAME === 'Russian Space Forces' && lsite.ESTABLISHMENT_DATE === '2012-02-11', 'Lekhtusi site: Russia, operator, combat duty date');
  const yi = decode('infra:cn-lpar-yiyuan:lpar'), ysite = siteById.get('sdn-infra:cn-lpar-yiyuan')?.rec;
  check(yi?.TYPE === 28 && yi.SPECTRAL_BANDS.length === 0 && !yi.RF && !yi.MOUNTING && yi.NOTES.includes('name=沂源'), 'Yiyuan LPAR: type from two quotes, no band or RF invented');
  check(ysite?.CTR_ID === '156' && ysite.SITE_KIND === 'first radar station with LPAR in China' && ysite.EXTERNAL_REFERENCES.some((r) => r.REGISTRY === 'openstreetmap') && ysite.EXTERNAL_REFERENCES.some((r) => r.REGISTRY === 'wikidata'), 'Yiyuan site: China, Wikidata description as kind, OSM and Wikidata references');
  check(/OpenStreetMap/.test(ysite.PROVENANCE.ORIGINATOR) && ysite.PROVENANCE.LICENSE_ID.includes('ODbL-1.0') && ysite.PROVENANCE.LICENSE_ID.includes('CC0-1.0') && ysite.PROVENANCE.LICENSE_CLASS === 3, 'Yiyuan record: licenses of the sources it used, share-alike');
}

// ---- e. Failures stop exactly what depends on them.
const rerun = async (mutate) => { const h = await harness(); const r = await build(h, urls, mutate); await h.destroy(); return r; };
const wikiUrlOf = (title) => urls.find((u) => u.startsWith('https://en.wikipedia.org/') && decodeURIComponent(u.split('titles=')[1]) === title);
{
  // A stale quote: a Cobra Dane sentence is edited away.
  const url = wikiUrlOf('Cobra Dane');
  const r = await rerun((u, e) => { if (u === url) { const j = JSON.parse(e.body); const p = Object.values(j.query.pages)[0]; p.extract = p.extract.replace('It operates in the L-band frequency.', 'It operates in a band.'); e.body = JSON.stringify(j); } return e; });
  const miss = notices(r).find((n) => n.reason === 'refused');
  check(miss && miss.items.length === 1 && miss.items[0].includes('It operates in the L-band frequency.'), `a stale quote is reported alone: ${miss?.items.join(' | ')}`);
  const cobra = records(frames(r, 'sensor_records')[0], SNR).find((x) => x.rec.SENSOR_ID === 'infra:cobra-dane-eareckson:an-fps-108')?.rec;
  check(cobra && cobra.SPECTRAL_BANDS[0].DESIGNATION === '' || cobra.SPECTRAL_BANDS[0].DESIGNATION === null, 'the band loses its designation, keeps the edges that have their own quote');
  check(itemMap(notices(r).find((n) => n.reason === 'infrastructure-counts'))['records.sites'] === String(sites.length), 'every site is still published');
}
{
  // A failed fetch of a Wikipedia article: only the values quoted from it go.
  const url = wikiUrlOf('Cobra Dane');
  const r = await rerun((u, e) => (u === url ? { ...e, status: 503, body: 'unavailable' } : e));
  const miss = notices(r).find((n) => n.reason === 'refused');
  check(miss && miss.items.some((x) => x.includes('Wikipedia HTTP 503')), 'the failed article is reported');
  const out = records(frames(r, 'site_records')[0], SIT);
  const cobra = out.find((x) => x.rec.ID === 'sdn-infra:cobra-dane-eareckson');
  check(cobra && cobra.rec.PARTIES.length === 0, 'Cobra Dane is still a site (its position is Wikidata\'s), without the operator quoted from the failed article');
  check(!records(frames(r, 'sensor_records')[0], SNR).some((x) => x.rec.SENSOR_ID === 'infra:cobra-dane-eareckson:an-fps-108'), 'its sensor, whose every claim is from that article, is not published');
}
{
  // A moved position: Wikidata puts Fylingdales 400 km away from the OSM way: the site and its sensor are not published.
  const url = urls.find((u) => u.startsWith('https://www.wikidata.org/') && decodeURIComponent(u).includes('Q1126073'));
  const r = await rerun((u, e) => { if (u === url) { const j = JSON.parse(e.body); j.entities.Q1126073.claims.P625[0].mainsnak.datavalue.value.latitude += 3.5; e.body = JSON.stringify(j); } return e; });
  const miss = notices(r).find((n) => n.reason === 'refused');
  check(miss && miss.items.some((x) => x.startsWith('site raf-fylingdales') && x.includes('km from') && x.includes('not published')), `a disagreeing position refuses the site: ${miss?.items.join(' | ')}`);
  check(!records(frames(r, 'site_records')[0], SIT).some((x) => x.rec.ID === 'sdn-infra:raf-fylingdales') && !records(frames(r, 'sensor_records')[0], SNR).some((x) => x.rec.SENSOR_ID.startsWith('infra:raf-fylingdales:')), 'neither the site nor its sensor is published');
}
{
  // The OSM request fails: every OSM-positioned site is refused, the others stand.
  const r = await rerun((u, e) => (u.startsWith('https://overpass-api.de/') ? { ...e, status: 502, body: 'busy' } : e));
  const miss = notices(r).find((n) => n.reason === 'refused');
  const osmSites = roster.sites.filter((s) => s.pos.src === 'osm');
  const out = records(frames(r, 'site_records')[0], SIT);
  check(out.length === roster.sites.length - osmSites.length, `OSM down: ${out.length} sites remain of ${roster.sites.length} (${osmSites.length} depend on OSM)`);
  check(miss && miss.items.some((x) => x.includes('OpenStreetMap HTTP 502')), 'the failed OSM request is reported');
  check(metas(r, 'site_meta')[0].reconcile === 'duplicates' && metas(r, 'sensor_meta')[0].reconcile === 'duplicates' && itemMap(notices(r).find((n) => n.reason === 'infrastructure-counts'))['fetch.failures'] === '1', 'a run with a failed fetch only adds: it never retires the records the failed source would have kept');
}

// ---- f. Lane metadata, provenance, determinism.
{
  const siteMeta = metas(run, 'site_meta')[0], sensorMeta = metas(run, 'sensor_meta')[0];
  check(siteMeta.schema === 'SIT.fbs' && sensorMeta.schema === 'SNR.fbs' && siteMeta.reconcile === 'current' && sensorMeta.reconcile === 'current' && counts.reconcile === 'current' && counts['fetch.failures'] === '0', 'a complete run is each lane\'s whole current set');
  check(siteMeta.tags.sourcePeer === PEER && siteMeta.tags.batchId === sha256(Buffer.from(frames(run, 'site_records')[0].payload)) && Number(siteMeta.provenance.normalizedCount) === sites.length, `site lane tags ${JSON.stringify(siteMeta.tags)}`);
  check(siteMeta.provenance.attributes.length === sites.length && sensorMeta.provenance.attributes.length === sensors.length, 'one attribute per record');
  const bySha = new Map(siteMeta.provenance.attributes.map((a) => [a.name, a.value]));
  check(sites.every((s) => bySha.get(s.rec.ID) === sha256(s.bytes)), 'each site attribute is the sha256 of its record (two weeks are diffable)');
  const sensorSha = new Map(sensorMeta.provenance.attributes.map((a) => [a.name, a.value]));
  check(sensors.every((s) => sensorSha.get(s.rec.SENSOR_ID) === sha256(s.bytes)), 'each sensor attribute is the sha256 of its record');
  check(siteMeta.tags.shareAlike === true && siteMeta.tags.license.includes('ODbL-1.0') && siteMeta.tags.license.includes('CC-BY-SA-4.0') && siteMeta.tags.license.includes('CC0-1.0'), 'the lanes are share-alike and name the three licenses');
  const p = pvns(run).map((x) => x.SOURCE_ID).sort();
  check(JSON.stringify(p) === JSON.stringify(['openstreetmap', 'wikidata', 'wikipedia-extracts']), `one PVN per source system: ${p}`);
  check(pvns(run).every((x) => x.LICENSE_ID && x.LICENSE_CLASS !== 0 && x.RETRIEVED_AT), 'every PVN has a license and a retrieval time');
  const again = await rerun((u, e) => e);
  const sameBytes = (a, b) => Buffer.compare(Buffer.from(frames(a, 'site_records')[0].payload), Buffer.from(frames(b, 'site_records')[0].payload)) === 0 && Buffer.compare(Buffer.from(frames(a, 'sensor_records')[0].payload), Buffer.from(frames(b, 'sensor_records')[0].payload)) === 0;
  check(sameBytes(run, again), 'two runs are byte-identical');
  const text = JSON.stringify([...sites, ...sensors].map((x) => x.rec), (k, v) => (typeof v === 'bigint' ? Number(v) : v));
  check(!text.includes('USER_DEFINED'), 'no USER_DEFINED provenance');
}
await host.destroy();

console.log(`space-infrastructure E2E: ${sites.length} sites, ${sensors.length} sensors, ${numbersChecked} band edges re-derived`);
if (failures.length) {
  console.error(`FAIL (${failures.length}):\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('PASS');
