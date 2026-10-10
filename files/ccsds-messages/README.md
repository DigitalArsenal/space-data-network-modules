# files/ccsds-messages

CCSDS **AEM** (Attitude Ephemeris Message) and **TDM** (Tracking Data Message)
readers, writers and SDS record projections, measured against example messages in
the layouts of the published Blue Book examples.

## The shape, and why it is this shape

The acceptance is *"every KVN keyword round-trips exactly"*. That property
belongs to the **document**, not to any record it is projected into — the
moment a reader parses into a fixed struct, every keyword the struct does not
name is gone, and the round trip is only exact for the subset somebody
remembered.

So this package is three layers:

| Layer | File | What it guarantees |
| --- | --- | --- |
| Document | `src/kvn.hpp` | Ordered, lossless keyword/value/units/comment model. Round trip is exact by construction. |
| View | `src/aem.hpp`, `src/tdm.hpp` | Named accessors over that document, with per-message structure (attitude component widths, observation triples). Refuses rather than truncates. |
| Record | `src/aem_projection.hpp`, `src/tdm_projection.hpp` | The `$AEM` / `$TDM` projection, both directions, against `spacedatastandards.org` **1.202.0** (`$AEM` 2.0.2, `$TDM` 2.0.4). What it cannot carry it **declares**. |

## Measured, against the published books

The checked-in fixtures are synthetic messages with the structure and quirks of
the books' annex examples (`fixtures/PROVENANCE.md`); the books state no terms
for reproducing the examples themselves. The findings below were made on the
books' own text.

Fixtures and their extraction are documented in `fixtures/PROVENANCE.md`.
**Premise correction:** the task body names CCSDS 504.0-B-1 and 503.0-B-1; both
are superseded and `public.ccsds.org` serves only B-2 for each (verified
2026-08-30, B-1 URLs 404).

**222 checks, 0 failures** across two lanes — 110 for the KVN layer, 112 for the
record projection.

| Claim | Result |
| --- | --- |
| KVN round trip, parse→serialize→parse, structural | 5 fixtures, **0 differences** (225 / 154 / 223 / 163 / 250 fields compared) |
| Keyword coverage vs an independent line scan | sets **equal**, not superset. AEM union **22** — the whole Annex-G2 corpus. TDM union **33** across three figures. |
| AEM numeric fidelity through the serialized form | max relative error **0.0** (bound 1e-12) |
| Structured-view round trip | **0** differences on all five |
| Component-count mismatch | refused (code −13) with an explicit fault, **no** Message produced |
| **Record round trip**, KVN→view→`$AEM`/`$TDM`→FlatBuffer→view→KVN | 5 fixtures, **0 differences** (225 / 153 / 223 / 158 / 240 fields compared) |
| **Keyword accounting**, mapped + declared-lost vs an independent count | equal on all five (32, 16, 22, 15, 25) |
| **Sampled attitude** through the record | max relative error **0.0** over 64 components (bound 1e-12) |
| **Observation epochs** through the record | 0 mismatches, verbatim, on all three TDM fixtures |
| **Uniform-grid rule** where a grid exists (E-18, both segments) | `START + i·STEP` reproduces every epoch, max error **0.0 s** (bound 1e-9 s), step 1.0 s |
| `TRANSMIT_RAMPS` on a ramp-free record | **absent** (null accessor on the buffer), not empty, on all three |
| Ramped record | 14/14 ramp fields survive exactly; **0** ramp keywords reach the KVN body; the ramp-free message is **0 differences** from the ramped one |
| Malformed record | NaN attitude and infinite observation both **refused** by status code, no Message produced |

Cross-checked with **Orekit 13.1** (`AemParser`, `TdmParser`), which agrees on
four of the five fixtures.

## Two findings from the published corpus

**Figure G-4 is non-uniform.** Its first segment steps **2336.3 s, then 1.0 s,
then 98398.0 s** — a max/min ratio of 98398. Every CCSDS AEM data line carries
an explicit epoch, so `START_TIME + i * STEP_SIZE` cannot express a real AEM.

**Figure E-17 goes backwards.** Its final `RCS` observation is stamped
`10:26:33.7008`, **0.2678 s earlier** than the `CARRIER_POWER` line above it.
Orekit preserves that ordering too. There is no grid to lay parallel columns
on.

Both are in the published books, and both refute a uniform-grid record.

## Orekit is stricter than the book

Orekit **rejects** published Figure E-17: *"unexpected keyword … EPHEMERIS_NAME"*.
Its `TdmMetadataKey` defines only `EPHEMERIS_NAME_1..5`, never the bare form
the Blue Book prints, and its own corpus contains no transcription of E-17.
That is Orekit being stricter than CCSDS, not a defect in the fixture, and the
fixture was **not** changed. With only that line removed (in scratch, never in
the repo) Orekit parses it and agrees exactly — including the backwards RCS
epoch.

Two things Orekit does that this layer deliberately does not: it
**renormalises** quaternions (`0.56748` → `0.5674807981623039`) and **converts
units** (RADEC degrees → radians, km → m). Both make an exact keyword round
trip impossible. The value is kept as written.

## The record projection

SDS **1.202.0** (Themis, `upstream-spacedatastandards-10`) added the carriers
these messages need: `attitudeDataLine` with a per-state `EPOCH` and the whole
504.0-B-2 table 4-4 column set, ten more `AEMSegment` keywords, and on `$TDM` a
`TDMObservation{KEYWORD, EPOCH, VALUE}` triple plus a real `TDMSegment`. The
seams in `src/aem.hpp` and `src/tdm.hpp` are filled.

**Always the verbose form.** `STEP_SIZE` is 0 and `ATTITUDE_DATA` empty for
every segment, uniform or not. Figure G-4 cannot use the compact form at all,
and choosing it for the uniform Figure G-5 would mean computing a step size from
two epoch strings and an epoch string back from a start and an index — which
needs the leap-second table `foundation/time` owns, and would not reproduce
`2006-090T05:00:00.196` even so. A record that ARRIVES in the compact form is
refused with `compact-form-needs-time-math` rather than guessed at.

**Observations are triples in file order.** Never sorted, never deduplicated,
never gathered into columns. The root's legacy parallel arrays and their
`OBSERVATION_START_TIME + i * OBSERVATION_STEP_SIZE` grid are never written, and
a record carrying only them is refused with `uniform-grid-needs-time-math`.

**`TRANSMIT_RAMPS` is absent, not empty.** No ramp is ever synthesised from
`TRANSMIT_FREQ_1`, and no ramp field — nor `SIGNAL_TO_NOISE`, `SPECTRAL_MAX` or
`DOPPLER_NOISE_HZ` — ever reaches a KVN body, because CCSDS has no keyword for
one. A ramp-free record is exactly a CCSDS-conformant TDM.

**Absent is not zero.** A FlatBuffers table omits a scalar equal to its type
default, so a numeric keyword written as `0` and one never written are the same
bytes. A keyword is re-emitted only when it differs from the default, and the
projection declares on the way in every keyword that rule will drop.

### What the record still cannot carry, declared rather than dropped

`ProjectionReport::losses` names every keyword and comment with no field to land
in, with its segment and its text — so a caller can ask *what will I lose*
before it writes. The acceptance uses that report as its reference: the original
document with exactly the declared losses removed must match the round-tripped
one field for field, with **zero** differences. A loss the projection failed to
declare shows up as a difference; a loss it declared but did not cause shows up
as a failed removal.

The published corpus produces three, and each is a **LACK** for Themis:

| Fixture | Declared loss | Why |
| --- | --- | --- |
| G-5 | `COMMENT` (`no-carrier`) | A COMMENT line **inside the data block**. `AEMSegment.COMMENT` is defined as the metadata block's comments and `attitudeDataLine` has no comment field, so carrying it would make the record say the file had it somewhere it did not. |
| E-17 | `EPHEMERIS_NAME` (`no-carrier`) | 503.0-B-2's metadata table defines only `EPHEMERIS_NAME_1..5`; the bare form the figure prints is not in it, and Orekit rejects the same line. Renaming it to `_1` would invent a participant index. |
| E-18 | `FREQ_OFFSET` ×2 (`default-valued`) | `FREQ_OFFSET = 0.0` in both segments. Zero is the field's type default and therefore the same bytes as absent. |

The counts are **pinned** in the harness. When a carrier lands, the pin goes to
zero — which is the point of pinning it.

### Two fields that are NOT here, on purpose

`QUATERNION_TYPE` was **removed** by CCSDS 504.0-B-2 (change item 7) and
`RATE_FRAME` occurs zero times in B-2 — **`ANGVEL_FRAME`** is the ratified name.
Themis refused both with evidence; neither is reintroduced. The two B-1
spellings the reader still accepts (`QUATERNION/RATE`, `EULER_ANGLE/RATE`) map
onto the columns B-2's rename produced, because B-2 renamed those keywords, it
did not add a second set of columns for the old ones.

### JSON

`to_json` emits the record with keys stringized from the same identifiers the
field accesses compile against, so no key was ever typed by hand
(json-schema-capitalization-rule). `tests/ccsds_projection.test.mjs` closes the
loop at the other end: it parses
`node_modules/spacedatastandards.org/schema/{AEM,TDM}/main.fbs` and requires the
emitted key set of each of the seven tables to be exactly that table's IDL field
set, case-exact, in both directions. A schema rename fails the suite. The two
`$RFM` union fields on the `$TDM` root have no JSON-trivial form and this
projection never populates them — a CCSDS TDM states its frame in
`REFERENCE_FRAME`, carried as the string the file wrote.

## Build and test

```sh
npm ci
npm run build     # dist/isomorphic/module.wasm, signed
npm test          # 222 native checks + 7 artifact/invoke tests
```

Two lanes, because they have different dependencies:

- `tests/ccsds_native.cpp` — the KVN layer. Compiles with `-I src -I tests` and
  **nothing else**: no SDS schema, no FlatBuffers runtime, no generated header.
  It is the floor everything else stands on and must stay measurable when the
  record toolchain is not available. 110 checks.
- `tests/ccsds_projection_native.cpp` — the `$AEM` / `$TDM` projection. Needs the
  generated headers (`src/generated/sds/`, produced by
  `generate-sds-headers.mjs` from the pinned `spacedatastandards.org`) and the
  FlatBuffers C++ runtime, which comes from `flatc-wasm`'s embedded C++ tree —
  the same source the module SDK's own compiler uses
  (`space-data-module-sdk/src/compiler/flatcSupport.js`). Both are **published
  packages this module already pins**; neither is read from a sibling checkout,
  which would not resolve from a task worktree and would break the
  published-deps law. The runtime is written to a temp directory for the length
  of the compile and deleted with it. 112 checks.

Binaries are built into a temp directory and deleted. Nothing compiled here ever
lands in the repo.

`tests/ccsds_test_support.hpp` holds the apparatus both lanes share — the RESULT
printer, the structural document comparison, the independent line scans, the
epoch arithmetic — and knows nothing about SDS.

## The compiled module surface

`plugin-manifest.json` + `build.mjs` build `dist/isomorphic/module.wasm` —
**327,328 bytes**, `pluginFamily: "parser"`, `capabilities: []`,
`threadModel: "wasi-sequential"`, standalone WASI (imports
`wasi_snapshot_preview1` and nothing else), **signed in the build** by
`scripts/sign-module-artifact.mjs`. Four methods, four exports:

| Method | In | Out |
| --- | --- | --- |
| `read_aem` | `$NCD` + AEM text | `$AEM`, `$NCD` |
| `read_tdm` | `$NCD` + TDM text | `$TDM`, `$NCD` |
| `write_aem` | `$AEM` | `$NCD` + AEM text |
| `write_tdm` | `$TDM` | `$NCD` + TDM text |

**The frame.** The SDK requires every port to declare a concrete SDS identity
and refuses `acceptsAnyFlatbuffer`, but this module's product is KVN *text* and
a frame of text has no record identity of its own. `$NCD` describes a file and
deliberately does not carry one, so descriptor and file travel together in one
frame — the same shape `files/orbit-products` reads:

```
[u32le n][ $NCD flatbuffer, n bytes ][ the message's exact bytes ]
```

i.e. a size-prefixed `$NCD` with the described file appended. The prefix makes
the boundary self-describing rather than agreed out of band, and
`SOURCE_SHA256` / `SOURCE_BYTE_LENGTH` make the pairing **provable**: whenever
the caller declares either, it is checked against the trailing bytes and a
mismatch is refused. That check is why the schema carries the hash, and it is
what lets a pure parser do its job with no fetch capability.
`ncdContainerFormat` already names `CCSDS_AEM_KVN = 9` and
`CCSDS_TDM_KVN = 11`, so this is the use those members were minted for. A
descriptor declaring the *other* CCSDS message is refused, never reinterpreted.

**Four methods rather than one.** A single `read_message` would leave one of two
record ports unpopulated on every invoke, making both optional and the contract
"one of these, we will not say which". Naming the message in the method keeps
every port required and every invoke's shape known before it runs.

**The methods are invoked in the tests, not just built.**
`plugin_push_output_ex` takes
`(…, root_type, fixed_string_length, required_alignment, ptr, len)`, and
transposing the two `uint16`s compiles, links, passes SDK compliance and
inspects clean — then refuses every call with `unsupported-output-type`.
Verified: with the two transposed, `node build.mjs` still succeeds and the
compliance and inspection tests still pass, and only the invoke tests go red.
`tests/ccsds_module.test.mjs` therefore calls all four methods, and proves the
frame by **consumption**: read a published fixture, write the record back, read
that emitted frame, and assert the two record payloads are byte-identical. It
also asserts no SDS extension (`TRANSMIT_RAMPS`, `SIGNAL_TO_NOISE`,
`SPECTRAL_MAX`, `DOPPLER_NOISE_HZ`) ever reaches the CCSDS body, and that a
wrong `FORMAT`, a hash over other bytes, and a descriptor with no file behind it
are each refused.

The descriptor states only what the file said. `PRODUCER`,
`INTERNAL_FILE_NAME` and `SOURCE_CID` have no CCSDS keyword, so they are carried
through from the caller's descriptor when it stated them and left empty
otherwise — never synthesised from `ORIGINATOR`, which is a different fact.
`START_TIME` / `STOP_TIME` come from the first and last segment rather than a
comparison across all of them, because both books require segments in time order
and comparing epoch strings would be time math this package does not do. Figure
E-17 declares neither, and gets neither.

`SOURCE_SHA256` is computed with `files/orbit-products`' `sha256.hpp`: one
implementation, included by whoever needs it, because a descriptor written by one
package and checked by the other must hash the same way. The reach is already
mutual — `orbit-products` includes this package's `kvn.hpp` for its own OEM
reader.
