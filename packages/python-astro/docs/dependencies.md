# Python dependencies and ABI limits — second pass, 2026-09-15

FFM (Full Force Model) is defined in [the FFM specification](../../../propagator/ffm/FFM.md).

The coordinator resolved the first-pass dependency blockers: this package embeds
**WasmEdge 0.16.4 through its C API using ctypes**, and vendors immutable generated
**SDS 1.271.0** output. It depends on neither the empty PyPI `wasmedge` package nor
the stale PyPI SDS wheels. `dependency-audit.json` records that historical audit.

## Native runtime

Search order is `WASMEDGE_LIB`, `~/.wasmedge/lib`, then system library discovery.
An explicitly selected library must work; a broken override is not ignored.
The runtime checks the library version against 0.16.4. Install it using the SDN
repository's `scripts/install-wasmedge.sh`, or point `WASMEDGE_LIB` at the matching
`.dylib`, `.so`, or `.dll`. The wheel does not bundle the native runtime. Python dependencies are NumPy,
FlatBuffers25.12.19, and cryptography46.0.4. The REC generated union imports
FlatbuffersEncryption/KMF, so cryptography is required even when only importing
that union; the package declares it explicitly.

The host mirrors the SDK C API runner and binary PIV/TAB codec. It initializes
WASI with no preopened directories and no inherited environment; invokes
`_initialize` when present; otherwise uses the guest constructors. Payloads stay
binary and aligned. Size prefixes delimit stream frames; the PIV envelope holds
TAB descriptors pointing into its payload arena. `runtime.frame_stream` and
`runtime.unframe_stream` implement the size-prefix boundary when needed.

Access's committed artifact imports Emscripten's legalized five-argument
`fd_seek`; the host mirrors the SDK stdio shim's ESPIPE/BADF behavior. Conjunction
imports the shared memory `env.memory` and `wasi.thread-spawn`; the host starts
each guest thread as a new instance on the resident instance's executor, because
WasmEdge 0.16.4 keeps the atomic waiter map on the executor. Its test performs a
real two-worker conjunction screen. No other artifact imports a host function.

Linux and Windows runtime
execution remain untested. macOS arm64 with Python 3.14 is verified.

## Generated bindings

See [sds-generation.md](sds-generation.md). The package uses immutable Git
`acbce14c8044fa2484e5f50fb51815d4488f05b8:lib/py`, even if another lane is
regenerating files in the canonical checkout. Full source manifest:
`abe67014ee43a291ad785fb9a229b0ebf3747e96d0afa17fa54ca821dff1ed14`.
All 7,413 source files are hashed; required families and their import closure
are vendored under a private namespace. Generated imports are rewritten only by
`scripts/vendor_sds.py`. Module `.fbs` schemas are compiled with pinned
`flatc-wasm@26.1.38`; schema/compiler/artifact hashes are in `bindings.lock.json`.

All vendored modules import and all audited cross-module symbols resolve.
**No missing-symbol expected-failure test is needed:** no such generator defect
was observed. Unknown imports fail vendoring instead of being skipped.

## Remaining upstream contracts

- FFM's `invoke` method takes the typed `$PRW` record (`PRWExecutionRequest`) and
  conjunction assessment takes `$CQR`; the Python `ffm` and `conjunction_assessment`
  wrappers build those generated objects with NumPy marshalling, and all
  integration, force evaluation and screening remain C++ WASM.
- FFM trajectory-segment generated C++ lacks its `.fbs` source in this checkout.
  Additional resident trajectory-segment Python wrappers are not implemented.
- Current SDK and legacy SGP4 schemas both define incompatible `StateVector`
  types. Legacy SGP4 bindings use `.invoke.legacy.orbpro`, never an alias that
  overwrites `.invoke.orbpro`.
- Module-declared SDS pins are mixed, not uniformly 1.271.0. Both those pins and
  the coordinator-selected immutable Python binding revision are recorded in
  the binding lock. No module manifest or SDS schema is changed by this lane.

The complete lane remains short of a clean isomorphism/build gate because of
pre-existing module and harness failures listed in [verification.md](verification.md).
