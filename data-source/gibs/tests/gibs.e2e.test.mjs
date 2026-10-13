import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";

// Fixtures are GIBS's own documents of 2026-10-13, trimmed to ten layers: the
// three WMTS Capabilities documents, each layer's layer-metadata JSON and the
// NDVI 16-day and GOES-East red-visible DescribeDomains answers (each
// Capabilities list stops at 100 values; the domains start in 2012 and 2019).
// The TEMPO granule layer's domain is two pages built in GIBS's form (a real
// page is 1.2 MB): GIBS answers at most 25,000 values, oldest first. The ten cover every branch the merge
// takes: a JPEG base layer, a 10-minute geostationary layer, a truncated
// 16-day layer, a monthly layer, two OpenStreetMap-derived reference layers, a
// vector (Mapbox Vector Tile) layer, a polar-only layer, a granule layer and a
// change-detection layer. (A full live run on 2026-10-13: 1,356 layers, 1,330
// drawable on the globe, 26 polar-only, 21 time domains extended, 6.4 MB.)
const require = createRequire(import.meta.url);
const sds = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(require.resolve("spacedatastandards.org/package.json"));
const { ByteBuffer } = require("flatbuffers");
const { PNM } = await import(pathToFileURL(path.join(sds, "lib/js/PNM/main.js")));
const wasmPath = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url)));
const wasm = fs.readFileSync(wasmPath);
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const BATCHES = 30;

function serve(url) {
  const caps = /\/wmts\/epsg(\d+)\/best\/1\.0\.0\/WMTSCapabilities\.xml$/.exec(url);
  if (caps) return fs.readFileSync(path.join(fixtures, `capabilities-epsg${caps[1]}.xml`));
  const meta = /\/layer-metadata\/v1\.0\/(.+)\.json$/.exec(url);
  if (meta) {
    const file = path.join(fixtures, "layer-metadata", `${meta[1]}.json`);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }
  for (const id of ["VIIRS_SNPP_L3_NDVI_16Day", "GOES-East_ABI_Band2_Red_Visible_1km"]) {
    if (url.includes(`/${id}/`) && url.endsWith("/all/1900-01-01--2100-01-01.xml")) return fs.readFileSync(path.join(fixtures, `domains-${id}.xml`));
  }
  if (url.includes(`/${TEMPO}/`)) {
    const page = /\/all\/(.+)--2100-01-01\.xml$/.exec(url)?.[1];
    if (page === "1900-01-01") return domains(tempoInstants(Date.UTC(2023, 7, 2, 12), 25_000));
    if (page === TEMPO_PAGE_2) return domains(tempoInstants(Date.parse(TEMPO_PAGE_2), 600));
  }
  return null;
}
// TEMPO's daylight scans: 120 six-minute instants a day from 12:00Z, each "t/t/PT6M".
const TEMPO = "TEMPO_L2_NO2_Vertical_Column_Troposphere_Granule";
function tempoInstants(from, n) {
  const out = [];
  for (let day = from - (from % 86_400_000); out.length < n; day += 86_400_000) {
    for (let k = 0; k < 120 && out.length < n; k++) {
      const t = day + 12 * 3_600_000 + k * 360_000;
      if (t >= from) out.push(`${new Date(t).toISOString().slice(0, 19)}Z`);
    }
  }
  return out;
}
const TEMPO_PAGE_2 = tempoInstants(Date.UTC(2023, 7, 2, 12), 25_000).at(-1);
const domains = (instants) => Buffer.from(`<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>${instants.map((t) => `${t}/${t}/PT6M`).join(",")}</Domain><Size>${instants.length}</Size></DimensionDomain></Domains>`);
function respond(request, status = null) {
  const header = Buffer.alloc(8);
  header.write("$HRB");
  const bytes = status === null ? serve(request.url) : null;
  header.writeInt32LE(status ?? (bytes ? 200 : 404), 4);
  return bytes ? Buffer.concat([header, bytes]) : header;
}
const input = (portId, value) => {
  const payload = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
  return { portId, payload, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length } };
};
const outs = (r, port) => r.outputs.filter((f) => f.portId === port).map((f) => Buffer.from(f.payload));
const J = (b) => JSON.parse(b.toString());
async function harness(t) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: "direct" });
  t.after(() => h.destroy());
  return h;
}
async function step(h, methodId, previous, answer = respond) {
  const requests = outs(previous, "request").map(J);
  const result = await h.invoke({ methodId, inputs: [input("state", outs(previous, "state")[0]), ...requests.map((r) => input("response", answer(r)))] });
  return { result, requests };
}

/** Every stage the flow runs, in order; returns the catalog document, the job and every request made. */
async function runAll(h) {
  let result = await h.invoke({ methodId: "plan_capabilities", inputs: [input("config", { access: "anonymous" })] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  const asked = [];
  for (let stage = 0; stage <= BATCHES; stage++) {
    const methodId = stage === 0 ? "plan_details" : stage < BATCHES ? "advance" : "build_catalog";
    const next = await step(h, methodId, result);
    asked.push(...next.requests);
    result = next.result;
    assert.equal(result.statusCode, 0, `${methodId} (${stage}): ${result.errorMessage}`);
  }
  const file = outs(result, "file")[0];
  const n = file.readUInt32LE(0);
  return { name: file.subarray(4, 4 + n).toString(), xml: file.subarray(4 + n).toString(), job: J(outs(result, "job")[0]), asked };
}
function layer(xml, id) {
  const at = xml.indexOf(`<ows:Identifier>${id}</ows:Identifier>`);
  assert.ok(at > 0, `${id} is in the catalog`);
  return xml.slice(xml.lastIndexOf("<Layer>", at), xml.indexOf("</Layer>", at) + 8);
}
const keyword = (l, type) => [...l.matchAll(new RegExp(`<ows:Keyword>([^<]*)</ows:Keyword><ows:Type codeSpace="[^"]+">${type}</ows:Type>`, "g"))].map((m) => m[1]);
const metadataTitle = (l, role) => new RegExp(`xlink:role="[^"]*/${role}" xlink:href="([^"]*)" xlink:title="([^"]*)"`).exec(l)?.slice(1) ?? null;

test("the artifact satisfies the SDK contract", async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: sds });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("the merged document lists every layer of the three projections, with GIBS's metadata and full time domains", async (t) => {
  const { name, xml, job, asked } = await runAll(await harness(t));
  assert.equal(name, "gibs-wmts-capabilities.xml");
  assert.deepEqual(job.counts, { layers: 10, drawable: 9, polarOnly: 1, truncatedTime: 3, undefinedTileMatrixSets: 0, metadata: 10, extendedTime: 3, domainPages: 1 });
  // One metadata request per layer and one domain request, each its own URL with its own validator.
  const urls = asked.map((r) => r.url);
  assert.equal(new Set(urls.filter((u) => u.includes("/layer-metadata/"))).size, 10);
  assert.ok(asked.every((r) => r.headers["If-Modified-Since"] === "Thu, 01 Jan 1970 00:00:00 GMT"));
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<Capabilities xmlns="http:\/\/www\.opengis\.net\/wmts\/1\.0"/);

  // A truncated 16-day layer carries its whole domain, from 2012.
  const ndvi = layer(xml, "VIIRS_SNPP_L3_NDVI_16Day");
  const values = [...ndvi.matchAll(/<Value>([^<]+)<\/Value>/g)].map((m) => m[1]);
  assert.equal(values.length, 674);
  assert.equal(values[0], "2012-01-17/2012-01-17/P16D");
  assert.deepEqual(keyword(ndvi, "timeKind"), ["MULTIDAY"]);
  assert.deepEqual(keyword(ndvi, "analysis"), ["INDEX"]);
  assert.deepEqual(keyword(ndvi, "measurement"), ["Vegetation Indices"]);

  // A 10-minute layer carries its coverage back to 2019: 2,350 GIBS runs kept
  // as 300, the hundred newest exactly as GIBS states them.
  const goes = layer(xml, "GOES-East_ABI_Band2_Red_Visible_1km");
  const goesValues = [...goes.matchAll(/<Value>([^<]+)<\/Value>/g)].map((m) => m[1]);
  assert.equal(goesValues.length, 300);
  assert.equal(goesValues[0].slice(0, 20), "2019-08-06T00:00:00Z");
  assert.ok(goesValues.every((v) => v.endsWith("/PT10M")));
  const gibsRuns = /<Domain>([^<]+)<\/Domain>/.exec(fs.readFileSync(path.join(fixtures, "domains-GOES-East_ABI_Band2_Red_Visible_1km.xml"), "utf8"))[1].split(",");
  assert.deepEqual(goesValues.slice(-90), gibsRuns.slice(-90));
  assert.deepEqual(keyword(goes, "timeKind"), ["SUBDAILY"]);

  // A domain longer than one DescribeDomains answer is read in pages: the
  // second asked from the first page's last value; the coverage spans both.
  const tempoPages = urls.filter((u) => u.includes(`/${TEMPO}/`) && u.includes("/all/"));
  assert.deepEqual(tempoPages.map((u) => u.slice(u.indexOf("/all/"))), ["/all/1900-01-01--2100-01-01.xml", `/all/${TEMPO_PAGE_2}--2100-01-01.xml`]);
  const tempo = [...layer(xml, TEMPO).matchAll(/<Value>([^<]+)<\/Value>/g)].map((m) => m[1]);
  assert.equal(tempo.length, 300);
  assert.ok(tempo[0].startsWith("2023-08-02T12:00:00Z/") && tempo.every((v) => v.endsWith("/PT6M")));
  assert.ok(tempo.some((v) => v.startsWith(TEMPO_PAGE_2.slice(0, 10))));

  // JPEG -> a base layer; its CMR collections are linked.
  const modis = layer(xml, "MODIS_Terra_CorrectedReflectance_TrueColor");
  assert.deepEqual(keyword(modis, "role"), ["BASE"]);
  assert.deepEqual(keyword(modis, "timeKind"), ["DAILY"]);
  assert.deepEqual(keyword(modis, "ongoing"), ["true"]);
  assert.match(modis, /xlink:href="https:\/\/cmr\.earthdata\.nasa\.gov\/search\/concepts\/C1426414410-LANCEMODIS\.html" xlink:title="MOD021KM 6\.1NRT \(NRT\)"/);
  assert.deepEqual(metadataTitle(modis, "license")?.[0], "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance");

  // OpenStreetMap-derived layers state ODbL and the OSM credit.
  for (const id of ["Reference_Labels_15m", "Coastlines_15m"]) {
    const osm = layer(xml, id);
    assert.deepEqual(keyword(osm, "role"), ["REFERENCE"]);
    assert.deepEqual(metadataTitle(osm, "license"), ["https://www.openstreetmap.org/copyright", "Open Database License (ODbL) 1.0"]);
    assert.match(metadataTitle(osm, "attribution")[1], /^© OpenStreetMap contributors/);
  }
  assert.equal(metadataTitle(layer(xml, "Reference_Labels_15m"), "attribution")[1], "© OpenStreetMap contributors, Natural Earth");
  // A static layer has no Time dimension and keeps its static template.
  const coast = layer(xml, "Coastlines_15m");
  assert.doesNotMatch(coast, /<Dimension>/);
  assert.match(coast, /template="https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/Coastlines_15m\/default\/\{TileMatrixSet\}\/\{TileMatrix\}\/\{TileRow\}\/\{TileCol\}\.png"/);

  // A vector layer names the WMS endpoint that draws it as PNG.
  const fires = layer(xml, "VIIRS_NOAA20_Thermal_Anomalies_375m_All");
  assert.match(fires, /<Format>application\/vnd\.mapbox-vector-tile<\/Format>/);
  assert.match(fires, /xlink:role="https:\/\/spacedatanetwork\.org\/def\/gibs-catalog\/wms" xlink:href="https:\/\/gibs\.earthdata\.nasa\.gov\/wms\/epsg3857\/best\/wms\.cgi"/);

  // Granule, monthly and change-detection layers.
  assert.deepEqual(keyword(layer(xml, "TEMPO_L2_NO2_Vertical_Column_Troposphere_Granule"), "timeKind"), ["GRANULE"]);
  assert.deepEqual(keyword(layer(xml, "MERRA2_2m_Air_Temperature_Monthly"), "timeKind"), ["MONTHLY"]);
  assert.deepEqual(keyword(layer(xml, "OPERA_L3_DIST-ALERT-HLS_Color_Index"), "analysis"), ["CHANGE"]);

  // A polar-only layer: its own renamed TileMatrixSet, defined in the document, and a literal polar template.
  const polar = layer(xml, "AIRS_L2_Cloud_Top_Height_Polar");
  assert.deepEqual(keyword(polar, "polarOnly"), ["EPSG:3413"]);
  const set = /<TileMatrixSetLink><TileMatrixSet>([^<]+)<\/TileMatrixSet>/.exec(polar)[1];
  assert.match(set, /^EPSG3413_/);
  assert.ok(xml.includes(`<TileMatrixSet><ows:Identifier>${set}</ows:Identifier>`), "the renamed set is defined");
  assert.doesNotMatch(/template="([^"]+)"/.exec(polar)[1], /\{TileMatrixSet\}/);
  // A 3857 layer that also exists in a polar projection is marked so.
  assert.deepEqual(keyword(modis, "polar"), ["EPSG:3413", "EPSG:3031"]);
  // Every 3857 TileMatrixSet the layers name is defined once.
  for (const s of new Set([...xml.matchAll(/<TileMatrixSetLink><TileMatrixSet>([^<]+)</g)].map((m) => m[1]))) {
    assert.equal(xml.split(`<TileMatrixSet><ows:Identifier>${s}</ows:Identifier>`).length - 1, 1, s);
  }
});

test("announce_catalog turns the IPFS add result into one $PNM naming the document", async (t) => {
  const h = await harness(t);
  const { name, xml, job } = await runAll(h);
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const result = await h.invoke({ methodId: "announce_catalog", inputs: [
    input("job", job),
    input("receipt", { retrieved_at_ms: Date.UTC(2026, 9, 13, 12, 0, 0), producer_peer_id: "16Uiu2HAmTestProducer" }),
    input("added", { name, cid, bytes: Buffer.byteLength(xml) }),
  ] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  const meta = J(outs(result, "meta")[0]);
  assert.equal(meta.schema, "PNM.fbs");
  assert.equal(meta.provider_id, "nasa-gibs");
  assert.equal(meta.source_name, "layer-catalog");
  assert.equal(meta.reconcile, "current");
  assert.match(meta.citation, /^We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services \(GIBS\)/);
  const records = outs(result, "records")[0];
  const size = records.readUInt32LE(0);
  assert.equal(records.length, 4 + size);
  const pnm = PNM.getRootAsPNM(new ByteBuffer(new Uint8Array(records.subarray(4))));
  assert.equal(pnm.FILE_NAME(), "gibs-wmts-capabilities.xml");
  assert.equal(pnm.CID(), cid);
  assert.equal(pnm.MULTIFORMAT_ADDRESS(), `/ipfs/${cid}`);
  assert.equal(pnm.PUBLISH_TIMESTAMP(), "2026-10-13T12:00:00Z");
  assert.equal(pnm.FILE_ID(), `nasa-gibs:layer-catalog:gibs-wmts-capabilities.xml:${job.files[0].sha256}`);
});

test("a failed Capabilities request stops the cycle and the published catalog stays", async (t) => {
  const h = await harness(t);
  const plan = await h.invoke({ methodId: "plan_capabilities", inputs: [input("config", { access: "anonymous" })] });
  const { result } = await step(h, "plan_details", plan, (r) => respond(r, r.url.includes("epsg3413") ? 503 : null));
  assert.notEqual(result.statusCode, 0);
  assert.match(result.errorMessage, /Capabilities request did not succeed/);
  assert.equal(outs(result, "request").length, 0);
});
