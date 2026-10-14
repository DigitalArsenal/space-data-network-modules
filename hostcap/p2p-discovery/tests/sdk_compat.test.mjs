import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeHostCall, encodeHostCallResult } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// hostcap/p2p-discovery on the typed contracts (1.0): an $APR routing decision in, the $APR (verbatim or refused)
// beside a typed body out ($NST / $PNV / $DAV + the batch on its standard's port), and the p2p.* reads SDS $PIV
// hostcalls. The host here answers the module's actual $PIV request from guest memory with a full $PIV response (the
// aligned records and frames the Go node sends), so the tests assert the module's own request bytes (PEER_ID, STANDARD,
// LIMIT, DELIVER) and its reading of the node's exact answers.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);

// The standards' own generated TS bindings, bundled once with the standards repo's esbuild.
async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const out = await esbuild.build({
    entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", logLevel: "silent",
    alias: { flatbuffers: fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js")) },
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const [APR, NST, PNV, DAV, EPM] = await Promise.all(["APR", "NST", "PNV", "DAV", "EPM"].map(loadStandard));

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: "flatbuffer" });
const RECORD_CODES = "omm mpe cat spw eop csm egp sit lcc tbs gnp wxf cnp rfb iqc tct dtt".split(" ");

const SELF = "12D3KooWSelfNode";
const PEER_A = "12D3KooWPeerAlpha";
const PEER_B = "12D3KooWPeerBravo";
const NOW_MS = 1_791_936_000_123n;

function encodeApr({ route, params = {}, status = 0, method = APR.aprMethod.GET, path: p = "/api/v1/network/peers", accept = APR.aprRepresentation.Default }) {
  const b = new flatbuffers.Builder(256);
  const t = new APR.APRT();
  t.METHOD = method; t.PATH = p; t.ROUTE = route; t.STATUS = status; t.ACCEPT = accept;
  t.PARAMETERS = Object.entries(params).map(([NAME, VALUE]) => Object.assign(new APR.APRParameterT(), { NAME, VALUE: String(VALUE) }));
  if (status) { t.ERROR_CODE = "method-not-allowed"; t.ERROR_MESSAGE = "decided upstream"; }
  b.finish(t.pack(b), "$APR");
  return b.asUint8Array();
}
const decisionFrame = (spec) => ({ portId: "decision", typeRef: typeRef("APR"), payload: encodeApr(spec) });
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
  return b.asUint8Array();
}
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
// The smallest valid FlatBuffer root carrying file identifier `$CODE` (an empty table), as a size-prefixed stream.
function emptyRecord(code) {
  const b = new Uint8Array(16), v = new DataView(b.buffer);
  v.setUint32(0, 12, true);
  b.set(new TextEncoder().encode(`$${code}`), 4);
  v.setUint16(8, 4, true); v.setUint16(10, 4, true);
  v.setInt32(12, 4, true);
  return b;
}
function recordStream(code, count) {
  const out = new Uint8Array(count * 20), v = new DataView(out.buffer);
  for (let i = 0; i < count; i++) { v.setUint32(i * 20, 16, true); out.set(emptyRecord(code), i * 20 + 4); }
  return out;
}

// The host: decodes the module's $PIV call from guest memory and answers with an encoded $PIV response.
function host(answers) {
  const calls = [];
  const answer = (call) => {
    if (call.op === "clock.now") return { result: { UNIX_MS: NOW_MS } };
    if (call.op === "node.peerId") return { raw: { value: SELF } };
    const a = answers[call.op];
    if (!a) throw Object.assign(new Error(`unexpected hostcall ${call.op}`), { code: "unsupported" });
    if (a.error) throw Object.assign(new Error(a.error.message), { code: a.error.code });
    return typeof a === "function" ? a(call) : a;
  };
  return { calls, p2p: () => calls.filter((c) => c.op.startsWith("p2p.")), answer };
}
async function harnessFor(t, h) {
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (source, imports) => {
    let memory, response = new Uint8Array(0);
    const bridge = {
      ...imports.space_data_module_host,
      call(_opPtr, _opLen, ptr, len) {
        const call = decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice());
        h.calls.push(call);
        try { response = encodeHostCallResult({ ok: true, op: call.op, ...h.answer(call) }); }
        catch (e) { response = encodeHostCallResult({ ok: false, error: { code: e.code ?? "failed", message: e.message } }); }
        return 0;
      },
      response_len: () => response.length,
      read_response(dst, len) { const n = Math.min(len, response.length); new Uint8Array(memory.buffer, dst, n).set(response.subarray(0, n)); return n; },
    };
    const result = await instantiate(source, { ...imports, space_data_module_host: bridge });
    const instance = result.instance ?? result;
    memory = instance.exports.memory;
    return result;
  };
  let harness;
  try {
    harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct", hostcallDispatch: () => { throw new Error("not reached"); } });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  return harness;
}
function outputs(result) {
  assert.equal(result.statusCode, 0, result.errorMessage);
  return Object.fromEntries(result.outputs.map((f) => [f.portId, f.payload]));
}

const PEERS_ANSWER = {
  result: { SELF, PEER_ID: "" },
  lists: {
    peers: [
      { PEER_ID: SELF, CONNECTED: false, SELF: true, EPM_INDEX: -1, AGENT_VERSION: "sdn-server/1.4.2" },
      { PEER_ID: PEER_A, CONNECTED: true, SELF: false, EPM_INDEX: 0, AGENT_VERSION: "sdn-server/1.4.1" },
      { PEER_ID: PEER_B, CONNECTED: false, SELF: false, EPM_INDEX: -1, AGENT_VERSION: "" },
    ],
    peer_addresses: [{ PEER_ID: PEER_A, VALUE: "/ip4/10.0.0.2/tcp/4001" }, { PEER_ID: PEER_A, VALUE: "/ip6/::1/tcp/4001" }, { PEER_ID: SELF, VALUE: "/ip4/10.0.0.1/tcp/4001" }],
    peer_standards: [{ PEER_ID: PEER_A, VALUE: "OMM" }, { PEER_ID: PEER_A, VALUE: "WXF" }],
  },
  raw: { records: epmFrame({ dn: "CN=alpha.node", legalName: "Alpha Orbital", signing: "02aa", encryption: "03bb" }) },
};
const PNM_STREAM = recordStream("PNM", 2);
const PNM_ENTRIES = [
  { PEER_ID: PEER_A, PUBLISHER_PEER_ID: PEER_A, GOSSIP_PEER_ID: PEER_A, STANDARD: "OMM", SCHEMA: "OMM.fbs", FILE_ID: "f-omm-1", FILE_NAME: "omm.fbs", CID: "bafyomm", PUBLISH_MS: 1791900000000n,
    SIGNATURE_TYPE: "ed25519", SIGNATURE_HEX: "deadbeef", SIGNATURE_VERIFIED: true, ATTRIBUTION: "signature", PNM_INDEX: 0, PUBLISHER_KEY_HEX: "0a0b", PUBLISHER_KEY_SOURCE: "epm-directory" },
  { PEER_ID: PEER_B, PUBLISHER_PEER_ID: PEER_B, GOSSIP_PEER_ID: SELF, STANDARD: "WXF", SCHEMA: "WXF.fbs", FILE_ID: "f-wxf-9", FILE_NAME: "wxf.fbs", CID: "bafywxf", PUBLISH_MS: 1791900005000n,
    SIGNATURE_TYPE: "ed25519", SIGNATURE_HEX: "c0ffee", SIGNATURE_VERIFIED: false, ATTRIBUTION: "gossip", PNM_INDEX: 1, PUBLISHER_KEY_HEX: "", PUBLISHER_KEY_SOURCE: "" },
];

test("hostcap/p2p-discovery passes SDK compliance with typed ports", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const methods = Object.fromEntries(readManifest().methods.map((m) => [m.methodId, m]));
  for (const method of Object.values(methods)) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes[0].acceptsAnyFlatbuffer, undefined, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes[0].wireFormat, "flatbuffer", port.portId);
    }
    assert.deepEqual(method.inputPorts.map((p) => p.acceptedTypeSets[0].allowedTypes[0].fileIdentifier), ["$APR"]);
  }
  const ids = (m) => Object.fromEntries(m.outputPorts.map((p) => [p.portId, p.acceptedTypeSets[0].allowedTypes[0].fileIdentifier]));
  assert.deepEqual(ids(methods.peers_snapshot), { decision: "$APR", peers: "$NST" });
  assert.deepEqual(ids(methods.standards_snapshot), { decision: "$APR", notices: "$PNV" });
  assert.deepEqual(ids(methods.pnm_history), { decision: "$APR", notices: "$PNV" });
  assert.deepEqual(ids(methods.latest_dataset), { decision: "$APR", availability: "$DAV", ...Object.fromEntries(RECORD_CODES.map((c) => [`${c}_records`, `$${c.toUpperCase()}`])) });
});

test("hostcap/p2p-discovery imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("peers_list: one p2p.peers_snapshot becomes one $NST, identity from the stored $EPM; the decision passes verbatim", async (t) => {
  const h = host({ "p2p.peers_snapshot": PEERS_ANSWER });
  const harness = await harnessFor(t, h);
  const request = encodeApr({ route: "peers_list" });
  const out = outputs(await harness.invoke({ methodId: "peers_snapshot", inputs: [{ portId: "decision", typeRef: typeRef("APR"), payload: request }] }));
  assert.deepEqual(out.decision, request, "the decision passes through verbatim");
  const nst = decode(NST, "NST", out.peers);
  assert.equal(nst.SOURCE_PEER_ID, SELF);
  assert.equal(BigInt(nst.GENERATED_AT), NOW_MS);
  assert.deepEqual(nst.NODES.map((n) => n.PEER_ID), [SELF, PEER_A, PEER_B]);
  const [self, alpha, bravo] = nst.NODES;
  assert.deepEqual([self.IS_SELF, self.IS_ONLINE, self.SOURCE, self.MULTIFORMAT_ADDRESS], [true, false, null, ["/ip4/10.0.0.1/tcp/4001"]]);
  assert.deepEqual([alpha.IS_ONLINE, alpha.SOURCE, alpha.AGENT_VERSION, alpha.MULTIFORMAT_ADDRESS], [true, "connected", "sdn-server/1.4.1", ["/ip4/10.0.0.2/tcp/4001", "/ip6/::1/tcp/4001"]]);
  assert.deepEqual([alpha.DN, alpha.ORGANIZATION, alpha.SIGNING_PUBLIC_KEY, alpha.ENCRYPTION_PUBLIC_KEY, alpha.EPM_CID], ["CN=alpha.node", "Alpha Orbital", "02aa", "03bb", null]);
  assert.deepEqual([bravo.DN, bravo.MULTIFORMAT_ADDRESS], [null, []]);
  assert.deepEqual([self.STANDARDS, alpha.STANDARDS, bravo.STANDARDS], [[], ["OMM", "WXF"], []], "STANDARDS from the host's peer_standards rows");
  assert.match(nst.ETAG, /^W\/"fnv1a64-[0-9a-f]{16}"$/);

  const [call] = h.p2p();
  assert.equal(call.op, "p2p.peers_snapshot");
  assert.deepEqual([call.params.PEER_ID ?? "", call.params.DELIVER], ["", 0], "peers_list sends no PEER_ID; DELIVER Inline");
});

test("peer_get narrows to one peer and sends PEER_ID; an unknown peer answers 404 peer-unknown with no body", async (t) => {
  const h = host({ "p2p.peers_snapshot": PEERS_ANSWER });
  const harness = await harnessFor(t, h);
  const one = outputs(await harness.invoke({ methodId: "peers_snapshot", inputs: [decisionFrame({ route: "peer_get", params: { peerId: PEER_A } })] }));
  assert.deepEqual(decode(NST, "NST", one.peers).NODES.map((n) => n.PEER_ID), [PEER_A]);
  assert.equal(h.p2p()[0].params.PEER_ID, PEER_A);

  const missing = outputs(await harness.invoke({ methodId: "peers_snapshot", inputs: [decisionFrame({ route: "peer_get", params: { peerId: "12D3KooWNobody" } })] }));
  assert.equal(missing.peers, undefined);
  const apr = decode(APR, "APR", missing.decision);
  assert.deepEqual([apr.STATUS, apr.ERROR_CODE, apr.ROUTE], [404, "peer-unknown", "peer_get"]);
  assert.match(apr.ERROR_MESSAGE, /12D3KooWNobody/);
});

test("standards_snapshot: one PNVEntry per notice, signatures and keys hex-decoded, attribution mapped", async (t) => {
  const h = host({ "p2p.standards_snapshot": { lists: { entries: PNM_ENTRIES }, raw: { records: PNM_STREAM } } });
  const harness = await harnessFor(t, h);
  const out = outputs(await harness.invoke({ methodId: "standards_snapshot", inputs: [decisionFrame({ route: "standards" })] }));
  const pnv = decode(PNV, "PNV", out.notices);
  assert.equal(pnv.VERIFIER_PEER_ID, SELF, "the verifier is node.peerId");
  assert.equal(BigInt(pnv.GENERATED_AT_MS), NOW_MS);
  const [omm, wxf] = pnv.ENTRIES;
  assert.deepEqual([omm.PUBLISHER_PEER_ID, omm.RECEIVED_FROM_PEER_ID, omm.STANDARD, omm.SCHEMA_NAME, omm.FILE_ID, omm.FILE_NAME, omm.CID, BigInt(omm.PUBLISHED_AT_MS), omm.SIGNATURE_TYPE],
    [PEER_A, PEER_A, "OMM", "OMM.fbs", "f-omm-1", "omm.fbs", "bafyomm", 1791900000000n, "ed25519"]);
  assert.deepEqual(omm.SIGNATURE, [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual(omm.PUBLISHER_KEY, [0x0a, 0x0b]);
  assert.deepEqual([omm.SIGNATURE_VERIFIED, omm.ATTRIBUTION, omm.KEY_SOURCE, omm.REASON], [true, PNV.pnvAttribution.Direct, PNV.pnvKeySource.IdentityRecord, null]);
  assert.deepEqual([wxf.SIGNATURE_VERIFIED, wxf.ATTRIBUTION, wxf.KEY_SOURCE, wxf.PUBLISHER_KEY], [false, PNV.pnvAttribution.Unattributed, PNV.pnvKeySource.None, []]);
  assert.match(wxf.REASON, /signature not verified/);
  assert.deepEqual([omm.PNM_CID, BigInt(omm.RECEIVED_AT_MS)], [null, 0n], "no host source for the notice's own CID or its receive time");
  assert.deepEqual(omm.PNM, Array.from(PNM_STREAM.subarray(0, 20)), "the received $PNM verbatim, size-prefixed (PNM_INDEX 0)");
  assert.deepEqual(wxf.PNM, Array.from(PNM_STREAM.subarray(20, 40)), "PNM_INDEX 1");
  assert.match(pnv.ETAG, /^W\/"fnv1a64-[0-9a-f]{16}"$/);

});

test("pnm_history sends PEER_ID and the clamped LIMIT; relayed publications are Relayed; no entries answers 404", async (t) => {
  const relayed = { ...PNM_ENTRIES[0], GOSSIP_PEER_ID: PEER_B };
  const h = host({ "p2p.pnm_history": (call) => (call.params.PEER_ID === PEER_A
    ? { result: { SELF, PEER_ID: PEER_A, PUBLISHER_KEY_AVAILABLE: true, GOSSIP_ONLY_EXCLUDED: 2 }, lists: { entries: [relayed] } }
    : { result: { SELF, PEER_ID: call.params.PEER_ID }, lists: { entries: [] } }) });
  const harness = await harnessFor(t, h);
  const out = outputs(await harness.invoke({ methodId: "pnm_history", inputs: [decisionFrame({ route: "pnm_history", params: { peerId: PEER_A, limit: 500 } })] }));
  const pnv = decode(PNV, "PNV", out.notices);
  assert.equal(pnv.VERIFIER_PEER_ID, SELF);
  assert.equal(pnv.ENTRIES[0].ATTRIBUTION, PNV.pnvAttribution.Relayed);
  assert.deepEqual([h.p2p()[0].params.PEER_ID, h.p2p()[0].params.LIMIT], [PEER_A, 100], "limit clamped to 100");

  await harness.invoke({ methodId: "pnm_history", inputs: [decisionFrame({ route: "pnm_history", params: { peerId: PEER_A } })] });
  assert.equal(h.p2p()[1].params.LIMIT, 1, "default limit 1 = the newest publication");

  const none = outputs(await harness.invoke({ methodId: "pnm_history", inputs: [decisionFrame({ route: "pnm_history", params: { peerId: PEER_B } })] }));
  assert.equal(none.notices, undefined);
  assert.deepEqual([decode(APR, "APR", none.decision).STATUS, decode(APR, "APR", none.decision).ERROR_CODE], [404, "no-publications"]);
});

const LATEST = { KNOWN: true, REASON: "", PINNED: true, SELF: false, FRESH: true, STANDARD: "OMM", SCHEMA: "OMM.fbs", PNM_CID: "bafypnm", PNM_FILE_ID: "f-omm-1", PNM_PUBLISH_MS: 1791900000000n,
  PNM_SIGNATURE_VERIFIED: true, PNM_ATTRIBUTION: "signature", BATCH_ID: "batch-77", PROVIDER_ID: "celestrak", SOURCE_NAME: "gp-active", RECORD_COUNT: 3n, BYTE_COUNT: 60n, PARTS: 1,
  PUBLISHED_MS: 1791900001000n, ETAG_FNV1A64: "0123456789abcdef" };

test("latest_dataset: a served batch rides its standard's port verbatim beside an AVAILABLE $DAV", async (t) => {
  const stream = recordStream("OMM", 3);
  const h = host({ "p2p.latest_dataset": { result: LATEST, raw: { stream } } });
  const harness = await harnessFor(t, h);
  const request = encodeApr({ route: "latest_dataset", params: { peerId: PEER_A, standard: "omm" } });
  const out = outputs(await harness.invoke({ methodId: "latest_dataset", inputs: [{ portId: "decision", typeRef: typeRef("APR"), payload: request }] }));
  assert.deepEqual(Object.keys(out).sort(), ["availability", "decision", "omm_records"]);
  assert.deepEqual(out.decision, request);
  assert.deepEqual(out.omm_records, stream, "the batch passes through verbatim");
  const dav = decode(DAV, "DAV", out.availability);
  assert.deepEqual([dav.STANDARD, dav.SCHEMA_NAME, dav.PROVIDER_ID, dav.SOURCE_NAME, dav.KNOWN, dav.AVAILABLE, dav.UNAVAILABLE_REASON, dav.SELF_PUBLISHED, dav.PINNED, dav.FRESH],
    ["OMM", "OMM.fbs", "celestrak", "gp-active", true, true, DAV.davUnavailableReason.None, false, true, true]);
  assert.deepEqual([dav.BATCH_ID, BigInt(dav.RECORD_COUNT), BigInt(dav.BYTE_COUNT), dav.PARTS, BigInt(dav.PUBLISHED_AT_MS), dav.PNM_CID, dav.PNM_FILE_ID, BigInt(dav.PNM_PUBLISHED_AT_MS), dav.PNM_SIGNATURE_VERIFIED, dav.PUBLISHER_PEER_ID, dav.ETAG],
    ["batch-77", 3n, 60n, 1, 1791900001000n, "bafypnm", "f-omm-1", 1791900000000n, true, PEER_A, 'W/"fnv1a64-0123456789abcdef"']);
  const [call] = h.p2p();
  assert.deepEqual([call.params.PEER_ID, call.params.STANDARD, call.params.DELIVER], [PEER_A, "omm", 1], "DELIVER Ref asked; a host that ignores it answers inline");
  assert.deepEqual([BigInt(dav.BODY_REF_TOKEN), BigInt(dav.BODY_REF_SIZE)], [0n, 0n], "inline: no reference");
});

test("latest_dataset: a host BodyRef rides DAV.BODY_REF_TOKEN / SIZE and no record frame is pushed; JSON asks Inline", async (t) => {
  const stream = recordStream("OMM", 3);
  const h = host({ "p2p.latest_dataset": (call) => (call.params.DELIVER === 1
    ? { result: { ...LATEST, REF: { TOKEN: 4242n, SIZE: 60n, FRAMES: 3n, FNV1A64: "0123456789abcdef" } } }
    : { result: LATEST, raw: { stream } }) });
  const harness = await harnessFor(t, h);
  const byRef = outputs(await harness.invoke({ methodId: "latest_dataset", inputs: [decisionFrame({ route: "latest_dataset", params: { peerId: PEER_A, standard: "omm" } })] }));
  assert.deepEqual(Object.keys(byRef).sort(), ["availability", "decision"], "no *_records frame: the batch stays with the host");
  const dav = decode(DAV, "DAV", byRef.availability);
  assert.deepEqual([BigInt(dav.BODY_REF_TOKEN), BigInt(dav.BODY_REF_SIZE), dav.AVAILABLE, dav.ETAG], [4242n, 60n, true, 'W/"fnv1a64-0123456789abcdef"']);
  assert.equal(h.p2p()[0].params.DELIVER, 1);

  const json = outputs(await harness.invoke({ methodId: "latest_dataset", inputs: [decisionFrame({ route: "latest_dataset", accept: APR.aprRepresentation.Json, params: { peerId: PEER_A, standard: "omm" } })] }));
  assert.equal(h.p2p()[1].params.DELIVER, 0, "a JSON request asks Inline: the responder renders the bytes");
  assert.deepEqual(json.omm_records, stream);
  assert.equal(BigInt(decode(DAV, "DAV", json.availability).BODY_REF_TOKEN), 0n);
});

test("the $NST / $PNV ETAG is a content tag: the same content under a different clock keeps its tag; other content changes it", async (t) => {
  let now = NOW_MS;
  const h = host({ "p2p.peers_snapshot": PEERS_ANSWER, "p2p.standards_snapshot": { lists: { entries: PNM_ENTRIES }, raw: { records: PNM_STREAM } } });
  const answer = h.answer;
  h.answer = (call) => (call.op === "clock.now" ? { result: { UNIX_MS: now } } : answer(call));
  const harness = await harnessFor(t, h);
  const nstOf = async () => decode(NST, "NST", outputs(await harness.invoke({ methodId: "peers_snapshot", inputs: [decisionFrame({ route: "peers_list" })] })).peers);
  const pnvOf = async () => decode(PNV, "PNV", outputs(await harness.invoke({ methodId: "standards_snapshot", inputs: [decisionFrame({ route: "standards" })] })).notices);
  const [n1, p1] = [await nstOf(), await pnvOf()];
  now += 60_000n;
  const [n2, p2] = [await nstOf(), await pnvOf()];
  assert.notEqual(BigInt(n1.GENERATED_AT), BigInt(n2.GENERATED_AT));
  assert.equal(n1.ETAG, n2.ETAG, "the peers' tag does not move with the clock");
  assert.equal(p1.ETAG, p2.ETAG, "the notices' tag does not move with the clock");
  const one = decode(NST, "NST", outputs(await harness.invoke({ methodId: "peers_snapshot", inputs: [decisionFrame({ route: "peer_get", params: { peerId: PEER_A } })] })).peers);
  assert.notEqual(one.ETAG, n1.ETAG, "different content, different tag");
});

test("latest_dataset: unknown lane 404 not-published, unpinned 503 dataset-unavailable, unported standard 404 not-served (each with its $DAV)", async (t) => {
  const answers = { unknown: { ...LATEST, KNOWN: false, REASON: "no-publications" }, pinned: { ...LATEST, PINNED: false, REASON: "not-pinned" }, xyz: { ...LATEST, STANDARD: "XYZ", SCHEMA: "XYZ.fbs" } };
  const h = host({ "p2p.latest_dataset": (call) => ({ result: answers[call.params.PEER_ID], raw: { stream: recordStream("OMM", 1) } }) });
  const harness = await harnessFor(t, h);
  const run = async (peerId) => outputs(await harness.invoke({ methodId: "latest_dataset", inputs: [decisionFrame({ route: "latest_dataset", params: { peerId, standard: "omm" } })] }));

  const unknown = await run("unknown");
  assert.deepEqual(Object.keys(unknown).sort(), ["availability", "decision"]);
  assert.deepEqual([decode(APR, "APR", unknown.decision).STATUS, decode(APR, "APR", unknown.decision).ERROR_CODE], [404, "not-published"]);
  assert.deepEqual([decode(DAV, "DAV", unknown.availability).KNOWN, decode(DAV, "DAV", unknown.availability).UNAVAILABLE_REASON], [false, DAV.davUnavailableReason.NotPublished]);

  const unpinned = await run("pinned");
  const apr = decode(APR, "APR", unpinned.decision), dav = decode(DAV, "DAV", unpinned.availability);
  assert.deepEqual([apr.STATUS, apr.ERROR_CODE, dav.AVAILABLE, dav.UNAVAILABLE_REASON, dav.PNM_CID], [503, "dataset-unavailable", false, DAV.davUnavailableReason.NotHeld, "bafypnm"]);
  assert.match(apr.ERROR_MESSAGE, /not-pinned/);
  assert.equal(unpinned.omm_records, undefined);

  const unported = await run("xyz");
  assert.deepEqual([decode(APR, "APR", unported.decision).STATUS, decode(APR, "APR", unported.decision).ERROR_CODE], [404, "not-served"]);
  assert.equal(Object.keys(unported).some((k) => k.endsWith("_records")), false);
});

test("a decided status or a route the method does not own passes on with no hostcall", async (t) => {
  const h = host({});
  const harness = await harnessFor(t, h);
  const decided = encodeApr({ route: "", status: 405, method: APR.aprMethod.POST });
  const out = outputs(await harness.invoke({ methodId: "peers_snapshot", inputs: [{ portId: "decision", typeRef: typeRef("APR"), payload: decided }] }));
  assert.deepEqual(out, { decision: decided }, "a decided APR passes verbatim, alone");
  for (const [methodId, route] of [["peers_snapshot", "standards"], ["standards_snapshot", "peers_list"], ["pnm_history", "latest_dataset"], ["latest_dataset", "pnm_history"]]) {
    const o = outputs(await harness.invoke({ methodId, inputs: [decisionFrame({ route })] }));
    assert.deepEqual(Object.keys(o), ["decision"]);
    const apr = decode(APR, "APR", o.decision);
    assert.deepEqual([apr.STATUS, apr.ERROR_CODE, apr.ROUTE], [404, "no-route", route], methodId);
  }
  assert.equal(h.calls.length, 0, "nothing reached the host");
});

test("a hostcall failure answers 502 host-failed; an over-bound peerId is refused 400, never truncated", async (t) => {
  const h = host({ "p2p.standards_snapshot": { error: { code: "not-authorized", message: "p2p_read not granted" } } });
  const harness = await harnessFor(t, h);
  const failed = outputs(await harness.invoke({ methodId: "standards_snapshot", inputs: [decisionFrame({ route: "standards" })] }));
  const apr = decode(APR, "APR", failed.decision);
  assert.deepEqual([apr.STATUS, apr.ERROR_CODE], [502, "host-failed"]);
  assert.match(apr.ERROR_MESSAGE, /not-authorized: p2p_read not granted/);
  assert.equal(failed.notices, undefined);

  const long = outputs(await harness.invoke({ methodId: "pnm_history", inputs: [decisionFrame({ route: "pnm_history", params: { peerId: "x".repeat(129) } })] }));
  const refused = decode(APR, "APR", long.decision);
  assert.deepEqual([refused.STATUS, refused.ERROR_CODE], [400, "invalid-parameter"]);
  assert.match(refused.ERROR_MESSAGE, /peerId is 129 bytes; .* at most 128/);
  const longStandard = outputs(await harness.invoke({ methodId: "latest_dataset", inputs: [decisionFrame({ route: "latest_dataset", params: { peerId: PEER_A, standard: "s".repeat(17) } })] }));
  assert.equal(decode(APR, "APR", longStandard.decision).STATUS, 400);
  assert.equal(h.p2p().length, 1, "only the first (failing) call reached the host");
});

test("frames that are not an $APR, a missing decision, or surplus decisions are refused", async (t) => {
  const h = host({});
  const harness = await harnessFor(t, h);
  const missing = await harness.invoke({ methodId: "peers_snapshot", inputs: [] });
  assert.match(missing.errorCode, /^missing-(decision-frame|required-input)$/, "the harness or the module refuses an absent decision");
  const garbage = await harness.invoke({ methodId: "peers_snapshot", inputs: [{ portId: "decision", typeRef: typeRef("APR"), payload: new TextEncoder().encode('{"route":"peers_list"}') }] });
  assert.equal(garbage.errorCode, "invalid-decision-frame");
  for (const methodId of ["peers_snapshot", "standards_snapshot", "pnm_history", "latest_dataset"]) {
    const twice = await harness.invoke({ methodId, inputs: [decisionFrame({ route: "peers_list" }), decisionFrame({ route: "peers_list" })] });
    assert.equal(twice.errorCode, "batched-input-frames", methodId);
    assert.match(twice.errorMessage, /2 frames on single-stream input port "decision"/);
    assert.equal(twice.outputs.length, 0);
  }
  assert.equal(h.calls.length, 0);
});

test("the source contains no port-blind plugin_get_input_frame(0) and no JSON", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/p2p_discovery_module.cpp", import.meta.url)), "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.deepEqual(code.filter((line) => line.includes("plugin_get_input_frame(0)")), []);
  // (aprRepresentation_Json is the APR's representation enum - the client's choice, read to pick the delivery mode.)
  assert.deepEqual(code.filter((line) => /json|ALIGNED_BINARY/i.test(line.replaceAll("aprRepresentation_Json", ""))), []);
});
