import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodePluginManifest } from "space-data-module-sdk";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createCelestrakSupgpPluginManifest from "../manifest.js";

function encodeEmbeddedManifest() {
  return encodePlgManifest(legacyManifestToPlg(createCelestrakSupgpPluginManifest()));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "dist", "celestrak-supgp.wasm");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(__dirname, "../../../../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json");

const REQUIRED_EXPORTS = [
  "plugin_invoke_stream",
  "plugin_alloc",
  "plugin_free",
  "plugin_get_manifest_flatbuffer",
  "plugin_get_manifest_flatbuffer_size",
];
const REQUIRED_HOST_IMPORTS = ["call", "response_len", "read_response"];

// CelesTrak SupGP endpoint each registry token resolves to (built-in table).
const BASE = "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php";
// Registry token -> {sourceName, fixture, expectRecords} (fixtures are trimmed
// real captures, 2026-07-13; see fixtures/PROVENANCE.md).
const REGISTRY = {
  "SES-E": { sourceName: "ses", fixture: "SES-E.trimmed.json", records: 4 },
  Planet: { sourceName: "planet", fixture: "Planet.trimmed.json", records: 4 },
  Iridium: { sourceName: "iridium", fixture: "Iridium.trimmed.json", records: 4 },
  Telesat: { sourceName: "telesat", fixture: "Telesat.trimmed.json", records: 4 },
  "Kuiper-E": { sourceName: "kuiper", fixture: "Kuiper-E.trimmed.json", records: 4 },
  AST: { sourceName: "ast-spacemobile", fixture: "AST.trimmed.json", records: 10 },
  "CSS-E": { sourceName: "css", fixture: "CSS-E.trimmed.json", records: 3 },
};

function loadWasm() {
  assert.ok(fs.existsSync(WASM_PATH), `built module not found at ${WASM_PATH}; run \`node build.mjs\` first`);
  return new Uint8Array(fs.readFileSync(WASM_PATH));
}

function u32le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}
function splitSizePrefixed(bytes) {
  const records = [];
  let off = 0;
  while (off < bytes.length) {
    const n = u32le(bytes, off);
    off += 4;
    records.push(Buffer.from(bytes.subarray(off, off + n)));
    off += n;
  }
  return records;
}
// CIDv1(raw, sha2-256), CIDv1 default multibase — the exact host store CID.
function cidV1RawSha256(bytes) {
  const digest = crypto.createHash("sha256").update(bytes).digest();
  const frame = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const alpha = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "", buffer = 0, bits = 0;
  for (const byte of frame) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += alpha[(buffer >>> bits) & 31]; }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += alpha[(buffer << (5 - bits)) & 31];
  return "b" + out;
}

function buildEnvelope(metaObj) {
  const meta = new TextEncoder().encode(JSON.stringify(metaObj));
  const out = new Uint8Array(4 + meta.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, meta.length, true);
  out.set(meta, 4);
  dv.setUint32(4 + meta.length, 0, true);
  return out;
}

function tokenFromUrl(url) {
  const m = url.match(/[?&]SOURCE=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Run the module with a mock host bridge. `serveHttp(url)` maps a fetch URL to a
// {status, body}; every requested URL is recorded so tests can prove tokens after
// a halt are never queried.
async function runPull(config, serveHttp) {
  const { stripWasmCustomSections } = await import("space-data-module-sdk/bundle");
  const loadable = stripWasmCustomSections(loadWasm());

  const captured = { storage: [], publishes: [], requests: [] };
  let responseBuf = new Uint8Array(0);
  let instance = null;
  const mem = () => new Uint8Array(instance.exports.memory.buffer);
  const readBytes = (ptr, len) => mem().slice(ptr, ptr + len);
  const readStr = (ptr, len) => new TextDecoder().decode(readBytes(ptr, len));
  const readReqMeta = (ptr, len) => {
    const bytes = readBytes(ptr, len);
    const metaLen = u32le(bytes, 0);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metaLen)));
  };

  const host = {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const op = readStr(opPtr, opLen);
      const req = readReqMeta(payloadPtr, payloadLen);
      let meta;
      if (op === "http.request") {
        captured.requests.push(req.url);
        const r = serveHttp(req.url);
        meta = { ok: true, result: { status: r.status, body_encoding: "utf8", body: r.body } };
      } else if (op === "storage.ingest_with_source") {
        const stream = Buffer.from(req.records, "base64");
        for (const data of splitSizePrefixed(stream)) {
          captured.storage.push({
            schema: req.schema,
            data,
            reconcile: req.reconcile,
            tags: {
              provider_id: req.provider_id,
              source_name: req.source_name,
              source_url: req.source_url,
              batch_id: req.batch_id,
              content_key_id: req.content_key_id,
            },
          });
        }
        meta = { ok: true, result: { schema: req.schema, inserted: 1, batch_id: req.batch_id } };
      } else if (op === "keyslot.sign") {
        const sig = Buffer.alloc(64, 0x2b);
        meta = { ok: true, result: { signature: sig.toString("base64"), algorithm: "ed25519" } };
      } else if (op === "pubsub.publish") {
        captured.publishes.push({ topic: req.topic, message: JSON.parse(req.data) });
        meta = { ok: true, result: {} };
      } else {
        meta = { ok: false, error: { message: "unhandled op " + op } };
      }
      responseBuf = buildEnvelope(meta);
      return 0;
    },
    response_len() { return responseBuf.length; },
    read_response(dstPtr, dstLen) {
      const n = Math.min(dstLen, responseBuf.length);
      mem().set(responseBuf.subarray(0, n), dstPtr);
      return n;
    },
    clear_response() { responseBuf = new Uint8Array(0); return 0; },
    last_status_code() { return 0; },
  };

  const wasm = await WebAssembly.instantiate(loadable, { space_data_module_host: host });
  instance = wasm.instance;
  const ex = instance.exports;

  const cfgBytes = config ? new TextEncoder().encode(JSON.stringify(config)) : new Uint8Array(0);
  let cfgPtr = 0;
  if (cfgBytes.length) {
    cfgPtr = ex.plugin_alloc(cfgBytes.length);
    mem().set(cfgBytes, cfgPtr);
  }
  const outLenPtr = ex.plugin_alloc(4);
  const resultPtr = ex.plugin_invoke_stream(cfgPtr, cfgBytes.length, outLenPtr);
  const outLen = u32le(mem(), outLenPtr);
  const summary = JSON.parse(new TextDecoder().decode(readBytes(resultPtr, outLen)));
  return { summary, ...captured };
}

// Serve every registry token's JSON fixture at its canonical FORMAT=JSON URL.
function serveRegistryJson(url) {
  const tok = tokenFromUrl(url);
  const entry = REGISTRY[tok];
  if (entry && /FORMAT=JSON/.test(url)) {
    return { status: 200, body: fs.readFileSync(path.join(FIXTURES_DIR, entry.fixture), "utf8") };
  }
  return { status: 404, body: "No SupGP data found" };
}

// ─────────────────────────── ABI / manifest ───────────────────────────

test("module builds as a valid signed SDN artifact", async () => {
  const keypair = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  await verifyModuleArtifact(loadWasm(), { trustedPublicKeys: [keypair.publicKeyHex], requireSignature: true });
});

test("module exports the canonical plugin ABI", async () => {
  const { exports } = await inspectModule(loadWasm());
  const names = exports.map((e) => (typeof e === "string" ? e : e.name));
  for (const name of REQUIRED_EXPORTS) assert.ok(names.includes(name), `missing ABI export: ${name}`);
});

test("pull imports the space_data_module_host host-call bridge", async () => {
  const { imports } = await inspectModule(loadWasm());
  const hostImports = imports.filter((i) => i.module === "space_data_module_host").map((i) => i.name);
  for (const name of REQUIRED_HOST_IMPORTS) {
    assert.ok(hostImports.includes(name), `missing host-call import: ${name} (have: ${hostImports.join(", ")})`);
  }
});

test("manifest declares the executable data-source contract + storage_ingest (not write/clock)", async () => {
  const manifest = decodePluginManifest(encodeEmbeddedManifest());
  assert.equal(manifest.pluginId, "com.orbpro.celestrak-supgp");
  assert.equal(manifest.pluginFamily, "data_source");
  const methodIds = (manifest.methods || []).map((m) => m.methodId);
  assert.ok(methodIds.includes("pull"), `missing pull method (have: ${methodIds.join(", ")})`);
  const caps = (manifest.hostCapabilities || []).map((c) => c.capability);
  for (const cap of ["http", "storage_ingest", "wallet_sign", "crypto_sign", "pubsub"]) {
    assert.ok(caps.includes(cap), `missing host capability: ${cap} (have: ${caps.join(", ")})`);
  }
  assert.ok(!caps.includes("storage_write"), "storage_write must be gone (uses storage_ingest)");
  assert.ok(!caps.includes("clock"), "storage_ingest must not decode as a CLOCK fallback");
});

test("timers: pull cadence is >= 2h (SupGP refresh; do not over-poll)", async () => {
  const manifest = decodePluginManifest(encodeEmbeddedManifest());
  const timers = manifest.timers || [];
  const pull = timers.find((t) => t.timerId === "celestrak-supgp-pull");
  assert.ok(pull, `missing celestrak-supgp-pull timer (have: ${timers.map((t) => t.timerId).join(", ")})`);
  assert.equal(pull.methodId, "pull");
  assert.ok(Number(pull.defaultIntervalMs) >= 7_200_000, `cadence ${pull.defaultIntervalMs}ms < 2h`);
});

// ─────────────────────────── multi-provider default registry ───────────────

test("pull (default registry): all 7 live providers ingested, honest per-token board", async () => {
  const { summary, storage, publishes, requests } = await runPull(null, serveRegistryJson);

  assert.equal(summary.ok, true);
  assert.equal(summary.provider, "celestrak-supgp");
  assert.equal(summary.data_source, "CelesTrak SupGP");
  assert.equal(summary.independent, false, "the whole lane is flagged non-independent");
  assert.equal(summary.halted, false);
  assert.equal(summary.tokens_attempted, 7);
  assert.equal(summary.tokens_ok, 7);

  const expectedTotal = Object.values(REGISTRY).reduce((a, e) => a + e.records, 0); // 33
  assert.equal(summary.records, expectedTotal);
  assert.equal(summary.stored, expectedTotal);
  assert.equal(summary.signed, expectedTotal);
  assert.equal(summary.published, expectedTotal);
  assert.equal(storage.length, expectedTotal);
  assert.equal(publishes.length, expectedTotal);

  // One query per token (no re-fetch within a cycle).
  assert.equal(requests.length, 7);
  assert.equal(new Set(requests).size, 7);

  // Per-token board matches expectations + distinct SourceName per provider.
  const board = Object.fromEntries(summary.per_token.map((t) => [t.token, t]));
  const seenSourceNames = new Set();
  for (const [tok, e] of Object.entries(REGISTRY)) {
    assert.ok(board[tok], `board missing ${tok}`);
    assert.equal(board[tok].status, 200);
    assert.equal(board[tok].format, "JSON");
    assert.equal(board[tok].records, e.records, `${tok} record count`);
    assert.equal(board[tok].source_name, e.sourceName);
    assert.ok(!seenSourceNames.has(e.sourceName), `SourceName ${e.sourceName} must be distinct per provider`);
    seenSourceNames.add(e.sourceName);
  }

  // Every stored record is an honestly-labeled, non-independent OMM with tags.
  for (const rec of storage) {
    assert.equal(rec.schema, "OMM");
    assert.equal(rec.reconcile, "none", "reconcile none protects NORAD=0/segment siblings");
    assert.equal(rec.tags.content_key_id, "public");
    assert.match(rec.tags.batch_id, /^[0-9a-f]{64}$/, "batch_id = source_sha256");
    assert.equal(rec.tags.provider_id, rec.tags.source_name, "provider_id reuses source_name");
    const body = JSON.parse(rec.data.toString("utf8"));
    assert.equal(body.USER_DEFINED_SDN_DATA_SOURCE, "CelesTrak SupGP");
    assert.equal(body.USER_DEFINED_SDN_INDEPENDENT, "false", "NON-INDEPENDENT flag present");
    assert.equal(body.USER_DEFINED_SDN_SOURCE_NAME, rec.tags.source_name, "synthesis fallback key == tag");
    assert.equal(body.MEAN_ELEMENT_THEORY, "SGP4");
    assert.equal(body.REFERENCE_FRAME, "TEME");
    assert.equal(body.TIME_SYSTEM, "UTC");
    // RMS/DATA_SOURCE are SupGP extras — NOT canonical OMM keys — so not bare fields.
    assert.ok(!("RMS" in body), "RMS must not be a bare OMM field (lives in USER_DEFINED)");
    assert.ok(!("DATA_SOURCE" in body), "DATA_SOURCE must not be a bare OMM field");
  }

  // Every PNM CID is the real in-guest CIDv1 byte-matching the host store, on the
  // per-provider channel.
  assert.equal(publishes.length, storage.length);
  const byTopic = {};
  for (let i = 0; i < storage.length; i++) {
    const cid = cidV1RawSha256(storage[i].data);
    assert.equal(publishes[i].message.PNM.CID, cid, "PNM.CID == host CID of stored record");
    assert.ok(cid.startsWith("bafkrei"), "CIDv1 raw block");
    byTopic[publishes[i].topic] = (byTopic[publishes[i].topic] || 0) + 1;
  }
  assert.equal(byTopic["sdn/data-source/ses"], 4);
  assert.equal(byTopic["sdn/data-source/ast-spacemobile"], 10);
  assert.equal(byTopic["sdn/data-source/css"], 3);
});

// ─────────────────────────── single-token JSON: honest labeling detail ─────

test("pull (single token SES-E JSON): schema-exact OMM + non-independent provenance", async () => {
  const { summary, storage, publishes } = await runPull(
    { token: "SES-E", sourceName: "ses" },
    serveRegistryJson,
  );
  assert.equal(summary.tokens_attempted, 1);
  assert.equal(summary.records, 4);
  assert.equal(storage.length, 4);

  // First object: NSS-11 (NORAD 26554), values copied faithfully from the feed.
  const rec = JSON.parse(storage[0].data.toString("utf8"));
  assert.equal(rec.CCSDS_OMM_VERS, 2.0);
  assert.equal(rec.OBJECT_NAME, "NSS-11");
  assert.equal(rec.OBJECT_ID, "2000-059A");
  assert.equal(rec.NORAD_CAT_ID, 26554);
  assert.equal(rec.CENTER_NAME, "EARTH");
  assert.equal(rec.CLASSIFICATION_TYPE, "C");
  assert.equal(rec.EPHEMERIS_TYPE, 0);
  assert.ok(Math.abs(rec.MEAN_MOTION - 1.00268926) < 1e-9, "MEAN_MOTION faithful");
  assert.ok(Math.abs(rec.ECCENTRICITY - 0.0002684) < 1e-12);
  assert.ok(Math.abs(rec.INCLINATION - 2.1911) < 1e-9);
  assert.ok(Math.abs(rec.MEAN_MOTION_DOT - 1.1466e-6) < 1e-12, "scientific-notation field faithful");
  // Honesty markers.
  assert.equal(rec.USER_DEFINED_SDN_SOURCE_NAME, "ses");
  assert.equal(rec.USER_DEFINED_SDN_DATA_SOURCE, "CelesTrak SupGP");
  assert.equal(rec.USER_DEFINED_SDN_INDEPENDENT, "false");
  assert.equal(rec.USER_DEFINED_SDN_CELESTRAK_DATA_SOURCE, "SES-E");
  assert.equal(rec.USER_DEFINED_SDN_CELESTRAK_RMS, "0.649", "CelesTrak fit residual preserved");
  assert.ok(Array.isArray(rec.COMMENT) && rec.COMMENT.some((c) => /NON-INDEPENDENT/.test(c)));

  // Tags + PNM.
  assert.equal(storage[0].tags.source_name, "ses");
  assert.equal(publishes[0].topic, "sdn/data-source/ses");
  const pnm = publishes[0].message.PNM;
  assert.equal(pnm.FILE_ID, "ses:OMM:26554:2026-07-13T00:00:00.000000");
  assert.equal(pnm.SIGNATURE_TYPE, "ed25519");
  assert.equal(pnm.FILE_NAME, "celestrak_supgp_SES-E.json");
  assert.equal(pnm.MULTIFORMAT_ADDRESS, "/ipfs/" + pnm.CID);

  // Provenance sidecar binds the raw fetched bytes + carries the non-independence.
  const expectedSha = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(FIXTURES_DIR, "SES-E.trimmed.json")))
    .digest("hex");
  const prov = publishes[0].message.provenance;
  assert.equal(prov.SOURCE_SHA256, expectedSha, "SOURCE_SHA256 = sha256(raw token response)");
  assert.equal(storage[0].tags.batch_id, expectedSha, "batch_id = source_sha256");
  assert.equal(prov.DATA_SOURCE, "CelesTrak SupGP");
  assert.equal(prov.INDEPENDENT, false);
  assert.equal(prov.CELESTRAK_TOKEN, "SES-E");
  assert.equal(prov.CELESTRAK_DATA_SOURCE, "SES-E");
});

// ─────────────────────────── AST: token != DATA_SOURCE != SourceName ────────

test("pull (AST): CelesTrak DATA_SOURCE 'AST-E' preserved distinctly from SourceName 'ast-spacemobile'", async () => {
  const { summary, storage } = await runPull({ token: "AST", sourceName: "ast-spacemobile" }, serveRegistryJson);
  assert.equal(summary.records, 10);
  const rec = JSON.parse(storage[0].data.toString("utf8"));
  assert.equal(rec.OBJECT_NAME, "BLUEWALKER-3");
  assert.equal(storage[0].tags.source_name, "ast-spacemobile", "SDN SourceName");
  assert.equal(rec.USER_DEFINED_SDN_CELESTRAK_DATA_SOURCE, "AST-E", "CelesTrak's own token preserved verbatim");
  assert.equal(rec.USER_DEFINED_SDN_SOURCE_NAME, "ast-spacemobile");
});

// ─────────────────────────── CSS-E segments: NORAD reuse, distinct FILE_IDs ─

test("pull (CSS-E): multi-segment single-object -> distinct FILE_IDs + CIDs, all same NORAD", async () => {
  const { summary, storage, publishes } = await runPull({ token: "CSS-E", sourceName: "css" }, serveRegistryJson);
  assert.equal(summary.records, 3);
  const norads = new Set(storage.map((r) => JSON.parse(r.data.toString("utf8")).NORAD_CAT_ID));
  assert.deepEqual([...norads], [48274], "all segments share NORAD 48274");
  const fileIds = publishes.map((p) => p.message.PNM.FILE_ID);
  assert.equal(new Set(fileIds).size, 3, "distinct per-epoch FILE_IDs");
  assert.equal(new Set(publishes.map((p) => p.message.PNM.CID)).size, 3, "distinct CIDs (distinct epochs)");
});

// ─────────────────────────── CSV fallback ───────────────────────────

test("pull (SES-E CSV fallback): CSV parses to the same schema-exact OMM records", async () => {
  const csvUrl = `${BASE}?SOURCE=SES-E&FORMAT=CSV`;
  const { summary, storage } = await runPull({ token: "SES-E", sourceName: "ses", format: "CSV" }, (url) => {
    if (url === csvUrl) return { status: 200, body: fs.readFileSync(path.join(FIXTURES_DIR, "SES-E.csv.trimmed.csv"), "utf8") };
    return { status: 404, body: "" };
  });
  assert.equal(summary.records, 4);
  assert.equal(summary.per_token[0].format, "CSV", "auto-detected CSV");
  const rec = JSON.parse(storage[0].data.toString("utf8"));
  // Same faithful values as the JSON path (CelesTrak CSV leading-dot / E-notation).
  assert.equal(rec.OBJECT_NAME, "NSS-11");
  assert.equal(rec.NORAD_CAT_ID, 26554);
  assert.ok(Math.abs(rec.MEAN_MOTION - 1.00268926) < 1e-9);
  assert.ok(Math.abs(rec.ECCENTRICITY - 0.0002684) < 1e-12, "leading-dot decimal parsed");
  assert.ok(Math.abs(rec.MEAN_MOTION_DOT - 1.1466e-6) < 1e-12, "E-notation parsed");
  assert.equal(rec.USER_DEFINED_SDN_CELESTRAK_RMS, "0.649");
  assert.equal(rec.USER_DEFINED_SDN_INDEPENDENT, "false");
});

// ─────────────────────────── halt-on-non-200 ───────────────────────────

test("pull: a non-200 halts the cycle; already-processed tokens keep records, later tokens are NOT queried", async () => {
  // Registry order: SES-E, Planet, Iridium, Telesat, Kuiper-E, AST, CSS-E.
  // Fail on Iridium (3rd). SES-E + Planet processed; Iridium halts; the rest are
  // never queried.
  const { summary, storage, requests } = await runPull(null, (url) => {
    const tok = tokenFromUrl(url);
    if (tok === "Iridium") return { status: 503, body: "" };
    return serveRegistryJson(url);
  });

  assert.equal(summary.halted, true);
  assert.equal(summary.halted_token, "Iridium");
  assert.equal(summary.halted_status, 503);
  assert.equal(summary.tokens_attempted, 3, "SES-E, Planet, Iridium attempted");
  assert.equal(summary.tokens_ok, 2, "SES-E + Planet succeeded");
  assert.equal(summary.records, 8, "4 SES-E + 4 Planet stored before halt");
  assert.equal(storage.length, 8);

  // The M2M-politeness contract: no token AFTER the failure is ever queried.
  const queriedTokens = requests.map(tokenFromUrl);
  assert.deepEqual(queriedTokens, ["SES-E", "Planet", "Iridium"]);
  for (const later of ["Telesat", "Kuiper-E", "AST", "CSS-E"]) {
    assert.ok(!queriedTokens.includes(later), `${later} must not be queried after halt`);
  }
});

// ─────────────────────────── fail-closed on empty/garbage 200 ───────────────

test("pull: a 200 with a non-OMM body ('No SupGP data found') stores nothing (fail-closed), no halt", async () => {
  const { summary, storage, publishes } = await runPull({ token: "SES-E", sourceName: "ses" }, () => ({
    status: 200,
    body: "No SupGP data found",
  }));
  assert.equal(summary.halted, false);
  assert.equal(summary.records, 0);
  assert.equal(storage.length, 0);
  assert.equal(publishes.length, 0);
});
