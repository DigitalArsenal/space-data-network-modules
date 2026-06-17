# Foundation Time

`foundation/time` is the shared SDS TIM conversion module for Orekit-compatible
time-scale behavior. It consumes a `TIM.fbs` envelope carrying
`TIMConversionRequest` and emits a `TIM.fbs` envelope carrying
`TIMConversionResult`.

The current surface covers UTC, TAI, TT, GPS, GLONASS, GST, QZSS, BDT, NAVIC,
SBAS, UT1, TCG, TDB, TCB, and GMST conversions using Orekit time-scale test
vectors. `TIMInstant` inputs and outputs support ISO-8601, Julian Date,
Modified Julian Date, Unix seconds, GNSS elapsed seconds, and GNSS week plus
seconds-in-week. ISO-8601 inputs include Orekit-backed signed extended years,
date-only, ordinal-date, ISO week-date, signed/basic calendar, basic ordinal,
basic week-date, ISO-8601 example equivalence across calendar/ordinal/week
forms, common-year/leap-year ordinal day mappings, full ISO week-component
boundary sweeps, exact DateComponents MJD day outputs, well-formed range
endpoint J2000-day outputs, minute-only local times, and basic time-of-day
forms, with Orekit-compatible ISO week-year, day-of-week, and malformed-date
validation.
Calendar day mapping follows Orekit's astronomical calendar, including the
BC/year-zero through J2000 chronology table from `DateComponentsTest.testParse`
and the 1582 Gregorian-reform discontinuity. `TIMInstant` inputs also support
initial CCSDS time-code parsing
for TAI-tagged unsegmented CUC sources using the CCSDS epoch, an explicit
agency epoch, or extended preambles such as `0x9F`/`0x30`, and UTC-tagged
day-segmented CDS sources using the CCSDS epoch or an explicit agency epoch,
plus UTC-tagged calendar-segmented CCS sources using month/day or day-of-year
calendar variants. `TIMInstant` CCSDS outputs support the
canonical TAI unsegmented CUC target form with CCSDS epoch and preamble `0x1F`,
and the canonical UTC day-segmented CDS target form with CCSDS epoch and
preamble `0x42`; requests sourced from TAI agency-epoch unsegmented CUC, UTC
CCSDS-epoch or agency-epoch day-segmented CDS, or UTC calendar-segmented CCS
can also emit source-kind-preserving target forms with preambles such as
`0x2F`, `0x9F`/`0x30`, `0x42`, `0x49`, `0x56`, and `0x5B`.
For `GPS_SECONDS` and `GNSS_WEEK_SECONDS`
requests tagged with
GPS, QZSS, SBAS, GST, BDT, or NAVIC, the module uses the Orekit constellation
epoch for the tagged time system. `GNSS_WEEK_SECONDS` inputs can also carry an
explicit Orekit-style rollover reference timestamp. GLONASS remains supported
as a time scale, but GNSS epoch representations tagged as GLONASS fail closed
to match Orekit `GNSSDate` satellite-system validity. UT1 and GMST requests
consume caller-supplied `DUT1_SECONDS` and fail closed when that
Earth-orientation value is absent. ISO-8601 parsing includes Orekit-backed UTC
offset suffixes such as `+00:01`, compact `+0430`, hour-only `-07`, and
stress-test leap offsets such as `-50:00`, plus comma or period fractional
seconds; HMS designator strings such as `23h59m59s` fail closed.
Pre-1972 UTC support
follows Orekit's linear MJD-based `UTC-TAI.history`
offsets before whole-second leap offsets begin in 1972, including the first
large UTC leap label `23:59:61.4` at the 1961 transition. TCG uses Orekit's
linear IAU LG rate from the 1977 TAI
reference epoch, and TDB uses Orekit's conventional two-term periodic offset
from TT around J2000. TCB adds Orekit's linear IAU LB rate to TDB from the 1977
TAI reference epoch. GLONASS follows Orekit's UTC+3h scale, while GST, QZSS,
SBAS, and NAVIC follow TAI-19s and BDT follows TAI-33s. UTC leap-second labels
such as `23:59:60` are parsed and emitted at the tested Orekit leap boundaries,
and GLONASS parses/emits its corresponding UTC+3h leap labels such as
`02:59:60`.

```bash
npm install
npm run build
npm test
```
