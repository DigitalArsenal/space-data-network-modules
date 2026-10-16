// THE MOON CASES, IN EVERY RUNTIME (moon-terrain-lane-20261013). The committed fixture
// (tests/fixtures/build-moon-parity-fixture.mjs) carries a body plan over a synthetic simple-cylindrical product, one
// over a synthetic south polar stereographic product, and pack over the first one's records. Each must answer with a
// body record carrying normals (and pack with its named files) in the shipped artifact, and - on request,
// SDN_RUN_TERRAIN_SOURCE_PARITY=1 with Chrome (SDM_CHROME_BINARY), WasmEdge 0.16.4 on PATH and the SDK's Docker
// parity image - byte for byte the same in browser, WasmEdge and Docker WasmEdge.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { decodePluginInvokeResponse } from "space-data-module-sdk/invoke";
import {
  createBrowserModuleHarness,
  defaultParityLaneRunners,
  formatParityReport,
  normalizeParityFixture,
  runParityHarness,
} from "space-data-module-sdk/testing";

import { decodeQuantizedMesh } from "./helpers.mjs";
import { dttOf, splitSized } from "../tools/moon-lane.mjs";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(`${FIXTURE_DIR}terrain-parity.json`, "utf8"));
const MOON = FIXTURE.cases.filter((c) => c.id.startsWith("moon-"));
const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));

// What every lane must say for each case.
function check(caseId, outputs, lane) {
  const port = (id) => outputs.filter((o) => o.portId === id).map((o) => Buffer.from(o.payload));
  if (caseId === "moon-pack") {
    const files = port("file"), names = splitSized(port("names")[0]);
    assert.equal(files.length, names.length, lane);
    assert.ok(files.length >= 1, lane);
    return;
  }
  const records = splitSized(port("records")[0]);
  assert.equal(records.length, caseId === "moon-tile-cylindrical" ? 2 : 1, `${lane} ${caseId}`);
  for (const sized of records) {
    const t = dttOf(sized.subarray(4)).unpack();
    assert.equal(t.TILING_SCHEME, 5, lane);
    assert.equal(t.CENTER_NAME, "MOON", lane);
    const mesh = decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(t.PAYLOAD.BYTES)));
    assert.deepEqual(mesh.extensions.map((e) => e.id), [1], `${lane} ${caseId}: normals`);
  }
}

const inputsOf = (c) => c.request.inputs.map((i) => ({ portId: i.portId, typeRef: i.typeRef, payload: new Uint8Array(fs.readFileSync(`${FIXTURE_DIR}${i.payloadFile}`)) }));

test("the shipped artifact answers every Moon parity case", async (t) => {
  assert.deepEqual(MOON.map((c) => c.id), ["moon-tile-cylindrical", "moon-tile-polar", "moon-pack"]);
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url)), manifest: MANIFEST, surface: "direct" });
  t.after(() => harness.destroy());
  for (const c of MOON) {
    const response = await harness.invoke({ methodId: c.request.methodId, inputs: inputsOf(c) });
    assert.equal(response.statusCode, 0, `${c.id}: ${response.errorCode} ${response.errorMessage}`);
    check(c.id, response.outputs, "shipped");
  }
});

test("the Moon cases give the same bytes in browser, WasmEdge and Docker WasmEdge", { skip: process.env.SDN_RUN_TERRAIN_SOURCE_PARITY !== "1" }, async () => {
  const plan = await normalizeParityFixture({ ...FIXTURE, threadCounts: [1], cases: MOON }, { fixtureDir: FIXTURE_DIR });
  const observed = [];
  const laneRunners = Object.fromEntries(Object.entries(defaultParityLaneRunners).map(([lane, runner]) => [lane, async (context) => {
    const runs = await runner(context);
    observed.push(...runs.map((run) => ({ ...run, lane })));
    return runs;
  }]));
  const report = await runParityHarness({
    wasmPath: fileURLToPath(new URL("../dist/parity/module.wasm", import.meta.url)),
    plan, laneRunners, autoBuildDockerImage: false, timeoutMs: 120000, log: console.log,
  });
  assert.equal(report.ok, true, formatParityReport(report));
  for (const c of MOON) {
    const runs = observed.filter((run) => run.caseId === c.id);
    assert.deepEqual(runs.map((run) => run.lane).sort(), ["browser", "docker-wasmedge", "wasmedge"], c.id);
    for (const run of runs) {
      const decoded = decodePluginInvokeResponse(run.stdout);
      assert.equal(decoded.statusCode, 0, `${run.lane}/${c.id}: ${decoded.errorMessage}`);
      check(c.id, decoded.outputs, run.lane);
    }
  }
});
