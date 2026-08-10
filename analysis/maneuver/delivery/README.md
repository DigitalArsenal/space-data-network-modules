# Delivering maneuver-planner 0.4.0 to an SDN node

`modules-catalog.entry.json` is this module's row for a node's
`<storage>/modules/modules-catalog.json`. It is committed here because the
catalog is DATA — the node's `internal/pmm` package is explicit that it is a
connector, not an application, and that every policy decision (which module is
CORE, which is browsable, which is entitled) arrives as data rather than as Go
code. The module ships the row it wants; the node operator decides whether to
admit it.

## What changed from the 0.3.0 row

| Field | 0.3.0 | 0.4.0 | Why |
|---|---|---|---|
| `VERSION` | `0.3.0` | `0.4.0` | ONE new operation, `phasingFromTargetState`, and no change to any existing response. |
| `CONTENT_HASH` | `4e945bbf…19144c97` | `65918188…8576e77e` | The bytes. The node RECOMPUTES this from disk and refuses a declared hash that disagrees. |
| `ARTIFACT_SIZE_BYTES` | 205,798 | 220,775 | +14,977 bytes: the Cartesian-to-classical element recovery, the phase geometry, the revolution-count scan, the two direction summaries and their messages. |
| `ARTIFACT_PATH` | `/modules/maneuver-planner/0.3.0/module.wasm` | `/modules/maneuver-planner/0.4.0/module.wasm` | Version-addressed path, per the convention every other row uses. |
| `SUPERSEDES_CONTENT_HASH` | `0746bb22…c2934ae` | `4e945bbf…19144c97` | Names the artifact this replaces, so a reader of the signed manifest can follow the lineage without a changelog. |
| `EPOCH` | 3 | 4 | Fourth publication of this module id. |
| `DESCRIPTION` | "…phasing…" | "…phasing (by angle or derived from a target spacecraft's state)…" | The storefront line names what is new; nothing else in the row moved. |

`abiVersion` stays **1**, the manifest's methods and ports are untouched, and
`TRUST_TIER` / `DEFAULT_ENABLED` / `ACCESS_POLICY` are unchanged. A new
`operation` NAME on the existing JSON command envelope is purely additive under
the SDK contract (ruling, 2026-08-10): every 0.3.0 response keeps its value and
its meaning, and a consumer written against 0.3.0 reads a 0.4.0 response
unchanged. Two things did move inside the artifact and both are corrections
rather than contract changes:

- **`version` now answers `0.4.0`.** It answered `"1.0.0"` from 0.1.0 through
  0.3.0 — a version this module has never carried — because nothing compared it
  to anything. The one operation whose job is to say which artifact you are
  talking to was returning a constant. `tests/behavior.test.mjs` now asserts it
  against `plugin-manifest.json` AND asserts this catalog row against the same
  manifest, so the three cannot diverge again.
- **`sequentialJustification.detail`** gains a clause for the revolution-count
  scan: it is the module's only loop whose trip count a caller influences, so
  the manifest says that its ceiling is clamped into `[1, 100000]` rather than
  trusted. The thread model itself is unchanged.

## What changed from the 0.2.0 row (historical, at 0.3.0)

| Field | 0.2.0 | 0.3.0 | Why |
|---|---|---|---|
| `VERSION` | `0.2.0` | `0.3.0` | Three Lambert changes, all ADDITIVE on the wire: a bracketing repair that stops the zero-revolution search stepping over its own domain boundary, a `branch` selector that exposes the second multi-revolution arc, and the transfer arc's own conic (`perigeeRadius` and companions) on every converged response. |
| `CONTENT_HASH` | `0746bb22…c2934ae` | `4e945bbf…19144c97` | The bytes. The node RECOMPUTES this from disk and refuses a declared hash that disagrees. |
| `ARTIFACT_SIZE_BYTES` | 200,879 | 205,798 | +4,919 bytes: the conic report, the branch scan's second-crossing path, the candidate-set writer, and their messages. |
| `ARTIFACT_PATH` | `/modules/maneuver-planner/0.2.0/module.wasm` | `/modules/maneuver-planner/0.3.0/module.wasm` | Version-addressed path, per the convention every other row uses. |
| `SUPERSEDES_CONTENT_HASH` | `6028c779…9cfe043` | `0746bb22…c2934ae` | Names the artifact this replaces, so a reader of the signed manifest can follow the lineage without a changelog. |
| `EPOCH` | 2 | 3 | Third publication of this module id. |

`abiVersion` stays **1** and the manifest's methods and ports are untouched.
The three changes live entirely inside the JSON payload and are additive: every
0.2.0 response field keeps its value and meaning, the default `branch` is the
arc 0.2.0 returned, and a consumer written against 0.2.0 reads a 0.3.0 response
unchanged. `TRUST_TIER` stays `RECOMMENDED`, `DEFAULT_ENABLED` stays `false`,
`ACCESS_POLICY` stays `ANONYMOUS`.

Two response keys are CONDITIONAL, and the condition is contract rather than
implementation detail (SDK ruling, 2026-08-10): `branch` appears only when
`revolutions >= 1`, and `apogeeRadius` / `transferSemiMajorAxis` only where the
quantity exists and is representable — with the always-present `transferConic`
discriminant beside them, so an absent key is never ambiguous. Emitting an
infinity instead would fail the writer's finiteness gate and turn a converged
solve into an error, which would not be additive.

## What changed from the live 0.1.0 row (historical, at 0.2.0)

| Field | 0.1.0 (live) | 0.2.0 | Why |
|---|---|---|---|
| `VERSION` | `0.1.0` | `0.2.0` | New artifact, new behaviour on the error path, the Lambert solver, the phasing guard and the serialised RIC arrays. |
| `CONTENT_HASH` | `6028c779…9cfe043` | `0746bb22…c2934ae` | The bytes. The node RECOMPUTES this from disk and refuses a declared hash that disagrees. |
| `ARTIFACT_SIZE_BYTES` | 244,552 | 200,879 | 43,673 bytes smaller: nlohmann/json is gone (it cannot report an error without exceptions — see below), and the SDK lane generates the invoke bridge the module used to vendor. |
| `PLUGIN_TYPE` | `Analysis` | `Maneuver` | It is not an analysis module. **Verified before setting**, per the task's instruction not to assume: the storefront's category list is a FIXED ordered map in `spaceaware-ui:src/orbital-console/store/moduleCatalog.ts`, and it already carries `Maneuver: "MANEUVER"` at line 73. So this buckets correctly with no console-side change and no empty category. |
| `SUPERSEDES_CONTENT_HASH` | — | `6028c779…9cfe043` | Names the artifact this replaces, so a reader of the signed manifest can follow the lineage without a changelog. |
| `EPOCH` | 1 | 2 | Second publication of this module id. |

`TRUST_TIER` stays `RECOMMENDED` and `DEFAULT_ENABLED` stays `false`: 0.2.0
changes what the module DOES when it is wrong, not who should load it.
`ACCESS_POLICY: ANONYMOUS` is unchanged — this module is plaintext on purpose,
served to a cold browser with no session.

## Why the artifact is smaller than the one it replaces

Not an optimisation. `-fno-exceptions` is mandatory on the sanctioned wasi
toolchain, and nlohmann/json's entire error contract is exceptions: `at()`,
`get<T>()` and `parse()` all throw, and `JSON_NOEXCEPTION` replaces the throw
with `std::abort()` — the same trap by another route. There is no configuration
of that library that turns a malformed request into a value a caller can read,
so it was replaced by a small no-throw reader/writer (`src/cpp/src/json_lite.cpp`)
written to the one requirement that matters here: no input may trap.

## Publishing

The lane that serves an ANONYMOUS plaintext wasm to a cold browser is the `$PMM`
lane, and it has **no CLI verb and no HTTP endpoint**. It is deployed DATA: the
artifact on disk plus a row in the catalog the node reads. `plugins
publish-orbpro` is the ENCRYPTED licensed lane and refuses a plaintext entry
(`catalog entry %q is not encrypted`); it writes to `<storage>/license/plugins`,
never touches `modules-catalog.json`, and never creates a
`/modules/<id>/<version>/module.wasm` path.

```bash
SHA=65918188aaf01223d820a691ac5ae86668da3ac7feaa9812ba59c6938576e77e
ROOT=/opt/data/sdn-module-delivery/modules      # <storage.path>/modules

# 1. the artifact, content-addressed (the convention every other row uses)
scp dist/isomorphic/module.wasm "$HOST:$ROOT/artifacts/$SHA.wasm"
ssh "$HOST" "chown sdn:sdn $ROOT/artifacts/$SHA.wasm && chmod 0644 $ROOT/artifacts/$SHA.wasm"

# 2. the row: REPLACE the existing maneuver-planner entry in entries[] with
#    modules-catalog.entry.json, and update its browse[] hint. Back up first;
#    write atomically (install + mv), never in place.
#
#    Replace rather than append: two ACTIVE rows for one MODULE_ID is a state
#    the catalog does not define an ordering over, and the storefront would show
#    the module twice.

# 3. nothing else. pmmRefreshInterval is 6 h and rebuild() re-reads the catalog
#    and re-hashes every artifact from disk, so a staged row goes live with NO
#    daemon restart.

# 4. leave the PREVIOUS version's artifact in place until this one is verified
#    live. It is content-addressed, so the two never collide, and it is the
#    rollback.
```

**Validate before you write.** `pmmPlugin.Start` fails CLOSED: a catalog it
cannot load means `RegisterRoutes` mounts nothing and the ENTIRE
`/.well-known/sdn/modules.pmm` + `/modules/` surface 404s until someone
notices. On host-01 that daemon also terminates TLS on :443. Run the daemon's
own `LoadCatalog` + `Manifest.Validate()` + `HashArtifact` over the candidate
file rather than eyeballing it.

## Evidence carried by this artifact (0.4.0)

Measured on `65918188aaf01223d820a691ac5ae86668da3ac7feaa9812ba59c6938576e77e`
(reproducible: two clean `node build.js` runs produced the identical digest).

- **Tri-runtime parity — ALL THREE LANES, for the first time on this module.**
  `parity PASS fixture=maneuver-command-parity module=65918188aaf01223
  lanes=[browser(116 runs), wasmedge(116 runs), docker-wasmedge(116 runs)]
  comparisons=656`, 29 cases byte-identical at 1/2/4/8 threads. The
  `docker-wasmedge` lane could NOT be exercised at 0.2.0 or 0.3.0 (the Docker
  daemon did not come up on the build box); it came up for this build and was
  run, so the third lane is measured rather than reported as unrun. Eight of
  the 29 cases are NEW and all eight are `phasingFromTargetState`: the
  canonical catch-up, the forced fall-behind, the revolution-count
  recommendation, the opposed-apsides geometry, the elements request form, and
  three refusals (both craft forms at once, an unknown direction, and an escape
  trajectory). The derived ANGLE is byte-diffed, not merely the plan built from
  it — it comes out of an `atan2` that a libm difference would move.
- **Vectors** — 43 rows across four tiers on browser AND WasmEdge (33 at
  0.3.0), 40 of them green (30 at 0.3.0), 165 tests passing. Ten rows are new:
  seven analytic tier-B constructions for `phasingFromTargetState` and three
  tier-D rows lifted from Orekit's `CartesianOrbitTest`. Worst healthy row
  still uses 59.0% of its budget — the tier-D Lambert watermark, unchanged, so
  nothing new is near its cliff. The new rows' own worst margin is **0.04%**.
- **Ratchet** — raised 33 -> 43 vectors, 30 -> 40 green;
  `phasingFromTargetState` enters at 10 rows with **zero** known-red, and the
  `orekit` library count goes 2 -> 5. No count fell and no row was demoted.
- **The derived angle, against analytic truth.** Each tier-B pair is built from
  elements whose separation is chosen by hand and handed to the module as
  Cartesian vectors only. Recovered: `+30.000000000 deg` (7.8e-16 rad error),
  `-30.000000000 deg` (5.6e-16), the opposed-apsides `+30 deg` (4.4e-16), the
  RAAN-projected `+20.310573890 deg` (1.7e-16), `+170 deg` (exact). Against
  Orekit's two published states the pair's relative phase agrees to
  **1.2e-14 rad** on a 1.1e-6 rad budget.
- **Both directions, honestly.** On a target leading by 30 degrees the module
  answers catch-up `146.0765 m/s` and fall-behind `1201.7458 m/s` and returns
  BOTH summaries whichever direction was asked for. The native suite asserts
  that the forced answers and the summaries are the same numbers.
- **Fuzz** — 885 hostile inputs (up from 698: every parameter of the new
  operation is in the mutation set, `maxRevs` included, because the
  recommendation is the only loop whose trip count a caller controls), zero
  traps on both runtimes, one instance throughout, still computing the correct
  Hohmann answer at the end.
- **Native C++** — 7/7 suites, compiled `-fno-exceptions` to match the shipped
  dialect. `test_classical` gains the state-to-elements round trip, the
  near-circular cancellation at e = 1e-9, both degenerate-state refusals and
  the opposed-apsides geometry; `test_approach` gains six phasing-from-state
  cases including the maxRevs clamp and the co-located pair.
- **SDK compliance** — `validatePluginArtifact` ok, imports
  `[wasi_snapshot_preview1]` only, `threadModel=wasi-sequential` resolved by
  the compiler and re-checked against the manifest.

## Evidence carried by 0.3.0 (historical)

Measured on `4e945bbf81a5a897161107e9d30b66a38535007c025fbde74c3e71cf19144c97`
(reproducible: two clean `node build.js` runs produced the identical digest):

- **Tri-runtime parity** — `parity PASS fixture=maneuver-command-parity
  module=4e945bbf81a5a897 lanes=[browser(84 runs), wasmedge(84 runs)]
  comparisons=308`, 21 cases byte-identical at 1/2/4/8 threads. Six of those
  cases are NEW and exist because 0.3.0 changed the response bytes: the Curtis
  5.3 domain-boundary bracket, the multi-revolution high branch, the same
  geometry with no branch stated (the default must not move), the hyperbolic
  conic report with its CONDITIONAL missing `apogeeRadius`, the min-dv
  candidate set as an ordered composite, and the branch-selector refusal. The
  `docker-wasmedge` lane could NOT be exercised on the build box (the Docker
  daemon does not come up: `Cannot connect to the Docker daemon at
  unix:///Users/tj/.docker/run/docker.sock`, unchanged from the 0.2.0 build);
  the native lane IS the pinned WasmEdge 0.16.4, so the pin is honoured, but the
  third lane is UNRUN and is reported as unrun.
- **Vectors** — 33 rows across three tiers on browser AND WasmEdge (28 at
  0.2.0), 30 of them green (22 at 0.2.0), 125 tests passing. Worst healthy row
  uses 59.0% of its budget — the tier-D margin watermark, unchanged from 0.2.0.
  The three rows that went green are the three defects this artifact closes:
  `hapsira-curtis-5-3`, `hapsira-der-molniya-1rev-highpath` and
  `lambert-perigee-radius-not-published-SCREENING`. Five rows are new:
  three forward-constructed march/boundary geometries, one min-dv case where the
  high branch wins by a factor of thirty-six, and the low branch asked for by
  name rather than by default.
- **Ratchet** — raised 28 -> 33 vectors, 22 -> 30 green;
  `solveLambert` 15 -> 19 rows with **zero** known-red (three at 0.2.0), and
  `solveLambertMinDV` gains its first row.
- **Lambert sweep** — 72 LEO geometries, every claimed solution arrives; worst
  arrival miss `3.539e-11` of `|r2|`, identical on both runtimes and
  BIT-IDENTICAL to 0.2.0. The bracketing repair is a change to the search only:
  no geometry 0.2.0 solved moved by a bit.
- **Fuzz** — 698 hostile inputs (16 values × every parameter of every wired
  operation including the new `branch`, plus 18 structural payloads including
  5,000-deep nesting), zero traps on both runtimes, one instance throughout,
  still computing the correct Hohmann answer at the end.
- **Native C++** — 7/7 suites, compiled `-fno-exceptions` to match the shipped
  dialect.
- **SDK compliance** — `validatePluginArtifact` ok, imports
  `[wasi_snapshot_preview1]` only, `threadModel=wasi-sequential` resolved by
  the compiler and re-checked against the manifest.

## Status

### 0.4.0 — STAGED 2026-08-10T20:35Z

Applied by `maneuver-phasing-0-4-0` under `/run/sdn-deploy.lock`, taken 20:35:03Z
and released 20:36:18Z, both ends recorded in `/var/log/sdn-deploy-lock.ledger`.
Catalog DATA only: no binary roll, no daemon restart, no unit file touched.

- artifact `artifacts/65918188…8576e77e.wasm`, 220,775 B, `sdn:sdn` `0644`. The
  uploaded bytes were re-hashed ON THE HOST before anything read them, and again
  after `install`, against the digest this repo committed. The content-addressed
  path did not previously exist, so nothing was overwritten.
- catalog row REPLACED in place (never appended — two ACTIVE rows for one
  `MODULE_ID` is a state the catalog defines no ordering over, and the
  storefront would list the module twice). 68 entries before and after, 68
  unique `MODULE_ID`s. Backup `modules-catalog.json.bak-20260810T203607Z`.
  `SUPERSEDES_CONTENT_HASH` was checked against the row being replaced rather
  than assumed, and the write refuses if the two disagree.
- validated BEFORE the write, because `pmmPlugin.Start` fails closed and that
  daemon also terminates TLS on :443. The pre-flight replicates `LoadCatalog` +
  `Manifest.Validate` + `HashArtifact`, **including stripping the 8-byte `$REC`
  publication trailer before hashing** — the trap recorded in
  `deployment/topology.json`: hash the raw bytes instead and every signed
  artifact reads as a false mismatch. Run THREE times — against the live catalog
  before touching anything, against the candidate, and against the installed
  file — and identical each time:

      68 entries, 53 served, 53 OK, 7 trailered, 0 bad

  which matches the clean run that topology file records for this host, so a
  restart would boot.
- `browse[]` needed no change: its maneuver row carries `module_id`, `family`,
  `module_path` and visibility flags, and no version.
- 0.3.0's artifact is left in place as the rollback. It is content-addressed, so
  the two never collide; reverting is restoring one catalog row from the backup.

**THE TICK MOVED, and it was checked rather than assumed.** The 6-hourly
`pmmRefreshInterval` runs from the daemon's own start, and this daemon RESTARTED
at 2026-08-10T19:14:30Z for an unrelated cellular re-mount
(`hephaestus-cell-remount`, ledgered), re-signing the manifest at 19:16:06Z. So
the rebuild that picks this row up is ~01:16Z on 2026-08-11 and NOT the ~00:12Z
the pre-restart schedule implies. Between the staging and that tick the manifest
legitimately still advertises 0.3.0 and
`/modules/maneuver-planner/0.4.0/module.wasm` legitimately 404s; that window is
not a failed deploy, and "fixing" it with a daemon restart nobody needed would
cost ~100 s of :443 — the app, the update feed and TLS — for convenience.

Both premises were checked against live state before staging rather than
believed: no other lane was mid-republish of this module (0.3.0's own staging
window closed at 18:12:54Z), and 0.3.0's artifact is on disk as the rollback.


The console side — the `wasmSolver` branch that calls `phasingFromTargetState`
and then arms CATCH S/C, FALL BEHIND and stage 2 of the composed far
rendezvous — belongs to the `/beta` lane and is tracked in
`saw-beta-maneuver-owner-followups`. **The response key it must read is
`relativePhaseAngle`**, not the `alongTrackAngle` the task filed: "along-track"
names a RIC distance elsewhere in this stack, and the SDK ruling on 2026-08-10
renamed it before it shipped rather than after.

### PREMISE CORRECTION, 2026-08-10 — this file said 0.2.0 was never published

It was. The section below used to read **NOT YET PUBLISHED**, and it was checked
against the live host rather than believed:

```
GET https://sdn.spaceaware.io/modules/maneuver-planner/0.2.0/module.wasm
  200, 200,879 bytes, etag "0746bb22…c2934ae"
GET https://sdn.spaceaware.io/.well-known/sdn/modules.pmm
  200 — module:maneuver-planner 0.2.0 0746bb22…c2934ae RECOMMENDED ANONYMOUS 0 ACTIVE
```

`maneuver-planner 0.2.0` has been live since 2026-08-10T07:06Z (deploy ledger,
`holder=maneuver-rebuild`). The recipe below was followed and this section was
not updated afterwards, so the file has been telling every subsequent reader
that a published artifact was unpublished. The 0.1.0 row is gone from the live
catalog; the lineage on the wire is `6028c779…` -> `0746bb22…` -> `4e945bbf…`,
exactly as `SUPERSEDES_CONTENT_HASH` records it.

### 0.3.0 — STAGED 2026-08-10T17:52Z

Applied by `maneuver-lambert-0-3-0` under `/run/sdn-deploy.lock`, taken 17:51Z
and released 17:54Z, both ends recorded in `/var/log/sdn-deploy-lock.ledger`.
Catalog DATA only: no binary roll, no daemon restart, no unit file touched.

- artifact `artifacts/4e945bbf…19144c97.wasm`, 205,798 B, `sdn:sdn` `0644`.
  The uploaded bytes were re-hashed ON THE HOST before anything read them, and
  again after `install`, against the digest this repo committed.
- catalog row REPLACED in place (never appended — two ACTIVE rows for one
  `MODULE_ID` is a state the catalog defines no ordering over, and the
  storefront would list the module twice). 68 entries before and after, no
  duplicate `MODULE_ID`. Backup `modules-catalog.json.bak-20260810T175206Z`.
- validated BEFORE the write, because `pmmPlugin.Start` fails closed and that
  daemon also terminates TLS on :443: the JSON parses back, the referenced
  artifact exists, its sha256 and byte count match the declared ones, and
  `SUPERSEDES_CONTENT_HASH` names the row being replaced.
- `browse[]` needed no change: its maneuver row carries `module_id`, `family`,
  `module_path` and visibility flags, and no version.
- 0.2.0's artifact is left in place as the rollback. It is content-addressed, so
  the two never collide; reverting is restoring one catalog row from the backup.

The `$PMM` lane has **no CLI verb and no HTTP endpoint** — confirmed again here
against the shipped binary's own help, where `plugins` exposes only
`publish-orbpro` (the encrypted licensed lane, which refuses a plaintext entry).
A staged row therefore goes live on the daemon's own `pmmRefreshInterval`
rebuild, 6-hourly from its start at 2026-08-09T18:11:23Z — i.e. ~18:11Z, and
the same rebuild picks up `janus-resign-wave`'s 12:57Z staging. Between the
staging and that tick the manifest legitimately still advertised 0.2.0 and
`/modules/maneuver-planner/0.3.0/module.wasm` legitimately 404'd; that window is
not a failed deploy, and reporting it as one is how a correct staging gets
"fixed" by a daemon restart nobody needed.

### 0.3.0 — LIVE 2026-08-10T18:12:54Z

The rebuild landed on schedule, with no restart and no intervention.

```
GET https://sdn.spaceaware.io/.well-known/sdn/modules.pmm
  module:maneuver-planner 0.3.0 4e945bbf…19144c97 RECOMMENDED ANONYMOUS 0 ACTIVE
  /modules/maneuver-planner/0.3.0/module.wasm

GET https://sdn.spaceaware.io/modules/maneuver-planner/0.3.0/module.wasm
  200, 205,798 bytes
  sha256 4e945bbf81a5a897161107e9d30b66a38535007c025fbde74c3e71cf19144c97
```

The served digest equals the committed one, so the bytes on the wire are the
bytes this repo built and tested.

**The served artifact was then RUN, not merely hashed** — a matching digest
proves delivery, not behaviour, and every defect this version closes lives in
behaviour. The file was fetched from the public URL and driven through the SDK
harness on browser AND WasmEdge:

| probe | live response | reference |
|---|---|---|
| Curtis 5.3, 0 revs — `no-solution` at 0.2.0 | `v1 = [-2435.667, 267.419, 0]` | hapsira `[-2435.6, 267.41, 0]`, rtol 1e-4 |
| Der Molniya, 1 rev, `branch: "high"` — unreachable at 0.2.0 | `branch "high"`, `v1 = [503.3577, 618.69408, -1571.76904]` | hapsira `lowpath=False`, exact to the printed digits |
| Der Molniya, 0 revs — silent at 0.2.0 | `transferConic "elliptic"`, `perigeeRadius 909990.65`, `apogeeRadius 51387540.49` | the arc that dives 5,468 km BELOW the surface, now reported so a consumer can screen it |

Identical on both runtimes.
