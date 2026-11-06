# Module signing

Every rebuilt `dist/isomorphic/module.wasm` ships signed with the module owner key (`module-owner-2026-10-15`, public key in `scripts/trusted-publishers.json`). The signature is a trailer; the module section a runtime compiles is unchanged. Identity of a signed dist is its SDK canonical module hash (the `sds.*` sections stripped) with the whole-file bundle hash beside it. `node scripts/check-module-signatures.mjs --check` verifies every current dist.

## Which wasm files are signed

- Signed: `dist/isomorphic/module.wasm` (the catalog artifact) and any artifact the SDK harness loads (the harness strips the trailer before compiling).
- Unsigned, with the hash pinned in the ledger: any wasm a JavaScript loader fetches and compiles directly. Today these are `propagator/sgp4` `dist/browser/module.wasm` and `dist/browser-shared/module.wasm`, `propagator/atmosphere` `dist/browser/module.wasm`, and `analysis/od` `dist/browser/module.wasm`. A signed copy would fail in `WebAssembly.compile` (unknown section code 0x10).
- `analysis/od` `dist/isomorphic/module.command.wasm` is signed by its own build, as before.
- `analysis/access`: `dist/isomorphic/module.wasm` and `dist/browser/module.wasm` are signed (the browser adapter loads through the SDK harness, which strips the trailer). `dist/access.wasm` and the base64 copy in `dist/access-binary.js` are the unsigned build bytes: the OrbPro `build:access` step validates `dist/access.wasm` with `WebAssembly.validate`, and `index.js` decodes the base64 for its bundled loader. The module's build signs only the first two.

## Why browser copies stay unsigned

Browser copies stay unsigned with their hashes pinned. A loader that strips a signature without checking it adds no security and only implies some. A signed browser copy earns its place when a browser loader verifies the signature.

## Adding a module

A build that is byte-identical before signing still gets a patch version, because the first signing moves the `sds.*` sections into the trailer. Build twice unsigned (`SDM_MODULE_UNSIGNED_BUILD=1`) and require equal SHA-256, then sign with `SDM_MODULE_SIGNING_KEYPAIR_PATH` naming the owner keypair file. The keypair is never read, copied or committed by tooling other than `scripts/sign-module-artifact.mjs` and `scripts/extract-public-key.mjs`.
