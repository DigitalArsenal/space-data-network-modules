# files/rinex

RINEX 3.02 to 3.05 GNSS **observation** files read into SDS `$GNO`, one record per epoch, and **broadcast
navigation** files evaluated into SDS `$OEM`, each with an `$NCD` descriptor that records the file. One space data
module: bytes in, records out, no capabilities, one `dist/isomorphic/module.wasm`.

| Method | In | Out |
| --- | --- | --- |
| `read_observations` | `container`: `[u32le n][$NCD][the file's exact bytes]` | `observations` (`$GNO`, one frame per epoch), `descriptor` (`$NCD`) |
| `evaluate_navigation` | `container`, as above (`"rinex-nav"`) | `ephemeris` (`$OEM`, one block per satellite), `descriptor` (`$NCD`) |

**A broadcast ephemeris cannot be kept.** SDS has no record for one (`$NAV` is the Naval Vessel record), so the
parameters have nowhere to go: `read_observations` refuses a navigation file by name (`navigation-not-in-sds`), and
`evaluate_navigation` gives what the parameters mean, the satellite's position and velocity, which `$OEM` can hold.
See "What SDS needs" below for the record to add.

## The request is a FlatBuffer

Owner, 2026-10-24: *"We need to be able to pass configurations using a flatbuffer message."* The `$NCD` that
frames the file is also the request. No option travels in a JSON file.

| Option | Where | Meaning |
| --- | --- | --- |
| format | `FORMAT = PROVIDER_DEFINED`, `PROVIDER_DEFINED_FORMAT_NAME = "rinex-obs"` | `ncdContainerFormat` has no RINEX member yet |
| window | `START_TIME`, `STOP_TIME` | inclusive, ISO 8601, on the file's own time system (`TIME OF FIRST OBS`); no scale is converted |
| satellite systems | `SEGMENTS[].NAME` = `G R E C J I S` | no entries selects every system the file holds |
| integrity | `SOURCE_SHA256`, `SOURCE_BYTE_LENGTH` | checked against the bytes when declared (`descriptor-hash-mismatch`, `descriptor-length-mismatch`) |

The returned descriptor lists one segment per system read (first and last epoch), so the reply can be edited
and sent back as the request.

## What `$GNO` carries

Per epoch: `EPOCH` as the file spelled it, `NUM_SATS` and `CLOCK_OFFSET` from the epoch line, receiver and
antenna identity and `APPROX_X/Y/Z` from the header, `INTERVAL`, and per satellite its id, its constellation
and every observation as written: `SIGNAL` is the three-character RINEX code (`C1C`, `L1C`, `D1C`, `S1C`),
`OBS_TYPE` its type, `VALUE` the number, `LLI` and `SSI` the two indicators. `OBS_CODE_SET` holds one entry per
system, the header's own list (`"G C1C C2S ..."`), so the column order is kept.

Not in the file and never computed: elevation, azimuth, tracking status, AGC state, the DOPs, and the geodetic
latitude, longitude and altitude (the file states `APPROX POSITION XYZ`, which is carried natively).

The `$NCD` carries the version, program and run-by, creation date, marker name (as the internal file name), the
header comments, the time system (`NATIVE_TIME_SYSTEM`), the span read and the SHA-256. The header records
neither record has a place for are **named in a `COMMENT_AREA` line**, with counts: marker number, observer,
antenna offsets, `SYS / PHASE SHIFT`, `GLONASS SLOT / FRQ #`, `SIGNAL STRENGTH UNIT`, `LEAP SECONDS`,
`# OF SATELLITES`, `PRN / # OF OBS`.

## Navigation: evaluated, not kept

`evaluate_navigation` reads the 8-line Keplerian broadcast records of GPS (`G`), QZSS (`J`), Galileo (`E`) and BeiDou
(`C`) and evaluates each by the ICD algorithm (IS-GPS-200 table 20-IV; the Galileo OS SIS ICD and the BeiDou ICD define
the same algorithm with their own constants: GPS and QZSS mu 3.986005e14 and Earth rotation 7.2921151467e-5, Galileo
mu 3.986004418e14 and 7.2921151467e-5, BeiDou mu 3.986004418e14 and 7.292115e-5), with the velocity as the exact
derivative of the same terms. Each satellite becomes one `$OEM` block: kilometers and kilometers per second in the
system's Earth-fixed frame (`WGS84`, `GTRF`, `CGCS2000`), every 300 s, from the message whose Toe is nearest within
+-7200 s (an epoch with none is a gap), on the system's own time (`GPS`, `GST`, `QZSS`, `BDT`; no scale is converted).
Request options travel in the `$NCD` as for observations: `START_TIME` and `STOP_TIME`, and `SEGMENTS[].NAME` = `G E C J`.

**Not evaluated, and declared in the descriptor's `COMMENT_AREA` with counts rather than dropped:** GLONASS and SBAS
(a state vector that is integrated, not a Keplerian set), IRNSS, BeiDou GEO (the ICD rotates the orbit plane by -5
degrees for them), and any message whose health word is not 0. Asking for `R`, `S` or `I` in `SEGMENTS` is
`evaluation-not-implemented`.

Measured (`tests/rinex_nav.test.mjs`, the IGS combined broadcast file `BRDC00IGS` of 2025-01-19, RINEX 3.04, every
second hour for 30 GPS, 8 Galileo, 6 BeiDou and the QZSS satellites it holds; `fixtures/PROVENANCE.md`):

| Claim | Authority | Result |
| --- | --- | --- |
| 14,302 states (G 9,990, E 2,434, C 1,878) | `tests/reference/nav_reference.py`: IS-GPS-200 written out again in Python, the records read with Python's `float()`, the absolute Toe from the week field | worst position difference **4.1e-8 m**; velocity 3.1e-6 m/s against the reference's central difference |
| GPS against the precise orbit | CODE MGEX final SP3 of the day, every 30 minutes, read by `files/orbit-products` | 1,470 states of 30 satellites: median 1.67 m, 95th percentile 2.65 m, rms 1.79 m, max 3.81 m |
| Galileo against the precise orbit | the same | 382 states of 8 satellites: median 0.88 m, 95th percentile 2.23 m, rms 1.41 m, **max 12.64 m** (E07 at 14:00, then 7.1 m at 14:30; E09 5.9 m; the cause is not investigated: the independent evaluation agrees with the module on the same parameters) |

A broadcast set is of the antenna phase center and the SP3 of the center of mass, so a meter or two is the truth, not
zero. BeiDou is held to the independent evaluation only: its time (BDT) is 14 s behind the SP3's GPST labels, so its
epochs are not on the SP3's grid. georinex 1.16.2 was tried as the reader for the reference and misaligns the Galileo
and BeiDou health and accuracy words on a merged file, so the reference reads the records itself.

## Refusals

Named, never traps, nothing completed with a guess. `unsupported-rinex-version` (outside 3.02 to 3.05, with the
version it was), `wrong-rinex-type`, `navigation-not-in-sds` (`read_observations` given a navigation file),
`bad-navigation-record` (a broadcast record that is not 8 lines of 4 numbers), `evaluation-not-implemented`, `unsupported-epoch-flag` (any flag but 0: an event
changes what the header or the indicators mean), `unsupported-observation-type` (`I` ionosphere phase delay
and `X` channel number have no member of `$GNO`'s observation types; a file that declares one is refused
rather than read with columns missing), `inconsistent-message` (an epoch's count disagrees with the lines),
`truncated`, `bad-epoch-record`, `bad-satellite-record`, `bad-value`, `bad-rinex`, `bad-encoding`,
`missing-time-system` (a mixed file that names none is not read as GPS), `bad-selection`, `empty-selection`,
`too-many-epochs`, `format-mismatch`, and the frame's own `descriptor-hash-mismatch` and
`descriptor-length-mismatch`.

## Measured

`tests/rinex_obs.test.mjs` reads the first 20 epochs (30 s) of the IGS station WTZR day file for 2025-01-19
(RINEX 3.05, GPS + GLONASS + Galileo + BeiDou + IRNSS + SBAS, 132 satellites in the day, 51 in the first epoch):
**13,496 observations, every one identical to georinex 1.16.2's**, value to the bit; **176 carry a loss-of-lock
indicator**, read from the file's columns (georinex 1.16.2 reports LLI 0 on some phase observations the file
marks, for example E19 L5Q at 00:07:30, so the columns are the authority for indicators). Request options
(window, systems) are set through the `$NCD` in the same test; the mutations of the file and the frame that the test makes are each refused with the code named above.

`tests/parity.mjs`: the browser (headless Chrome) and native WasmEdge 0.16.4 lanes give byte-identical
outputs and the same exit class on all 18 cases (`conformance/parity.json`, the artifact's SHA-256 recorded).
The Docker leg is waived by the owner (2026-10-22).

`tests/rinex_fuzz.test.mjs` and `tests/interchange_fuzz.test.mjs` (orbit-products): seeded mutations of every reader's
input are refused by name or read, never a trap (21,000 more were run once at authoring time, with two seeds).

`node tests/interchange.e2e.mjs` runs this package's suite and the interchange suites of
`files/orbit-products` and checks the parity records are for the artifacts in `dist/`.

## What SDS needs

`spacedatastandards.org` 1.262.0 (the latest) has no record for a GNSS broadcast navigation message: `$NAV`
is the **Naval Vessel** record (hull, propulsion, damage control). RINEX navigation therefore cannot be
kept, and `read_observations` refuses it by name until a record exists (its positions are what
`evaluate_navigation` gives). These are the exact additions; they were **not** made here (SDS is not edited from this
lane).

```fbs
// ---- new family GNM: GNSS broadcast navigation message (one satellite, one message) ----
enum gnssNavMessageType : byte {
  LNAV, CNAV, CNV1, CNV2, CNV3, FNAV, INAV, D1, D2, FDMA, SBAS
}

/// Keplerian broadcast parameters (GPS, Galileo, BeiDou, QZSS, IRNSS), IS-GPS-200 symbols.
table gnssKeplerianBroadcast {
  SQRT_A:double;          // sqrt(m)
  ECCENTRICITY:double;
  I0:double;              // rad
  OMEGA0:double;          // rad
  OMEGA:double;           // rad
  M0:double;              // rad
  DELTA_N:double;         // rad/s
  OMEGA_DOT:double;       // rad/s
  IDOT:double;            // rad/s
  CUC:double; CUS:double; // rad
  CRC:double; CRS:double; // m
  CIC:double; CIS:double; // rad
  TOE:double;             // seconds of the system week
  WEEK:uint;              // system week of TOE (not rolled over)
  IODE_OR_IODNAV:double;  // issue of data, as broadcast
  FIT_INTERVAL_HOURS:double;
}

/// GLONASS and SBAS broadcast a state vector (PZ-90 / system frame), km, km/s, km/s^2.
table gnssStateBroadcast {
  X:double; Y:double; Z:double;
  VX:double; VY:double; VZ:double;
  AX:double; AY:double; AZ:double;
  TOE:double;             // seconds of day
  FREQUENCY_NUMBER:byte;  // GLONASS channel k
  MESSAGE_FRAME_TIME:double;
}

table GNM {
  SATELLITE_ID:string;                 // G05, E11, C21, R24
  CONSTELLATION:gnssConstellation;     // from the GNO family
  MESSAGE_TYPE:gnssNavMessageType;
  TIME_SYSTEM:string;                  // the system time TOC, TOE and the clock refer to
  TOC:string;                          // ISO 8601 on TIME_SYSTEM
  CLOCK_BIAS:double;                   // s
  CLOCK_DRIFT:double;                  // s/s
  CLOCK_DRIFT_RATE:double;             // s/s^2
  TRANSMISSION_TIME:double;            // seconds of the system week
  HEALTH:uint;
  ACCURACY:double;                     // m (URA/SISA/URE index resolved) with ACCURACY_INDEX below
  ACCURACY_INDEX:int;
  GROUP_DELAYS:[double];               // TGD / BGD / ISC values in the order of GROUP_DELAY_NAMES
  GROUP_DELAY_NAMES:[string];
  KEPLERIAN:gnssKeplerianBroadcast;
  STATE:gnssStateBroadcast;
  DATA_SOURCES:uint;                   // the RINEX data-source bit field
}
root_type GNM;
file_identifier "$GNM";
```

and, to carry what the observation header holds and the request options this package would otherwise place
in existing fields by convention:

```diff
--- GNO/main.fbs 0.0.4
+++ GNO/main.fbs 0.0.5
 enum gnssObsType : byte {
   PSEUDORANGE, CARRIER_PHASE, DOPPLER, SNR, RAW_IF,
+  IONOSPHERE_PHASE_DELAY,   // RINEX type I
+  CHANNEL_NUMBER,           // RINEX type X
 }
 table gnssSatObs {
   ...
+  GLONASS_FREQUENCY_NUMBER:byte;   // GLONASS SLOT / FRQ #
 }
 table GNO {
   ...
+  TIME_SYSTEM:string;       // GPS GLO GAL QZS BDT IRN: the scale of EPOCH
+  EPOCH_FLAG:ubyte;         // RINEX epoch flag
+  MARKER_NAME:string; MARKER_NUMBER:string; MARKER_TYPE:string;
+  OBSERVER:string; AGENCY:string;
+  ANTENNA_DELTA_HEN:[double];          // H, E, N, m
+  PHASE_SHIFTS:[string];               // "G L2S -0.25000"
+  SIGNAL_STRENGTH_UNIT:string;
+  LEAP_SECONDS:int;
 }
```

```diff
--- NCD/main.fbs 0.0.2
+++ NCD/main.fbs 0.0.3
   CCSDS_RDM_XML = 26,
+  SENTINEL_EOF_XML = 27,   // ESA Earth Explorer orbit file (Sentinel-1/2/3 AUX_POEORB, RESORB, PREORB)
+  NAIF_CK_DAF = 28,        // NAIF C-kernel (DAF/CK)
+  NAIF_SCLK_KERNEL = 29,   // NAIF spacecraft clock kernel (text)
+  RINEX_OBS = 30,
+  RINEX_NAV = 31,
   PROVIDER_DEFINED = 255,
 ...
 table NCD {
   ...
   SOURCE_CID: string;
+  // A reader's REQUEST (today carried by convention in START_TIME, STOP_TIME and SEGMENTS):
+  SELECT_START_TIME: string;               // inclusive window, on the container's own time scale
+  SELECT_STOP_TIME: string;
+  SELECT_SAMPLE_INTERVAL_SECONDS: double;  // thin to this spacing; 0 = every sample
+  SELECT_SATELLITE_SYSTEMS: [string];      // RINEX letters G R E C J I S; empty = all
+  SELECT_OBSERVATION_CODES: [string];      // C1C, L1C ...; empty = all
+  SELECT_CLOCK_ID: int;                    // spacecraft clock id (-76); 0 = by the instrument id
 }
```

## Build

```sh
npm ci
npm run build      # generates the SDS headers from the PUBLISHED spacedatastandards.org, compiles, signs
npm test           # tests/rinex_obs.test.mjs
node tests/interchange.e2e.mjs
```

Fixtures and their sources: `fixtures/PROVENANCE.md`.
