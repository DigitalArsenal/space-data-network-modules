# Ballistic mission screening

This C++/WASM adapter evaluates explicit mission budgets from the published
Lambert `$PCE` mesh. It does not solve another Lambert problem. Units are SI;
departure and arrival states must refer to the same inertial frame, continuous
time scale, epoch origin and center. The caller composes ephemeris → Lambert →
screening through existing module ports. No trajectory calculation runs in JS.

`screen_grid` takes one `request` PCE and 1–400 `mesh` PCE frames in departure-row
order. Each row has at most 400 cells. The Lambert artifact is read-only.
This version accepts **zero-revolution** cells: Lambert retains a branch by
sum-of-v∞, so a later budget transform cannot select alternative multi-revolution
branches. The result is a sampled screening result, not a continuous optimum.

| Output | Meaning |
| --- | --- |
| `departure_c3` | Squared departure hyperbolic excess speed, m²/s² |
| `departure_vinf`, `arrival_vinf` | Endpoint hyperbolic excess speeds, m/s; Lambert's legacy `departure_dv` and `arrival_dv` |
| `sum_vinf` | Sum of endpoint hyperbolic excess speeds; no parking-orbit interpretation |
| `parking_injection` | Circular departure orbit → hyperbola impulse: √(v∞² + 2μ/r) − √(μ/r) |
| `flyby_impulse` | Zero for this direct-transfer adapter; Star reports its powered flyby patch separately |
| `capture` | Arrival hyperbola → circular target orbit impulse, using arrival μ and radius |
| `total_impulse` | Parking injection + flyby impulse + capture |

The request is a PCE evaluation sample of `PROVIDER_DEFINED` values (serialization
helper: `codec.mjs`). All scalar values have an absent `VALUES` vector. Supply:

- Text: `ephemeris`, `center`, `reference_frame`, `time_scale`, `epoch_origin`,
  `provenance`, and `objective` (one of the table's scalar metrics, except
  `flyby_impulse`). Ephemeris/center/provenance are caller declarations: the
  Lambert mesh carries only frame/time/epoch, which the adapter checks.
- `departure_mu`, `arrival_mu`: `PROVIDER_DEFINED` units, with catalog symbol
  `m^3/s^2`; positive finite gravitational parameters.
- `departure_parking_radius`, `arrival_parking_radius`: `METRE`; measured from
  each body's center, not altitude above its surface.
- `grid_step`: `SECOND`; `page_offset`, `page_size` (1–160000) and `cancelled`
  (0 or 1): `DIMENSIONLESS`.

The `mesh` output preserves row-major `cell_index`, epochs, and Lambert's status
(0 solved, 1 nonpositive flight time, 2 undefined plane, 3 nonconvergence).
Invalid cells retain their status and have NaN budgets. `best` ranks **all input
cells**, independent of the page, with the first row-major cell winning ties.
It includes `total_cells` and `next_offset`. Model/context and sampled step are
repeated in every result. An empty valid set reports `no-valid-cells`.

`cancelled=1` returns a cancellation report without budgets. For an already
running synchronous invocation the host must terminate its dedicated worker or
WasmEdge process; the module never claims mid-invoke cooperative cancellation.

Build after `npm ci` in this directory: `npm run build`. The lock pins released
SDS 1.252.0, SDK 0.9.8 and flatc-wasm 26.1.38. Headers are generated from the
installed schemas; no schema source or scratch oracle code is vendored.
The budget kernel and header generator are also consumed by Star.

From the modules root, the single flow E2E is:

```
node --test analysis/mission-screening/tests/mission-screening.e2e.test.mjs
```

Install root and both package dependencies first. The E2E consumes the committed
Lambert/solar-system-bodies WASM and both new artifacts. Set
`MISSION_SCREENING_KERNEL_DIR` to a public NAIF kernel cache, or let the test
download the two SHA-256-pinned kernels into ignored `tests/data/`. WasmEdge
0.16.4 development headers/library, `wasmedgec`, and clang are required for the native Star
host (default `~/.wasmedge`, or `MISSION_SCREENING_WASMEDGE_ROOT`). AOT is
a temporary compilation of the exact committed WASM, never a product rewrite.
The test supplies an ephemeral, in-memory Ed25519 signer through the
actual typed `keyslot.sign` hostcall; no production keys are used.

For independent numerical replay, `MISSION_SCREENING_EVIDENCE` writes the
sampled states, selected grid cells, budgets and Star residuals to an external
JSON evidence file. It does not change the expected values. The grid checks
use Sun-centered ICRF/TDB, Earth 399 and **Mars barycenter 4**, one-day sampling,
and a 0.001 km²/s² C3 tolerance. The authoritative Star fixture is the existing
upstream `5c66706` E–M–E–J data, with 33 trajectories and a 1e-8 km/s tolerance
for the native-to-WASM patch-cost comparison. TDB epoch serialization is checked
within 1 microsecond.
