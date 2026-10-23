# Sea state

`com.digitalarsenal.analysis.sea-state` (0.1.0) computes a stationary deep-water
wind sea in C++ through the SDN module SDK. One artifact,
`dist/isomorphic/module.wasm`, runs unchanged in browsers and native WasmEdge.
No network, host capability, clock, renderer dependency, or background worker
is required. `codec.js` only transports typed binary SDS PCE values.

The model is the JONSWAP 1973 spectrum with a PM 1964 fully developed limit,
using SPM 1984's 1/7-power height conversion from U10 to U19.5 for PM.
Fetch and duration can constrain development. Duration uses an explicitly
derived peak group-travel approximation, not a published transient-growth fit.
The PM limit caps both energy and period. The unmodified JONSWAP overshoot,
energy scale, and effective spectral alpha remain visible in the result.
See [SOURCES.md](SOURCES.md) for checked primary equations and assumptions,
and [INTERFACE.md](INTERFACE.md) for the UI/FFT contract.

Marine overrides and the existing console's render clamps/chop are computed
in the module. They do not modify the physical wind-sea spectrum. All input
values must be finite real scalars. Negative wind clamps to zero; wind above
70 m/s clamps to 70. Positive wind below 1e-6 m/s is refused. Positive fetch
and duration must be in 1e-6..1e12 SI units; zero or omission means unlimited.
Unknown fields, wrong value types, malformed frames, and missing wind fail
without producing an output. These are typed-API rules, not TS coercions.

## Build and verify

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run check:compliance
node tests/sea-state.e2e.mjs
```

Build uses SDK `compileModuleFromSource` and an existing repo-local
`deps/emsdk` LLVM toolchain. It never uses a PATH or Homebrew compiler. The
manifest is embedded and validated; published outputs include the unchanged
artifact and a copy of the authoring manifest. The module's unique pluginId
is above; any numeric publication MODULE_UID belongs to the catalog publisher.

`wasi-sequential` is an SDK pure-transform profile with shared WASM memory;
browser hosts need COOP/COEP and SharedArrayBuffer. The E2E verifies both in
one headless Firefox, and compares complete result payload bytes with Node's
browser harness and native WasmEdge. It never launches Chrome or Docker.
Docker is waived by the owner (2026-10-22). `WASMEDGE_BINARY` and
`FIREFOX_BINARY` can select existing native installations. `SEA_STATE_SCRATCH`
selects build/browser scratch (otherwise the ignored `.build/` directory).

The E2E tests the published equations on 0, 2, 5, 8, 10, 12, 15, 20, 25, 30,
and 70 m/s, fetch/duration constraints, saturation, marine overrides, and
rejected inputs. References are independently calculated by Python's standard
library from the primary equations, with a different integration coordinate
and algorithm. Run `python3 tests/reference-vectors.py` to reproduce them.
Metadata states sources, SI units, frame, no-epoch assumption, tolerance, and
rationale. The upper/lower wind extremes are arithmetic extrapolation checks,
not forecast calibration claims.

`tests/legacy-oceanWeather.ts` is a hashed read-only snapshot of the original
console mapping, evaluated only by tests. The wind-table report prints every
Hs/Tp difference and asserts equality of the remaining engine fields. The
production codec has a no-physics guard. The console's removal gate and actual
pixel comparison remain **pending in the UI lane**: this lane does not edit
SpaceAware-UI or claim that state equality measures pixels.

Generated evidence: `conformance/latest.e2e.json` (ignored, tied to the exact
branch SHA and artifact digest); the checked-in verification snapshot records
an earlier tested checkpoint without causing E2E to dirty a gauntlet candidate.
