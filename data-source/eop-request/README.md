# EOP request builder

Pure C++/WASM request builder. Choose a method to switch the upstream source:

| Method | Default GET | Parser method |
| --- | --- | --- |
| `finals2000a` | `https://maia.usno.navy.mil/ser7/finals2000A.all` | `parse_finals2000a` |
| `c04` | `https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now` | `parse_c04` |
| `paris` | `https://hpiers.obspm.fr/iers/eop/eopc04/eopc04_IAU2000.62-now` | `parse_paris` |

The finals2000A file comes directly from its producer, the U.S. Naval
Observatory (USNO), IERS Rapid Service/Prediction Center. It is U.S. Government
work in the public domain. The IERS datacenter mirrors this product but rejects
automated requests from the provider node; USNO is the production source.

`flows/open-dca` and `flows/eop` embed this request builder. Their request nodes
call `finals2000a`, paired with `parse_finals2000a`; no flow calls `c04` or `paris`.
`flows/eop` publishes the parsed finals2000A as SDS EOP records.
The live-source E2E checks that finals2000A covers the last 32 days plus a
48-hour forecast. C04 is therefore not required by this flow. The optional C04
methods retain their contracts, but their Paris endpoints timed out from
host-02 on 2026-10-23 and are not used by the deployed flow.

Typed contracts 1.0: FlatBuffers only, no JSON and no base64. Each invocation
consumes exactly one `tick`, a `TimerTick` (TICK; its fields are not read; a
second tick is refused), and emits one frame:

- `request`: an `HttpRequest` (HREQ) for `hostcap/http-request`: GET the
  method's file, `TIMEOUT_MS` 90000, `MAX_BYTES` 16777216 (the host errors past
  it, never truncates). Its `CONTEXT` is the parser job, one size-prefixed SDS
  `$ICN` (Ingest Connector) record: `CONNECTOR_ID` and `DATASET_ID` the format
  (`finals2000a` / `c04` / `paris`), `SOURCE_NAME` the series name,
  `ENDPOINT_URL` the file, `KIND` HttpsPull, `HTTP_METHOD` GET,
  `TARGET_SCHEMA` EOP.fbs, `EMITS_SCHEMAS` [EOP], `POST_INGEST_ACTION`
  LeaveInPlace.

Connect `request` to `hostcap/http-request.request` and its `response` to
`eop-parser.response`: the connector echoes `CONTEXT` verbatim, so the job
reaches the parser inside the response (there is no separate job port).
Alternatively the parser accepts the raw file as one `$FIL` on `body`. The host
schedules ticks, fetches, retries, caches, stores and publishes. Neither node
makes a hostcall or holds a capability, and neither performs network access.

Paris is the **named EOP 20 C04 legacy-format product**, not an independent
scientific solution from the modern C04 feed. It is identified as `OTHER` and
named in parser metadata, as required by this lane. See the
[parser contract](../eop-parser/README.md) before combining sources.

## Build and verify

From this directory:

```sh
mkdir -p node_modules && ln -sfn <space-data-module-sdk 0.9.0 checkout> node_modules/space-data-module-sdk
export SPACE_DATA_STANDARDS_ROOT=<spacedatastandards.org checkout>   # default: the sibling checkout
node build.mjs
node --test tests/sdk_compat.test.mjs
SDN_RUN_EOP_PARITY=1 node --test tests/*.test.mjs
```

The build inlines the SDS `$ICN` header from
`$SPACE_DATA_STANDARDS_ROOT/lib/cpp/ICN/main_generated.h` (include guard
renamed) and uses `compileModuleFromSource` with an explicit `single-thread`
profile and the SDK's pinned emception backend. It emits the same standalone
`dist/isomorphic/module.wasm` for browser and WasmEdge, plus guest-link objects
for the established flow compiler. No machine-global Emscripten is invoked.
Parity requires Chrome, `wasmedge` 0.16.4 on PATH, Docker, and the SDK's pinned
`space-data-module-sdk/parity-wasmedge:0.16.4` image. `esbuild` is pinned for the
SDK's browser parity runner.
