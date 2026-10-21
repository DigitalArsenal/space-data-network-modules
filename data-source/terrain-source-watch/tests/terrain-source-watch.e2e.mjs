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
const SOURCES = [...fs.readFileSync(path.join(PACKAGE, "src", "watch_sources.hpp"), "utf8").matchAll(/^\s+\{"(\w+)", "(\d+)", "(\w+)", "([^"]+)", "([^"]+)", "((?:\\"|[^"])*)", "([^"]*)"\},$/gm)]
  .map((m, i) => ({ index: i, body: m[1], naif: m[2], product: m[3], file: m[4], url: m[5], pinned: m[6].replaceAll('\\"', '"'), serves: m[7] }));
const sizeOf = (s) => 1000 + s.index;
const key = (s) => `raw/${s.naif}/${s.product}/${s.file}`;

let wasm, mock;
before(async () => {
  wasm = H.compileFlow(H.loadFlow("terrain-refresh"));
  mock = await H.startMockS3({ accessKey: ACCESS, secret: SECRET, bucket: BUCKET, region: "auto" });
});
after(() => mock?.stop());

// ---- the simulated publishers + the real mirror -----------------------------------------------------------------------
function httpFor(overrides = {}) {
  const probed = [];
  const fn = (request) => {
    if (request.url.startsWith(mock.endpoint)) return H.syncHttp(request);
    const source = SOURCES.find((s) => s.url === request.url);
    assert.ok(source, `a probe of a URL the table does not hold: ${request.url}`);
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
  return fn;
}
const tick = () => H.encodeTimerTick({ triggerId: "terrain-refresh-watch", firedMs: Date.now() });
const config = (extra = {}) => ({ body: "moon", store: "r2", endpoint: mock.endpoint, bucket: BUCKET, region: "auto", ...extra });
async function run({ cfg = config(), overrides = {}, credential = true, mirrorFor = [] } = {}) {
  await mock.reset();
  for (const [s, size, modified] of mirrorFor) await mock.seed(key(s), size ?? sizeOf(s), modified);
  const http = httpFor(overrides);
  const node = H.createNode({ store: credential ? new Map([["storage_r2", { username: ACCESS, secret: SECRET }]]) : new Map(), http, config: cfg });
  const { outputs } = await H.runFlow({ wasm, node, inputs: [{ trigger: 0, portId: "tick", payload: tick() }] });
  const out = { node, http, report: null, notices: [], results: [], rows: [] };
  for (const b of outputs) {
    assert.ok(!Buffer.from(b).includes(Buffer.from(SECRET)), "an egress frame carries the secret");
    if (H.idAt(b, 8) === "$QRP") { out.report = H.readQrp(b, true); out.reportBytes = Buffer.from(b); out.rows = H.rowsOf(out.report); }
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
  assert.equal(SOURCES.length, 61);
  assert.deepEqual([SOURCES.filter((s) => s.body === "moon").length, SOURCES.filter((s) => s.body === "mars").length], [34, 27]);
  assert.ok(SOURCES.every((s) => s.pinned.startsWith('"') && s.url.startsWith("https://")), "every source is pinned to an ETag");
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

test("both bodies in one run: 61 probes, two listings, two reports, two puts, two notices; the frames fit one invocation", async () => {
  const hrsc = SOURCES.find((s) => s.product === "hrsc_mola_blend_200m_v2");
  await mock.reset();
  await mock.seed(key(ldem4), sizeOf(ldem4));
  await mock.seed(key(hrsc), sizeOf(hrsc));
  const http = httpFor();
  const node = H.createNode({ store: new Map([["storage_r2", { username: ACCESS, secret: SECRET }]]), http, config: config({ bodies: "moon, mars" }) });
  const { outputs } = await H.runFlow({ wasm, node, inputs: [{ trigger: 0, portId: "tick", payload: tick() }] });
  const reports = outputs.filter((b) => H.idAt(b, 8) === "$QRP").map((b) => H.readQrp(b, true));
  assert.deepEqual(reports.map((r) => H.rowsOf(r).length).sort((a, b) => a - b), [27, 34]);
  assert.equal(http.probed.length, 61);
  const notices = outputs.filter((b) => H.idAt(b, 4) === "FNTC").map((b) => H.decodeFlowNotice(b));
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map((n) => /check (moon|mars) /.exec(n.reason)[1]).sort(), ["mars", "moon"]);
  const stored = Object.keys((await mock.state()).objects).filter((k) => k.startsWith("watch/")).sort();
  assert.deepEqual(stored.map((k) => k.split("/")[1]), ["301", "499"]);
});

test("a body the table lacks is unconfigured, not skipped", async () => {
  // a name the table lacks is refused (a run whose probes and listings exceed 64 frames is refused the same way)
  const r = await run({ cfg: config({ bodies: "moon,venus" }) });
  assert.deepEqual(r.notices.map((n) => n.kind), ["missing"]);
  assert.match(r.notices[0].reason, /venus/);
});

test("mars: its own table, NAIF 499 and the HRSC blend by its published name", async () => {
  const hrsc = SOURCES.find((s) => s.product === "hrsc_mola_blend_200m_v2");
  const mega = SOURCES.find((s) => s.product === "mega_16");
  const r = await run({ cfg: config({ body: "mars", bodies: undefined }), mirrorFor: [[hrsc, 11384463908 > 1e6 ? sizeOf(hrsc) : 1], [mega]] });
  assert.equal(r.rows.length, 27);
  assert.ok(r.rows.every((x) => x.body === "mars" && x.naif === "499"));
  assert.equal(r.states["hrsc_mola_blend_200m_v2/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"], "current");
  assert.equal(r.states["mega_16/mega90n000eb.img"], "current");
  assert.equal(Object.keys((await mock.state()).objects).some((k) => /^watch\/499\//.test(k)), true);
});
