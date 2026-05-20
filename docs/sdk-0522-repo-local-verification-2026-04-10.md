# SDK 0.5.22 Repo-Local Verification And External Stop

Superseded on April 10, 2026 by
[`docs/licensing-client-server-flow-2026-04-10.md`](./licensing-client-server-flow-2026-04-10.md).
This file remains as the checkpoint captured before the sibling-repo host
changes were implemented and verified.

## Repo-Local State

This repository now carries local implementations for the protection modules
instead of relying on external OrbPro-only sources:

- `packages/protection-key-server`
- `packages/protection-license-client`

Both packages now publish the canonical SDK artifact layout:

- `dist/browser/module.js`
- `dist/browser/module.wasm`
- `dist/isomorphic/module.wasm`

Both packages are pinned to `space-data-module-sdk` `0.5.22`, use the
canonical invoke ABI exports, and keep `dist/` tracked.

I also updated the stale OD local harness to load the canonical browser
artifact names instead of the legacy `dist/od_wasm.js` path.

## Repo-Local Verification That Passed

Executed and passing in this repo:

- `cd packages/protection-key-server && node --test tests/sdk_compat.test.mjs`
- `cd packages/protection-license-client && node --test tests/sdk_compat.test.mjs`
- `cd packages/plugin-delivery && npm test`
- `cd packages/client-decrypt && npm test`
- `cd packages/atmosphere && node --test tests/sdk_compat.test.mjs`
- `cd packages/cislunar && node --test tests/sdk_compat.test.mjs`
- `cd packages/conjunction-assessment && node --test tests/sdk_compat.test.mjs`
- `cd packages/fred && node --test tests/sdk_compat.test.mjs`
- `cd packages/hpop && node --test tests/sdk_compat.test.mjs`
- `cd packages/maneuver && node --test tests/sdk_compat.test.mjs`
- `cd packages/od && node --test tests/sdk_compat.test.mjs tests/test_wasm.mjs`
- `cd packages/propagator.sgp4 && node --test tests/sdk_compat.test.mjs`

Important repo-local results:

- `plugin-delivery` and `client-decrypt` pass IPFS round-trip tests inside this
  repo.
- `protection-license-client` passes both direct-surface and command-surface
  DEK retrieval against the local protection key broker flow.
- `protection-key-server` passes browser-surface SDK compatibility and command
  invoke coverage.

Packages with no runnable test suite in this repo at the time of this pass:

- `packages/fastest-path`
- `packages/sensor-shaders`
- `packages/sgp4`
- `packages/viewshed-shader`

## External Blockers

This repo can prove the module logic locally, but it cannot make the real host
repos work without changes there.

### 1. `sdn-server` does not currently provision a real `protocol.*` host handler

Relevant files:

- `../space-data-network/sdn-server/internal/modulert/module.go`
- `../space-data-network/sdn-server/internal/modulert/hostbridge.go`
- `../space-data-network/sdn-server/internal/modulert/caps/*.go`

What is present:

- `module.go` maps `protocol_handle` and `protocol_dial` to the `protocol`
  hostcall prefix.
- `hostbridge.go` advertises `protocol_handle` and `protocol_dial` in the
  supported capability list.

What is missing:

- There is no capability factory in `internal/modulert/caps` that actually
  handles `protocol.*` operations.
- There is therefore no registered server-side implementation for the
  `protocol.request` hostcall used by the local protection license client.

Impact:

- The protection modules work in this repo only because the local tests provide
  a custom `createJsonHostcallBridge(...)` dispatcher for `protocol.request`.
- Real server-side licensing over the module host bridge still requires changes
  in `space-data-network`.

### 2. The browser host layer does not expose `protocol.request`

Relevant files:

- `../space-data-network/packages/module-runner/src/runner.js`
- `../space-data-module-sdk/src/host/browserHost.js`

What is present:

- `module-runner` constructs a browser host with `createBrowserHost(...)`.

What is missing:

- `BrowserHostSupportedCapabilities` does not include `protocol_dial` or
  `protocol_handle`.
- `BrowserHostSupportedOperations` does not include `protocol.request`.

Impact:

- The local browser-side protection tests only pass because this repo injects a
  custom `createJsonHostcallBridge(...)` dispatcher.
- A real browser/client harness still needs external host support for the
  protocol bridge before end-to-end licensing can be claimed outside this repo.

### 3. Raw standalone WasmEdge is not the same as the server runtime host bridge

Relevant files:

- `packages/protection-key-server/tests/sdk_compat.test.mjs`
- `../space-data-network/sdn-server/internal/modulert/module.go`

Impact:

- Raw WasmEdge loading of the protection key server is intentionally skipped in
  the repo-local SDK suite because plain standalone WasmEdge does not provide
  the `space_data_module_host` bridge needed by these `space-data-module-abi` artifacts.
- Real server verification must happen through `sdn-server`'s module runtime,
  not a bare WasmEdge standalone load.

## Stop Condition

This repo is at the correct stop point for repo-local work:

- module logic is local
- SDK `0.5.22` package targets are updated
- repo-local IPFS/licensing tests pass
- remaining work is host-runtime integration outside this repo

Do not claim full real-world server/client licensing support until the external
`space-data-network` host bridges add and register the missing `protocol.*`
operations.
