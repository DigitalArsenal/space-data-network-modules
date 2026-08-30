# fixtures/ — SPK provenance

Every kernel here is either published by NAIF and copied verbatim, or
written by the official NAIF toolkit through spiceypy. Nothing in this
directory was produced by the code it tests.

Generator: /Users/tj/software/gmat09-authority/gen_spk_vectors.py
Toolkit:   CSPICE_N0067 (spiceypy 8.2.0)

## cspice_multi_summary.bsp

- size: 39936 bytes
- sha256 (as committed): 1ee1c2e1badd489cf9e8f9b5d8498d0e7f6bf8bc0d086dc38545a47d75977cab
- source: none; synthesised for this acceptance
- produced by: 30 type-13 segments written by spkw13 into one kernel, so the summaries spill past the 25 a single summary record holds and the forward link is exercised
- note: bodies -1000 .. -1029, 20 states each, degree 7

## cspice_t05_unsupported.bsp

- size: 6144 bytes
- sha256 (as committed): 662719bc9065a8c9194416ee8d9b8a5cbd210ebb2d831fb39313593b6fd2d9ed
- source: none; synthesised for this acceptance
- produced by: written by the official NAIF toolkit through spiceypy 8.2.0 / CSPICE_N0067: spkw05(body=-930, center=399, frame=J2000, segid='T5-DISCRETE-TWO-BODY', degree=n/a, n=50)
- note: a circular two-body arc (mu=398600.4418000 km^3/s^2, r=7000 km, i=51.6 deg) sampled analytically in position and velocity

## cspice_t13_big_endian.bsp

- size: 17408 bytes
- sha256 (as committed): efd7db5f33bf0be5124503d20281efc6bb5e66bc0feb2b0a6bae1dd9f8fc2b84
- source: none; synthesised for this acceptance
- produced by: writer_parity_t13.bsp with every double and every summary integer byte-reversed and LOCFMT set to BIG-IEEE; character fields (ID word, internal file name, comment area, name record, FTP string) untouched
- note: verified by CSPICE: spkpvn on this file and on writer_parity_t13.bsp return bit-identical states at 7 probe epochs

## cspice_t13_deg7_deg5.bsp

- size: 48128 bytes
- sha256 (as committed): 2c788b722f390956029b8631018ee84f16852b71b81fa26fbeeae3e88c56fa78
- source: none; synthesised for this acceptance
- produced by: written by the official NAIF toolkit through spiceypy 8.2.0 / CSPICE_N0067: spkw13(body=-920, center=399, frame=J2000, segid='T13-DEG7-EVEN-WINDOW', degree=7, n=400); spkw13(body=-921, center=399, frame=J2000, segid='T13-DEG5-ODD-WINDOW', degree=5, n=400)
- note: a circular two-body arc (mu=398600.4418000 km^3/s^2, r=7000 km, i=51.6 deg) sampled analytically in position and velocity

## cspice_t8_deg7_deg8.bsp

- size: 41984 bytes
- sha256 (as committed): b8d40f51e804dbb53f37285eb47f87f1db89ad2a6804c2159cd63a375f58e475
- source: none; synthesised for this acceptance
- produced by: written by the official NAIF toolkit through spiceypy 8.2.0 / CSPICE_N0067: spkw08(body=-900, center=399, frame=J2000, segid='T8-DEG7-EVEN-WINDOW', degree=7, n=400); spkw08(body=-901, center=399, frame=J2000, segid='T8-DEG8-ODD-WINDOW', degree=8, n=400)
- note: a circular two-body arc (mu=398600.4418000 km^3/s^2, r=7000 km, i=51.6 deg) sampled analytically in position and velocity

## cspice_t9_deg7_deg8.bsp

- size: 48128 bytes
- sha256 (as committed): e372f61c6020d1cf2d93c7dc976b5c64269e90fa148ce4f6399facbefbb449d5
- source: none; synthesised for this acceptance
- produced by: written by the official NAIF toolkit through spiceypy 8.2.0 / CSPICE_N0067: spkw09(body=-910, center=399, frame=J2000, segid='T9-DEG7-EVEN-WINDOW', degree=7, n=400); spkw09(body=-911, center=399, frame=J2000, segid='T9-DEG8-ODD-WINDOW', degree=8, n=400)
- note: a circular two-body arc (mu=398600.4418000 km^3/s^2, r=7000 km, i=51.6 deg) sampled analytically in position and velocity

## earthstns_itrf93_260814.bsp

- size: 26624 bytes
- sha256 (as committed): 007eb0aad5dd022c6d61bdbfb2395680bd1eb31c49a8637d0b0a1cfbea737c6b
- source: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/stations/earthstns_itrf93_260814.bsp
- sha256 of the original at that URL: 007eb0aad5dd022c6d61bdbfb2395680bd1eb31c49a8637d0b0a1cfbea737c6b
- produced by: copied verbatim

## insight_atls_2016e09o_v1.bsp

- size: 7168 bytes
- sha256 (as committed): 2a19c280169e09812972b275157c0c40d08a8224b9915307af397472e197612b
- source: https://naif.jpl.nasa.gov/pub/naif/INSIGHT/kernels/spk/insight_atls_2016e09o_v1.bsp
- sha256 of the original at that URL: 2a19c280169e09812972b275157c0c40d08a8224b9915307af397472e197612b
- produced by: copied verbatim

## ladee_seg01_t13.bsp

- size: 528384 bytes
- sha256 (as committed): 8cdb3469e05220b6957b941d6eb480ecaf13d880254c26164595506849ceb38d
- source: https://naif.jpl.nasa.gov/pub/naif/LADEE/kernels/spk/ladee_r_13250_13279_pha_v01.bsp
- sha256 of the original at that URL: 9c58793873f140cdd69592ee735184bb2c23b59e1b1834e4b514239356937f8c
- produced by: segment 0 of 42 read with dafgda and rewritten by the official toolkit: spiceypy.spkw13(handle, -12, 399, 'J2000', epochs[0], epochs[-1], 'LADEE-PHA-SEG01-EXTRACT', 7, 9357, states, epochs)
- note: the original segment's control word is 3, i.e. window size 4 states, i.e. Hermite degree 7; the extract reproduces it

## msl_atls_gc120806_v1.bsp

- size: 7168 bytes
- sha256 (as committed): cfec59592f3004d6fcc949a41fdae94f0e017d711a508aeea151fefa78093e86
- source: https://naif.jpl.nasa.gov/pub/naif/MSL/kernels/spk/msl_atls_gc120806_v1.bsp
- sha256 of the original at that URL: cfec59592f3004d6fcc949a41fdae94f0e017d711a508aeea151fefa78093e86
- produced by: copied verbatim

## writer_parity_t13.bsp

- size: 17408 bytes
- sha256 (as committed): f78344b182e7e0d5fa4b4f7214b9d2e27fdc5cd784ecf5cd9967dde17fba72ee
- source: none; synthesised for this acceptance
- produced by: spkopn(fname, 'orbit-products writer parity', 0) then spkw13(body=-940, center=399, frame='J2000', segid='PARITY-T13', degree=7, n=250, states, epochs); 250 nodes so the epoch directory is non-empty (ndir=2)
- note: the native test rewrites this file from its own reader's Series and compares every byte

## spk_reference.txt

CSPICE reference values for the native test, emitted by the generator
above. States come from spiceypy.spkpvn — one segment, its own frame, its
own center — which is exactly the contract of spk::evaluate. Doubles are
carried as 16 hex digits of their IEEE-754 bits so the comparison is
bit-exact rather than decimal-round-trip-exact.

## Type 9 authority

There is no small published NAIF type-9 kernel to check against, so the
authority for type 9 is a kernel WRITTEN BY THE TOOLKIT
(cspice_t9_deg7_deg8.bsp) and read back through spkpvn. That is weaker
than a NAIF publication and is recorded as such: it proves this reader
agrees with CSPICE's writer/reader pair, not that it agrees with a kernel
some third party shipped.


# fixtures/ — Code-500 and STK provenance

This section covers the Code-500 (src/code500.hpp) and STK ephemeris/attitude
(src/stk_ephemeris.hpp) containers. It is appended to the SPK section above and
does not modify it.

## Format authority — GMAT R2026a

The Code-500 record layout and the STK keyword set were transcribed from NASA
GMAT R2026a (Apache-2.0). The files were fetched to
/Users/tj/software/gmat09-authority/code500/ — OUTSIDE this repository — and
read as a format specification. No GMAT code was copied into this tree.

| file | URL | sha256 |
| --- | --- | --- |
| Code500EphemerisFile.hpp | https://raw.githubusercontent.com/nasa/GMAT/R2026a/src/gmatutil/util/Code500EphemerisFile.hpp | 530f0e0e432766eda54d6fb767d33df9593431a518d887c578e840b206fa5f39 |
| Code500EphemerisFile.cpp | https://raw.githubusercontent.com/nasa/GMAT/R2026a/src/gmatutil/util/Code500EphemerisFile.cpp | 7c55fa10532396ce5406b204bbf440d34f8e0b91fc48e71a42eaa244eec47704 |
| STKEphemerisFile.hpp | https://raw.githubusercontent.com/nasa/GMAT/R2026a/src/gmatutil/util/STKEphemerisFile.hpp | e601cfa8c2ad2796cff74dc447ef08e7d46c4c737a3d7f0b9f05e73ec9b26789 |
| STKEphemerisFile.cpp | https://raw.githubusercontent.com/nasa/GMAT/R2026a/src/gmatutil/util/STKEphemerisFile.cpp | c10dbc9f5aee3976966597ba97bc364ad85ccce9aa896299df242b14bce0f911 |

The mirror the task named (ChristopherRabotin/GMAT at R2026a, path
src/base/util/) does not exist: that fork stops at GMAT-R2022a and, in R2026a,
NASA moved these files from src/base/util to src/gmatutil/util. The URLs above
are the ones that resolve.

### Ambiguities resolved from that source, and how

- **Record size.** "Code 500" is the Goddard organisation code, not a word
  count. RECORD_SIZE is 2800 bytes (350 doubles) and NUM_STATES_PER_RECORD is
  50. Record 1 is header 1, record 2 is header 2, data records start at record 3
  (Code500EphemerisFile::ReadDataAt seeks to (n+1)*2800 for 1-based n, and
  WriteDataAt to (n-1)*2800 for a counter that starts at 3).
- **Distance unit.** DUL_TO_KM = 10000.0 — the file is in units of 10000 km,
  NOT earth radii. DUT_TO_SEC = 864.0, so a DUT is exactly 1/100 day and
  DUL/DUT to km/s is 10000/864.
- **Time-system indicator.** GMAT's Initialize() carries a stale comment
  ("0.0 = A.1, 1.0 = UTC"). The code contradicts it: mTimeSystem "A1" writes
  1.0 and "UTC" writes 2.0, and IsFileEndianSwapped() accepts only 1 or 2. This
  header follows the code: 1 = A.1, 2 = UTC.
- **Byte order.** No magic number exists. GMAT detects the order by reading
  timeSystemIndicator and testing it against 1 or 2; src/code500.hpp does the
  same, trying little-endian first and big-endian second, and returns BadMagic
  when neither reads as a legal indicator.
- **DUT origin.** 18 September 1957 00:00:00, carried in the header as
  refTimeForDUT_YYMMDD = 570918.0.
- **Sentinel.** 9.999999999999999e15, compared with an ABSOLUTE tolerance of
  10.0 (GmatMathUtil::IsEqual(x, sentinel, 10.0)), not for equality. A record
  terminates when its first ten fields are all sentinels, and a state slot
  terminates when more than five of its six components are sentinel OR more
  than five are zero.
- **Central-body scales.** centralBodyIndicator (body of integration) counts
  from 1 = Earth; coordinateCenterIndicator (body of the output ephemeris)
  counts from 0 = Earth. The two differ by one.
- **STK default distance unit.** Meters. GMAT's STKEphemerisFile.cpp
  initialises distanceUnit = "Meters" and Orekit's STKEphemerisFileParser
  defaults STKDistanceUnit.METERS; every published example below omits the
  DistanceUnit line entirely.

## Published STK example files — Orekit test resources

Copied verbatim from the Orekit repository, shallow-cloned to
/Users/tj/software/gmat09-authority/orekit-src at commit
26a0b30366ce350153680faacd224594fa055d98 (2026-08-29). Each file's own banner
records that STK v12.2.0 wrote it. Upstream path:
https://gitlab.orekit.org/orekit/orekit/-/blob/master/src/test/resources/stk/<name>

### stk_02674_pv.e

- size: 2372 bytes
- sha256 (as committed): fa12828b8ce1afe9387a3cb3ae9aa06c655b456e03685500a86fec5187d0c95b
- source: gitlab.orekit.org/orekit/orekit src/test/resources/stk/stk_02674_pv.e @ 26a0b30366ce350153680faacd224594fa055d98
- produced by: copied verbatim
- note: no DistanceUnit line, so the values are METRES; 11 points at 60 s from ScenarioEpoch 12 Jan 2007 00:00:00.000883

### stk_02674_pva.e

- size: 3167 bytes
- sha256 (as committed): ae0979e0d65d9d698e828a3005fe8a56b23f9504004ba08cea12b08f4b121e46
- source: gitlab.orekit.org/orekit/orekit src/test/resources/stk/stk_02674_pva.e @ 26a0b30366ce350153680faacd224594fa055d98
- produced by: copied verbatim
- note: no DistanceUnit line, so the values are METRES; 11 points at 60 s from ScenarioEpoch 12 Jan 2007 00:00:00.000883

### stk_02674_p.e

- size: 1577 bytes
- sha256 (as committed): 02919266cbd441812493c19d3f97ff369963bbb6a426a7c1687585c13f8fa718
- source: gitlab.orekit.org/orekit/orekit src/test/resources/stk/stk_02674_p.e @ 26a0b30366ce350153680faacd224594fa055d98
- produced by: copied verbatim
- note: no DistanceUnit line, so the values are METRES; 11 points at 60 s from ScenarioEpoch 12 Jan 2007 00:00:00.000883

## Independent cross-check — Orekit 13.1

- files: stk_02674_pv.orekit-13.1.txt (sha256 408439e326b6fa36e507bebc0e8384cb56ae1500baee24dfd4e68672739b430a), stk_02674_pva.orekit-13.1.txt (sha256 e63b4c0552862e44a19a177dde9ea95ef68ac9e919172e83ea67d70e2803516f)
- produced by: /Users/tj/software/gmat09-authority/java/DumpStkEphemeris.java compiled and run
  against orekit-13.1.jar + hipparchus-4.0.1 (jars at
  /Users/tj/software/gmat09-authority/jars/), with
  org.orekit.files.stk.STKEphemerisFileParser and the orekit test data bundle
  at orekit-src/src/test/resources/regular-data supplying UTC.
- content: one line per state, "t px py pz vx vy vz ax ay az" at %.17e, in
  METRES — Orekit's own internal units, so no conversion of ours stands between
  its parse and the comparison.
- why it is committed rather than run live: the suite must not need a JVM. To
  regenerate, recompile that Java file against the same jars and rerun it on the
  .e fixtures above.

## Authored fixture — stk_attitude_quaternions.a

- size: 895 bytes
- sha256 (as committed): ee2af982264a89e291d78bcc311462d8f9f5f5accc0488eb0dd31ac8d3703eda
- source: NONE. AUTHORED HERE from the STK .a format description; it is NOT an
  independent authority and no published .a file with tabulated reference values
  was found. It supports only the round-trip and unit-norm checks, which are
  properties of the file itself.
- content: 5 points at 60 s, AttitudeTimeQuaternions (scalar-last), a rotation
  about the normalised axis (1,2,3) through 0.0 to 0.4 rad.

## What is NOT proved

- **No published Code-500 file was found**, so every Code-500 number is a round
  trip of this header against itself, plus the layout transcription above. The
  reader has never been run against a file GMAT wrote. Obtaining one requires a
  GMAT build; that is the gap.
- **The .e writer has not been read back by STK or by GMAT**, only by this
  reader and (for the published input files) by Orekit.


# fixtures/ — SP3 provenance

## SP3

This section covers the SP3-c/SP3-d container (`src/sp3.hpp`,
`tests/sp3_native.cpp`, `tests/sp3.test.mjs`). It is appended to the sections
above and modifies none of them. Everything here was retrieved 2026-08-30.

### Format authority — IGS

Fetched to `/Users/tj/software/gmat09-authority/specs/` — OUTSIDE this
repository — and read as a specification. The SP3-d PDF's text was extracted
with pypdf to `sp3d.txt` alongside it.

| file | URL | sha256 |
| --- | --- | --- |
| sp3d.pdf | https://files.igs.org/pub/data/format/sp3d.pdf | 0809fe6571816a9b8394b46b8851b9bfbab956b46f7acab5af6eb62acee5ebbe |
| sp3c.txt | https://files.igs.org/pub/data/format/sp3c.txt | ac844f38cd1c1a1eafbaa45d7ba0baf89b0787cf307fb42ba645b03dc195da9d |
| sp3_docu.txt | https://files.igs.org/pub/data/format/sp3_docu.txt | d95c39676e853376486fbaaac7832fbde01b6a154cb7a77755966a51f5f61485 |

`sp3d.pdf` is "The Extended Standard Product 3 Orbit Format (SP3-d)", Steve
Hilla, National Geodetic Survey, 21 February 2016. Its column-by-column table
and its Examples 1 and 2 are the authority for every column number in
`src/sp3.hpp` and for every rule counted by `sp3d_spec_rules_checked`.

Points the specification settles that implementations commonly get wrong, and
which are therefore asserted:

- **`+ ` / `++` line counts.** SP3-d raised the satellite ceiling from SP3-c's
  85 to 999, so the count is `max(5, ceil(nsat/17))` — five is a FLOOR kept for
  backwards compatibility, not a constant. The spec states it twice (in
  "IMPLEMENTATION CONSIDERATIONS" and in the last-line-number formula
  `8+2*(INT(NSAT/17.01)+1)+NCOMM+...`).
- **The absent-value sentinels.** Bad or absent position and velocity are
  `0.000000`. Bad or absent clock bias AND bad or absent clock rate-of-change
  are both `_999999.999999` — the same six integer nines, with the fractional
  nines explicitly optional. The `9999999.999999` sometimes quoted for the rate
  appears nowhere in either the SP3-c or the SP3-d document; the reader accepts
  any value at or above 999999 so that both spellings translate to
  `has_clock == false`, and the writer emits the spec form.
- **The P/V unit asymmetry.** Position record cols 5-46 are kilometres and cols
  47-60 are microseconds; velocity record cols 5-46 are DECIMETRES PER SECOND
  and cols 47-60 are 1e-4 microseconds per second. Same F14.6 layout, different
  units.
- **Comment width.** cols 4-80 in SP3-d (A77), cols 4-60 in SP3-c.

### COD0MGXFIN_20250190000_01D_05M_ORB.3ep.sp3

- size: 24376 bytes
- sha256 (as committed): 455b34ab6ab010c96763c20c65bfe2114caf480bbb0f3208031717195c1f1efe
- source: ftp://igs.gnsswhu.cn/pub/gps/products/2350/COD0MGXFIN_20250190000_01D_05M_ORB.SP3.gz
  (Wuhan University IGS data centre mirror of the CODE MGEX final product;
  files.igs.org/pub/product/ holds only a readme, and CDDIS requires an
  Earthdata login)
- sha256 of the original at that URL: e18b018289dfd7695fdf8efe7cdb303c0dc9dee229312755ca270e8bb1f2a5ef
- sha256 after gunzip: 57e6631ac7ca0f4ae9c99a1496ed935285dd0bc8214d8e641aa50a0d382044d0
- produced by: TRUNCATED. The full 22-line header verbatim with the epoch-count
  field (line 1 cols 33-39) updated 289 -> 3 so the file stays self-consistent,
  then the first 3 epoch blocks (3 x 122 = 366 `P` records) and the `EOF`
  marker. No value was altered.
- note: a real SP3-d with **122 satellites** — G/R/E/C/J — which is the reason
  it was chosen: past SP3-c's 85-satellite ceiling, so it carries **eight**
  `+ ` lines and eight `++` lines and six comment lines. Position-only.
  Coordinate system IGS20, time system GPS, orbit type FIT, agency AIUB.
  Three records in the first three epochs carry the `999999.999999`
  absent-clock sentinel, and two carry the all-zero absent-position sentinel,
  so both translations are exercised on published bytes.

### igs15000.3ep.sp3

- size: 9218 bytes
- sha256 (as committed): 8ff0acc62d3d9fc126d6f73302acc44cc99671afd75a5c758eca2de24a04517d
- source: ftp://igs.gnsswhu.cn/pub/gps/products/1500/igs15000.sp3.Z
- sha256 of the original at that URL: 95a86f00bac83c0171b74ec07ce6da7151789a873600215039c5e086630a056c
- sha256 after uncompress: 191fe32bb52a571656525327adcbbd4ee28b12577d86ba6fd64ec2f12c423b40
- produced by: TRUNCATED the same way — full header with the epoch count
  96 -> 3, then 3 epoch blocks (3 x 32 `P` records) and `EOF`.
- note: an **SP3-c** IGS final combined orbit (32 GPS satellites, IGS05, HLM,
  agency " IGS" right-justified in cols 57-60). It is here to exercise the
  version-'c' read path and the fixed five-line `+ `/`++` header that SP3-d
  generalised.

### Independent parser — Orekit 13.1

`org.orekit.files.sp3.SP3Parser`, driven by
`/Users/tj/software/gmat09-authority/java-sp3/Sp3Dump.java` — OUTSIDE this
repository, and sharing no code with `src/sp3.hpp`. It emits JSON plus a TSV
sidecar of the same Orekit objects, which is what the native harness reads.

| artefact | source | sha256 |
| --- | --- | --- |
| orekit-13.1.jar | (already staged for this task at /Users/tj/software/gmat09-authority/jars/) | bbda7dae7ddaf6b5b4464548ee2519c545b59f24117ef790fc34d5bbef3f7407 |
| orekit-data-main.zip | https://gitlab.orekit.org/orekit/orekit-data/-/archive/main/orekit-data-main.zip | 063a3255bc10a013ae8a3b33698504b975762a2db6f4a7e4eeb9507c2b2ee5ac |

The `master` branch name the task named 404s; the project's default branch is
`main`. The data bundle supplies the UTC/GPS scales `SP3Parser` needs.

Orekit's own units, confirmed from `SP3Utils` and printed by the dumper: it
reads km/dm-per-s/microseconds/1e-4-microseconds-per-second off the file and
returns metres, metres per second and seconds. An absent clock arrives as NaN.
Those three conversions are exactly what the comparison in
`tests/sp3_native.cpp` inverts, which is why a unit error in this writer would
show there as a factor of 1000 or 10000 rather than as a rounding difference.

### Cross-checks that produced no fixture

- `data-source/glonass-source/test/fixtures/iac_glonass.sp3.glo` (already in
  this repo, not copied here) was read and re-written as part of developing
  this header. Two real-world deviations from the specification were found in
  it and are handled rather than refused: it writes `fractional_day` as exactly
  `1.0000000000000` where the spec says `0.0 <= fraction < 1.0`, and it
  zero-pads the epoch-header month (`*  2026 07 11`) where the spec's I2 gives
  a leading blank (`*  2026  7 11`). The writer emits the spec form.
- `ftp://igs.gnsswhu.cn/pub/gps/products/1000/cod10000.eph` was read as an
  SP3-**a** smoke test (numeric satellite ids, no system letter). The reader
  accepts it; the writer refuses to emit version 'a' with
  `UnsupportedVariant`, because SP3-a's satellite-id convention is not the one
  this header writes.

### What is NOT proved

- **No published SP3 file containing `V` (velocity) records was located.**
  Every IGS/MGEX/CODE/NRCan product sampled — 2025 MGEX finals, 2008 IGS
  finals, 1999 CODE `.eph` — is position-only. The decimetre-per-second
  velocity column is therefore proved by (a) the specification's Example 2,
  (b) the literal column content of a file this writer produced, and (c)
  Orekit's parse of that file, but **not** against a published file that
  somebody else wrote with V records.
- **The `EP` and `EV` correlation records are skipped, not parsed.** The
  specification explicitly permits that, and the spine has nowhere to put a
  position/clock correlation; a file carrying them round-trips without them.
- **No SP3 file this writer produced has been fed to a third-party GNSS
  processing package** (Bernese, gLAB, RTKLIB). Orekit is the only independent
  reader in the loop.
