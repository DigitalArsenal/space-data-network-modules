/*
 * Supplemental Catalog Synthesis module test (App 2, A2.7).
 *
 * Instantiates the rebuilt PURE_WASI module with a mock `space_data_module_host`
 * bridge that serves a fixture constellation carrying BOTH real inputs, in their
 * REAL on-the-wire encodings, so the test exercises the true C++ path:
 *
 *   - our OD-fitted OMMs: raw JSON records mirroring analysis/od/fit-pipeline
 *     output (od::elements_to_json shape + COMMENT[] + USER_DEFINED_SDN_SOURCE_*
 *     lineage). UNTAGGED (SourceTags.SourceName=""), exactly as fit-pipeline
 *     writes them via storage.write today — the reader must fall back to
 *     USER_DEFINED_SDN_SOURCE_NAME.
 *   - Space-Track GP OMMs: real $OMM FlatBuffer records built with the SDS OMM
 *     binding from the trimmed live Space-Track gp JSON (NORAD 5/11/12) + the
 *     CelesTrak reference rows for the overlap objects. TAGGED
 *     SourceName="spacetrack-gp", exactly as the Go current-gp ingest lane writes
 *     them (sds.NewOMMBuilder → store.StoreWithSourceTags).
 *
 * It asserts the packet acceptance items: (a) union completeness, (b) determinism
 * across two runs, (c) per-NORAD precedence (hard-pass fresher fit wins; interim
 * fit never wins even when fresher; a staler hard-pass fit never wins),
 * (d) quarantine of unmapped fits, (e) element-space diff vs the CelesTrak GP
 * reference within A2.4 tolerances on the overlap set — plus the ABI/manifest
 * contract and schema-exact provenance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { inspectModule } from "space-data-module-sdk";
import { decodePluginManifest } from "space-data-module-sdk";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createCatalogSynthesisPluginManifest from "../manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "dist", "catalog-synthesis.wasm");
const REPO_ROOT = path.resolve(__dirname, "../../..");            // space-data-network-modules
const MAIN_PACKAGES_ROOT = path.resolve(REPO_ROOT, "..");         // repos/main-packages
const SDS_ROOT = path.join(MAIN_PACKAGES_ROOT, "spacedatastandards.org");
const KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(REPO_ROOT, "../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json");

// CelesTrak SupGP reference CSVs the OD gate suite already ships (read-only reuse).
const REF_DIR = path.join(REPO_ROOT, "analysis", "od", "tests", "data", "supgp-reference");
const GP_SAMPLE_PATH = path.join(__dirname, "fixtures", "spacetrack-gp-current-sample.json");

// SDS OMM FlatBuffer binding + flatbuffers runtime (from the sibling checkout,
// the same load pattern the conjunction-assessment parity harness uses).
const flatbuffers = await import(
  pathToFileURL(path.join(SDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js")).href
);
const { OMM, OMMT } = await import(pathToFileURL(path.join(SDS_ROOT, "lib", "js", "OMM", "main.js")).href);

// ── A2.4 element-space tolerances (ISS-gate class) for the overlap diff ───────
// Proving the synthesis PRESERVES elements within A2.4 bounds — the fit accuracy
// itself is gated by the A2.4 suite; here every winner is compared epoch-aligned
// against its CelesTrak reference row.
const A24_TOL = {
  MEAN_MOTION: 2e-4,
  ECCENTRICITY: 5e-5,
  INCLINATION: 0.01,
  RA_OF_ASC_NODE: 0.02,
  ARG_OF_PERICENTER: 0.05,
  MEAN_ANOMALY: 0.05,
};

// ── CelesTrak reference CSV reader ────────────────────────────────────────────

function readCsvRows(provider, file) {
  const text = fs.readFileSync(path.join(REF_DIR, provider, file), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}
function csvRow(provider, file, norad, epochPrefix) {
  const rows = readCsvRows(provider, file).filter((r) => Number.parseInt(r.NORAD_CAT_ID, 10) === norad);
  const row = epochPrefix ? rows.find((r) => r.EPOCH.startsWith(epochPrefix)) : rows[0];
  assert.ok(row, `no CSV row for NORAD ${norad} in ${provider}/${file}`);
  return {
    OBJECT_NAME: row.OBJECT_NAME,
    OBJECT_ID: row.OBJECT_ID,
    EPOCH: row.EPOCH,
    MEAN_MOTION: Number.parseFloat(row.MEAN_MOTION),
    ECCENTRICITY: Number.parseFloat(row.ECCENTRICITY),
    INCLINATION: Number.parseFloat(row.INCLINATION),
    RA_OF_ASC_NODE: Number.parseFloat(row.RA_OF_ASC_NODE),
    ARG_OF_PERICENTER: Number.parseFloat(row.ARG_OF_PERICENTER),
    MEAN_ANOMALY: Number.parseFloat(row.MEAN_ANOMALY),
    NORAD_CAT_ID: Number.parseInt(row.NORAD_CAT_ID, 10),
    ELEMENT_SET_NO: Number.parseInt(row.ELEMENT_SET_NO, 10) || 999,
    REV_AT_EPOCH: Number.parseInt(row.REV_AT_EPOCH, 10) || 1,
    BSTAR: Number.parseFloat(row.BSTAR) || 0,
    MEAN_MOTION_DOT: Number.parseFloat(row.MEAN_MOTION_DOT) || 0,
    MEAN_MOTION_DDOT: Number.parseFloat(row.MEAN_MOTION_DDOT) || 0,
    DATA_SOURCE: row.DATA_SOURCE,
  };
}

// ── fitted OMM (JSON, our fit-pipeline output shape) ─────────────────────────

function fittedOmmJson({ el, epoch, provider, dataSource, idStatus = "source", norad = el.NORAD_CAT_ID }) {
  const sourceCid = `cid-oem-${provider}-${norad}`;
  const sourceSha = crypto.createHash("sha256").update(`${provider}:${norad}:${epoch}`).digest("hex");
  return JSON.stringify({
    OBJECT_NAME: el.OBJECT_NAME,
    OBJECT_ID: el.OBJECT_ID,
    EPOCH: epoch,
    MEAN_MOTION: el.MEAN_MOTION,
    ECCENTRICITY: el.ECCENTRICITY,
    INCLINATION: el.INCLINATION,
    RA_OF_ASC_NODE: el.RA_OF_ASC_NODE,
    ARG_OF_PERICENTER: el.ARG_OF_PERICENTER,
    MEAN_ANOMALY: el.MEAN_ANOMALY,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U",
    NORAD_CAT_ID: norad,
    ELEMENT_SET_NO: el.ELEMENT_SET_NO,
    REV_AT_EPOCH: el.REV_AT_EPOCH,
    BSTAR: el.BSTAR,
    MEAN_MOTION_DOT: el.MEAN_MOTION_DOT,
    MEAN_MOTION_DDOT: el.MEAN_MOTION_DDOT,
    RMS: "0.150",
    ITERATIONS: 7,
    MAX_ITERATIONS: 50,
    CONVERGED: true,
    DATA_SOURCE: dataSource,
    COMMENT: [
      "SDN OD-fitted supplemental GP (SupGP/OMM) — App 2 A2.3 pipeline.",
      "Fitted from stored SDS OEM record via od::fit_sgp4_series.",
      `SOURCE_NAME=${provider} DATA_SOURCE=${dataSource}`,
    ],
    USER_DEFINED_SDN_SOURCE_CID: sourceCid,
    USER_DEFINED_SDN_SOURCE_SHA256: sourceSha,
    USER_DEFINED_SDN_SOURCE_NAME: provider,
    USER_DEFINED_SDN_ID_STATUS: idStatus,
  });
}

// ── Space-Track GP OMM ($OMM FlatBuffer, Go current-gp lane output shape) ─────

function spacetrackOmmFlatbuffer({ el, epoch, objectName, objectId, norad = el.NORAD_CAT_ID }) {
  const t = new OMMT();
  t.CCSDS_OMM_VERS = 3.0;
  t.COMMENT = "GENERATED VIA SPACE-TRACK.ORG API";
  t.ORIGINATOR = "18 SPCS";
  t.OBJECT_NAME = objectName ?? el.OBJECT_NAME;
  t.OBJECT_ID = objectId ?? el.OBJECT_ID;
  t.CENTER_NAME = "EARTH";
  t.EPOCH = epoch;
  t.MEAN_MOTION = el.MEAN_MOTION;
  t.ECCENTRICITY = el.ECCENTRICITY;
  t.INCLINATION = el.INCLINATION;
  t.RA_OF_ASC_NODE = el.RA_OF_ASC_NODE;
  t.ARG_OF_PERICENTER = el.ARG_OF_PERICENTER;
  t.MEAN_ANOMALY = el.MEAN_ANOMALY;
  t.CLASSIFICATION_TYPE = "U";
  t.NORAD_CAT_ID = norad;
  t.ELEMENT_SET_NO = el.ELEMENT_SET_NO;
  t.REV_AT_EPOCH = el.REV_AT_EPOCH;
  t.BSTAR = el.BSTAR;
  t.MEAN_MOTION_DOT = el.MEAN_MOTION_DOT;
  t.MEAN_MOTION_DDOT = el.MEAN_MOTION_DDOT;
  const b = new flatbuffers.Builder(1024);
  OMM.finishOMMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}

// gp JSON row (all-string values) -> element object for the FlatBuffer builder.
function gpRowToEl(gp) {
  return {
    OBJECT_NAME: gp.OBJECT_NAME,
    OBJECT_ID: gp.OBJECT_ID,
    MEAN_MOTION: Number.parseFloat(gp.MEAN_MOTION),
    ECCENTRICITY: Number.parseFloat(gp.ECCENTRICITY),
    INCLINATION: Number.parseFloat(gp.INCLINATION),
    RA_OF_ASC_NODE: Number.parseFloat(gp.RA_OF_ASC_NODE),
    ARG_OF_PERICENTER: Number.parseFloat(gp.ARG_OF_PERICENTER),
    MEAN_ANOMALY: Number.parseFloat(gp.MEAN_ANOMALY),
    NORAD_CAT_ID: Number.parseInt(gp.NORAD_CAT_ID, 10),
    ELEMENT_SET_NO: Number.parseInt(gp.ELEMENT_SET_NO, 10),
    REV_AT_EPOCH: Number.parseInt(gp.REV_AT_EPOCH, 10),
    BSTAR: Number.parseFloat(gp.BSTAR),
    MEAN_MOTION_DOT: Number.parseFloat(gp.MEAN_MOTION_DOT),
    MEAN_MOTION_DDOT: Number.parseFloat(gp.MEAN_MOTION_DDOT),
  };
}

// ── storage.query record shapes (mirror internal/storage Record JSON) ────────

function jsonRecord(cid, sourceName, jsonStr) {
  return record(cid, sourceName, Buffer.from(jsonStr, "utf8"));
}
function fbRecord(cid, sourceName, bytes) {
  return record(cid, sourceName, Buffer.from(bytes));
}
function record(cid, sourceName, dataBuf) {
  return {
    CID: cid,
    RowID: 1,
    PeerID: "",
    Timestamp: "2026-07-13T00:00:00Z",
    Data: dataBuf.toString("base64"),
    Signature: null,
    SourceTags: {
      ProviderID: sourceName ? (sourceName === "spacetrack-gp" ? "space-track" : sourceName) : "",
      SourceName: sourceName || "",
      SourceURL: "",
      BatchID: "",
      ContentKeyID: "",
    },
    StreamPath: "",
    StreamOffset: 0,
    RecordLength: dataBuf.length,
  };
}

// ── fixture constellation ─────────────────────────────────────────────────────
// Reference rows (CelesTrak SupGP) drive both inputs so the overlap diff is
// epoch-aligned. Winner epoch == CelesTrak reference epoch; loser epoch is set to
// drive each precedence case.

function buildConstellation() {
  const sxCsv = "celestrak_supgp_2026-034.csv";
  const el67850 = csvRow("starlink", sxCsv, 67850);   // epoch 2026-05-14T05:07:42.000038
  const el67851 = csvRow("starlink", sxCsv, 67851);   // epoch 2026-05-14T06:51:42.000019
  const elIss = csvRow("iss", "celestrak_supgp_iss-e_2026-07-13.csv", 25544, "2026-07-13T12:00:00");
  const elGlonass = csvRow("glonass", "celestrak_supgp_glonass-re_2026-07-13.csv", 32393); // 2026-07-11T23:59:42.000029

  const gp = JSON.parse(fs.readFileSync(GP_SAMPLE_PATH, "utf8")); // Vanguard 5,11,12

  const records = [];

  // (c1) 67850 — hard-pass Starlink fit is FRESHER than ST -> ours wins.
  records.push(jsonRecord("cid-fit-67850", "", fittedOmmJson({ el: el67850, epoch: el67850.EPOCH, provider: "spacex-starlink", dataSource: "SpaceX-E" })));
  records.push(fbRecord("cid-st-67850", "spacetrack-gp", spacetrackOmmFlatbuffer({ el: el67850, epoch: "2026-05-14T01:00:00.000000" })));

  // (c2) 67851 — hard-pass Starlink fit is STALER than ST -> ST wins.
  records.push(jsonRecord("cid-fit-67851", "", fittedOmmJson({ el: el67851, epoch: "2026-05-14T02:00:00.000000", provider: "spacex-starlink", dataSource: "SpaceX-E" })));
  records.push(fbRecord("cid-st-67851", "spacetrack-gp", spacetrackOmmFlatbuffer({ el: el67851, epoch: el67851.EPOCH })));

  // (c3) 25544 — A2.4d: ISS is now hard-pass (same-ephemeris RMS beat), and its
  // fit is FRESHER than ST -> ours wins (was: interim ISS loses despite fresher).
  records.push(jsonRecord("cid-fit-25544", "", fittedOmmJson({ el: elIss, epoch: "2026-07-13T20:00:00.000000", provider: "iss", dataSource: "ISS-E" })));
  records.push(fbRecord("cid-st-25544", "spacetrack-gp", spacetrackOmmFlatbuffer({ el: elIss, epoch: elIss.EPOCH, objectName: "ISS (ZARYA)", objectId: "1998-067A" })));

  // (c4) 32393 — interim GLONASS fit, SOLE source (no ST) -> ours wins (never dropped).
  records.push(jsonRecord("cid-fit-32393", "", fittedOmmJson({ el: elGlonass, epoch: elGlonass.EPOCH, provider: "glonass", dataSource: "GLONASS-RE" })));

  // (d) unmapped fit (no NORAD) -> quarantine, never keyed as NORAD 0.
  records.push(jsonRecord("cid-fit-unmapped", "", fittedOmmJson({
    el: { ...elGlonass, OBJECT_NAME: "GLONASS-UNRESOLVED", OBJECT_ID: "" },
    epoch: "2026-07-11T23:59:42.000029", provider: "glonass", dataSource: "GLONASS-RE",
    idStatus: "unmapped-object-id", norad: 0,
  })));

  // Space-Track-only catalog objects (Vanguard 5/11/12) -> ST sole source.
  for (const g of gp) {
    records.push(fbRecord(`cid-st-${g.NORAD_CAT_ID}`, "spacetrack-gp", spacetrackOmmFlatbuffer({
      el: gpRowToEl(g), epoch: g.EPOCH, objectName: g.OBJECT_NAME, objectId: g.OBJECT_ID,
    })));
  }

  return {
    records,
    refs: { 67850: el67850, 67851: el67851, 25544: elIss, 32393: elGlonass },
    expectedWinners: {
      67850: { kind: "ours-fit", ruleIncludes: "ours-hardpass-fresher" },
      67851: { kind: "spacetrack-gp", ruleIncludes: "spacetrack-ours-not-fresher" },
      25544: { kind: "ours-fit", ruleIncludes: "ours-hardpass-fresher" },
      32393: { kind: "ours-fit", ruleIncludes: "ours-sole-source" },
      5: { kind: "spacetrack-gp", ruleIncludes: "spacetrack-sole-source" },
      11: { kind: "spacetrack-gp", ruleIncludes: "spacetrack-sole-source" },
      12: { kind: "spacetrack-gp", ruleIncludes: "spacetrack-sole-source" },
    },
  };
}

// ── mock host bridge ──────────────────────────────────────────────────────────

function u32le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
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
function loadWasm() {
  assert.ok(fs.existsSync(WASM_PATH), `built module not found at ${WASM_PATH}; run \`node build.mjs\` first`);
  return new Uint8Array(fs.readFileSync(WASM_PATH));
}

async function runSynthesis(config, fixtureRecords) {
  const { stripWasmCustomSections } = await import("space-data-module-sdk/bundle");
  const loadable = stripWasmCustomSections(loadWasm());

  const captured = { ingests: [], publishes: [], queries: 0 };
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
      if (op === "plugin.getConfig") {
        meta = { ok: false, error: { message: "no module config" } };
      } else if (op === "storage.query") {
        captured.queries++;
        assert.equal(req.schema, "OMM", "synthesis queries the OMM schema");
        meta = { ok: true, result: fixtureRecords };
      } else if (op === "storage.ingest_with_source") {
        // records = base64 of [u32le len][record bytes] (single-record stream)
        const stream = Buffer.from(req.records, "base64");
        const len = u32le(stream, 0);
        const data = stream.subarray(4, 4 + len);
        captured.ingests.push({
          schema: req.schema,
          source_name: req.source_name,
          provider_id: req.provider_id,
          batch_id: req.batch_id,
          reconcile: req.reconcile,
          content_key_id: req.content_key_id,
          data: Buffer.from(data),
        });
        meta = { ok: true, inserted: 1 };
      } else if (op === "keyslot.sign") {
        meta = { ok: true, result: { signature: Buffer.alloc(64, 0x2b).toString("base64"), algorithm: "ed25519" } };
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

  const wasi = {
    fd_close: () => 0,
    fd_seek: () => 0,
    fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
      const dv = new DataView(instance.exports.memory.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) total += dv.getUint32(iovsPtr + i * 8 + 4, true);
      dv.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    environ_sizes_get: (countPtr, sizePtr) => {
      const dv = new DataView(instance.exports.memory.buffer);
      dv.setUint32(countPtr, 0, true);
      dv.setUint32(sizePtr, 0, true);
      return 0;
    },
    environ_get: () => 0,
  };

  const wasm = await WebAssembly.instantiate(loadable, { space_data_module_host: host, wasi_snapshot_preview1: wasi });
  instance = wasm.instance;
  const ex = instance.exports;

  const cfgBytes = config ? new TextEncoder().encode(JSON.stringify(config)) : new Uint8Array(0);
  let cfgPtr = 0;
  if (cfgBytes.length) { cfgPtr = ex.plugin_alloc(cfgBytes.length); mem().set(cfgBytes, cfgPtr); }
  const outLenPtr = ex.plugin_alloc(4);
  const resultPtr = ex.plugin_invoke_stream(cfgPtr, cfgBytes.length, outLenPtr);
  const outLen = u32le(mem(), outLenPtr);
  const summary = JSON.parse(new TextDecoder().decode(readBytes(resultPtr, outLen)));
  return { summary, ...captured };
}

// Every ingested catalog OMM, keyed by NORAD_CAT_ID (bare number in the record).
function catalogByNorad(ingests) {
  const map = new Map();
  for (const w of ingests) {
    assert.equal(w.schema, "OMM", "catalog records are stored under the OMM schema");
    const omm = JSON.parse(w.data.toString("utf8"));
    map.set(omm.NORAD_CAT_ID, { omm, ingest: w });
  }
  return map;
}

// ── ABI + manifest contract ───────────────────────────────────────────────────

const REQUIRED_EXPORTS = [
  "plugin_invoke_stream",
  "plugin_alloc",
  "plugin_free",
  "plugin_get_manifest_flatbuffer",
  "plugin_get_manifest_flatbuffer_size",
];

test("module builds as a valid signed SDN artifact", async () => {
  const keypair = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  await verifyModuleArtifact(loadWasm(), { trustedPublicKeys: [keypair.publicKeyHex], requireSignature: true });
});

test("module exports the canonical plugin ABI", async () => {
  const { exports } = await inspectModule(loadWasm());
  const names = exports.map((e) => (typeof e === "string" ? e : e.name));
  for (const name of REQUIRED_EXPORTS) assert.ok(names.includes(name), `missing ABI export: ${name}`);
});

test("manifest declares storage_query/storage_ingest/wallet_sign/pubsub + 6h timer + synthesize_catalog", async () => {
  const manifest = decodePluginManifest(encodePlgManifest(legacyManifestToPlg(createCatalogSynthesisPluginManifest())));
  assert.equal(manifest.pluginId, "com.orbpro.catalog-synthesis");

  const methodIds = (manifest.methods || []).map((m) => m.methodId);
  assert.ok(methodIds.includes("synthesize_catalog"), `missing synthesize_catalog (have: ${methodIds.join(", ")})`);

  const caps = (manifest.hostCapabilities || []).map((c) => c.capability);
  for (const cap of ["storage_query", "storage_ingest", "wallet_sign", "pubsub"]) {
    assert.ok(caps.includes(cap), `missing host capability: ${cap} (have: ${caps.join(", ")})`);
  }

  const timers = manifest.timers || [];
  const t = timers.find((x) => x.timerId === "catalog-synthesis-pull");
  assert.ok(t, `missing catalog-synthesis-pull timer (have: ${timers.map((x) => x.timerId).join(", ")})`);
  assert.equal(t.methodId, "synthesize_catalog");
});

// ── end-to-end acceptance ─────────────────────────────────────────────────────

test("(a) union completeness: every NORAD in either input is in the catalog", async () => {
  const { records } = buildConstellation();
  const { summary, ingests } = await runSynthesis(null, records);
  assert.equal(summary.ok, true);
  assert.equal(summary.query_ok, true);

  const catalog = catalogByNorad(ingests);
  // union of NORADs across both inputs, excluding the unmapped (NORAD 0) fit.
  const expected = new Set([67850, 67851, 25544, 32393, 5, 11, 12]);
  assert.equal(catalog.size, expected.size, `catalog size ${catalog.size} != ${expected.size}`);
  for (const n of expected) assert.ok(catalog.has(n), `NORAD ${n} missing from the catalog`);
  assert.ok(!catalog.has(0), "NORAD 0 must never be a catalog key");
  assert.equal(summary.catalog_records, expected.size);
  assert.equal(summary.published, expected.size, "one PNM per catalog record");
  assert.equal(summary.stored, expected.size);
  assert.equal(summary.signed, expected.size);
});

test("(b) determinism: two runs over identical inputs produce byte-identical output", async () => {
  const { records } = buildConstellation();
  const hashRun = async () => {
    const { summary, ingests, publishes } = await runSynthesis(null, records);
    const canon = JSON.stringify({
      summary,
      stored: ingests.map((w) => ({ s: w.source_name, b: w.batch_id, d: w.data.toString("base64") })),
      publishes,
    });
    return crypto.createHash("sha256").update(canon).digest("hex");
  };
  const h1 = await hashRun();
  const h2 = await hashRun();
  assert.equal(h1, h2, "two synthesis runs are not byte-identical");
});

test("(c) precedence: hard-pass-fresher wins; interim never wins; staler never wins; sole source kept", async () => {
  const { records, expectedWinners } = buildConstellation();
  const { summary, ingests } = await runSynthesis(null, records);
  const catalog = catalogByNorad(ingests);

  for (const [norad, want] of Object.entries(expectedWinners)) {
    const entry = catalog.get(Number(norad));
    assert.ok(entry, `NORAD ${norad} not in catalog`);
    assert.equal(entry.omm.USER_DEFINED_SDN_CATALOG_SOURCE_KIND, want.kind, `NORAD ${norad} winner kind`);
    assert.ok(
      entry.omm.USER_DEFINED_SDN_CATALOG_PRECEDENCE.includes(want.ruleIncludes),
      `NORAD ${norad} precedence "${entry.omm.USER_DEFINED_SDN_CATALOG_PRECEDENCE}" !~ "${want.ruleIncludes}"`,
    );
  }
  // A2.4d: the ISS fit is now hard-pass AND fresher than ST, so it WINS — the
  // load-bearing flip (was: interim ISS lost despite being fresher). The
  // "interim-fresher-still-loses" rule stays covered by the config-override test
  // below, which demotes starlink to interim and watches its fresher fit lose.
  assert.equal(catalog.get(25544).omm.USER_DEFINED_SDN_CATALOG_SOURCE_KIND, "ours-fit");
  assert.equal(catalog.get(25544).omm.USER_DEFINED_SDN_CATALOG_GATE_STATUS, "hard-pass");
  // Starlink hard-pass fresher fit won.
  assert.equal(catalog.get(67850).omm.USER_DEFINED_SDN_CATALOG_SOURCE_KIND, "ours-fit");
  assert.equal(catalog.get(67850).omm.USER_DEFINED_SDN_CATALOG_GATE_STATUS, "hard-pass");

  assert.equal(summary.ours_won, 3, "67850 + 32393 + 25544 (ISS now hard-pass, fresher)");
  assert.equal(summary.spacetrack_won, 4, "67851 + 5 + 11 + 12");
});

test("(d) quarantine: an unmapped fit is quarantined, never keyed as NORAD 0", async () => {
  const { records } = buildConstellation();
  const { summary, ingests } = await runSynthesis(null, records);
  assert.equal(summary.quarantined, 1);
  assert.equal(summary.quarantine.length, 1);
  const q = summary.quarantine[0];
  assert.equal(q.cid, "cid-fit-unmapped");
  assert.equal(q.id_status, "unmapped-object-id");
  assert.equal(q.provider, "glonass");
  // Not stored/published as a catalog record.
  const catalog = catalogByNorad(ingests);
  assert.ok(!catalog.has(0));
  for (const w of ingests) {
    const omm = JSON.parse(w.data.toString("utf8"));
    assert.notEqual(omm.NORAD_CAT_ID, 0, "no NORAD-0 record ever stored");
  }
});

test("(e) element-space diff vs CelesTrak reference within A2.4 tolerances on the overlap", async () => {
  const { records, refs } = buildConstellation();
  const { ingests } = await runSynthesis(null, records);
  const catalog = catalogByNorad(ingests);

  for (const norad of [67850, 67851, 25544, 32393]) {
    const ref = refs[norad];
    const got = catalog.get(norad).omm;
    for (const key of Object.keys(A24_TOL)) {
      const d = Math.abs(Number(got[key]) - ref[key]);
      assert.ok(
        d <= A24_TOL[key],
        `NORAD ${norad} ${key}: |${got[key]} - ${ref[key]}| = ${d} > ${A24_TOL[key]}`,
      );
    }
  }
});

test("provenance + schema-exact keys + SourceTags on every catalog record", async () => {
  const { records } = buildConstellation();
  const { ingests, publishes } = await runSynthesis(null, records);

  // one batch_id for the whole run; SourceName tagged as the synthesis provider.
  const batchIds = new Set(ingests.map((w) => w.batch_id));
  assert.equal(batchIds.size, 1, "all catalog records share one deterministic batch_id");
  const batchId = [...batchIds][0];
  assert.ok(/^[0-9a-f]{64}$/.test(batchId), "batch_id is a sha256 hex of the input set");

  for (const w of ingests) {
    assert.equal(w.source_name, "catalog-synthesis");
    assert.equal(w.provider_id, "catalog-synthesis");
    assert.equal(w.reconcile, "none", "reconcile pinned to none (no sibling deletion)");
    const omm = JSON.parse(w.data.toString("utf8"));
    for (const k of ["NORAD_CAT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY"]) {
      assert.ok(k in omm, `catalog OMM missing schema key ${k}`);
    }
    // synthesis provenance (winning source + precedence + batch) on every record.
    assert.ok(["ours-fit", "spacetrack-gp"].includes(omm.USER_DEFINED_SDN_CATALOG_SOURCE_KIND));
    assert.ok(omm.USER_DEFINED_SDN_CATALOG_SOURCE_NAME.length > 0);
    assert.ok(omm.USER_DEFINED_SDN_CATALOG_SOURCE_CID.length > 0);
    assert.ok(omm.USER_DEFINED_SDN_CATALOG_PRECEDENCE.length > 0);
    assert.equal(omm.USER_DEFINED_SDN_CATALOG_BATCH, batchId);
  }

  // PNM per catalog record + one summary message on the synthesis topic.
  const pnmPublishes = publishes.filter((p) => p.message.PNM);
  const summaryPublishes = publishes.filter((p) => p.message.CATALOG_SYNTHESIS_SUMMARY);
  assert.equal(pnmPublishes.length, ingests.length, "one PNM publish per stored catalog record");
  assert.equal(summaryPublishes.length, 1, "exactly one synthesis summary published");
  for (const p of pnmPublishes) {
    assert.equal(p.topic, "sdn/data-source/catalog-synthesis");
    for (const k of ["MULTIFORMAT_ADDRESS", "PUBLISH_TIMESTAMP", "CID", "FILE_NAME", "FILE_ID", "SIGNATURE", "SIGNATURE_TYPE"]) {
      assert.ok(k in p.message.PNM, `PNM missing ${k}`);
    }
    assert.equal(p.message.PNM.SIGNATURE_TYPE, "ed25519");
    assert.ok(p.message.PNM.FILE_ID.includes(":OMM:"), `FILE_ID not an OMM partition: ${p.message.PNM.FILE_ID}`);
    assert.equal(p.message.provenance.RECORD_SCHEMA, "OMM");
    assert.equal(p.message.provenance.CATALOG, "celestrak-replacement");
  }
});

test("classification: tag-first with USER_DEFINED fallback (both discriminate our fit from ST)", async () => {
  // A TAGGED our-fit record (post fit-pipeline ingest_with_source migration) and
  // an UNTAGGED our-fit record (today) must both be attributed to our fit, and a
  // tagged ST record to Space-Track — proving the reader's dual discrimination.
  const el = csvRow("starlink", "celestrak_supgp_2026-034.csv", 67850);
  const taggedFit = jsonRecord("cid-tagged-fit", "spacex-starlink",
    fittedOmmJson({ el, epoch: "2026-05-14T10:00:00.000000", provider: "spacex-starlink", dataSource: "SpaceX-E", norad: 90001 }));
  const untaggedFit = jsonRecord("cid-untagged-fit", "",
    fittedOmmJson({ el, epoch: "2026-05-14T10:00:00.000000", provider: "spacex-starlink", dataSource: "SpaceX-E", norad: 90002 }));
  const st = fbRecord("cid-st-90003", "spacetrack-gp", spacetrackOmmFlatbuffer({ el, epoch: "2026-05-14T09:00:00.000000", norad: 90003 }));

  const { summary, ingests } = await runSynthesis(null, [taggedFit, untaggedFit, st]);
  const catalog = catalogByNorad(ingests);
  assert.equal(catalog.get(90001).omm.USER_DEFINED_SDN_CATALOG_SOURCE_KIND, "ours-fit", "tagged our fit");
  assert.equal(catalog.get(90002).omm.USER_DEFINED_SDN_CATALOG_SOURCE_KIND, "ours-fit", "untagged our fit (USER_DEFINED fallback)");
  assert.equal(catalog.get(90003).omm.USER_DEFINED_SDN_CATALOG_SOURCE_KIND, "spacetrack-gp", "tagged ST");
  assert.equal(summary.ours_won, 2);
  assert.equal(summary.spacetrack_won, 1);
});

test("config override: gateStatus can promote/demote a provider at runtime", async () => {
  // Demote spacex-starlink AND iss to interim via a runtime override: the 67850
  // and (A2.4d) 25544 fits that won under the compiled hard-pass defaults now
  // both lose to Space-Track GP. Demoting an interim provider proves the
  // "interim fit never outranks Space-Track even when fresher" invariant — the
  // coverage previously carried by the un-flipped ISS case.
  const { records } = buildConstellation();
  const cfg = { gateStatus: { providers: { "spacex-starlink": "interim", "iss": "interim" } } };
  const { summary, ingests } = await runSynthesis(cfg, records);
  const catalog = catalogByNorad(ingests);
  assert.equal(catalog.get(67850).omm.USER_DEFINED_SDN_CATALOG_SOURCE_KIND, "spacetrack-gp",
    "starlink demoted to interim -> its fit no longer outranks Space-Track");
  assert.equal(catalog.get(25544).omm.USER_DEFINED_SDN_CATALOG_SOURCE_KIND, "spacetrack-gp",
    "iss demoted to interim -> its fresher fit no longer outranks Space-Track");
  assert.equal(summary.ours_won, 1, "only the sole-source GLONASS fit remains ours");
});
