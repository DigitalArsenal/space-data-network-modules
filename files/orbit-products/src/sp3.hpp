/*
 * SP3-d reader and writer, over the ephemeris spine.
 *
 * Authority: "The Extended Standard Product 3 Orbit Format (SP3-d)", Steve
 * Hilla, National Geodetic Survey, 21 February 2016
 * (https://files.igs.org/pub/data/format/sp3d.pdf). Every column number below
 * is that document's, and the spec's own Example 1 and Example 2 are the
 * layouts the writer reproduces. SP3-c
 * (https://files.igs.org/pub/data/format/sp3c.txt) shares the record layout,
 * so `read` accepts 'a'..'d' and `write` emits 'c' or 'd'.
 *
 * WHAT SP3-d CHANGED, and why the writer cares. SP3-c capped a file at 85
 * satellites, which pinned the header at exactly five "+ " and five "++"
 * lines; SP3-d raised the cap to 999 and made the count of those lines a
 * function of the satellite count (17 ids per line), while keeping five as a
 * FLOOR for backwards compatibility. A writer that hardcodes five lines
 * silently truncates a 122-satellite MGEX product to 85; a writer that emits
 * ceil(n/17) without the floor produces a header that pre-SP3-d readers walk
 * off the end of. Both are wrong, and both look fine until someone else parses
 * the file. SP3-d also widened comments from 60 to 80 columns.
 *
 * COLUMNS ARE THE FORMAT. SP3 is FORTRAN-formatted: a field one column left of
 * where the spec puts it is not a cosmetic defect, it is a different number to
 * every strict reader. So every field here is emitted at a checked width and
 * the write REFUSES (OutOfRange) rather than let a too-large value push the
 * rest of the record sideways.
 *
 * THE P/V UNIT ASYMMETRY — the single most-botched thing in SP3 writers.
 * Position records carry kilometres in cols 5-46 and a clock bias in
 * MICROSECONDS in cols 47-60. Velocity records reuse the identical F14.6
 * layout but carry DECIMETRES PER SECOND in cols 5-46 and a clock drift in
 * 1e-4 MICROSECONDS PER SECOND in cols 47-60. The unit choice is not
 * arbitrary: F14.6 decimetres/second gives a 4 km/s orbit a 40000.000000-style
 * field with 1e-4 mm/s resolution, which km/s in the same field could not
 * reach. So the km/s <-> dm/s factor of 1e4 lives in exactly two places in
 * this file (`kKmPerSecToDmPerSec` and its inverse) and nowhere else.
 *
 * SENTINELS DO NOT ESCAPE INTO THE SPINE. SP3 spells "no clock" as the literal
 * 999999.999999 and "no position" as 0.000000. Both are ordinary doubles, so a
 * reader that passes them through hands its caller a satellite one second off
 * GPS time sitting at the geocentre. They are translated at this boundary:
 * an absent clock becomes StateRow::has_clock == false, an absent position
 * drops the record entirely. Nothing downstream ever sees a magic number, and
 * nothing here ever produces a NaN — a field that will not parse is a Status.
 *
 * TIME: none is converted, per the spine's rule. SP3 epochs are calendar
 * instants in the time system the %c line declares (usually GPS); they are
 * carried as seconds from the file's own first epoch, with that first epoch in
 * Series::epoch_zero_iso and the declared scale in Series::time_system. The
 * calendar arithmetic here is proleptic-Gregorian day counting, which involves
 * no leap second and is exact in integers. That is also why the GPS week and
 * seconds-of-week on header line 2 are written from what the caller declared
 * rather than derived: deriving them from a calendar epoch is only leap-second
 * free when the file's time system happens to be GPS, and a writer that is
 * silently right for GPS and silently wrong for UTC is worse than one that
 * refuses to guess.
 */

#ifndef ORBIT_PRODUCTS_SP3_HPP
#define ORBIT_PRODUCTS_SP3_HPP

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "ephemeris_series.hpp"

namespace sp3 {

/* ------------------------------------------------------------------------ */
/* Format constants                                                          */
/* ------------------------------------------------------------------------ */

/* Satellite ids per "+ "/"++" header line: cols 10-12, 13-15 ... 58-60. */
static constexpr size_t kSatsPerLine = 17;

/* Five "+ " and five "++" lines, and four comment lines, are required even
 * when the satellite count needs fewer — SP3-d keeps them so that software
 * written against SP3-c's fixed 22-line header still finds the epoch records
 * where it expects them. */
static constexpr size_t kMinIdLines = 5;
static constexpr size_t kMinComments = 4;

/* SP3-d raised the ceiling from SP3-c's 85; the field itself is I3. */
static constexpr size_t kMaxSatsC = 85;
static constexpr size_t kMaxSatsD = 999;

/* Comment text occupies cols 4-80 in SP3-d and cols 4-60 in SP3-c. */
static constexpr size_t kCommentWidthD = 77;
static constexpr size_t kCommentWidthC = 57;

/* The written form of "bad or absent clock". The spec requires the six
 * integer nines and makes the fractional nines optional, so a reader must
 * accept 999999. as readily as 999999.999999 — hence a THRESHOLD on read and a
 * literal on write. 999999 microseconds is a full second of clock offset,
 * which no GNSS satellite clock has ever been near, so the threshold cannot
 * eat a real value. It also absorbs the 9999999.999999 that some writers emit
 * for the clock rate. */
static constexpr double kAbsentClock = 999999.999999;
static constexpr double kAbsentClockThreshold = 999999.0;

/* See the P/V note in the file header. Position km, velocity dm/s. */
static constexpr double kKmPerSecToDmPerSec = 1.0e4;
static constexpr double kDmPerSecToKmPerSec = 1.0e-4;

/* Ticks are hundredths of a microsecond, the resolution of the F11.8 seconds
 * field on an epoch header. Integers, so an epoch survives the round trip
 * without a decimal-rounding argument. */
static constexpr int64_t kTicksPerSecond = 100000000LL;
static constexpr int64_t kTicksPerMinute = 60LL * kTicksPerSecond;
static constexpr int64_t kTicksPerHour = 60LL * kTicksPerMinute;
static constexpr int64_t kTicksPerDay = 24LL * kTicksPerHour;

/* MJD 0 is 1858-11-17; the internal day count is from 1970-01-01. */
static constexpr int64_t kMjdZeroAsDays1970 = -40587LL;

/* ------------------------------------------------------------------------ */
/* Per-record columns 61-80                                                  */
/* ------------------------------------------------------------------------ */

/*
 * The tail of a P or V record: standard-deviation EXPONENTS (the value is
 * base**exponent, with the bases on the %f line) and four single-character
 * event flags. None of this is state, so none of it belongs on StateRow — but
 * dropping it would make a read-modify-write silently erase a maneuver flag,
 * so it is carried alongside, one entry per row.
 *
 * A negative exponent means the field was blank, which the spec defines as
 * "standard deviation unknown" and which is NOT the same as an exponent of 0.
 */
struct RecordFlags {
    int16_t x_sdev = -1; /* cols 62-63, exponent on the pos/vel base, mm       */
    int16_t y_sdev = -1; /* cols 65-66                                        */
    int16_t z_sdev = -1; /* cols 68-69                                        */
    int16_t c_sdev = -1; /* cols 71-73, exponent on the clock base, psec      */

    int16_t xv_sdev = -1; /* V record cols 62-63, 1e-4 mm/s                   */
    int16_t yv_sdev = -1;
    int16_t zv_sdev = -1;
    int16_t cr_sdev = -1; /* V record cols 71-73, 1e-4 psec/s                 */

    bool clock_event = false;      /* col 75 'E': clock discontinuity          */
    bool clock_predicted = false;  /* col 76 'P'                               */
    bool maneuver = false;         /* col 79 'M'                               */
    bool orbit_predicted = false;  /* col 80 'P'                               */

    /* StateRow has one has_clock for the bias. A record may carry a bias and
     * sentinel its rate, so the rate's presence is tracked here rather than
     * folded into the bias flag. */
    bool has_clock_rate = false;
};

/* ------------------------------------------------------------------------ */
/* The file                                                                  */
/* ------------------------------------------------------------------------ */

struct SatelliteBlock {
    std::string sat_id;         /* "G01", "R24", "C48" — letter + 2 digits    */
    int accuracy_exponent = 0;  /* "++" line; 2**n mm, 0 meaning "unknown"    */
    ephem::Series series;

    /* Parallel to series.rows. Either empty (nothing to carry) or the same
     * length; a shorter vector is treated as all-defaults. */
    std::vector<RecordFlags> flags;
};

struct File {
    char version = 'd';       /* line 1 cols 1-2, the letter after '#'        */
    char pos_vel_flag = 'P';  /* line 1 col 3: 'V' means every P has a V      */

    std::string data_used;      /* cols 41-45 */
    std::string coordinate_sys; /* cols 47-51, e.g. "IGS20" */
    std::string orbit_type;     /* cols 53-55: FIT / EXT / BCT / HLM */
    std::string agency;         /* cols 57-60 */
    std::string time_system;    /* %c cols 10-12: GPS/GLO/GAL/BDT/TAI/UTC/... */

    int gps_week = 0;             /* line 2 cols 4-7   */
    double seconds_of_week = 0.0; /* line 2 cols 9-23,  0 <= s < 604800       */
    double epoch_interval = 0.0;  /* line 2 cols 25-38, 0 < i < 100000        */
    int mjd = 0;                  /* line 2 cols 40-44, 44244 = GPS zero time */
    double fractional_day = 0.0;  /* line 2 cols 46-60, 0 <= f < 1            */

    double base_pos_vel_sigma = 0.0; /* %f cols 4-13,  e.g. 1.25   */
    double base_clk_rate_sigma = 0.0; /* %f cols 15-26, e.g. 1.025 */

    std::vector<std::string> comments;
    std::vector<SatelliteBlock> satellites;

    /* ---- carried so the header can be written back exactly -------------- */

    /* %c cols 4-5. One of "G ", "M ", "R ", "L ", "S ", "I ", "E ", "C ",
     * "J "; the spec implies no default, so an empty value is a refusal on
     * write rather than a guess at "mixed". */
    std::string file_type;

    /* Line 1's calendar epoch, ISO-8601 without a zone designator because the
     * scale is `time_system`, not UTC. This is the zero point every Series in
     * the file counts seconds from. Empty on write means "derive it from
     * mjd + fractional_day". */
    std::string start_epoch_iso;

    /* Line 1 cols 33-39 AS READ. `write` ignores it and emits the number of
     * epoch records it actually produced: a declared count that disagrees with
     * the body is a file that fails its own integrity check. */
    int declared_num_epochs = 0;
};

ephem::Status read(const char* text, size_t len, File* out);
ephem::Status write(const File& f, std::string* out);

/* ------------------------------------------------------------------------ */
/* Text helpers                                                              */
/* ------------------------------------------------------------------------ */

namespace detail {

inline std::string trim(const std::string& s) {
    size_t a = 0;
    while (a < s.size() && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r')) ++a;
    size_t b = s.size();
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r')) --b;
    return s.substr(a, b - a);
}

inline void rtrim_in_place(std::string* s) {
    size_t b = s->size();
    while (b > 0 && (*s)[b - 1] == ' ') --b;
    s->resize(b);
}

/* 1-indexed inclusive column slice. The spec is explicit that a record may
 * stop short of its last column and that the missing columns are blanks, so a
 * slice past the end is empty rather than an error. */
inline std::string cols(const std::string& line, size_t first, size_t last) {
    if (first < 1 || last < first || line.size() < first) return std::string();
    const size_t begin = first - 1;
    const size_t avail = line.size() - begin;
    const size_t want = last - first + 1;
    return line.substr(begin, want < avail ? want : avail);
}

/*
 * strtod on a bounded slice. `blank` distinguishes "the field was empty",
 * which several fields define as meaningful, from "the field held something
 * that is not a number", which is Malformed. Text spellings of NaN and
 * infinity parse fine in strtod and are rejected here, because the one thing
 * this reader must never do is hand a NaN to the spine.
 */
inline bool parse_double(const std::string& line, size_t first, size_t last, double* out,
                         bool* blank) {
    const std::string field = trim(cols(line, first, last));
    if (blank) *blank = field.empty();
    if (field.empty()) {
        *out = 0.0;
        return true;
    }
    char* end = nullptr;
    const double v = std::strtod(field.c_str(), &end);
    if (end != field.c_str() + field.size()) return false;
    if (!ephem::is_finite(v)) return false;
    *out = v;
    return true;
}

inline bool parse_int(const std::string& line, size_t first, size_t last, long* out,
                      bool* blank) {
    const std::string field = trim(cols(line, first, last));
    if (blank) *blank = field.empty();
    if (field.empty()) {
        *out = 0;
        return true;
    }
    char* end = nullptr;
    const long v = std::strtol(field.c_str(), &end, 10);
    if (end != field.c_str() + field.size()) return false;
    *out = v;
    return true;
}

/* ------------------------------------------------------------------------ */
/* Calendar arithmetic (proleptic Gregorian, integer-exact, leap-second free) */
/* ------------------------------------------------------------------------ */

/* Howard Hinnant's civil_from_days / days_from_civil, whose correctness is
 * established for the whole int64 range rather than for a window of years. */
inline int64_t days_from_civil(int64_t y, int64_t m, int64_t d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const int64_t yoe = y - era * 400;
    const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

inline void civil_from_days(int64_t z, int64_t* y, int64_t* m, int64_t* d) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t yr = yoe + era * 400;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    *d = doy - (153 * mp + 2) / 5 + 1;
    *m = mp + (mp < 10 ? 3 : -9);
    *y = yr + (*m <= 2);
}

/* Euclidean division, so a pre-1970 instant floors instead of truncating
 * toward zero and lands a day early. */
inline int64_t floor_div(int64_t a, int64_t b) {
    const int64_t q = a / b;
    return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q;
}

inline int64_t round_ticks(double seconds) {
    const double t = seconds * static_cast<double>(kTicksPerSecond);
    return t >= 0.0 ? static_cast<int64_t>(t + 0.5) : -static_cast<int64_t>(-t + 0.5);
}

struct Civil {
    int64_t year = 0, month = 1, day = 1, hour = 0, minute = 0;
    int64_t sec_ticks = 0; /* 0 .. 59_99999999 */
};

inline int64_t ticks_from_civil(const Civil& c) {
    return days_from_civil(c.year, c.month, c.day) * kTicksPerDay + c.hour * kTicksPerHour +
           c.minute * kTicksPerMinute + c.sec_ticks;
}

inline Civil civil_from_ticks(int64_t ticks) {
    Civil c;
    const int64_t day = floor_div(ticks, kTicksPerDay);
    int64_t rem = ticks - day * kTicksPerDay;
    civil_from_days(day, &c.year, &c.month, &c.day);
    c.hour = rem / kTicksPerHour;
    rem -= c.hour * kTicksPerHour;
    c.minute = rem / kTicksPerMinute;
    rem -= c.minute * kTicksPerMinute;
    c.sec_ticks = rem;
    return c;
}

/* "YYYY-MM-DDTHH:MM:SS.ssssssss". No 'Z': the scale is the file's declared
 * time system, and stamping a UTC designator on a GPS-time epoch is exactly
 * the 18-second lie this layer exists to avoid. */
inline std::string iso_from_ticks(int64_t ticks) {
    const Civil c = civil_from_ticks(ticks);
    char buf[48];
    const int n = std::snprintf(buf, sizeof(buf),
                                "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%08lld",
                                static_cast<long long>(c.year), static_cast<long long>(c.month),
                                static_cast<long long>(c.day), static_cast<long long>(c.hour),
                                static_cast<long long>(c.minute),
                                static_cast<long long>(c.sec_ticks / kTicksPerSecond),
                                static_cast<long long>(c.sec_ticks % kTicksPerSecond));
    if (n <= 0) return std::string();
    return std::string(buf, static_cast<size_t>(n));
}

inline bool ticks_from_iso(const std::string& iso, int64_t* out) {
    /* YYYY-MM-DDThh:mm:ss[.frac] — the shape iso_from_ticks emits, plus a
     * space separator and an optional fraction, which is what hand-written
     * callers actually produce. */
    if (iso.size() < 19) return false;
    long long y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
    if (std::sscanf(iso.c_str(), "%lld-%lld-%lld", &y, &mo, &d) != 3) return false;
    const char sep = iso[10];
    if (sep != 'T' && sep != 't' && sep != ' ') return false;
    if (std::sscanf(iso.c_str() + 11, "%lld:%lld:%lld", &h, &mi, &s) != 3) return false;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 ||
        s > 60) {
        return false;
    }
    int64_t frac = 0;
    const size_t dot = iso.find('.', 19);
    if (dot != std::string::npos) {
        int64_t scale = kTicksPerSecond / 10;
        for (size_t i = dot + 1; i < iso.size() && scale > 0; ++i) {
            if (iso[i] < '0' || iso[i] > '9') break;
            frac += static_cast<int64_t>(iso[i] - '0') * scale;
            scale /= 10;
        }
    }
    Civil c;
    c.year = y;
    c.month = mo;
    c.day = d;
    c.hour = h;
    c.minute = mi;
    c.sec_ticks = s * kTicksPerSecond + frac;
    *out = ticks_from_civil(c);
    return true;
}

/* ------------------------------------------------------------------------ */
/* Fixed-width emission                                                      */
/* ------------------------------------------------------------------------ */

/*
 * Append exactly `width` characters, or fail. This is the whole defence
 * against a misaligned record: snprintf widens rather than truncates when a
 * value does not fit its format, so checking the returned length is checking
 * that every following field is still in its own columns.
 */
inline bool emit_f(std::string* out, const char* fmt, double v, size_t width) {
    if (!ephem::is_finite(v)) return false;
    char buf[64];
    const int n = std::snprintf(buf, sizeof(buf), fmt, v);
    if (n < 0 || static_cast<size_t>(n) != width) return false;
    out->append(buf, width);
    return true;
}

inline bool emit_i(std::string* out, const char* fmt, long v, size_t width) {
    char buf[64];
    const int n = std::snprintf(buf, sizeof(buf), fmt, v);
    if (n < 0 || static_cast<size_t>(n) != width) return false;
    out->append(buf, width);
    return true;
}

/* Left-justified text in a fixed field, blank-padded, truncated if the caller
 * over-fills it — the descriptor fields (data used, agency, ...) are labels,
 * and a label one character too long must not shift the record. */
inline void emit_text(std::string* out, const std::string& s, size_t width) {
    const size_t n = s.size() < width ? s.size() : width;
    out->append(s, 0, n);
    out->append(width - n, ' ');
}

/* Right-justified, for satellite ids: SP3-c/d ids are exactly 3 characters,
 * but an SP3-a numeric id ("1") belongs in cols 3-4 with col 2 blank. */
inline void emit_id(std::string* out, const std::string& s, size_t width) {
    const size_t n = s.size() < width ? s.size() : width;
    out->append(width - n, ' ');
    out->append(s, 0, n);
}

}  // namespace detail

/* ------------------------------------------------------------------------ */
/* Reader                                                                    */
/* ------------------------------------------------------------------------ */

/*
 * Reads a whole SP3 file into one Series per satellite.
 *
 * The header is a state machine keyed on cols 1-2, which is exactly how the
 * spec tells implementers to read it: the counts of the "+ ", "++" and comment lines
 * are all variable in SP3-d, so nothing may be found by line NUMBER.
 *
 * EP and EV correlation records are skipped. The spec explicitly permits that
 * ("these 'EP' and 'EV' records might be simply ignored and skipped over") and
 * the spine has nowhere to put a position/clock correlation; a reader that
 * refused them would reject legal files to no purpose.
 */
inline ephem::Status read(const char* text, size_t len, File* out) {
    using namespace detail;
    if (!text || !out) return ephem::Status::Malformed;
    if (len < 2) return ephem::Status::Truncated;

    *out = File{};

    /* Header order is authoritative for which "++" exponent belongs to which
     * satellite, and it is the order records must appear in at every epoch. */
    std::vector<std::string> header_ids;
    std::vector<long> header_acc;
    long declared_sats = 0;
    bool seen_first_line = false;
    bool seen_time_system = false;
    bool seen_base_line = false;

    int64_t start_ticks = 0;
    bool have_start = false;
    int64_t epoch_ticks = 0;
    bool have_epoch = false;
    size_t epoch_count = 0;

    /* Satellite whose P record was seen most recently, so a following V or a
     * short-record fixup lands on the right row. */
    size_t last_sat = static_cast<size_t>(-1);

    size_t pos = 0;
    while (pos <= len) {
        size_t nl = pos;
        while (nl < len && text[nl] != '\n') ++nl;
        std::string line(text + pos, nl - pos);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        pos = nl + 1;
        if (nl >= len && line.empty()) break;

        if (line.empty()) continue;

        if (!seen_first_line) {
            if (line[0] != '#') return ephem::Status::BadMagic;
            if (line.size() < 3) return ephem::Status::Truncated;
            seen_first_line = true;
            out->version = line[1];
            if (out->version < 'a' || out->version > 'd') return ephem::Status::UnsupportedVariant;
            out->pos_vel_flag = line[2];
            if (out->pos_vel_flag != 'P' && out->pos_vel_flag != 'V') {
                return ephem::Status::Malformed;
            }
            long y = 0, mo = 0, d = 0, h = 0, mi = 0, nep = 0;
            double sec = 0.0;
            bool blank = false;
            if (!parse_int(line, 4, 7, &y, &blank) || !parse_int(line, 9, 10, &mo, &blank) ||
                !parse_int(line, 12, 13, &d, &blank) || !parse_int(line, 15, 16, &h, &blank) ||
                !parse_int(line, 18, 19, &mi, &blank) ||
                !parse_double(line, 21, 31, &sec, &blank)) {
                return ephem::Status::Malformed;
            }
            if (!parse_int(line, 33, 39, &nep, &blank)) return ephem::Status::Malformed;
            if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec < 0.0 ||
                sec >= 61.0) {
                return ephem::Status::Malformed;
            }
            Civil c;
            c.year = y;
            c.month = mo;
            c.day = d;
            c.hour = h;
            c.minute = mi;
            c.sec_ticks = round_ticks(sec);
            start_ticks = ticks_from_civil(c);
            have_start = true;
            out->start_epoch_iso = iso_from_ticks(start_ticks);
            out->declared_num_epochs = static_cast<int>(nep);
            /* Right-trim only. These are A5/A3/A4 descriptor fields and IGS
             * products right-JUSTIFY some of them (agency " IGS" in cols
             * 57-60); trimming both ends would rewrite the file's own label. */
            out->data_used = cols(line, 41, 45);
            out->coordinate_sys = cols(line, 47, 51);
            out->orbit_type = cols(line, 53, 55);
            out->agency = cols(line, 57, 60);
            rtrim_in_place(&out->data_used);
            rtrim_in_place(&out->coordinate_sys);
            rtrim_in_place(&out->orbit_type);
            rtrim_in_place(&out->agency);
            continue;
        }

        if (line.size() >= 2 && line[0] == '#' && line[1] == '#') {
            long week = 0, mjd = 0;
            double sow = 0.0, interval = 0.0, frac = 0.0;
            bool blank = false;
            if (!parse_int(line, 4, 7, &week, &blank) ||
                !parse_double(line, 9, 23, &sow, &blank) ||
                !parse_double(line, 25, 38, &interval, &blank) ||
                !parse_int(line, 40, 44, &mjd, &blank) ||
                !parse_double(line, 46, 60, &frac, &blank)) {
                return ephem::Status::Malformed;
            }
            out->gps_week = static_cast<int>(week);
            out->seconds_of_week = sow;
            out->epoch_interval = interval;
            out->mjd = static_cast<int>(mjd);
            out->fractional_day = frac;
            continue;
        }

        if (line[0] == '+' && line.size() >= 2 && line[1] == ' ') {
            if (header_ids.empty() && declared_sats == 0) {
                long n = 0;
                bool blank = false;
                if (!parse_int(line, 4, 6, &n, &blank)) return ephem::Status::Malformed;
                declared_sats = n;
            }
            for (size_t k = 0; k < kSatsPerLine; ++k) {
                const size_t first = 10 + 3 * k;
                const std::string id = trim(cols(line, first, first + 2));
                /* Zeros pad the last line out to 17 slots; the spec says they
                 * appear only after the real ids, so they end the list. */
                if (id.empty() || id == "0") continue;
                header_ids.push_back(id);
            }
            continue;
        }

        if (line.size() >= 2 && line[0] == '+' && line[1] == '+') {
            for (size_t k = 0; k < kSatsPerLine; ++k) {
                const size_t first = 10 + 3 * k;
                long v = 0;
                bool blank = false;
                if (!parse_int(line, first, first + 2, &v, &blank)) {
                    return ephem::Status::Malformed;
                }
                header_acc.push_back(v);
            }
            continue;
        }

        if (line.size() >= 2 && line[0] == '%' && line[1] == 'c') {
            /* Only the FIRST %c carries the file type and time system; the
             * second is filler, and reading it would overwrite GPS with the
             * literal "ccc". */
            if (!seen_time_system) {
                seen_time_system = true;
                out->file_type = cols(line, 4, 5);
                out->time_system = trim(cols(line, 10, 12));
            }
            continue;
        }

        if (line.size() >= 2 && line[0] == '%' && line[1] == 'f') {
            if (!seen_base_line) {
                seen_base_line = true;
                bool blank = false;
                double a = 0.0, b = 0.0;
                if (!parse_double(line, 4, 13, &a, &blank) ||
                    !parse_double(line, 15, 26, &b, &blank)) {
                    return ephem::Status::Malformed;
                }
                out->base_pos_vel_sigma = a;
                out->base_clk_rate_sigma = b;
            }
            continue;
        }

        if (line.size() >= 2 && line[0] == '%' && line[1] == 'i') continue;

        if (line.size() >= 2 && line[0] == '/' && line[1] == '*') {
            std::string c = cols(line, 4, 80);
            rtrim_in_place(&c);
            out->comments.push_back(c);
            continue;
        }

        if (line[0] == '*') {
            long y = 0, mo = 0, d = 0, h = 0, mi = 0;
            double sec = 0.0;
            bool blank = false;
            if (!parse_int(line, 4, 7, &y, &blank) || !parse_int(line, 9, 10, &mo, &blank) ||
                !parse_int(line, 12, 13, &d, &blank) || !parse_int(line, 15, 16, &h, &blank) ||
                !parse_int(line, 18, 19, &mi, &blank) ||
                !parse_double(line, 21, 31, &sec, &blank)) {
                return ephem::Status::Malformed;
            }
            if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec < 0.0 ||
                sec >= 61.0) {
                return ephem::Status::Malformed;
            }
            Civil c;
            c.year = y;
            c.month = mo;
            c.day = d;
            c.hour = h;
            c.minute = mi;
            c.sec_ticks = round_ticks(sec);
            epoch_ticks = ticks_from_civil(c);
            have_epoch = true;
            ++epoch_count;
            if (!have_start) {
                start_ticks = epoch_ticks;
                have_start = true;
                out->start_epoch_iso = iso_from_ticks(start_ticks);
            }
            last_sat = static_cast<size_t>(-1);
            continue;
        }

        if (line.size() >= 3 && line[0] == 'E' && (line[1] == 'P' || line[1] == 'V')) continue;

        if (line[0] == 'P' || line[0] == 'V') {
            if (!have_epoch) return ephem::Status::Malformed;
            const bool is_vel = line[0] == 'V';
            const std::string id = trim(cols(line, 2, 4));
            if (id.empty()) return ephem::Status::Malformed;

            /* A record must reach at least col 46 to carry three coordinates.
             * Anything shorter is not a short record, it is a truncated one. */
            if (line.size() < 46) return ephem::Status::Truncated;

            double a = 0.0, b = 0.0, c = 0.0, clk = 0.0;
            bool clk_blank = false, blank = false;
            if (!parse_double(line, 5, 18, &a, &blank) ||
                !parse_double(line, 19, 32, &b, &blank) ||
                !parse_double(line, 33, 46, &c, &blank) ||
                !parse_double(line, 47, 60, &clk, &clk_blank)) {
                return ephem::Status::Malformed;
            }

            size_t si = static_cast<size_t>(-1);
            for (size_t i = 0; i < out->satellites.size(); ++i) {
                if (out->satellites[i].sat_id == id) {
                    si = i;
                    break;
                }
            }
            if (si == static_cast<size_t>(-1)) {
                SatelliteBlock blk;
                blk.sat_id = id;
                blk.series.object_id = id;
                blk.series.frame_name = trim(out->coordinate_sys);
                blk.series.time_system = out->time_system;
                /* SP3 positions are geocentric by construction — the format
                 * defines its coordinate-system field as the TERRESTRIAL
                 * reference frame the satellites are given in. This is the
                 * format speaking, not a substituted default. */
                blk.series.center_name = "EARTH";
                blk.series.epoch_zero_iso = out->start_epoch_iso;
                /* SP3 declares no interpolation rule, so none is invented. */
                blk.series.interp = ephem::Interp::Unknown;
                out->satellites.push_back(blk);
                si = out->satellites.size() - 1;
            }
            SatelliteBlock& blk = out->satellites[si];

            const bool clock_absent = clk_blank || clk >= kAbsentClockThreshold;

            if (!is_vel) {
                /* All-zero position is the spec's "bad or absent" marker: the
                 * satellite must still appear at every epoch, so the record
                 * exists to keep the file's integrity check, not to state a
                 * position. Dropping it is what makes the Series honest. */
                if (a == 0.0 && b == 0.0 && c == 0.0) {
                    last_sat = static_cast<size_t>(-1);
                    continue;
                }
                ephem::StateRow row;
                row.epoch = static_cast<double>(epoch_ticks - start_ticks) /
                            static_cast<double>(kTicksPerSecond);
                row.pos[0] = a;
                row.pos[1] = b;
                row.pos[2] = c;
                if (!clock_absent) {
                    row.clock_bias = clk;
                    row.has_clock = true;
                }
                if (!ephem::row_is_finite(row)) return ephem::Status::Malformed;

                RecordFlags fl;
                long v = 0;
                if (!parse_int(line, 62, 63, &v, &blank)) return ephem::Status::Malformed;
                fl.x_sdev = blank ? -1 : static_cast<int16_t>(v);
                if (!parse_int(line, 65, 66, &v, &blank)) return ephem::Status::Malformed;
                fl.y_sdev = blank ? -1 : static_cast<int16_t>(v);
                if (!parse_int(line, 68, 69, &v, &blank)) return ephem::Status::Malformed;
                fl.z_sdev = blank ? -1 : static_cast<int16_t>(v);
                if (!parse_int(line, 71, 73, &v, &blank)) return ephem::Status::Malformed;
                fl.c_sdev = blank ? -1 : static_cast<int16_t>(v);
                fl.clock_event = cols(line, 75, 75) == "E";
                fl.clock_predicted = cols(line, 76, 76) == "P";
                fl.maneuver = cols(line, 79, 79) == "M";
                fl.orbit_predicted = cols(line, 80, 80) == "P";

                blk.series.rows.push_back(row);
                blk.flags.push_back(fl);
                last_sat = si;
                continue;
            }

            /* A V record modifies the P record it follows. If that P was the
             * absent-position sentinel there is no row to attach to, and the
             * velocity is dropped with it rather than inventing a state. */
            if (last_sat != si || blk.series.rows.empty()) continue;
            ephem::StateRow& row = blk.series.rows.back();
            if (a == 0.0 && b == 0.0 && c == 0.0) {
                /* The velocity absent-marker, same shape as position's. */
            } else {
                row.vel[0] = a * kDmPerSecToKmPerSec;
                row.vel[1] = b * kDmPerSecToKmPerSec;
                row.vel[2] = c * kDmPerSecToKmPerSec;
                row.has_vel = true;
            }
            if (!ephem::row_is_finite(row)) return ephem::Status::Malformed;
            if (blk.flags.size() == blk.series.rows.size()) {
                RecordFlags& fl = blk.flags.back();
                if (!clock_absent) {
                    row.clock_rate = clk;
                    fl.has_clock_rate = true;
                }
                long v = 0;
                if (!parse_int(line, 62, 63, &v, &blank)) return ephem::Status::Malformed;
                fl.xv_sdev = blank ? -1 : static_cast<int16_t>(v);
                if (!parse_int(line, 65, 66, &v, &blank)) return ephem::Status::Malformed;
                fl.yv_sdev = blank ? -1 : static_cast<int16_t>(v);
                if (!parse_int(line, 68, 69, &v, &blank)) return ephem::Status::Malformed;
                fl.zv_sdev = blank ? -1 : static_cast<int16_t>(v);
                if (!parse_int(line, 71, 73, &v, &blank)) return ephem::Status::Malformed;
                fl.cr_sdev = blank ? -1 : static_cast<int16_t>(v);
            }
            continue;
        }

        if (line.compare(0, 3, "EOF") == 0) break;
        /* Anything else in the body is a record type this reader does not
         * know. Ignoring it silently would let a corrupt file read clean. */
        return ephem::Status::Malformed;
    }

    if (!seen_first_line) return ephem::Status::BadMagic;
    if (epoch_count == 0) return ephem::Status::Truncated;

    /* The header's satellite list is the authority on order and on the
     * accuracy exponents; satellites that only ever carried absent positions
     * still belong in the file's roster. */
    for (size_t i = 0; i < header_ids.size(); ++i) {
        if (declared_sats > 0 && i >= static_cast<size_t>(declared_sats)) break;
        bool found = false;
        for (const SatelliteBlock& b : out->satellites) {
            if (b.sat_id == header_ids[i]) {
                found = true;
                break;
            }
        }
        if (found) continue;
        SatelliteBlock blk;
        blk.sat_id = header_ids[i];
        blk.series.object_id = header_ids[i];
        blk.series.frame_name = trim(out->coordinate_sys);
        blk.series.time_system = out->time_system;
        blk.series.center_name = "EARTH";
        blk.series.epoch_zero_iso = out->start_epoch_iso;
        out->satellites.push_back(blk);
    }
    /* Restore header order, so a re-written file passes the spec's "the
     * satellite order of the P, EP, V, and EV records must be the same as the
     * order of the satellite ID records" integrity check. */
    if (!header_ids.empty()) {
        std::vector<SatelliteBlock> ordered;
        ordered.reserve(out->satellites.size());
        std::vector<bool> taken(out->satellites.size(), false);
        for (size_t i = 0; i < header_ids.size(); ++i) {
            if (declared_sats > 0 && i >= static_cast<size_t>(declared_sats)) break;
            for (size_t j = 0; j < out->satellites.size(); ++j) {
                if (!taken[j] && out->satellites[j].sat_id == header_ids[i]) {
                    ordered.push_back(out->satellites[j]);
                    taken[j] = true;
                    break;
                }
            }
        }
        for (size_t j = 0; j < out->satellites.size(); ++j) {
            if (!taken[j]) ordered.push_back(out->satellites[j]);
        }
        out->satellites.swap(ordered);
    }
    for (size_t i = 0; i < out->satellites.size() && i < header_acc.size(); ++i) {
        out->satellites[i].accuracy_exponent = static_cast<int>(header_acc[i]);
    }

    return ephem::Status::Ok;
}

/* ------------------------------------------------------------------------ */
/* Writer                                                                    */
/* ------------------------------------------------------------------------ */

namespace detail {

/* One satellite's rows keyed by absolute tick, sorted, so the epoch sweep can
 * walk each satellite with a cursor instead of searching. */
struct SatIndex {
    std::vector<int64_t> ticks;
    std::vector<size_t> row;
    size_t cursor = 0;
};

inline bool emit_epoch_header(std::string* out, int64_t ticks) {
    const Civil c = civil_from_ticks(ticks);
    if (c.year < 0 || c.year > 9999) return false;
    out->append("*  ");
    if (!emit_i(out, "%4ld", static_cast<long>(c.year), 4)) return false;
    out->push_back(' ');
    if (!emit_i(out, "%2ld", static_cast<long>(c.month), 2)) return false;
    out->push_back(' ');
    if (!emit_i(out, "%2ld", static_cast<long>(c.day), 2)) return false;
    out->push_back(' ');
    if (!emit_i(out, "%2ld", static_cast<long>(c.hour), 2)) return false;
    out->push_back(' ');
    if (!emit_i(out, "%2ld", static_cast<long>(c.minute), 2)) return false;
    out->push_back(' ');
    const double sec = static_cast<double>(c.sec_ticks) / static_cast<double>(kTicksPerSecond);
    if (!emit_f(out, "%11.8f", sec, 11)) return false;
    out->push_back('\n');
    return true;
}

/* Cols 61-80 of a P record / 61-73 of a V record. Emitted only when there is
 * something to say, because the spec allows a record to stop at col 60 and a
 * line of trailing blanks is noise a diff will trip over. */
inline void emit_record_tail(std::string* out, const RecordFlags& fl, bool is_vel) {
    const int16_t sx = is_vel ? fl.xv_sdev : fl.x_sdev;
    const int16_t sy = is_vel ? fl.yv_sdev : fl.y_sdev;
    const int16_t sz = is_vel ? fl.zv_sdev : fl.z_sdev;
    const int16_t sc = is_vel ? fl.cr_sdev : fl.c_sdev;
    const bool any_flag =
        !is_vel && (fl.clock_event || fl.clock_predicted || fl.maneuver || fl.orbit_predicted);
    if (sx < 0 && sy < 0 && sz < 0 && sc < 0 && !any_flag) return;

    char buf[8];
    out->push_back(' ');
    if (sx >= 0 && std::snprintf(buf, sizeof(buf), "%2d", static_cast<int>(sx)) == 2) {
        out->append(buf, 2);
    } else {
        out->append(2, ' ');
    }
    out->push_back(' ');
    if (sy >= 0 && std::snprintf(buf, sizeof(buf), "%2d", static_cast<int>(sy)) == 2) {
        out->append(buf, 2);
    } else {
        out->append(2, ' ');
    }
    out->push_back(' ');
    if (sz >= 0 && std::snprintf(buf, sizeof(buf), "%2d", static_cast<int>(sz)) == 2) {
        out->append(buf, 2);
    } else {
        out->append(2, ' ');
    }
    out->push_back(' ');
    if (sc >= 0 && std::snprintf(buf, sizeof(buf), "%3d", static_cast<int>(sc)) == 3) {
        out->append(buf, 3);
    } else {
        out->append(3, ' ');
    }
    if (is_vel) return;
    out->push_back(' ');
    out->push_back(fl.clock_event ? 'E' : ' ');
    out->push_back(fl.clock_predicted ? 'P' : ' ');
    out->append(2, ' ');
    out->push_back(fl.maneuver ? 'M' : ' ');
    out->push_back(fl.orbit_predicted ? 'P' : ' ');
}

}  // namespace detail

/*
 * Serialises a File to SP3-c or SP3-d text.
 *
 * The epoch grid is the sorted union of every satellite's row epochs, and
 * EVERY satellite gets a record at EVERY epoch — that is the spec's integrity
 * check ("the order and the total number of satellites at each epoch must
 * always be the same"), and a satellite with no state at an epoch is written
 * with the all-zero absent marker rather than skipped.
 */
inline ephem::Status write(const File& f, std::string* out) {
    using namespace detail;
    if (!out) return ephem::Status::Malformed;
    out->clear();

    if (f.version != 'c' && f.version != 'd') return ephem::Status::UnsupportedVariant;
    if (f.pos_vel_flag != 'P' && f.pos_vel_flag != 'V') return ephem::Status::Malformed;
    if (f.satellites.empty()) return ephem::Status::NotEnoughStates;
    if (f.file_type.empty()) return ephem::Status::Malformed;
    if (f.time_system.empty()) return ephem::Status::Malformed;

    const size_t max_sats = f.version == 'd' ? kMaxSatsD : kMaxSatsC;
    if (f.satellites.size() > max_sats) return ephem::Status::OutOfRange;

    /* Ranges the spec states outright. A header that violates them is a file
     * whose second line contradicts itself. */
    if (!ephem::is_finite(f.seconds_of_week) || f.seconds_of_week < 0.0 ||
        f.seconds_of_week >= 604800.0) {
        return ephem::Status::OutOfRange;
    }
    if (!ephem::is_finite(f.epoch_interval) || f.epoch_interval <= 0.0 ||
        f.epoch_interval >= 100000.0) {
        return ephem::Status::OutOfRange;
    }
    /* The spec states 0.0 <= fraction < 1.0, but the IAC rapid GLONASS product
     * writes exactly 1.0 for a file starting at the end of the stated MJD day.
     * Refusing that would make this writer unable to re-emit a file that is
     * actually published, so 1.0 is admitted and anything outside [0,1] is
     * not. */
    if (!ephem::is_finite(f.fractional_day) || f.fractional_day < 0.0 ||
        f.fractional_day > 1.0) {
        return ephem::Status::OutOfRange;
    }
    if (f.gps_week < 0 || f.gps_week > 9999 || f.mjd < 0 || f.mjd > 99999) {
        return ephem::Status::OutOfRange;
    }

    /* The file's zero point. Preferring the declared ISO epoch over
     * mjd+fractional_day is deliberate: the F15.13 fraction resolves only to
     * ~0.9 ns, which is coarser than the F11.8 seconds field it would have to
     * reproduce. */
    int64_t start_ticks = 0;
    if (!f.start_epoch_iso.empty()) {
        if (!ticks_from_iso(f.start_epoch_iso, &start_ticks)) return ephem::Status::Malformed;
    } else if (!f.satellites[0].series.epoch_zero_iso.empty()) {
        if (!ticks_from_iso(f.satellites[0].series.epoch_zero_iso, &start_ticks)) {
            return ephem::Status::Malformed;
        }
    } else {
        start_ticks = (static_cast<int64_t>(f.mjd) + kMjdZeroAsDays1970) * kTicksPerDay +
                      round_ticks(f.fractional_day * 86400.0);
    }

    /* Index every satellite's rows on the absolute tick grid. */
    std::vector<SatIndex> index(f.satellites.size());
    std::vector<int64_t> all_ticks;
    for (size_t i = 0; i < f.satellites.size(); ++i) {
        const SatelliteBlock& blk = f.satellites[i];
        int64_t zero = start_ticks;
        if (!blk.series.epoch_zero_iso.empty() &&
            !ticks_from_iso(blk.series.epoch_zero_iso, &zero)) {
            return ephem::Status::Malformed;
        }
        std::vector<std::pair<int64_t, size_t> > pairs;
        pairs.reserve(blk.series.rows.size());
        for (size_t r = 0; r < blk.series.rows.size(); ++r) {
            const ephem::StateRow& row = blk.series.rows[r];
            if (!ephem::row_is_finite(row)) return ephem::Status::Malformed;
            pairs.push_back(std::make_pair(zero + round_ticks(row.epoch), r));
        }
        std::sort(pairs.begin(), pairs.end());
        index[i].ticks.reserve(pairs.size());
        index[i].row.reserve(pairs.size());
        for (size_t k = 0; k < pairs.size(); ++k) {
            index[i].ticks.push_back(pairs[k].first);
            index[i].row.push_back(pairs[k].second);
            all_ticks.push_back(pairs[k].first);
        }
    }
    std::sort(all_ticks.begin(), all_ticks.end());
    all_ticks.erase(std::unique(all_ticks.begin(), all_ticks.end()), all_ticks.end());
    if (all_ticks.empty()) return ephem::Status::NotEnoughStates;
    if (all_ticks.size() > 9999999u) return ephem::Status::OutOfRange;

    const int64_t first_tick = all_ticks.front();

    /* ---- line 1 ---- */
    {
        const Civil c = civil_from_ticks(first_tick);
        if (c.year < 0 || c.year > 9999) return ephem::Status::OutOfRange;
        out->push_back('#');
        out->push_back(f.version);
        out->push_back(f.pos_vel_flag);
        if (!emit_i(out, "%4ld", static_cast<long>(c.year), 4)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_i(out, "%2ld", static_cast<long>(c.month), 2)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_i(out, "%2ld", static_cast<long>(c.day), 2)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_i(out, "%2ld", static_cast<long>(c.hour), 2)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_i(out, "%2ld", static_cast<long>(c.minute), 2)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        const double sec =
            static_cast<double>(c.sec_ticks) / static_cast<double>(kTicksPerSecond);
        if (!emit_f(out, "%11.8f", sec, 11)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_i(out, "%7ld", static_cast<long>(all_ticks.size()), 7)) {
            return ephem::Status::OutOfRange;
        }
        out->push_back(' ');
        emit_text(out, f.data_used, 5);
        out->push_back(' ');
        emit_text(out, f.coordinate_sys, 5);
        out->push_back(' ');
        emit_text(out, f.orbit_type, 3);
        out->push_back(' ');
        emit_text(out, f.agency, 4);
        rtrim_in_place(out);
        out->push_back('\n');
    }

    /* ---- line 2 ---- */
    {
        out->append("## ");
        if (!emit_i(out, "%4d", f.gps_week, 4)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_f(out, "%15.8f", f.seconds_of_week, 15)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_f(out, "%14.8f", f.epoch_interval, 14)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_i(out, "%5d", f.mjd, 5)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_f(out, "%15.13f", f.fractional_day, 15)) return ephem::Status::OutOfRange;
        out->push_back('\n');
    }

    /* ---- "+ " satellite ids / "++" accuracy exponents ------------------- */
    /* THE c->d DIFFERENCE. SP3-c always has exactly five of each because 85
     * satellites fit in five 17-wide lines. SP3-d keeps five as the floor and
     * grows from there. */
    const size_t nsat = f.satellites.size();
    size_t id_lines = (nsat + kSatsPerLine - 1) / kSatsPerLine;
    if (id_lines < kMinIdLines) id_lines = kMinIdLines;
    if (f.version == 'c' && id_lines != kMinIdLines) return ephem::Status::OutOfRange;

    for (size_t l = 0; l < id_lines; ++l) {
        out->append("+ ");
        if (l == 0) {
            out->push_back(' ');
            if (!emit_i(out, "%3ld", static_cast<long>(nsat), 3)) {
                return ephem::Status::OutOfRange;
            }
        } else {
            out->append(4, ' ');
        }
        out->append(3, ' ');
        for (size_t k = 0; k < kSatsPerLine; ++k) {
            const size_t s = l * kSatsPerLine + k;
            if (s < nsat) {
                emit_id(out, f.satellites[s].sat_id, 3);
            } else {
                out->append("  0");
            }
        }
        out->push_back('\n');
    }
    for (size_t l = 0; l < id_lines; ++l) {
        out->append("++");
        out->append(7, ' ');
        for (size_t k = 0; k < kSatsPerLine; ++k) {
            const size_t s = l * kSatsPerLine + k;
            long acc = 0;
            if (s < nsat) acc = f.satellites[s].accuracy_exponent;
            if (acc < 0 || acc > 999) return ephem::Status::OutOfRange;
            if (!emit_i(out, "%3ld", acc, 3)) return ephem::Status::OutOfRange;
        }
        out->push_back('\n');
    }

    /* ---- %c / %f / %i --------------------------------------------------- */
    /* The 'c' and 'ccc...' groups are the spec's own placeholders for fields
     * reserved for future use; real IGS products carry them literally, so
     * emitting them keeps a written file byte-comparable with a published one
     * in the header block. */
    {
        out->append("%c ");
        emit_text(out, f.file_type, 2);
        out->append(" cc ");
        emit_text(out, f.time_system, 3);
        out->append(" ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc\n");
        out->append("%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc\n");

        out->append("%f ");
        if (!emit_f(out, "%10.7f", f.base_pos_vel_sigma, 10)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_f(out, "%12.9f", f.base_clk_rate_sigma, 12)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_f(out, "%14.11f", 0.0, 14)) return ephem::Status::OutOfRange;
        out->push_back(' ');
        if (!emit_f(out, "%18.15f", 0.0, 18)) return ephem::Status::OutOfRange;
        out->push_back('\n');
        out->append("%f  0.0000000  0.000000000  0.00000000000  0.000000000000000\n");

        out->append("%i    0    0    0    0      0      0      0      0         0\n");
        out->append("%i    0    0    0    0      0      0      0      0         0\n");
    }

    /* ---- comments ------------------------------------------------------- */
    {
        const size_t width = f.version == 'd' ? kCommentWidthD : kCommentWidthC;
        size_t n = f.comments.size();
        if (n < kMinComments) n = kMinComments;
        for (size_t i = 0; i < n; ++i) {
            out->append("/* ");
            if (i < f.comments.size()) {
                const std::string& c = f.comments[i];
                out->append(c, 0, c.size() < width ? c.size() : width);
            }
            rtrim_in_place(out);
            out->push_back('\n');
        }
    }

    /* ---- epoch blocks --------------------------------------------------- */
    const bool want_vel = f.pos_vel_flag == 'V';
    for (size_t e = 0; e < all_ticks.size(); ++e) {
        const int64_t t = all_ticks[e];
        if (!emit_epoch_header(out, t)) return ephem::Status::OutOfRange;

        for (size_t i = 0; i < nsat; ++i) {
            const SatelliteBlock& blk = f.satellites[i];
            SatIndex& idx = index[i];
            while (idx.cursor < idx.ticks.size() && idx.ticks[idx.cursor] < t) ++idx.cursor;
            const bool present = idx.cursor < idx.ticks.size() && idx.ticks[idx.cursor] == t;
            const ephem::StateRow* row =
                present ? &blk.series.rows[idx.row[idx.cursor]] : nullptr;
            const RecordFlags* fl = nullptr;
            if (present && blk.flags.size() == blk.series.rows.size()) {
                fl = &blk.flags[idx.row[idx.cursor]];
            }
            static const RecordFlags kNoFlags;
            if (!fl) fl = &kNoFlags;

            out->push_back('P');
            emit_id(out, blk.sat_id, 3);
            for (int c = 0; c < 3; ++c) {
                const double v = row ? row->pos[c] : 0.0;
                if (!emit_f(out, "%14.6f", v, 14)) return ephem::Status::OutOfRange;
            }
            const bool has_clk = row && row->has_clock;
            if (!emit_f(out, "%14.6f", has_clk ? row->clock_bias : kAbsentClock, 14)) {
                return ephem::Status::OutOfRange;
            }
            emit_record_tail(out, *fl, false);
            rtrim_in_place(out);
            out->push_back('\n');

            if (!want_vel) continue;

            out->push_back('V');
            emit_id(out, blk.sat_id, 3);
            const bool has_vel = row && row->has_vel;
            for (int c = 0; c < 3; ++c) {
                /* km/s -> dm/s. See the P/V note at the top of this file. */
                const double v = has_vel ? row->vel[c] * kKmPerSecToDmPerSec : 0.0;
                if (!emit_f(out, "%14.6f", v, 14)) return ephem::Status::OutOfRange;
            }
            const bool has_rate = row && fl->has_clock_rate;
            if (!emit_f(out, "%14.6f", has_rate ? row->clock_rate : kAbsentClock, 14)) {
                return ephem::Status::OutOfRange;
            }
            emit_record_tail(out, *fl, true);
            rtrim_in_place(out);
            out->push_back('\n');
        }
    }

    out->append("EOF\n");
    return ephem::Status::Ok;
}

}  // namespace sp3

#endif  // ORBIT_PRODUCTS_SP3_HPP
