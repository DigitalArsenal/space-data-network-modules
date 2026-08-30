# files/ccsds-messages

CCSDS **AEM** (Attitude Ephemeris Message) and **TDM** (Tracking Data Message)
readers and writers, measured against the published Blue Book example messages.

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
| Record | *(not yet)* | The `$AEM` / `$TDM` projection. Gated on a schema — see below. |

The document layer is what makes exactness provable, and the measurements bear
it out: **110 checks, 0 failures**, and the numeric round trips are exactly
`0.0` rather than merely small, because values are carried as written.

## Measured, against the published books

Fixtures and their extraction are documented in `fixtures/PROVENANCE.md`.
**Premise correction:** the task body names CCSDS 504.0-B-1 and 503.0-B-1; both
are superseded and `public.ccsds.org` serves only B-2 for each (verified
2026-08-30, B-1 URLs 404).

| Claim | Result |
| --- | --- |
| KVN round trip, parse→serialize→parse, structural | 5 fixtures, **0 differences** (225 / 154 / 223 / 163 / 250 fields compared) |
| Keyword coverage vs an independent line scan | sets **equal**, not superset. AEM union **22** — the whole Annex-G2 corpus. TDM union **33** across three figures. |
| AEM numeric fidelity through the serialized form | max relative error **0.0** (bound 1e-12) |
| Structured-view round trip | **0** differences on all five |
| Component-count mismatch | refused (code −13) with an explicit fault, **no** Message produced |

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

## The record projection is gated on a schema

`src/aem.hpp` and `src/tdm.hpp` each end with a marked, empty projection seam.
They are empty because at `spacedatastandards.org` 1.201.0 the records cannot
carry these messages:

- **`$AEM`** has no carrier for `CENTER_NAME`, `QUATERNION_TYPE`,
  `EULER_ROT_SEQ`, `RATE_FRAME`, `INTERPOLATION_METHOD`,
  `INTERPOLATION_DEGREE`, `USEABLE_START_TIME`, `USEABLE_STOP_TIME` or
  `MESSAGE_ID`, and it reconstructs epochs from `START_TIME + i * STEP_SIZE` —
  which Figure G-4 disproves.
- **`$TDM`** has **no `RANGE` field at all** — the format's primary observable —
  and models observations as parallel arrays on a uniform grid, which Figure
  E-17 disproves.

Themis ruled the additive extension required and is landing it under
`upstream-spacedatastandards-10`. The views consume the ordered `kvn::Entry`
list rather than a struct precisely so the projection can attach without
reshaping this layer when the schema lands.

## Build and test

```sh
npm ci
npm test          # 110 checks against the published examples
```

The module's compiled surface lands with the record projection: the SDK
requires every port to declare one concrete SDS identity, and until the records
can carry these messages there is nothing honest to declare.
