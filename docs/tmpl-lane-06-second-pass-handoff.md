# TMPL lane 06 second-pass handoff — 2026-09-15

## Delivery

Branch: `tmpl/lane-06-constraints`.
Private worktree: `/Users/tj/software/worktrees/modules-lane-06-constraints`.
Base: `5c6a7de` (`origin/main` fetched at session start).
The first-pass branch/worktree is untouched. The final response lists the
implementation and handoff commit SHAs; the coordinator owns landing.

The branch implements the ratified ACW constraint engine in `analysis/access`
and exposes the identical compiled evaluator through
`propagator/events.locate_access_windows`. Both primary artifacts are
`dist/isomorphic/module.wasm`, built through SDK `compileModuleFromSource`.
Production JavaScript performs source composition, ABI calls, and byte movement;
all constraint evaluation and root finding are C++ WASM.

### Implemented behavior

- Nested `ALL_OF` and `ANY_OF` expressions; depth-first leaf labels and causal
  opening/closing attribution, including irrelevant simultaneous transitions.
- Ground sites and supplied moving-observer trajectories, each with separate
  windows and the appropriate station/observer identifier.
- Discrete sample runs and continuous windows with Brent-refined boundaries.
  Individual leaves are solved before composition, so an AND interval can lie
  wholly between two false aggregate samples.
- Minimum elevation, cyclic azimuth masks, min/max range, interpolated Sun/Moon
  exclusion directions, target sunlit/umbra/penumbra/not-umbra selection,
  finite-segment WGS84 ellipsoid occultation with raised atmospheric semiaxes,
  and observer blackouts.
- Polynomial root candidates for angular, limb, and finite-disk shadow
  boundaries, plus unrefracted mask stationary points. Narrow solar gaps,
  millimetre limb grazes, and roughly 2.26 ms penumbra bands have regressions.
- Continuous range extrema include exact interior closest approaches. Visible
  target sample counts can be zero for a window entirely between samples.
- Legacy requests without a constraint set retain their existing behavior.
- Invalid required trajectories, uncovered ephemeris spans, unknown kinds or
  operators, invalid thresholds/tolerances, and undefined evaluated geometry
  fail explicitly. No extrapolation or implicit body-position model is added.
- Existing events contact/conic interval output now pairs increasing entry with
  decreasing exit; eclipse retains decreasing entry.

### Standards and dependencies

No schema is authored or modified. The base already pins SDS `^1.219.0` in the
root and both touched packages; `npm ci` resolved **1.219.0** for both. Root and
other module package manifests remain untouched. Access uses locked SDK
**0.8.18**; events uses locked SDK **0.8.16**. Events now declares the parity
harness's previously missing `esbuild` dependency at **0.28.2**.

Both builds regenerate bindings from their own installed SDS package. Events
compiles ACW with its unscoped enum style, matching the shared evaluator, and
retains scoped enums for existing families. Its build-source helper receives
the caller's generated header and requires no dependency install in access.
Generated events CAT/EOP/LCC/RFM headers also reflect the pinned SDS update.

EVL still defines its existing six locator classes. The new events method uses
the ratified ACW request/result, including interval attribution, instead of
inventing EVL enum values or a private payload.

## Authoritative numerical evidence

All synthetic cases state Earth-fixed Cartesian metres, radians, and TT Julian
dates in their fixture metadata. Expected values are independently derived
line intersections, finite-disk tangents, and WGS84 ellipsoid geometry. They
are not outputs recorded from the new implementation.

| Reference/case | Measured error | Tolerance and rationale |
| --- | --- | --- |
| Orekit 13.1.2 `ElevationDetectorTest.testIssue110`: published edges 478.945 / 665.721 s after J2000 TT | 0.000380449295 / 0.001617535114 s | 0.1 s; covers published millisecond rounding, one-second independent Cartesian interpolation, one-millisecond requested root tolerance, and JD representation |
| Orekit GroundAtNightDetector civil twilight via a fixed zenith target and 96-degree SUN_EXCLUSION; published duration 45037.367 s | 0.000381783961 s | 0.1 s; independent Orekit Sun positions, linear interpolation near transitions and JD representation |
| All access closed-form edge cases, including attribution | max 0.0000298023224 s | ordinarily 0.0101 s; 0.01 s requested refinement plus JD representation allowance |
| Narrow solar exclusion gap | max 0.0000193715096 s | 0.0101 s; independent arctangent boundary |
| Narrow millimetre limb occultation | max 0.0000206957858 s | 0.0101 s; independent ellipsoid intersection |
| Narrow umbra/penumbra | max 0.0000105660992 s | 0.0002 s; 0.0001 s requested refinement plus JD representation, resolving millisecond penumbra bands |
| Access continuous range extrema | 0 m | 1 m; conservative allowance for edge-time error, with exact interior quadratic minimum |
| Existing six Orekit inverse topocentric coordinate cases | max 4.73132644174e-12 rad | 1e-10 rad; Earth-radius subtraction and libm rounding |
| Events ACW closed-form edge cases | max 0.00003159046 s | 0.1 s; prescribed trajectory, 0.01 s root tolerance and JD representation |
| Events ACW min/max range | 0 / 0 m | 2 m; conservative edge-time allowance |
| Events conic-intrusion interval entry/exit | 3.87445e-10 / 3.87899e-10 s | 0.001 s; independent conic geometry and supplied trajectory interpolation |

Sources:

- [Orekit published elevation assertions](https://raw.githubusercontent.com/CS-SI/Orekit/13.1.2/src/test/java/org/orekit/propagation/events/ElevationDetectorTest.java).
  `tests/data/orekit-elevation.json` contains 221 independent Orekit samples,
  complete orbit/site/frame/TT configuration, input data and dependency hashes,
  and a Java reproduction generator. Independent Orekit reproduction itself
  differs from its published assertions by 0.000006578 / 0.000787367 s.
- [Orekit TopocentricFrame tests](https://www.orekit.org/site-orekit-13.1.2/xref-test/org/orekit/frames/TopocentricFrameTest.html).
- [NGA WGS84](https://earth-info.nga.mil/?action=wgs84&dir=wgs84).
- [IAU 2012 B2 astronomical unit](https://www.iau.org/static/resolutions/IAU2012_English.pdf)
  and [IAU 2015 B3 nominal solar radius](https://www.iau.org/static/resolutions/IAU2015_English.pdf).
- [Orekit EclipseDetector](https://www.orekit.org/site-orekit-13.1.2/xref/org/orekit/propagation/events/EclipseDetector.html).
  Lighting calls the existing events evaluator using the same apparent-angle
  umbra/penumbra geometry; independent synthetic expectations use tangent lines.

The attribution fixtures assert the exact flattened labels and indices, not
only boundary times. A discrete fixture with `(A AND B) OR C` proves that an
irrelevant change in A does not receive C's opening attribution.

## Reproduction and checks

Run dependency preparation before builds:

```sh
cd analysis/access
npm ci --no-audit --no-fund
npm run build
```

```text
added 15 packages in 13s
Built dist/isomorphic/module.wasm through SDK; compliance PASS (unsigned local build).
```

Access's legacy test imports `analysis/embeddedManifest.js`, whose shared SDK
import is outside the module directory. This bare private worktree lacked its
workspace dependency resolution. An ignored root `node_modules` directory links
`space-data-module-sdk`, `flatbuffers`, and `spacedatastandards.org` to the
installed access dependencies. No shared source or manifest was changed to
provision this existing test dependency.

From `analysis/access`:

```sh
npm test
node --test tests/sdk_compat.test.mjs
npm run check:compliance
node tests/parity.mjs
node tests/constraints-parity.mjs
```

```text
npm test: tests 68; pass 68; fail 0; skipped 0
sdk_compat: tests 6; pass 6; fail 0; skipped 0
[compliance] PASS: access manifest and dist/isomorphic/module.wasm
parity PASS fixture=lane10 access Orekit and command errors module=1277308cfb5abafc lanes=[browser(36 runs, 1135ms), wasmedge(36 runs, 887ms), docker-wasmedge(36 runs, 5008ms)] comparisons=174
  9 case(s) byte-identical across 3 lane(s).
parity PASS fixture=lane06 ACW constraint geometry, attribution, invalid inputs and legacy module=1277308cfb5abafc lanes=[browser(200 runs, 879ms), wasmedge(200 runs, 5030ms), docker-wasmedge(200 runs, 32011ms)] comparisons=1150
  50 case(s) byte-identical across 3 lane(s).
```

These are the same final access WASM bytes in real Chrome/V8, native WasmEdge,
and Docker WasmEdge at thread counts 1, 2, 4, and 8. Numerical correctness is
asserted separately; parity asserts identical responses including invalid input
and legacy cases. Timing receipts are not performance benchmarks.

The standalone constraint suite reports `tests 49; pass 49; fail 0` (37 geometry
cases, 10 invalid cases, one legacy case, and the enclosing test). Parity adds
the published Orekit elevation and civil-night fixtures.

The additional Orekit night test uses a target fixed along the station's
geodetic zenith, so its angle to the Sun is exactly 90 degrees minus solar
elevation. A 96-degree exclusion therefore reproduces civil twilight without
introducing a new constraint kind. Published source:
[Orekit GroundAtNightDetectorTest](https://raw.githubusercontent.com/CS-SI/Orekit/13.1.2/src/test/java/org/orekit/propagation/events/GroundAtNightDetectorTest.java).
The fixture and generator record the independent Sun ephemeris and data hashes.

From `propagator/events`:

```sh
npm ci
npm run build
PATH="$HOME/.wasmedge/bin:$PATH" npm test
PATH="$HOME/.wasmedge/bin:$PATH" node --test tests/sdk_compat.test.mjs
npm run check:compliance
PATH="$HOME/.wasmedge/bin:$PATH" npm run test:parity
```

```text
npm ci: added 13 packages; found 0 vulnerabilities
Built dist/isomorphic/module.wasm against spacedatastandards.org@1.219.0 over the 335-parameter catalog and 248 vendored ERFA sources
npm test: tests 16; pass 16; fail 0; skipped 0
sdk_compat: tests 2; pass 2; fail 0; skipped 0
[compliance] PASS: events manifest and dist/isomorphic/module.wasm
parity PASS fixture=TMPL lane06 events and access constraints module=5c32c352874e3cea lanes=[browser(14 runs, 1326ms), wasmedge(14 runs, 1437ms), docker-wasmedge(14 runs, 3780ms)] comparisons=70
  14 case(s) byte-identical across 3 lane(s).
```

After the initial `npm ci`, events added its missing parity dependency with
`npm install --save-dev --save-exact esbuild@0.28.2`; the lockfile records it.
Existing native event core conformance reports `55 checks, 0 failures`.
Artifact SHA-256 values:

- Access: `1277308cfb5abafcccc7b6d61dc0ce24085a7c36960229d0013698583007b42e`.
- Events: `5c32c352874e3cea9a876574088fc593a37ad4429a8e167d6c5a7daab6b57499`.

Logs retained locally as `/private/tmp/lane06-access-*.log` and
`/private/tmp/lane06-events-*.log`.

## Scope and remaining acceptance item

The requested exact **Vallado Example 11-6 site-satellite edge fixture remains
unverified**. The checked [CelesTrak primary code repository](https://github.com/CelesTrak/fundamentals-of-astrodynamics)
at `475d47d4172a88d69e9d80730d84536d8f50b92c` contains MATLAB examples 11-1
through 11-5, no `11_6` path, and the direct `ex11_6.m` URL returns 404. This
establishes unavailable verification material in the checked source, not that
an example in some book edition does not exist. The coordinator needs the
exact edition/page or authoritative inputs and expected epochs to close that
named criterion. Orekit published edges are independently verified above; they
are not relabeled as Vallado values.

Accuracy applies to the supplied piecewise-linear Earth-fixed trajectories.
There is no propagation, automatic reference-frame conversion, or light-time
option in ACW. Target lighting uses the existing events spherical shadow model;
line-of-sight uses WGS84 ellipsoid geometry. Refracted masks retain numerical
bracketing of the nonpolynomial correction, so unlike algebraic leaves their
completeness depends on resolving that function between supplied samples.
No claim of exhaustive unsampled physical orbit reconstruction is made.

## Bounded improvement review

Applied the required question: “What's the best next safe and deployable and
accretive improvement you could make to this plan/artifact right now, and if
none exists return NO_BETTER_OPTION?”

Baseline: shared C++ constraint evaluator plus published and closed-form tests
(score 32/40). W1 selected independent, reproducible Orekit inputs with hashes
(36/40). W2 selected polynomial interior-boundary candidates and causal
attribution regressions after review found concrete counterexamples (39/40).
W3 selected the equivalent zenith-target twilight reference fixture (40/40).
Scores combine objective impact, current deployability, fail-closed safety,
and source lineage; safety and deployability do not decrease. Bounded stop:
`max_waves_reached` (three waves). No extra schema or deployment work was added.

## Workspace and commit hygiene

Only `analysis/access`, `propagator/events`, and this handoff are delivered.
No canonical checkout edit, recursive submodule command, credential access,
publication, deployment, or merge was performed. The branch is pushed for the
coordinator to review and land.

Commits use the owner's explicitly authorized workspace-guard environment:

```sh
GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f"
GRAPH_GUARD_OVERRIDE="TMPL parity lane 06 (owner goal 2026-09-15)"
```

No hook is disabled. The hook selected an unrelated ocean-terrain task and
recorded the explicitly authorized override for the staged lane files.
`git diff --check` passes.

## Implementation commits and exact files

- `ecf6152f522728ccd393912464cd0ba4b8a0600a` — feat(access): compose ratified ACW constraints with refined boundaries
- `eab4a34a6ef153edac6dcfab28643ebd60bc3fe1` — feat(events): expose shared ACW locators and correct interval direction

The handoff is a separate documentation commit; its SHA is in the final response.
Native and container WasmEdge use SDK pin **0.16.4**.

Exact delivered file list (43 files):

- `analysis/access/README.md`
- `analysis/access/build-source.mjs`
- `analysis/access/build.mjs`
- `analysis/access/dist/access-binary.js`
- `analysis/access/dist/access.wasm`
- `analysis/access/dist/browser/module.wasm`
- `analysis/access/dist/isomorphic/module.wasm`
- `analysis/access/dist/manifest.json`
- `analysis/access/manifest.json`
- `analysis/access/src/access_plugin.cpp`
- `analysis/access/src/constraint_engine.cpp.inc`
- `analysis/access/src/constraint_polynomials.hpp`
- `analysis/access/src/generated/ACW_generated.h`
- `analysis/access/tests/constraints-fixture.mjs`
- `analysis/access/tests/constraints-parity.mjs`
- `analysis/access/tests/constraints.test.mjs`
- `analysis/access/tests/data/OrekitElevationReference.java`
- `analysis/access/tests/data/OrekitNightReference.java`
- `analysis/access/tests/data/orekit-elevation.json`
- `analysis/access/tests/data/orekit-night.json`
- `analysis/access/tests/orekit-elevation.test.mjs`
- `analysis/access/tests/orekit-night.test.mjs`
- `propagator/events/README.md`
- `propagator/events/build.mjs`
- `propagator/events/check-compliance.mjs`
- `propagator/events/dist/build-provenance.json`
- `propagator/events/dist/isomorphic/module.wasm`
- `propagator/events/dist/plugin-manifest.json`
- `propagator/events/generate-sds-headers.mjs`
- `propagator/events/package-lock.json`
- `propagator/events/package.json`
- `propagator/events/plugin-manifest.json`
- `propagator/events/src/events_module.cpp`
- `propagator/events/src/generated/sds/ACW_generated.h`
- `propagator/events/src/generated/sds/CAT_generated.h`
- `propagator/events/src/generated/sds/EOP_generated.h`
- `propagator/events/src/generated/sds/LCC_generated.h`
- `propagator/events/src/generated/sds/RFM_generated.h`
- `propagator/events/tests/access-constraints.test.mjs`
- `propagator/events/tests/access-fixture.mjs`
- `propagator/events/tests/events.test.mjs`
- `propagator/events/tests/kernel-parity.mjs`
- `docs/tmpl-lane-06-second-pass-handoff.md`
