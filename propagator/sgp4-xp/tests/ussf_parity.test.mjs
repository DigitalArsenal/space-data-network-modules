// The merged module against the Space Force library's own JavaScript runtime.
//
// The library (third_party/ussf-sgp4/Sgp4Prop.xp.wasm) is an Emscripten build: nine imports from the Emscripten runtime,
// answered in the JavaScript that ships with it (Sgp4Prop.xp.js). The module has no JavaScript: build.mjs joins the same
// wasm to the SDN code with wasm-merge and src/shim.wat answers the imports. What that has to preserve is every number
// the library returns, so the reference here is the library run by its own runtime, on the same two-line sets, and the
// comparison is exact: the same doubles, not agreement to a tolerance.
//
// Sets: 640 valid element sets (SGP4, type 0, and SGP4-XP, type 4, alternately) in low, sun-synchronous, medium, geosynchronous
// and highly eccentric orbits, each at seven times from -12 h to 7 days from its epoch, all through one module instance. A
// set the library refuses at some time is one the module must refuse too, by name. The library keeps about 29 KB of every
// SGP4-XP satellite it has propagated, so the module restores the library's memory to its starting state every 256 of
// them (Library::recycle in src/ussf.hpp); 320 XP sets in one instance cross that more than once, and every set after
// the first restoration is compared exactly like the first.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './lib/module.mjs';
import { battery, omm as ommOfLines, referenceLibrary } from './lib/tle.mjs';
import { blockLines, frame, ommBytes, oemBytes, readOem } from './lib/sds.mjs';

const MINUTES = [0, 90, 360, 1440, 4320, 10080, -720];
const SETS = 640;

// The epoch of a set as the micro-second text the module reads, and `minutes` later in the same text.
function epochs(fields) {
  const [whole, micro] = fields.epoch.split('.');
  const base = Date.parse(`${whole}Z`);
  return MINUTES.map((m) => `${new Date(base + m * 60000).toISOString().slice(0, 19)}.${micro}Z`);
}

test('the module returns the Space Force library\'s states exactly, SGP4 and SGP4-XP, on 640 sets across the library\'s restorations', async () => {
  const module = await loadModule();
  const reference = await referenceLibrary();
  let compared = 0, refusedBoth = 0, xp = 0, sgp4 = 0;
  try {
    for (const set of battery(SETS, 20261011)) {
      const fields = ommOfLines(set.lines, { norad: 10000 + set.index });
      const want = reference.propagate(set.lines, MINUTES);
      const grid = oemBytes({ blocks: [{ frame: 'TEMEOFDATE', lines: epochs(fields).map((epoch) => ({ epoch })) }] });
      const response = await module.refused('propagate', [frame('omm', 'OMM', ommBytes(fields)), frame('grid', 'OEM', grid)]);
      const libraryRefused = want === null || want.some((state) => state.error !== 0);
      if (libraryRefused) {
        assert.notEqual(response.statusCode, 0, `set ${set.index}: the library refuses it, the module must too`);
        assert.match(response.errorCode, /^(element-set-refused|propagation-failed)$/, `set ${set.index}: ${response.errorCode}`);
        refusedBoth += 1;
        continue;
      }
      assert.equal(response.statusCode, 0, `set ${set.index}: ${response.errorCode}: ${response.errorMessage}`);
      const got = blockLines(readOem(new Uint8Array(response.outputs[0].payload)).EPHEMERIS_DATA_BLOCK[0]);
      assert.equal(got.length, MINUTES.length);
      got.forEach((state, i) => {
        assert.deepEqual(state.r, want[i].r, `set ${set.index} (type ${set.type}) position at ${MINUTES[i]} min`);
        assert.deepEqual(state.v, want[i].v, `set ${set.index} (type ${set.type}) velocity at ${MINUTES[i]} min`);
      });
      compared += 1;
      if (set.type === 4) xp += 1; else sgp4 += 1;
    }
  } finally {
    await module.destroy();
  }
  // The library propagates nearly every set at every time; the few it refuses (decayed highly eccentric orbits) the module refuses too.
  assert.ok(compared >= SETS * 0.95, `only ${compared} sets compared`);
  assert.ok(xp >= 300 && sgp4 >= 300, `${xp} XP and ${sgp4} SGP4 sets compared`);
  assert.ok(compared + refusedBoth === SETS);
});
