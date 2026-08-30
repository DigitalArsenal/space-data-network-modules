# files/orbit-products

Readers and writers for the four ephemeris **containers** GMAT can produce and
consume, projected onto SDS `$OEM`: **SPK** (NAIF DAF, segment types 8, 9 and
13), **Code-500**, **STK ephemeris** (`.e`, and `.a` for attitude) and
**SP3-d**.

A container is a wire format, not a standard. Nothing here mints a record: the
state history goes into `$OEM` and comes back out of it, and the container's
own header facts go into the native-container descriptor that
`upstream-spacedatastandards-10` is landing.

## Layout

| File | What it owns |
| --- | --- |
| `src/ephemeris_series.hpp` | The spine: one in-memory `Series` every reader writes into and every writer reads out of, plus the Linear/Lagrange/Hermite evaluation and the endianness helpers. |
| `src/daf.hpp` | The NAIF Double Precision Array File container: file record, summary and name records, comment area, segment descriptors. |
| `src/spk_read.hpp` | SPK segment evaluation, types 8, 9 and 13. |
| `src/spk_write.hpp` | A type-13 DAF/SPK writer. |
| `src/code500.hpp` | Code-500 fixed-record binary ephemeris, read and write. |
| `src/stk_ephemeris.hpp` | STK `.e` ephemeris and `.a` attitude, read and write. |
| `src/sp3.hpp` | SP3-d, read and **write** — the writer is the gap this task closes. |

Headers, not compiled units, because the SDK compiles ONE translation unit per
module and three consumers assemble different subsets of these: this package's
own reader module, the `data-source/spk-source` ephemeris propagator, and the
signed closed `exporter-ephemeris`. One implementation, three artifacts — the
alternative is the five-mirror drift the propagator ABI header exists to end.

## Two rules that shape everything here

**No time-scale conversion.** Every container declares its own time system —
SPK stores ET seconds past J2000, SP3 is GPS, an STK file counts seconds from
its own `ScenarioEpoch`, a CCSDS OEM names `TIME_SYSTEM` outright. Converting
between them needs the leap-second table `foundation/time` already owns and
measures, and a second copy of that table here is the drift this stack keeps
paying for. A `Series` therefore carries epochs in the scale its container
declared plus the NAME of that scale. This is also why the round-trip
tolerances are honest: a round trip never crosses a leap second.

**The container's interpolation rule wins.** An SPK segment type fixes it (8
and 9 are Lagrange, 13 is Hermite), an OEM says `INTERPOLATION` and
`INTERPOLATION_DEGREE`, an STK file says `InterpolationMethod`. A reader that
substitutes its own rule is not reading the file, it is fitting one. The only
caller allowed to override the degree is the acceptance that asserts
Hermite-versus-Lagrange error ordering on a known-analytic arc.

## Authorities

Nothing here is checked against itself.

| Claim | Authority |
| --- | --- |
| SPK read, types 8/9/13 | CSPICE N0067 via spiceypy 8.2.0, against NAIF-**published** kernels |
| DAF structure | The DAF Required Reading, compared field-by-field with CSPICE's own descriptor read |
| SPK write | Read back by CSPICE, not only by our reader |
| STK `.e` | Orekit 13.1 `STKEphemerisFileParser`, plus a published example file's printed precision |
| SP3-d | The IGS SP3-d specification, plus Orekit 13.1 `SP3Parser` as an independent parser |
| Code-500 | The format as GMAT R2026a (Apache-2.0) implements it, read as a specification — no GMAT code is vendored |

Fixture provenance, including source URLs and hashes, is in
`fixtures/PROVENANCE.md`.

## The module surface is gated on a schema

The reader **headers** are complete and measured. The module's *method* surface
is not shipped yet, and the reason is structural rather than unfinished work:
the SDK requires every port to declare one concrete SDS identity, and raw
container bytes have no SDS record at pin 1.201.0. That is the native-container
descriptor Themis ruled a mint for, tracked as
`upstream-spacedatastandards-10`. The port lands with the record.

Propagation is unaffected and ships today: `data-source/spk-source` reaches
these same headers through `plugin_init_ephemeris`, an ABI export that carries
bytes directly and therefore needs no port type at all.

## Build

```sh
npm ci
npm run build      # generates the SDS headers, compiles, signs
npm test           # the native acceptance suites
```

The build generates `src/generated/sds/*.h` from the **published**
`spacedatastandards.org` package this repo pins, never from a sibling checkout
(published-deps law, owner 2026-08-21).
