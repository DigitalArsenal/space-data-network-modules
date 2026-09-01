// The gridSize decision, measured on REAL terrain instead of argued.
//
// gridSize trades two BOUNDS against each other and both are binding:
//
//   * per-tile gzipped size — Hermes: p50 <= 4 KiB, p99 <= 12 KiB, hard 32 KiB,
//     and a 20 GiB ceiling on the whole store;
//   * vertical accuracy — Atlas: max error <= 77067/2^level metres against the
//     full-resolution source, RMSE within 25% of that.
//
// A denser lattice buys accuracy with bytes. This measures both on the same
// real granule so the choice is a number rather than a preference.
//
// The reference is the encoder's own gridSize-129 output over the SAME source
// raster — 77 m post spacing at z11 against the dataset's native 30 m. NOT 255:
// a gridSize-255 tile over Alpine relief encodes to ~49.5 KB gzipped and the
// encoder REFUSES it at the 32 KiB serving ceiling, which is the right answer
// for a served tile and makes 255 unusable as a reference here. So the errors
// below are measured against a surface that is itself a downsample, and the
// true error against the native raster is at most this plus the reference's
// own — stated, not hidden.
//
//   node tools/terrain-pyramid/measure-grid.mjs --granule <file.bin> --level 11 --x N --y N

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SDK_DIR = path.join(REPO, "flows", "terrain-ingest", "node_modules", "space-data-module-sdk");
const WASM = path.join(REPO, "data-source", "terrain-source", "dist", "isomorphic", "module.wasm");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO, "data-source", "terrain-source", "plugin-manifest.json"), "utf8"),
);

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
assert.ok(args.granule, "--granule <cached granule .bin> is required");
const level = Number(args.level ?? 11);
const tileX = Number(args.x);
const tileY = Number(args.y);
assert.ok(Number.isInteger(tileX) && Number.isInteger(tileY), "--x and --y are required");

const encoder = new TextEncoder();
const frame = (portId, bytes) => ({
  portId,
  typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.length },
  payload: bytes,
});
const jsonFrame = (portId, value) => frame(portId, encoder.encode(JSON.stringify(value)));

const granule = fs.readFileSync(path.resolve(args.granule));
const hrb = Buffer.alloc(8 + granule.length);
hrb.write("$HRB", 0, "latin1");
hrb.writeUInt32LE(200, 4);
granule.copy(hrb, 8);

const { createBrowserModuleHarness } = await import(path.join(SDK_DIR, "src/testing/index.js"));

function decodeMesh(buf) {
  let at = 0;
  const f64 = () => { const v = buf.readDoubleLE(at); at += 8; return v; };
  const f32 = () => { const v = buf.readFloatLE(at); at += 4; return v; };
  const u32 = () => { const v = buf.readUInt32LE(at); at += 4; return v; };
  const u16 = () => { const v = buf.readUInt16LE(at); at += 2; return v; };
  f64(); f64(); f64();
  const minHeight = f32();
  const maxHeight = f32();
  f64(); f64(); f64(); f64(); f64(); f64(); f64();
  const vertexCount = u32();
  const unzig = () => {
    const out = [];
    let value = 0;
    for (let i = 0; i < vertexCount; i += 1) {
      const z = u16();
      value += (z >> 1) ^ -(z & 1);
      out.push(value);
    }
    return out;
  };
  const u = unzig();
  const v = unzig();
  const h = unzig();
  return { minHeight, maxHeight, vertexCount, u, v, h };
}

async function encodeAt(gridSize) {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest: MANIFEST, surface: "direct" });
  try {
    const response = await harness.invoke({
      methodId: "tile",
      inputs: [
        jsonFrame("plan", {
          tilesetId: "measure",
          level,
          x: tileX,
          y: tileY,
          gridSize,
          maxLevel: level,
          provenance: {
            datasetId: "cop-dem-glo-30",
            datasetEpoch: "2023-04-01T00:00:00.000Z",
            retrievedAt: "2026-08-26T00:00:00.000Z",
            license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
          },
        }),
        frame("dem", new Uint8Array(hrb)),
      ],
    });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    const records = response.outputs.find((o) => o.portId === "records").payload;
    const buf = Buffer.from(records);
    const length = buf.readUInt32LE(0);
    const record = buf.subarray(4, 4 + length);
    // the payload bytes, straight out of the report
    const report = JSON.parse(new TextDecoder().decode(response.outputs.find((o) => o.portId === "report").payload));
    // pull the gzipped payload back out of the record by scanning for the gzip magic
    const gz = record.indexOf(Buffer.from([0x1f, 0x8b, 0x08]));
    const mesh = decodeMesh(zlib.gunzipSync(record.subarray(gz, gz + report.payloadBytes)));
    return { gridSize, payloadBytes: report.payloadBytes, mesh, report };
  } finally {
    harness.destroy();
  }
}

// Height at a normalized (u, v) position, bilinear over a lattice.
function sampler({ mesh, gridSize }) {
  const range = mesh.maxHeight - mesh.minHeight;
  const grid = new Float64Array(gridSize * gridSize);
  for (let n = 0; n < mesh.vertexCount; n += 1) {
    const i = Math.round((mesh.u[n] / 32767) * (gridSize - 1));
    const j = Math.round((mesh.v[n] / 32767) * (gridSize - 1));
    grid[j * gridSize + i] = mesh.minHeight + (mesh.h[n] / 32767) * range;
  }
  return (fu, fv) => {
    const x = fu * (gridSize - 1);
    const y = fv * (gridSize - 1);
    const x0 = Math.min(Math.floor(x), gridSize - 1);
    const y0 = Math.min(Math.floor(y), gridSize - 1);
    const x1 = Math.min(x0 + 1, gridSize - 1);
    const y1 = Math.min(y0 + 1, gridSize - 1);
    const dx = x - x0;
    const dy = y - y0;
    return (
      (1 - dy) * ((1 - dx) * grid[y0 * gridSize + x0] + dx * grid[y0 * gridSize + x1]) +
      dy * ((1 - dx) * grid[y1 * gridSize + x0] + dx * grid[y1 * gridSize + x1])
    );
  };
}

const REFERENCE_GRID = 129;
const reference = await encodeAt(REFERENCE_GRID);
const refAt = sampler(reference);
const levelBound = 77067 / 2 ** level;
const rows = [];

for (const gridSize of [33, 65]) {
  const candidate = await encodeAt(gridSize);
  const at = sampler(candidate);
  let maxDelta = 0;
  let sumSq = 0;
  let n = 0;
  // Compare on the REFERENCE lattice: every post the dense surface states.
  for (let j = 0; j < REFERENCE_GRID; j += 1) {
    for (let i = 0; i < REFERENCE_GRID; i += 1) {
      const fu = i / (REFERENCE_GRID - 1);
      const fv = j / (REFERENCE_GRID - 1);
      const delta = Math.abs(at(fu, fv) - refAt(fu, fv));
      maxDelta = Math.max(maxDelta, delta);
      sumSq += delta * delta;
      n += 1;
    }
  }
  rows.push({
    gridSize,
    postSpacingM: +(((180 / 2 ** level) / (gridSize - 1)) * 111320).toFixed(0),
    payloadBytes: candidate.payloadBytes,
    maxErrorM: +maxDelta.toFixed(2),
    rmseM: +Math.sqrt(sumSq / n).toFixed(2),
    levelBoundM: +levelBound.toFixed(1),
    withinMaxError: maxDelta <= levelBound,
    withinRmse: Math.sqrt(sumSq / n) <= 0.25 * levelBound,
  });
}

console.log(
  JSON.stringify(
    {
      level,
      tile: { x: tileX, y: tileY },
      referenceGridSize: REFERENCE_GRID,
      referencePayloadBytes: reference.payloadBytes,
      referenceRelief: {
        minHeightM: +reference.mesh.minHeight.toFixed(1),
        maxHeightM: +reference.mesh.maxHeight.toFixed(1),
      },
      levelBoundM: +levelBound.toFixed(1),
      rows,
    },
    null,
    2,
  ),
);
