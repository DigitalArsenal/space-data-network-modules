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
// the mount actually drives.
//
// THE FIRST CUT OF THIS CURVE DROVE HALF THE MOUNT. It ran `route` and one
// `layer_json` render and nothing else — no `respond`, which is the mount's
// SECOND invoke (flows/terrain-serving.flow.json wires route -> flatsql-query
// -> respond inside ONE flow, i.e. one linear memory) and where the record
// bytes, the synthesized mesh and both content codings are built; and no
// identity representation, which is what forces the UNCOMPRESSED index body
// into memory (any Accept-Encoding without gzip — `br`, `deflate`, empty,
// `gzip;q=0` — returns the whole 7.76 MB index instead of 78 KB).
//
// The mix is now the real pair, both codings, interleaved: route -> respond
// over a STORED record, route -> respond over an empty stream inside
// availability (the synth path), route -> layer_json, and a junk 404, with one
// request in three asking for `identity`. Re-measured that way, 1,200 requests
// deep, on this candidate:
//
//     index bytes    peak pages    MiB     pages per index page
//         45 B           256        16.0     —
//       0.36 MB          256        16.0     —
//       1.52 MB          359        22.4     4.4
//       2.81 MB          601        37.6     8.0
//       6.33 MB         1232        77.0    10.1     <-- past the 1024 default
//       8.66 MB         1619       101.2    10.3
//      12.66 MB         2381       148.8    11.0
//      16.46 MB         3285       205.3    12.1
//
// A SECOND, INDEPENDENT MEASUREMENT SETS THE FIT, NOT THIS ONE. An independent
// harness driving the same shipped artifact at a 7.76 MB index measured 1,848
// pages on 3/3 runs, against 1,619 here at a LARGER index — same module, same
// shapes, a different allocation order, 355 pages apart. Which of the two
// orders a host reproduces is not something this file can promise, so the fit
// is set above the HIGHER of them. `memory_pages` is a HARD cap in the host
// (httpmount.go -> wasmrt.WithMaxMemoryPages), so a fit that is merely close is
// memory.grow returning -1 inside the guest mid-request.
//
// FOURTEEN PAGES PER INDEX PAGE WAS NOT ENOUGH, and the counterexample is why
// this constant now carries a margin it looks like it does not need. An
// independent measurement of the same shipped artifact, same real pair, same
// 1-in-3 identity mix, at a 14.24 MB index: the fit STATED 3,328 pages and the
// instance PEAKED at 3,384 — over by 56, on 4 of 4 runs. The trigger is
// allocation ORDER, not size: the same 600-request mix with gzip first peaks at
// 3,167 (under by 161), and putting the identity layer.json render FIRST is
// what crosses it. Measured pages-per-index-page there is 14.39, i.e. the old
// constant sat BELOW the measurement and the 128-page block rounding did not
// rescue it. Every other size sampled — 2.25 MB through 22.50 MB — had margins
// of 221 to 883 pages, which is the actual finding: the margin is unmodelled
// and swings by 4x, so "it passed at the sizes we sampled" was never a bound.
//
// SIXTEEN puts 14.24 MB at 3,840 (covering the 3,384 peak with 456 to spare),
// 7.76 MB at 2,176 (covering 1,848 with 328), and leaves every point in the
// table above with 500 to 1,000. It does not move the number this lane
// actually deploys: the regional index is 10,219 B, which rounds to the same
// 384 pages under either constant.
//
// The peak is a mark, not a leak: at a fixed index it is reached inside the
// first ~1,200 requests and does not move over the next 3,000 driven through
// BOTH invokes. Growth is with the INDEX, which a config number can cover;
// growth with REQUESTS is what no config number could, and there is none.
//
// Plus the 256-page floor the module occupies with no index at all, rounded up
// to a whole 128-page block so the deployment carries a round number rather
// than a fitted one.
//
// Both readers of this file — tools/terrain-pyramid/verify.mjs, which writes
// `memory_pages` onto the MOUNT ENTRY a deployment installs (never into the
// module config block: it is config.FlowMount.MemoryPages, a sibling of
// `config:`), and data-source/terrain-source/tests/serving-memory.test.mjs,
// which drives a real instance through the real pair and asserts it stays under
// that number — import it from HERE, so the number the deployment states and
// the number the test checks cannot drift apart.

export const HOST_DEFAULT_PAGES = 1024;
export const BASE_PAGES = 256;
export const PAGES_PER_INDEX_PAGE = 16;
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
    // Above roughly 3.1 MB of index the host default is not enough and the
    // mount MUST state the key.
    mustBeConfigured: pages > HOST_DEFAULT_PAGES,
    // WHERE THE KEY GOES. It is config.FlowMount.MemoryPages — a sibling of the
    // mount's `config:` block, read only by internal/flowrt/httpmount.go — and
    // NOT a module config key delivered through plugin.getConfig. Stated here
    // because the run writes it into a file an operator pastes from.
    yamlLocation: "flows.mounts[].memory_pages (sibling of `config:`, never inside it)",
  };
}
