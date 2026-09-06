import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing/browser";
import {
  encodeOmmPayload,
  encodeSizePrefixedStream,
} from "./lib/payloadEncoders.mjs";
import { invokePiv } from "./lib/pivInvokeHelper.mjs";

// Vallado's public SGP4 verification case 00005, also exercised by the pinned
// Tudat reference: https://github.com/DigitalArsenal/tudat-wasm/blob/
// c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/src/testSpice.cpp
// Epoch is UTC JD; native path states are TEME km and km/s. The published
// +4320-minute position is checked within 1 cm, allowing rounded reference
// coordinates. B changes only the input mean motion; it is a replacement
// identity check, not an independently validated second physical orbit.
const A = {
  noradId: 5,
  objectName: "VALLADO TEST CASE",
  objectId: "1958-002B",
  epoch: "2000-06-27T18:50:19.733568",
  meanMotion: 10.82419157,
  eccentricity: 0.1859667,
  inclination: 34.2682,
  raan: 348.7242,
  argPericenter: 331.7664,
  meanAnomaly: 19.3264,
  bstar: 0.000028098,
  meanMotionDot: 0.00000023,
  meanMotionDdot: 0,
};
const B = { ...A, meanMotion: A.meanMotion + 0.01 };
const LATER = { ...A, epoch: "2000-06-28T18:50:19.733568", meanMotion: 11 };
const EPOCH = 2451723.28495062;
const REFERENCE_POSITION = [-9060.4737357, 4658.70952502, 813.686731533];

async function createModule(t, variant) {
  const harness = await createBrowserModuleHarness({
    wasmSource: await readFile(
      new URL(`../dist/${variant}/module.wasm`, import.meta.url),
    ),
    surface: "direct",
    sharedMemory: variant === "browser-shared",
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
  });
  const module = {
    ...Object.fromEntries(
      Object.entries(harness.instance.exports).map(([name, value]) => [
        `_${name}`,
        value,
      ]),
    ),
    get HEAPU8() {
      return new Uint8Array(harness.memory.buffer);
    },
  };
  t.after(() => {
    module._plugin_destroy();
    harness.destroy();
  });
  return module;
}

function withBytes(module, bytes, callback) {
  const pointer = module._plugin_alloc(bytes.length);
  try {
    module.HEAPU8.set(bytes, pointer);
    return callback(pointer, bytes.length);
  } finally {
    module._plugin_free(pointer, bytes.length);
  }
}

function initialize(module, records) {
  const bytes = encodeSizePrefixedStream(records.map(encodeOmmPayload));
  const count = withBytes(module, bytes, (pointer, length) =>
    module._plugin_init_omm_flatbuffer_stream(pointer, length),
  );
  assert.equal(count, 1, "all records belong to one catalogue entity");
}

function append(module, record) {
  const epoch = withBytes(module, encodeOmmPayload(record), (pointer, length) =>
    module._plugin_entity_add_omm_flatbuffer(0, pointer, length),
  );
  assert.equal(epoch, EPOCH, "native append acknowledges the same epoch");
}

function ingest(module, record) {
  const result = invokePiv(module, {
    methodId: "ingest_omm",
    inputs: [
      {
        portId: "omm",
        payload: encodeOmmPayload(record),
        typeRef: { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM" },
      },
    ],
  });
  assert.equal(result.response.STATUS_CODE ?? 0, 0);
}

function currentRecord(module) {
  const pointer = module._plugin_entity_get_omm_pointer(0);
  assert.ok(pointer > 0);
  // Public OrbProOMMRecord ABI: epoch and mean motion are the first two f64s.
  return withBytes(module, new Uint8Array(88), (output) => {
    assert.equal(module._plugin_get_omm_record_by_pointer(pointer, output), 0);
    const view = new DataView(module.HEAPU8.buffer);
    return {
      pointer,
      epoch: view.getFloat64(output, true),
      meanMotion: view.getFloat64(output + 8, true),
    };
  });
}

function stateAt(module, epoch) {
  return withBytes(module, new Uint8Array(48), (pointer) => {
    assert.equal(module._plugin_propagate_path_sv(0, epoch, 0, 1, pointer), 1);
    const view = new DataView(module.HEAPU8.buffer);
    const state = Array.from({ length: 6 }, (_, i) =>
      view.getFloat64(pointer + i * 8, true),
    );
    assert.ok(state.every(Number.isFinite), "native state must stay finite");
    return state;
  });
}

function assertVallado(state) {
  REFERENCE_POSITION.forEach((value, i) =>
    assert.ok(
      Math.abs(state[i] - value) < 1e-5,
      `TEME position axis ${i} matches Vallado within 1 cm: ${state[i]} vs ${value}`,
    ),
  );
}

for (const variant of ["browser", "browser-shared"]) {
  for (const [name, update] of [
    ["native append", append],
    ["SDS PIV ingest", ingest],
  ]) {
    test(`${variant}: ${name} replaces one epoch A/B/A without stale state`, async (t) => {
      const module = await createModule(t, variant);
      initialize(module, [A]);
      const original = stateAt(module, EPOCH + 3);
      assertVallado(original);
      const originalPointer = currentRecord(module).pointer;
      update(module, B);
      assert.equal(module._plugin_entity_omm_count(0), 1);
      assert.equal(currentRecord(module).meanMotion, B.meanMotion);
      assert.notEqual(currentRecord(module).pointer, originalPointer);
      const replaced = stateAt(module, EPOCH + 3);
      assert.ok(
        Math.hypot(...replaced.slice(0, 3).map((v, i) => v - original[i])) > 1,
        "the accepted mean-motion change must move the propagated position by over 1 km",
      );
      update(module, A);
      assert.equal(currentRecord(module).meanMotion, A.meanMotion);
      assert.deepEqual(
        stateAt(module, EPOCH + 3),
        original,
        "A restoration reproduces all six original TEME components",
      );
    });
  }

  test(`${variant}: bulk initialization uses the last same-epoch record`, async (t) => {
    const module = await createModule(t, variant);
    initialize(module, [A, B]);
    assert.equal(module._plugin_entity_omm_count(0), 1);
    assert.equal(currentRecord(module).meanMotion, B.meanMotion);
    const replaced = stateAt(module, EPOCH + 3);
    initialize(module, [A, B, A]);
    assert.equal(currentRecord(module).meanMotion, A.meanMotion);
    const restored = stateAt(module, EPOCH + 3);
    assertVallado(restored);
    assert.notDeepEqual(replaced, restored);
  });

  test(`${variant}: historical epoch selection and replacement keep readout aligned`, async (t) => {
    const module = await createModule(t, variant);
    initialize(module, [A, LATER]);
    const laterState = stateAt(module, EPOCH + 1);
    assert.equal(currentRecord(module).meanMotion, LATER.meanMotion);
    const earlierState = stateAt(module, EPOCH);
    assert.equal(currentRecord(module).meanMotion, A.meanMotion);
    assert.equal(currentRecord(module).epoch, EPOCH);
    append(module, B);
    assert.equal(currentRecord(module).meanMotion, B.meanMotion);
    assert.notDeepEqual(stateAt(module, EPOCH), earlierState);
    assert.deepEqual(
      stateAt(module, EPOCH + 1),
      laterState,
      "replacing the earlier orbit preserves the later one",
    );
    assert.equal(currentRecord(module).meanMotion, LATER.meanMotion);
    append(module, A);
    assert.equal(
      currentRecord(module).meanMotion,
      LATER.meanMotion,
      "updating inactive history does not replace active metadata",
    );
    assert.deepEqual(stateAt(module, EPOCH), earlierState);
    assert.equal(currentRecord(module).meanMotion, A.meanMotion);
    assert.equal(module._plugin_entity_omm_count(0), 2);
  });

  test(`${variant}: interpolated and out-of-range queries expose the selected bracket record`, async (t) => {
    const module = await createModule(t, variant);
    initialize(module, [A, LATER]);
    assert.equal(module._plugin_entity_set_mode(0, 1), 0);
    for (const [offset, record] of [
      [-1, A],
      [0.25, A],
      [0.75, LATER],
      [2, LATER],
      [-1, A],
    ]) {
      stateAt(module, EPOCH + offset);
      assert.equal(currentRecord(module).meanMotion, record.meanMotion);
      assert.equal(
        currentRecord(module).epoch,
        record === A ? EPOCH : EPOCH + 1,
      );
    }
  });

  test(`${variant}: adaptive paths update active OMM metadata with the sampled orbit`, async (t) => {
    const module = await createModule(t, variant);
    initialize(module, [A, LATER]);
    assert.equal(currentRecord(module).meanMotion, LATER.meanMotion);
    withBytes(module, new Uint8Array(24), (pointer) => {
      assert.equal(
        module._plugin_propagate_path_adaptive(
          0,
          EPOCH,
          EPOCH + 0.01,
          EPOCH,
          360,
          0,
          1,
          1,
          pointer,
        ),
        1,
      );
      const view = new DataView(module.HEAPU8.buffer);
      for (let i = 0; i < 3; i++)
        assert.ok(Number.isFinite(view.getFloat64(pointer + i * 8, true)));
    });
    assert.equal(currentRecord(module).meanMotion, A.meanMotion);
  });
}
