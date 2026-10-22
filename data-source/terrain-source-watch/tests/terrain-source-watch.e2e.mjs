// data-source/terrain-source-watch, end to end: the BUILT module linked into the committed flow flows/terrain-refresh
// (plan -> http-request probes + storage/object-s3 list -> diff -> object-s3 put) on the WasmEdge leg of the SDK flow
// runtime host (storage/tools/test-support/harness.mjs). The publishers are simulated per source file (ETag,
// Last-Modified, size, answered to the one-byte ranged GET the module sends); the mirror is the SigV4-verifying S3 mock, read
// and written through the REAL storage/object-s3 with a credential on the node's storage_r2 lane.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import * as H from "../../../storage/tools/test-support/harness.mjs";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACKAGE, "plugin-manifest.json"), "utf8"));
const ACCESS = "AKIAWATCHTESTKEY0001";
const SECRET = "watch-secret-access-key-0123456789abcdefghij-SECRET";
const BUCKET = "watchbucket";

// The compiled-in source table, read from the generated header.
const SOURCES = [...fs.readFileSync(path.join(PACKAGE, "src", "watch_sources.hpp"), "utf8").matchAll(/^\s+\{"(\w+)", "(\d+)", "(\w+)", "([^"]+)", "([^"]*)", "((?:\\"|[^"])*)", "([^"]*)", (\d+)ULL\},$/gm)]
  .map((m, i) => ({ index: i, body: m[1], naif: m[2], product: m[3], file: m[4], url: m[5], pinned: m[6].replaceAll('\\"', '"'), serves: m[7], pinnedSize: Number(m[8]) }));
const sizeOf = (s) => s.pinnedSize || 1000 + s.index;
const key = (s) => `raw/${s.naif}/${s.product}/${s.file}`;
const INSETS = SOURCES.filter((s) => s.pinnedSize > 0);
const PROBED = SOURCES.filter((s) => s.url);

let wasm, mock;
before(async () => {
  // Exercise the shipped flow bytes as well as the rebuilt module they embed.
  wasm = fs.readFileSync(path.join(PACKAGE, "../../flows/terrain-refresh/dist/runtime.wasm"));
  mock = await H.startMockS3({ accessKey: ACCESS, secret: SECRET, bucket: BUCKET, region: "auto" });
});
after(() => mock?.stop());

// ---- the simulated publishers + the real mirror -----------------------------------------------------------------------
function httpFor(overrides = {}, mirrorSizes = new Map()) {
  const probed = [];
  const listings = [];
  const fn = (request) => {
    if (request.url.startsWith(mock.endpoint)) {
      const response = H.syncHttp(request);
      if (request.method === "GET" && new URL(request.url).searchParams.get("list-type") === "2" && response.status === 200) {
        listings.push(new URL(request.url));
        // The mock owns small backing objects; listing fixtures carry the real
        // multi-gigabyte sizes without allocating entire DEMs in the test host.
        response.body = Buffer.from(response.body.toString().replace(/<Contents>(.*?)<\/Contents>/g, (entry) => {
          const size = mirrorSizes.get(/<Key>(.*?)<\/Key>/.exec(entry)[1]);
          return size === undefined ? entry : entry.replace(/<Size>\d+<\/Size>/, `<Size>${size}</Size>`);
        }));
        response.headers = response.headers.replace(/content-length:[^\r\n]*/i, `content-length: ${response.body.length}`);
      }
      return response;
    }
    const source = PROBED.find((s) => s.url === request.url);
    assert.ok(source, `a probe of a URL the non-inset table does not hold: ${request.url}`);
    assert.equal(request.headers.range, "bytes=0-0", "the probe is a one-byte ranged GET");
    assert.ok(request.headers["if-none-match"], "the probe names a validator no file carries");
    probed.push(source.index);
    const o = overrides[source.index] ?? {};
    if (o.status) return { status: o.status, url: request.url, headers: "", body: Buffer.alloc(0) };
    if (o.fail) return { status: 0, url: request.url, headers: "", body: Buffer.alloc(0), error: "connection refused" };
    const headers = [`etag: ${o.etag ?? source.pinned}`, `last-modified: ${o.lastModified ?? "Mon, 01 Jan 2018 00:00:00 GMT"}`, `content-range: bytes 0-0/${o.size ?? sizeOf(source)}`, "accept-ranges: bytes"];
    return { status: 206, url: request.url, headers: headers.join("\r\n"), body: Buffer.alloc(1) };
  };
  fn.probed = probed;
  fn.listings = listings;
  return fn;
}
const tick = () => H.encodeTimerTick({ triggerId: "terrain-refresh-watch", firedMs: Date.now() });
const config = (extra = {}) => ({ body: "moon", store: "r2", endpoint: mock.endpoint, bucket: BUCKET, region: "auto", ...extra });
async function run({ cfg = config(), overrides = {}, credential = true, mirrorFor = [] } = {}) {
  await mock.reset();
  const mirrorSizes = new Map();
  for (const [s, size, modified] of mirrorFor) {
    mirrorSizes.set(key(s), size ?? sizeOf(s));
    await mock.seed(key(s), Math.min(size ?? sizeOf(s), 1024), modified);
  }
  const http = httpFor(overrides, mirrorSizes);
  const node = H.createNode({ store: credential ? new Map([["storage_r2", { username: ACCESS, secret: SECRET }]]) : new Map(), http, config: cfg });
  const { outputs } = await H.runFlow({ wasm, node, inputs: [{ trigger: 0, portId: "tick", payload: tick() }] });
  const out = { node, http, report: null, reports: [], notices: [], results: [], rows: [] };
  for (const b of outputs) {
    assert.ok(!Buffer.from(b).includes(Buffer.from(SECRET)), "an egress frame carries the secret");
    if (H.idAt(b, 8) === "$QRP") {
      out.report = H.readQrp(b, true);
      out.reportBytes = Buffer.from(b);
      out.reports.push(out.report);
      out.rows.push(...H.rowsOf(out.report));
    }
    else if (H.idAt(b, 4) === "FNTC") out.notices.push(H.decodeFlowNotice(b));
    else if (H.idAt(b, 4) === "$APR") out.results.push(H.readApr(b));
    else assert.fail(`an egress frame of no declared type: ${H.idAt(b, 4)}`);
  }
  out.states = Object.fromEntries(out.rows.map((r) => [`${r.product}/${r.file}`, r.state]));
  out.counts = out.rows.reduce((c, r) => ({ ...c, [r.state]: (c[r.state] ?? 0) + 1 }), {});
  return out;
}
const byProduct = (name) => SOURCES.filter((s) => s.body === "moon" && s.product === name);
const [ldem4] = byProduct("ldem_4"), [ldem16] = byProduct("ldem_16"), [ldem64] = byProduct("ldem_64"), [ldem128] = byProduct("ldem_128");

test("the source table is exactly what the terrain walk's own tables produce", () => {
  execFileSync(process.execPath, [path.join(PACKAGE, "tools", "generate-sources.mjs"), "--check"], { stdio: "pipe" });
  assert.equal(SOURCES.length, 93);
  assert.deepEqual([SOURCES.filter((s) => s.body === "moon").length, SOURCES.filter((s) => s.body === "mars").length], [34, 59]);
  assert.deepEqual([PROBED.filter((s) => s.body === "moon").length, PROBED.filter((s) => s.body === "mars").length], [34, 27]);
  assert.ok(SOURCES.every((s) => s.pinned.startsWith('"') || s.pinnedSize > 0), "every source has an ETag or byte-size pin");
  assert.equal(new Set(SOURCES.map(key)).size, 93, "no duplicate mirror keys");
  // Authority: the walk's BodyInset byte lengths, not watcher-generated golden output.
  // Units: bytes, exact integer metadata; frame/epoch: not applicable; tolerance: zero.
  const plan = fs.readFileSync(path.join(PACKAGE, "../terrain-ingest/src/body_plan.hpp"), "utf8");
  const catalog = plan.slice(plan.indexOf("const std::array<BodyInset,32>& body_insets()"), plan.indexOf("const BodyInset* body_inset("));
  const names = [...catalog.matchAll(/\{"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(INSETS.map((s) => path.posix.basename(s.file)).sort(), names.sort());
  assert.equal(INSETS.length, 32);
  assert.deepEqual(Object.fromEntries(["hrsc_hmc30_dt5", "msl_gale_dem_1m_v3", "msr_trn_hirise_dtm_1m_v003"].map((p) => [p, INSETS.filter((s) => s.product === p).length])), {
    hrsc_hmc30_dt5: 20, msl_gale_dem_1m_v3: 6, msr_trn_hirise_dtm_1m_v003: 6,
  });
  assert.ok(INSETS.every((s) => s.naif === "499" && s.url === "" && s.pinned === "" && /^L\d+ inset/.test(s.serves)));
  for (const [file, size, serves] of [
    ["ovr/HMC_11E10_dt5_rows.tif", 474389369, "L10 inset 50 m"],
    ["HMC_13E10_dt5.tif", 638313017, "L10 inset 50 m"],
    ["ovr/MSL_Gale_DEM_Mosaic_1m_v3_rows.tif", 7578866127, "L15 inset 1 m"],
    ["ovr/MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_32m.tif", 2015819, "L10 inset 32 m"],
  ]) {
    const s = INSETS.find((s) => s.file === file);
    assert.ok(s, file);
    assert.deepEqual([s.pinnedSize, s.serves], [size, serves]);
  }
  const hrsc = SOURCES.find((s) => s.product === "hrsc_mola_blend_200m_v2");
  assert.equal(hrsc.file, "Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif");
});

test("manifest: clock only, typed ports, no network and no credential", () => {
  assert.deepEqual(MANIFEST.capabilities, ["clock"]);
  assert.deepEqual(MANIFEST.methods.map((m) => m.methodId), ["plan", "diff"]);
  for (const method of MANIFEST.methods) for (const port of [...method.inputPorts, ...method.outputPorts]) {
    assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1);
    assert.equal(port.acceptedTypeSets[0].allowedTypes[0].wireFormat, "flatbuffer");
  }
  const flow = H.loadFlow("terrain-refresh").flow;
  const granted = new Set(flow.nodes.flatMap((n) => n.capabilities));
  assert.deepEqual([...granted].sort(), ["clock", "http", "secrets:storage_r2"], "the flow's whole grant: no write lane, no storage, no wallet");
});

test("a clean check: every pinned source answers its pin, the mirrored files match; the unmirrored are named; the report is stored beside the mirror", async () => {
  const r = await run({ mirrorFor: [[ldem4], [ldem16]] });
  assert.equal(r.rows.length, 34);
  assert.deepEqual(r.counts, { current: 2, "not-mirrored": 32 });
  assert.equal(r.states["ldem_4/ldem_4_float.img"], "current");
  const row = r.rows.find((x) => x.product === "ldem_16");
  assert.deepEqual([row.body, row.naif, row.file, row.source_etag, row.pinned_etag, Number(row.source_size), Number(row.mirror_size), row.serves],
    ["moon", "301", "ldem_16_float.img", ldem16.pinned, ldem16.pinned, sizeOf(ldem16), sizeOf(ldem16), "L4-5 lat -90..90"]);
  assert.equal(row.mirror_key, "raw/301/ldem_16/ldem_16_float.img");
  assert.equal(row.source_url, ldem16.url);
  assert.deepEqual(r.http.probed.slice().sort((a, b) => a - b), SOURCES.filter((s) => s.body === "moon").map((s) => s.index), "one probe per source file of the body");
  assert.deepEqual(r.notices.map((n) => [n.kind, n.reason.startsWith("terrain source check moon ")]), [["unchanged", true]]);
  assert.match(r.notices[0].reason, /current=2 not-mirrored=32/);
  // stored: the page is at watch/301/<date>.qrp and is the report, byte for byte
  const state = await mock.state();
  const stored = Object.keys(state.objects).filter((k) => k.startsWith("watch/301/"));
  assert.equal(stored.length, 1);
  assert.match(stored[0], /^watch\/301\/\d{4}-\d{2}-\d{2}\.qrp$/);
  assert.equal(state.objects[stored[0]].size, r.reportBytes.length);
  assert.equal(state.objects[stored[0]].contentType, "application/x-flatbuffers");
  assert.deepEqual(r.results.map((x) => [x.ROUTE, x.STATUS]), [["put", 200]]);
  assert.ok(state.requests.every((q) => q.auth === "ok"), "the mirror was read and written with verified SigV4");
  // the mirror listing is bounded to the body
  assert.ok(state.requests.some((q) => q.method === "GET" && q.query.includes("prefix=raw%2F301%2F")));
});

test("changes are named: a re-pinned ETag, a different size, a source that does not answer; the notice lists what to refresh", async () => {
  const r = await run({
    mirrorFor: [[ldem4], [ldem16, 5], [ldem64]],
    overrides: { [ldem64.index]: { etag: '"reprocessed:0"' }, [ldem128.index]: { status: 404 }, [ldem4.index]: { lastModified: "Tue, 02 Jan 2018 00:00:00 GMT" } },
  });
  assert.equal(r.states["ldem_64/ldem_64_float.img"], "source-changed");
  assert.equal(r.states["ldem_16/ldem_16_float.img"], "size-changed");
  assert.equal(r.states["ldem_128/ldem_128_float.img"], "probe-failed");
  assert.equal(r.states["ldem_4/ldem_4_float.img"], "current", "a pinned file whose ETag is its pin is current whatever its Last-Modified says");
  const failed = r.rows.find((x) => x.product === "ldem_128");
  assert.equal(failed.probe_error, "HTTP 404");
  assert.equal(failed.source_etag, null);
  assert.deepEqual(r.notices.map((n) => n.kind), ["info"]);
  assert.deepEqual(r.notices[0].items.sort(), ["ldem_16/ldem_16_float.img=size-changed", "ldem_64/ldem_64_float.img=source-changed"]);
  assert.equal(r.notices[0].count, 34);
});

test("a source that errors at the transport is probe-failed with its reason; the others are unaffected", async () => {
  const r = await run({ mirrorFor: [[ldem4]], overrides: { [ldem16.index]: { fail: true } } });
  assert.equal(r.states["ldem_16/ldem_16_float.img"], "probe-failed");
  assert.match(r.rows.find((x) => x.product === "ldem_16").probe_error, /exceeds|failed|no answer|HTTP 0|connection/);
  assert.equal(r.states["ldem_4/ldem_4_float.img"], "current");
});

test("pins=off compares size and Last-Modified: a source modified after the mirror was written is source-newer", async () => {
  const r = await run({
    cfg: config({ pins: "off" }),
    mirrorFor: [[ldem4, undefined, "2018-01-01T00:00:00.000Z"], [ldem16, undefined, "2018-03-01T00:00:00.000Z"]],
    overrides: { [ldem4.index]: { lastModified: "Tue, 02 Jan 2018 00:00:00 GMT" }, [ldem64.index]: { etag: '"anything"' } },
  });
  assert.equal(r.states["ldem_4/ldem_4_float.img"], "source-newer");
  assert.equal(r.states["ldem_16/ldem_16_float.img"], "current");
  assert.equal(r.states["ldem_64/ldem_64_float.img"], "not-mirrored", "without pins a different ETag alone says nothing");
});

test("an unreadable mirror (no credential): the source half is reported, nothing is stored, the notice says so", async () => {
  const r = await run({ credential: false });
  assert.equal(r.rows.length, 34);
  assert.ok(r.rows.every((x) => x.state === "current" || x.state === "probe-failed" || x.state === "source-changed"), "no file is called not-mirrored when the mirror could not be listed");
  assert.equal(r.counts.current, 34);
  assert.equal(r.rows[0].mirror_size, null);
  assert.deepEqual(r.notices.map((n) => n.kind), ["info"]);
  assert.match(r.notices[0].reason, /mirror unreadable/);
  assert.ok(r.notices[0].items.some((i) => i.startsWith("mirror=no-credential")), JSON.stringify(r.notices[0].items));
  assert.equal(Object.keys((await mock.state()).objects).filter((k) => k.startsWith("watch/")).length, 0, "no page claiming an unreadable mirror is empty");
  assert.equal((await mock.state()).requests.length, 0, "no refused task reached the store");
});

test("unconfigured: one Missing notice and no probe", async () => {
  for (const cfg of [config({ endpoint: "" }), config({ bodies: "venus" })]) {
    const r = await run({ cfg });
    assert.deepEqual(r.notices.map((n) => n.kind), ["missing"]);
    assert.match(r.notices[0].reason, /unconfigured/);
    assert.equal(r.http.probed.length, 0);
    assert.equal(r.report, null);
  }
});

test("moon,mars fits one invocation: 61 probes plus two recursive listings produce all 93 rows", async () => {
  const r = await run({ cfg: config({ bodies: "moon,mars" }), mirrorFor: [[ldem4], [INSETS[0]]] });
  assert.equal(r.http.probed.length, 61);
  assert.deepEqual(r.http.probed.slice().sort((a, b) => a - b), PROBED.map((s) => s.index));
  assert.equal(r.http.listings.length, 2);
  assert.equal(r.http.probed.length + r.http.listings.length, 63);
  assert.deepEqual(r.http.listings.map((url) => url.searchParams.get("prefix")).sort(), ["raw/301/", "raw/499/"]);
  assert.ok(r.http.listings.every((url) => !url.searchParams.has("delimiter") && url.searchParams.get("max-keys") === "1000"));
  assert.deepEqual(r.reports.map((page) => page.ROWS.length).sort((a, b) => a - b), [34, 59]);
  assert.equal(r.rows.length, 93);
  assert.deepEqual(r.counts, { current: 2, "not-mirrored": 91 });
  assert.deepEqual(r.notices.map((n) => n.kind), ["unchanged", "unchanged"]);
  assert.deepEqual(r.results.map((x) => [x.ROUTE, x.STATUS]), [["put", 200], ["put", 200]]);
  const stored = Object.keys((await mock.state()).objects).filter((k) => k.startsWith("watch/"));
  assert.equal(stored.length, 2);
  assert.ok(["301", "499"].every((naif) => stored.some((k) => k.startsWith(`watch/${naif}/`))));
});

test("a body the table lacks is unconfigured, not skipped", async () => {
  // a name the table lacks is refused (a run whose probes and listings exceed 64 frames is refused the same way)
  const r = await run({ cfg: config({ bodies: "moon,venus" }) });
  assert.deepEqual(r.notices.map((n) => n.kind), ["missing"]);
  assert.match(r.notices[0].reason, /venus/);
});

test("mars: all 59 sources including HRSC HMC-30, Gale and Jezero/MSR appear under raw/499", async () => {
  const hrsc = SOURCES.find((s) => s.product === "hrsc_mola_blend_200m_v2");
  const mega = SOURCES.find((s) => s.product === "mega_16");
  const r = await run({ cfg: config({ body: "mars" }), mirrorFor: [[hrsc], [mega], ...INSETS.map((s) => [s])] });
  assert.equal(r.rows.length, 59);
  assert.ok(r.rows.every((x) => x.body === "mars" && x.naif === "499"));
  assert.deepEqual(r.counts, { current: 34, "not-mirrored": 25 });
  assert.equal(r.states["hrsc_mola_blend_200m_v2/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"], "current");
  assert.equal(r.states["mega_16/mega90n000eb.img"], "current");
  for (const s of INSETS) {
    const row = r.rows.find((x) => x.product === s.product && x.file === s.file);
    assert.ok(row, `${s.product}/${s.file} appears in the Mars report`);
    assert.deepEqual([row.state, row.mirror_key, row.source_url, row.serves, row.source_size, Number(row.mirror_size), Number(row.pinned_size)],
      ["current", key(s), null, s.serves, null, s.pinnedSize, s.pinnedSize]);
    assert.deepEqual([row.source_etag, row.source_last_modified, row.probe_error], [null, null, null]);
    assert.equal(row.pinned_etag, null, "the inset table supplies size pins, not invented ETags");
  }
  assert.deepEqual(r.http.probed.slice().sort((a, b) => a - b), PROBED.filter((s) => s.body === "mars").map((s) => s.index));
  assert.equal(r.http.probed.length, 27);
  assert.equal(r.http.listings.length, 1);
  const query = r.http.listings[0].searchParams;
  assert.equal(query.get("prefix"), "raw/499/");
  assert.equal(query.get("max-keys"), "1000");
  assert.equal(query.has("delimiter"), false, "nested product/ovr keys must be returned as objects");
  const state = await mock.state();
  assert.ok(state.requests.some((q) => q.method === "GET" && q.query.includes("prefix=raw%2F499%2F")));
  assert.equal(Object.keys(state.objects).filter((k) => /^watch\/499\//.test(k)).length, 1);
  assert.deepEqual(r.results.map((x) => [x.ROUTE, x.STATUS]), [["put", 200]]);
});

test("Mars inset states come only from the mirror listing and byte-size pins, even with pins=off", async () => {
  const current = INSETS.find((s) => s.file === "ovr/HMC_11E10_dt5_rows.tif");
  const changed = INSETS.find((s) => s.file === "ovr/MSL_Gale_DEM_Mosaic_1m_v3_rows.tif");
  const missing = INSETS.find((s) => s.product === "msr_trn_hirise_dtm_1m_v003");
  // Exact byte count from body_insets() (2026-10-21 metadata); no frame/time scale;
  // one-byte perturbation must be detected, so tolerance is zero.
  const changedSize = 7578866128;
  for (const pins of ["on", "off"]) {
    const r = await run({ cfg: config({ body: "mars", pins }), mirrorFor: [[current, 474389369], [changed, changedSize]] });
    for (const [s, state, size] of [[current, "current", 474389369], [changed, "size-changed", changedSize], [missing, "not-mirrored", null]]) {
      const row = r.rows.find((x) => x.product === s.product && x.file === s.file);
      assert.deepEqual([row.state, row.mirror_size, row.pinned_size], [state, size, s.pinnedSize]);
      assert.deepEqual([row.source_url, row.source_etag, row.source_size, row.probe_error], [null, null, null, null]);
    }
    assert.equal(r.rows.length, 59);
    assert.deepEqual(r.counts, { "not-mirrored": 57, current: 1, "size-changed": 1 });
    assert.deepEqual(r.notices[0].items, [`${changed.product}/${changed.file}=size-changed`]);
    assert.equal(r.http.probed.length, 27);
    assert.ok(r.http.probed.every((index) => !INSETS.some((s) => s.index === index)));
  }
});

test("an unreadable Mars mirror leaves inset state unknown and stores nothing", async () => {
  const r = await run({ cfg: config({ body: "mars" }), credential: false });
  assert.equal(r.rows.length, 59);
  for (const s of INSETS) {
    const row = r.rows.find((x) => x.product === s.product && x.file === s.file);
    assert.deepEqual([row.state, row.mirror_size, row.source_url, row.source_size, row.probe_error], [null, null, null, null, null]);
    assert.equal(row.pinned_size, s.pinnedSize);
  }
  assert.equal(r.http.probed.length, 27);
  assert.match(r.notices[0].reason, /mirror unreadable/);
  assert.equal((await mock.state()).requests.length, 0);
});
