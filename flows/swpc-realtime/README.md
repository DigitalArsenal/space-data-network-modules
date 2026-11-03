# SWPC real-time flow

One minute timer drives independent complete SWS, SWA and SFE source batches:
request planner -> generic HTTP -> C++/WASM parser -> generic storage ingest.
The flow builds the existing host connectors inside its own output tree and
adds SWS/SWA/SFE typed input-port declarations to that local storage manifest.
Shared connector source and manifests are untouched.

Install the flow’s pinned SDK with `npm ci --prefix flows/swpc-realtime`.
Build from modules root with `node flows/swpc-realtime/build.mjs --unsigned`.
`dist/runtime/runtime.wasm` is the deployable linked flow artifact. It is
unsigned; the owner signs and installs it on host-02. The example configuration
names the three publication lanes and required service. It is not installed by
this lane. Flare publication requires the node to embed SDS 1.274.0 (SDN 50eea40d5 or later).

`--fixtures` builds an ignored acceptance-only replay flow under
`data-source/swpc-realtime/tests/fixture-flow`. Its only substitution is a WASM
HTTP responder containing captured bytes. It must never be deployed as a live
producer. `node data-source/swpc-realtime/tests/flow.test.mjs` checks all three
storage calls from a timer tick; the module E2E checks native publication.
