// The committed build, as the module catalog will publish it: its embedded $PLG
// names this package, and the same parse_lookups request answers the same
// GeoNames names in a real headless browser, native WasmEdge and the pinned
// Docker WasmEdge. The artifact imports no host bridge, so every lane runs the
// shipped bytes themselves.
//
// The tri-runtime case needs Chrome (SDM_CHROME_BINARY), WasmEdge 0.16.4 on PATH
// and Docker with the SDK parity image, so it runs on request:
// SDN_RUN_GEONAMES_SOURCE_PARITY=1.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { embeddedPlgManifest } from "space-data-module-sdk/host/runtime-target-gate";
import { decodePluginInvokeResponse } from "space-data-module-sdk/invoke";
import {
  defaultParityLaneRunners,
  formatParityReport,
  normalizeParityFixture,
  runParityHarness,
} from "space-data-module-sdk/testing";

const WASM_PATH = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test("the built artifact embeds this manifest's plugin id and version", () => {
  const embedded = embeddedPlgManifest(new WebAssembly.Module(fs.readFileSync(WASM_PATH)));
  assert.equal(embedded?.pluginId, manifest.pluginId);
  assert.equal(embedded?.version, manifest.version);
});

function wire(portId, value) {
  const payload = Buffer.from(JSON.stringify(value));
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length },
    payloadBase64: payload.toString("base64"),
  };
}
const response = (body) => ({ status: 200, headers: {}, bodyB64: Buffer.from(body).toString("base64") });

test(
  "parse_lookups names Andorra and its parishes identically in browser, WasmEdge and Docker WasmEdge",
  { skip: process.env.SDN_RUN_GEONAMES_SOURCE_PARITY !== "1" },
  async () => {
    const plan = await normalizeParityFixture({
      name: "geonames-source",
      threadCounts: [1],
      cases: [
        {
          id: "lookups",
          request: {
            methodId: "parse_lookups",
            inputs: [
              wire("job", { dataset_id: "geonames", license: "CC BY 4.0" }),
              wire("admin1", response(fixture("admin1CodesASCII.slice.txt"))),
              wire("admin2", response(fixture("admin2Codes.slice.txt"))),
              wire("country", response(fixture("countryInfo.slice.txt"))),
            ],
          },
          expect: "ok",
        },
      ],
    });
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
      wasmPath: WASM_PATH,
      plan,
      laneRunners,
      autoBuildDockerImage: false,
      timeoutMs: 60000,
      log: console.log,
    });
    assert.equal(report.ok, true, formatParityReport(report));
    assert.deepEqual(observed.map((run) => run.lane).sort(), ["browser", "docker-wasmedge", "wasmedge"]);
    for (const run of observed) {
      const decoded = decodePluginInvokeResponse(run.stdout);
      assert.equal(decoded.statusCode, 0, `${run.lane}: ${decoded.errorMessage}`);
      const tables = JSON.parse(Buffer.from(decoded.outputs.find((o) => o.portId === "tables").payload));
      // countryInfo.txt row "AD AND 020 AN Andorra"; admin1CodesASCII.txt row
      // "AD.06 Sant Julià de Loria" (UTF-8 kept); first six admin1 rows.
      assert.equal(tables.country.AD, "Andorra", run.lane);
      assert.equal(tables.admin1["AD.06"], "Sant Julià de Loria", run.lane);
      assert.deepEqual(tables.counts, { admin1: 6, admin2: 6, country: 10 }, run.lane);
    }
  },
);
