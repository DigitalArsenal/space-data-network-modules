# Delivering maneuver-planner 0.3.0 to an SDN node

`modules-catalog.entry.json` is this module's row for a node's
`<storage>/modules/modules-catalog.json`. It is committed here because the
catalog is DATA — the node's `internal/pmm` package is explicit that it is a
connector, not an application, and that every policy decision (which module is
CORE, which is browsable, which is entitled) arrives as data rather than as Go
code. The module ships the row it wants; the node operator decides whether to
admit it.

## What changed from the 0.2.0 row

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
SHA=4e945bbf81a5a897161107e9d30b66a38535007c025fbde74c3e71cf19144c97
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

# 4. leave 0.2.0's artifact in place until 0.3.0 is verified live. It is
#    content-addressed, so the two never collide, and it is the rollback.
```

**Validate before you write.** `pmmPlugin.Start` fails CLOSED: a catalog it
cannot load means `RegisterRoutes` mounts nothing and the ENTIRE
`/.well-known/sdn/modules.pmm` + `/modules/` surface 404s until someone
notices. On host-01 that daemon also terminates TLS on :443. Run the daemon's
own `LoadCatalog` + `Manifest.Validate()` + `HashArtifact` over the candidate
file rather than eyeballing it.

## Evidence carried by this artifact

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

**NOT YET PUBLISHED.** Staging to `sdn.spaceaware.io` requires the deploy lock
and host access; this file is the recipe and the row, ready to apply. 0.2.0 was
never staged either, so the live catalog still carries the 0.1.0 row — a node
admitting 0.3.0 goes straight from `6028c779…9cfe043` to `4e945bbf…19144c97`,
and `SUPERSEDES_CONTENT_HASH` names the 0.2.0 artifact that was built and
verified but never served. Update this section with the staged/live timestamps,
the manifest module count before and after, and the artifact's
`HTTP 200 / etag` when it lands.
