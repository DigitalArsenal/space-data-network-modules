// HOW MUCH LINEAR MEMORY A SERVING INSTANCE NEEDS, AS A FUNCTION OF THE INDEX
// IT IS CONFIGURED WITH.
//
// route() is O(1) in the availability index now, because serving_config() reads
// the config ONCE per instance and keeps the parsed rectangles. That is the
// right lifetime and the right cost — but it moves the index out of the request
// and into the instance, so an instance's resident memory scales with
// `terrain_available` instead of with what it is being asked.
//
// The host default is 1024 pages (64 MiB): sdn-server/internal/flowrt/
// httpmount.go, `pages := deps.MaxMemoryPages; if pages == 0 { pages = 1024 }`.
// Nothing in the terrain lane named `memory_pages` — the ship plan listed the
// mount's config keys as tileset_id / dataset_epoch / terrain_available /
// licence / attribution and no memory key at all — so the configuration Hermes
// ruled (global z11) would have been deployed against an unraised default, on a
// pool of four instances, with nothing in the lane able to notice.
//
// MEASURED on the shipped artifact (dist/isomorphic/module.wasm), one instance,
// pages = memory.buffer.byteLength >>> 16, at the HIGH-WATER MARK of the mix
// the mount actually drives — one route() on a tile address, one on
// layer.json, one layer.json render, then 1,200 interleaved route() calls over
// a stored address, a deep address, layer.json, a shallow address and a junk
// path. The mix is the measurement: each shape ALONE settles lower (a
// tile-only instance at a 2.8 MB index sits at 343 pages), and a config sized
// from a single shape would be under the real peak.
//
//     index bytes    peak pages    MiB
//         45 B           256        16.0
//       0.36 MB          256        16.0
//       1.35 MB          312        19.5
//       2.81 MB          558        34.9
//       5.63 MB         1034        64.6     <-- past the 1024 default
//       8.66 MB         1619       101.2
//      11.25 MB         1988       124.3
//      14.63 MB         2779       173.7
//
// The peak is a mark, not a leak: at a fixed index it is reached inside the
// first ~1,200 requests and does not move over the next 12,000. Growth is with
// the INDEX, which a config number can cover; growth with REQUESTS is what no
// config number could, and there is none.
//
// The fit below sits ABOVE every measured point, because the number a
// deployment writes down has to hold for an index somewhat larger than the one
// that was measured: twelve pages per index page (the measured ratio runs 2.7
// to 11.3 and rises with size), plus the 256-page floor the module occupies
// with no index at all, rounded up to a whole 128-page block so the config
// carries a round number rather than a fitted one.
//
// Both readers of this file — tools/terrain-pyramid/verify.mjs, which writes
// `memory_pages` into the layer-json config a deployment consumes, and
// data-source/terrain-source/tests/serving-memory.test.mjs, which drives a real
// instance and asserts it stays under that number — import it from HERE, so the
// number the config states and the number the test checks cannot drift apart.

export const HOST_DEFAULT_PAGES = 1024;
export const BASE_PAGES = 256;
export const PAGES_PER_INDEX_PAGE = 12;
const BLOCK = 128;

/** Pages a serving instance needs for an availability index of `bytes` bytes. */
export function memoryPagesFor(bytes) {
  const raw = BASE_PAGES + Math.ceil((bytes * PAGES_PER_INDEX_PAGE) / 65536);
  return Math.ceil(raw / BLOCK) * BLOCK;
}

/** The line a deployment reads: the number, and whether it needs to be SET. */
export function memoryPagesAdvice(bytes) {
  const pages = memoryPagesFor(bytes);
  return {
    availabilityIndexBytes: bytes,
    memoryPages: pages,
    memoryMiB: +((pages * 65536) / 1024 / 1024).toFixed(1),
    hostDefaultPages: HOST_DEFAULT_PAGES,
    // The daemon runs a pool of these; the box pays for all of them.
    poolMiBAtFourInstances: +((pages * 65536 * 4) / 1024 / 1024).toFixed(1),
    // Above roughly 4.2 MB of index the host default is not enough and the
    // mount MUST state the key.
    mustBeConfigured: pages > HOST_DEFAULT_PAGES,
  };
}
