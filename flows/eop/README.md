# Earth orientation publication flow

A node runs this flow once a day and publishes the U.S. Naval Observatory's
IERS Rapid Service/Prediction Center finals2000A file as SDS `$EOP` records on
lane `EOP.fbs` / `eop` / `usno-finals2000a`. Parsing is in WASM; the host supplies
its generic HTTP, cron, storage and publication hooks and runs no application code.

```
tick -> eop-request -> route_request -> http-request -> restore_response -> eop-parser -+-> records ------------> storage-ingest -> egress
                                                                                        +-> meta -> attribute_lane -^
                                                                                        +-> unchanged ------------------------> egress
```

`eop-request` and `eop-parser` are the modules in `data-source/`; the hooks are
`hostcap/http-request` and `hostcap/storage-ingest`. `src/lane.cpp` is the only code
of this flow, one typed frame in and one out, with no parsing, network, clock or physics:

- `route_request` adds `If-Modified-Since: Thu, 01 Jan 1970 00:00:00 GMT`. The host
  presents the validators of the last fetch of a URL, and the open-DCA flow on the same
  node fetches this very file; a conditional request could be answered "not modified"
  for a copy this flow never stored. With the node config `eop_archive_url` set
  (loopback HTTP or HTTPS), it aims the request at `<mirror>/<sha256 of the URL>`
  and keeps the original request in `CONTEXT`.
- `restore_response` puts the original URL and job back before the parser sees the response.
- `attribute_lane` names the lane (`eop`, `usno-finals2000a`), the license
  (`LicenseRef-US-Government-Work-Public-Domain`: a U.S. Government work, 17 U.S.C. 105)
  and the citation on the parser's `IngestRequest`, and sets `Current` so a newer edition
  replaces the stored one. It refuses any batch that is not eop-parser's finals2000A from
  `https://maia.usno.navy.mil/`.

## The lane

Each publication is one complete edition: about 20,000 daily rows from 1973-01-02 through
the Rapid Service's predictions (about 6 MB, one shard). A file that has not changed
publishes nothing. The EOP record has no provenance field: every row's `DATA_SET_CID` is
the CIDv1 (raw, sha2-256) of the exact file, `DATA_TYPE` marks observed and predicted
rows, and the signed manifest carries the license and citation. Core values are both
`_HP` doubles and float copies, in radians and seconds; the parser README has the
columns and units. Consumers select the window they need (the frames module takes up to
366 rows).

## Build and verify

```sh
export SDN_LOCAL_EMSDK_DIR=<emsdk 6.0.1>          # the SDN_WASI_* variables are in deployment/space-weather-provider-node/README.md
npm ci --prefix flows/eop && node flows/eop/build.mjs
```

The build compiles every guest wasi-sequential (no exception-handling instructions, so
the node's WasmEdge 0.16.4 AOT accepts it) and links them into `dist/runtime`, which is
what the owner stages. E2E, from this repository's root:

```sh
SDN_NODE_BINARY=<node built from sdn origin/main> SDN_JS=<its built sdn-js> \
GAUNTLET_CANDIDATE_OPS=<stack checkout> node flows/eop/tests/local-node.e2e.mjs
```

It signs the flow and installs it on a scratch node with the owner's `host-config.py`,
prewarms AOT, lets the daily timer fetch this machine's archived finals2000A through the
mirror, reads the publication back from a separate SDN client by CID, compares every record
with eop-parser's offline parse of the same file, and runs the owner's `live-check.mjs`
against the scratch node. Installation on host-02 is
`deployment/space-weather-provider-node` in the stack.
