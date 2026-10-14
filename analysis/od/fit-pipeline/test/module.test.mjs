// analysis/od/fit-pipeline on the typed contracts (1.0), end to end through the SDK's in-process harness: a TimerTick
// in; the stored records come from the typed storage.query hostcall (the harness's stub host answers it with real
// $OEM records - the bytes data-source/spacex-starlink-source and data-source/oem-source-iss emit); $OMM / $OBD /
// FlowNotice out. Each fit is checked against analysis/od's own `fit` artifact on the same $OEM and settings.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ByteBuffer, Builder } from "flatbuffers";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OBD } from "spacedatastandards.org/lib/js/OBD/OBD.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeFlowNotice, decodeHostCall, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const MANIFEST_PATH = here("../plugin-manifest.json");
const WASM_PATH = here("../dist/isomorphic/module.wasm");
const OD_WASM_PATH = here("../../dist/isomorphic/module.wasm");
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? here("../../node_modules/spacedatastandards.org/");

// Real $OEM records: SpaceX Starlink (12 states each, captured MEME via data-source/spacex-starlink-source) and the
// NASA ISS ephemeris (data-source/oem-source-iss, verbose and compact).
const STARLINK = [0, 1].map((i) => fs.readFileSync(here(`../../../../data-source/spacex-starlink-source/tests/fixtures/legacy-oem/fixtures/oem-${i}.bin`)));
const ISS_VERBOSE = fs.readFileSync(here("../../../../data-source/oem-source-iss/tests/fixtures/legacy-oem-verbose.bin"));
const ISS_COMPACT = fs.readFileSync(here("../../../../data-source/oem-source-iss/tests/fixtures/legacy-oem-compact.bin"));

const FIRED_MS = 1_791_259_200_000;
const TICK = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };
const OEM_TYPE = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat: "flatbuffer" };

// A changed copy of an $OEM record (object API: unpack, edit the first block, pack).
function variant(bytes, edit) {
  const oem = OEM.getRootAsOEM(new ByteBuffer(new Uint8Array(bytes))).unpack();
  edit(oem.EPHEMERIS_DATA_BLOCK[0]);
  const builder = new Builder(bytes.length + 1024);
  builder.finish(oem.pack(builder), "$OEM");
  return builder.asUint8Array();
}
const record = (cid, sourceName, data, providerId = "") => ({ CID: cid, SourceTags: { SourceName: sourceName, ProviderID: providerId }, Data: new Uint8Array(data) });

// Host stub: plugin.getConfig answers `config`; storage.query answers `records` (the store's Record shape, which the
// SDK adapter turns into list "records_meta" + raw "records"). Every $PIV request the module sends is decoded into
// `wire`.
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
  return harness.invoke({ methodId: "fit_pipeline", inputs });
}
const tickFrame = () => ({ portId: "tick", typeRef: TICK, payload: encodeTimerTick({ triggerId: "od-fit-pull", scheduledMs: FIRED_MS, firedMs: FIRED_MS, sequence: 1 }) });

function split(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const of = (port) => response.outputs.filter((o) => o.portId === port);
  return {
    omm: of("omm").map((o) => o.payload),
    obd: of("obd").map((o) => o.payload),
    notices: of("status").map((o) => decodeFlowNotice(o.payload)),
  };
}
const omm = (bytes) => OMM.getSizePrefixedRootAsOMM(new ByteBuffer(bytes));
const obd = (bytes) => OBD.getSizePrefixedRootAsOBD(new ByteBuffer(bytes));

// analysis/od's `fit` on the same $OEM, with the provider's settings as its node config.
async function odFit(t, bytes, config) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(OD_WASM_PATH), surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({ methodId: "fit", inputs: [{ portId: "oem", typeRef: OEM_TYPE, payload: new Uint8Array(bytes) }] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return { omm: response.outputs.find((o) => o.portId === "omm").payload, obd: response.outputs.find((o) => o.portId === "obd").payload };
}

test("the shipped artifact passes SDK compliance: typed ports, browser and wasmedge, storage_query and timers, the 2 h timer", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const result = await validateArtifactWithStandards({ manifest, wasmPath: WASM_PATH, standardsRoot: STANDARDS_ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  const [method] = manifest.methods;
  const ports = [...method.inputPorts, ...method.outputPorts].map((port) => {
    assert.equal(port.acceptedTypeSets.length, 1, port.portId);
    for (const type of port.acceptedTypeSets[0].allowedTypes) assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
    return [port.portId, [...new Set(port.acceptedTypeSets[0].allowedTypes.map((type) => type.fileIdentifier))]];
  });
  assert.deepEqual(ports, [["tick", ["TICK"]], ["omm", ["$OMM"]], ["obd", ["$OBD"]], ["status", ["FNTC"]]]);
  assert.deepEqual(manifest.capabilities, ["storage_query", "timers"]);
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.deepEqual(manifest.timers, [{ timerId: "od-fit-pull", methodId: "fit_pipeline", defaultIntervalMs: 7_200_000, description: manifest.timers[0].description }]);
  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.deepEqual([...new Set(inspection.imports.map((entry) => entry.module))].sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("one pass: Starlink and ISS records fitted to analysis/od's own records; the rest reported with the reason", async (t) => {
  const moon = variant(STARLINK[0], (block) => { block.CENTER_NAME = "MOON"; });
  const short = variant(STARLINK[1], (block) => { block.EPHEMERIS_DATA = block.EPHEMERIS_DATA.slice(0, 5 * 6); });
  const stub = createHostStub({ records: [
    record("cid-sl-0", "spacex-starlink", STARLINK[0], "spacex"),
    record("cid-iss-v", "iss", ISS_VERBOSE),
    record("cid-moon", "spacex-starlink", moon, "spacex"),
    record("cid-sl-1", "spacex-starlink", STARLINK[1], "spacex"),
    record("cid-short", "spacex-starlink", short, "spacex"),
    record("cid-junk", "iss", new TextEncoder().encode("not an ephemeris record")),
    record("cid-oneweb", "oneweb", STARLINK[0]),
  ] });
  const out = split(await run(t, stub));

  // The wire: plugin.getConfig, then one storage.query for the compiled default (OEM, 500).
  assert.deepEqual(stub.wire.map((c) => c.op), ["plugin.getConfig", "storage.query"]);
  assert.deepEqual(stub.calls.find((c) => c.operation === "storage.query").params, { schema: "OEM", limit: 500 });

  assert.equal(out.omm.length, 3);
  assert.equal(out.obd.length, 3);
  assert.deepEqual(out.omm.map((b) => omm(b).NORAD_CAT_ID()), [67850, 25544, 67851]);
  assert.deepEqual(out.obd.map((b) => obd(b).SENSORS(0)?.SENSOR_ID()), ["SpaceX-E", "ISS-E", "SpaceX-E"]);
  const iss = omm(out.omm[1]);
  assert.equal(iss.OBJECT_NAME(), "ISS");
  assert.ok(iss.MEAN_MOTION() > 15 && iss.MEAN_MOTION() < 16);
  assert.ok(Math.abs(iss.INCLINATION() - 51.6) < 0.2);

  // Byte for byte the records analysis/od's `fit` emits for each $OEM with the provider's settings as its config.
  const sources = [[STARLINK[0], "SpaceX-E"], [ISS_VERBOSE, "ISS-E"], [STARLINK[1], "SpaceX-E"]];
  for (const [i, [bytes, dataSource]] of sources.entries()) {
    const theirs = await odFit(t, bytes, { dataSource, maxIterations: 50 });
    assert.deepEqual(Buffer.from(out.omm[i]), Buffer.from(theirs.omm), `record ${i}: the $OMM analysis/od emits`);
    assert.deepEqual(Buffer.from(out.obd[i]), Buffer.from(theirs.obd), `record ${i}: the $OBD analysis/od emits`);
  }

  const skipped = out.notices.filter((n) => n.kind === "skipped");
  assert.deepEqual(skipped.map((n) => [n.sourceName, n.providerId, n.items, n.reason.split(":")[0], n.count, n.atMs]), [
    ["spacex-starlink", "spacex", ["cid-moon"], "unsupported-center", 1, FIRED_MS],
    ["spacex-starlink", "spacex", ["cid-short"], "too-few-samples", 1, FIRED_MS],
    ["iss", "", ["cid-junk"], "parse-failed", 1, FIRED_MS],
    ["", "", ["cid-oneweb"], "unconfigured", 1, FIRED_MS],
  ]);
  assert.equal(skipped[1].reason, "too-few-samples:5");
  const info = out.notices.filter((n) => n.kind === "info");
  assert.deepEqual(info.map((n) => [n.sourceName, n.count, n.items]), [
    ["spacex-starlink", 2, ["cid-sl-0", "cid-sl-1"]],
    ["iss", 1, ["cid-iss-v"]],
  ]);
  assert.match(info[0].reason, /^fitted 2 of 4 \(skipped 2; ids registry-mapped 0, unmapped 0; 7 records read\)$/);
  assert.ok(out.notices.every((n) => n.schema === "OEM"));
});

test("config: the provider set, its fit policy, size-prefixed stored records and the object-ID registry", async (t) => {
  // Position-only style records with no NORAD: one the registry maps, one it does not (honest-empty IDs).
  const r03 = variant(ISS_COMPACT, (block) => { block.OBJECT.OBJECT_NAME = "R03"; block.OBJECT.NORAD_CAT_ID = 0; block.OBJECT.OBJECT_ID = ""; });
  const r99 = variant(ISS_COMPACT, (block) => { block.OBJECT.OBJECT_NAME = "R99"; block.OBJECT.NORAD_CAT_ID = 0; block.OBJECT.OBJECT_ID = ""; });
  const sizePrefixed = (bytes) => { const out = new Uint8Array(bytes.length + 4); new DataView(out.buffer).setUint32(0, bytes.length, true); out.set(bytes, 4); return out; };
  const stub = createHostStub({
    config: {
      querySchema: "OEM", queryLimit: 20,
      providers: [{ sourceName: "glonass-test", dataSource: "GLONASS-E", requireConverged: false, fit: { maxIterations: 40, fitWindowSec: 5400 } }],
      idRegistry: { R03: { NORAD_CAT_ID: 32275, OBJECT_ID: "2007-052A" } },
    },
    records: [record("cid-r03", "glonass-test", sizePrefixed(r03)), record("cid-r99", "glonass-test", r99), record("cid-iss", "iss", ISS_COMPACT)],
  });
  const out = split(await run(t, stub));
  assert.deepEqual(stub.calls.find((c) => c.operation === "storage.query").params, { schema: "OEM", limit: 20 });
  assert.deepEqual(out.omm.map((b) => [omm(b).OBJECT_NAME(), omm(b).NORAD_CAT_ID(), omm(b).OBJECT_ID() ?? ""]), [["R03", 32275, "2007-052A"], ["R99", 0, ""]]);
  assert.deepEqual(out.obd.map((b) => obd(b).SENSORS(0)?.SENSOR_ID()), ["GLONASS-E", "GLONASS-E"]);
  const notices = out.notices.map((n) => [n.kind, n.sourceName, n.count, n.items]);
  assert.deepEqual(notices, [["skipped", "", 1, ["cid-iss"]], ["info", "glonass-test", 2, ["cid-r03", "cid-r99"]]]);
  assert.match(out.notices[1].reason, /ids registry-mapped 1, unmapped 1/);
});

test("a store that cannot be read is a Missing notice and no records; an empty store fits nothing", async (t) => {
  const failing = split(await run(t, createHostStub({ fail: "store offline" })));
  assert.equal(failing.omm.length, 0);
  assert.deepEqual(failing.notices.map((n) => [n.kind, n.schema]), [["missing", "OEM"]]);
  assert.match(failing.notices[0].reason, /^storage-query-failed: .*store offline/);

  const empty = split(await run(t, createHostStub(), []));
  assert.equal(empty.omm.length, 0);
  assert.deepEqual(empty.notices.map((n) => [n.kind, n.sourceName, n.count, n.atMs]), [["info", "spacex-starlink", 0, 0], ["info", "iss", 0, 0]]);
});
