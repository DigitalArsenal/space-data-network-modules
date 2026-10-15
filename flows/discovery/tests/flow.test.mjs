/*
 * Flow-level tests for the compiled discovery flows (typed contracts 1.0): peers, standards, pnm and latest. Each
 * artifact is the one a daemon mounts; a $HTQ enters foundation/http-route discover, the $APR decision and the typed
 * answer ($NST / $PNV / $DAV + records) travel route -> hostcap/p2p-discovery -> foundation/http-respond linked-direct
 * inside the artifact, and the only host crossings are the typed $PIV hostcalls (p2p.*, node.peerId, clock.now),
 * answered here on the wire the way a typed host answers them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest } from "space-data-module-sdk/http";
import { decodeHostCall, encodeHostCallResult } from "space-data-module-sdk/runtime-contracts";

const WASM = {
  peers: new URL("../dist/peers/runtime.wasm", import.meta.url),
  standards: new URL("../dist/standards/runtime.wasm", import.meta.url),
  pnm: new URL("../dist/pnm/runtime.wasm", import.meta.url),
  latest: new URL("../dist/latest/runtime.wasm", import.meta.url),
};
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
const [APR, NST, PNV, DAV, EPM, OMM, PNM] = await Promise.all(["APR", "NST", "PNV", "DAV", "EPM", "OMM", "PNM"].map(loadStandard));

const SELF = "12D3KooWSelfNode";
const PEER_A = "12D3KooWPeerAlpha";
const PEER_B = "12D3KooWPeerBravo";
const NOW_MS = 1_791_936_000_123n;

const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const decode = (mod, code, bytes) => {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.ok(mod[code].bufferHasIdentifier(bb), `a $${code} frame`);
  return mod[code][`getRootAs${code}`](bb).unpack();
};
// A real stored profile: a size-prefixed $EPM with DN, LEGAL_NAME and a signing + encryption key.
function epmFrame({ dn, legalName, signing, encryption }) {
  const b = new flatbuffers.Builder(256);
  const t = new EPM.EPMT();
  t.DN = dn; t.LEGAL_NAME = legalName; t.ENTITY_TYPE = EPM.EntityType.Node;
  t.KEYS = [
    Object.assign(new EPM.CryptoKeyT(), { PUBLIC_KEY: signing, KEY_TYPE: EPM.KeyType.Signing }),
    Object.assign(new EPM.CryptoKeyT(), { PUBLIC_KEY: encryption, KEY_TYPE: EPM.KeyType.Encryption }),
  ];
  b.finishSizePrefixed(t.pack(b), "$EPM");
  return b.asUint8Array().slice();
}
// $OMM records as the store delivers them (size-prefixed, concatenated).
function ommFrame(fields) {
  const b = new flatbuffers.Builder(256);
  b.finishSizePrefixed(Object.assign(new OMM.OMMT(), fields).pack(b), "$OMM");
  return b.asUint8Array().slice();
}
// Received $PNM notices as the host stores them (size-prefixed), referenced by PNM_INDEX.
function pnmFrame(fields) {
  const b = new flatbuffers.Builder(256);
  b.finishSizePrefixed(Object.assign(new PNM.PNMT(), fields).pack(b), "$PNM");
  return b.asUint8Array().slice();
}
const PNM_FRAMES = [pnmFrame({ FILE_ID: "f-omm-1", CID: "bafyomm" }), pnmFrame({ FILE_ID: "f-wxf-9", CID: "bafywxf" })];
const ETAG_FORMAT = /^W\/"fnv1a64-[0-9a-f]{16}"$/;
const OMM_RECORDS = concat(ommFrame({ NORAD_CAT_ID: 25544, OBJECT_NAME: "ISS (ZARYA)", MEAN_MOTION: 15.5 }), ommFrame({ NORAD_CAT_ID: 20580, OBJECT_NAME: "HST", MEAN_MOTION: 15.1 }));

const PEERS_ANSWER = {
  result: { SELF, PEER_ID: "" },
  lists: {
    peers: [
      { PEER_ID: PEER_A, CONNECTED: true, SELF: false, EPM_INDEX: 0, AGENT_VERSION: "sdn-server/1.4.1" },
      { PEER_ID: SELF, CONNECTED: false, SELF: true, EPM_INDEX: -1, AGENT_VERSION: "sdn-server/1.4.2" },
    ],
    peer_addresses: [{ PEER_ID: PEER_A, VALUE: "/ip4/10.0.0.2/tcp/4001" }, { PEER_ID: SELF, VALUE: "/ip4/10.0.0.1/tcp/4001" }],
    peer_standards: [{ PEER_ID: PEER_A, VALUE: "OMM" }],
  },
  raw: { records: epmFrame({ dn: "CN=alpha.node", legalName: "Alpha Orbital", signing: "02aa", encryption: "03bb" }) },
};
const PNM_ENTRIES = [
  { PEER_ID: PEER_A, PUBLISHER_PEER_ID: PEER_A, GOSSIP_PEER_ID: PEER_A, STANDARD: "OMM", SCHEMA: "OMM.fbs", FILE_ID: "f-omm-1", FILE_NAME: "omm.fbs", CID: "bafyomm", PUBLISH_MS: 1791900000000n,
    SIGNATURE_TYPE: "ed25519", SIGNATURE_HEX: "deadbeef", SIGNATURE_VERIFIED: true, ATTRIBUTION: "signature", PNM_INDEX: 0, PUBLISHER_KEY_HEX: "0a0b", PUBLISHER_KEY_SOURCE: "epm-directory" },
  { PEER_ID: PEER_B, PUBLISHER_PEER_ID: PEER_B, GOSSIP_PEER_ID: SELF, STANDARD: "WXF", SCHEMA: "WXF.fbs", FILE_ID: "f-wxf-9", FILE_NAME: "wxf.fbs", CID: "bafywxf", PUBLISH_MS: 1791900005000n,
    SIGNATURE_TYPE: "ed25519", SIGNATURE_HEX: "c0ffee", SIGNATURE_VERIFIED: false, ATTRIBUTION: "gossip", PNM_INDEX: 1, PUBLISHER_KEY_HEX: "", PUBLISHER_KEY_SOURCE: "" },
];
const LATEST = { KNOWN: true, REASON: "", PINNED: true, SELF: false, FRESH: true, STANDARD: "OMM", SCHEMA: "OMM.fbs", PNM_CID: "bafypnm", PNM_FILE_ID: "f-omm-1", PNM_PUBLISH_MS: 1791900000000n,
  PNM_SIGNATURE_VERIFIED: true, PNM_ATTRIBUTION: "signature", BATCH_ID: "batch-77", PROVIDER_ID: "celestrak", SOURCE_NAME: "gp-active", RECORD_COUNT: 2n, BYTE_COUNT: BigInt(OMM_RECORDS.length), PARTS: 1,
  PUBLISHED_MS: 1791900001000n, ETAG_FNV1A64: "0123456789abcdef" };
const LATEST_ETAG = 'W/"fnv1a64-0123456789abcdef"';

// A typed host on the wire: each $PIV call is decoded and answered with a $PIV response. answers[op] is a value or a
// function of the decoded call; an Error thrown (with .code) becomes STATUS FAILED.
function typedHost(answers = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const answer = (call) => {
    if (call.op === "clock.now") return { result: { UNIX_MS: NOW_MS } };
    if (call.op === "node.peerId") return { raw: { value: SELF } };
    const a = answers[call.op];
    if (!a) throw Object.assign(new Error(`unexpected op ${call.op}`), { code: "unsupported" });
    return typeof a === "function" ? a(call) : a;
  };
  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, ptr, len) {
        const call = decodeHostCall(new Uint8Array(memoryRef.memory.buffer).slice(ptr, ptr + len));
        calls.push(call);
        let out;
        try { out = { ok: true, op: call.op, ...answer(call) }; } catch (error) { out = { ok: false, error: { code: error.code ?? "failed", message: error.message } }; }
        response = encodeHostCallResult(out);
        return 0;
      },
      response_len: () => response.length,
      read_response(dst, len) {
        const n = Math.min(len, response.length);
        new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst);
        return n;
      },
    },
  };
  return { calls, p2p: () => calls.filter((c) => c.op.startsWith("p2p.")), imports, memoryRef };
}

async function serve(flow, host, request) {
  const runtime = await createFlowRuntimeHost({ wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(WASM[flow]))), extraImports: host.imports, runtimeTarget: "wasmedge" });
  host.memoryRef.memory = runtime.memory;
  const responses = [];
  runtime.enqueueTriggerFrame(0, { portId: "request", bytes: encodeHttpRequest(request) });
  await runtime.drain({ "sdn.flow.egress:emit": ({ frames }) => { for (const f of frames) responses.push(decodeHttpResponse(f.bytes)); return { statusCode: 0 }; } }, { maxIterations: 100 });
  assert.equal(responses.length, 1, "exactly one $HTR");
  const [http] = responses;
  http.header = (name) => http.headers.find((h) => h.name === name)?.value;
  http.json = () => JSON.parse(new TextDecoder().decode(http.body));
  return http;
}

test("peers: GET answers one $NST (identity from the stored $EPM) as FlatBuffers, and as JSON on request", async () => {
  const host = typedHost({ "p2p.peers_snapshot": PEERS_ANSWER });
  const http = await serve("peers", host, { method: "GET", path: "/api/v1/peers" });
  assert.equal(http.status, 200);
  assert.deepEqual([http.header("content-type"), http.header("x-sdn-file-identifier")], ["application/x-flatbuffers", "$NST"]);
  const nst = decode(NST, "NST", http.body);
  assert.match(nst.ETAG, ETAG_FORMAT);
  assert.equal(http.header("etag"), nst.ETAG, "the $NST ETAG is the answer's entity tag");
  assert.equal(nst.SOURCE_PEER_ID, SELF);
  assert.equal(BigInt(nst.GENERATED_AT), NOW_MS);
  const [alpha, self] = nst.NODES;
  assert.deepEqual([alpha.PEER_ID, alpha.IS_ONLINE, alpha.IS_SELF, alpha.SOURCE, alpha.MULTIFORMAT_ADDRESS], [PEER_A, true, false, "connected", ["/ip4/10.0.0.2/tcp/4001"]]);
  assert.deepEqual([alpha.DN, alpha.ORGANIZATION, alpha.SIGNING_PUBLIC_KEY, alpha.ENCRYPTION_PUBLIC_KEY], ["CN=alpha.node", "Alpha Orbital", "02aa", "03bb"]);
  assert.deepEqual([self.PEER_ID, self.IS_SELF, self.IS_ONLINE, self.DN, self.MULTIFORMAT_ADDRESS], [SELF, true, false, null, ["/ip4/10.0.0.1/tcp/4001"]]);
  assert.deepEqual([alpha.STANDARDS, self.STANDARDS], [["OMM"], []], "the host's peer_standards rows");
  const [call] = host.p2p();
  assert.deepEqual([call.op, call.params.PEER_ID ?? "", call.params.DELIVER], ["p2p.peers_snapshot", "", 0], "no PEER_ID; DELIVER Inline");

  const json = await serve("peers", typedHost({ "p2p.peers_snapshot": PEERS_ANSWER }), { method: "GET", path: "/api/v1/peers", query: "format=json" });
  assert.equal(json.header("content-type"), "application/json");
  const body = json.json();
  assert.equal(body.SOURCE_PEER_ID, SELF);
  assert.deepEqual(body.NODES.map((n) => [n.PEER_ID, n.DN, n.IS_ONLINE]), [[PEER_A, "CN=alpha.node", true], [SELF, null, false]]);
  assert.deepEqual([body.ETAG, body.NODES[0].STANDARDS], [nst.ETAG, ["OMM"]]);
  assert.equal(json.header("etag"), nst.ETAG, "the tag is stable across calls (GENERATED_AT is not hashed)");

  const notModified = await serve("peers", typedHost({ "p2p.peers_snapshot": PEERS_ANSWER }), { method: "GET", path: "/api/v1/peers", headers: { "If-None-Match": nst.ETAG } });
  assert.deepEqual([notModified.status, notModified.header("etag"), notModified.body.length], [304, nst.ETAG, 0]);
});

test("peers: /peers/{id} narrows to one peer; an unknown peer answers 404 peer-unknown", async () => {
  const host = typedHost({ "p2p.peers_snapshot": PEERS_ANSWER });
  const one = await serve("peers", host, { method: "GET", path: `/api/v1/peers/${PEER_A}` });
  assert.equal(one.status, 200);
  assert.deepEqual(decode(NST, "NST", one.body).NODES.map((n) => n.PEER_ID), [PEER_A]);
  assert.equal(host.p2p()[0].params.PEER_ID, PEER_A);

  const missing = await serve("peers", typedHost({ "p2p.peers_snapshot": PEERS_ANSWER }), { method: "GET", path: "/api/v1/peers/12D3KooWNobody", query: "format=json" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().code, "peer-unknown");
  assert.match(missing.json().error, /12D3KooWNobody/);
});

test("peers: a non-GET request is refused 404 without any hostcall; a p2p failure answers 502 host-failed", async () => {
  const host = typedHost({ "p2p.peers_snapshot": PEERS_ANSWER });
  const post = await serve("peers", host, { method: "POST", path: "/api/v1/peers" });
  assert.equal(post.status, 404);
  assert.equal(decode(APR, "APR", post.body).ERROR_CODE, "no-route", "the refusal record itself, as FlatBuffers");
  assert.equal(host.calls.length, 0, "never reaches the host");

  const failing = typedHost({ "p2p.peers_snapshot": () => { throw Object.assign(new Error("peerstore unavailable"), { code: "failed" }); } });
  const http = await serve("peers", failing, { method: "GET", path: "/api/v1/peers", query: "format=json" });
  assert.equal(http.status, 502);
  assert.equal(http.json().code, "host-failed");
  assert.match(http.json().error, /peerstore unavailable/);
});

test("standards: one $PNV entry per notice, signatures and keys as bytes; JSON renders them hex", async () => {
  const answers = { "p2p.standards_snapshot": { lists: { entries: PNM_ENTRIES }, raw: { records: concat(...PNM_FRAMES) } } };
  const http = await serve("standards", typedHost(answers), { method: "GET", path: "/api/v1/standards" });
  assert.deepEqual([http.status, http.header("x-sdn-file-identifier")], [200, "$PNV"]);
  const pnv = decode(PNV, "PNV", http.body);
  assert.equal(pnv.VERIFIER_PEER_ID, SELF);
  const [omm, wxf] = pnv.ENTRIES;
  assert.deepEqual([omm.PUBLISHER_PEER_ID, omm.STANDARD, omm.FILE_ID, omm.CID, BigInt(omm.PUBLISHED_AT_MS)], [PEER_A, "OMM", "f-omm-1", "bafyomm", 1791900000000n]);
  assert.deepEqual(omm.SIGNATURE, [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual(omm.PUBLISHER_KEY, [0x0a, 0x0b]);
  assert.deepEqual([omm.SIGNATURE_VERIFIED, omm.ATTRIBUTION, omm.KEY_SOURCE], [true, PNV.pnvAttribution.Direct, PNV.pnvKeySource.IdentityRecord]);
  assert.deepEqual([wxf.SIGNATURE_VERIFIED, wxf.ATTRIBUTION, wxf.KEY_SOURCE], [false, PNV.pnvAttribution.Unattributed, PNV.pnvKeySource.None]);
  assert.deepEqual([Uint8Array.from(omm.PNM_BYTES), Uint8Array.from(wxf.PNM_BYTES)], PNM_FRAMES, "each received $PNM verbatim, so a reader can verify it");
  assert.match(pnv.ETAG, ETAG_FORMAT);
  assert.equal(http.header("etag"), pnv.ETAG);
  const notModified = await serve("standards", typedHost(answers), { method: "GET", path: "/api/v1/standards", headers: { "If-None-Match": pnv.ETAG } });
  assert.deepEqual([notModified.status, notModified.body.length], [304, 0]);

  const json = (await serve("standards", typedHost(answers), { method: "GET", path: "/api/v1/standards", headers: { Accept: "application/json" } })).json();
  assert.equal(json.VERIFIER_PEER_ID, SELF);
  assert.deepEqual(json.ENTRIES.map((e) => [e.STANDARD, e.SIGNATURE, e.PUBLISHER_KEY, e.ATTRIBUTION, e.KEY_SOURCE]),
    [["OMM", "deadbeef", "0a0b", "Direct", "IdentityRecord"], ["WXF", "c0ffee", null, "Unattributed", "None"]]);
});

test("pnm: the clamped limit reaches P2pParams.LIMIT; no recorded publications answer 404 no-publications", async () => {
  const relayed = { ...PNM_ENTRIES[0], GOSSIP_PEER_ID: PEER_B };
  const answers = { "p2p.pnm_history": (call) => (call.params.PEER_ID === PEER_A
    ? { result: { SELF, PEER_ID: PEER_A, PUBLISHER_KEY_AVAILABLE: true, GOSSIP_ONLY_EXCLUDED: 0 }, lists: { entries: [relayed] } }
    : { result: { SELF, PEER_ID: call.params.PEER_ID }, lists: { entries: [] } }) };
  const host = typedHost(answers);
  const http = await serve("pnm", host, { method: "GET", path: `/api/v1/peers/${PEER_A}/pnm`, query: "limit=500" });
  assert.equal(http.status, 200);
  const pnv = decode(PNV, "PNV", http.body);
  assert.deepEqual([pnv.VERIFIER_PEER_ID, pnv.ENTRIES.length, pnv.ENTRIES[0].ATTRIBUTION], [SELF, 1, PNV.pnvAttribution.Relayed]);
  assert.deepEqual([host.p2p()[0].params.PEER_ID, host.p2p()[0].params.LIMIT], [PEER_A, 100], "limit clamped to 100");

  const defaultHost = typedHost(answers);
  await serve("pnm", defaultHost, { method: "GET", path: `/api/v1/peers/${PEER_A}/pnm` });
  assert.equal(defaultHost.p2p()[0].params.LIMIT, 1, "default 1 = the newest publication");
  assert.match(pnv.ETAG, ETAG_FORMAT);
  const notModified = await serve("pnm", typedHost(answers), { method: "GET", path: `/api/v1/peers/${PEER_A}/pnm`, query: "limit=500", headers: { "If-None-Match": pnv.ETAG } });
  assert.equal(notModified.status, 304);

  const none = await serve("pnm", typedHost(answers), { method: "GET", path: `/api/v1/peers/${PEER_B}/pnm`, query: "format=json" });
  assert.deepEqual([none.status, none.json().code], [404, "no-publications"]);
});

test("latest: a served dataset is [$DAV][records] as one stream, an $OMM array as JSON, 304 on its etag", async () => {
  const answers = { "p2p.latest_dataset": { result: LATEST, raw: { stream: OMM_RECORDS } } };
  const host = typedHost(answers);
  const http = await serve("latest", host, { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest` });
  assert.equal(http.status, 200);
  assert.deepEqual([http.header("content-type"), http.header("x-sdn-record-count"), http.header("etag")], ["application/vnd.sdn.flatbuffers.stream", "2", LATEST_ETAG]);
  const view = new DataView(http.body.buffer, http.body.byteOffset, http.body.byteLength);
  const davLength = view.getUint32(0, true);
  const dav = decode(DAV, "DAV", http.body.slice(4, 4 + davLength));
  assert.deepEqual([dav.STANDARD, dav.AVAILABLE, dav.BATCH_ID, dav.PUBLISHER_PEER_ID, dav.ETAG], ["OMM", true, "batch-77", PEER_A, LATEST_ETAG]);
  const recordsAt = Math.ceil((4 + davLength) / 8) * 8;
  assert.deepEqual(http.body.slice(recordsAt), OMM_RECORDS, "the records verbatim after the $DAV");
  const [call] = host.p2p();
  assert.deepEqual([call.params.PEER_ID, call.params.STANDARD, call.params.DELIVER], [PEER_A, "omm", 1], "FlatBuffers ask DELIVER Ref; a host that answers inline is served inline");

  const jsonHost = typedHost(answers);
  const json = await serve("latest", jsonHost, { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest`, query: "format=json" });
  assert.equal(jsonHost.p2p()[0].params.DELIVER, 0, "JSON asks DELIVER Inline: the responder renders the bytes");
  assert.deepEqual([json.status, json.header("x-sdn-record-count"), json.header("etag")], [200, "2", LATEST_ETAG]);
  assert.deepEqual(json.json().map((r) => [r.NORAD_CAT_ID, r.OBJECT_NAME, r.MEAN_MOTION]), [[25544, "ISS (ZARYA)", 15.5], [20580, "HST", 15.1]]);

  const notModified = await serve("latest", typedHost(answers), { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest`, headers: { "If-None-Match": LATEST_ETAG } });
  assert.deepEqual([notModified.status, notModified.header("etag"), notModified.body.length], [304, LATEST_ETAG, 0]);
});

test("latest: a host BodyRef answers the $HTR by reference (no inline body), 304 on its etag; JSON asks Inline", async () => {
  const REF = { TOKEN: 4242n, SIZE: BigInt(OMM_RECORDS.length), FRAMES: 2n, FNV1A64: "0123456789abcdef" };
  const answers = { "p2p.latest_dataset": (call) => (call.params.DELIVER === 1 ? { result: { ...LATEST, REF } } : { result: LATEST, raw: { stream: OMM_RECORDS } }) };
  const host = typedHost(answers);
  const http = await serve("latest", host, { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest` });
  assert.deepEqual([http.status, http.body.length, Number(http.bodyRefToken), http.bodyRefSize], [200, 0, 4242, OMM_RECORDS.length]);
  assert.deepEqual([http.header("content-type"), http.header("x-sdn-record-count"), http.header("etag")], ["application/vnd.sdn.flatbuffers.stream", "2", LATEST_ETAG]);
  assert.equal(host.p2p()[0].params.DELIVER, 1);

  const notModified = await serve("latest", typedHost(answers), { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest`, headers: { "If-None-Match": LATEST_ETAG } });
  assert.deepEqual([notModified.status, notModified.body.length, Number(notModified.bodyRefToken)], [304, 0, 0]);

  const json = await serve("latest", typedHost(answers), { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest`, query: "format=json" });
  assert.deepEqual([json.status, Number(json.bodyRefToken)], [200, 0]);
  assert.deepEqual(json.json().map((r) => r.NORAD_CAT_ID), [25544, 20580]);
});

test("latest: a published shard (each stored size-prefixed record in a shard frame of its own) renders as JSON", async () => {
  // The node serves a batch's shard files verbatim: [u32 frame][u32 record][record] per record.
  const shardFrame = (record) => { const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, record.length, true); return concat(prefix, record); };
  const shard = concat(shardFrame(ommFrame({ NORAD_CAT_ID: 25544, OBJECT_NAME: "ISS (ZARYA)", MEAN_MOTION: 15.5 })), shardFrame(ommFrame({ NORAD_CAT_ID: 20580, OBJECT_NAME: "HST", MEAN_MOTION: 15.1 })));
  const answers = { "p2p.latest_dataset": { result: { ...LATEST, BYTE_COUNT: BigInt(shard.length) }, raw: { stream: shard } } };
  const json = await serve("latest", typedHost(answers), { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest`, query: "format=json" });
  assert.deepEqual([json.status, json.header("x-sdn-record-count"), json.header("etag")], [200, "2", LATEST_ETAG]);
  assert.deepEqual(json.json().map((r) => [r.NORAD_CAT_ID, r.OBJECT_NAME]), [[25544, "ISS (ZARYA)"], [20580, "HST"]]);
  const fb = await serve("latest", typedHost(answers), { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest` });
  assert.deepEqual([fb.status, fb.header("x-sdn-record-count")], [200, "2"]);
  assert.deepEqual(fb.body.slice(fb.body.length - shard.length), shard, "the shard verbatim after the $DAV");
});

test("latest: known but unpinned answers 503 with the $DAV and the newest notice's pointer; unknown answers 404 with the $DAV", async () => {
  const unpinned = await serve("latest", typedHost({ "p2p.latest_dataset": { result: { ...LATEST, PINNED: false, REASON: "not-pinned" } } }),
    { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest`, query: "format=json" });
  assert.equal(unpinned.status, 503);
  const body = unpinned.json();
  assert.deepEqual([body.AVAILABLE, body.UNAVAILABLE_REASON, body.PNM_CID, body.PNM_FILE_ID, body.PNM_PUBLISHED_AT_MS], [false, "NotHeld", "bafypnm", "f-omm-1", 1791900000000]);
  const unpinnedFb = await serve("latest", typedHost({ "p2p.latest_dataset": { result: { ...LATEST, PINNED: false, REASON: "not-pinned" } } }), { method: "GET", path: `/api/v1/peers/${PEER_A}/omm/latest` });
  assert.deepEqual([unpinnedFb.status, unpinnedFb.header("x-sdn-file-identifier")], [503, "$DAV"]);
  assert.equal(decode(DAV, "DAV", unpinnedFb.body).UNAVAILABLE_REASON, DAV.davUnavailableReason.NotHeld);

  const unknown = await serve("latest", typedHost({ "p2p.latest_dataset": { result: { ...LATEST, KNOWN: false, REASON: "no-publications" } } }), { method: "GET", path: `/api/v1/peers/${PEER_B}/omm/latest` });
  assert.deepEqual([unknown.status, unknown.header("x-sdn-file-identifier")], [404, "$DAV"]);
  const dav = decode(DAV, "DAV", unknown.body);
  assert.deepEqual([dav.KNOWN, dav.UNAVAILABLE_REASON], [false, DAV.davUnavailableReason.NotPublished]);
});

test("each bundle carries its api block for the OpenAPI generator", () => {
  const api = (flow) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../dist/${flow}/flow.json`, import.meta.url)), "utf8")).api;
  const expect = {
    peers: ["/api/v1/peers", ["application/json", "application/x-flatbuffers"]],
    standards: ["/api/v1/standards", ["application/json", "application/x-flatbuffers"]],
    pnm: ["/api/v1/peers/{peerId}/pnm", ["application/json", "application/x-flatbuffers"]],
    latest: ["/api/v1/peers/{peerId}/{standard}/latest", ["application/json", "application/vnd.sdn.flatbuffers.stream"]],
  };
  for (const [flow, [basePath, types]] of Object.entries(expect)) {
    const a = api(flow);
    assert.equal(a.basePath, basePath, flow);
    for (const route of a.routes) {
      assert.equal(route.method, "GET");
      assert.deepEqual(Object.keys(route.responses["200"].content).sort(), types, flow);
    }
  }
  assert.deepEqual(api("peers").routes.map((r) => r.path), ["", "{peerId}"]);
  assert.ok(api("latest").routes[0].responses["503"]);
  assert.ok(api("latest").routes[0].responses["304"], "latest documents its conditional GET");
});
