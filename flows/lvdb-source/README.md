# LVDB retrieval flow

Seven typed nodes: release marker request → HTTP → asset planning → HTTP →
LVDB WASM parser → storage ingest → egress. Publishes `SSY.fbs / lvdb / comb-all`.
SDK 0.9.12 is pinned in this flow; SDS 1.275.0 resolves from lvdb-source.

Build with `node flows/lvdb-source/build.mjs --unsigned` from the modules root.
`--fixtures` builds an ignored replay artifact for the source E2E; production
always compiles the existing generic HTTP host hook.

See `../../data-source/lvdb-source/README.md` for provenance, acceptance and
the explicitly deferred native-node CID readback. Provider installation is
outside this task.
