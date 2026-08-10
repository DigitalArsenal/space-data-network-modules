/**
 * Load the built module and drive the propagator ABI from JavaScript.
 *
 * Note what this file does NOT contain: a single hard-coded byte offset. Every
 * read goes through ORBPRO_STATE_VECTOR / ORBPRO_OMM_RECORD, the bindings
 * GENERATED from the same IDL the C header comes from. That is the point of
 * the W1.1 generation lane — the JS reader and the C writer cannot disagree,
 * because neither of them wrote the layout down.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";

import {
  ORBPRO_OMM_RECORD,
  ORBPRO_STATE_VECTOR,
  ReferenceFrame,
  StateFlags,
} from "space-data-module-sdk/generated/propagator-abi";

export { ORBPRO_OMM_RECORD, ORBPRO_STATE_VECTOR, ReferenceFrame, StateFlags };

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const artifactPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");

/** Documented error codes — mirrors the ABI §10 table in the module source. */
export const ErrorCode = Object.freeze({
  OK: 0,
  NOT_INITIALIZED: -1,
  BAD_ENTITY_INDEX: -2,
  NULL_OUTPUT: -3,
  BAD_INPUT: -4,
  NOT_CONVERGED: -5,
  UNPHYSICAL: -6,
});

export async function loadModule() {
  const bytes = await fs.readFile(artifactPath);
  const wasi = new WASI({ version: "preview1", args: ["module"], env: {} });
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  // Deliberately NOT calling wasi.start(): the artifact declares the `command`
  // invoke surface, so `_start` is the SDK's stdin-driven invoke loop and
  // blocks forever when driven from a test. The propagator ABI is a set of
  // directly-callable exports — which is exactly how the engine calls it — so
  // the tests call them directly. The command surface is exercised separately
  // by the tri-runtime parity fixture.
  return new ReferencePropagator(instance);
}

export class ReferencePropagator {
  constructor(instance) {
    this.instance = instance;
    this.exports = instance.exports;
  }

  get memory() {
    return this.exports.memory;
  }

  view() {
    return new DataView(this.memory.buffer);
  }

  alloc(byteLength) {
    const pointer = this.exports.plugin_alloc(byteLength);
    if (pointer === 0) throw new Error(`plugin_alloc(${byteLength}) returned 0`);
    return pointer;
  }

  free(pointer) {
    this.exports.plugin_free(pointer);
  }

  /** Pack element sets into the ABI's OrbProOMMRecord layout. */
  packOmmRecords(records) {
    const { size, offsets } = ORBPRO_OMM_RECORD;
    const buffer = new ArrayBuffer(size * records.length);
    const view = new DataView(buffer);
    records.forEach((record, index) => {
      const base = index * size;
      view.setFloat64(base + offsets.epoch_jd, record.epochJd, true);
      view.setFloat64(base + offsets.mean_motion, record.meanMotionRevPerDay, true);
      view.setFloat64(base + offsets.eccentricity, record.eccentricity, true);
      view.setFloat64(base + offsets.inclination, record.inclinationDeg, true);
      view.setFloat64(base + offsets.ra_of_asc_node, record.raOfAscNodeDeg, true);
      view.setFloat64(base + offsets.arg_of_pericenter, record.argOfPericenterDeg, true);
      view.setFloat64(base + offsets.mean_anomaly, record.meanAnomalyDeg, true);
      view.setFloat64(base + offsets.bstar, record.bstar ?? 0, true);
      view.setFloat64(base + offsets.mean_motion_dot, record.meanMotionDot ?? 0, true);
      view.setFloat64(base + offsets.mean_motion_ddot, record.meanMotionDdot ?? 0, true);
      view.setUint32(base + offsets.norad_cat_id, record.noradCatId ?? 0, true);
    });
    return new Uint8Array(buffer);
  }

  initFromOmm(records) {
    const packed = this.packOmmRecords(records);
    const pointer = this.alloc(packed.byteLength);
    new Uint8Array(this.memory.buffer).set(packed, pointer);
    try {
      return this.exports.plugin_init_omm(pointer, records.length);
    } finally {
      this.free(pointer);
    }
  }

  ingestOne(record) {
    const packed = this.packOmmRecords([record]);
    const pointer = this.alloc(packed.byteLength);
    new Uint8Array(this.memory.buffer).set(packed, pointer);
    try {
      return this.exports.plugin_ingest_omm_one(pointer);
    } finally {
      this.free(pointer);
    }
  }

  /** Returns {status, state, bytes} — bytes for the byte-identity checks. */
  propagate(julianDate, entityIndex) {
    const pointer = this.alloc(ORBPRO_STATE_VECTOR.size);
    try {
      const status = this.exports.plugin_propagate(julianDate, entityIndex, pointer);
      const bytes = new Uint8Array(
        this.memory.buffer.slice(pointer, pointer + ORBPRO_STATE_VECTOR.size),
      );
      return { status, state: decodeStateVector(bytes), bytes };
    } finally {
      this.free(pointer);
    }
  }

  propagateBatch(julianDate, count) {
    const pointer = this.alloc(ORBPRO_STATE_VECTOR.size * count);
    try {
      const status = this.exports.plugin_propagate_batch(julianDate, pointer, count);
      const states = [];
      for (let index = 0; index < count; index += 1) {
        const start = pointer + index * ORBPRO_STATE_VECTOR.size;
        states.push(
          decodeStateVector(
            new Uint8Array(this.memory.buffer.slice(start, start + ORBPRO_STATE_VECTOR.size)),
          ),
        );
      }
      return { status, states };
    } finally {
      this.free(pointer);
    }
  }

  entityCount() {
    return this.exports.plugin_entity_count();
  }

  destroy() {
    this.exports.plugin_destroy();
  }
}

/** Decode a 64-byte state vector using the GENERATED offsets. */
export function decodeStateVector(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { offsets } = ORBPRO_STATE_VECTOR;
  return {
    epoch: view.getFloat64(offsets.epoch, true),
    position: [
      view.getFloat64(offsets.position + 0, true),
      view.getFloat64(offsets.position + 8, true),
      view.getFloat64(offsets.position + 16, true),
    ],
    velocity: [
      view.getFloat64(offsets.velocity + 0, true),
      view.getFloat64(offsets.velocity + 8, true),
      view.getFloat64(offsets.velocity + 16, true),
    ],
    referenceFrame: view.getUint8(offsets.reference_frame),
    // The three IDL-reserved bytes. Read them explicitly: they are part of the
    // contract, and a writer that skips them leaves the previous call behind.
    reserved: [
      view.getUint8(offsets.reference_frame + 1),
      view.getUint8(offsets.reference_frame + 2),
      view.getUint8(offsets.reference_frame + 3),
    ],
    flags: view.getUint32(offsets.flags, true),
  };
}
