# Access analysis

The canonical build uses SDK `compileModuleFromSource` and its
`wasi-sequential` profile. The module processes ordered trajectory samples and
exports both direct PIV and command invocation. One byte-identical WASM file is
used in Chrome/V8, native WasmEdge, and container WasmEdge. Browser JS adapts
legacy C export names and memory views; C++ computes ACW, geometry, elevation
masks, and refraction for both the SDK method and retained helper APIs.

```sh
npm ci --ignore-scripts
node build.mjs
node --test tests/sdk_compat.test.mjs
npm test
npm run check:compliance
PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
```

The build generates ACW C++ headers from the pinned published SDS package and
uses the SDK's configured WASI clang toolchain. It does not sign or publish.
`node build.js` and `npm run build` invoke the same canonical build.

The parity command requires Chrome, native WasmEdge, and Docker with the SDK's
pinned WasmEdge image. It checks six Orekit inverse-coordinate cases and all
three SDK command error fixtures at thread counts 1, 2, 4, and 8. The numerical
test documents source, units, frame, TT epoch, and the unchanged 1e-10 rad bound
in `tests/orekit-fixture.mjs`. There is no missing-runtime success path.

The SDK now enforces the manifest's required input port before calling the
method. An empty valid PIV request returns `missing-required-input` with
`Missing required input port: request`; malformed command bytes are handled by
the shared SDK command bridge.

## Composed access constraints (SDS 1.219.0)

The SDK method `compute_access_windows` accepts the ratified `$ACW` envelope.
`CONSTRAINTS` selects the C++ composition engine. Nested `ALL_OF` / `ANY_OF`
sets combine elevation, azimuth masks, minimum/maximum range, Sun/Moon
exclusion, target illumination, ellipsoid line of sight, and blackout leaves.
An empty `ALL_OF` is true; an empty `ANY_OF` is false. Each ground station and
moving observer produces its own windows. Elevation leaves require ground
observers. Blackouts participate only when a `BLACKOUT` leaf is present.
Legacy requests without `CONSTRAINTS` retain their existing elevation/mask,
refraction, and blackout behavior.

All supplied trajectories use the same Earth-fixed Cartesian frame, metres,
and Julian Date TT. Position-only trajectories are interpolated linearly;
observer and required Sun/Moon data must cover the complete target span.
Unsorted, duplicate, nonfinite, missing, or uncovered required state data is
rejected. There is no extrapolation or implicit ephemeris fallback.

- `DISCRETE` evaluates target sample epochs and reports runs of visible samples.
  Elevation/range summaries are over those visible samples.
- `CONTINUOUS` partitions each linear segment at individual constraint
  boundaries, then uses the events module's Brent solver with
  `ROOT_TOLERANCE_S`. Polynomial candidates include interior angular,
  ellipsoid, and shadow crossings; mask azimuth knots and stationary points
  partition unrefracted mask functions. This detects intervals hidden between
  two samples with equal aggregate truth values. Refraction retains numerical
  bracketing of its nonpolynomial correction.
- Range extrema include endpoints and exact interior closest approaches in
  continuous mode. `SAMPLE_COUNT` counts visible input target samples, so an
  interval wholly between input samples legitimately has count zero.
- Leaf labels are flattened depth first (a set's constraints before its nested
  sets). Boundary attribution uses the changing boolean expression; unrelated
  simultaneous transitions cannot take credit. Sample-span endpoints use `-1`.
- Moving-observer windows set `OBSERVER_ID`, leave `STATION_ID` empty, and use
  zero for `MAX_ELEVATION_RAD` because ACW defines no spacecraft local vertical.

Target lighting calls the existing events umbra/penumbra evaluator with Earth
radius 6378137 m and solar radius 695700000 m. Line of sight uses the finite
observer-target segment and WGS84 equatorial/polar semiaxes, each increased by
`OCCULTATION_ATMOSPHERE_HEIGHT_M`. It includes endpoint occultation and permits
surface grazing. These are geometric tests; ACW defines no light-time option.

Refinement accuracy applies to the interpolated supplied trajectories, not an
unprovided orbit between them. Single-double Julian dates near modern epochs
have roughly 40 microseconds of representation spacing.

`propagator/events.locate_access_windows` compiles this same C++ evaluator and
uses the same `$ACW` request/result. Its original `$EVL` methods remain available.
No production JavaScript computes constraint geometry.

Additional validation:

```sh
node --test tests/constraints.test.mjs tests/orekit-elevation.test.mjs tests/orekit-night.test.mjs
node tests/constraints-parity.mjs
```

The independent Orekit fixture includes its Java generator, published expected
edges, data and dependency hashes. Closed-form fixtures cover attribution,
range extrema, nested composition, moving observers, body interpolation,
blackouts, and narrow angular/limb/lighting intervals. Every numerical fixture
states units, frame, time scale, tolerance, and its rationale.

The Orekit civil-night reference uses a fixed zenith target and a 96-degree
solar-exclusion threshold, exactly equivalent to the published -6-degree Sun
elevation condition. Its independent Sun samples and Java generator are in
`tests/data/orekit-night.json` and `tests/data/OrekitNightReference.java`.
