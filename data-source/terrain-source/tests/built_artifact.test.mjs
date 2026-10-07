// The committed build, as the module catalog will publish it.
//
// Both artifacts embed this package's $PLG identity. The tri-runtime half runs
// dist/parity/module.wasm, because the SDK's WasmEdge lanes cannot link the
// space_data_module_host bridge the shipped artifact imports (build-parity.mjs
// says why); tests/parity-artifact.test.mjs proves the two answer every fixture
// case with identical bytes. Two cases, two known answers per lane:
//
//   layer_json — the quantized-mesh layer.json (format "quantized-mesh-1.0",
//                scheme "tms") with the plan's maxzoom 13, gzip on the wire;
//   respond    — a conditional GET whose If-None-Match equals the stored
//                record's ETag is 304 Not Modified with that same ETag
//                (RFC 9110 §13.1.2).
//
// Needs Chrome (SDM_CHROME_BINARY), WasmEdge 0.16.4 on PATH and Docker with the
// SDK parity image, so it runs on request: SDN_RUN_TERRAIN_SOURCE_PARITY=1.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { decodeHttpResponse } from "space-data-module-sdk/http";
import { embeddedPlgManifest } from "space-data-module-sdk/host/runtime-target-gate";
import { decodePluginInvokeResponse } from "space-data-module-sdk/invoke";
import {
  defaultParityLaneRunners,
  formatParityReport,
  normalizeParityFixture,
  runParityHarness,
} from "space-data-module-sdk/testing";

const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const PARITY_WASM = fileURLToPath(new URL("../dist/parity/module.wasm", import.meta.url));

for (const artifact of ["isomorphic", "parity"]) {
  test(`dist/${artifact}/module.wasm embeds this manifest's plugin id and version`, () => {
    const bytes = fs.readFileSync(new URL(`../dist/${artifact}/module.wasm`, import.meta.url));
    const embedded = embeddedPlgManifest(new WebAssembly.Module(bytes));
    assert.equal(embedded?.pluginId, manifest.pluginId);
    assert.equal(embedded?.version, manifest.version);
  });
}

const header = (response, name) => response.headers.find((h) => h.name.toLowerCase() === name)?.value;

test(
  "layer_json and a conditional respond give the same known answers in browser, WasmEdge and Docker WasmEdge",
  { skip: process.env.SDN_RUN_TERRAIN_SOURCE_PARITY !== "1" },
  async () => {
    const fixture = JSON.parse(fs.readFileSync(`${FIXTURE_DIR}terrain-parity.json`, "utf8"));
    const wanted = ["layer-json", "respond-not-modified"];
    const plan = await normalizeParityFixture(
      { ...fixture, threadCounts: [1], cases: fixture.cases.filter((c) => wanted.includes(c.id)) },
      { fixtureDir: FIXTURE_DIR },
    );
    const ifNoneMatch = JSON.parse(fs.readFileSync(`${FIXTURE_DIR}parity/context-conditional.json`, "utf8")).ifNoneMatch;
    const observed = [];
    const laneRunners = Object.fromEntries(
      Object.entries(defaultParityLaneRunners).map(([lane, runner]) => [
        lane,
        async (context) => {
          const runs = await runner(context);
          observed.push(...runs.map((run) => ({ ...run, lane })));
          return runs;
        },
      ]),
    );
    const report = await runParityHarness({
      wasmPath: PARITY_WASM,
      plan,
      laneRunners,
      autoBuildDockerImage: false,
      timeoutMs: 60000,
      log: console.log,
    });
    assert.equal(report.ok, true, formatParityReport(report));

    for (const caseId of wanted) {
      const runs = observed.filter((run) => run.caseId === caseId);
      assert.deepEqual(runs.map((run) => run.lane).sort(), ["browser", "docker-wasmedge", "wasmedge"], caseId);
      for (const run of runs) {
        const decoded = decodePluginInvokeResponse(run.stdout);
        assert.equal(decoded.statusCode, 0, `${run.lane}/${caseId}: ${decoded.errorMessage}`);
        const http = decodeHttpResponse(decoded.outputs.find((o) => o.portId === "response").payload);
        if (caseId === "layer-json") {
          assert.equal(http.status, 200, run.lane);
          assert.equal(header(http, "content-encoding"), "gzip", run.lane);
          const layer = JSON.parse(zlib.gunzipSync(Buffer.from(http.body)).toString("utf8"));
          assert.equal(layer.format, "quantized-mesh-1.0", run.lane);
          assert.equal(layer.scheme, "tms", run.lane);
          assert.equal(layer.maxzoom, 13, run.lane);
        } else {
          assert.equal(http.status, 304, run.lane);
          assert.equal(header(http, "etag"), ifNoneMatch, run.lane);
        }
      }
    }
  },
);
