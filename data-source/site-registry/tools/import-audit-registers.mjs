#!/usr/bin/env node
// One-time import of the site-status audit's registers into this module
// (owner 2026-10-13: "It should all load over SDN, that's the whole point":
// the console no longer ships them; the module compiles them in).
//
// Source: SpaceAware-UI commit e0d053f (task/site-source-status-audit-20261013,
// verified round 5) and its placemark report (pm5.json):
//   src/tools/facility-status/{sources,reviewed}.json   -> register/sources.json, reviewed.json
//   src/tools/fetch-facilities.mjs CLASSES              -> register/classes.json
//   src/orbital-console/sources/facilities/curated.json -> register/curated.json
//   src/tools/space-sites.json                          -> register/space-sites.json
//   src/tools/wikidata-references/regulators.json       -> register/regulators.json (Info-box branch 24e869a)
//   geo/data/geoplaces-placemarks*.gnp.bin.gz + .status.json + pm5.json -> register/placemarks.json
// and Wikidata (CC0) for register/countries.json (ISO 3166-1 alpha-2, numeric).
//
//   node tools/import-audit-registers.mjs <SpaceAware-UI at e0d053f> <pm5.json> <countries SPARQL JSON> <SpaceAware-UI at 24e869a>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const [ui, pm5File, countriesFile, infoUi] = process.argv.slice(2);
if (!infoUi) throw new Error("usage: import-audit-registers.mjs UI_CHECKOUT PM5_JSON COUNTRIES_SPARQL_JSON");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "register");
const require = createRequire(import.meta.url);
const sds = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(require.resolve("spacedatastandards.org/package.json"));
const { GNP } = await import(pathToFileURL(path.join(sds, "lib/js/GNP/main.js")));
const { ByteBuffer } = require("flatbuffers");
const read = (rel) => JSON.parse(readFileSync(path.join(ui, rel), "utf8"));
const write = (name, value) => writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 1)}\n`);

// ── sources ────────────────────────────────────────────────────────────────
const audit = read("src/tools/facility-status/sources.json");
const sources = audit.sources.map(({ id, name, licenseClass, licenseId, terms, attribution, credit, use, version, data, recordUrl }) => ({
  id, name, licenseClass, licenseId, terms, attribution, ...(credit ? { credit } : {}), use: use.startsWith("publish") ? "publish" : use.startsWith("check only") ? "check-only" : "not-read",
  ...(version ? { version } : {}), ...(data ? { data } : {}), ...(recordUrl ? { recordUrl } : {}),
}));
const curatedSource = sources.find((s) => s.id === "spaceaware-curated");
Object.assign(curatedSource, {
  name: "SDN site register (curated rows)", terms: "data-source/site-registry/register/curated.json", attribution: "Space Data Network site register",
  version: "2026-10-13", recordUrl: "",
});
sources.push(
  { id: "geonames", name: "GeoNames", licenseClass: "Reproducible", licenseId: "CC-BY-4.0", terms: "https://www.geonames.org/about.html", attribution: "GeoNames (geonames.org)", credit: "GeoNames (CC BY 4.0)", use: "publish", version: "2026-09 dump", recordUrl: "https://www.geonames.org/{recordId}" },
  { id: "space-sites", name: "SDN site register (space sites)", licenseClass: "Reproducible", licenseId: "CC-BY-4.0", terms: "data-source/site-registry/register/space-sites.json", attribution: "Space Data Network site register: published pad and facility positions, checked 2026-09-14", use: "publish", version: "2026-09-14" },
);
const nrc = sources.find((s) => s.id === "us-nrc");
nrc.use = "not-read";
write("sources.json", { $comment: "The sources the site-registry module reads or cites, and their terms (read 2026-10-13). licenseClass is the SDS $PVN pvnLicenseClass; use: publish (reproduced with its credit), check-only (compared by tools/check-only.mjs, never published), not-read. Wikipedia is read for infobox facts and titles only, never prose.", sources });

// ── classes ────────────────────────────────────────────────────────────────
write("classes.json", {
 $comment: "Wikidata class membership per network, in priority order (an item in several lands in the first). transitive: P31/P279*. NPP is the nuclear power plant class; a NUCF member that is also a power plant is NPP.",
 networks: { NPP: "Nuclear power plants", NUCL: "Nuclear labs", NUCF: "Nuclear facilities", STORE: "Storage sites", CHEMP: "Chemical plants", RSCH: "Research facilities", BIO: "Bio labs", CHEM: "Chemical labs", SPACE: "Space sites" },
 classes: [
  ["NPP", "Q134447", "nuclear power plant", true],
  ["NUCL", "Q1438105", "research reactor", true], ["NUCL", "Q109909183", "nuclear research institute", true], ["NUCL", "Q2624320", "US national laboratory", true],
  ["STORE", "Q21493801", "radioactive waste repository", true], ["STORE", "Q1340555", "deep geological repository", true], ["STORE", "Q63313760", "weapons depot", true], ["STORE", "Q60983064", "military depot", true],
  ["NUCF", "Q1739545", "nuclear facility", true], ["CHEMP", "Q905286", "chemical plant", true],
  ["RSCH", "Q483242", "laboratory", true], ["RSCH", "Q3214482", "underground research laboratory", true], ["RSCH", "Q31855", "research institute", false],
 ],
});

// ── curated facilities ─────────────────────────────────────────────────────
const curated = read("src/orbital-console/sources/facilities/curated.json");
write("curated.json", {
 $comment: `${curated.$comment} Imported from SpaceAware-UI e0d053f. position: where the coordinate comes from (wikidata = the item's P625, read each run; register = the row's own published coordinate with its citation).`,
 categories: curated.categories,
 facilities: curated.facilities.map((r) => ({ name: r.name, category: r.category, kind: r.kind, cc: r.cc, ...(r.wikidata ? { wikidata: r.wikidata } : {}), lat: r.lat, lon: r.lon, position: r.position })),
});

// ── space sites ────────────────────────────────────────────────────────────
const space = read("src/tools/space-sites.json");
write("space-sites.json", { ...space, $comment: `${space.$comment} Imported from SpaceAware-UI e0d053f.` });

// ── regulators ─────────────────────────────────────────────────────────────
const regulators = JSON.parse(readFileSync(path.join(infoUi, "src/tools/wikidata-references/regulators.json"), "utf8"));
write("regulators.json", regulators);

// ── reviewed facts ─────────────────────────────────────────────────────────
write("reviewed.json", read("src/tools/facility-status/reviewed.json"));

// ── nuclear placemarks ─────────────────────────────────────────────────────
function frames(file) {
  const stream = gunzipSync(readFileSync(path.join(ui, file)));
  const outFrames = [];
  for (let offset = 0; offset < stream.length; ) {
    const size = stream.readUInt32LE(offset);
    const p = GNP.getRootAsGNP(new ByteBuffer(new Uint8Array(stream.subarray(offset + 4, offset + 4 + size))));
    const src = p.SOURCE();
    outFrames.push({ id: p.ID(), name: p.NAME(), ascii: p.ASCII_NAME() ?? "", code: p.FEATURE_CODE() ?? "", cc: p.COUNTRY_CODE() ?? "", admin1: p.ADMIN1_NAME() ?? "", lat: p.LATITUDE(), lon: p.LONGITUDE(), epoch: src?.DATASET_EPOCH() ?? "", modified: src?.NATIVE_MODIFIED() ?? "" });
    offset += 4 + size;
  }
  return outFrames;
}
const byId = new Map([...frames("src/orbital-console/geo/data/geoplaces-placemarks.gnp.bin.gz"), ...frames("src/orbital-console/geo/data/geoplaces-placemarks-historic.gnp.bin.gz")].map((f) => [f.id.replace(/^geonames:/, ""), f]));
const status = read("src/orbital-console/geo/data/geoplaces-placemarks.status.json");
const pm5 = JSON.parse(readFileSync(pm5File, "utf8"));
const placemarks = pm5.map((row) => {
  const frame = byId.get(row.geonameId);
  if (!frame) throw new Error(`placemark ${row.geonameId} is in no shard`);
  const gem = (status.places[row.geonameId]?.[3] ?? []).find((e) => e[0] === "gem-gnpt" && !/reviewed/.test(e[6]));
  return {
   geonameId: row.geonameId, name: frame.name, ascii: frame.ascii, code: frame.code, cc: frame.cc, admin1: frame.admin1, lat: frame.lat, lon: frame.lon, modified: frame.modified,
   wikidata: row.qid || "", unitItem: Boolean(row.unitItem),
   gemUnits: gem ? gem[3].split(",") : [], gemName: row.gem || "", unitPlant: gem ? /^unit /.test(gem[6]) : false,
  };
});
write("placemarks.json", {
 $comment: "GeoNames power-station placemarks (PS, PSN, CTRA) the site-status audit identified as nuclear (SpaceAware-UI e0d053f, placemark-status.mjs round 5): position, names and feature code as GeoNames (CC BY 4.0) publishes them in the 2026-09 dump, the reviewed join to a Wikidata item (unitItem: the item is the placemark's own unit) and to Global Energy Monitor tracker units (unitPlant: the join is to one unit). The module reads their status each run.",
 dataset: { id: "geonames", name: "GeoNames", url: "https://download.geonames.org/export/dump/", epoch: [...byId.values()][0]?.epoch ?? "" },
 placemarks,
});

// ── countries ──────────────────────────────────────────────────────────────
const bindings = JSON.parse(readFileSync(countriesFile, "utf8")).results.bindings;
const countries = {};
for (const b of bindings) {
  const a2 = b.a2.value;
  const num = b.num?.value ?? "";
  const row = { numeric: num, wikidata: b.c.value.split("/").pop(), name: b.label?.value ?? "" };
  if (!countries[a2] || (!countries[a2].numeric && num)) countries[a2] = row;
}
write("countries.json", {
 $comment: "ISO 3166-1 alpha-2 -> numeric code (SIT CTR_ID), the country's Wikidata item and English label, from Wikidata P297/P299 (CC0), read 2026-10-13. gemNames: the country names the Global Energy Monitor tracker uses where they differ from the label.",
 countries: Object.fromEntries(Object.entries(countries).sort(([a], [b]) => a.localeCompare(b))),
 gemNames: {},
});
console.log(`sources ${sources.length}, curated ${curated.facilities.length}, space sites ${space.sites.length}, placemarks ${placemarks.length}, countries ${Object.keys(countries).length}`);
