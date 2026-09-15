# Buffered JPL SPK ephemerides (TMPL lane 01)

## C++ lookup

`files/orbit-products/src/spk_kernel.hpp` exposes a borrowed kernel view:

```cpp
spk::Kernel kernel;
if (kernel.load(bytes, byte_count) != ephem::Status::Ok) { /* refuse */ }
ephem::StateRow state;
if (kernel.state(301, 399, jd_tdb, &state) != ephem::Status::Ok) { /* refuse */ }
// state.pos: km; state.vel: km/s; geometric Moon minus Earth, ICRF/J2000.
```

The byte buffer must remain alive and immutable until the final query. SPK
2 evaluates position Chebyshev polynomials and differentiates them for
velocity; SPK 3 evaluates its independent position and velocity polynomials.
The lookup follows NAIF segment priority and resolves the nearest common
ancestor, including Moon/Earth via EMB. Only frame 1 (J2000) is accepted.
Missing bodies, unsupported frames/types, cycles, invalid records and coverage
fail explicitly. No light-time, aberration or precession corrections are made.
`state_et` accepts TDB seconds past J2000 to avoid the roughly 40-microsecond
spacing of a single double Julian date near the present.

The reader copies at most 4096 segment descriptors and reads coefficients
in place. It does not decode the kernel into sampled trajectories.
`describe_container` reports DE segment metadata. `read_container` retains its
sampled-state meaning: a coefficient-only kernel returns
`unsupported-spk-materialization`; mixed kernels preserve discrete segments.

## Kernel input wire

HPOP's `invoke` method and events' `locate_events` method accept optional port
`kernel`, typed as the existing `NCD.fbs` / `$NCD` / `NCD` identity:

```text
[u32 little-endian descriptor length][$NCD FlatBuffer][exact SPK bytes]
```

The descriptor uses `FORMAT=SPK_DAF`; optional `SOURCE_BYTE_LENGTH` and
`SOURCE_SHA256` claims are checked against the supplied bytes. The descriptor
is bounded to 1 MiB and copied for alignment. The SPK remains a byte view.
This is the existing orbit-products container convention, not a new schema.
There is no guest filesystem access, kernel download, or baked-in kernel.
See [reference acquisition and hashes](de440-validation.md).

### HPOP

On the existing `invoke` JSON request surface, `operation: "ephemeris"` accepts
`params: {target: 301, center: 399, epochTDBJD: 2461041.5}`. It requires a kernel
and returns position, velocity, `frame: "ICRF/J2000"` and
`ephemerisSource: "JPL_SPK"`. The generic label deliberately does not guess a
DE release from a file name supplied by a caller.

`operation: "propagate"` uses that same kernel for Sun/Moon/planet third-body
forces and SRP. Its existing `epochJD` and `targetJD` are TDB. The force options
include `thirdBodySun`, `thirdBodyMoon`, `thirdBodyMercury`, `thirdBodyVenus`,
`thirdBodyMars`, `thirdBodyJupiter`, `thirdBodySaturn`, `thirdBodyUranus`, and
`thirdBodyNeptune`; planetary DE states are system barycentres (NAIF 1–9).
Omitting the kernel selects `Analytical`; `params.ephemerisSource="Analytical"`
explicitly selects it even when a kernel is supplied. Results report their
source. A selected kernel never silently falls back on missing coverage.

The buffer is scoped to one invocation and all its integrator substeps.
Legacy resident/cache/trajectory methods do **not** advertise the kernel port;
source-aware persistent trajectory caching is outside this lane. The old
`loadEphemerisFile` stub now returns failure and never marks a file loaded.

HPOP's existing CMake build is diagnostic evidence only: SDK compilation and
legacy manifest compliance remain blockers described in the lane handoff.

### Events

`locate_events` uses the kernel for eclipse and body-intrusion body positions.
In kernel mode, each trajectory OEM block must declare `TIME_SYSTEM=UTC`,
ICRF/J2000/GCRF celestial axes, and `CENTER_NAIF_ID` matching the request's
central body. Other axes/scales are refused. UTC is converted through TT to
TDB using the vendored ERFA/SOFA geocentric conversion; the body state is
converted from kilometres to the locator's metres at the boundary.

A successful body lookup emits `ephemeris_source`, the verified size-prefixed
NCD descriptor of the kernel actually used. Without a kernel, body lookups
explicitly select the existing Analytical ERFA provider and no kernel receipt
is emitted. Locators that need no body ephemeris also emit no receipt. The
existing EVL report has no per-state source enum; no schema field is invented.

## Verification entry points

```sh
node files/orbit-products/build.mjs --unsigned
node propagator/events/build.mjs
PATH="$HOME/.wasmedge/bin:$PATH" node --test files/orbit-products/tests/*.test.mjs
PATH="$HOME/.wasmedge/bin:$PATH" node --test propagator/events/tests/*.test.mjs
node files/orbit-products/tests/de440-parity.mjs
node propagator/events/tests/kernel-parity.mjs
```

`--unsigned` is an explicit local build mode that reads no signing key;
ordinary orbit-products builds retain mandatory signing. The SDK parity
harness needs its browser tooling (`esbuild`, Chrome) and the SDK-pinned native
and container WasmEdge (0.16.4 in this run). The same artifact bytes are used
in all three runtime lanes. Test-only Python and JS prepare fixtures and
requests; production ephemeris and force calculations remain C++/WASM.
