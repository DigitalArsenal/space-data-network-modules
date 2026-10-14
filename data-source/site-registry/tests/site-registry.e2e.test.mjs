import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";

// The whole stage chain on recorded answers (tests/fixtures, built by
// tools/make-fixtures.mjs from a live run of 2026-10-13; licences in
// fixtures/PROVENANCE.md): the class membership, items, parties, tracker
// units, ROR rows and infoboxes of a dozen named sites, and every item the
// registers name. The named rows are the ones the site-status verdicts named.
const require = createRequire(import.meta.url);
const sds = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(require.resolve("spacedatastandards.org/package.json"));
const { ByteBuffer } = require("flatbuffers");
const { SIT } = await import(pathToFileURL(path.join(sds, "lib/js/SIT/main.js")));
const { GNP } = await import(pathToFileURL(path.join(sds, "lib/js/GNP/main.js")));
const wasmPath = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url)));
const wasm = fs.readFileSync(wasmPath);
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
const json = (name) => JSON.parse(fixture(name));
const classes = json("classes.json");
const settlements = new Set(json("settlements.json"));
const entities = json("entities.json");
const parties = json("parties.json");
const countries = json("countries.json");
const labels = json("labels.json");
const articles = json("articles.json");
const gem = fixture("gem.geojson");
const STAGES = ["entities_a", "entities_b", "entities_c", "parties", "articles_a", "articles_b", "articles_c", "finish"];
const RUN_AT = Date.UTC(2026, 9, 14);
const STATUSES = ["UNSPECIFIED", "PLANNED", "UNDER_CONSTRUCTION", "CONSTRUCTION_SUSPENDED", "OPERATING", "LONG_TERM_SHUTDOWN", "PERMANENT_SHUTDOWN", "DECOMMISSIONING", "DECOMMISSIONED", "CANCELLED", "UNVERIFIED"];

/** A ROR dump: one deflated CSV member, as Zenodo serves it. */
function rorZip() {
  const name = Buffer.from("v2.14-2026-10-06-ror-data.csv");
  const csv = fixture("ror-slice.csv");
  const data = deflateRawSync(csv);
  let crc = 0xffffffff;
  for (const byte of csv) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(csv.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(csv.length, 24); central.writeUInt16LE(name.length, 28);
  const dirOffset = 30 + name.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(dirOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
const ZIP = rorZip();

const valuesOf = (query) => [...(query.match(/VALUES \?item \{([^}]*)\}/)?.[1] ?? "").matchAll(/wd:(Q\d+)/g)].map((m) => m[1]);
const iri = (qid) => ({ type: "uri", value: `http://www.wikidata.org/entity/${qid}` });

function serve(request) {
  const url = new URL(request.url);
  const tag = url.searchParams.get("sdn-req") ?? "";
  if (url.host === "query.wikidata.org") {
    const query = new URLSearchParams(Buffer.from(request.bodyB64, "base64").toString()).get("query");
    const ids = valuesOf(query);
    let bindings = [];
    if (tag.startsWith("classes-")) bindings = classes[Number(tag.slice(8))];
    else if (tag === "settlements") bindings = ids.filter((q) => settlements.has(q)).map((q) => ({ item: iri(q) }));
    else if (tag.startsWith("parties-")) bindings = ids.flatMap((q) => parties[q] ?? []);
    else if (tag.startsWith("country-")) bindings = ids.flatMap((q) => countries[q] ?? []);
    else if (tag.startsWith("labels-")) bindings = ids.flatMap((q) => labels[q] ?? []);
    return Buffer.from(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
  }
  if (url.host === "www.wikidata.org" && url.searchParams.get("action") === "wbgetentities") {
    const ids = url.searchParams.get("ids").split("|");
    return Buffer.from(JSON.stringify({ entities: Object.fromEntries(ids.map((q) => [q, entities[q] ?? { id: q, missing: "" }])), success: 1 }));
  }
  if (url.host === "www.wikidata.org") return Buffer.from(JSON.stringify({ query: { general: {} } }));
  if (url.host.endsWith(".wikipedia.org")) {
    const lang = url.host.split(".")[0];
    const pages = url.searchParams.get("titles").split("|").map((title) => {
      const a = articles[`${lang}:${title}`];
      return a ? { title: a.title, revisions: [{ revid: a.revid, slots: { main: { content: a.content } } }] } : { title, missing: true };
    });
    return Buffer.from(JSON.stringify({ batchcomplete: true, query: { pages } }));
  }
  if (url.pathname.endsWith(".geojson")) return gem;
  if (url.host === "zenodo.org" && url.pathname === "/api/records") {
    return Buffer.from(JSON.stringify({ hits: { hits: [{ files: [{ key: "v2.14-2026-10-06-ror-data.zip", links: { self: "https://zenodo.org/api/records/1/files/ror.zip/content" } }] }] } }));
  }
  if (url.host === "zenodo.org") return ZIP;
  return null;
}
function respond(request) {
  const header = Buffer.alloc(8);
  header.write("$HRB");
  const body = serve(request);
  header.writeInt32LE(body ? 200 : 404, 4);
  return body ? Buffer.concat([header, body]) : header;
}
const input = (portId, value) => {
  const payload = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
  return { portId, payload, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length } };
};
const outs = (result, port) => result.outputs.filter((f) => f.portId === port).map((f) => Buffer.from(f.payload));
const J = (bytes) => JSON.parse(bytes.toString());

// The provider flow's one-thread variant (build.mjs --flow-host).
const flowHost = { wasm: fs.readFileSync(new URL("../flow-host/dist/isomorphic/module.wasm", import.meta.url)), manifest: JSON.parse(fs.readFileSync(new URL("../flow-host/plugin-manifest.json", import.meta.url))) };

async function run(t, variant = { wasm, manifest }) {
  const h = await createBrowserModuleHarness({ wasmSource: variant.wasm, manifest: variant.manifest, surface: "direct" });
  t.after(() => h.destroy());
  let result = await h.invoke({ methodId: "plan", inputs: [input("config", { access: "anonymous", run_at_ms: RUN_AT, producer_peer_id: "16Uiu2HAmTestProducer" })] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  const asked = [];
  for (const stage of STAGES) {
    const requests = outs(result, "request").map(J);
    asked.push({ stage, requests });
    const state = result.outputs.find((f) => f.portId === "state");
    result = await h.invoke({ methodId: stage, inputs: [{ portId: "state", payload: state.payload, typeRef: state.typeRef }, ...requests.map((r) => input("response", respond(r)))] });
    assert.equal(result.statusCode, 0, `${stage}: ${result.errorMessage}`);
  }
  return { sites: outs(result, "sites")[0], places: outs(result, "places")[0], meta: J(outs(result, "sites_meta")[0]), report: J(outs(result, "report")[0]), asked };
}
function frames(stream) {
  const out = [];
  for (let o = 0; o + 4 <= stream.length; ) {
    const n = stream.readUInt32LE(o);
    out.push(new Uint8Array(stream.subarray(o + 4, o + 4 + n)));
    o += 4 + n;
  }
  return out;
}
function decodeSites(stream) {
  const byId = new Map();
  for (const frame of frames(stream)) {
    const s = SIT.getRootAsSIT(new ByteBuffer(frame)).unpack();
    byId.set(s.ID, s);
  }
  return byId;
}

test("the artifact satisfies the SDK contract", async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: sds });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("the named sites come out with their verified lifecycle, country, description and references", async (t) => {
  const { sites, places, meta, report, asked } = await run(t);
  const byId = decodeSites(sites);
  const status = (id) => byId.get(id) && `${STATUSES[byId.get(id).LIFECYCLE_STATUS]}@${byId.get(id).LIFECYCLE_STATUS_DATE ?? ""}`;

  // AEG Prüfreaktor: dismantled 1978-02-22, read by hand from the de article (owner 2026-10-13).
  assert.equal(status("wikidata:Q1438110"), "DECOMMISSIONED@1978-02-22");
  const aeg = byId.get("wikidata:Q1438110");
  assert.ok(aeg.STATUS_EVIDENCE.some((e) => e.CITATION.PROVENANCE.SOURCE_ID === "wikipedia" && e.CITATION.SOURCE_RECORD_ID === "de:Forschungsreaktor Karlstein" && e.CITATION.SOURCE_FIELD === "register:reviewed"));
  // The round-5 verdict's open sub-statuses: dismantling under way.
  assert.equal(status("wikidata:Q1695264"), "DECOMMISSIONING@2022");
  assert.equal(status("wikidata:Q1536182"), "DECOMMISSIONING@2026-10-01");
  // Hoger Onderwijs Reactor: a country code from its item (the audit left it empty).
  assert.equal(byId.get("wikidata:Q2450052").CTR_ID, "528");
  // Kambarka's town item is not the site: the curated row keeps its own record.
  assert.equal(byId.has("wikidata:Q143813"), false);
  const kambarka = [...byId.values()].find((s) => s.NAME === "Kambarka chemical weapons destruction facility");
  assert.ok(kambarka && kambarka.ID.startsWith("sdn-site:"));
  assert.ok(!kambarka.EXTERNAL_REFERENCES.some((r) => r.REGISTRY === "wikidata"));
  // Gorleben: no English description on its item, so the German one, cited.
  const gorleben = byId.get("wikidata:Q757630");
  assert.equal(gorleben.DESCRIPTION_LANGUAGE, "de");
  assert.equal(gorleben.DESCRIPTION_CITATION.PROVENANCE.SOURCE_ID, "wikidata");
  // The power plants the facility set lacked.
  for (const id of ["wikidata:Q1516546", "wikidata:Q3664615", "wikidata:Q1630042", "wikidata:Q5767271"]) assert.ok(byId.has(id), id);
  assert.equal(STATUSES[byId.get("wikidata:Q5767271").LIFECYCLE_STATUS], "UNDER_CONSTRUCTION");
  // A research body merged into a successor stays in operation (ROR successor).
  assert.equal(STATUSES[byId.get("wikidata:Q1022865").LIFECYCLE_STATUS], "OPERATING");
  // Round-6 verdict (2026-10-13). A description in any language closes a body: nl "voormalig"
  // (Dr. Neher Laboratorium), "GDR" (Institute for Biotechnology, Leipzig), and an item that calls
  // itself defunct is closed even with a successor (Royal Aircraft Establishment, dissolved 1991).
  assert.equal(STATUSES[byId.get("wikidata:Q1994681").LIFECYCLE_STATUS], "PERMANENT_SHUTDOWN");
  assert.equal(STATUSES[byId.get("wikidata:Q122930142").LIFECYCLE_STATUS], "PERMANENT_SHUTDOWN");
  assert.equal(status("wikidata:Q1419175"), "PERMANENT_SHUTDOWN@1991");
  // A station filed as a nuclear facility follows its tracker units (Kashiwazaki-Kariwa runs), but an
  // item whose own statements close it keeps them (Tokai Power Station, retired 1998).
  assert.equal(STATUSES[byId.get("wikidata:Q725100").LIFECYCLE_STATUS], "OPERATING");
  assert.equal(status("wikidata:Q11527936"), "PERMANENT_SHUTDOWN@1998-03-31");
  // Philippine Research Reactor-1: the reactor shut in 1988 (the 2022 subcritical assembly is not a reactor).
  assert.equal(status("wikidata:Q25058143"), "PERMANENT_SHUTDOWN@1988");

  // Every record: an own-record reference, a provenance, no check-only or ODbL terms, statuses with citations.
  for (const s of byId.values()) {
    assert.ok(s.EXTERNAL_REFERENCES.some((r) => r.ROLE === 1), `${s.ID} has a RECORD reference`);
    assert.ok(s.PROVENANCE?.LICENSE_ID, `${s.ID} has terms`);
    const citations = [...s.STATUS_EVIDENCE.map((e) => e.CITATION), s.DESCRIPTION_CITATION, s.POSITION_CITATION, ...s.QUANTITIES.map((q) => q.CITATION), ...s.PARTIES.map((p) => p.CITATION)].filter(Boolean);
    for (const c of citations) {
      assert.notEqual(c.PROVENANCE.LICENSE_CLASS, 2, `${s.ID} cites a CiteOnly source`);
      assert.notEqual(c.PROVENANCE.LICENSE_ID, "ODbL-1.0", `${s.ID} cites ODbL data`);
      assert.ok(!(c.SOURCE_FIELD ?? "").startsWith("prose:"), "working statements are not published");
    }
    assert.ok(STATUSES[s.LIFECYCLE_STATUS] === "UNSPECIFIED" || s.STATUS_EVIDENCE.length > 0, `${s.ID} states its evidence`);
    if (s.DESCRIPTION) assert.ok(s.DESCRIPTION_CITATION, `${s.ID} cites its description`);
  }
  // Sorted by ID.
  const ids = [...byId.keys()];
  assert.deepEqual(ids, [...ids].sort());

  // The search projection: current and prospective rows, never the dismantled AEG Prüfreaktor.
  const placeIds = new Set(frames(places).map((f) => GNP.getRootAsGNP(new ByteBuffer(f)).ID()));
  assert.equal(placeIds.has("wikidata:Q1438110"), false);
  assert.ok(placeIds.has("wikidata:Q5767271"));

  // The lane's meta and report.
  assert.equal(meta.provider_id, "sdn-site-registry");
  assert.equal(meta.source_name, "sites");
  assert.equal(meta.batch_id, createHash("sha256").update(sites).digest("hex"));
  assert.equal(report.records, byId.size);
  assert.equal(report.no_record_reference, 0);

  // Every stage asks at most 60 times, each request its own URL with its own validator.
  const urls = new Set();
  for (const { stage, requests } of asked) {
    assert.ok(requests.length >= 1 && requests.length <= 60, `${stage}: ${requests.length} requests`);
    for (const r of requests) {
      assert.equal(r.headers["If-Modified-Since"], "Thu, 01 Jan 1970 00:00:00 GMT");
      assert.match(r.headers["User-Agent"], /^SDN-site-registry\/[\d.]+ \(\+https:\/\/spacedatanetwork\.org\)$/);
      assert.ok(!urls.has(r.url), `one URL per request: ${r.url}`);
      urls.add(r.url);
    }
  }
});

test("two runs on the same answers write the same bytes, threaded or on one thread", async (t) => {
  const first = await run(t);
  const second = await run(t);
  const single = await run(t, flowHost);
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  assert.equal(sha(first.sites), sha(second.sites));
  assert.equal(sha(first.places), sha(second.places));
  assert.equal(sha(single.sites), sha(first.sites), "the flow-host variant writes the threaded module's bytes");
  assert.equal(sha(single.places), sha(first.places));
});
