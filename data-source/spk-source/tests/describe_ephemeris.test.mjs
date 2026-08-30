/*
 * `describe_ephemeris` — actually invoked, because it shipped broken once.
 *
 * The method's `plugin_push_output_ex` call passed a null schema name and file
 * identifier and had `fixed_string_length` and `required_alignment` TRANSPOSED
 * (8, 1 instead of 0, 8). `ResolveOutputType` refuses all three of those on a
 * port that declares concrete SDS types, so every invocation would have failed
 * with `unsupported-output-type` — and nothing noticed, because the propagator
 * suites drive the ABI exports and never the record surface.
 *
 * Two uint16_t neighbours in a nine-argument C call is exactly the transposition
 * a compiler cannot see. The only thing that catches it is calling the method.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing/browser";
import { toLoadableWasmBytes } from "space-data-module-sdk/bundle";

import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataBlock } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLine } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";

/* The generated JS is ASYMMETRIC and it catches people out: the builder statics
 * are camelCase (`addEpoch`, `addXDot`) while the READ accessors keep the IDL
 * capitalization verbatim (`EPOCH()`, `X_DOT()`). The read side is the one the
 * JSON-key rule governs, and it is the side asserted below. */

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(here, "..", "dist", "isomorphic", "module.wasm");

/* A two-state $OEM in the verbose form. Epochs are explicit so the round trip
 * is checked against dates we wrote, not dates the module chose. */
function buildOem(epochs) {
  const b = new flatbuffers.Builder(2048);
  const lines = epochs.map((iso, i) => {
    const e = b.createString(iso);
    ephemerisDataLine.startephemerisDataLine(b);
    ephemerisDataLine.addEpoch(b, e);
    ephemerisDataLine.addX(b, 7000 + i);
    ephemerisDataLine.addY(b, 100 + i);
    ephemerisDataLine.addZ(b, 200 + i);
    ephemerisDataLine.addXDot(b, 1 + i * 0.01);
    ephemerisDataLine.addYDot(b, 2 + i * 0.01);
    ephemerisDataLine.addZDot(b, 3 + i * 0.01);
    return ephemerisDataLine.endephemerisDataLine(b);
  });
  const linesVec = ephemerisDataBlock.createEphemerisDataLinesVector(b, lines);
  const centre = b.createString("EARTH");
  const interp = b.createString("Hermite");
  ephemerisDataBlock.startephemerisDataBlock(b);
  ephemerisDataBlock.addCenterName(b, centre);
  ephemerisDataBlock.addInterpolation(b, interp);
  ephemerisDataBlock.addInterpolationDegree(b, 7);
  ephemerisDataBlock.addEphemerisDataLines(b, linesVec);
  const block = ephemerisDataBlock.endephemerisDataBlock(b);
  const blocks = OEM.createEphemerisDataBlockVector(b, [block]);
  OEM.startOEM(b);
  OEM.addCcsdsOemVers(b, 3.0);
  OEM.addEphemerisDataBlock(b, blocks);
  const oem = OEM.endOEM(b);
  OEM.finishSizePrefixedOEMBuffer(b, oem);
  return b.asUint8Array();
}

test("describe_ephemeris answers with a typed $OEM instead of refusing", async () => {
  const bytes = new Uint8Array(fs.readFileSync(ARTIFACT));
  const harness = await createBrowserModuleHarness({
    wasmSource: toLoadableWasmBytes(bytes),
    surface: "command",
  });

  const epochs = ["2026-01-01T00:00:00.000000", "2026-01-01T00:01:00.000000"];
  const response = await harness.invoke({
    methodId: "describe_ephemeris",
    inputs: [
      {
        portId: "ephemeris",
        /* The canonical type ref, not the aligned-binary peer: the aligned
         * descriptor carries a byteLength the harness requires and the port
         * accepts both, so the canonical form is the one a caller writes. */
        typeRef: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" },
        payload: buildOem(epochs),
      },
    ],
  });

  assert.equal(
    response.statusCode,
    0,
    `describe_ephemeris failed: ${response.errorCode ?? ""} ${response.errorMessage ?? ""}`,
  );

  const frame = response.outputs.find((o) => o.portId === "summary");
  assert.ok(frame, "no summary frame");

  const buf = new flatbuffers.ByteBuffer(new Uint8Array(frame.payload));
  const out = OEM.getSizePrefixedRootAsOEM(buf);
  const block = out.EPHEMERIS_DATA_BLOCK(0);
  assert.ok(block, "no ephemeris data block came back");

  /* The epochs must come back as the ones we sent. This is where the 305-day
   * formatter defect would surface on the shipping record surface. */
  assert.equal(block.START_TIME(), epochs[0]);
  assert.equal(block.STOP_TIME(), epochs[1]);
  assert.equal(block.EPHEMERIS_DATA_LINES(0).EPOCH(), epochs[0]);
  assert.equal(block.EPHEMERIS_DATA_LINES(1).EPOCH(), epochs[1]);

  /* And the module must report the rule it will actually use, not "Unknown". */
  assert.equal(block.INTERPOLATION(), "Hermite");
  assert.equal(block.CENTER_NAME(), "EARTH");

  await harness.destroy?.();
});
