// E2E: current cislunar objects from discovery (Horizons listing + probe) and
// NAIF SPICE mission kernels, through the production plan/advance/build path.
// Replays tests/fixtures/cislunar/cassette.json.gz (real fetches; trims are
// whole listing rows or whole SPK segments, each with URL, time and sha256).
// CISLUNAR_RECORD=1 re-records live.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { decodeHttpRequest, encodeHttpResponse, encodeTimerTick, decodeIngestRequest, decodeFlowNotice } from "space-data-module-sdk/runtime-contracts";
import { sha256, LRO_DIR, LADEE_DIR, LISTING_URL, KERNEL_TRIM, trimListing, trimSpk } from "./cislunar-fixtures.mjs";

const root = new URL("../", import.meta.url);
const fixtureUrl = new URL("tests/fixtures/cislunar/cassette.json.gz", root);
const record = process.env.CISLUNAR_RECORD === "1";
const sds = path.dirname(createRequire(import.meta.url).resolve("spacedatastandards.org/package.json"));
const manifest = JSON.parse(fs.readFileSync(new URL("plugin-manifest.json", root)));
const wasm = fs.readFileSync(new URL("dist/isomorphic/module.wasm", root));
// The 0.2.0 roster: membership before discovery.
const OLD_ROSTER = new Set([-143205, -31, -32, -23, -24, -98, -96, -170, -61, -159, -49, -255, -64, -21, -92, -78, -8,
  -139479, -680, -121, -144, -18, -155, -85, -1176, -192, -193, -12, -177, -181, -95, -1023, -1024, -74, -202, -53,
  -41, -143, -5, -248, -236, -82]);
assert.equal(OLD_ROSTER.size, 42);
const CISLUNAR = ["lunar-orbit", "cislunar", "earth-moon-lagrange"];
const PROVIDER_LANE = (source) => `deep-space-spacecraft/${source}`;
// SPICE kernel -> 300 s grid -> OEM Hermite-7 (evaluate_oem) vs Horizons' own LRO states.
// Observed 2026-11-05: 0.54 m and 0.21 m/s (the OEM evaluator's velocity is the weaker term).
const TOLERANCE_KM = 0.005, TOLERANCE_KMS = 5e-4;

const day = (ms) => Math.floor(ms / 86400000) * 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
let cassette;
if (record) {
  const firedMs = Date.now(), d = day(firedMs);
  const limit = (id) => ({ id, start: iso(d), stop: iso(d + 86400000) });
  cassette = { firedMs, recordedAt: new Date(firedMs).toISOString(), responses: {}, config: {
    deep_space_enabled: true, producer_peer_id: "16Uiu2HAmCislunarProducer", objects: [-85], discover: true,
    spk_sources: [{ url: LRO_DIR, mission: "lro", prefix: "lrorg_", files: 1 },
                  { url: LADEE_DIR, mission: "ladee", prefix: "ladee_r_132", files: 2 }],
    limits: [-85, -152, -169, -240, -78000, -9901492].map(limit) } };
} else cassette = JSON.parse(gunzipSync(fs.readFileSync(fixtureUrl)));

async function answer(url) {
  if (!record) {
    const r = cassette.responses[url];
    assert.ok(r, `uncached URL ${url}`);
    r.used = (r.used ?? 0) + 1;
    return { status: r.status, body: Buffer.from(r.body, "base64") };
  }
  const fetchedAt = new Date().toISOString();
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  const original = Buffer.from(await response.arrayBuffer());
  let body = original, trimmed = null;
  if (url === LISTING_URL) { body = Buffer.from(trimListing(original.toString())); trimmed = "whole listing rows kept: tests/cislunar-fixtures.mjs LISTING_IDS"; }
  const file = url.split("/").pop();
  const rule = Object.entries(KERNEL_TRIM).find(([prefix]) => file.startsWith(prefix));
  if (url.endsWith(".bsp") && rule) {
    const t = trimSpk(original, rule[1]);
    body = t.bytes; trimmed = { rule: rule[0], segmentsInOriginal: t.segments, kept: t.kept };
  }
  cassette.responses[url] = { status: response.status, fetchedAt, sha256: sha256(original), bytes: original.length,
    trimmed, bodySha256: sha256(body), body: body.toString("base64") };
  return { status: response.status, body };
}

const typed = (name, id) => ({ schemaName: `${name}.fbs`, fileIdentifier: id, rootTypeName: name, wireFormat: "flatbuffer" });
const framesOn = (result, port) => result.outputs.filter((f) => f.portId === port).map((f) => Buffer.from(f.payload));
const ok = (result, label) => assert.equal(result.statusCode, 0, `${label}: ${result.errorCode ?? ""} ${result.errorMessage ?? ""}`);
const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: "direct", hostOptions: { config: cassette.config } });
try {
  let result = await h.invoke({ methodId: "plan_horizons", inputs: [{ portId: "tick", typeRef: typed("TimerTick", "TICK"),
    payload: encodeTimerTick({ triggerId: "daily", firedMs: cassette.firedMs }) }] });
  ok(result, "plan_horizons");
  let requests = 0;
  for (const methodId of [...Array(6).fill("advance"), "build_oem"]) {
    const responses = [];
    for (const request of framesOn(result, "request").map(decodeHttpRequest)) {
      const r = await answer(request.url); requests++;
      responses.push({ portId: "response", typeRef: typed("HttpResponse", "HRSP"),
        payload: encodeHttpResponse({ url: request.url, status: r.status, body: r.body }) });
    }
    const [state] = framesOn(result, "state");
    result = await h.invoke({ methodId, inputs: [{ portId: "state", payload: state,
      typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: state.length } }, ...responses] });
    ok(result, methodId);
    if (methodId === "build_oem") break;
  }
  if (record) {
    // Independent reference: Horizons' LRO states at off-grid epochs inside the trimmed kernel.
    const kernel = Object.values(cassette.responses).find((r) => r.trimmed?.rule === "lrorg_");
    const [a, b] = [kernel.trimmed.kept[0].start_et, kernel.trimmed.kept.at(-1).stop_et];
    const epochs = Array.from({ length: 8 }, (_, i) => 2451545 + (a + 3600 + 137.25 + i * (b - a - 7200) / 7) / 86400);
    const q = (k, v) => `${k}=${encodeURIComponent(`'${v}'`)}`;
    const url = "https://ssd.jpl.nasa.gov/api/horizons.api?format=text&" + [q("COMMAND", "-85"), q("OBJ_DATA", "NO"),
      q("MAKE_EPHEM", "YES"), q("EPHEM_TYPE", "VECTORS"), q("CENTER", "500@301"), q("TLIST", epochs.map((e) => e.toFixed(9)).join(" ")),
      q("TLIST_TYPE", "JD"), q("TIME_TYPE", "TDB"), q("VEC_TABLE", "2"), q("REF_SYSTEM", "ICRF"), q("REF_PLANE", "FRAME"),
      q("OUT_UNITS", "KM-S"), q("VEC_LABELS", "NO"), q("CSV_FORMAT", "YES")].join("&");
    const fetchedAt = new Date().toISOString();
    const text = await (await fetch(url)).text();
    cassette.reference = { url, fetchedAt, sha256: sha256(Buffer.from(text)), text };
    for (const r of Object.values(cassette.responses)) delete r.used;
    fs.mkdirSync(new URL("tests/fixtures/cislunar/", root), { recursive: true });
    fs.writeFileSync(fixtureUrl, gzipSync(JSON.stringify(cassette)));
    fs.writeFileSync(new URL("tests/fixtures/cislunar/provenance.json", root), JSON.stringify({ recordedAt: cassette.recordedAt,
      firedMs: cassette.firedMs, reference: { url, fetchedAt, sha256: cassette.reference.sha256 },
      responses: Object.entries(cassette.responses).map(([u, r]) => ({ url: u, fetchedAt: r.fetchedAt, status: r.status,
        sha256: r.sha256, bytes: r.bytes, trimmed: r.trimmed, bodySha256: r.bodySha256 })) }, null, 1) + "\n");
  } else {
    for (const [url, r] of Object.entries(cassette.responses)) {
      assert.equal(r.used, 1, `cassette URL used exactly once: ${url}`);
      assert.equal(sha256(Buffer.from(r.body, "base64")), r.bodySha256, `fixture body sha256: ${url}`);
    }
  }
  console.log(`PASS staged run: ${requests} HTTP responses, ${Object.keys(cassette.responses).length} fixture URLs, recorded ${cassette.recordedAt}`);

  // Records per lane, with the OEM block comments and NAIF ids.
  const { OEM } = await import(pathToFileURL(path.join(sds, "lib/js/OEM/OEM.js")));
  const { ByteBuffer } = await import("flatbuffers");
  const lanes = {};
  for (const id of ["lunar-orbit", "cislunar", "earth-moon-lagrange", "sun-earth-l1", "sun-earth-l2", "heliocentric"]) {
    const [stream] = framesOn(result, id.replaceAll("-", "_") + "_records");
    lanes[id] = [];
    for (let at = 0; stream && at < stream.length;) {
      const size = stream.readUInt32LE(at) + 4, bytes = stream.subarray(at, at + size);
      const oem = OEM.getSizePrefixedRootAsOEM(new ByteBuffer(bytes)).unpack();
      lanes[id].push({ id: oem.EPHEMERIS_DATA_BLOCK[0].OBJECT_NAIF_ID, name: oem.EPHEMERIS_DATA_BLOCK[0].OBJECT.OBJECT_NAME,
        blocks: oem.EPHEMERIS_DATA_BLOCK, bytes });
      at += size;
    }
  }
  const notices = framesOn(result, "notice").map(decodeFlowNotice);
  const discovery = Object.fromEntries(notices.find((n) => n.reason === "discovery").items.map((s) => s.split(":")).map(([k, v]) => [k, Number(v)]));
  console.log("discovery", JSON.stringify(discovery));
  assert.equal(discovery.source_errors, 0);
  assert.equal(discovery.listed, 10, "12 kept rows minus the simulation and NEOCP entries");
  assert.equal(discovery.probed, 8, "LRO and CAPSTONE are notables: never probed");
  assert.equal(discovery.kernels, 3);

  // 1. A SPICE-sourced lunar orbiter in lunar-orbit, matching Horizons.
  const lro = lanes["lunar-orbit"].find((r) => r.id === -85);
  assert.ok(lro, "LRO in lunar-orbit");
  const spiceBlocks = lro.blocks.filter((b) => b.COMMENT.includes("spice lrorg_"));
  assert.ok(spiceBlocks.length >= 1 && spiceBlocks.every((b) => b.CENTER_NAIF_ID === 301 && b.STEP_SIZE === 300));
  assert.ok(lro.blocks.some((b) => b.COMMENT.includes("window Moon-centered")), "Horizons window kept beside the kernel rows");
  const ref = cassette.reference.text, soe = ref.indexOf("$$SOE"), eoe = ref.indexOf("$$EOE");
  const rows = ref.slice(soe + 5, eoe).trim().split("\n").map((l) => l.split(",").map((f) => f.trim()));
  const jds = rows.map((r) => Number(r[0]));
  const epochsJson = Buffer.from(JSON.stringify({ jd_tdb: jds }));
  const evaluated = await h.invoke({ methodId: "evaluate_oem", inputs: [
    { portId: "oem", payload: lro.bytes, typeRef: typed("OEM", "$OEM") },
    { portId: "epochs", payload: epochsJson, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: epochsJson.length } }] });
  ok(evaluated, "evaluate_oem");
  const states = JSON.parse(Buffer.from(framesOn(evaluated, "states")[0]).toString());
  let worst = 0, worstV = 0;
  states.forEach((s, i) => {
    assert.ok(lro.blocks[s.block].COMMENT.includes("spice lrorg_"), "reference epochs fall in the SPICE block");
    const r = rows[i].slice(2, 8).map(Number);
    worst = Math.max(worst, Math.hypot(s.x - r[0], s.y - r[1], s.z - r[2]));
    worstV = Math.max(worstV, Math.hypot(s.vx - r[3], s.vy - r[4], s.vz - r[5]));
  });
  assert.ok(worst <= TOLERANCE_KM && worstV <= TOLERANCE_KMS, `LRO SPICE vs Horizons ${worst} km ${worstV} km/s`);
  console.log(`PASS SPICE LRO (-85) in lunar-orbit: ${states.length} Horizons epochs, max |dr| ${(worst * 1000).toFixed(3)} m, max |dv| ${(worstV * 1e6).toFixed(3)} mm/s (tolerance ${TOLERANCE_KM * 1000} m, ${TOLERANCE_KMS * 1e6} mm/s)`);

  // 2. Discovery: a craft outside the 0.2.0 roster, in a cislunar lane.
  const discovered = CISLUNAR.flatMap((lane) => lanes[lane].filter((r) => !OLD_ROSTER.has(r.id) && r.id !== -12).map((r) => ({ lane, ...r })));
  assert.ok(discovered.length >= 1, "discovered craft published");
  for (const d of discovered) assert.ok(d.blocks.every((b) => b.COMMENT.includes("window ")), "discovered craft carry Horizons windows");
  console.log(`PASS discovery: ${discovered.map((d) => `${d.name} (${d.id}) -> ${d.lane}`).join("; ")}`);
  assert.equal(discovery.admitted, discovered.length);

  // 3. A regime change splits: LADEE's Earth-centered phasing kernel and its Moon-centered LOI kernel.
  const ladee = CISLUNAR.flatMap((lane) => lanes[lane].filter((r) => r.id === -12).map((r) => ({ lane, ...r })));
  const lunar = ladee.find((r) => r.lane === "lunar-orbit"), before = ladee.find((r) => r.lane !== "lunar-orbit");
  assert.ok(lunar && before, `LADEE split into two lanes: ${ladee.map((r) => r.lane)}`);
  assert.ok(lunar.blocks.every((b) => b.CENTER_NAIF_ID === 301 && b.COMMENT.includes("spice ladee_r_13278_13325_loa")));
  assert.ok(before.blocks.every((b) => b.CENTER_NAIF_ID === 399 && b.COMMENT.includes("spice ladee_r_13250_13279_pha")));
  const end = Math.max(...before.blocks.map((b) => Date.parse(b.STOP_TIME + "Z")));
  const start = Math.min(...lunar.blocks.map((b) => Date.parse(b.START_TIME + "Z")));
  assert.ok(end < start, "the split is at the kernel's center change: no overlap");
  console.log(`PASS regime split: LADEE (-12) ${before.lane} until ${before.blocks.at(-1).STOP_TIME} -> lunar-orbit from ${lunar.blocks[0].START_TIME}`);

  // Licensing and provenance travel with SPICE rows.
  const meta = decodeIngestRequest(framesOn(result, "lunar_orbit_meta")[0]);
  assert.equal(meta.tags.license, "LicenseRef-NASA-JPL-Horizons-PD AND LicenseRef-NASA-NAIF-PDS-Public");
  assert.equal(meta.provenance.parserVersion, "0.3.0");
  const counts = Object.fromEntries(CISLUNAR.map((lane) => [lane, lanes[lane].length]));
  console.log(`PASS cislunar lanes: lunar-orbit ${counts["lunar-orbit"]}, cislunar ${counts.cislunar}, earth-moon-lagrange ${counts["earth-moon-lagrange"]} (fixture selection)`);

  // Native leg: the same cassette through the compiled flow in an isolated native node.
  const modulesRoot = path.resolve(fileURLToPath(root), "../..");
  const binary = process.env.SDN_NODE_BINARY ?? path.resolve(modulesRoot, "../space-data-network/sdn-server/bin/spacedatanetwork");
  const sdnJs = process.env.SDN_JS ?? path.resolve(modulesRoot, "../space-data-network/sdn-js");
  assert.ok(fs.existsSync(binary), `native node binary required (SDN_NODE_BINARY): ${binary}`);
  assert.ok(fs.existsSync(path.join(sdnJs, "dist/index.mjs")), `sdn-js dist required (SDN_JS): ${sdnJs}`);
  const { EGP } = await import(pathToFileURL(path.join(sds, "lib/js/EGP/EGP.js")));
  const egpIds = [];
  const [egpStream] = framesOn(result, "catalogs_records");
  for (let at = 0; at < egpStream.length;) {
    const size = egpStream.readUInt32LE(at) + 4;
    egpIds.push(EGP.getSizePrefixedRootAsEGP(new ByteBuffer(egpStream.subarray(at, at + size))).GROUP_ID()); at += size;
  }
  const expected = [
    ...["lunar-orbit", "cislunar", "earth-moon-lagrange"].filter((l) => lanes[l].length).map((l) => ({ schema: "OEM.fbs", source: l,
      ids: lanes[l].map((r) => r.id), license: decodeIngestRequest(framesOn(result, l.replaceAll("-", "_") + "_meta")[0]).tags.license })),
    { schema: "EGP.fbs", source: "catalogs", ids: egpIds, license: decodeIngestRequest(framesOn(result, "catalogs_meta")[0]).tags.license },
  ];
  const { nativePublication } = await import("./native-publication.mjs");
  for (const lane of await nativePublication({ packageDir: fileURLToPath(root), binary, sdnJs, cassette, lanes: expected }))
    console.log(`PASS native CID readback ${lane.schema} ${PROVIDER_LANE(lane.source)}: ${lane.ids.length} records in ${lane.shards.length} shards, ` +
      `every shard by CID (manifest ${lane.manifest}; ids ${lane.ids.join(",")})`);
  console.log("PASS deep-space-spacecraft cislunar sources E2E");
} finally {
  await h.destroy();
}
// libp2p and the harness keep handles open after a passing run.
process.exit(0);
