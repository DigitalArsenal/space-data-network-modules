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
into a neighboring reader.

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

## STK covariance (0.1.4)

An STK ephemeris with a `CovarianceTimePosVel` block in `CovarianceFormat
LowerTriangular` (COMSPOC's SynCoPate files, for example) reads with its
covariance: each row becomes an `$OEM` covariance line at its own epoch, the 21
lower-triangle values in the order both formats share, converted from
`DistanceUnit` to km units, with `COV_REFERENCE_FRAME` equal to the states'
`CoordinateSystem`. A position-only or upper-triangular covariance block is
refused by name. The STK writer writes the block back.

## SES and Intelsat eleven-parameter ephemerides (0.1.3)

`normalize_ses_i11` reads an Intelsat eleven-parameter (IESS-412) ephemeris
file as SES publishes it (provider format `ses-i11`), hash-checked against its
NCD, and evaluates the model from the element epoch to the file's stated end
of validity (170 hours when it states none) every 300 s. It emits one $OEM
block, Earth-fixed (`FIXED_EARTH`, the format names no realization) on UTC,
kilometers and kilometers per second, and the input NCD unchanged.

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

## Sentinel orbit files and NAIF CK (0.2.0)

Three more methods, all pure compute, no capabilities. **Every option of a request travels in the `$NCD` that
frames the file or in the target record** (owner, 2026-10-24: *"We need to be able to pass configurations using a
flatbuffer message"*); none travels in a JSON options file.

| Method | In | Out |
| --- | --- | --- |
| `normalize_sentinel_eof` | `container`: `$NCD` (`PROVIDER_DEFINED`, `"sentinel-eof"`) + an ESA Earth Explorer orbit file | `ephemeris` (`$OEM`), `descriptor` (`$NCD`) |
| `normalize_naif_ck` | `container`: `$NCD` (`"naif-ck"`) + a CK; `sclk`: `$NCD` (`"naif-sclk"`) + the clock kernel | `attitude` (`$AEM`), `descriptor` (`$NCD`) |
| `write_naif_ck` | `attitude` (`$AEM`), `sclk` (as above), optional `descriptor` (`$NCD`) | `container`: the frame `normalize_naif_ck` reads |

| Option | Where |
| --- | --- |
| selection window | container `$NCD` `START_TIME`, `STOP_TIME`: inclusive, on the file's own time scale (EOF: its `Time_Reference`; CK: the clock's TDB or TT) |
| object / segment | container `$NCD` `SEGMENTS`: an entry selects the CK segments whose `NAME` and/or `TARGET_NAIF_ID` (the instrument) match; none selects all |
| spacecraft clock | `sclk` `$NCD` `SEGMENTS[0].TARGET_NAIF_ID` (`-76`); without it NAIF's rule, the instrument id divided by 1000 |
| frames, instrument, segment id (write) | `$AEM`: `REF_FRAME_A` (a NAIF built-in inertial name or a decimal frame code), `REF_FRAME_B` (a decimal instrument code), `OBJECT_NAME` |
| file facts (write) | optional `$NCD` `INTERNAL_FILE_NAME`, `COMMENT_AREA` |

The ESA and NAIF formats have no `ncdContainerFormat` member yet, so they are `PROVIDER_DEFINED` with the names
above. What SDS needs for these (the enum members, and the request fields now carried by convention) is the exact
diff in `../rinex/README.md`, "What SDS needs".

### Sentinel EOF to `$OEM`

The Copernicus POD service publishes the precise (`AUX_POEORB`), restituted (`AUX_RESORB`) and predicted
(`AUX_PREORB`) orbits of Sentinel-1/2/3 as XML. The reader is strict: an unknown element, a unit other than `m` and
`m/s`, a `Time_Reference` the OSVs carry no stamp for, a `count` that disagrees with the list, epochs that do not
increase, non-XML and a non-EOF root are each refused by name. The states are read to **one `$OEM` block in the
file's own Earth-fixed frame**: `REFERENCE_FRAME.NAME = "EARTH_FIXED"` as the file spells it (and `FIXED_EARTH`
from the roster, since the file names no realization), `CENTER_NAME = EARTH`, kilometers and kilometers per
second (one division from the file's meters), the epoch text the file wrote on its `Time_Reference` (explicit
epochs, never a grid: a UTC grid is not uniform across a leap second). `OBJECT_NAME` is the mission the file
names; no catalog number is supplied. The `$NCD` records the source: internal file name, producing system and
creator, creation date, frame, time reference, the file type and validity as the one segment, the coverage read and
the SHA-256. `$OEM` has no column for the per-OSV TAI and UT1 stamps, the absolute orbit number or the Quality
flag; the block `COMMENT` declares that, with the orbit range and the flag counts.

### NAIF CK type 3 and `$AEM`

Only type 3 (discrete pointing with interpolation intervals) is read and written; any other type in a selected
segment is `unsupported-ck-type`. The quaternion is NAIF's (`q0` scalar, `q2m(q)` the C-matrix from the reference
frame to the instrument frame); CCSDS 504.0-B-2 annex F defines its quaternion from the same frame transformation
with the opposite handedness of the vector part, so **CCSDS (Q1 Q2 Q3 QC) from A to B = NAIF (-q1 -q2 -q3 q0)**,
an exact sign (A = the segment's reference frame, B = the instrument). The angular velocity is converted from rad/s
to deg/s and is expressed in `REF_FRAME_A`. An interpolation interval is a continuity claim, so a CK segment with
several intervals becomes several `$AEM` segments. `REF_FRAME_B` is the instrument code and `REF_FRAME_A` a NAIF
built-in name or the decimal frame code, because a CK stores integers and the names of mission frames live in a
frame kernel this module is not given.

Time comes from the SCLK kernel (read with `propagator/solar-system-bodies`' text-kernel reader): NAIF's type 1
conversion on the clock's declared time system, TDB or TT, **with no time-scale conversion**; `TIME_SYSTEM` says
which. A writer refuses a `TIME_SYSTEM` that is not the clock's (`time-system-mismatch`), a B2A direction, an
attitude type other than `QUATERNION` and `QUATERNION/ANGVEL`, an angular velocity expressed in `REF_FRAME_B`, the
compact form (it would have to invent epochs), a non-unit quaternion and a name over 40 characters.

### Measured

| Claim | Authority | Result |
| --- | --- | --- |
| EOF states (Sentinel-1A `AUX_POEORB` x2, `AUX_RESORB`; 721, 721 and 541 OSVs) | Python `xml.etree` reading the same bytes | identical to the bit, epochs included |
| Same arc, two precise files | adjacent-day `AUX_POEORB`, 721 common epochs | worst 3D difference **1.8 mm** |
| Same arc, restituted against precise | 6-node Hermite of the precise states (`tests/reference/eof_resorb_vs_poe.py`) | 539 states, max **3.9 cm**, rms 3.1 cm |
| CK read | NAIF-published MSL and InSight kernels, CSPICE N0067 (spiceypy 8.3.0) raw read | 30 records, quaternion and rates identical to the bit |
| CK time | NAIF's type 1 formula from the kernel text; CSPICE `sct2e` + `unitim` | 0 s; 4.8e-7 s (CSPICE's TT/TDB round trip) |
| quaternion convention | CSPICE `q2m` against annex F's matrix of (-q1 -q2 -q3 q0) | 3.3e-16 over all 30 records |
| CK write | a kernel this module writes (2 segments, 265 records), read by CSPICE `ckgp`/`ckgpav` | rotation **2.2e-16 rad**, rate 4.3e-19 rad/s |
| tri-runtime | browser and native WasmEdge, 18 cases | byte-identical (`conformance/parity.json`); Docker leg waived by the owner |

The sample set is Sentinel-1A. Sentinel-2 and Sentinel-3 orbit files are published on the same service and in the
same format, but their download needs a Copernicus Data Space account, so none was read here; a file whose
structure differs is refused by name, not guessed. Fixtures and their sources and licenses:
`fixtures/interchange/PROVENANCE.md`. The references are generated by `tests/reference/*.py` and committed.
