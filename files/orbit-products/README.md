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
| `src/oem_projection.hpp` | The `Series` → `$OEM` projection: which of the record's two state forms a history takes, and the epoch text. |
| `src/orbit_products_module.cpp` | The module surface: `read_container` and `describe_container`, the `$NCD` framing and its SHA-256 check, and the vocabulary mapping onto `timingStandard` and `CelestialFrame`. |

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

## The module surface

`upstream-spacedatastandards-10` landed in `spacedatastandards.org` **1.202.0**,
so the surface that had no record to type its ports on now has one. Two methods
ship, both pure compute, no capabilities:

| Method | In | Out |
| --- | --- | --- |
| `read_container` | `$NCD` + the container's bytes | `ephemeris` (`$OEM`), `descriptor` (`$NCD`) |
| `describe_container` | `$NCD` + the container's bytes | `descriptor` (`$NCD`) |

**How the bytes arrive.** `$NCD` describes a container, it does not carry one —
it has `SOURCE_SHA256`, `SOURCE_BYTE_LENGTH` and `SOURCE_CID` and no payload
field. The SDK refuses a port typed `acceptsAnyFlatbuffer`, so "typed
descriptor plus raw bytes" cannot be two ports; the byte port would have no
concrete SDS identity to declare. So one port carries both, in this order:

```
[u32le n][ $NCD flatbuffer, n bytes ][ the container's exact bytes ]
```

which is a size-prefixed `$NCD` with the described file appended. The size
prefix is self-describing, so the boundary comes out of the frame rather than
out of an agreement, and when the caller declares `SOURCE_SHA256` or
`SOURCE_BYTE_LENGTH` they are CHECKED against the trailing bytes — a mismatch
is `descriptor-hash-mismatch` / `descriptor-length-mismatch`, not a read. That
check is what the schema carries the hash for, and it is why this module needs
no fetch capability to do its job.

**What the schema bump bought.** `$OEM` 1.1.4 added per-state clock bias and
rate, the per-coordinate sigma exponents, and `OBJECT_NAIF_ID` /
`CENTER_NAIF_ID`. Those are exactly the columns an SP3 read and an SPK read had
been dropping: SP3's clock column is mandatory in every position record, and an
SPK segment stores integer body codes with no ratified text mapping back. Both
are populated now, so a state history no longer loses its clocks on the way
into the record or its body identity on the way out.

`FORMAT` selects the reader; `UNSPECIFIED` asks the module to identify the
container from its own leading bytes and say what it found. A member of the
`$NCD` roster this reader does not project onto `$OEM` — the attitude and
tracking-data containers, OEM in XML — is refused by name rather than folded
into a neighbouring reader.

Propagation is a separate lane and is unchanged: `data-source/spk-source`
reaches these same headers through `plugin_init_ephemeris`, an ABI export that
carries bytes directly and therefore needs no port type at all.

## Build

```sh
npm ci
npm run build      # generates the SDS headers, compiles, signs
npm test           # the native acceptance suites
```

The build generates `src/generated/sds/*.h` from the **published**
`spacedatastandards.org` package this repo pins, never from a sibling checkout
(published-deps law, owner 2026-08-21).

## Vimpel epoch-state conversion (0.1.1)

`normalize_vimpel` accepts a hash-checked NCD+raw orbit table with provider format
`vimpel-orbits-text`. It converts the documented **osculating** elements using
`foundation/orbits`, with true anomaly equal to argument of latitude minus
argument of perigee. It emits one canonical J2000/UTC OPM per object and the
original NCD. The reference-epoch velocity is analytic; it is never differentiated
from the ten-minute positions. Native identity remains namespaced. Unknown
uncertainty markers and signed age values stay in the raw source, and no
covariance, drag coefficient or SRP coefficient is fabricated.

See [catalog epoch fitting](../../analysis/catalog-composer/docs/epoch-fitting.md)
for position-arc validation, fitting and reproducible real-provider evidence.

## SES and Intelsat eleven-parameter ephemerides (0.1.3)

`normalize_ses_i11` reads an Intelsat eleven-parameter (IESS-412) ephemeris
file as SES publishes it (provider format `ses-i11`), hash-checked against its
NCD, and evaluates the model from the element epoch to the file's stated end
of validity (170 hours when it states none) every 300 s. It emits one $OEM
block, Earth-fixed (`FIXED_EARTH`, the format names no realization) on UTC,
kilometres and kilometres per second, and the input NCD unchanged.

The evaluation is the one Orekit 13.1 implements
(`IntelsatElevenElementsPropagator.propagateInEcef`): east longitude and
geocentric latitude as functions of the days since the epoch, the cross term
of the latitude amplitudes in the longitude, and the radius from the longitude
drift on the 42164.57 km synchronous radius. Velocities are the analytic
derivatives. The satellite is named as the file names it; no catalog number is
supplied.

The files print the satellite's predicted longitude and latitude at a stated
hour after the epoch. The method evaluates that prediction first and refuses a
file whose elements do not reproduce it to the printed precision (6e-5 deg:
half the printed 1e-4 deg plus the rounding of the inputs). Every one of the
38 SES files captured on 2026-09-09 reproduces its prediction within 5e-5 deg.

Evidence (`tests/ses_i11.test.mjs`):

| Claim | Reference | Tolerance |
| --- | --- | --- |
| Earth-fixed position and velocity at 0–170 h, three element sets (Orekit's own Intelsat 4521 set, an inclined drifting orbit, a station-kept one) | Orekit 13.1, `tests/fixtures/ses-i11/GenerateReference.java` and its output | 1 mm, 1 µm/s (double-precision evaluation of the same expressions) |
| Longitude and latitude at 170 h for Intelsat 4521 | Intelsat's calculator, as Orekit 13.1's test asserts it (301.9191 E, 0.0257 N) | 1e-4 deg |
| Longitude, latitude, radius and radial rate at the epoch for Intelsat 4521 | STK, as Orekit 13.1's test asserts it (302.0355 E, 0.0378 N, 42172456.005 m, 0.797 m/s) | 1e-4 deg, 1 mm, 1 mm/s |
| A printed prediction the elements do not reproduce, a wrong format name, a wrong hash and a missing parameter line | refused, no output | — |
