# TMPL lane 13 — HPOP PRW migration handoff

## Scope and artifact

Implementation of proposal §6.2 (H1a–H1d and B1h), consuming **published
`spacedatastandards.org@1.220.0`** and canonical **SDK 0.8.18**. The isolated
`tmpl/13-hpop-prw` worktree starts at
`ee14a6836727d4aedc8693477fcd6c3f2bb45090`. No publication, deployment, main merge,
credential access, or canonical-checkout source changes were performed.

The root and HPOP package pin SDS exactly to `1.220.0`, with lockfile updates.
`generate-sds-bindings.mjs` recursively consumes the installed npm package IDL,
then generates C++ and test JavaScript object bindings. No local FlatBuffer
contract was authored. The deployed scientific payload root is always PRW;
PIV/TAB remain the SDK-owned streaming envelope.

Final artifact: `propagator/hpop/dist/isomorphic/module.wasm`, **1,014,366 bytes**.
SHA256:
`7305c5ef6db04cfb5babc4f2c5f87b17b1e5901e4c14bd25cf9ca7b14b7b48b1`.
The retained browser diagnostic wrapper uses these same bytes. Compiler and
exception-runtime archive provenance is recorded in
[dist/build-provenance.json](../propagator/hpop/dist/build-provenance.json).

## What changed

| Proposal item | Implementation |
| --- | --- |
| H1a typed dispatch | New named C++ execution/configuration values, structural PRW verification, exactly-one-arm enforcement, method/arm checks, and named PIV errors. Public invoke no longer parses JSON. |
| H1b resident state | PRW state/request records, SI state transport, explicit ISO/TIM epochs and RFM axes, UTC-to-TDB conversion in C++, ordered opaque handles, atomic ingest, generation invalidation, and explicit rejection of unsupported resident controls. |
| H1c trajectory export | Original 13 Chebyshev coefficients and explicit velocity coefficients exported through nested PPE; interval coverage separated from unmeasured fit quality; complete-source chunks and deterministic continuation. |
| H1d rich dynamics | Six/seven-state STM and covariance, cumulative samples, impulses, finite burns, PCE events, atmosphere queries, ephemeris queries, typed version result, and verified NCD/SPK bytes inside PRW.NATIVE_INPUT. |
| B1h build/evidence | `build.mjs` calls `compileModuleFromSource`, SDK validates/embeds PLG and owns PIV/allocators/command framing, compliance script added, canonical artifact and runtime/numerical receipts regenerated. |

All advertised ports use `schemaName:"PRW.fbs"`, `fileIdentifier:"$PRW"`,
`rootTypeName:"PRW"`, `wireFormat:"flatbuffer"`. The manifest no longer advertises
variable-sized records as fixed aligned layouts. The required method mapping is:

| Method/port | PRW arm |
| --- | --- |
| `invoke.request` / `response` | EXECUTION, EPHEMERIS, ATMOSPHERE request/result pairs, or VERSION_QUERY/RESULT |
| `invoke.kernel` | NATIVE_INPUT |
| `ingest_state.state` | RESIDENT_STATE |
| `propagate_state.request` / `state` | RESIDENT_REQUEST / RESIDENT_STATE |
| `prepare_trajectory_segments.request` / `result` | PREPARE_REQUEST / PREPARE_RESULT |
| `describe_trajectory_segments.request` / `result` | DESCRIBE_REQUEST / DESCRIBE_RESULT, with PPE nested |

### Numerical and lifetime boundaries

- Dynamics remain C++/WASM. JavaScript performs host orchestration and binary
  representation conversions. Covariance uses `D P Dᵀ`; STM uses
  `D_out Phi D_in⁻¹`, including the unscaled kg mass component.
- The typed configuration separates the TDB integration clock from UTC weather
  metadata. Atmosphere evaluation receives UTC; ephemeris and dynamics retain
  TDB. Native diagnostic defaults remain unchanged.
- Published PRW throttle is piecewise linear. A new explicit C++ control selects
  that behavior; the existing diagnostic zero-order-hold behavior remains intact.
  The PRW rocket fixture uses a linear curve with the same independently
  integrated thrust duration. The original lane-04 native fixture is unchanged.
- PCE event direction, SI goal, and positive goal tolerance are checked. The
  solver reports failure if a computed root does not meet the requested goal
  tolerance. An unreached time remains absent through its HAS_* flag; zero is
  preserved as an actual initial-epoch edge.
- Initial dynamical mass takes precedence over the force configuration fallback.
  Six- and seven-state covariances may coexist. Duplicate initial covariance
  sources, invalid dimensions, nonfinite/asymmetric/non-PSD input, and nonfinite
  transported results are rejected.
- A supplied kernel requires SPK_DAF, exact SOURCE_BYTE_LENGTH, and matching
  SOURCE_SHA256. Kernel selection and coverage failures never become an implicit
  analytical fallback.

The build uses `wasm32-wasip1-threads`, **`threadModel:"wasi-sequential"`**, and
shared memory. A resident instance owns ordered state/cache mutations and runs
one invocation at a time; independent instances can run concurrently. Browser
COOP/COEP isolation remains required.

SDK 0.8.18 exposes one `sourceCode` entry and defaults to no C++ exceptions. The
public `SDN_WASI_CLANGXX` compiler driver supplies the listed separate C++/C units,
repo-local LLVM toolchain, standard Wasm exception ABI archives, and the existing
256 MiB initial memory. It never invokes system `emcc` or replaces SDK PIV/PLG
code. `plugin_runtime.cpp` is not part of the canonical public artifact; its
existing CMake O0/no-LTO workaround remains unchanged.

Command/reactor constructor entry paths previously registered/destructed global
C++ state twice and trapped on error responses. An idempotent constructor wrapper
and `-fno-c++-static-destructors` give globals the resident instance's lifetime;
the host reclaims memory when the instance is destroyed. The existing
`__wasm_call_ctors` export also supports the SDK's persistent WasmEdge service
runner. A thin final-link initialization unit preserves that exact export name,
which LLVM otherwise loses in its relocatable link. Direct and command error paths now pass without changing physics
optimization levels.

## Completion gates and evidence

Commands run from `propagator/hpop`, with
`PATH="$HOME/.wasmedge/bin:$PATH"` for module/runtime tests. Dependencies were
installed in the isolated package directory with `npm ci`.

| Gate | Result | Receipt |
| --- | --- | --- |
| `node build.mjs` | PASS, canonical SDK artifact validation | [build-final.log](../propagator/hpop/tests/evidence/lane13/build-final.log) |
| `node --test tests/sdk_compat.test.mjs` | 9 passed, 0 failed, 0 skipped | [sdk-compat-final.log](../propagator/hpop/tests/evidence/lane13/sdk-compat-final.log) |
| `npm test` | 53 passed, 0 failed, 0 skipped | [npm-test-final.log](../propagator/hpop/tests/evidence/lane13/npm-test-final.log) |
| `npm run check:compliance` | 0 standards-aware/artifact errors; 10 audited `no-aligned-peer` warnings | [compliance-final.log](../propagator/hpop/tests/evidence/lane13/compliance-final.log) |
| PLG round-trip and canonical exports | PASS, authored/embedded manifests agree | Same compliance and SDK receipts |
| DE440 command parity | 6 cases; 138 comparisons; PASS | [kernel-parity.json](../propagator/hpop/tests/evidence/lane13/kernel-parity.json) |
| Variational command parity | 10 cases; 230 comparisons; PASS | [variational-parity.json](../propagator/hpop/tests/evidence/lane13/variational-parity.json) |
| Finite-burn command parity | 45 cases; 1,035 comparisons; PASS | [finite-burn-parity.json](../propagator/hpop/tests/evidence/lane13/finite-burn-parity.json) |
| Malformed/unsupported command parity | 18 cases; 381 comparisons; PASS | [prw-parity.json](../propagator/hpop/tests/evidence/lane13/prw-parity.json) |
| Persistent resident parity | 20 requests × 3 runtimes; exact bytes/classifications; PASS | [resident-stateful-parity.json](../propagator/hpop/tests/evidence/lane13/resident-stateful-parity.json) |
| Native resident numerical/contract suite | 6 passed, 0 failed; 1 diagnostic-only skip | [resident-native-final.log](../propagator/hpop/tests/evidence/lane13/resident-native-final.log) |
| Container resident numerical/contract suite | 6 passed, 0 failed; 1 diagnostic-only skip | [resident-container-final.log](../propagator/hpop/tests/evidence/lane13/resident-container-final.log) |

Each command parity receipt identifies the final artifact hash and tests the
same bytes in real Chrome/V8, native WasmEdge, and container WasmEdge with
worker-count settings 1/2/4/8. This is a sequential shared-memory profile, not a
claim of guest parallel speedup. Empty/truncated/malformed PIV/PRW, ambiguous
arms, unsupported controls, and physical failure responses have identical
classifications across runtimes. Positive scientific responses are byte-identical.

Persistent-instance tests independently establish state continuity, source/chunk
ordering, atomic rejection, and generation/segment invalidation in real
Chrome/V8, native WasmEdge, and container WasmEdge. Each platform executes the
same 20 requests in two resident-instance groups. The native/container suites
skip only direct diagnostic C-export mutation: the public SDK process harness
exposes PIV methods, while that diagnostic test passes in the full browser suite.
Container launch uses Docker's init process so the SDK's SIGTERM teardown reaches
the resident runner; no SDK runner source is patched.

## Preserved authoritative numbers

[The comparison receipt](../propagator/hpop/tests/evidence/lane13/native-comparison.json)
compares **109 native numerical RESULT lines** before/after and finds every line
**exactly unchanged**, excluding timing. These comprise 75 finite-burn checks,
24 variational cases, and 10 DE440 force cases, all with zero failures. Raw logs:
[before](../propagator/hpop/tests/evidence/lane13/baseline.log),
[after](../propagator/hpop/tests/evidence/lane13/native-after.log).

Representative unchanged results:

| Quantity | Measured error/result | Retained bound |
| --- | --- | --- |
| DE440 Sun differential acceleration | `2.7745692215067836e-22 km/s²` | `1e-18 km/s²` |
| Kernel-Sun SRP acceleration | `0 km/s²` | `1e-18 km/s²` |
| Eccentric one-orbit analytic STM | relative error `3.041679099438583e-14` | `1e-9` |
| J2 symplectic identity | error `1.9669591394513481e-13` | `1e-9` |
| Tsiolkovsky Δv | error `3.535366444040733e-15 km/s` | `2e-11 km/s` |
| Tsiolkovsky mass | error `1.836042429204099e-10 kg` | `2e-8 kg` |
| Orekit final mass | `2007.882454426169 kg`, error `4.547473508864641e-11 kg` | `1e-8 kg` |
| Orekit inclination | `2.687177005226931°`, error `2.299477306921816e-5°` | `1e-4°` |
| Orekit semimajor axis | `28970.06620405709 km`, error `0.06620405708599719 km` | `1 km` |

The migrated WASM invokes preserve the original physical-unit bounds: 12 CSPICE
states have maximum position error `1.4901161193847656e-8 km` and velocity error
`1.7763568394002505e-15 km/s`; four Kepler STM cases have maximum relative error
`8.561445106097466e-15`. Zero failures does not mean every floating-point
residual is numerically zero.

Authority, frame, time, units, and per-case tolerance rationale remain in the
existing tests. DE440 is geometric ICRF/J2000 at TDB epochs, validated against
NAIF CSPICE records in the committed fixture. The force reference uses Newtonian
differential gravity and IAU photon-momentum constants. STM references use
[Battin/MIT 16.346](https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/).
Finite burns retain the [NASA ideal rocket equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/ideal-rocket-equation/),
[MIT propulsion spiral approximation](https://ocw.mit.edu/courses/16-522-space-propulsion-spring-2015/7f725e54b9be201164d56ebbd5e08023_MIT16_522S15_Lecture6.pdf),
and [Orekit 13.0.1 ConstantThrustManeuverTest](https://www.orekit.org/site-orekit-13.0.1/xref-test/org/orekit/forces/maneuvers/ConstantThrustManeuverTest.html#L268).
The autonomous Orekit point-mass case retains its published elapsed interval;
no new absolute TDB interpretation is asserted for its UTC fixture.

## Remaining debt and faithful profile limits

- This implements proposal §6.2, not full TMPL capability parity. Resident
  per-object covariance, mass, gravitational-parameter overrides, and ballistic
  coefficients fail explicitly; rich supported dynamics use EXECUTION_REQUEST.
- Only Earth-centered ICRF axes (GCRF) are supported for propagation. Earth-fixed
  and TEME transformations and tesseral gravity require authoritative EOP data
  absent from this profile. PRW gravity defaults to zonal order zero, with inline
  spherical degree at most 20 and embedded EGM2008 degree 2–70; custom EGM μ and
  unsupported truncations fail. This does not claim a certified global gravity
  model or complete frame/time provider.
- ABM, ENCKE, and EQUINOCTIAL_VOP fail rather than enter the old result
  dispatcher's RKF78 fallback. Existing verified restrictions on analytic STM,
  finite burns, forward propagation, and event ordering remain enforced.
- Component tolerances must map to the existing scalar km-based solver tolerance;
  arbitrary mixed component tolerances need a separate integrator enhancement.
- TIM support is explicit JD/MJD/ISO and UTC Unix seconds; UTC before 1972 and
  unsupported clock representations fail. FRM uses ISO text with nine fractional
  digits. No historical/future timing-data certification is added.
- PRW and PPE have different fit-quality expressiveness. PRW reports UNMEASURED
  with unavailable bounds; PPE's default residual scalars cannot distinguish
  absence from zero, so those fields are omitted and a comment points to PRW.
  No zero-error or certified-accuracy claim is made.
- SDS's general aligned-peer wording and the SDK's fixed-layout restriction still
  need upstream reconciliation. Ten canonical-only variable-length warnings are
  audited and retained; no compliance exception or fake aligned record is added.
- SDK 0.8.18 has no guest output-cap accessor. Resident methods emit one complete
  state/source per chunk, respecting every positive cap, with explicit backlog
  and continuation. Multiple interleaved continuations require a broader runtime
  contract.
- The SDK's public compiler hook currently accommodates multiple C++ units,
  standard Wasm EH, constructor lifetime, and diagnostic exports. Upstream SDK
  options could replace this local driver later. Legacy CMake/diagnostic source
  remains separate evidence and is not a public JSON physics ABI.

The worktree is retained. The coordinator should review and land the pushed lane
branch; this lane must not merge to main.
