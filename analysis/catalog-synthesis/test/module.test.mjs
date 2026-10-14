// analysis/catalog-synthesis on the typed contracts (1.0), end to end: the built artifact in the SDK's in-process
// harness; a TimerTick in; the stored records come from the typed storage.query hostcall (a stub host answers it with
// real $OMM FlatBuffers: Space-Track GP sets tagged spacetrack-gp, built from the synthetic gp sample and reference
// rows, and our fits as analysis/od/fit-pipeline stores them, tagged with the provider's SOURCE_NAME); node config
// through plugin.getConfig; IngestRequest + size-prefixed $OMM stream + FlowNotices out.
//
// The acceptance items of A2.7 hold on the typed wire: (a) union completeness, (b) determinism across two runs,
// (c) per-NORAD precedence (hard-pass fresher fit wins; interim never wins; staler never wins; sole source kept),
// (d) quarantine of unmapped fits, (e) element-space diff vs the reference rows within A2.4 tolerances.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Builder, ByteBuffer } from "flatbuffers";
import { OMM, OMMT } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeFlowNotice, decodeHostCall, decodeIngestRequest, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const MANIFEST_PATH = here("../plugin-manifest.json");
const WASM_PATH = here("../dist/isomorphic/module.wasm");
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? here("../node_modules/spacedatastandards.org/");
const REFERENCE_ELEMENTS = here("./fixtures/reference-elements.csv");
const GP_SAMPLE = here("./fixtures/spacetrack-gp-current-sample.json");
const FIRED_MS = 1_791_259_200_000;
const TICK = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };

// A2.4 element-space tolerances (ISS-gate class) for the overlap diff.
const A24_TOL = { MEAN_MOTION: 2e-4, ECCENTRICITY: 5e-5, INCLINATION: 0.01, RA_OF_ASC_NODE: 0.02, ARG_OF_PERICENTER: 0.05, MEAN_ANOMALY: 0.05 };

// -- fixtures ------------------------------------------------------------------------------------------------------

function csvRow(norad, epochPrefix) {
  const [header, ...lines] = fs.readFileSync(REFERENCE_ELEMENTS, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const keys = header.split(",");
  const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v])))
    .filter((r) => Number.parseInt(r.NORAD_CAT_ID, 10) === norad);
  const row = epochPrefix ? rows.find((r) => r.EPOCH.startsWith(epochPrefix)) : rows[0];
  assert.ok(row, `no reference row for NORAD ${norad}`);
  const f = (k) => Number.parseFloat(row[k]) || 0;
  return {
    OBJECT_NAME: row.OBJECT_NAME, OBJECT_ID: row.OBJECT_ID, EPOCH: row.EPOCH, NORAD_CAT_ID: norad,
    MEAN_MOTION: f("MEAN_MOTION"), ECCENTRICITY: f("ECCENTRICITY"), INCLINATION: f("INCLINATION"), RA_OF_ASC_NODE: f("RA_OF_ASC_NODE"),
    ARG_OF_PERICENTER: f("ARG_OF_PERICENTER"), MEAN_ANOMALY: f("MEAN_ANOMALY"), BSTAR: f("BSTAR"), MEAN_MOTION_DOT: f("MEAN_MOTION_DOT"),
    MEAN_MOTION_DDOT: f("MEAN_MOTION_DDOT"), ELEMENT_SET_NO: Number.parseInt(row.ELEMENT_SET_NO, 10) || 999, REV_AT_EPOCH: Number.parseInt(row.REV_AT_EPOCH, 10) || 1,
  };
}
const gpRowToEl = (g) => ({
  ...Object.fromEntries(["MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT"]
    .map((k) => [k, Number.parseFloat(g[k])])),
  OBJECT_NAME: g.OBJECT_NAME, OBJECT_ID: g.OBJECT_ID, NORAD_CAT_ID: Number.parseInt(g.NORAD_CAT_ID, 10),
  ELEMENT_SET_NO: Number.parseInt(g.ELEMENT_SET_NO, 10), REV_AT_EPOCH: Number.parseInt(g.REV_AT_EPOCH, 10),
});

// One $OMM (not size-prefixed, as the store keeps it). originator "18 SPCS" for Space-Track GP, "SDN-OD" for our fits
// (analysis/od's builder).
function ommBytes({ el, epoch, originator, objectName, objectId, norad = el.NORAD_CAT_ID }) {
  const t = new OMMT();
  t.CCSDS_OMM_VERS = 3.0;
  t.ORIGINATOR = originator;
  t.OBJECT_NAME = objectName ?? el.OBJECT_NAME;
  t.OBJECT_ID = objectId ?? el.OBJECT_ID;
  t.CENTER_NAME = "EARTH";
  t.EPOCH = epoch;
  for (const k of ["MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT", "ELEMENT_SET_NO", "REV_AT_EPOCH"]) t[k] = el[k];
  t.CLASSIFICATION_TYPE = "U";
  t.NORAD_CAT_ID = norad;
  const b = new Builder(1024);
  OMM.finishOMMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}
const st = (el, epoch, extra = {}) => ommBytes({ el, epoch, originator: "18 SPCS", ...extra });
const fit = (el, epoch, extra = {}) => ommBytes({ el, epoch, originator: "SDN-OD", ...extra });
const record = (cid, sourceName, data) => ({
  CID: cid, SourceTags: { SourceName: sourceName, ProviderID: sourceName === "spacetrack-gp" ? "space-track" : sourceName }, Data: new Uint8Array(data),
});

function buildConstellation() {
  const el67850 = csvRow(67850);
  const el67851 = csvRow(67851);
  const elIss = csvRow(25544, "2026-07-13T12:00:00");
  const elGlonass = csvRow(32393);
  const gp = JSON.parse(fs.readFileSync(GP_SAMPLE, "utf8")); // Vanguard 5, 11, 12
  const records = [
    // (c1) 67850: hard-pass Starlink fit FRESHER than ST -> ours wins.
    record("cid-fit-67850", "spacex-starlink", fit(el67850, el67850.EPOCH)),
    record("cid-st-67850", "spacetrack-gp", st(el67850, "2026-05-14T01:00:00.000000")),
    // (c2) 67851: hard-pass Starlink fit STALER than ST -> ST wins.
    record("cid-fit-67851", "spacex-starlink", fit(el67851, "2026-05-14T00:50:00.000000")),
    record("cid-st-67851", "spacetrack-gp", st(el67851, el67851.EPOCH)),
    // (c3) 25544: hard-pass ISS fit fresher than ST -> ours wins.
    record("cid-fit-25544", "iss", fit(elIss, "2026-07-13T20:00:00.000000")),
    record("cid-st-25544", "spacetrack-gp", st(elIss, elIss.EPOCH, { objectName: "ISS (ZARYA)", objectId: "1998-067A" })),
    // (c4) 32393: interim GLONASS fit, SOLE source -> ours (never dropped).
    record("cid-fit-32393", "glonass", fit(elGlonass, elGlonass.EPOCH)),
    // (d) an unmapped fit (no NORAD) -> quarantined, never keyed as NORAD 0.
    record("cid-fit-unmapped", "glonass", fit({ ...elGlonass, OBJECT_NAME: "GLONASS-UNRESOLVED", OBJECT_ID: "" }, "2026-07-11T23:59:42.000029", { norad: 0 })),
    // Space-Track-only objects -> ST sole source.
    ...gp.map((g) => record(`cid-st-${g.NORAD_CAT_ID}`, "spacetrack-gp", st(gpRowToEl(g), g.EPOCH, { objectName: g.OBJECT_NAME, objectId: g.OBJECT_ID }))),
  ];
  return {
    records,
    refs: { 67850: el67850, 67851: el67851, 25544: elIss, 32393: elGlonass },
    expectedWinners: {
      67850: ["ours-fit", "ours-hardpass-fresher"],
      67851: ["spacetrack-gp", "spacetrack-ours-not-fresher"],
      25544: ["ours-fit", "ours-hardpass-fresher"],
      32393: ["ours-fit", "ours-sole-source-gate-interim"],
      5: ["spacetrack-gp", "spacetrack-sole-source"],
      11: ["spacetrack-gp", "spacetrack-sole-source"],
      12: ["spacetrack-gp", "spacetrack-sole-source"],
    },
  };
}

// -- harness -------------------------------------------------------------------------------------------------------

function createHostStub({ config = {}, records = [], fail = null } = {}) {
  const wire = [];
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (operation === "plugin.getConfig") return config;
    if (operation === "storage.query") {
      if (fail) throw new Error(fail);
      return records;
    }
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { wire, calls, dispatch };
}

const instantiate = WebAssembly.instantiate;
async function run(t, stub, inputs = [tickFrame()]) {
  WebAssembly.instantiate = async (module, imports) => {
    const host = imports?.space_data_module_host;
    if (!host) return instantiate(module, imports);
    let memory;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (op, opLen, ptr, len) => {
        stub.wire.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()));
        return host.call(op, opLen, ptr, len);
      },
    } };
    const instance = await instantiate(module, wrapped);
    memory = instance.exports.memory;
    return instance;
  };
  t.after(() => { WebAssembly.instantiate = instantiate; });
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(WASM_PATH), manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "command", hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return split(await harness.invoke({ methodId: "synthesize_catalog", inputs }));
}
const tickFrame = () => ({ portId: "tick", typeRef: TICK, payload: encodeTimerTick({ triggerId: "catalog-synthesis-pull", scheduledMs: FIRED_MS, firedMs: FIRED_MS, sequence: 1 }) });

// The size-prefixed $OMM stream -> [{ bytes, omm, params }] in stream order.
function records(stream) {
  const out = [];
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let at = 0; at < stream.length;) {
    const len = view.getUint32(at, true);
    const bytes = stream.slice(at, at + 4 + len);
    const omm = OMM.getSizePrefixedRootAsOMM(new ByteBuffer(bytes));
    const params = {};
    for (let i = 0; i < omm.userDefinedParametersLength(); i++) {
      const p = omm.USER_DEFINED_PARAMETERS(i);
      params[p.PARAM_NAME()] = p.PARAM_VALUE();
    }
    out.push({ bytes, omm, params });
    at += 4 + len;
  }
  return out;
}

function split(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const of = (port) => response.outputs.filter((o) => o.portId === port);
  const meta = of("omm_meta");
  const stream = of("omm_records");
  assert.equal(meta.length, stream.length, "omm_meta and omm_records go out together");
  assert.ok(meta.length <= 1 && stream.length <= 1);
  const catalog = stream.length ? records(stream[0].payload) : [];
  return {
    meta: meta.length ? decodeIngestRequest(meta[0].payload) : null,
    stream: stream.length ? Buffer.from(stream[0].payload) : null,
    catalog,
    byNorad: new Map(catalog.map((r) => [r.omm.NORAD_CAT_ID(), r])),
    notices: of("status").map((o) => decodeFlowNotice(o.payload)),
  };
}
const summaryOf = (out) => out.notices.find((n) => n.kind === "info" && n.sourceName === "catalog-synthesis");

// -- tests ---------------------------------------------------------------------------------------------------------

test("the shipped artifact passes SDK compliance: one concrete FlatBuffer type per port, storage_query and timers, the 6 h timer", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const result = await validateArtifactWithStandards({ manifest, wasmPath: WASM_PATH, standardsRoot: STANDARDS_ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.equal(manifest.pluginId, "com.orbpro.catalog-synthesis");
  const [method] = manifest.methods;
  const ports = [...method.inputPorts, ...method.outputPorts].map((port) => {
    const types = port.acceptedTypeSets.flatMap((s) => s.allowedTypes);
    assert.equal(types.length, 1, port.portId);
    assert.equal(types[0].wireFormat, "flatbuffer");
    assert.equal(types[0].acceptsAnyFlatbuffer, undefined);
    return [port.portId, types[0].fileIdentifier];
  });
  assert.deepEqual(ports, [["tick", "TICK"], ["omm_meta", "INGQ"], ["omm_records", "$OMM"], ["status", "FNTC"]]);
  assert.deepEqual(manifest.capabilities, ["storage_query", "timers"]);
  assert.deepEqual(manifest.timers.map((x) => [x.timerId, x.methodId, x.defaultIntervalMs]), [["catalog-synthesis-pull", "synthesize_catalog", 21_600_000]]);
  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.deepEqual([...new Set(inspection.imports.map((entry) => entry.module))].sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("(a) union completeness: every NORAD in either lane is in the catalog, ascending, NORAD 0 never", async (t) => {
  const stub = createHostStub({ records: buildConstellation().records });
  const out = await run(t, stub);
  assert.deepEqual(stub.wire.map((c) => c.op), ["plugin.getConfig", "storage.query"]);
  assert.deepEqual(stub.calls.find((c) => c.operation === "storage.query").params, { schema: "OMM", limit: 20000 });
  assert.deepEqual(out.catalog.map((r) => r.omm.NORAD_CAT_ID()), [5, 11, 12, 25544, 32393, 67850, 67851]);
  const summary = summaryOf(out);
  assert.equal(summary.count, 7);
  assert.equal(summary.atMs, FIRED_MS);
  assert.match(summary.reason, /^catalog ours-won=3 spacetrack-won=4 quarantined=1 unreadable=0 \(11 records read\)$/);
});

test("(b) determinism: two runs over identical inputs are byte-identical", async (t) => {
  const { records: input } = buildConstellation();
  const digest = async () => {
    const out = await run(t, createHostStub({ records: input }));
    return crypto.createHash("sha256").update(out.stream).update(JSON.stringify(out.meta)).update(JSON.stringify(out.notices)).digest("hex");
  };
  assert.equal(await digest(), await digest());
});

test("(c) precedence: hard-pass fresher wins; staler never wins; interim sole source kept", async (t) => {
  const out = await run(t, createHostStub({ records: buildConstellation().records }));
  for (const [norad, [kind, rule]] of Object.entries(buildConstellation().expectedWinners)) {
    const r = out.byNorad.get(Number(norad));
    assert.ok(r, `NORAD ${norad} not in the catalog`);
    assert.equal(r.params.SDN_CATALOG_SOURCE_KIND, kind, `NORAD ${norad} winner kind`);
    assert.equal(r.params.SDN_CATALOG_PRECEDENCE, rule, `NORAD ${norad} precedence`);
  }
  assert.equal(out.byNorad.get(25544).params.SDN_CATALOG_GATE_STATUS, "hard-pass");
  assert.equal(out.byNorad.get(25544).params.SDN_CATALOG_SOURCE_CID, "cid-fit-25544");
  assert.equal(out.byNorad.get(67850).params.SDN_CATALOG_SOURCE_NAME, "spacex-starlink");
  assert.equal(out.byNorad.get(32393).params.SDN_CATALOG_GATE_STATUS, "interim");
  assert.equal(out.byNorad.get(67851).params.SDN_CATALOG_GATE_STATUS, "n/a");
  assert.equal(out.byNorad.get(67851).params.SDN_CATALOG_SOURCE_CID, "cid-st-67851");
  // One Info per provider: candidates, won, quarantined.
  const per = Object.fromEntries(out.notices.filter((n) => n.kind === "info" && n.sourceName !== "catalog-synthesis").map((n) => [n.sourceName, [n.count, n.reason]]));
  assert.deepEqual(per, {
    glonass: [1, "ours-fit candidates=2 won=1 quarantined=1"],
    iss: [1, "ours-fit candidates=1 won=1 quarantined=0"],
    "spacetrack-gp": [4, "spacetrack-gp candidates=6 won=4 quarantined=0"],
    "spacex-starlink": [1, "ours-fit candidates=2 won=1 quarantined=0"],
  });
});

test("(d) quarantine: an unmapped fit is a Skipped notice, never a NORAD-0 record", async (t) => {
  const out = await run(t, createHostStub({ records: buildConstellation().records }));
  const skipped = out.notices.filter((n) => n.kind === "skipped");
  assert.deepEqual(skipped.map((n) => [n.reason, n.count, n.items]), [["no-norad-unmapped-object-id", 1, ["cid-fit-unmapped"]]]);
  assert.ok(!out.byNorad.has(0));
});

test("(e) element-space diff vs the reference rows within A2.4 tolerances on the overlap; every winner field kept", async (t) => {
  const { records: input, refs } = buildConstellation();
  const out = await run(t, createHostStub({ records: input }));
  for (const norad of [67850, 67851, 25544, 32393]) {
    const got = out.byNorad.get(norad).omm;
    for (const [key, tol] of Object.entries(A24_TOL)) {
      assert.ok(Math.abs(got[key]() - refs[norad][key]) <= tol, `NORAD ${norad} ${key}`);
    }
  }
  // The catalog record is the winning stored $OMM plus the seven SDN_CATALOG_* parameters, nothing else changed.
  for (const r of out.catalog) {
    const winner = input.find((x) => x.CID === r.params.SDN_CATALOG_SOURCE_CID);
    const stored = OMM.getRootAsOMM(new ByteBuffer(winner.Data)).unpack();
    const emitted = r.omm.unpack();
    assert.deepEqual(emitted.USER_DEFINED_PARAMETERS.map((p) => p.PARAM_NAME), [
      "SDN_CATALOG_SOURCE_KIND", "SDN_CATALOG_SOURCE_NAME", "SDN_CATALOG_SOURCE_CID", "SDN_CATALOG_PRECEDENCE",
      "SDN_CATALOG_GATE_STATUS", "SDN_CATALOG_BATCH", "SDN_CATALOG_COMMENT"]);
    emitted.USER_DEFINED_PARAMETERS = [];
    assert.deepEqual(emitted, stored);
  }
});

test("the batch: one IngestRequest for storage-ingest, batch_id = sha256 of the sorted input CIDs", async (t) => {
  const { records: input } = buildConstellation();
  const out = await run(t, createHostStub({ records: input }));
  const batchId = crypto.createHash("sha256").update(["catalog-synthesis:v1", ...input.map((r) => r.CID).sort()].join("\n")).digest("hex");
  assert.equal(out.meta.schema, "OMM.fbs");
  assert.deepEqual(
    { providerId: out.meta.tags.providerId, sourceName: out.meta.tags.sourceName, batchId: out.meta.tags.batchId, sourceUrl: out.meta.tags.sourceUrl },
    { providerId: "catalog-synthesis", sourceName: "catalog-synthesis", batchId, sourceUrl: "sdn://catalog-synthesis" });
  assert.equal(out.meta.reconcile, "none");
  assert.equal(out.meta.provenance.normalizedCount, 7);
  assert.equal(out.meta.provenance.normalizedSha256, crypto.createHash("sha256").update(out.stream).digest("hex"));
  assert.deepEqual(out.meta.provenance.schemaCounts, { "OMM.fbs": 7 });
  for (const r of out.catalog) assert.equal(r.params.SDN_CATALOG_BATCH, batchId);
  assert.ok(out.notices.every((n) => n.batchId === batchId));
});

test("classification: tag first; an untagged $OMM is a catalog input; a legacy JSON record is unreadable", async (t) => {
  const el = csvRow(67850);
  const input = [
    record("cid-tagged-fit", "spacex-starlink", fit(el, "2026-05-14T10:00:00.000000", { norad: 90001 })),
    record("cid-untagged", "", st(el, "2026-05-14T10:00:00.000000", { norad: 90002 })),
    record("cid-st-90003", "spacetrack-gp", st(el, "2026-05-14T09:00:00.000000", { norad: 90003 })),
    record("cid-json", "spacex-starlink", new TextEncoder().encode(JSON.stringify({ NORAD_CAT_ID: 90004, EPOCH: "2026-05-14T10:00:00" }))),
  ];
  const out = await run(t, createHostStub({ records: input }));
  assert.equal(out.byNorad.get(90001).params.SDN_CATALOG_SOURCE_KIND, "ours-fit");
  assert.equal(out.byNorad.get(90002).params.SDN_CATALOG_SOURCE_KIND, "spacetrack-gp");
  assert.equal(out.byNorad.get(90002).params.SDN_CATALOG_SOURCE_NAME, "spacetrack-gp");
  assert.equal(out.byNorad.get(90003).params.SDN_CATALOG_SOURCE_KIND, "spacetrack-gp");
  assert.ok(!out.byNorad.has(90004));
  assert.deepEqual(out.notices.filter((n) => n.kind === "skipped").map((n) => [n.reason, n.items]), [["unreadable", ["unknown-encoding:cid-json"]]]);
  assert.match(summaryOf(out).reason, /ours-won=1 spacetrack-won=2 quarantined=0 unreadable=1/);
});

test("node config: gateStatus demotes a provider; spacetrackSourceNames, sourceName, querySchema and queryLimit apply", async (t) => {
  const demoted = await run(t, createHostStub({ records: buildConstellation().records,
    config: { gateStatus: { providers: { "spacex-starlink": "interim", iss: "interim" } } } }));
  assert.equal(demoted.byNorad.get(67850).params.SDN_CATALOG_SOURCE_KIND, "spacetrack-gp");
  assert.equal(demoted.byNorad.get(67850).params.SDN_CATALOG_PRECEDENCE, "spacetrack-ours-gate-interim");
  assert.equal(demoted.byNorad.get(25544).params.SDN_CATALOG_SOURCE_KIND, "spacetrack-gp", "an interim fresher fit never outranks Space-Track");
  assert.match(summaryOf(demoted).reason, /ours-won=1 /);

  const el = csvRow(67850);
  const stub = createHostStub({
    config: { querySchema: "OMM.fbs", queryLimit: 5, sourceName: "sdn-catalog", spacetrackSourceNames: ["my-gp"], gateStatus: { providers: { mine: "hard-pass" } } },
    records: [record("cid-a", "my-gp", st(el, "2026-05-14T00:00:00", { norad: 7 })), record("cid-b", "mine", fit(el, "2026-05-14T01:00:00", { norad: 7 }))],
  });
  const out = await run(t, stub);
  assert.deepEqual(stub.calls.find((c) => c.operation === "storage.query").params, { schema: "OMM.fbs", limit: 5 });
  assert.equal(out.byNorad.get(7).params.SDN_CATALOG_PRECEDENCE, "ours-hardpass-fresher");
  assert.equal(out.meta.tags.sourceName, "sdn-catalog");
});

test("storage.query failure is a Missing notice and no batch; an empty store is an empty catalog", async (t) => {
  const failed = await run(t, createHostStub({ fail: "store offline" }));
  assert.equal(failed.meta, null);
  assert.deepEqual(failed.notices.map((n) => [n.kind, n.reason.startsWith("storage-query-failed: ")]), [["missing", true]]);
  const empty = await run(t, createHostStub({ records: [] }), []);
  assert.equal(empty.meta, null);
  assert.equal(summaryOf(empty).count, 0);
  assert.equal(summaryOf(empty).atMs, 0, "no tick: AT_MS 0");
});
