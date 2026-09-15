# TMPL lane 04 handoff — finite HPOP maneuvers

## Delivery and acceptance

Branch: **`tmpl/finite-04`**, based on current-at-start `origin/main`
**`902da63d7196a62fd1837de90574be678479a5c9`**, including lane 03.
Private worktree: `/Users/tj/software/worktrees/modules-finite-04`.

**Finite-burn numerical implementation and focused native/WASM checks pass.**
**SDK admission remains blocked by the existing HPOP contract.** The artifact
uses HPOP's diagnostic local-emSDK CMake build; it is not an SDK-compliant
publication candidate. The SDK-source admission probe rejects 27 manifest /
standards errors before compiler selection. Artifact compliance retains exactly
the same 11 `code/location` errors as the base artifact. No failing check was
weakened and no schema was invented.

Source implementation commit: `5840077ad5c823c75b9dcdf803b7e7fa2d8e8ea2`.
Validation fix: `dd1b9a0eef0be0269ba58ae6c55a74926c13f3fe`.
Authoritative tests: `c5e2c027e6160037320b6302e997160cba76685c`.
The artifact/handoff commit follows these; its exact pushed SHA is supplied in
the coordinator-facing final response (a commit cannot contain its own SHA).
**Tri-runtime parity passes: 49 finite-burn cases, 10 existing STM cases and
6 existing kernel cases are byte-identical in all three runtimes.**
The coordinator owns integration; no main merge, stack pin, publication,
deployment, production restart, or standards change is part of this lane.

## Implementation

- `finiteBurns` extends the existing JSON `invoke` / `propagate` control surface.
  All production dynamics execute in C++ WASM. One coupled state integrates
  Cartesian position/velocity, mass, a 7×7 STM, and per-burn scalar delta-V and
  propellant integrals. Existing six-state requests retain their previous path.
- Constant thrust in N or prescribed acceleration in km/s², positive Isp in s,
  and `g0=9.80665 m/s²`. Thrust mode uses `a=T/(1000m)` and
  `dm/dt=-T/(Isp*g0)`; prescribed acceleration changes thrust with current mass.
  Drag and cannonball SRP also use the propagated mass.
- Directions: inertial, RTN/LVLH, VNC, velocity, anti-velocity. LVLH explicitly
  aliases RTN here. Vector frames optionally use linear steering followed by
  normalization. Steering and throttle clocks remain tied to the original epoch.
- Scheduled edges accept elapsed seconds or JD TDB. Throttle is a zero-order
  hold table in `[0,1]`; zero throttle provides duty-cycle coast intervals.
  Start/stop, throttle, and existing impulse epochs force step boundaries.
  Endpoint stages use the force on their own side of each boundary.
- Event starts/stops reuse `propagator/events` scalar stopping functions and
  Brent refinement: radius, speed, radial velocity, inertial z/node, or mass.
  Search windows remain explicit. Summary flags distinguish event transitions
  from scheduled window termination and report unmet start events.
- Analytical mass and moving-direction derivatives drive the STM. State-event
  transitions apply saltation matrices to include changes in crossing time;
  existing impulse Jacobians extend to seven states with unchanged mass.
  Optional `covariance7` transports mass uncertainty and cross-covariances;
  existing six-state covariance treats initial mass as exact. No process noise.
- Outputs and samples include mass, `stm7`, the six-state STM projection,
  covariances, and cumulative per-burn delta-V / propellant / transition summaries.
  Samples are independently propagated from the original epoch.
- RKF78/RK78 add full-step versus two-half-step error control: the inherited
  embedded estimate can vanish for explicit-time thrust or linearly decreasing
  mass despite nonzero quadrature error. A negative-mass trial stage is rejected
  and retried so an earlier positive-mass cutoff can still be located. Boundary
  roots can switch modes without an artificial minimum-step delay.

The [HPOP README](../propagator/hpop/README.md#finite-burns-with-propagated-mass-tmpl-lane-04)
contains the request example, units, controls, result fields, and limitations.

## Authoritative numerical evidence

Unless stated otherwise, native cases use Earth-centred J2000 inertial axes,
JD2451545 TDB as origin, elapsed dynamical seconds, km, km/s, kg, N, and seconds
of Isp. The Earth point-mass parameter is `398600.4418 km³/s²`; environmental
forces are disabled. Every fixture declares its source, units, frame/time,
tolerance, and rationale in `tests/finite_burn_native.cpp` or
`tests/finite_burn_invoke.test.mjs`. No captured output from the implementation
under test serves as an oracle.

| Case | Final measured error | Bound and rationale |
| --- | ---: | --- |
| Orekit published finite burn, final mass | 4.547473508864641e-11 kg | 1e-8 kg; linear mass flow, RK summation allowance |
| Orekit published finite burn, inclination | 2.299477306921816e-5° | 1e-4°; exactly Orekit's rounded-reference bound |
| Orekit published finite burn, semi-major axis | 0.06620405708599719 km | 1 km; exactly Orekit's rounded-reference bound |
| One-day tangential thrust, Tsiolkovsky integrated delta-V | 3.535366444040733e-15 km/s | 2e-11 km/s; exact rocket equation, numerical accumulation only |
| Same tangential burn, final mass | 1.836042429204099e-10 kg | 2e-8 kg; exact linear mass flow |
| Same low-eccentricity spiral, semi-major axis | 2.993944690388162e-6 km | 5e-4 km; near-circular approximation neglects eccentricity terms |
| Impulsive limit, duration 10 → 1 → 0.1 s | 6.290244248400663e-6 → 7.872038673578625e-8 → 3.515031142889315e-9 balanced km | Each decade reduces error by at least 4×; final bound 2e-5 balanced km |
| All five physical direction choices, STM7 central differences | max 2.201741889614438e-10 relative | 3e-6; balanced Frobenius comparison, independent whole-arc perturbations |
| Five stop-event types, STM7 central differences | max 9.995246709827583e-8 relative; half perturbation max 2.495315764815306e-8 | 5e-6; two perturbation sizes check truncation/cancellation |
| Node-triggered start, STM7 | 1.504440090513924e-9; half perturbation 4.895353161573121e-10 | 5e-6; includes state-dependent start time |
| Overlapping acceleration burns plus impulse, exact STM7 / covariance | 2.842170943040401e-14 / 1.4210854715202e-14 maximum entry error | 1e-10; elementary constant-acceleration and exponential-mass flow |
| Drag / SRP / combined initial-mass columns, two perturbation sizes | max 4.35272400237681e-7 relative | 1e-5; balanced dynamical mass-column comparison, excluding trivial Phi_mm |
| High mass flow, positive dry-mass cutoff, rocket delta-V | 8.881784197001252e-16 km/s | 1e-9 km/s; exact rocket equation |
| Same cutoff, max-step 2 → 0.02 s position convergence | 2.459816853617074e-11 km | 1e-8 km; independent step refinement |

**Orekit case.** Source is `ConstantThrustManeuverTest.testRoughBehaviour`,
Orekit 13.0.1, lines 268–321, with `mu=398600.47 km³/s²` from its setup.
Initial elements are a=24396.159 km, e=0.72831215, i=7°, argument of periapsis
180°, RAAN 261°, and true anomaly 0°. The published frame is EME2000 and epoch
is 2004-01-01T23:30:00 UTC. Initial mass is 2500 kg, thrust 420 N, Isp 318 s;
inertial direction RA=351°, Dec=-7.4978°. Start is 17134.08 elapsed seconds,
duration 3653.99 seconds, final epoch 20934.08 elapsed seconds. Expected final
mass is 2007.8824544261233 kg, inclination 2.6872°, and semi-major axis 28970 km.
The test independently converts elements to Cartesian coordinates. Because the
point-mass problem is autonomous, it preserves the source axes and elapsed
seconds using JD2451545 as a computational origin; it does not claim to test
EME2000/GCRF or UTC/TDB transformations. Actual WASM also passes these published
bounds: mass error 4.547473508864641e-11 kg, inclination error
2.2994773068774066e-5°, semi-major-axis error 0.06620405697685783 km.

**Spiral and rocket equation.** Start at a circular 7000 km orbit, m0=1000 kg,
T=0.1 N, Isp=3000 s, burn along instantaneous velocity for 86400 s. The exact
scalar propulsion integral is `Isp*g0*ln(m0/mf)/1000` km/s. Integrating the
near-circular energy equation gives `a≈a0/(1-deltaV/v0)^2`; thrust/gravity ratio
is about 1.23e-5. Expected approximate a=7016.059505875884 km; actual
7016.059508869828 km. Delta-V denotes the acceleration-magnitude integral,
not the final-minus-initial velocity vector.

**Impulsive limit.** Fix delta-V at 0.001 km/s with initial mass 1000 kg and
Isp 300 s. For duration D choose
`T=m0*Isp*g0*(1-exp(-1000*deltaV/(Isp*g0)))/D`. Centre each burn on the same
representable impulse epoch, propagate to a common final epoch, and compare
with lane 03's inertial impulse result. The balanced error is
`|delta-r| + (1000 s)*|delta-v|`; it decreases at every tested duration.

STM finite differences use 20 m position, 2 cm/s velocity, and 0.02 kg mass
perturbations, plus half these sizes for events. Matrix comparison balances
coordinates with `D=diag(1,1,1,0.001,0.001,0.001,1)` and compares
`D^-1 Phi D`. Supplementary analytical tests cover normalized frame directions,
asinh/sqrt steering integrals, exponential mass, and exact throttle area.
Additional mass-column tests enable drag, SRP, and both, separately, on a
120-second illuminated arc near 400 km altitude. Initial mass is 1000 kg;
drag area 10000 m² and SRP area 100000 m² deliberately amplify sensitivity.
An exponential atmosphere with finite-difference density gradient is used.
Initial-mass perturbations are ±0.1 and ±0.05 kg; comparison excludes the unit
mass-row entry so it cannot hide missing environmental derivatives. Each case
also requires a resolvable environmental contribution versus the same arc
without drag/SRP. These tests check derivative consistency, not new accuracy
claims for the existing atmosphere or SRP models.

Sources:

- [Orekit 13.0.1 published maneuver test](https://www.orekit.org/site-orekit-13.0.1/xref-test/org/orekit/forces/maneuvers/ConstantThrustManeuverTest.html#L268), with [versioned source](https://raw.githubusercontent.com/CS-SI/Orekit/13.0.1/src/test/java/org/orekit/forces/maneuvers/ConstantThrustManeuverTest.java).
- [NASA Glenn ideal rocket equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/ideal-rocket-equation/).
- [MIT 16.522 lecture 6, equations 4–6 and 9](https://ocw.mit.edu/courses/16-522-space-propulsion-spring-2015/7f725e54b9be201164d56ebbd5e08023_MIT16_522S15_Lecture6.pdf), near-circular low-thrust spiral approximation.
- [Orekit LOFType definitions](https://www.orekit.org/site-orekit-12.0.1/apidocs/org/orekit/frames/LOFType.html), RTN/QSW and VNC bases.
- [Kong et al., Saltation Matrices](https://arxiv.org/abs/2306.06862), state-event sensitivity updates.

## Build and test receipts

Commands below run from the private worktree root unless shown otherwise.
Installed test SDK is 0.8.18 with SDS 1.202.0. The explicit SDK-source admission
probe uses canonical SDK 0.8.15 and installed SDS 1.202.0. Ignored local
`node_modules` points to `/private/tmp/finite-04-deps/node_modules`; browser
harness provisioning also installed `esbuild` there. No dependency source,
lockfile, or other lane's directory was edited.

### Diagnostic build — PASS, exit 0

```sh
env SDN_FLATBUFFERS_INCLUDE_DIR=/Users/tj/software/spacedatanetwork-stack/repos/main-packages/flatbuffers/include \
SDN_LOCAL_EMSDK_DIR=/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-modules/propagator/hpop/deps/emsdk \
bash propagator/hpop/build.sh
```

```text
[100%] Built target hpop_wasm
=== Build Complete ===
```

Both browser and isomorphic WASM outputs are 833345 bytes, SHA256:

```text
627f0204b7f09aff0e89e24bcc6ec4cff9780411c74706f4368434a8002ad79a
```

### Focused native and actual-WASM tests — PASS, exit 0

```sh
node --test propagator/hpop/tests/finite_burn.test.mjs
node --test propagator/hpop/tests/finite_burn_invoke.test.mjs
```

```text
PASS HPOP finite burns checks=75 failures=0
native: tests 1; pass 1; fail 0; skipped 0
invoke: tests 8; pass 8; fail 0; skipped 0
```

Actual-WASM checks include Orekit, exact mass/delta-V, all six frame names
(including LVLH alias), steering, mass-column STM/covariance, event starts/stops,
JD edges, cumulative samples, 30 invalid controls, and same-instance recovery.

### Tri-runtime parity — PASS, exit 0

```sh
PATH="$HOME/.wasmedge/bin:$PATH" node propagator/hpop/tests/finite-burn-parity.mjs
PATH="$HOME/.wasmedge/bin:$PATH" node propagator/hpop/tests/variational-parity.mjs
PATH="$HOME/.wasmedge/bin:$PATH" node propagator/hpop/tests/kernel-parity.mjs
```

```text
parity PASS fixture=TMPL lane04 HPOP finite burns diagnostic artifact module=627f0204b7f09aff lanes=[browser(49 runs, 3633ms), wasmedge(49 runs, 4225ms), docker-wasmedge(49 runs, 36010ms)] comparisons=245
  49 case(s) byte-identical across 3 lane(s).
parity PASS fixture=TMPL lane03 HPOP variational diagnostic artifact module=627f0204b7f09aff lanes=[browser(10 runs, 3632ms), wasmedge(10 runs, 1853ms), docker-wasmedge(10 runs, 12921ms)] comparisons=50
  10 case(s) byte-identical across 3 lane(s).
parity PASS fixture=TMPL lane01 HPOP diagnostic CMake artifact module=627f0204b7f09aff lanes=[browser(6 runs, 2220ms), wasmedge(6 runs, 1691ms), docker-wasmedge(6 runs, 5919ms)] comparisons=30
  6 case(s) byte-identical across 3 lane(s).
```

Real browser/V8, native WasmEdge 0.16.4 and container WasmEdge 0.16.4 use
the same bytes. No runtime lanes are skipped. The 49 finite-burn cases include
30 invalid controls and recovery. New validation returns explicit statuses
because throwing across a finite-burn vector exposed WasmEdge cleanup traps;
the final artifact passes those same negative cases in every runtime.
The initial missing browser `esbuild` dependency was provisioned privately.

### Required SDK compatibility and regression — baseline failure, exit 1

```sh
(cd propagator/hpop && PATH="$HOME/.wasmedge/bin:$PATH" node --test tests/sdk_compat.test.mjs)
(cd propagator/hpop && PATH="$HOME/.wasmedge/bin:$PATH" npm test)
```

```text
sdk_compat: tests 10; pass 9; fail 1; skipped 0
npm test:   tests 42; pass 41; fail 1; skipped 0
FAIL built artifact passes SDK compliance checks
baselineErrors=11 currentErrors=11 identical=true
```

The comparison uses exact `code/location` pairs with the same SDK against the
base and final artifacts. Its scope is unchanged compliance errors, not a claim
that artifact admission passes.

### Additional existing regression — PASS, exit 0

```sh
PATH="$HOME/.wasmedge/bin:$PATH" node --test \
propagator/hpop/tests/kernel_invoke.test.mjs \
propagator/hpop/tests/de440_force.test.mjs \
propagator/hpop/tests/no_duplicate_sources.test.mjs \
propagator/hpop/tests/zonal_crossvalidation.test.mjs
```

```text
tests 6; pass 6; fail 0; skipped 0
```

### SDK-source build admission — BLOCKED, exit 1

```sh
env SDN_MODULE_SDK_ROOT=/Users/tj/software/spacedatanetwork-stack/repos/ancillary-packages/space-data-module-sdk \
SPACE_DATA_STANDARDS_ROOT=/private/tmp/finite-04-deps/node_modules/spacedatastandards.org \
node propagator/hpop/tests/sdk-build-preflight.mjs
```

```text
SDK preflight sdk=0.8.15 standards=1.202.0
SDK BUILD BLOCKED: Manifest validation failed. errors=27
HPOP source preparation skipped: SDK rejected the manifest before compiler selection.
```

The preflight contains a deliberate sentinel source and proves only that the
existing manifest is rejected before compilation. It does not claim an SDK
build of HPOP. Artifact compliance and SDK migration are owned by the separate
contract lane. Full SDK-wide and whole-stack suites were not run; deployment,
publication, production verification, and stack pins are outside this lane.

Local receipts: `/private/tmp/finite-04-{native,invoke,build,regression,sdk-compat,sdk-preflight}.log`.
`git diff --check` passes.

## Limits and remaining work

1. SDK admission and the 11 existing artifact errors remain blocked separately.
   No SDK-compliant publication claim is made.
2. Maximum 16 burns per request. Forward propagation only. Finite burns require
   analytic STM; `FINITE_DIFFERENCE` for the seven-state path is unsupported.
   No resident/cache API or new binary burn contract was added.
3. Event detection requires sign-changing roots bracketed by accepted steps.
   `maxStep` must resolve crossing separation; multiple roots within one step
   and tangencies are not guaranteed to be found. Detected grazing events,
   simultaneous state-event edges, and state-event ties within 1 ns of scheduled
   edges or output epochs are refused because a unique classical STM is absent.
4. RK4 retains user-controlled fixed-step accuracy. Adaptive methods support
   RKF45/COWELL and RKF78/RK78. Velocity/anti-velocity modes do not accept vector
   steering; use the vector frames for steered burns.
5. Delta-V summaries integrate each burn's acceleration magnitude. They do not
   represent gravity-corrected endpoint velocity differences or a vector sum
   across overlapping burns. Impulses preserve the existing unchanged-mass law.
6. Existing lane-03 environmental derivative/model restrictions remain. This
   lane does not expand the gravity field or validate unrelated force models.

## Workspace and commit hygiene

No graph task existed for the requested claim. Focused commits use the owner's
explicitly authorized workspace-guard override:

```sh
GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f"
GRAPH_GUARD_OVERRIDE="TMPL parity lane 04 (owner goal 2026-09-15)"
```

Tracked edits are confined to the private worktree. No credentials were read.
The task branch is retained for coordinator integration; no main merge is made.

The three source/test SHAs appear at the top of this report. The artifact and
handoff are in the following commit; the final coordinator response records its
SHA and read-back verification of `refs/heads/tmpl/finite-04`.

Changed files:

```text
docs/tmpl-lane-04-handoff.md
propagator/hpop/README.md
propagator/hpop/dist/browser/module.wasm
propagator/hpop/dist/isomorphic/module.wasm
propagator/hpop/lib/finite_burn.cpp
propagator/hpop/lib/finite_burn.h
propagator/hpop/package.json
propagator/hpop/src/cpp/CMakeLists.txt
propagator/hpop/src/cpp/src/plugin_runtime.cpp
propagator/hpop/tests/finite-burn-fixture.mjs
propagator/hpop/tests/finite-burn-parity.mjs
propagator/hpop/tests/finite_burn.test.mjs
propagator/hpop/tests/finite_burn_invoke.test.mjs
propagator/hpop/tests/finite_burn_native.cpp
```
