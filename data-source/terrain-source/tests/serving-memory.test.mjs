// A SERVING INSTANCE'S RESIDENT MEMORY IS BOUNDED BY THE NUMBER ITS OWN
// DEPLOYMENT CONFIG STATES.
//
// route() is O(1) in the availability index because serving_config() reads the
// config ONCE per instance and keeps the parsed rectangles. That is the right
// lifetime and it is what made route flat — but it moves the index out of the
// request and into the instance, so resident memory now scales with
// `terrain_available` rather than with what the instance is being asked.
//
// Nothing in this lane named a memory bound. The host default is 1024 pages
// (sdn-server/internal/flowrt/httpmount.go: `pages := deps.MaxMemoryPages; if
// pages == 0 { pages = 1024 }`), the ship configuration Hermes ruled is a
// global z11 index of several megabytes, and MEASURED on the shipped artifact
// that lands at 1138 pages for a 7.76 MB index — over the default, on a
// four-instance pool, with nothing in the lane to notice.
//
// So the pyramid run now WRITES `memory_pages` into the layer-json config a
// deployment consumes, from the measured curve in
// tools/terrain-pyramid/memory-pages.mjs. This asserts the two halves agree:
// that a real instance, driven the way the mount drives it, stays under the
// number that file would have the config state. Both read the same module, so
// the recommendation and the check cannot drift apart.
//
// It also asserts the other half of the bound, the one that was already true
// and has to stay true: at a FIXED index, memory does not grow with requests.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";

import { memoryPagesFor, HOST_DEFAULT_PAGES } from "../../../tools/terrain-pyramid/memory-pages.mjs";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));

// Shaped like a real index: every level from 0, the deep one carrying the
// rectangles. The addresses below are inside it at every size.
function availabilityOfSize(bytes) {
  const levels = [];
  for (let z = 0; z <= 11; z++) {
    levels.push([{ startX: 0, startY: 0, endX: 2 ** (z + 1) - 1, endY: 2 ** z - 1 }]);
  }
  const deep = levels[11];
  const filler = Math.max(0, Math.round(bytes / 48) - 12);
  for (let i = 0; i < filler; i++) {
    deep.push({ startX: 4000 + (i % 90), startY: 1000 + (i % 90), endX: 4001 + (i % 90), endY: 1001 + (i % 90) });
  }
  return levels;
}

const req = (path) => ({
  portId: "request",
  typeRef: HTTP_REQUEST_TYPE_REF,
  payload: encodeHttpRequest({ method: "GET", path, query: "", headers: {} }),
});

const planFrame = (value) => {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  return {
    portId: "plan",
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
};

// Everything the mount makes an instance do with its index: resolve a tile
// address, resolve layer.json, render layer.json, and then keep serving a mix
// of all of them. The MIX matters — each request shape on its own settles at a
// lower number than they do interleaved, because the peak is a high-water mark
// across shapes and not a per-shape cost.
async function driveInstance(t, available, soakRequests = 1200) {
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
  const pages = () => harness.memory.buffer.byteLength >>> 16;
  const paths = [
    "/api/v1/terrain/8/271/192.terrain",
    "/api/v1/terrain/11/2159/1525.terrain",
    "/api/v1/terrain/layer.json",
    "/api/v1/terrain/3/1/1.terrain",
    "/api/v1/terrain/nonsense",
  ];
  await harness.invoke({ methodId: "route", inputs: [req(paths[0])] });
  await harness.invoke({ methodId: "route", inputs: [req(paths[2])] });
  await harness.invoke({
    methodId: "layer_json",
    inputs: [planFrame({ tilesetId: "spaceaware-terrain", maxzoom: 11, available })],
  });
  for (let i = 0; i < soakRequests; i++) {
    await harness.invoke({ methodId: "route", inputs: [req(paths[i % paths.length])] });
  }
  return { harness, pages, paths };
}

test("the mount config's memory_pages bounds what a real instance actually takes", async (t) => {
  const measured = [];
  for (const targetBytes of [45, 320_000, 2_500_000, 7_700_000]) {
    const available =
      targetBytes < 100 ? [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]] : availabilityOfSize(targetBytes);
    const bytes = Buffer.byteLength(JSON.stringify(available));
    const { pages } = await driveInstance(t, available);
    const took = pages();
    const stated = memoryPagesFor(bytes);
    measured.push({ bytes, took, stated });
    assert.ok(
      took <= stated,
      `a ${(bytes / 1e6).toFixed(2)} MB index peaked at ${took} pages; the config states ${stated}`,
    );
  }
  // …and the recommendation is not simply enormous: it has to be a number a
  // deployment would actually write, not "always the maximum".
  for (const m of measured) {
    assert.ok(
      m.stated <= m.took + 512,
      `${(m.bytes / 1e6).toFixed(2)} MB: stated ${m.stated} pages against ${m.took} measured — ` +
        "a recommendation with no relationship to the measurement is not a bound",
    );
  }
  // THE POINT OF THE WHOLE FILE: at the ruled ship scale the host default is
  // not enough, so the deployment MUST set the key rather than inherit 1024.
  const shipScale = measured[measured.length - 1];
  assert.ok(
    shipScale.stated > HOST_DEFAULT_PAGES,
    `a ${(shipScale.bytes / 1e6).toFixed(2)} MB index needs ${shipScale.stated} pages against a ` +
      `${HOST_DEFAULT_PAGES}-page host default — if this ever stops being true the config key can go`,
  );
});

test("the peak is a HIGH-WATER MARK, not a leak: it stops moving and stays stopped", async (t) => {
  // The distinction this file has to keep straight. Memory scaling with the
  // INDEX is bounded, proportional growth that a config number can cover.
  // Memory scaling with REQUESTS would be a leak, and no config number could.
  // Measured here rather than assumed: the mixed shape reaches its mark inside
  // the first ~1,200 requests and does not move over the next 6,000.
  const available = availabilityOfSize(2_500_000);
  const { harness, pages, paths } = await driveInstance(t, available);
  const mark = pages();
  for (let i = 0; i < 6_000; i++) {
    await harness.invoke({ methodId: "route", inputs: [req(paths[i % paths.length])] });
  }
  assert.equal(pages(), mark, `6,000 further mixed requests moved the instance off ${mark} pages`);
  assert.ok(
    mark <= memoryPagesFor(Buffer.byteLength(JSON.stringify(available))),
    "and the mark is still inside what the config states",
  );
});
