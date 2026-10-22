# Publication Seal

`com.digitalarsenal.licensing.publication-seal:seal` seals opaque files into the
SDK protected-publication format consumed by the unchanged
`licensing/client-decrypt:decrypt_artifact`. The canonical artifact is
`dist/isomorphic/module.wasm`; direct and command invoke surfaces use the same
single-threaded WASM in browser and WasmEdge.

| Port | Type | Contract |
| --- | --- | --- |
| `file` input | repeated `$FIL` | `CONTENT` contains opaque bytes, including an empty file. Up to 256 files per invocation. |
| `release_key` input | `$KMF` | `ROLE=DecryptKey`, `KEY_BYTES` is the 32-byte X25519 recipient private key. |
| `options` input | `ModuleConfig` (`MCFG`) | `context` is a nonempty String; `names` is a StringList in file input order. Names must be nonempty and unique. |
| `file` output | repeated `$FIL` | Sealed `CONTENT`, in input order; `SIZE` is the sealed byte count. |

`ENC.CONTEXT` is exactly `<context>/<name>`. Neither component may contain NUL.
Unknown or duplicate options, wrong counts, malformed records and missing inputs
fail without output. The module does not interpret filenames as filesystem paths.

The host passes files and keys as binary typed frames; no JSON/base64 crosses
module ports. This package does not fetch, store, upload, or log content or keys.
Release key storage and delivery remain the host/key-server responsibilities.

## Format and entropy

```
ciphertext || GCM tag (16 bytes) || REC(ENC) || uint32le(REC length) || "$REC"
```

ENC uses X25519, HKDF-SHA256 with empty salt and CONTEXT as info, and symmetric
wire value `1` (AES-256-GCM, as in SDK `transport/records.js`). The standalone
`$ENC` serialization is GCM additional authenticated data, with the SDK object
API's field/vector construction order. REC version is `1.0.0`.

Each file gets a fresh ephemeral X25519 key and 12-byte nonce from WASI
`random_get`. A nonzero errno fails closed, including after earlier files in a
batch have been prepared. There is no seed, fallback RNG, or test entropy option.
The host must supply a CSPRNG. Browser SDK WASI maps this to
`crypto.getRandomValues`; native WASI obtains OS entropy. The timestamp is runtime
wall-clock milliseconds and is authenticated as part of ENC.

Crypto++ secure blocks wipe release, ephemeral, shared-secret and AES-key copies
on every exit. The parsed input key bytes in guest memory are also wiped. Hosts
must retain and clear their own input/transport buffers according to their secret
lifecycle. Errors contain fixed descriptions, never key values.

Consumers must check parsed ENC CONTEXT against the expected `<context>/<name>`
before accepting plaintext. Authentication alone does not tell a caller which
filename it intended to fetch.

## Build

Install this package's JS development dependencies and provision a local
`deps/emsdk`, Crypto++ **8.9.0**, and FlatBuffers headers matching the committed
core SDS headers. No source or toolchain is fetched by the build.

```sh
# From the repository root; paths name your locally provisioned dependencies.
export SDN_LOCAL_EMSDK_DIR=/path/to/repo/deps/emsdk
export CRYPTOPP_SOURCE_DIR=/path/to/cryptopp-8.9.0
export FLATBUFFERS_INCLUDE_DIR=/path/to/flatbuffers/include
uptime
EMCC_CORES=4 node licensing/publication-seal/build.mjs
```

The repo toolchain resolver enforces `scripts/emsdk-pin.json`. A historical local
compiler requires its explicit `SDN_EMSDK_ERA` identity. The checked artifact used
`SDN_EMSDK_ERA=em-5.0.7`, the available client-decrypt toolchain, recorded in
`dist/build-toolchain.json`. Crypto++ translation units build serially and compiler
helpers are capped at eight. System/Homebrew Emscripten is refused.

The build embeds SDK-generated typed invoke glue and the manifest. It consumes
read-only SDS and ModuleConfig headers already committed under `licensing/core`.
Generated build caches stay under `.build/` and `.emcache/`.

## Verification

```sh
node --test licensing/publication-seal/tests/sdk_compat.test.mjs
node licensing/publication-seal/tests/seal-grant-decrypt.e2e.mjs
PUBLICATION_SEAL_SCRATCH=/your/authorized/scratch \
  node licensing/publication-seal/tests/runtime-parity.mjs
```

The E2E fails loudly if any real artifact is absent. It seals four committed R2
terrain fixtures, publishes the release key and sealed bytes to the real key-server
WASM, obtains a lease through `$LCH` / EPM-proved `$LPF` / `$LGR`, and decrypts via
the real client-decrypt WASM. `ALLOWED_XPUBS=["*"]` admits proved accounts; a
request missing its EPM account proof is refused. It also seals the fixtures with
the independent SDK writer and decrypts both writers' outputs through
client-decrypt. The SDK additionally decrypts the C++ output.

Each fixture tests refusal for missing grant, another publication's grant, wrong
session key, one flipped ciphertext byte, one flipped tag byte, one flipped ENC
nonce byte, and a reader expecting a different filename. Comparisons use exact
SHA-256 equality (zero tolerance). These are byte/cryptographic tests; reference
frame, physical units, epoch and time scale do not apply. The public format oracle
is the SDK transport implementation, not golden values generated by this module.

The descriptor has an honest CIDv1 raw/SHA-256 of the concatenated sealed tileset
bytes in input order. This exercises the existing descriptor requirement without
changing client-decrypt. Production data-publication descriptors and catalog/R2
rollout are separate work.

The parity script runs one headless browser at a time plus native and Docker
WasmEdge pinned by the SDK. It compares lengths, trailer structure, AAD size and
decrypted SHA-256; independent runtime ciphertexts are intentionally random.
It requires an already provisioned Docker image and running Docker daemon. SDK
containers use `--rm`; browser profiles and the browser PID are cleaned up by the
SDK runner. If you start Docker Desktop for this test, quit it when finished.
Only a complete three-runtime pass writes `tests/parity-receipt.json`.

The SDK-compat suite also injects early and late failures at the **host's** ordinary
WASI entropy import to prove atomic failure. The production module is unchanged
for these tests.

Fixture sizes are 49,113 / 61,571 / 453,508 / 17,145 bytes, for Mars root/L12 and
Moon root/L9 respectively. With the E2E context, each sealed file adds 296 bytes.
Throughput is measured and printed on each run; it is not a fixed acceptance
threshold.
