# EOP request builder

Pure C++/WASM request builder. Choose a method to switch the upstream source:

| Method | Default GET | Parser method |
| --- | --- | --- |
| `finals2000a` | `https://datacenter.iers.org/data/9/finals2000A.all` | `parse_finals2000a` |
| `c04` | `https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now` | `parse_c04` |
| `paris` | `https://hpiers.obspm.fr/iers/eop/eopc04/eopc04_IAU2000.62-now` | `parse_paris` |

Each invocation consumes exactly one `tick` and emits:

- `request`: hostcap/http-request JSON `{method:"GET",url,timeoutMs:90000,maxBytes:16777216}`.
- `job`: `{source_url,series_name,format}` for the matching parser.

Connect `request` to `hostcap/http-request.request`, its `response` to
`eop-parser.response`, and `job` to `eop-parser.job`. Alternatively the parser
accepts raw HTTP body bytes on `body`. The host schedules ticks, fetches,
retries, caches, stores and publishes. Both nodes have no host capabilities
and do not perform network access. JSON carries only control/HTTP metadata;
normalized EOP data travels as binary SDS records.

Paris is the **named EOP 20 C04 legacy-format product**, not an independent
scientific solution from the modern C04 feed. It is identified as `OTHER` and
named in parser metadata, as required by this lane. See the
[parser contract](../eop-parser/README.md) before combining sources.

## Build and verify

From this directory:

```sh
npm ci
node build.mjs
node --test tests/sdk_compat.test.mjs
SDN_RUN_EOP_PARITY=1 node --test tests/*.test.mjs
```

The build uses `compileModuleFromSource` with an explicit `single-thread`
profile and the SDK's pinned emception backend. It emits the same standalone
`dist/isomorphic/module.wasm` for browser and WasmEdge, plus guest-link objects
for the established flow compiler. No machine-global Emscripten is invoked.
Parity requires Chrome, `wasmedge` 0.16.4 on PATH, Docker, and the SDK's pinned
`space-data-module-sdk/parity-wasmedge:0.16.4` image. `esbuild` is pinned for the
SDK's browser parity runner.
