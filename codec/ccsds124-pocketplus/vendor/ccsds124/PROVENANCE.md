# Vendored upstream: CCSDS 124.0-B-1 POCKET+ reference C implementation

| | |
|---|---|
| Upstream | https://github.com/tanagraspace/ccsds124 |
| Commit | `b832360013a2b46e35f40f7f21a854e023cc1c0a` (2026-07-28) |
| Upstream path | `implementations/c/` |
| Library version | 1.0.0 (`VERSION`) |
| License | MIT — Copyright (c) 2025 Tanagra Space (`LICENSE`, verbatim) |
| Standard | CCSDS 124.0-B-1, "Robust Compression of Fixed-Length Housekeeping Data" |
| Cross-validation authorship | Universitat Autonoma de Barcelona (Miguel Hernandez-Cabronero, Ian Blanes, Joan Serra-Sagrista) under technical supervision of Mickael Bruno, CNES |

## Integrity law

These files are **byte-identical to upstream and are never edited**. The
CCSDS 124.0-B-1 conformance claim is that *the ESA-cross-validated reference C
executes unmodified inside the wasm artifact*; any local edit voids that claim.

SHA-256 at vendoring time (`npm run verify:vendor` re-checks these):

```
4630ef1b09857d71d4135b76ea0b9ae7e9b6e8dac17c1e30f28e360d5dd0f78b  include/ccsds124.h
2f9a977ca7c86fd4f7d4dda4621723409fc7f73d8fdbf4aad7d34f0529e76121  LICENSE
b254634f1f3dca83bb3efb17f57c99517931550e0eceed98db22571cbb502e9b  src/bitbuffer.c
e3ec782ec2d410663ab10a16bcd8abbc7d3582245c5c06c0d0b7751d24ea5933  src/bitvector.c
4c9baa0a37034c511169a2ca66ccd62cc640e0c5698a3a80fab3527a8576cfcf  src/compress.c
727a4f49a7cf189d7ae6d26a9c074ae3331415276b03a9dbd58ae18b291df043  src/decompress.c
4c071c7a2857be5ed196d72027748d09c3e9c34054f8d9271cccec7d3ff568f3  src/encode.c
7587903cdb9b70e6d03d388680d5c8fc38bce60d6df89ba317e70e999045bda1  src/mask.c
92521fc3cbd964bdc9f584a991b89fddaa5754ed1cc96d6d42445338669c1305  VERSION
```

## What was NOT vendored, and why

- `src/cli.c` — the only translation unit in the upstream library that touches
  `stdio`/`stdlib` (file I/O, `printf`, `exit`). It is a host CLI driver, not
  codec logic. Excluding it keeps the guest free of host I/O, which is what
  lets the module satisfy REJECT-HOST-LOGIC and the generic-hook-only rule.
- `tests/`, `fuzz/`, `Makefile`, `Dockerfile`, `Doxyfile`, `misra.supp` —
  upstream's own native build/test scaffolding. The SDK owns our build.

## Why the six vendored `.c` files compile as one translation unit

`src/ccsds124_amalgam.c` `#include`s these six sources into a single TU because
the SDK's `compileModuleFromSource()` compiles exactly one guest translation
unit. The amalgamation is a *wrapper* — it does not modify vendored bytes.
Verified preconditions for TU merging (all re-checked by `verify:vendor`):

- No duplicate `static` function names across the six files.
- No `malloc`/`calloc`/`realloc`/`free` — the codec is entirely
  caller-allocated / static, per MISRA-C:2012.
- No `stdio`, no `setjmp`, no threads, no floating point, no `assert`.

## Upstream bump procedure

1. Re-clone upstream at the new commit; copy the same nine files.
2. Update the table and hashes above.
3. `npm run verify:vendor` (re-proves the TU preconditions on the new bytes).
4. Rebuild and re-run the vector suite on **both** runtimes. A vector-suite
   delta on an upstream bump is a finding, not a rubber stamp.
