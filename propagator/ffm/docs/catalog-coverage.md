# Catalog coverage

The entity renderer can use the same configured `ResidentDynamics` as the PRW
resident profile. It shares force parsing, verified SPK ownership, environment
validation, automatic GJ8/Sundman policy, dense output and PPE fitting. There is
no separate catalog force model.

Call `plugin_init`, then `plugin_configure_catalog(records, byteLength,
bstars, count)`, then `plugin_init_states_ecef(states, count)`. Configuration
records are concatenated size-prefixed PRW frames: one EXECUTION_REQUEST, one
NATIVE_INPUT containing the SHA-256-described SPK, EARTH_ORIENTATION,
SPACE_WEATHER, and optional JB2008_INDICES for a local custom atmosphere.
`catalog-configuration.mjs` supplies browser-compatible encoding and the FFM-1
default request; its `forces` option overrides canonical PRW force fields.
All inputs follow the resident profile's validation. Never publish licensed
JB2008 driver rows to browsers.

Each seed has seven doubles: UTC Julian date followed by ECEF meters and m/s.
EOP drives both seed conversion and rendered output. One B* belongs to each
seed slot, including invalid zero rows. The module computes Cd*A/m with
`plugin_drag_area_over_mass_from_bstar(bstar, 0.01)` and uses Cr*A/m = 0.02.
Per-object coefficients do not change the profile name.

`plugin_ensure_coverage(utcJD, start, count)` prepares the shared resident PPE
coefficients. `plugin_eval_positions` evaluates only those coefficients and
preserves coverage-edge clamping; `plugin_eval_states` requires actual coverage.
`plugin_eval_catalog_states_gcrf` returns evaluation-only inertial SI states.
`plugin_catalog_transform_state` converts an SI state using the configured EOP
(inverse=0 GCRF to ITRF, inverse=1 ITRF to GCRF), including velocity transport.
No host propagation, polynomial fit or frame physics is required.

The retained catalog window is at most 1,800 seconds behind the requested
coverage epoch (a smaller positive `plugin_set_ephemeris_retention` is honored),
plus intersecting 300-second segments. The shared fitter trims dense history.
Older requests rebuild from the seed; hosts should reseed on large time jumps.

`plugin_get_profile()` returns `FFM-1`, `custom`, `diagnostic` or `unconfigured`.
The FFM-1 comparison uses a generated copy of the canonical catalog defaults,
including every force selector. Changed diagnostic setters invalidate an active
catalog rather than silently modifying it. Rebuild the instance for new
catalog configuration or inputs. Burns belong to the independent focus instance.
Negative return values are explained by `plugin_catalog_error()`.

Run `node propagator/ffm/scripts/e2e-catalog-coverage.mjs` from the module repo.
It records one-day dense-state agreement for eight regimes, single-thread CPU,
real headless-browser memory at 1k/10k entities, and shared resident PIV parity.
The diagnostic pointer exports are browser-host surfaces; the SDK process
harness exposes canonical PIV methods. The existing `scripts/e2e-ffm.mjs`
separately qualifies resident dynamics against independent study truth.
Docker WasmEdge is waived by the owner's 2026-10-22 ruling; this E2E runs
headless Chromium and native WasmEdge without starting Docker.
