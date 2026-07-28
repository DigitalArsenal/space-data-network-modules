# CCSDS 124.0-B-1 POCKET+ codec

Lossless compression of fixed-length CCSDS housekeeping packets, as an
isomorphic Space Data Network WASM module.

The codec is the **unmodified** `tanagraspace/ccsds124` MIT reference C
implementation, vendored verbatim under `vendor/ccsds124/` and executed as-is
inside the wasm artifact. See `vendor/ccsds124/PROVENANCE.md`.

## Status

| deliverable | state |
|---|---|
| vendored reference C, integrity-gated | **done** |
| compiles clean under the SDK's `wasm32-wasip1-threads` clang | **done** (zero warnings at `-Wall -Wextra -pedantic -std=c99`) |
| reference vectors byte-identical to ESA, in-wasm | **done** — 5/5, 161,900 packets |
| tri-runtime parity (JS engine / native WasmEdge / Docker WasmEdge) | **done** — byte-identical on all three |
| UAB/CNES 24,900-vector cross-validation | **blocked** — vector data is not public (see below) |
| SDK module with typed SDS ports | **blocked** on `$CPS` ratification (see below) |

## Vendor, not port

Porting was rejected. The acceptance criterion is byte-identity with the ESA
reference; a re-expression in another language introduces divergence risk with
no upside, and would have to be re-validated against a vector suite we cannot
fully obtain. A git submodule was also rejected: the SDK compiles exactly one
guest translation unit, so the sources must be amalgamable in-tree, and
reproducible byte-identical builds need the exact bytes pinned in the repo. The
`third_party/nrlmsise00` precedent in this repository is likewise a verbatim
copy.

Vendored files are **never edited**. `npm run verify:vendor` re-proves, before
every build, that they hash to the values in `PROVENANCE.md` and that the
single-translation-unit preconditions still hold (no duplicate `static` names,
no heap, no stdio, no threads, no floating point).

## Threading

**None, deliberately.** POCKET+ is inherently sequential: decoding packet k
requires the mask and the previous output from packet k−1. There is no
intra-stream parallelism to exploit, and faking one is forbidden. Independent
streams may be driven concurrently by a caller — the library has no mutable
globals and every context is self-contained.

## Hooks

**Zero.** The manifest declares no capabilities and the guest makes no host
calls: no http, no tcp, no fs, no clock, no wallet. A codec is a pure transform,
so no new host capability was invented.

## Build

```sh
npm run verify:vendor          # integrity + single-TU preconditions
npm run build                  # -> dist/isomorphic/module.wasm  (blocked on $CPS)
node tests/harness/build-probe.mjs   # the codec parity probe (works today)
```

## Test

The reference vector data is 20 MB and is not committed. Point
`CCSDS124_VECTORS` at a checkout of `github.com/tanagraspace/ccsds124`:

```sh
CCSDS124_VECTORS=/path/to/ccsds124 npm test

# full tri-runtime parity, no lane allowed to be missing:
CCSDS124_VECTORS=/path/to/ccsds124 \
CCSDS124_REQUIRE_ALL_LANES=1 \
SDM_WASMEDGE_BINARY=/path/to/wasmedge \
  npm run test:parity
```

The WasmEdge version is read from the SDK's `src/testing/wasmedgePin.json` —
the single pin source. Native and container versions must match it; drift fails
the test loudly.

## Two blockers, both external to the codec

### 1. Typed SDS ports need `$CPS`

The SDK's compliance gate requires every PLG port to name one concrete SDS
identity with canonical + aligned-binary peers; `acceptsAnyFlatbuffer` is a hard
error (`wildcard-port-type`). The decompressed side maps to `$SPP`, but the
compressed side has no ratified SDS type until `$CPS` lands
(`sds-ccsds124-compressed-packet-stream`, awaiting owner ratification of the
code letters).

So `build.mjs` cannot pass validation yet. Until then the codec is proven
through `tests/harness/`, which compiles the *same vendored bytes* with the
*same toolchain and flags*. When `$CPS` ratifies, only the manifest changes.

The interim wire header used by `src/module.c` is documented at the top of that
file and is designed to be replaced field-for-field by `$CPS`.

### 2. The 24,900-vector suite is not publicly available

Upstream states the cross-validation data is **not committed** and must be
obtained from ESA's OPS-SAT mission control team
(`ccsds124_full_crossvalidation_20220309.zip`). What ships in the repo is
`crossvalidation/file_list.csv` — a manifest of expected sizes and SHA-256
hashes for 49,802 files — plus five full input/expected-output vector pairs.

Note also that the acceptance criterion "all 24,900 pass" is not achievable by
*any* implementation as written: the upstream C reference itself carries a
documented baseline of **1,863 known decoder failures** (`known-failures.txt`,
UAB/CNES malformed-input accept/reject gaps). The upstream runner's own verdict
is "failures match the baseline exactly", not "zero failures".

The correct isomorphism criterion — and the stronger one — is that every lane
produces identical results on all 24,900 **including identical failures on the
1,863**. `tests/harness/run-lanes.mjs` is already shaped to run that comparison
the moment the data is available; it needs only the vector directory.

## Layout

```
vendor/ccsds124/     verbatim upstream C + LICENSE + PROVENANCE.md
src/module.c         SDK invoke glue only — no codec logic, no host logic
src/                 (codec is amalgamated from vendor/ at build time)
scripts/             vendor integrity + single-TU precondition gate
tests/harness/       cross-runtime probe, WASI driver, lane runner
tests/               vector + tri-runtime parity tests
SYNCHRONIZATION.md   the codec's real sync contract (finding sent to Themis)
```
