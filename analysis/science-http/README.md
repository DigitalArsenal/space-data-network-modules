# Science HTTP adapter

A transport-only, MIT-licensed WASM module. `route` accepts one SDK `$HTQ`
HTTP envelope containing a POSTed canonical `$CQR` FlatBuffer. It emits the
unchanged record to `conjunction-assessment:screen_catalog`. `respond` turns
all result records into an aligned, size-prefixed FlatBuffer HTTP stream.
The adapter does not propagate or screen orbits.

Responses use `application/vnd.sdn.flatbuffers.stream`: little-endian uint32
record length, the canonical FlatBuffer, then zero padding to an eight-byte
boundary. Every result chunk is retained. Errors are plain-text HTTP responses;
unsupported methods return 405, wrong request identifiers return 400, requests
above 4 MiB return 413, and missing/wrong-schema results return 502. Full CQR
validation belongs to the assessment module. Responses are not cached.

Build with the SDK's repository-local LLVM/WASI compiler:

```sh
npm install
SDN_WASI_CLANGXX=/path/to/repo-local/emsdk/upstream/bin/clang++ npm run build
npm test
```

The explicit `wasi-sequential` profile is justified by this pure byte transform.
The same artifact runs in the browser SDK harness and the native node host.
`dist/guest-link/` is also emitted for hosts supporting compiled compositions.
The stack's `deployment/ut-austin-core/science.flow.json` is the HTTP composition;
flow orchestration stays in the host repository.

Tests exercise protocol behavior and byte preservation, not fabricated numerical
oracles. Numerical validation uses the independently published SOCRATES report
and matching CelesTrak GP snapshot in the deployment's replay gate.
