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
// So the pyramid run now WRITES `memory_pages` onto the MOUNT ENTRY a
// deployment installs (tools/terrain-pyramid/out/<run>/mount-entry.json — the
// level the daemon actually reads, a sibling of `config:` and never a member of
// it), from the measured curve in tools/terrain-pyramid/memory-pages.mjs. This
// asserts the two halves agree: that a real instance, driven the way the mount
// drives it — BOTH invokes of the serving pair and BOTH content codings — stays
// under the number that file would have the deployment state. Both read the
// same module, so the recommendation and the check cannot drift apart.
//
// It also asserts the other half of the bound, the one that was already true
// and has to stay true: at a FIXED index, memory does not grow with requests.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";

import { buildGeoTiff } from "./helpers.mjs";
import { memoryPagesFor, HOST_DEFAULT_PAGES } from "../../../tools/terrain-pyramid/memory-pages.mjs";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

const frame = (portId, payload) => {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
};
const req = (path, headers = {}) => ({
  portId: "request",
  typeRef: HTTP_REQUEST_TYPE_REF,
  payload: encodeHttpRequest({ method: "GET", path, query: "", headers }),
});
const planFrame = (value) => frame("plan", JSON.stringify(value));

// ── THE STORED RECORD THE MOUNT'S SECOND INVOKE IS GIVEN ────────────────────
//
// Built ONCE on a throwaway instance, because `tile` decodes a GeoTIFF and that
// allocation is not part of what a serving instance does — an instance that had
// encoded its own fixture would carry a decode buffer no mount ever asks for
// and would measure the wrong thing. What ships to the serving instance is the
// $DTT stream, exactly as the flatsql-query node hands it over.
const STORED_ADDRESS = { level: 8, x: 271, y: 192 };
let storedStream = null;
async function storedRecordStream() {
  if (storedStream) return storedStream;
  const harness = await createBrowserModuleHarness({
    wasmSource: WASM,
    manifest: MANIFEST,
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return { terrain_tileset_id: "spaceaware-terrain" };
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  try {
    const tiff = buildGeoTiff({
      width: 64,
      height: 64,
      originLon: 10.5,
      originLat: 45.8,
      scaleLon: 0.8 / 63,
      scaleLat: 0.9 / 63,
      heightFn: (px, py) => 100 + px + 2 * py,
    });
    const result = await harness.invoke({
      methodId: "tile",
      inputs: [
        planFrame({
          tilesetId: "spaceaware-terrain",
          ...STORED_ADDRESS,
          gridSize: 33,
          maxLevel: 8,
          childAvailability: 0,
          provenance: {
            datasetId: "cop-dem-glo-30",
            datasetEpoch: "2023-04-01T00:00:00.000Z",
            retrievedAt: "2026-08-15T12:00:00.000Z",
            license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
          },
        }),
        frame("dem", encoder.encode(JSON.stringify({ status: 200, headers: {}, bodyB64: Buffer.from(tiff).toString("base64") }))),
      ],
    });
    const records = result.outputs.find((o) => o.portId === "records");
    storedStream = new Uint8Array(records.payload);
    return storedStream;
  } finally {
    harness.destroy();
  }
}

// ── THE MIX IS THE MOUNT'S OWN, NOT HALF OF IT ─────────────────────────────
//
// This used to drive `route` and one `layer_json` render and nothing else. That
// omits the mount's SECOND invoke: flows/terrain-serving.flow.json wires
// terrain-source:route -> hostcap/flatsql-query -> terrain-source:respond inside
// ONE flow, i.e. one linear memory, and respond is where the record bytes, the
// synthesized mesh and the gzip/identity representations are built. It also
// omits the identity representation entirely — and MEASURED on the shipped
// artifact at a 7.76 MB index, adding `accept-encoding: identity` on one request
// in three took the same instance from 1,493 pages to 1,848, i.e. 56 pages OVER
// the number the old fit would have had a deployment write down. `memory_pages`
// is a HARD cap in the host (httpmount.go -> wasmrt.WithMaxMemoryPages), so
// being 56 pages short is memory.grow returning -1 inside the guest on request
// twelve.
//
// So the mix here is the real pair, both encodings, interleaved:
//   route -> respond           over a STORED record (the 200 path, real bytes)
//   route -> respond           over an empty stream inside availability (synth)
//   route -> layer_json        (the index render, the biggest single allocation)
//   route                      on a junk path (the cheap 404)
// with one request in three asking for `identity`, which is what actually
// forces the uncompressed representation into memory.
async function driveInstance(t, available, soakRequests = 1200) {
  const stored = await storedRecordStream();
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
  // FALSIFIABILITY. This file's whole defect last round was that it drove half
  // the mount while claiming to bound it, and nothing in it could tell. The
  // counters are asserted below, so a mix that quietly degrades to route-only
  // fails the test instead of passing it with a smaller number.
  const invoked = { route: 0, respond: 0, layer_json: 0, identity: 0 };

  const shapes = [
    { path: `/api/v1/terrain/${STORED_ADDRESS.level}/${STORED_ADDRESS.x}/${STORED_ADDRESS.y}.terrain`, stream: () => stored },
    { path: "/api/v1/terrain/11/2159/1525.terrain", stream: () => new Uint8Array(4) },
    { path: "/api/v1/terrain/layer.json", stream: null },
    { path: "/api/v1/terrain/3/1/1.terrain", stream: () => new Uint8Array(4) },
    { path: "/api/v1/terrain/nonsense", stream: null },
  ];

  // ONE request through the mount: route first, then whichever second invoke
  // route's own answer selects — exactly what the flow does.
  async function serve(shape, identity) {
    const headers = identity ? { "accept-encoding": "identity" } : { "accept-encoding": "gzip" };
    if (identity) invoked.identity += 1;
    invoked.route += 1;
    const routed = await harness.invoke({ methodId: "route", inputs: [req(shape.path, headers)] });
    const context = routed.outputs.find((o) => o.portId === "context");
    const plan = routed.outputs.find((o) => o.portId === "layer_plan");
    if (plan) {
      invoked.layer_json += 1;
      await harness.invoke({ methodId: "layer_json", inputs: [frame("plan", new Uint8Array(plan.payload))] });
      return;
    }
    if (!context || !shape.stream) return; // a 404 route answered by itself
    invoked.respond += 1;
    await harness.invoke({
      methodId: "respond",
      inputs: [frame("stream", shape.stream()), frame("context", new Uint8Array(context.payload))],
    });
  }

  for (const shape of shapes) await serve(shape, false);
  for (let i = 0; i < soakRequests; i++) await serve(shapes[i % shapes.length], i % 3 === 0);
  return { harness, pages, serve, shapes, invoked };
}

test("the mount config's memory_pages bounds what a real instance actually takes", async (t) => {
  const measured = [];
  for (const targetBytes of [45, 320_000, 2_500_000, 7_700_000]) {
    const available =
      targetBytes < 100 ? [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]] : availabilityOfSize(targetBytes);
    const bytes = Buffer.byteLength(JSON.stringify(available));
    const { pages, invoked } = await driveInstance(t, available);
    // The mix really was the mount's, not half of it.
    assert.ok(invoked.respond > 300, `respond ran ${invoked.respond} times, not a token few`);
    assert.ok(invoked.layer_json > 200, `layer_json ran ${invoked.layer_json} times`);
    assert.ok(invoked.identity > 300, `identity was asked for ${invoked.identity} times`);
    const took = pages();
    const stated = memoryPagesFor(bytes);
    measured.push({ bytes, took, stated });
    assert.ok(
      took <= stated,
      `a ${(bytes / 1e6).toFixed(2)} MB index peaked at ${took} pages; the config states ${stated}`,
    );
  }
  // …and the recommendation is not simply enormous: it has to be a number a
  // deployment would actually write, not "always the maximum". The band is
  // PROPORTIONAL rather than a flat 512 pages, and deliberately wide on the
  // upper side: an independent harness measured 1,848 pages at 7.76 MB against
  // 1,619 here at a larger index, so the fit is set above the higher of two
  // real measurements that disagree by 355 pages and cannot also sit within
  // half a megabyte of the lower one. What it must not do is drift into "just
  // ask for everything".
  for (const m of measured) {
    assert.ok(
      m.stated >= m.took * 1.1,
      `${(m.bytes / 1e6).toFixed(2)} MB: stated ${m.stated} pages against ${m.took} measured — ` +
        "a bound with no headroom is a bound that fails on another allocation order",
    );
    assert.ok(
      m.stated <= m.took * 1.6 + 384,
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
  const { pages, serve, shapes } = await driveInstance(t, available);
  const mark = pages();
  for (let i = 0; i < 3_000; i++) await serve(shapes[i % shapes.length], i % 3 === 0);
  assert.equal(pages(), mark, `3,000 further mixed pair requests moved the instance off ${mark} pages`);
  assert.ok(
    mark <= memoryPagesFor(Buffer.byteLength(JSON.stringify(available))),
    "and the mark is still inside what the config states",
  );
});
