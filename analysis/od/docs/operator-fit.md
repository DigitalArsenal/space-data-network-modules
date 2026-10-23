# Operator-seeded FFM fit

`fit_ffm` estimates the six GCRF epoch-state components and effective ballistic
coefficient, B_eff = (1-kappa) B. Only B_eff is identifiable from one arc. Kappa
is emitted only when CONFIG supplies a positive `ballisticPrior`; it is relative
to that prior, not an independently observed thrust fraction. The current
resident dynamics contract requires B_eff >= 0. A boundary result is labelled;
it cannot represent net acceleration from kappa > 1.

Supply exactly one ephemeris: `meme` ($FIL containing MEME or OEM KVN), or `oem`
(an unprefixed SDS $OEM). Supply the existing FFM $PRW `configuration`, `kernel`,
`earth_orientation` and `space_weather` inputs. Optional `density_correction`
is the published $DCL log-density series: drag uses NRLMSISE-00 times exp(s).
Absence of DCL is labelled and means uncorrected NRLMSISE-00. Ephemerides stay
in memory; neither the fit nor its E2E persists raw operator or SupGP records.

The configuration uses FFM's catalog full-force profile: EGM2008 70x70, JPL
third bodies, solid/ocean tides, radiation, relativity and NRLMSISE-00. This
release does not qualify a reduced-force profile. EOP and weather are explicit
inputs, not network calls inside the fit. The E2E uses local EOP and DE440s,
and the space-weather module's GFZ/NOAA source plan and WASM parser.

## Reused libraries and frames

This extends analysis/od's existing general OD path associated with
`od-core-20261012`: the MEME/OEM StateSeries parsers, SGP4 element fitter and
record builders are shared. That broader graph task is not claimed or closed.
The fit calls the existing FFM Fast `ResidentDynamics`, including its DCL
attachment. It does not introduce a second force model. The seven-column LM
Jacobian uses finite differences through that library; it does not expose or
claim to use the private STM from `ResidentDynamics::covariance`.

MEME states are EME2000. UVW describes their covariance only. The parser's TEME
state contract is reversed before the ERFA EME2000/GCRF frame bias is applied.
OEM state input is restricted to full EME2000/J2000/GCRF states. Operator
covariance uses the same inertial RTN/UVW convention and shared frame triad as
gp-error-model 0.10.0 `source_covariance`. The module does not link that module's
host entry point. OEM covariance at a matching sample epoch is retained from
both text and typed inputs; supported covariance axes are GCRF/ICRF,
EME2000/J2000 and inertial RTN/RSW/RIC/UVW. Other covariance axes fail explicitly.
There is no covariance interpolation or extrapolation in this fit.

## Windows, outputs and controls

The fit excludes the sample at 48 hours, where the SpaceX blend joins. A
`fitWindowSeconds` above 172800 is refused. One-step innovations between source
states detect discrete events before fitting. The default thresholds are
0.1 km position or 0.001 km/s velocity; the event epoch is bounded by the two
samples. A segment needs eight samples. MNV describes the innovation interval,
not a reconstructed burn time or executed delta-v. Detection resolution and
sensitivity depend on sampling and these configured thresholds.

Each segment emits $OCM, $OMM and $OBD; each detected event emits $MNV. OCM carries
the fitted GCRF state, B_eff, optional prior-relative kappa, fixed SRP, residuals,
convergence and source labels. Its primary covariance is the operator's epoch
covariance (rule 1). The formal state covariance is separately labelled in
USER_DEFINED_PARAMETERS when convergence and numerical rank permit it. At the
zero-B bound it is conditional on B_eff = 0. It is unweighted fit uncertainty,
not calibrated prediction uncertainty. OMM/OBD use the existing SGP4 fitter on
the segment's first 11520 seconds or its shorter available span.

| CONFIG | Default | Meaning |
| --- | --- | --- |
| `fitWindowSeconds` | 172800 | Exclusive end from the first source epoch |
| `sampleSeconds` | 600 | Maximum supported downsampling interval, seconds |
| `maxIterations` | 12 | LM iterations, 1–100 |
| `ballisticSeed` | 0.003 | Initial effective Cd*A/m, m²/kg |
| `ballisticPrior` | 0 | Positive physical B prior enables kappa |
| `srpAreaOverMass` | 0.02 | Fixed Cr*A/m, m²/kg; never fitted |
| `maneuverPositionKm` | 0.1 | One-step position innovation threshold |
| `maneuverVelocityKmS` | 0.001 | One-step velocity innovation threshold |
| `warmStart` | false | Use supplied GCRF state at the new source epoch |
| `warmX/Y/Z`, `warmVx/Vy/Vz` | 0 | Warm state in km and km/s |
| `dataSource` | empty | Caller-supplied provenance label |

For a new cycle, propagate the previous OCM through FFM to the new source epoch
before supplying the warm state and previous B_eff. The E2E measures only a
same-epoch warm replay, not an eight-hour cycle benchmark. Cost scales with
iterations, force evaluations and span; sampling is at most ten minutes.

## Build and exact-change E2E

From the modules worktree, with Eigen headers and the SDK WASI toolchain:

```sh
npm --prefix analysis/od ci
SDN_OD_EIGEN_DIR=/opt/homebrew/include/eigen3 node analysis/od/build-wasi.mjs analysis/od/dist/isomorphic/module.wasm
node analysis/od/scripts/e2e-operator-fit.mjs
```

The SDK's FFM catalog marshaler also needs its package dependencies provisioned
in `propagator/ffm/node_modules`. The build reads FFM source and its manifest
identity in place, uses one `.build-operator` tree, and validates the canonical
WASI artifact. It does not build the legacy Emscripten browser artifact.

The E2E fits all 25 public 2026-10-09 files with and without constant DCL s=ln(2),
using six iterations and 600-second samples. It records per-file RMS, B_eff,
convergence, wall time and CPU time. The first pair runs alone in its browser;
remaining independent fits use up to eight isolated headless browsers to stay
within the graph runner's ten-minute command budget. Concurrent throughput is
not a host-02 capacity qualification. The acceptance median is below 0.6 km;
the historical 0.6–0.75 km measurement crossed the blend join and is not an
independent prediction benchmark.

The same E2E checks the independent REFERENCE_RMS frame gate, refusal beyond
48 h, planted-maneuver segmentation, OEM covariance preservation, nonzero
B_eff scaling with doubled density, browser/native WasmEdge byte parity on a
two-hour DCA fit, and exact-artifact node `prewarm-aot` on WasmEdge 0.16.4.
Docker is waived by the owner (2026-10-22). No unit suites are run.

Default inputs live in the owner's `/opt/data/sdn-archive`. `OD_FIXTURES`,
`OD_REFERENCE_CSV`, `OD_EOP_FILE`, `OD_KERNEL_FILE`, `SDN_NODE_BINARY` and
`OD_REPORT` override paths. `OD_FIXTURE_LIMIT` is for diagnostic pilots only;
acceptance uses 25. The native SDK runner accepts `WASMEDGE_INCLUDE_DIR` and
`WASMEDGE_LIB_DIR` for the pinned local 0.16.4 SDK. Run this command on the
owner-selected host to check a shipped artifact; this task does not deploy or
restart production. Independent prediction validation remains a separate live
check against the first hours of a fresh operator file.
