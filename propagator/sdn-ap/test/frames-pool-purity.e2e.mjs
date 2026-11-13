#!/usr/bin/env node
// Synthetic UTC records, TEME km/km/s and Earth-fixed m/m/s. Reference instances follow
// the same theory-call history; only the tested instance builds frames between calls.
// All states and statuses require exact IEEE equality, including SGP4 and stock SGP4XP.
import assert from "node:assert/strict";
import { openFrames, population, ocmOfObject, EPOCH_MS, DAY } from "./lib/frame-cells.mjs";
import { repackOcm } from "./lib/ocm.mjs";
const pop = population([["leo500", 64], ["geo", 16], ["leo830", 16]], 20261113, 48);
const records = pop.map((o, i) => i < 64 ? ocmOfObject(o) : i < 80 ? ocmOfObject(o, false) : repackOcm(ocmOfObject(o, false), t => {
  t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = 0; t.MEAN_ELEMENTS.BSTAR = 1e-4; t.ORB_AVERAGING = "KOZAI";
}));
for (const threads of [0, 4, 15]) {
  const a = await openFrames({ threads }), b = await openFrames({ threads });
  await a.load(pop, records); await b.load(pop, records); b.open(2e6);
  let framesPoolRows = 0;
  for (const days of [0, 1, -1, 2]) {
    const t = EPOCH_MS + days * DAY + 3600000, before = b.poolStats()[14];
    assert.equal(b.fill(t, 2880, 32).due, 0); framesPoolRows += b.poolStats()[14] - before;
    assert.ok(b.at(t).status.slice(64).every(s => s === 2));
    for (const frame of [0, 3]) assert.deepEqual(b.epochsAt(t, frame), a.epochsAt(t, frame));
    for (let i = 0; i < pop.length; ++i) assert.deepEqual(b.ap(i, t + 37000), a.ap(i, t + 37000));
  }
  if (threads) assert.ok(framesPoolRows > 0);
  await a.h.destroy(); await b.h.destroy();
}
console.log("FRAMES-POOL-PURITY PASS: AP, SGP4, SGP4XP unchanged at 0/4/15 threads across four clock histories");
