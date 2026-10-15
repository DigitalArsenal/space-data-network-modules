// Tri-runtime parity for the celestrak-parser artifact: the SAME invoke bytes
// through a real headless browser, native WasmEdge and the pinned Docker
// WasmEdge must produce byte-identical responses. parse_gp is the case that
// carries the GP product's REFERENCE_FRAME (TEME of date) in every OMM record;
// the other methods keep their existing outputs under the same comparison.
// Needs WasmEdge 0.16.4 (native), Docker with the SDK parity image and Chrome,
// so it runs on request: SDN_RUN_CELESTRAK_PARSER_PARITY=1.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodePluginInvokeResponse } from "space-data-module-sdk/invoke";
import {
  defaultParityLaneRunners,
  formatParityReport,
  normalizeParityFixture,
  runParityHarness,
} from "space-data-module-sdk/testing";

import { flatbuffers, responseInput, sdsLib } from "./frames.mjs";

const { CelestialFrame, CelestialFrameWrapper, OMM, RFMUnion } = await sdsLib("OMM");

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

// The typed HttpResponse frame (its job a size-prefixed $ICN in CONTEXT) in the parity plan's base64 form.
const asPlanInput = ({ payload, ...frame }) => ({ ...frame, payloadBase64: Buffer.from(payload).toString("base64") });

// The response Date header pins the retrieval time in the provenance record, which otherwise falls back to the guest
// wall clock (ambient state that differs between lanes run seconds apart).
const HEADERS = { date: "Mon, 28 Sep 2026 12:00:00 GMT" };

const JOBS = {
  parse_gp: {
    source_url: "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv",
    source_name: "celestrak-gp",
    dataset_id: "gp-full-catalog",
  },
  parse_satcat: {
    source_url: "https://celestrak.org/pub/satcat.csv",
    source_name: "celestrak-satcat",
  },
  parse_socrates: {
    source_url: "https://celestrak.org/SOCRATES/sort-minRange.csv",
    source_name: "celestrak-socrates",
  },
};

const invoke = (methodId, body) => ({
  methodId,
  inputs: [asPlanInput(responseInput(JOBS[methodId], body, HEADERS))],
});

test(
  "celestrak-parser bytes match in a real browser, native WasmEdge and Docker WasmEdge",
  { skip: process.env.SDN_RUN_CELESTRAK_PARSER_PARITY !== "1" },
  async () => {
    const cases = [
      { id: "gp-omm-with-teme-frame", request: invoke("parse_gp", fixture("celestrak-gp-omm.csv")), expect: "ok" },
      { id: "satcat-csv", request: invoke("parse_satcat", fixture("celestrak-satcat.csv")), expect: "ok" },
      { id: "socrates-minrange", request: invoke("parse_socrates", fixture("celestrak-socrates-minrange.csv")), expect: "ok" },
      {
        id: "gp-not-modified",
        request: {
          methodId: "parse_gp",
          inputs: [asPlanInput(responseInput(JOBS.parse_gp, new Uint8Array(0), HEADERS, 304))],
        },
        expect: "ok",
      },
    ];
    const plan = await normalizeParityFixture({ name: "celestrak-parser", threadCounts: [1], cases });
    // Observe each lane's actual response bytes as well, so the frame is
    // checked in what every runtime emitted, not only in their equality.
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
      wasmPath: fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)),
      plan,
      laneRunners,
      autoBuildDockerImage: false,
      timeoutMs: 60000,
      log: console.log,
    });
    console.log(formatParityReport(report));
    assert.equal(report.ok, true, formatParityReport(report));
    assert.equal(report.lanes.length, 3);
    for (const run of report.runs) assert.equal(run.exitClass, "ok", `${run.lane}/${run.caseId}`);

    const gpRuns = observed.filter((run) => run.caseId === "gp-omm-with-teme-frame");
    assert.deepEqual(gpRuns.map((run) => run.lane).sort(), ["browser", "docker-wasmedge", "wasmedge"]);
    for (const run of gpRuns) {
      const decoded = decodePluginInvokeResponse(run.stdout);
      assert.equal(decoded.statusCode, 0, `${run.lane}: ${decoded.errorMessage}`);
      const stream = decoded.outputs.find((frame) => frame.portId === "omm_records").payload;
      const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
      let records = 0;
      for (let offset = 0; offset < stream.byteLength; ) {
        const length = view.getUint32(offset, true);
        const record = Uint8Array.from(stream.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
        const frame = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(record)).REFERENCE_FRAME();
        assert.ok(frame, `${run.lane}: OMM record without REFERENCE_FRAME`);
        assert.equal(frame.REFERENCE_FRAME_type(), RFMUnion.CelestialFrameWrapper, run.lane);
        assert.equal(frame.REFERENCE_FRAME(new CelestialFrameWrapper()).frame(), CelestialFrame.TEMEOFDATE, run.lane);
        records++;
      }
      assert.equal(records, 2, `${run.lane}: OMM record count`);
    }
  },
);
