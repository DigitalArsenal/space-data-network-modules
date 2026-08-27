// ROUTE COST IS INDEPENDENT OF THE AVAILABILITY INDEX'S SIZE.
//
// route() used to cost time linear in `terrain_available`. Measured warm on one
// instance, same address, p50 over 300 invokes (60 above 408 KB) on the shipped
// artifact: 0.054 ms at a 45-byte index, 0.210 ms at 11 KB, 4.668 ms at 408 KB,
// 66.264 ms at 5.9 MB, 104.553 ms at 9.3 MB. At the configuration ruled for
// ship — a global z11 availability index of several megabytes — that is 15-18
// tile requests per second per instance, against an acceptance bound of dozens
// of tiles per camera pose per client, and it was paid before the store was
// even touched.
//
// Caching the PARSE (which the module already did) moved that by ~5%, because
// the parse was never the cost: an independent A/B at 4.4 MB with the same
// bytes parked in a key NOTHING reads still cost 5.96 ms per request. The cost
// was the config crossing the host boundary on every invoke, the whole-buffer
// scans that walk past the value looking for later keys, and the memcmp that
// keyed the cache — all of it linear in a quantity that has nothing to do with
// the request being answered.
//
// The config is read ONCE per instance now and everything derived from it is
// derived once with it, so what is asserted here is the shape of the curve
// rather than an absolute number that would only measure this laptop: the p50
// at 6.9 MB must sit inside a small multiple of the p50 at 45 bytes.
//
// Coordinator 2026-08-27: "route() must be O(log n) or O(1) in the
// availability-index size per request ... measure at 45 B / 9.7 KB / 318 KB /
// 6.9 MB."

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));

// An availability index of approximately `bytes` bytes, shaped like a real one:
// levels 0..11, the deep levels carrying many rectangles. The ADDRESS the
// requests below use is inside it at every size, so a larger index never means
// a shorter walk.
function availabilityOfSize(bytes) {
  const levels = [];
  for (let z = 0; z <= 11; z++) {
    levels.push([{ startX: 0, startY: 0, endX: 2 ** (z + 1) - 1, endY: 2 ** z - 1 }]);
  }
  const deep = levels[11];
  // One rectangle is ~48 bytes of JSON.
  const filler = Math.max(0, Math.round(bytes / 48) - 12);
  for (let i = 0; i < filler; i++) {
    deep.push({ startX: 4000 + (i % 90), startY: 1000 + (i % 90), endX: 4001 + (i % 90), endY: 1001 + (i % 90) });
  }
  return levels;
}

const REQUEST = {
  portId: "request",
  typeRef: HTTP_REQUEST_TYPE_REF,
  payload: encodeHttpRequest({
    method: "GET",
    path: "/api/v1/terrain/8/271/192.terrain",
    query: "",
    headers: {},
  }),
};

async function p50RouteMs(t, availableBytes, invokes, { available: given, path } = {}) {
  const available = given ?? availabilityOfSize(availableBytes);
  const config = {
    terrain_tileset_id: "spaceaware-terrain",
    terrain_maxzoom: 11,
    terrain_available: available,
    terrain_version: "1.0.0",
  };
  const actualBytes = JSON.stringify(available).length;
  const request = path
    ? {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({ method: "GET", path, query: "", headers: {} }),
      }
    : REQUEST;
  const harness = await createBrowserModuleHarness({
    wasmSource: WASM,
    manifest: MANIFEST,
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());

  // Warm: the first invoke is the one that pays for the config, by design.
  const first = await harness.invoke({ methodId: "route", inputs: [request] });
  assert.equal(first.statusCode, 0, `${first.errorCode}: ${first.errorMessage}`);
  assert.ok(
    first.outputs.some((o) => o.portId === "query"),
    "the address must be INSIDE availability at every size, or a bigger index would mean a shorter walk",
  );

  const samples = [];
  for (let i = 0; i < invokes; i++) {
    const started = process.hrtime.bigint();
    const response = await harness.invoke({ methodId: "route", inputs: [request] });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    assert.equal(response.statusCode, 0);
  }
  samples.sort((a, b) => a - b);
  return { p50: samples[Math.floor(samples.length / 2)], bytes: actualBytes };
}

test("route cost does not track the availability index's size", async (t) => {
  // The module's own 45-byte default, measured at the only address it
  // contains. Kept separate from the curve below because it walks one level
  // rather than twelve, and comparing different walk DEPTHS would measure
  // something other than index size.
  const bare = await p50RouteMs(t, 0, 300, {
    available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
    path: "/api/v1/terrain/0/0/0.terrain",
  });
  assert.equal(bare.bytes, 45, "the module's literal default index");
  console.log(`[route-cost] index ${bare.bytes} B (the default) -> p50 ${bare.p50.toFixed(4)} ms`);

  // The curve: ONE address, one walk depth, four orders of magnitude of index.
  const sizes = [500, 9_700, 318_000, 6_900_000];
  const measured = [];
  for (const size of sizes) {
    measured.push(await p50RouteMs(t, size, size > 400_000 ? 120 : 300));
  }
  for (const m of measured) {
    console.log(`[route-cost] index ${m.bytes.toLocaleString()} B -> p50 ${m.p50.toFixed(4)} ms`);
  }

  const [smallest] = measured;
  const largest = measured[measured.length - 1];
  assert.ok(largest.bytes > 6_000_000, `the largest index must really be megabytes: ${largest.bytes}`);

  // The bound is a RATIO, not a number of milliseconds: an absolute threshold
  // would measure this machine. Before the fix this ratio was ~2,000x
  // (0.054 ms -> 104 ms across four orders of magnitude of index); a constant
  // -cost route leaves only harness noise, and 4x is generous room for it.
  const ratio = largest.p50 / smallest.p50;
  console.log(`[route-cost] largest / smallest ratio ${ratio.toFixed(2)}x`);
  assert.ok(
    ratio < 4,
    `route p50 grew ${ratio.toFixed(2)}x from a 0.5 KB index to a 7 MB one — the cost still tracks the index`,
  );

  // …and monotonic blow-up is refused at every step, not only end to end.
  for (let i = 1; i < measured.length; i++) {
    const step = measured[i].p50 / smallest.p50;
    assert.ok(
      step < 4,
      `index ${measured[i].bytes} B cost ${step.toFixed(2)}x the smallest index's p50`,
    );
  }
});

test("layer.json renders ONCE per config, so a revalidation is not a re-render", async (t) => {
  // The other half of the same defect: layer.json is a pure function of the
  // mount's config, and rendering + hashing + gzipping a 4.4 MB body on every
  // request is 168 ms of guest CPU that one anonymous 40-byte GET can buy.
  const available = availabilityOfSize(2_000_000);
  const config = {
    terrain_tileset_id: "spaceaware-terrain",
    terrain_maxzoom: 11,
    terrain_available: available,
    terrain_version: "1.0.0",
  };
  const harness = await createBrowserModuleHarness({
    wasmSource: WASM,
    manifest: MANIFEST,
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());

  const layerRequest = {
    portId: "request",
    typeRef: HTTP_REQUEST_TYPE_REF,
    payload: encodeHttpRequest({ method: "GET", path: "/api/v1/terrain/layer.json", query: "", headers: {} }),
  };
  const render = async () => {
    const routed = await harness.invoke({ methodId: "route", inputs: [layerRequest] });
    assert.equal(routed.statusCode, 0);
    const plan = routed.outputs.find((o) => o.portId === "layer_plan");
    const started = process.hrtime.bigint();
    const rendered = await harness.invoke({
      methodId: "layer_json",
      inputs: [{ portId: "plan", typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: plan.payload.byteLength }, payload: plan.payload }],
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(rendered.statusCode, 0, `${rendered.errorCode}: ${rendered.errorMessage}`);
    return ms;
  };

  const cold = await render();
  const warm = [];
  for (let i = 0; i < 5; i++) warm.push(await render());
  warm.sort((a, b) => a - b);
  const warmP50 = warm[2];
  console.log(`[route-cost] layer.json cold ${cold.toFixed(3)} ms, warm p50 ${warmP50.toFixed(3)} ms`);
  assert.ok(
    warmP50 < cold,
    `a repeat render (${warmP50.toFixed(3)} ms) must not cost what the first one did (${cold.toFixed(3)} ms)`,
  );
});
