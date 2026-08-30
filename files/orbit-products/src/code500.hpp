/*
 * files/orbit-products — Code-500 binary ephemeris, reader and writer.
 *
 * AUTHORITY. The layout below is transcribed from GMAT R2026a
 * src/gmatutil/util/Code500EphemerisFile.{hpp,cpp} (NASA/GSFC, Apache-2.0),
 * field by field, from the byte ranges its EphemHeader1 / EphemData structs
 * carry in their own comments. It is a transcription of a FORMAT, not of code:
 * nothing here is copied from GMAT, and the numbers the acceptance prints are
 * measured against files this header wrote and read back. fixtures/PROVENANCE.md
 * records the exact source URLs and their SHA-256.
 *
 * THINGS THE NAME GETS WRONG. "Code 500" is the NASA Goddard organisation code
 * the format came from, not a record size: a logical record here is 2800 bytes
 * — 350 IEEE-754 doubles — and there are exactly 50 state vectors in a data
 * record. Record 1 is header 1, record 2 is header 2 (gravity-harmonic titles),
 * and data records run from record 3 to the sentinel record. Callers who expect
 * "500 words" find 350 and conclude the file is corrupt; it is not.
 *
 * UNITS. Distances are DUL (1 DUL = 10000 km) and speeds are DUL/DUT where
 * 1 DUT = 864 seconds, so the file is NOT in earth radii — a common and
 * expensive misreading, since 10000 km and one earth radius differ by a factor
 * of 1.57 and a wrong ephemeris in the right shape is the hardest kind to spot.
 * 864 s is 1/100 of a day, which is why DUT doubles as a date: a DUT count is
 * hundredths of a day since the file's own reference instant.
 *
 * TIME. Per the spine, no scale conversion happens here. The header declares
 * its scale in `time_system_indicator` (1 = A.1 atomic, 2 = UTC) and its DUT
 * origin in `ref_time_for_dut_yymmdd`; row epochs come out as seconds from that
 * origin, expressed in that scale, with the origin's calendar date reported as
 * Series::epoch_zero_iso. Turning that into TDB or GPS is the time module's
 * job and needs a leap-second table this layer deliberately does not have.
 *
 * BYTE ORDER. Both orders exist in the wild — the format predates the PC and
 * GMAT still writes either on request — and neither carries a magic number, so
 * the order is DETECTED the way GMAT detects it: `time_system_indicator` is 1
 * or 2 in a readable file and is nothing like that when the bytes are reversed.
 */

#ifndef ORBIT_PRODUCTS_CODE500_HPP
#define ORBIT_PRODUCTS_CODE500_HPP

#include "ephemeris_series.hpp"

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace code500 {

/* ------------------------------------------------------------------------ */
/* Format constants                                                          */
/* ------------------------------------------------------------------------ */

static constexpr size_t kRecordSize = 2800;
static constexpr size_t kStatesPerRecord = 50;

static constexpr double kDulToKm = 10000.0;
static constexpr double kKmToDul = 1.0 / 10000.0;
static constexpr double kDulDutToKmSec = 10000.0 / 864.0;
static constexpr double kKmSecToDulDut = 864.0 / 10000.0;
static constexpr double kDutToSec = 864.0;
static constexpr double kSecToDut = 1.0 / 864.0;

/*
 * The end-of-data marker: a value chosen to be enormous but still a normal
 * double. It is compared with an ABSOLUTE tolerance of 10.0, not for equality —
 * that is GMAT's own rule, and it exists because the value survived a trip
 * through single-precision and EBCDIC-era tooling that did not preserve the
 * low bits. Equality comparison here would fail to recognise the terminator in
 * files written by anything but GMAT itself.
 */
static constexpr double kSentinel = 9.999999999999999e15;
static constexpr double kSentinelTolerance = 10.0;

/* The DUT origin GMAT writes, and the one every file we have seen carries:
 * 18 September 1957, packed as YYMMDD. */
static constexpr double kDefaultRefTimeForDutYymmdd = 570918.0;

inline bool is_sentinel(double v) {
    const double d = v - kSentinel;
    return (d < 0.0 ? -d : d) <= kSentinelTolerance;
}

/* ------------------------------------------------------------------------ */
/* Header record 1                                                           */
/* ------------------------------------------------------------------------ */

/*
 * Every field of the 2800-byte header, named as the format names it (GMAT's
 * identifiers, snake-cased to this tree's convention, including the unit suffix
 * the format itself attaches — `_dut`, `_sec`, `_yyymmdd` — because dropping
 * the suffix is how a DUT gets added to a second).
 *
 * The spares and the harmonic-title blocks are carried verbatim rather than
 * discarded, so that a read/write pair reproduces the file BYTE FOR BYTE.
 * "Spare" means undefined by the format, not empty: real files put producer
 * annotations there, and a writer that blanks them silently destroys data it
 * never understood.
 */
struct Header {
    /* Byte order of the record stream. Detected on read; obeyed on write. */
    bool big_endian = false;

    /*
     * How the packed dates are written. GMAT calls it the year format: 1 stores
     * YYYMMDD with the year offset from 1900 (57 for 1957), 2 stores the full
     * YYYYMMDD. The header carries no flag for it, so it is a caller's
     * declaration, not something read out of the file; the reader reports the
     * form it inferred from the magnitude of the start date.
     */
    int year_format = 1;

    std::string product_id;    /* 8 chars, "EPHEM   " from GMAT */
    double sat_id = 0.0;
    double time_system_indicator = 0.0; /* 1 = A.1 atomic, 2 = UTC */

    double start_date_of_ephem_yyymmdd = 0.0;
    double start_day_count_of_year = 0.0;
    double start_seconds_of_day = 0.0;
    double end_date_of_ephem_yyymmdd = 0.0;
    double end_day_count_of_year = 0.0;
    double end_seconds_of_day = 0.0;
    double step_size_sec = 0.0;

    std::string tape_id;      /* 8 chars  */
    std::string source_id;    /* 8 chars  */
    std::string header_title; /* 56 chars */

    /* Central body of INTEGRATION: 1 = Earth, 2 = Luna, 3 = Sun, 4 = Mars ...
     * offset by one from `coordinate_center_indicator` below, which is the
     * central body of the OUTPUT ephemeris and counts from 0 = Earth. The two
     * scales differing by one is a real property of the format and the single
     * easiest way to publish an ephemeris centred on the wrong planet. */
    double central_body_indicator = 0.0;

    double brouwer_lyddane[6] = {0, 0, 0, 0, 0, 0};
    double ref_time_for_dut_yymmdd = 0.0;

    /* "2000" = J2000, "INER" = true of reference, "MEAN" = mean of B1950,
     * "EFI " = earth-fixed / body-fixed. Four characters, kept verbatim. */
    std::string coord_system_indicator_1;
    /* 2 = mean of 1950, 3 = true of reference, 4 = J2000, 5 = body-fixed. */
    int32_t coord_system_indicator_2 = 0;

    std::string orbit_theory; /* 8 chars, "COWELL  " from GMAT */
    std::string spares_1;     /* 16 chars */

    double drag_coefficient = 0.0;
    double sc_reflectivity_constant = 0.0;
    std::string atmospheric_density_model; /* 8 chars */
    double area_of_spacecraft = 0.0;
    double mass_of_spacecraft = 0.0;
    double zonal_tesseral_harmonics_indicator = 0.0;
    std::string spares_2; /* 8 chars */

    double lunar_grav_perturb_indicator = 0.0;
    double solar_radiation_perturb_indicator = 0.0;
    double solar_grav_perturb_indicator = 0.0;
    double atmospheric_drag_perturb_indicator = 0.0;

    double epoch_time_of_elements_dut = 0.0;
    double year_of_epoch_yyy = 0.0;
    double month_of_epoch_mm = 0.0;
    double day_of_epoch_dd = 0.0;
    double hour_of_epoch_hh = 0.0;
    double minute_of_epoch_mm = 0.0;
    double seconds_of_epoch_milsec = 0.0;

    double keplerian_elements_at_epoch_rad[6] = {0, 0, 0, 0, 0, 0};
    double true_anomaly_at_epoch = 0.0;
    double arg_of_latitude_at_epoch = 0.0;
    double flight_path_angle_at_epoch = 0.0;
    double ecc_anomaly_at_epoch = 0.0;
    double anomalistic_period_dut = 0.0;
    double perigee_height_at_epoch = 0.0;
    double apogee_height_at_epoch = 0.0;
    double mean_motion = 0.0;
    double rate_of_change_of_arg_of_perigee = 0.0;
    double rate_of_change_of_ra_of_ascending_node = 0.0;

    double cartesian_elements_at_epoch_dult[6] = {0, 0, 0, 0, 0, 0};
    double t_sub_q[14] = {0};
    std::string spares_3; /* 48 chars */

    double rho_sub_1 = 0.0;
    double rho_sub_2 = 0.0;
    double rho_sub_3 = 0.0;
    double rho_sub_4 = 0.0;
    double brouwer_1st_order_drag_terms[14] = {0};
    double brouwer_2nd_order_drag_terms[14] = {0};
    std::string spares_4; /* 40 chars */

    double geocentric_coord_of_sun_at_epoch[3] = {0, 0, 0};
    double total_number_of_brouwer_drag_terms = 0.0;
    std::string spares_5; /* 480 chars */

    double start_time_of_ephemeris_dut = 0.0;
    double end_time_of_ephemeris_dut = 0.0;
    double time_interval_between_points_dut = 0.0;
    double precession_nutation_indicator = 0.0;
    double gha_at_epoch = 0.0;
    /* Central body of the OUTPUT ephemeris: 0 = Earth, 1 = Luna, 2 = Sun ... */
    double coordinate_center_indicator = 0.0;
    double date_of_initiation_of_ephem_comp_yyymmdd = 0.0;
    double time_of_initiation_of_ephem_comp_hhmmss = 0.0;
    double gha_at_ephem_start_rad = 0.0;
    double gha_at_ephemeris_end_rad = 0.0;

    int32_t output_interval_indicator = 0; /* 1 = fixed step, 2 = variable */
    int32_t leap_second_indicator = 0;     /* 1 = none in span, 2 = one occurs */
    double date_of_leap_seconds_yyymmdd = 0.0;
    double time_of_leap_seconds_hhmmss = 0.0;
    double utc_time_adjustment_sec = 0.0;
    double dc_observation_time_span[4] = {0, 0, 0, 0};
    int32_t tracking_validation_indicator = 0;

    std::string spares_6;                /* 660 chars  */
    std::string harmonics_with_titles_1; /* 456 chars, tail of record 1 */
    std::string harmonics_with_titles_2; /* 2800 chars, the whole of record 2 */
};

/* ------------------------------------------------------------------------ */
/* Byte offsets                                                              */
/* ------------------------------------------------------------------------ */

/*
 * Zero-based offsets into a record, from the 1-based byte ranges GMAT's struct
 * comments carry. They are spelled out rather than computed from a field list
 * because a transcription error in a computed layout shifts EVERY subsequent
 * field, and a literal table can be diffed against the source line by line.
 *
 * The struct is byte-packed in GMAT, but every field here happens to be
 * naturally aligned (doubles on multiples of 8, the four int32s on multiples of
 * 4), so there is no padding question to resolve and no ambiguity between
 * compilers.
 */
namespace h1 {
static constexpr size_t kProductId = 0;
static constexpr size_t kSatId = 8;
static constexpr size_t kTimeSystemIndicator = 16;
static constexpr size_t kStartDateOfEphem = 24;
static constexpr size_t kStartDayCountOfYear = 32;
static constexpr size_t kStartSecondsOfDay = 40;
static constexpr size_t kEndDateOfEphem = 48;
static constexpr size_t kEndDayCountOfYear = 56;
static constexpr size_t kEndSecondsOfDay = 64;
static constexpr size_t kStepSizeSec = 72;
static constexpr size_t kTapeId = 80;
static constexpr size_t kSourceId = 88;
static constexpr size_t kHeaderTitle = 96;
static constexpr size_t kCentralBodyIndicator = 152;
static constexpr size_t kBrouwerLyddane = 160;
static constexpr size_t kRefTimeForDut = 208;
static constexpr size_t kCoordSystemIndicator1 = 216;
static constexpr size_t kCoordSystemIndicator2 = 220;
static constexpr size_t kOrbitTheory = 224;
static constexpr size_t kSpares1 = 232;
static constexpr size_t kDragCoefficient = 248;
static constexpr size_t kScReflectivityConstant = 256;
static constexpr size_t kAtmosphericDensityModel = 264;
static constexpr size_t kAreaOfSpacecraft = 272;
static constexpr size_t kMassOfSpacecraft = 280;
static constexpr size_t kZonalTesseralHarmonicsIndicator = 288;
static constexpr size_t kSpares2 = 296;
static constexpr size_t kLunarGravPerturbIndicator = 304;
static constexpr size_t kSolarRadiationPerturbIndicator = 312;
static constexpr size_t kSolarGravPerturbIndicator = 320;
static constexpr size_t kAtmosphericDragPerturbIndicator = 328;
static constexpr size_t kEpochTimeOfElementsDut = 336;
static constexpr size_t kYearOfEpoch = 344;
static constexpr size_t kMonthOfEpoch = 352;
static constexpr size_t kDayOfEpoch = 360;
static constexpr size_t kHourOfEpoch = 368;
static constexpr size_t kMinuteOfEpoch = 376;
static constexpr size_t kSecondsOfEpochMilsec = 384;
static constexpr size_t kKeplerianElementsAtEpoch = 392;
static constexpr size_t kTrueAnomalyAtEpoch = 440;
static constexpr size_t kArgOfLatitudeAtEpoch = 448;
static constexpr size_t kFlightPathAngleAtEpoch = 456;
static constexpr size_t kEccAnomalyAtEpoch = 464;
static constexpr size_t kAnomalisticPeriodDut = 472;
static constexpr size_t kPerigeeHeightAtEpoch = 480;
static constexpr size_t kApogeeHeightAtEpoch = 488;
static constexpr size_t kMeanMotion = 496;
static constexpr size_t kRateOfChangeOfArgOfPerigee = 504;
static constexpr size_t kRateOfChangeOfRaOfAscendingNode = 512;
static constexpr size_t kCartesianElementsAtEpochDult = 520;
static constexpr size_t kTSubQ = 568;
static constexpr size_t kSpares3 = 680;
static constexpr size_t kRhoSub1 = 728;
static constexpr size_t kRhoSub2 = 736;
static constexpr size_t kRhoSub3 = 744;
static constexpr size_t kRhoSub4 = 752;
static constexpr size_t kBrouwer1stOrderDragTerms = 760;
static constexpr size_t kBrouwer2ndOrderDragTerms = 872;
static constexpr size_t kSpares4 = 984;
static constexpr size_t kGeocentricCoordOfSunAtEpoch = 1024;
static constexpr size_t kTotalNumberOfBrouwerDragTerms = 1048;
static constexpr size_t kSpares5 = 1056;
static constexpr size_t kStartTimeOfEphemerisDut = 1536;
static constexpr size_t kEndTimeOfEphemerisDut = 1544;
static constexpr size_t kTimeIntervalBetweenPointsDut = 1552;
static constexpr size_t kPrecessionNutationIndicator = 1560;
static constexpr size_t kGhaAtEpoch = 1568;
static constexpr size_t kCoordinateCenterIndicator = 1576;
static constexpr size_t kDateOfInitiationOfEphemComp = 1584;
static constexpr size_t kTimeOfInitiationOfEphemComp = 1592;
static constexpr size_t kGhaAtEphemStartRad = 1600;
static constexpr size_t kGhaAtEphemerisEndRad = 1608;
static constexpr size_t kOutputIntervalIndicator = 1616;
static constexpr size_t kLeapSecondIndicator = 1620;
static constexpr size_t kDateOfLeapSeconds = 1624;
static constexpr size_t kTimeOfLeapSeconds = 1632;
static constexpr size_t kUtcTimeAdjustmentSec = 1640;
static constexpr size_t kDcObservationTimeSpan = 1648;
static constexpr size_t kTrackingValidationIndicator = 1680;
static constexpr size_t kSpares6 = 1684;
static constexpr size_t kHarmonicsWithTitles1 = 2344;
}  // namespace h1

namespace d1 {
static constexpr size_t kDateOfFirstEphemPoint = 0;
static constexpr size_t kDayOfYearForFirstEphemPoint = 8;
static constexpr size_t kSecsOfDayForFirstEphemPoint = 16;
static constexpr size_t kTimeIntervalBetweenPointsSec = 24;
static constexpr size_t kFirstStateVectorDult = 32;
static constexpr size_t kStateVector2Thru50Dult = 80;
static constexpr size_t kTimeOfFirstDataPointDut = 2432;
static constexpr size_t kTimeIntervalBetweenPointsDut = 2440;
static constexpr size_t kThrustIndicator = 2448;
static constexpr size_t kSpares1 = 2456;
}  // namespace d1

/* ------------------------------------------------------------------------ */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------ */

inline std::string read_chars(const uint8_t* p, size_t n) {
    return std::string(reinterpret_cast<const char*>(p), n);
}

/* Blank-pads or truncates to the field's exact width. Blanks, not NULs: the
 * format is a fixed-column record descended from card images, and a NUL in a
 * character field is what makes a file unreadable to the FORTRAN readers that
 * still consume it. */
inline void write_chars(uint8_t* p, const std::string& s, size_t n) {
    const size_t copied = s.size() < n ? s.size() : n;
    for (size_t i = 0; i < copied; ++i) p[i] = static_cast<uint8_t>(s[i]);
    for (size_t i = copied; i < n; ++i) p[i] = static_cast<uint8_t>(' ');
}

inline std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && (s[b] == ' ' || s[b] == '\0')) ++b;
    while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\0')) --e;
    return s.substr(b, e - b);
}

/* Days since 1970-01-01 from a proleptic Gregorian date, and its inverse.
 * Pure calendar arithmetic on a uniform day count — no leap seconds, no time
 * scale, nothing this layer is forbidden to know. */
inline int64_t days_from_civil(int y, int m, int d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const int64_t yoe = y - era * 400;
    const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

inline void civil_from_days(int64_t z, int* y, int* m, int* d) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t yr = yoe + era * 400;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    *d = static_cast<int>(doy - (153 * mp + 2) / 5 + 1);
    *m = static_cast<int>(mp + (mp < 10 ? 3 : -9));
    *y = static_cast<int>(yr + (*m <= 2));
}

/* Unpacks the format's YYMMDD reference date. Two-digit years are read as
 * 1900+YY without a pivot: the format's own reference is 1957 and a Code-500
 * file cannot predate it, so a pivot would only invent 20xx dates that the
 * field can never legitimately hold. */
inline bool decode_yymmdd(double packed, int* y, int* m, int* d) {
    if (!ephem::is_finite(packed)) return false;
    const int64_t v = static_cast<int64_t>(packed);
    if (static_cast<double>(v) != packed || v < 10101 || v > 991231) return false;
    const int yy = static_cast<int>(v / 10000);
    const int mm = static_cast<int>((v / 100) % 100);
    const int dd = static_cast<int>(v % 100);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
    *y = 1900 + yy;
    *m = mm;
    *d = dd;
    return true;
}

inline std::string iso_date_midnight(int y, int m, int d) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT00:00:00", y, m, d);
    return std::string(buf);
}

/* Days from 1970-01-01 to 2000-01-01, so the J2000 instant (noon that day) is
 * kDaysToJ2000 days plus half a day out. */
static constexpr int64_t kDaysToJ2000 = 10957;

/* Seconds from the J2000 epoch to a civil date-time, ON WHATEVER SCALE the
 * caller's calendar is expressed in. Pure day arithmetic: which scale it is
 * stays the container's declaration, exactly as Series::epoch_zero_offset_sec
 * specifies. */
inline double seconds_past_j2000(int y, int m, int d, double seconds_of_day) {
    return static_cast<double>(days_from_civil(y, m, d) - kDaysToJ2000) * 86400.0 - 43200.0 +
           seconds_of_day;
}

/* The documented meaning of `coord_system_indicator_2`. Offered as a lookup
 * rather than written into Series::frame_name, because the series carries what
 * the container SAID (the four-character tag) and a caller that wants a frame
 * name should be able to see which mapping produced it. */
inline const char* coord_system_name(int32_t indicator) {
    switch (indicator) {
        case 2: return "MeanOf1950";
        case 3: return "TrueOfReference";
        case 4: return "J2000";
        case 5: return "BodyFixed";
        default: return "";
    }
}

/* `which` selects the scale: 1 for the central body of integration (1 = Earth),
 * 2 for the central body of the output ephemeris (0 = Earth). */
inline const char* body_name(double indicator, int which) {
    const double shifted = which == 2 ? indicator + 1.0 : indicator;
    if (shifted == 1.0) return "Earth";
    if (shifted == 2.0) return "Luna";
    if (shifted == 3.0) return "Sun";
    if (shifted == 4.0) return "Mars";
    if (shifted == 5.0) return "Jupiter";
    if (shifted == 6.0) return "Saturn";
    if (shifted == 7.0) return "Uranus";
    if (shifted == 8.0) return "Neptune";
    if (shifted == 9.0) return "Pluto";
    if (shifted == 10.0) return "Mercury";
    if (shifted == 11.0) return "Venus";
    return "";
}

inline const char* time_system_name(double indicator) {
    /* GMAT's Initialize() carries a stale comment saying 0 = A.1 and 1 = UTC;
     * its own code (mTimeSystem "A1" -> 1.0, "UTC" -> 2.0) and its endian probe
     * (which accepts only 1 or 2) settle it the other way. */
    if (indicator == 1.0) return "A1";
    if (indicator == 2.0) return "UTC";
    return "";
}

/* ------------------------------------------------------------------------ */
/* Header serialisation                                                      */
/* ------------------------------------------------------------------------ */

namespace detail {

inline void read_f64_array(const uint8_t* rec, size_t off, double* out, size_t n, bool be) {
    for (size_t i = 0; i < n; ++i) out[i] = ephem::read_f64(rec + off + 8 * i, be);
}

inline void write_f64_array(uint8_t* rec, size_t off, const double* in, size_t n, bool be) {
    for (size_t i = 0; i < n; ++i) ephem::write_f64(rec + off + 8 * i, in[i], be);
}

inline void unpack_header(const uint8_t* r1, const uint8_t* r2, bool be, Header* h) {
    h->big_endian = be;
    h->product_id = read_chars(r1 + h1::kProductId, 8);
    h->sat_id = ephem::read_f64(r1 + h1::kSatId, be);
    h->time_system_indicator = ephem::read_f64(r1 + h1::kTimeSystemIndicator, be);
    h->start_date_of_ephem_yyymmdd = ephem::read_f64(r1 + h1::kStartDateOfEphem, be);
    h->start_day_count_of_year = ephem::read_f64(r1 + h1::kStartDayCountOfYear, be);
    h->start_seconds_of_day = ephem::read_f64(r1 + h1::kStartSecondsOfDay, be);
    h->end_date_of_ephem_yyymmdd = ephem::read_f64(r1 + h1::kEndDateOfEphem, be);
    h->end_day_count_of_year = ephem::read_f64(r1 + h1::kEndDayCountOfYear, be);
    h->end_seconds_of_day = ephem::read_f64(r1 + h1::kEndSecondsOfDay, be);
    h->step_size_sec = ephem::read_f64(r1 + h1::kStepSizeSec, be);
    h->tape_id = read_chars(r1 + h1::kTapeId, 8);
    h->source_id = read_chars(r1 + h1::kSourceId, 8);
    h->header_title = read_chars(r1 + h1::kHeaderTitle, 56);
    h->central_body_indicator = ephem::read_f64(r1 + h1::kCentralBodyIndicator, be);
    read_f64_array(r1, h1::kBrouwerLyddane, h->brouwer_lyddane, 6, be);
    h->ref_time_for_dut_yymmdd = ephem::read_f64(r1 + h1::kRefTimeForDut, be);
    h->coord_system_indicator_1 = read_chars(r1 + h1::kCoordSystemIndicator1, 4);
    h->coord_system_indicator_2 = ephem::read_i32(r1 + h1::kCoordSystemIndicator2, be);
    h->orbit_theory = read_chars(r1 + h1::kOrbitTheory, 8);
    h->spares_1 = read_chars(r1 + h1::kSpares1, 16);
    h->drag_coefficient = ephem::read_f64(r1 + h1::kDragCoefficient, be);
    h->sc_reflectivity_constant = ephem::read_f64(r1 + h1::kScReflectivityConstant, be);
    h->atmospheric_density_model = read_chars(r1 + h1::kAtmosphericDensityModel, 8);
    h->area_of_spacecraft = ephem::read_f64(r1 + h1::kAreaOfSpacecraft, be);
    h->mass_of_spacecraft = ephem::read_f64(r1 + h1::kMassOfSpacecraft, be);
    h->zonal_tesseral_harmonics_indicator =
        ephem::read_f64(r1 + h1::kZonalTesseralHarmonicsIndicator, be);
    h->spares_2 = read_chars(r1 + h1::kSpares2, 8);
    h->lunar_grav_perturb_indicator = ephem::read_f64(r1 + h1::kLunarGravPerturbIndicator, be);
    h->solar_radiation_perturb_indicator =
        ephem::read_f64(r1 + h1::kSolarRadiationPerturbIndicator, be);
    h->solar_grav_perturb_indicator = ephem::read_f64(r1 + h1::kSolarGravPerturbIndicator, be);
    h->atmospheric_drag_perturb_indicator =
        ephem::read_f64(r1 + h1::kAtmosphericDragPerturbIndicator, be);
    h->epoch_time_of_elements_dut = ephem::read_f64(r1 + h1::kEpochTimeOfElementsDut, be);
    h->year_of_epoch_yyy = ephem::read_f64(r1 + h1::kYearOfEpoch, be);
    h->month_of_epoch_mm = ephem::read_f64(r1 + h1::kMonthOfEpoch, be);
    h->day_of_epoch_dd = ephem::read_f64(r1 + h1::kDayOfEpoch, be);
    h->hour_of_epoch_hh = ephem::read_f64(r1 + h1::kHourOfEpoch, be);
    h->minute_of_epoch_mm = ephem::read_f64(r1 + h1::kMinuteOfEpoch, be);
    h->seconds_of_epoch_milsec = ephem::read_f64(r1 + h1::kSecondsOfEpochMilsec, be);
    read_f64_array(r1, h1::kKeplerianElementsAtEpoch, h->keplerian_elements_at_epoch_rad, 6, be);
    h->true_anomaly_at_epoch = ephem::read_f64(r1 + h1::kTrueAnomalyAtEpoch, be);
    h->arg_of_latitude_at_epoch = ephem::read_f64(r1 + h1::kArgOfLatitudeAtEpoch, be);
    h->flight_path_angle_at_epoch = ephem::read_f64(r1 + h1::kFlightPathAngleAtEpoch, be);
    h->ecc_anomaly_at_epoch = ephem::read_f64(r1 + h1::kEccAnomalyAtEpoch, be);
    h->anomalistic_period_dut = ephem::read_f64(r1 + h1::kAnomalisticPeriodDut, be);
    h->perigee_height_at_epoch = ephem::read_f64(r1 + h1::kPerigeeHeightAtEpoch, be);
    h->apogee_height_at_epoch = ephem::read_f64(r1 + h1::kApogeeHeightAtEpoch, be);
    h->mean_motion = ephem::read_f64(r1 + h1::kMeanMotion, be);
    h->rate_of_change_of_arg_of_perigee = ephem::read_f64(r1 + h1::kRateOfChangeOfArgOfPerigee, be);
    h->rate_of_change_of_ra_of_ascending_node =
        ephem::read_f64(r1 + h1::kRateOfChangeOfRaOfAscendingNode, be);
    read_f64_array(r1, h1::kCartesianElementsAtEpochDult, h->cartesian_elements_at_epoch_dult, 6, be);
    read_f64_array(r1, h1::kTSubQ, h->t_sub_q, 14, be);
    h->spares_3 = read_chars(r1 + h1::kSpares3, 48);
    h->rho_sub_1 = ephem::read_f64(r1 + h1::kRhoSub1, be);
    h->rho_sub_2 = ephem::read_f64(r1 + h1::kRhoSub2, be);
    h->rho_sub_3 = ephem::read_f64(r1 + h1::kRhoSub3, be);
    h->rho_sub_4 = ephem::read_f64(r1 + h1::kRhoSub4, be);
    read_f64_array(r1, h1::kBrouwer1stOrderDragTerms, h->brouwer_1st_order_drag_terms, 14, be);
    read_f64_array(r1, h1::kBrouwer2ndOrderDragTerms, h->brouwer_2nd_order_drag_terms, 14, be);
    h->spares_4 = read_chars(r1 + h1::kSpares4, 40);
    read_f64_array(r1, h1::kGeocentricCoordOfSunAtEpoch, h->geocentric_coord_of_sun_at_epoch, 3, be);
    h->total_number_of_brouwer_drag_terms =
        ephem::read_f64(r1 + h1::kTotalNumberOfBrouwerDragTerms, be);
    h->spares_5 = read_chars(r1 + h1::kSpares5, 480);
    h->start_time_of_ephemeris_dut = ephem::read_f64(r1 + h1::kStartTimeOfEphemerisDut, be);
    h->end_time_of_ephemeris_dut = ephem::read_f64(r1 + h1::kEndTimeOfEphemerisDut, be);
    h->time_interval_between_points_dut =
        ephem::read_f64(r1 + h1::kTimeIntervalBetweenPointsDut, be);
    h->precession_nutation_indicator = ephem::read_f64(r1 + h1::kPrecessionNutationIndicator, be);
    h->gha_at_epoch = ephem::read_f64(r1 + h1::kGhaAtEpoch, be);
    h->coordinate_center_indicator = ephem::read_f64(r1 + h1::kCoordinateCenterIndicator, be);
    h->date_of_initiation_of_ephem_comp_yyymmdd =
        ephem::read_f64(r1 + h1::kDateOfInitiationOfEphemComp, be);
    h->time_of_initiation_of_ephem_comp_hhmmss =
        ephem::read_f64(r1 + h1::kTimeOfInitiationOfEphemComp, be);
    h->gha_at_ephem_start_rad = ephem::read_f64(r1 + h1::kGhaAtEphemStartRad, be);
    h->gha_at_ephemeris_end_rad = ephem::read_f64(r1 + h1::kGhaAtEphemerisEndRad, be);
    h->output_interval_indicator = ephem::read_i32(r1 + h1::kOutputIntervalIndicator, be);
    h->leap_second_indicator = ephem::read_i32(r1 + h1::kLeapSecondIndicator, be);
    h->date_of_leap_seconds_yyymmdd = ephem::read_f64(r1 + h1::kDateOfLeapSeconds, be);
    h->time_of_leap_seconds_hhmmss = ephem::read_f64(r1 + h1::kTimeOfLeapSeconds, be);
    h->utc_time_adjustment_sec = ephem::read_f64(r1 + h1::kUtcTimeAdjustmentSec, be);
    read_f64_array(r1, h1::kDcObservationTimeSpan, h->dc_observation_time_span, 4, be);
    h->tracking_validation_indicator = ephem::read_i32(r1 + h1::kTrackingValidationIndicator, be);
    h->spares_6 = read_chars(r1 + h1::kSpares6, 660);
    h->harmonics_with_titles_1 = read_chars(r1 + h1::kHarmonicsWithTitles1, 456);
    h->harmonics_with_titles_2 = read_chars(r2, kRecordSize);

    /* The full-year form is the only one that can carry a date this large: a
     * YYYMMDD packed against 1900 tops out at 991231. */
    h->year_format = h->start_date_of_ephem_yyymmdd >= 19000000.0 ? 2 : 1;
}

inline void pack_header(const Header& h, uint8_t* r1, uint8_t* r2) {
    const bool be = h.big_endian;
    for (size_t i = 0; i < kRecordSize; ++i) r1[i] = static_cast<uint8_t>(' ');
    write_chars(r1 + h1::kProductId, h.product_id, 8);
    ephem::write_f64(r1 + h1::kSatId, h.sat_id, be);
    ephem::write_f64(r1 + h1::kTimeSystemIndicator, h.time_system_indicator, be);
    ephem::write_f64(r1 + h1::kStartDateOfEphem, h.start_date_of_ephem_yyymmdd, be);
    ephem::write_f64(r1 + h1::kStartDayCountOfYear, h.start_day_count_of_year, be);
    ephem::write_f64(r1 + h1::kStartSecondsOfDay, h.start_seconds_of_day, be);
    ephem::write_f64(r1 + h1::kEndDateOfEphem, h.end_date_of_ephem_yyymmdd, be);
    ephem::write_f64(r1 + h1::kEndDayCountOfYear, h.end_day_count_of_year, be);
    ephem::write_f64(r1 + h1::kEndSecondsOfDay, h.end_seconds_of_day, be);
    ephem::write_f64(r1 + h1::kStepSizeSec, h.step_size_sec, be);
    write_chars(r1 + h1::kTapeId, h.tape_id, 8);
    write_chars(r1 + h1::kSourceId, h.source_id, 8);
    write_chars(r1 + h1::kHeaderTitle, h.header_title, 56);
    ephem::write_f64(r1 + h1::kCentralBodyIndicator, h.central_body_indicator, be);
    write_f64_array(r1, h1::kBrouwerLyddane, h.brouwer_lyddane, 6, be);
    ephem::write_f64(r1 + h1::kRefTimeForDut, h.ref_time_for_dut_yymmdd, be);
    write_chars(r1 + h1::kCoordSystemIndicator1, h.coord_system_indicator_1, 4);
    ephem::write_i32(r1 + h1::kCoordSystemIndicator2, h.coord_system_indicator_2, be);
    write_chars(r1 + h1::kOrbitTheory, h.orbit_theory, 8);
    write_chars(r1 + h1::kSpares1, h.spares_1, 16);
    ephem::write_f64(r1 + h1::kDragCoefficient, h.drag_coefficient, be);
    ephem::write_f64(r1 + h1::kScReflectivityConstant, h.sc_reflectivity_constant, be);
    write_chars(r1 + h1::kAtmosphericDensityModel, h.atmospheric_density_model, 8);
    ephem::write_f64(r1 + h1::kAreaOfSpacecraft, h.area_of_spacecraft, be);
    ephem::write_f64(r1 + h1::kMassOfSpacecraft, h.mass_of_spacecraft, be);
    ephem::write_f64(r1 + h1::kZonalTesseralHarmonicsIndicator,
                     h.zonal_tesseral_harmonics_indicator, be);
    write_chars(r1 + h1::kSpares2, h.spares_2, 8);
    ephem::write_f64(r1 + h1::kLunarGravPerturbIndicator, h.lunar_grav_perturb_indicator, be);
    ephem::write_f64(r1 + h1::kSolarRadiationPerturbIndicator,
                     h.solar_radiation_perturb_indicator, be);
    ephem::write_f64(r1 + h1::kSolarGravPerturbIndicator, h.solar_grav_perturb_indicator, be);
    ephem::write_f64(r1 + h1::kAtmosphericDragPerturbIndicator,
                     h.atmospheric_drag_perturb_indicator, be);
    ephem::write_f64(r1 + h1::kEpochTimeOfElementsDut, h.epoch_time_of_elements_dut, be);
    ephem::write_f64(r1 + h1::kYearOfEpoch, h.year_of_epoch_yyy, be);
    ephem::write_f64(r1 + h1::kMonthOfEpoch, h.month_of_epoch_mm, be);
    ephem::write_f64(r1 + h1::kDayOfEpoch, h.day_of_epoch_dd, be);
    ephem::write_f64(r1 + h1::kHourOfEpoch, h.hour_of_epoch_hh, be);
    ephem::write_f64(r1 + h1::kMinuteOfEpoch, h.minute_of_epoch_mm, be);
    ephem::write_f64(r1 + h1::kSecondsOfEpochMilsec, h.seconds_of_epoch_milsec, be);
    write_f64_array(r1, h1::kKeplerianElementsAtEpoch, h.keplerian_elements_at_epoch_rad, 6, be);
    ephem::write_f64(r1 + h1::kTrueAnomalyAtEpoch, h.true_anomaly_at_epoch, be);
    ephem::write_f64(r1 + h1::kArgOfLatitudeAtEpoch, h.arg_of_latitude_at_epoch, be);
    ephem::write_f64(r1 + h1::kFlightPathAngleAtEpoch, h.flight_path_angle_at_epoch, be);
    ephem::write_f64(r1 + h1::kEccAnomalyAtEpoch, h.ecc_anomaly_at_epoch, be);
    ephem::write_f64(r1 + h1::kAnomalisticPeriodDut, h.anomalistic_period_dut, be);
    ephem::write_f64(r1 + h1::kPerigeeHeightAtEpoch, h.perigee_height_at_epoch, be);
    ephem::write_f64(r1 + h1::kApogeeHeightAtEpoch, h.apogee_height_at_epoch, be);
    ephem::write_f64(r1 + h1::kMeanMotion, h.mean_motion, be);
    ephem::write_f64(r1 + h1::kRateOfChangeOfArgOfPerigee, h.rate_of_change_of_arg_of_perigee, be);
    ephem::write_f64(r1 + h1::kRateOfChangeOfRaOfAscendingNode,
                     h.rate_of_change_of_ra_of_ascending_node, be);
    write_f64_array(r1, h1::kCartesianElementsAtEpochDult, h.cartesian_elements_at_epoch_dult, 6, be);
    write_f64_array(r1, h1::kTSubQ, h.t_sub_q, 14, be);
    write_chars(r1 + h1::kSpares3, h.spares_3, 48);
    ephem::write_f64(r1 + h1::kRhoSub1, h.rho_sub_1, be);
    ephem::write_f64(r1 + h1::kRhoSub2, h.rho_sub_2, be);
    ephem::write_f64(r1 + h1::kRhoSub3, h.rho_sub_3, be);
    ephem::write_f64(r1 + h1::kRhoSub4, h.rho_sub_4, be);
    write_f64_array(r1, h1::kBrouwer1stOrderDragTerms, h.brouwer_1st_order_drag_terms, 14, be);
    write_f64_array(r1, h1::kBrouwer2ndOrderDragTerms, h.brouwer_2nd_order_drag_terms, 14, be);
    write_chars(r1 + h1::kSpares4, h.spares_4, 40);
    write_f64_array(r1, h1::kGeocentricCoordOfSunAtEpoch, h.geocentric_coord_of_sun_at_epoch, 3, be);
    ephem::write_f64(r1 + h1::kTotalNumberOfBrouwerDragTerms,
                     h.total_number_of_brouwer_drag_terms, be);
    write_chars(r1 + h1::kSpares5, h.spares_5, 480);
    ephem::write_f64(r1 + h1::kStartTimeOfEphemerisDut, h.start_time_of_ephemeris_dut, be);
    ephem::write_f64(r1 + h1::kEndTimeOfEphemerisDut, h.end_time_of_ephemeris_dut, be);
    ephem::write_f64(r1 + h1::kTimeIntervalBetweenPointsDut,
                     h.time_interval_between_points_dut, be);
    ephem::write_f64(r1 + h1::kPrecessionNutationIndicator, h.precession_nutation_indicator, be);
    ephem::write_f64(r1 + h1::kGhaAtEpoch, h.gha_at_epoch, be);
    ephem::write_f64(r1 + h1::kCoordinateCenterIndicator, h.coordinate_center_indicator, be);
    ephem::write_f64(r1 + h1::kDateOfInitiationOfEphemComp,
                     h.date_of_initiation_of_ephem_comp_yyymmdd, be);
    ephem::write_f64(r1 + h1::kTimeOfInitiationOfEphemComp,
                     h.time_of_initiation_of_ephem_comp_hhmmss, be);
    ephem::write_f64(r1 + h1::kGhaAtEphemStartRad, h.gha_at_ephem_start_rad, be);
    ephem::write_f64(r1 + h1::kGhaAtEphemerisEndRad, h.gha_at_ephemeris_end_rad, be);
    ephem::write_i32(r1 + h1::kOutputIntervalIndicator, h.output_interval_indicator, be);
    ephem::write_i32(r1 + h1::kLeapSecondIndicator, h.leap_second_indicator, be);
    ephem::write_f64(r1 + h1::kDateOfLeapSeconds, h.date_of_leap_seconds_yyymmdd, be);
    ephem::write_f64(r1 + h1::kTimeOfLeapSeconds, h.time_of_leap_seconds_hhmmss, be);
    ephem::write_f64(r1 + h1::kUtcTimeAdjustmentSec, h.utc_time_adjustment_sec, be);
    write_f64_array(r1, h1::kDcObservationTimeSpan, h.dc_observation_time_span, 4, be);
    ephem::write_i32(r1 + h1::kTrackingValidationIndicator, h.tracking_validation_indicator, be);
    write_chars(r1 + h1::kSpares6, h.spares_6, 660);
    write_chars(r1 + h1::kHarmonicsWithTitles1, h.harmonics_with_titles_1, 456);
    write_chars(r2, h.harmonics_with_titles_2, kRecordSize);
}

}  // namespace detail

/* ------------------------------------------------------------------------ */
/* Reader                                                                    */
/* ------------------------------------------------------------------------ */

/*
 * Reads a whole Code-500 file. `out` receives the state history; `hdr`, when
 * given, receives every header field including the spares, which is what makes
 * a byte-exact rewrite possible.
 *
 * Row epochs come out as SECONDS FROM THE DUT ORIGIN in the file's declared
 * scale, not as an absolute date, because turning them into one needs the
 * leap-second table this layer does not own.
 */
inline ephem::Status read(const uint8_t* bytes, size_t len, ephem::Series* out,
                          Header* hdr = nullptr) {
    if (!bytes || !out) return ephem::Status::Malformed;
    if (len < 3 * kRecordSize) return ephem::Status::Truncated;
    if (len % kRecordSize != 0) return ephem::Status::Truncated;

    /* Byte order, by the only field in the header whose legal values are known
     * a priori. A swapped 1.0 or 2.0 reads as a denormal near 3e-320, so the
     * test is decisive rather than heuristic. */
    bool be = false;
    double tsi = ephem::read_f64(bytes + h1::kTimeSystemIndicator, false);
    if (tsi != 1.0 && tsi != 2.0) {
        tsi = ephem::read_f64(bytes + h1::kTimeSystemIndicator, true);
        if (tsi != 1.0 && tsi != 2.0) return ephem::Status::BadMagic;
        be = true;
    }

    Header local;
    Header* h = hdr ? hdr : &local;
    detail::unpack_header(bytes, bytes + kRecordSize, be, h);

    *out = ephem::Series{};
    out->time_system = time_system_name(h->time_system_indicator);
    out->frame_name = trim(h->coord_system_indicator_1);
    out->center_name = body_name(h->coordinate_center_indicator, 2);
    /* The satellite id is a double in this format. Only an integral one has an
     * unambiguous text form, so a fractional id stays in the header rather than
     * being rendered into an identifier that will not compare equal later. */
    if (ephem::is_finite(h->sat_id) &&
        static_cast<double>(static_cast<int64_t>(h->sat_id)) == h->sat_id) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(h->sat_id));
        out->object_id = buf;
    }
    out->object_name = trim(h->product_id);
    {
        int y = 0, m = 0, d = 0;
        if (decode_yymmdd(h->ref_time_for_dut_yymmdd, &y, &m, &d)) {
            out->epoch_zero_iso = iso_date_midnight(y, m, d);
            out->epoch_zero_offset_sec = seconds_past_j2000(y, m, d, 0.0);
        }
    }

    const size_t records = len / kRecordSize;
    for (size_t rec = 2; rec < records; ++rec) {
        const uint8_t* r = bytes + rec * kRecordSize;

        /* Ten sentinels in the leading fields is the "no more data" record. */
        int leading = 0;
        for (size_t k = 0; k < 4; ++k) {
            if (is_sentinel(ephem::read_f64(r + 8 * k, be))) ++leading;
        }
        for (size_t k = 0; k < 6; ++k) {
            if (is_sentinel(ephem::read_f64(r + d1::kFirstStateVectorDult + 8 * k, be))) ++leading;
        }
        if (leading == 10) break;

        const double base_dut = ephem::read_f64(r + d1::kTimeOfFirstDataPointDut, be);
        const double step_sec = ephem::read_f64(r + d1::kTimeIntervalBetweenPointsSec, be);
        if (!ephem::is_finite(base_dut) || !ephem::is_finite(step_sec)) {
            return ephem::Status::Malformed;
        }
        const double base_sec = base_dut * kDutToSec;

        /* Count the states in this record BEFORE emitting any, because a record
         * holding more than one state with no step declared has no reconstructible
         * epoch for its second point and must be refused rather than guessed at.
         * That is a real limitation of the container: it stores one time per
         * record plus a stride, so a variable-step history cannot be written. */
        size_t count = 1;
        for (size_t i = 0; i + 1 < kStatesPerRecord; ++i) {
            const uint8_t* s = r + d1::kStateVector2Thru50Dult + 48 * i;
            int sentinels = 0, zeros = 0;
            double v[6];
            for (int j = 0; j < 6; ++j) {
                v[j] = ephem::read_f64(s + 8 * j, be);
                if (is_sentinel(v[j])) ++sentinels;
                /* GMAT also treats an all-zero slot as a terminator, for files
                 * from producers that zero-fill rather than sentinel-fill. A
                 * genuinely zero position AND velocity is not a state any body
                 * can occupy, so the rule costs nothing. */
                if (v[j] > -1e-12 && v[j] < 1e-12) ++zeros;
            }
            if (sentinels > 5 || zeros > 5) break;
            ++count;
        }
        if (count > 1 && !(step_sec > 0.0)) return ephem::Status::UnsupportedVariant;

        for (size_t i = 0; i < count; ++i) {
            const uint8_t* s = i == 0 ? r + d1::kFirstStateVectorDult
                                      : r + d1::kStateVector2Thru50Dult + 48 * (i - 1);
            ephem::StateRow row;
            row.epoch = base_sec + static_cast<double>(i) * step_sec;
            for (int j = 0; j < 3; ++j) {
                row.pos[j] = ephem::read_f64(s + 8 * j, be) * kDulToKm;
                row.vel[j] = ephem::read_f64(s + 8 * (j + 3), be) * kDulDutToKmSec;
            }
            row.has_vel = true;
            if (!ephem::row_is_finite(row)) return ephem::Status::Malformed;
            out->rows.push_back(row);
        }

        /* A short record ends the file: the slots after it are fill, not data. */
        if (count < kStatesPerRecord) break;
    }

    if (out->rows.empty()) return ephem::Status::NotEnoughStates;
    return ephem::Status::Ok;
}

/* ------------------------------------------------------------------------ */
/* Writer                                                                    */
/* ------------------------------------------------------------------------ */

/*
 * Fills the header fields that DESCRIBE a given series — the span, the step and
 * the packed start/end calendar dates — leaving everything else alone.
 *
 * This is separate from write() on purpose. write() emits the header exactly as
 * handed to it, so a read/modify/write cycle reproduces the original bytes and
 * the caller can see which fields it chose to change. A writer that silently
 * recomputed half the header would make a byte-level round trip impossible to
 * assert, and impossible to distinguish from a writer that corrupts it.
 */
inline ephem::Status derive_header(const ephem::Series& s, Header* hdr) {
    if (!hdr) return ephem::Status::Malformed;
    if (s.rows.empty()) return ephem::Status::NotEnoughStates;

    int ry = 1957, rm = 9, rd = 18;
    if (!decode_yymmdd(hdr->ref_time_for_dut_yymmdd, &ry, &rm, &rd)) {
        hdr->ref_time_for_dut_yymmdd = kDefaultRefTimeForDutYymmdd;
        decode_yymmdd(kDefaultRefTimeForDutYymmdd, &ry, &rm, &rd);
    }
    const int64_t ref_day = days_from_civil(ry, rm, rd);

    double step = 0.0;
    hdr->output_interval_indicator = s.uniform_step(&step) ? 1 : 2;
    hdr->step_size_sec = step;
    hdr->time_interval_between_points_dut = step * kSecToDut;

    const double first = s.rows.front().epoch;
    const double last = s.rows.back().epoch;
    hdr->start_time_of_ephemeris_dut = first * kSecToDut;
    hdr->end_time_of_ephemeris_dut = last * kSecToDut;

    struct Split {
        double packed_date;
        double day_of_year;
        double seconds_of_day;
    };
    auto split = [&](double epoch_sec) {
        /* Floor division, so an epoch before the DUT origin lands on the right
         * calendar day instead of one day late with a negative time of day. */
        double days = epoch_sec / 86400.0;
        int64_t whole = static_cast<int64_t>(days);
        if (static_cast<double>(whole) > days) --whole;
        const double secs = epoch_sec - static_cast<double>(whole) * 86400.0;
        int y = 0, m = 0, d = 0;
        civil_from_days(ref_day + whole, &y, &m, &d);
        const double doy = static_cast<double>(days_from_civil(y, m, d) -
                                               days_from_civil(y, 1, 1) + 1);
        const double packed = hdr->year_format == 2
                                  ? static_cast<double>(y) * 10000.0 + m * 100.0 + d
                                  : static_cast<double>(y - 1900) * 10000.0 + m * 100.0 + d;
        return Split{packed, doy, secs};
    };

    const Split a = split(first);
    const Split b = split(last);
    hdr->start_date_of_ephem_yyymmdd = a.packed_date;
    hdr->start_day_count_of_year = a.day_of_year;
    hdr->start_seconds_of_day = a.seconds_of_day;
    hdr->end_date_of_ephem_yyymmdd = b.packed_date;
    hdr->end_day_count_of_year = b.day_of_year;
    hdr->end_seconds_of_day = b.seconds_of_day;

    /* The header's own copy of the first state, in the file's units. */
    for (int j = 0; j < 3; ++j) {
        hdr->cartesian_elements_at_epoch_dult[j] = s.rows.front().pos[j] * kKmToDul;
        hdr->cartesian_elements_at_epoch_dult[j + 3] = s.rows.front().vel[j] * kKmSecToDulDut;
    }
    hdr->epoch_time_of_elements_dut = hdr->start_time_of_ephemeris_dut;
    return ephem::Status::Ok;
}

/*
 * Serialises `s` into a Code-500 file: header 1, header 2, then data records of
 * fifty states each, sentinel-terminated the way GMAT terminates them.
 *
 * The container has six state elements and no acceleration column, so any
 * acceleration on the series is dropped — that is the format, not a shortcut.
 * A row with no velocity is REFUSED rather than written as three zeros, because
 * a zero velocity is a claim the series never made.
 */
inline ephem::Status write(const ephem::Series& s, const Header& hdr, std::vector<uint8_t>* out) {
    if (!out) return ephem::Status::Malformed;
    if (s.rows.empty()) return ephem::Status::NotEnoughStates;
    if (!s.all_have_velocity()) return ephem::Status::Unsupported;

    const bool be = hdr.big_endian;
    const size_t n = s.rows.size();
    const size_t data_records = (n + kStatesPerRecord - 1) / kStatesPerRecord;
    /* A file whose last data record is full needs an extra all-sentinel record,
     * because there is no free slot left in which to mark the end. */
    const bool trailing_sentinel_record = (n % kStatesPerRecord) == 0;
    const size_t total = 2 + data_records + (trailing_sentinel_record ? 1 : 0);

    out->assign(total * kRecordSize, static_cast<uint8_t>(' '));
    uint8_t* base = out->data();
    detail::pack_header(hdr, base, base + kRecordSize);

    int ry = 1957, rm = 9, rd = 18;
    if (!decode_yymmdd(hdr.ref_time_for_dut_yymmdd, &ry, &rm, &rd)) {
        decode_yymmdd(kDefaultRefTimeForDutYymmdd, &ry, &rm, &rd);
    }
    const int64_t ref_day = days_from_civil(ry, rm, rd);

    for (size_t rec = 0; rec < data_records; ++rec) {
        uint8_t* r = base + (2 + rec) * kRecordSize;
        const size_t first = rec * kStatesPerRecord;
        const size_t count = (n - first) < kStatesPerRecord ? (n - first) : kStatesPerRecord;

        /* Every slot starts as a sentinel, so the unused tail of a short record
         * marks the end of the file without a second pass. */
        for (size_t i = 0; i < 6; ++i) {
            ephem::write_f64(r + d1::kFirstStateVectorDult + 8 * i, kSentinel, be);
        }
        for (size_t i = 0; i + 1 < kStatesPerRecord; ++i) {
            for (size_t j = 0; j < 6; ++j) {
                ephem::write_f64(r + d1::kStateVector2Thru50Dult + 48 * i + 8 * j, kSentinel, be);
            }
        }

        /* Each record carries its OWN stride, so a series that is piecewise
         * uniform is representable even though a globally variable one is not.
         * A record whose points are not evenly spaced has nowhere to put the
         * spacing and is refused. */
        double step = 0.0;
        if (count > 1) {
            step = s.rows[first + 1].epoch - s.rows[first].epoch;
            if (!(step > 0.0)) return ephem::Status::Unsupported;
            for (size_t i = 2; i < count; ++i) {
                const double d = s.rows[first + i].epoch - s.rows[first + i - 1].epoch;
                const double diff = d > step ? d - step : step - d;
                if (diff > 1e-9 * (step > 1.0 ? step : 1.0)) return ephem::Status::Unsupported;
            }
        }

        const double base_sec = s.rows[first].epoch;
        double days = base_sec / 86400.0;
        int64_t whole = static_cast<int64_t>(days);
        if (static_cast<double>(whole) > days) --whole;
        int y = 0, m = 0, d = 0;
        civil_from_days(ref_day + whole, &y, &m, &d);
        const double packed = hdr.year_format == 2
                                  ? static_cast<double>(y) * 10000.0 + m * 100.0 + d
                                  : static_cast<double>(y - 1900) * 10000.0 + m * 100.0 + d;
        ephem::write_f64(r + d1::kDateOfFirstEphemPoint, packed, be);
        ephem::write_f64(r + d1::kDayOfYearForFirstEphemPoint,
                         static_cast<double>(days_from_civil(y, m, d) - days_from_civil(y, 1, 1) + 1),
                         be);
        ephem::write_f64(r + d1::kSecsOfDayForFirstEphemPoint,
                         base_sec - static_cast<double>(whole) * 86400.0, be);
        ephem::write_f64(r + d1::kTimeIntervalBetweenPointsSec, step, be);
        ephem::write_f64(r + d1::kTimeOfFirstDataPointDut, base_sec * kSecToDut, be);
        ephem::write_f64(r + d1::kTimeIntervalBetweenPointsDut, step * kSecToDut, be);
        /* 1 = thrusting, 2 = free flight. GMAT writes 2 on every record it
         * emits; nothing in the series says otherwise. */
        ephem::write_f64(r + d1::kThrustIndicator, 2.0, be);
        write_chars(r + d1::kSpares1, std::string(), 344);

        for (size_t i = 0; i < count; ++i) {
            const ephem::StateRow& row = s.rows[first + i];
            if (!ephem::row_is_finite(row)) return ephem::Status::Malformed;
            uint8_t* slot = i == 0 ? r + d1::kFirstStateVectorDult
                                   : r + d1::kStateVector2Thru50Dult + 48 * (i - 1);
            for (int j = 0; j < 3; ++j) {
                ephem::write_f64(slot + 8 * j, row.pos[j] * kKmToDul, be);
                ephem::write_f64(slot + 8 * (j + 3), row.vel[j] * kKmSecToDulDut, be);
            }
        }
    }

    if (trailing_sentinel_record) {
        uint8_t* r = base + (2 + data_records) * kRecordSize;
        for (size_t k = 0; k < 4; ++k) ephem::write_f64(r + 8 * k, kSentinel, be);
        for (size_t i = 0; i < 6; ++i) {
            ephem::write_f64(r + d1::kFirstStateVectorDult + 8 * i, kSentinel, be);
        }
        for (size_t i = 0; i + 1 < kStatesPerRecord; ++i) {
            for (size_t j = 0; j < 6; ++j) {
                ephem::write_f64(r + d1::kStateVector2Thru50Dult + 48 * i + 8 * j, kSentinel, be);
            }
        }
        ephem::write_f64(r + d1::kTimeOfFirstDataPointDut, 0.0, be);
        ephem::write_f64(r + d1::kTimeIntervalBetweenPointsDut, 0.0, be);
        ephem::write_f64(r + d1::kThrustIndicator, 2.0, be);
        write_chars(r + d1::kSpares1, std::string(), 344);
    }

    return ephem::Status::Ok;
}

}  // namespace code500

#endif  // ORBIT_PRODUCTS_CODE500_HPP
