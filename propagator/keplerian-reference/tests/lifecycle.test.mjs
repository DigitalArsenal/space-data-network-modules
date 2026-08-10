/**
 * The lifecycle leak test — ABI §11.
 *
 * BOTH shipped first-party propagators fail this today: `destroySource()` is
 * literally `{}` in each of them (official-harness-shapes finding §4.5). This
 * module passes it, and that is deliberate — W1.2's job is to set the bar that
 * W1.5 brings the first-party propagators up to, not to wait for them.
 *
 * How a leak is measured honestly: WebAssembly linear memory NEVER SHRINKS, so
 * "memory went back down" is not available and any test asserting it would be
 * asserting something impossible. What a non-leaking module gives you instead
 * is that growth STOPS: after a warm-up that pays for every allocation the
 * cycle will ever need, N further identical cycles must add ZERO pages. A
 * module that leaks one allocation per cycle grows without bound and fails.
 *
 * The test carries its own negative control: it demonstrates that the metric
 * can move at all, by growing memory deliberately and observing the change. A
 * leak test that would pass a leaking module is worse than none.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ErrorCode, loadModule } from "./harness.mjs";

const ELEMENTS = {
  epochJd: 2460000.5,
  meanMotionRevPerDay: 15.5,
  eccentricity: 0.0006703,
  inclinationDeg: 51.64,
  raOfAscNodeDeg: 208.9163,
  argOfPericenterDeg: 30.8756,
  meanAnomalyDeg: 329.2838,
  noradCatId: 25544,
};

/** One complete lifecycle: ingest, use, destroy. */
function cycle(propagator, entityCount) {
  const records = Array.from({ length: entityCount }, (_, index) => ({
    ...ELEMENTS,
    noradCatId: 25544 + index,
    meanAnomalyDeg: (ELEMENTS.meanAnomalyDeg + index) % 360,
  }));

  const ingested = propagator.initFromOmm(records);
  assert.equal(ingested, entityCount, "ingest did not accept every record");

  const batch = propagator.propagateBatch(ELEMENTS.epochJd + 0.01, entityCount);
  assert.equal(batch.status, ErrorCode.OK, "propagate_batch failed mid-cycle");

  propagator.destroy();
  assert.equal(
    propagator.entityCount(),
    0,
    "destroy left entities behind — the module is holding state it said it released",
  );
}

test("N x ingest/propagate/destroy returns to a steady memory baseline", async () => {
  const propagator = await loadModule();
  const ENTITIES = 256;

  // Warm-up: pay for every allocation the steady state will ever need.
  for (let i = 0; i < 20; i += 1) cycle(propagator, ENTITIES);

  const baselineBytes = propagator.memory.buffer.byteLength;

  // The measurement window.
  const CYCLES = 200;
  for (let i = 0; i < CYCLES; i += 1) cycle(propagator, ENTITIES);

  const finalBytes = propagator.memory.buffer.byteLength;
  const growth = finalBytes - baselineBytes;

  assert.equal(
    growth,
    0,
    `linear memory grew by ${growth} bytes across ${CYCLES} identical ` +
      `ingest/propagate/destroy cycles (baseline ${baselineBytes}, final ${finalBytes}). ` +
      `A module whose destroy is real reaches a steady state; growth that continues after ` +
      `warm-up is a leak of roughly ${(growth / CYCLES).toFixed(1)} bytes per cycle.`,
  );
});

test("destroy is idempotent and leaves the module usable", async () => {
  const propagator = await loadModule();

  propagator.destroy();
  propagator.destroy();
  assert.equal(propagator.entityCount(), 0);

  // A destroyed module must refuse to propagate rather than read freed state.
  assert.equal(propagator.propagate(ELEMENTS.epochJd, 0).status, ErrorCode.NOT_INITIALIZED);

  // And it must come back cleanly.
  assert.equal(propagator.initFromOmm([ELEMENTS]), 1);
  assert.equal(propagator.propagate(ELEMENTS.epochJd, 0).status, ErrorCode.OK);
});

test("NEGATIVE CONTROL — the leak metric can actually move", async () => {
  const propagator = await loadModule();

  for (let i = 0; i < 20; i += 1) cycle(propagator, 256);
  const baselineBytes = propagator.memory.buffer.byteLength;

  // Deliberately leak: allocate without freeing, in the same module, until the
  // allocator must ask for more pages. If this does NOT move the number the
  // steady-state test reads, that test is measuring nothing.
  let leaked = 0;
  while (propagator.memory.buffer.byteLength === baselineBytes) {
    propagator.alloc(1 << 16);
    leaked += 1;
    assert.ok(leaked < 100000, "allocating 64 KiB blocks never grew linear memory");
  }

  assert.ok(
    propagator.memory.buffer.byteLength > baselineBytes,
    "linear memory did not grow even under a deliberate leak",
  );
});
