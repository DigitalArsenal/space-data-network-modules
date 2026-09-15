# TMPL lane 06 coordinator handoff — 2026-09-15

## Status: blocked by the existing SDS contract

**No lane 06 physics implementation is delivered or accepted.** The owner's
instruction says: "if a standard is missing, STOP and report instead of
inventing one." The requested constraint aggregator cannot be expressed in
the existing ACW request/result contract. Implementation stopped at this gate.
This branch delivers the contract audit, a repair for an independently found
events build regression, and baseline verification receipts.

- Branch: `tmpl/lane-06`.
- Private worktree: `/Users/tj/software/worktrees/modules-lane-06`.
- Base: `65388c053ecefc9d5f1eb57eadbe2d3c3593a47a`, fetched `origin/main` at
  lane start; includes lanes 01 and 08.
- Changed files: `propagator/events/build.mjs`,
  `propagator/events/dist/isomorphic/module.wasm`, and this handoff.
- No schema, generated binding, manifest, physics source, or dependency pin
  is changed by this delivery.
- The final response supplies the commit SHAs and remote SHA.
  The coordinator owns integration; this branch is not merged to main.

Build-repair commit: `ffc6a26e53af2da86f2d2df5b303b464a1179cde`.
The following documentation commit records this handoff.

## Contract evidence

The modules root pins `spacedatastandards.org` **1.202.0** in `package.json:7`.
The published package contains `schema/ACW/main.fbs`, `schema/EVL/main.fbs`,
and `schema/PCE/main.fbs`. Those files are byte-identical to the canonical SDS
checkout at `b76da41467e260c83b3432ba7f34a1eb05cc7ac7`, whose package version is
`1.217.0+1789398499674`. Merely updating to that checkout would not fix this gap.

The actual canonical checkout stores schemas at
`repos/main-packages/spacedatastandards.org/schema/`; the stack bootstrap's
`packages/spacedatastandards.org/schema/` location is absent in this checkout.
No schema was created at either location.

| Published schema | SHA-256 |
| --- | --- |
| ACW | `2421c07cadf00434ed859e350194d8abc3966293de68a95fa8d33c867b2144e0` |
| EVL | `b3d65b1355d1a05e45ff2043017294454bb9e89e6c3f2cd892c3510b688a107e` |
| PCE | `683e8be4f2af75014885a20307f35ba18e551df1b76f2cfdec938cf210543b92` |

### ACW is the blocking contract

`analysis/access/plugin-manifest.json` declares ACW for both input and output.
In `schema/ACW/main.fbs`:

- `ACWStateSample` (lines 28–37) contains a TT Julian Date and three Earth-fixed
  position components in metres.
- `ACWRequest` (lines 83–99) contains operation, ground stations, one target
  state series, station selection, minimum-elevation override, trace ID,
  elevation mask, and refraction model.
- `ACWAccessWindow` (lines 102–112) contains only `STATION_ID`,
  `START_JULIAN_DATE_TT`, `END_JULIAN_DATE_TT`, `MAX_ELEVATION_RAD`, and
  `SAMPLE_COUNT`.

There is no general constraint list, AND/OR operator, spacecraft observer
trajectory, solar/lunar exclusion threshold, range bound, lighting selection,
LOS atmosphere-height offset, discrete/continuous selector, root-refinement
configuration, or per-window limiting-constraint attribution. `STATION_ID` and
`TRACE_ID` retain their stated meanings; neither can carry missing metadata.
The native `AccessWindowRecord` has a reserved word, but an implementation's
reserved storage does not authorize a new SDS field.

### EVL/PCE has partial support, not a blanket schema blocker

| Requested capability | Existing standard and remaining issue |
| --- | --- |
| Range threshold | Representable through EVL `PARAMETER_CONDITION` (EVL 249–260), PCE `RELATIVE_RANGE` (491–492), `SECOND_OBJECT_ID` (549), `OWNER_OBJECT_ID` (552), and `GOAL_VALUE` (770–771). A secondary OEM input and object-ID lookup would be module implementation work, not schema invention. |
| Target lighting | PCE `ILLUMINATION_FRACTION` (510–513) defines 1 for full sunlight, 0 for umbra, and intermediate illumination. `ILLUMINATING_BODY_ID` (690–691) and generic conditions can support thresholds. EVL already carries eclipse-region flags. |
| Combined constraints | EVL has a condition vector, but no AND/OR expression or combined-window attribution. `EVLEvent.CONDITION_INDEX` (309–311) attributes one generic condition, not an ACW window's limiting constraints. |
| Satellite observer | EVL contact accepts `RFMOrigin` and says the observer is "normally a GROUND_SITE" (163–164); RFM has `SPACE_OBJECT` and `OBJECT_ID`. However, the CONTACT locator description explicitly defines surface-site visibility (EVL 16–18). General spacecraft LOS needs an authoritative standards interpretation. |
| LOS atmosphere offset | Contact carries occulting-body IDs and aberration correction, but no atmosphere-height offset. |
| Solar/lunar exclusion | No explicit exclusion locator/configuration exists. PCE `ANGULAR_SEPARATION` does not unambiguously bind both sightlines. `SOLAR_PHASE_ANGLE` is measured at its owner between illumination and observer; ordinary target-owner usage gives the wrong vertex for observer-based exclusion. No silent reinterpretation was made. |

Schema availability does not establish implementation availability:
`propagator/events/src/events_module.cpp:767` currently selects only the first
generic condition, and its parameter context does not bind secondary-object
states. No claim is made that range or illumination-fraction thresholds work
today. Those independent extensions were not started after the explicit
schema-stop gate was reached.

Lane 01's body-position integration is already available. Future supported
body-dependent locators should use `BodyPositionFn` and the existing scoped
SPK/Analytical selection, described in [lane 01's handoff](tmpl-lane-01-handoff.md)
and [DE440 integration](de440-integration.md). A supplied kernel must continue
to refuse missing coverage rather than silently fall back.

## Verification

### Existing native event core: PASS

From the private worktree root:

```sh
node --test propagator/events/tests/event_locator_conformance.test.mjs
```

Exit 0:

```text
55 checks, 0 failures
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
```

This is baseline regression evidence, **not lane 06 acceptance**. The existing
harness checks Brent roots and closed-form trajectories against a second
root-finder; it does not supply the requested published access-window case.
Measured existing station-contact rise error was 0 s and set error was
`4.547474e-13` s against that harness's independent bisection calculation
(bar `1e-3` s). Existing umbra and penumbra edge errors were at most
`4.547474e-13` s at the same bar. These errors measure solver agreement, not
STK/Orekit/Vallado access accuracy.

### Build integration repair: PASS

The unmodified base failed `node build.mjs` in `propagator/events`:

```text
fatal error: 'iau_body_models.hpp' file not found
1 error generated.
```

Lane 08 added this local header dependency to the shared `axis_engine.hpp`.
The events builder assembled that engine into the SDK's temporary translation
unit without its dependency. The repair reads the existing shared body-model
header, places it before the engine, and strips the now-redundant local include,
matching `foundation/frames/build.mjs`. No physics is reimplemented.

Dependency preparation and successful build, from `propagator/events`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node build.mjs
```

Exit 0:

```text
added 13 packages in 2m
Built dist/isomorphic/module.wasm against spacedatastandards.org@1.202.0 over the 335-parameter catalog and 248 vendored ERFA sources
```

The build uses the package's locked SDK **0.8.16**, `compileModuleFromSource`,
and its declared `wasi-sequential` profile. The rebuilt artifact SHA-256 is
`b8be8d5ae8f8111714427a9680deba4e1b2b77f748f1ea583ced350e1abd50cc`.
This restores the existing module build; it does not add lane 06 features.

### Existing wire tests: PASS

From `propagator/events`:

```sh
node --test tests/events.test.mjs
```

Exit 0:

```text
ℹ tests 11
ℹ pass 11
ℹ fail 0
ℹ skipped 0
```

### SDK compatibility after the successful build: PASS

From `propagator/events`:

```sh
PATH="/Users/tj/.wasmedge/bin:$PATH" node --test tests/sdk_compat.test.mjs
```

Exit 0:

```text
✔ events DE440 invoke + explicit fallback + refusal (browser)
✔ events DE440 invoke + explicit fallback + refusal (wasmedge)
ℹ tests 2
ℹ pass 2
ℹ fail 0
ℹ skipped 0
```

The first compatibility attempt after the failed baseline build had no artifact
to open; after rebuilding, the unqualified command found no `wasmedge` on PATH.
Adding the already-installed runtime directory resolved this provisioning issue.
`/Users/tj/.wasmedge/bin/wasmedge --version` reports **0.16.4**, matching the
SDK's native/container pin. No runtime version was changed.

### Three-runtime parity: PASS

The first attempt found the native and container lanes available, but browser
bundling lacked the SDK development dependency `esbuild`. No numerical
divergence was reported; this was a harness provisioning failure.

The final run used locked SDK **0.8.16**, SDS **1.202.0**, and the existing SDK
checkout's `esbuild` **0.28.0** via an ignored local dependency symlink. No
package manifest or lockfile changed. From `propagator/events`:

```sh
ln -s /Users/tj/software/spacedatanetwork-stack/repos/ancillary-packages/space-data-module-sdk/node_modules/esbuild node_modules/esbuild
node tests/kernel-parity.mjs
```

Exit 0:

```text
parity PASS fixture=TMPL lane01 events module=b8be8d5ae8f81117 lanes=[browser(4 runs, 1758ms), wasmedge(4 runs, 1210ms), docker-wasmedge(4 runs, 4056ms)] comparisons=20
  4 case(s) byte-identical across 3 lane(s).
```

This tests the same rebuilt bytes in Chrome/V8, native WasmEdge 0.16.4, and
container WasmEdge 0.16.4 for DE440 eclipse, Analytical eclipse, kernel coverage
refusal, and bad-kernel-hash refusal. Timing values are harness receipts, not
performance benchmarks. This is existing-events parity, not evidence of any
new lane 06 feature.

`git diff --check` and the staged whitespace checks passed.

## Undelivered acceptance criteria

All requested new capabilities remain undelivered: exclusion locators,
satellite-to-satellite LOS with atmosphere offset and optional light time,
range/lighting extensions, and discrete/continuous AND/OR access aggregation
with attributed ACW windows. There are no new authoritative lane 06 numerical
tests or measured errors: the 0.1 s published access example, closed-form
sun-exclusion case, and closed-form limb-grazing case were not run against an
implementation because implementation stopped at the standards gate.

The unchanged `analysis/access` build/tests and SDK-wide test suite were not
run. No build migration or API extension of access was attempted after the
schema blocker. Existing events checks do not establish the lane's access
accuracy, aggregation behavior, or new exclusion/LOS geometry.

The coordinator must obtain ratified ACW support for the missing request and
result semantics, plus authoritative EVL/PCE mappings for exclusion and
spacecraft LOS, before the complete lane can resume. Generic range and
illumination thresholds have an existing standards path as documented above.
This report is a requirements gap; it assigns no new schema names, field
numbers, enum values, or private wire format.

## Workspace and commit hygiene

The canonical modules checkout and other lane directories were not edited.
No production deployment, publication, stack pin update, or merge was done.
The read-only contract audit was independently cross-checked by a sub-agent.

The bounded claim attempt was:

```sh
env GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f" \
  node graph/graphctl.mjs claim tmpl-lane-06 --agent codex-lane-06
```

It exited 1 with `graphctl: no such task: tmpl-lane-06`. Both commits use the
owner's explicitly authorized override:

```sh
GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f"
GRAPH_GUARD_OVERRIDE="TMPL parity lane 06 (owner goal 2026-09-15)"
```

The hook selected an unrelated terrain task and recorded the authorized
workspace-guard override for the explicitly staged lane files.

The clean worktree is retained pending coordinator disposition because the
branch has not landed.
