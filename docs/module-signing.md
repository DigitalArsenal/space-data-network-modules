# Module signing

Every rebuilt `dist/isomorphic/module.wasm` ships signed with the module owner key (`module-owner-2026-10-15`, public key in `scripts/trusted-publishers.json`). The signature is a trailer; the module section a runtime compiles is unchanged. Identity of a signed dist is its SDK canonical module hash (the `sds.*` sections stripped) with the whole-file bundle hash beside it. `node scripts/check-module-signatures.mjs --check` verifies every current dist and the rule below.

## The rule

A signed file carries a publication trailer that `WebAssembly.validate` and `WebAssembly.compile` reject (`unknown section code 0x10`). So:

- A wasm that a loader compiles or validates directly stays the unsigned build bytes, with its hash pinned in the ledger.
- A signed wasm must be named as loaded through the SDK harness (which strips the trailer) or by a verifier (which checks it).
- Every `dist/isomorphic/module.wasm` is loaded through the SDK harness and is signed.

`scripts/check-module-signatures.mjs` enforces it: it runs `WebAssembly.validate` over every tracked `.wasm` and every base64 wasm in a tracked JS or JSON file. A file in `RAW_CONSUMED` that does not validate fails; any other file that does not validate and is neither a `dist/isomorphic/module.wasm` nor in `SDK_LOADED_SIGNED` fails.

Browser copies stay unsigned with their hashes pinned. A loader that strips a signature without checking it adds no security and only implies some. A signed browser copy earns its place when a browser loader verifies the signature.

## Unsigned, consumed raw (`RAW_CONSUMED`)

| file | consumer |
|---|---|
| `propagator/sgp4/dist/browser/module.wasm` | `dist/browser/module.js` (Emscripten loader); `propagator/ffm/tests/intermodule_sgp4_import.test.mjs` |
| `propagator/sgp4/dist/browser-shared/module.wasm` | `dist/browser-shared/module.js` (Emscripten loader) |
| `propagator/atmosphere/dist/browser/module.wasm` | `dist/browser/module.js` (Emscripten loader) |
| `analysis/od/dist/browser/module.wasm` | `dist/browser/module.js` (Emscripten loader); OrbPro `analysis.od` build |
| `analysis/access/dist/access.wasm` | OrbPro `build:access` (`WebAssembly.validate`) |
| `analysis/access/dist/access-binary.js` | `analysis/access/index.js` bundled loader (base64) |
| `licensing/core/dist/browser/module.wasm` | `dist/browser/module.js` (Emscripten loader) |

## Signed, not an isomorphic dist (`SDK_LOADED_SIGNED`)

| file | loader |
|---|---|
| `analysis/access/dist/browser/module.wasm` | `src/browser-adapter.mjs` through `createBrowserModuleHarness` (strips the trailer) |
| `analysis/od/dist/isomorphic/module.command.wasm` | OrbPro `analysis.od` build, verified against trusted signers |
| `data-source/gps-source/dist/gps-source.wasm` | module tests strip the trailer before instantiating; no raw consumer found in the modules repo, sdn-js or the SDN-AP docs |
| `data-source/oneweb-source/dist/oneweb-source.wasm` | module tests strip the trailer before instantiating; no raw consumer found in the modules repo, sdn-js or the SDN-AP docs |

## Consumers outside this repository

- SDN-AP site demo loaders (`docs/demo-worker.js`, `compare.js`) strip the `$REC` footer before `WebAssembly.compile`; a trailer is tolerated there.
- sdn-js `live-delivery.ts` and local-flatsql use the SDK harness, which strips; the console's `scenarioModules.ts` strips the SDS trailer unread.
- OrbPro `access/build.mjs` validates `dist/access.wasm` raw (hence the unsigned copy above). OrbPro `conjunction-assessment/build.js` and `comms/sdnRfModuleDelivery.js` strip with `toLoadableWasmBytes` before compiling.
- OrbPro tests `propagator.ffm/test/frameWorkerForceModel.test.mjs` and `frameWorkerPool.test.mjs` call `WebAssembly.compile` on `propagator/ffm/dist/isomorphic/module.wasm` read raw when `TMPL_MODULES_ROOT` names a modules checkout; a signed ffm dist fails there until those tests strip the trailer.

## Adding a module

A build that is byte-identical before signing still gets a patch version, because the first signing moves the `sds.*` sections into the trailer. Build twice unsigned (`SDM_MODULE_UNSIGNED_BUILD=1`) and require equal SHA-256, then sign with `SDM_MODULE_SIGNING_KEYPAIR_PATH` naming the owner keypair file. The keypair is never read, copied or committed by tooling other than `scripts/sign-module-artifact.mjs` and `scripts/extract-public-key.mjs`. A new non-isomorphic wasm joins one of the two tables above and the matching list in the script.
