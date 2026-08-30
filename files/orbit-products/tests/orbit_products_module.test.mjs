/*
 * The container reader, INVOKED — because a build that succeeds proves nothing
 * about a method.
 *
 * This package had four native `.cpp` suites and no invoke test, and the gap is
 * not theoretical: `describe_ephemeris` in the sibling propagator shipped with
 * `plugin_push_output_ex`'s `fixed_string_length` and `required_alignment`
 * transposed and a null type ref, and it refused EVERY call. The build
 * succeeded, the artifact signed, SDK validation returned ok, and every export
 * was present. Two uint16_t neighbours in a nine-argument C call is exactly the
 * transposition nothing upstream of an actual invocation can see.
 *
 * So this drives both methods across all four containers and asserts what comes
 * back, not merely that something did.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing/browser";
import { toLoadableWasmBytes } from "space-data-module-sdk/bundle";

import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { ncdContainerFormat } from "spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WASM_PATH = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const MANIFEST_PATH = path.join(packageRoot, "plugin-manifest.json");

/* The four containers of ONE closed-form arc that the propagator package
 * generates. Reaching them here is the same include-don't-copy seam the build
 * uses for the headers: one trajectory, so a disagreement is the reader's. */
const ARC = path.join(packageRoot, "..", "..", "data-source", "spk-source", "fixtures");

const CONTAINERS = [
  ["ephemeris.oem", ncdContainerFormat.CCSDS_OEM_KVN],
  ["ephemeris.bsp", ncdContainerFormat.SPK_DAF],
  ["ephemeris.code500", ncdContainerFormat.CODE_500],
  ["ephemeris.e", ncdContainerFormat.SCENARIO_EPOCH_EPHEMERIS_TEXT],
];

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/* [u32le n][ $NCD, n bytes ][ the container's exact bytes ]. The prefix makes
 * the boundary self-describing; the hash makes the pairing provable. */
function buildFrame(bytes, format, { hash = true } = {}) {
  const b = new flatbuffers.Builder(1024);
  const sha = hash ? b.createString(sha256Hex(bytes)) : null;
  NCD.startNCD(b);
  if (format !== undefined) NCD.addFormat(b, format);
  NCD.addSourceByteLength(b, BigInt(bytes.byteLength));
  if (sha !== null) NCD.addSourceSha256(b, sha);
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  const desc = b.asUint8Array();
  const frame = new Uint8Array(desc.byteLength + bytes.byteLength);
  frame.set(desc, 0);
  frame.set(bytes, desc.byteLength);
  return frame;
}

const NCD_TYPE = {
  schemaName: "NCD.fbs",
  fileIdentifier: "$NCD",
  rootTypeName: "NCD",
};

async function harness() {
  return createBrowserModuleHarness({
    wasmSource: toLoadableWasmBytes(new Uint8Array(fs.readFileSync(WASM_PATH))),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "command",
  });
}

const ready = fs.existsSync(WASM_PATH) && fs.existsSync(path.join(ARC, "ephemeris.oem"));

test("read_container returns states and a descriptor for all four containers", { skip: !ready }, async () => {
  const h = await harness();
  try {
    for (const [name, format] of CONTAINERS) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(ARC, name)));
      const res = await h.invoke({
        methodId: "read_container",
        inputs: [{ portId: "container", typeRef: NCD_TYPE, payload: buildFrame(bytes, format) }],
      });
      assert.equal(res.statusCode, 0, `${name}: ${res.errorCode ?? ""} ${res.errorMessage ?? ""}`);

      const oemFrame = res.outputs.find((o) => o.portId === "ephemeris");
      assert.ok(oemFrame, `${name}: no ephemeris frame`);
      const oem = OEM.getSizePrefixedRootAsOEM(
        new flatbuffers.ByteBuffer(new Uint8Array(oemFrame.payload)),
      );
      const block = oem.EPHEMERIS_DATA_BLOCK(0);
      assert.ok(block, `${name}: no data block`);
      /* $OEM declares state rows TWICE and forbids populating both
       * (schema/OEM/main.fbs): STEP_SIZE > 0 selects the compact row-major
       * EPHEMERIS_DATA on an implicit uniform grid, STEP_SIZE == 0 selects
       * EPHEMERIS_DATA_LINES with an explicit EPOCH per state. This arc is a
       * uniform 60 s grid, so the compact form is what it IS — and the first
       * version of this assertion demanded the verbose form and failed, which
       * is the test being wrong rather than the module.
       *
       * Assert the RULE, not one branch of it: exactly one form populated,
       * 121 states either way, and the two never both present. */
      const compact = block.ephemerisDataLength();
      const verbose = block.ephemerisDataLinesLength();
      assert.ok(
        (compact > 0) !== (verbose > 0),
        `${name}: exactly one $OEM state form must be populated (compact ${compact}, lines ${verbose})`,
      );
      const stateSize = block.STATE_VECTOR_SIZE() || 6;
      const states = compact > 0 ? compact / stateSize : verbose;
      assert.equal(states, 121, `${name}: state count`);
      if (compact > 0) {
        assert.ok(block.STEP_SIZE() > 0, `${name}: compact form requires STEP_SIZE > 0`);
        assert.equal(compact % stateSize, 0, `${name}: EPHEMERIS_DATA is not a whole number of states`);
      } else {
        assert.equal(block.STEP_SIZE(), 0, `${name}: verbose form requires STEP_SIZE == 0`);
      }

      const descFrame = res.outputs.find((o) => o.portId === "descriptor");
      assert.ok(descFrame, `${name}: no descriptor frame`);
      const ncd = NCD.getSizePrefixedRootAsNCD(
        new flatbuffers.ByteBuffer(new Uint8Array(descFrame.payload)),
      );
      assert.equal(ncd.FORMAT(), format, `${name}: FORMAT round trip`);
      assert.equal(ncd.SOURCE_SHA256(), sha256Hex(bytes), `${name}: SOURCE_SHA256`);
    }
  } finally {
    await h.destroy?.();
  }
});

test("describe_container answers without materialising states", { skip: !ready }, async () => {
  const h = await harness();
  try {
    const bytes = new Uint8Array(fs.readFileSync(path.join(ARC, "ephemeris.bsp")));
    const res = await h.invoke({
      methodId: "describe_container",
      inputs: [
        {
          portId: "container",
          typeRef: NCD_TYPE,
          payload: buildFrame(bytes, ncdContainerFormat.SPK_DAF),
        },
      ],
    });
    assert.equal(res.statusCode, 0, `${res.errorCode ?? ""} ${res.errorMessage ?? ""}`);
    const descFrame = res.outputs.find((o) => o.portId === "descriptor");
    assert.ok(descFrame, "no descriptor frame");
    const ncd = NCD.getSizePrefixedRootAsNCD(
      new flatbuffers.ByteBuffer(new Uint8Array(descFrame.payload)),
    );
    assert.equal(ncd.FORMAT(), ncdContainerFormat.SPK_DAF);
    /* A DAF's segments are the thing only the descriptor can carry. */
    assert.ok(ncd.segmentsLength() >= 1, "no segment descriptors");
  } finally {
    await h.destroy?.();
  }
});

test("a hash over other bytes is refused, not read anyway", { skip: !ready }, async () => {
  const h = await harness();
  try {
    const bytes = new Uint8Array(fs.readFileSync(path.join(ARC, "ephemeris.oem")));
    const frame = buildFrame(bytes, ncdContainerFormat.CCSDS_OEM_KVN, { hash: false });
    /* Declare a hash of DIFFERENT bytes: the descriptor and the payload no
     * longer belong together, which is the whole reason the schema carries
     * SOURCE_SHA256. A reader that proceeds anyway has made the field
     * decorative. */
    const b = new flatbuffers.Builder(1024);
    const sha = b.createString(sha256Hex(new Uint8Array([1, 2, 3])));
    NCD.startNCD(b);
    NCD.addFormat(b, ncdContainerFormat.CCSDS_OEM_KVN);
    NCD.addSourceByteLength(b, BigInt(bytes.byteLength));
    NCD.addSourceSha256(b, sha);
    NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
    const desc = b.asUint8Array();
    const bad = new Uint8Array(desc.byteLength + bytes.byteLength);
    bad.set(desc, 0);
    bad.set(bytes, desc.byteLength);

    const res = await h.invoke({
      methodId: "read_container",
      inputs: [{ portId: "container", typeRef: NCD_TYPE, payload: bad }],
    });
    assert.notEqual(res.statusCode, 0, "a mismatched SOURCE_SHA256 was accepted");
    assert.match(
      `${res.errorCode ?? ""} ${res.errorMessage ?? ""}`,
      /SHA256|hash/i,
      "the refusal did not name the hash",
    );
    void frame;
  } finally {
    await h.destroy?.();
  }
});
