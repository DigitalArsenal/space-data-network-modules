/*
 * files/orbit-products — STK ephemeris (.e) and attitude (.a), reader and writer.
 *
 * AUTHORITY. Two independent implementations pin the dialect this reader
 * accepts: Orekit 13.1's org.orekit.files.stk.STKEphemerisFileParser (Apache-2.0)
 * and GMAT R2026a's src/gmatutil/util/STKEphemerisFile.cpp (Apache-2.0). Where
 * they agree — the keyword set, the block keywords, and above all the DEFAULT
 * DISTANCE UNIT — this header follows them, and the acceptance diffs this
 * reader against Orekit's parse of the same published file. fixtures/PROVENANCE.md
 * records the exact sources.
 *
 * METRES ARE THE DEFAULT, AND THAT IS THE TRAP. An .e file with no DistanceUnit
 * line is in METRES, not kilometres — Orekit and GMAT both default that way, and
 * every published STK example we could find omits the line. A reader that
 * assumes kilometres reads a LEO ephemeris as a heliocentric one and every
 * downstream number is wrong by a factor of a thousand while still looking like
 * an orbit. The spine is kilometres, so metres are divided here, on the way in,
 * once.
 *
 * TIME. The rows are seconds from the file's own ScenarioEpoch and stay that
 * way; the epoch itself is carried as its calendar instant in the scale the
 * file declares (UTC unless a TimeFormat line says otherwise, which is what
 * both authorities assume). No leap second is consulted, so a round trip
 * through this header cannot move an epoch.
 *
 * WHAT THIS READER REFUSES RATHER THAN DROPS. An LLA block is latitude,
 * longitude and altitude — not a Cartesian state, and treating its degrees as
 * kilometres would produce a plausible-looking series that is nonsense. A
 * Covariance block is real data the spine has nowhere to put. Both come back as
 * UnsupportedVariant. What this reader DOES drop, and cannot help dropping, is
 * a SegmentBoundaryTimes block: the spine carries no segmentation, so a file
 * with impulsive-manoeuvre boundaries reads correctly but writes back without
 * them.
 */

#ifndef ORBIT_PRODUCTS_STK_EPHEMERIS_HPP
#define ORBIT_PRODUCTS_STK_EPHEMERIS_HPP

#include "ephemeris_series.hpp"

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace stk_ephem {

/* ------------------------------------------------------------------------ */
/* Text scanning                                                             */
/* ------------------------------------------------------------------------ */

namespace detail {

inline bool is_space(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }

inline std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_space(s[b])) ++b;
    while (e > b && is_space(s[e - 1])) --e;
    return s.substr(b, e - b);
}

/* Splits on runs of whitespace. STK writes keyword and value separated by tabs
 * in some versions and spaces in others; treating them alike is the difference
 * between reading a real file and reading only the ones we wrote. */
inline void split(const std::string& line, std::vector<std::string>* out) {
    out->clear();
    size_t i = 0;
    while (i < line.size()) {
        while (i < line.size() && is_space(line[i])) ++i;
        size_t b = i;
        while (i < line.size() && !is_space(line[i])) ++i;
        if (i > b) out->push_back(line.substr(b, i - b));
    }
}

/* A line that opens with a sign, digit or point is data. Nothing else in either
 * format starts that way, so this distinguishes a row from a keyword without a
 * mode flag that could get out of step with the file. */
inline bool looks_numeric(const std::string& s) {
    const std::string t = trim(s);
    if (t.empty()) return false;
    const char c = t[0];
    return (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.';
}

inline bool parse_double(const std::string& token, double* out) {
    const char* p = token.c_str();
    char* end = nullptr;
    const double v = std::strtod(p, &end);
    if (end == p || *end != '\0') return false;
    if (!ephem::is_finite(v)) return false;
    *out = v;
    return true;
}

inline bool parse_int(const std::string& token, long* out) {
    const char* p = token.c_str();
    char* end = nullptr;
    const long v = std::strtol(p, &end, 10);
    if (end == p || *end != '\0') return false;
    *out = v;
    return true;
}

inline bool equals_ignore_case(const std::string& a, const char* b) {
    size_t i = 0;
    for (; i < a.size() && b[i]; ++i) {
        char x = a[i], y = b[i];
        if (x >= 'A' && x <= 'Z') x = static_cast<char>(x - 'A' + 'a');
        if (y >= 'A' && y <= 'Z') y = static_cast<char>(y - 'A' + 'a');
        if (x != y) return false;
    }
    return i == a.size() && b[i] == '\0';
}

static const char* const kMonthNames[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

inline int month_from_name(const std::string& s) {
    for (int i = 0; i < 12; ++i) {
        if (equals_ignore_case(s, kMonthNames[i])) return i + 1;
    }
    return 0;
}

inline int64_t days_from_civil(int y, int m, int d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const int64_t yoe = y - era * 400;
    const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

/* A ScenarioEpoch split into its parts. `fraction` keeps the seconds' decimal
 * digits AS WRITTEN, because reproducing ".000883" rather than ".00088300000"
 * is what makes the round trip a string identity rather than an approximation
 * that happens to be close. */
struct EpochParts {
    int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
    std::string fraction; /* digits after the decimal point, no '.' */
    bool valid = false;
};

inline bool parse_hms(const std::string& s, EpochParts* p) {
    /* HH:MM:SS[.fff] */
    long h = 0, mi = 0, sec = 0;
    size_t c1 = s.find(':');
    if (c1 == std::string::npos) return false;
    size_t c2 = s.find(':', c1 + 1);
    if (c2 == std::string::npos) return false;
    if (!parse_int(s.substr(0, c1), &h)) return false;
    if (!parse_int(s.substr(c1 + 1, c2 - c1 - 1), &mi)) return false;
    const std::string secs = s.substr(c2 + 1);
    const size_t dot = secs.find('.');
    if (dot == std::string::npos) {
        if (!parse_int(secs, &sec)) return false;
        p->fraction.clear();
    } else {
        if (!parse_int(secs.substr(0, dot), &sec)) return false;
        p->fraction = secs.substr(dot + 1);
        for (size_t i = 0; i < p->fraction.size(); ++i) {
            if (p->fraction[i] < '0' || p->fraction[i] > '9') return false;
        }
    }
    p->hour = static_cast<int>(h);
    p->minute = static_cast<int>(mi);
    p->second = static_cast<int>(sec);
    return true;
}

/* Accepts STK's own "12 Jan 2007 00:00:00.000883" and an ISO-8601 instant, and
 * says so rather than guessing: a caller handed anything else keeps the string
 * verbatim, which round-trips even though we cannot date-arithmetic on it. */
inline EpochParts parse_epoch(const std::string& text) {
    EpochParts p;
    std::vector<std::string> tokens;
    split(text, &tokens);
    if (tokens.size() >= 4) {
        long day = 0, year = 0;
        const int month = month_from_name(tokens[1]);
        if (month && parse_int(tokens[0], &day) && parse_int(tokens[2], &year) &&
            parse_hms(tokens[3], &p)) {
            p.year = static_cast<int>(year);
            p.month = month;
            p.day = static_cast<int>(day);
            p.valid = true;
            return p;
        }
    }
    const std::string t = trim(text);
    const size_t tpos = t.find('T');
    if (tpos == 10 && t.size() > 11) {
        long y = 0, mo = 0, d = 0;
        if (parse_int(t.substr(0, 4), &y) && parse_int(t.substr(5, 2), &mo) &&
            parse_int(t.substr(8, 2), &d) && t[4] == '-' && t[7] == '-') {
            std::string time = t.substr(tpos + 1);
            if (!time.empty() && (time[time.size() - 1] == 'Z')) time.erase(time.size() - 1);
            if (parse_hms(time, &p)) {
                p.year = static_cast<int>(y);
                p.month = static_cast<int>(mo);
                p.day = static_cast<int>(d);
                p.valid = true;
                return p;
            }
        }
    }
    return p;
}

inline std::string to_iso(const EpochParts& p) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d", p.year, p.month, p.day,
                  p.hour, p.minute, p.second);
    std::string out(buf);
    if (!p.fraction.empty()) {
        out += '.';
        out += p.fraction;
    }
    return out;
}

inline std::string to_stk_epoch(const EpochParts& p) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%d %s %04d %02d:%02d:%02d", p.day, kMonthNames[p.month - 1],
                  p.year, p.hour, p.minute, p.second);
    std::string out(buf);
    if (!p.fraction.empty()) {
        out += '.';
        out += p.fraction;
    }
    return out;
}

static constexpr int64_t kDaysToJ2000 = 10957; /* 1970-01-01 to 2000-01-01 */

inline double seconds_past_j2000(const EpochParts& p) {
    double frac = 0.0;
    if (!p.fraction.empty()) {
        const std::string text = "0." + p.fraction;
        parse_double(text, &frac);
    }
    return static_cast<double>(days_from_civil(p.year, p.month, p.day) - kDaysToJ2000) * 86400.0 -
           43200.0 + p.hour * 3600.0 + p.minute * 60.0 + p.second + frac;
}

/* Splits a buffer into lines, tolerating CRLF and a missing final newline. */
inline void lines_of(const char* text, size_t len, std::vector<std::string>* out) {
    out->clear();
    size_t b = 0;
    for (size_t i = 0; i <= len; ++i) {
        if (i == len || text[i] == '\n') {
            size_t e = i;
            if (e > b && text[e - 1] == '\r') --e;
            out->push_back(std::string(text + b, e - b));
            b = i + 1;
        }
    }
    if (!out->empty() && out->back().empty() && len > 0 && text[len - 1] == '\n') {
        out->pop_back();
    }
}

}  // namespace detail

/* ------------------------------------------------------------------------ */
/* Ephemeris (.e)                                                            */
/* ------------------------------------------------------------------------ */

/*
 * Reads an STK .e file into the spine.
 *
 * `out->epoch_zero_iso` is the ScenarioEpoch and `out->rows[i].epoch` is
 * seconds from it, exactly as the file tabulates — the file's own clock, not a
 * re-based one.
 */
inline ephem::Status read(const char* text, size_t len, ephem::Series* out) {
    if (!text || !out) return ephem::Status::Malformed;

    std::vector<std::string> lines;
    detail::lines_of(text, len, &lines);

    *out = ephem::Series{};

    enum class Block { None, TimePos, TimePosVel, TimePosVelAcc, SegmentBoundaries };
    Block block = Block::None;
    bool saw_version = false;
    bool saw_begin = false;
    /* Metres until a DistanceUnit line says otherwise. See the file comment:
     * this default is the format's, confirmed against Orekit and GMAT, and
     * getting it wrong is a silent factor of 1000. */
    double to_km = 1.0 / 1000.0;
    long declared_points = -1;
    std::vector<std::string> tokens;

    for (size_t li = 0; li < lines.size(); ++li) {
        const std::string line = detail::trim(lines[li]);
        if (line.empty() || line[0] == '#') continue;

        if (!saw_version) {
            /* The banner is the only magic this format has. */
            if (line.size() < 6 || line.compare(0, 6, "stk.v.") != 0) {
                return ephem::Status::BadMagic;
            }
            /* The banner version is not carried on the Series — the spine has
             * no field for it, and inventing one for a single container would
             * be worse than the omission. A writer that must reproduce it takes
             * it in WriteOptions::version. */
            saw_version = true;
            continue;
        }

        if (detail::looks_numeric(line)) {
            if (block == Block::SegmentBoundaries) continue;
            if (block == Block::None) return ephem::Status::Malformed;

            detail::split(line, &tokens);
            const size_t want = block == Block::TimePos          ? 4
                                : block == Block::TimePosVel     ? 7
                                                                 : 10;
            if (tokens.size() != want) return ephem::Status::Malformed;

            double v[10];
            for (size_t i = 0; i < want; ++i) {
                if (!detail::parse_double(tokens[i], &v[i])) return ephem::Status::Malformed;
            }
            ephem::StateRow row;
            row.epoch = v[0];
            for (int c = 0; c < 3; ++c) row.pos[c] = v[1 + c] * to_km;
            if (block != Block::TimePos) {
                for (int c = 0; c < 3; ++c) row.vel[c] = v[4 + c] * to_km;
                row.has_vel = true;
            }
            if (block == Block::TimePosVelAcc) {
                for (int c = 0; c < 3; ++c) row.acc[c] = v[7 + c] * to_km;
                row.has_acc = true;
            }
            out->rows.push_back(row);
            continue;
        }

        detail::split(line, &tokens);
        if (tokens.empty()) continue;
        const std::string& key = tokens[0];

        if (detail::equals_ignore_case(key, "BEGIN")) {
            if (tokens.size() >= 2 && detail::equals_ignore_case(tokens[1], "Ephemeris")) {
                saw_begin = true;
            } else if (tokens.size() >= 2 &&
                       detail::equals_ignore_case(tokens[1], "SegmentBoundaryTimes")) {
                block = Block::SegmentBoundaries;
            }
            continue;
        }
        if (detail::equals_ignore_case(key, "END")) {
            if (tokens.size() >= 2 &&
                detail::equals_ignore_case(tokens[1], "SegmentBoundaryTimes")) {
                block = Block::None;
                continue;
            }
            if (tokens.size() >= 2 && detail::equals_ignore_case(tokens[1], "Ephemeris")) break;
            continue;
        }

        if (detail::equals_ignore_case(key, "ScenarioEpoch")) {
            const std::string value = detail::trim(line.substr(key.size()));
            const detail::EpochParts parts = detail::parse_epoch(value);
            out->epoch_zero_iso = parts.valid ? detail::to_iso(parts) : value;
            if (parts.valid) out->epoch_zero_offset_sec = detail::seconds_past_j2000(parts);
            continue;
        }
        if (detail::equals_ignore_case(key, "CentralBody")) {
            if (tokens.size() >= 2) out->center_name = tokens[1];
            continue;
        }
        if (detail::equals_ignore_case(key, "CoordinateSystem")) {
            if (tokens.size() >= 2) out->frame_name = tokens[1];
            continue;
        }
        if (detail::equals_ignore_case(key, "TimeFormat")) {
            /* The .e ScenarioEpoch is UTC Gregorian unless the file says
             * otherwise; both authorities parse it that way. Anything else is
             * carried verbatim rather than mapped. */
            if (tokens.size() >= 2) {
                out->time_system =
                    detail::equals_ignore_case(tokens[1], "UTCG") ? "UTC" : tokens[1];
            }
            continue;
        }
        if (detail::equals_ignore_case(key, "DistanceUnit")) {
            if (tokens.size() < 2) return ephem::Status::Malformed;
            if (detail::equals_ignore_case(tokens[1], "Meters")) {
                to_km = 1.0 / 1000.0;
            } else if (detail::equals_ignore_case(tokens[1], "Kilometers")) {
                to_km = 1.0;
            } else {
                /* Feet, nautical miles and the rest are real STK units. We do
                 * not carry their conversion factors, and inventing one is how
                 * a wrong ephemeris gets published. */
                return ephem::Status::UnsupportedVariant;
            }
            continue;
        }
        if (detail::equals_ignore_case(key, "InterpolationMethod")) {
            if (tokens.size() >= 2) {
                if (detail::equals_ignore_case(tokens[1], "Lagrange")) {
                    out->interp = ephem::Interp::Lagrange;
                } else if (detail::equals_ignore_case(tokens[1], "Hermite")) {
                    out->interp = ephem::Interp::Hermite;
                } else if (detail::equals_ignore_case(tokens[1], "Linear")) {
                    out->interp = ephem::Interp::Linear;
                } else {
                    return ephem::Status::UnsupportedVariant;
                }
            }
            continue;
        }
        if (detail::equals_ignore_case(key, "InterpolationSamplesM1") ||
            detail::equals_ignore_case(key, "InterpolationOrder")) {
            long v = 0;
            if (tokens.size() >= 2 && detail::parse_int(tokens[1], &v)) {
                out->interp_degree = static_cast<int>(v);
            }
            continue;
        }
        if (detail::equals_ignore_case(key, "NumberOfEphemerisPoints")) {
            long v = 0;
            if (tokens.size() >= 2 && detail::parse_int(tokens[1], &v)) declared_points = v;
            continue;
        }
        if (detail::equals_ignore_case(key, "EphemerisTimePos")) {
            block = Block::TimePos;
            continue;
        }
        if (detail::equals_ignore_case(key, "EphemerisTimePosVel") ||
            detail::equals_ignore_case(key, "EphemerisEciTimePosVel")) {
            block = Block::TimePosVel;
            continue;
        }
        if (detail::equals_ignore_case(key, "EphemerisTimePosVelAcc")) {
            block = Block::TimePosVelAcc;
            continue;
        }
        /* A block keyword we recognise as real but cannot represent. Falling
         * through to "ignore" would leave the following numeric lines to be
         * parsed under whatever block was last set — silently mixing latitudes
         * into a Cartesian series. */
        if (key.size() > 9 && key.compare(0, 9, "Ephemeris") == 0) {
            return ephem::Status::UnsupportedVariant;
        }
        if (key.size() >= 10 && key.compare(0, 10, "Covariance") == 0) {
            return ephem::Status::UnsupportedVariant;
        }
        /* Any other keyword is metadata this reader does not model. It is
         * ignored rather than refused, because refusing on an unknown
         * annotation would make every future STK version unreadable. */
    }

    if (!saw_version) return ephem::Status::BadMagic;
    if (!saw_begin) return ephem::Status::Malformed;
    if (out->rows.empty()) return ephem::Status::NotEnoughStates;
    /* The count is a declared structural fact, not a hint: a mismatch means the
     * file was truncated or concatenated, and both produce a series that looks
     * fine and is missing states. */
    if (declared_points >= 0 && static_cast<size_t>(declared_points) != out->rows.size()) {
        return ephem::Status::Truncated;
    }
    if (out->time_system.empty()) out->time_system = "UTC";
    return ephem::Status::Ok;
}

/*
 * `version`, `central_body` and the rest are NOT in the four fields the spec
 * sketched, and they have to be: the acceptance requires every keyword to
 * survive a round trip, and a writer that cannot reproduce the banner or the
 * central body cannot do that. Empty means "take it from the series", not
 * "substitute a default".
 */
struct WriteOptions {
    bool meters = false;
    /* SIGNIFICANT digits per value. 17 makes every double round-trip exactly;
     * 16 is the default because that is what STK itself prints. */
    int precision = 16;
    std::string interpolation_method;
    int interpolation_samples_m1 = 0;

    std::string version;      /* banner line; empty writes stk.v.11.0 */
    std::string written_by;   /* the "# WrittenBy" annotation; empty omits it */
};

inline ephem::Status write(const ephem::Series& s, const WriteOptions& opt, std::string* out) {
    if (!out) return ephem::Status::Malformed;
    if (s.rows.empty()) return ephem::Status::NotEnoughStates;

    const double from_km = opt.meters ? 1000.0 : 1.0;
    int digits = opt.precision;
    if (digits < 1) digits = 1;
    if (digits > 17) digits = 17;

    /* All rows must agree on which columns exist: a file cannot have velocity
     * on some lines and not others, and emitting zeros for the rest would put
     * numbers in the file that the series never held. */
    bool all_vel = true, all_acc = true;
    for (size_t i = 0; i < s.rows.size(); ++i) {
        if (!s.rows[i].has_vel) all_vel = false;
        if (!s.rows[i].has_acc) all_acc = false;
        if (!ephem::row_is_finite(s.rows[i])) return ephem::Status::Malformed;
    }
    const int columns = all_acc && all_vel ? 3 : (all_vel ? 2 : 1);

    std::string text;
    text.reserve(s.rows.size() * 200 + 512);
    text += opt.version.empty() ? "stk.v.11.0" : opt.version;
    text += "\n\n";
    if (!opt.written_by.empty()) {
        text += "# WrittenBy    ";
        text += opt.written_by;
        text += "\n\n";
    }
    text += "BEGIN Ephemeris\n\n";

    char buf[64];
    std::snprintf(buf, sizeof(buf), "%zu", s.rows.size());
    text += "NumberOfEphemerisPoints ";
    text += buf;
    text += "\n";

    if (!s.epoch_zero_iso.empty()) {
        const detail::EpochParts parts = detail::parse_epoch(s.epoch_zero_iso);
        text += "ScenarioEpoch           ";
        text += parts.valid ? detail::to_stk_epoch(parts) : s.epoch_zero_iso;
        text += "\n";
    }

    const std::string method = !opt.interpolation_method.empty()
                                   ? opt.interpolation_method
                                   : (s.interp == ephem::Interp::Unknown
                                          ? std::string()
                                          : std::string(ephem::interp_name(s.interp)));
    if (!method.empty()) {
        text += "InterpolationMethod     ";
        text += method;
        text += "\n";
        const int m1 = opt.interpolation_samples_m1 > 0 ? opt.interpolation_samples_m1
                                                        : s.interp_degree;
        if (m1 > 0) {
            std::snprintf(buf, sizeof(buf), "%d", m1);
            text += "InterpolationSamplesM1  ";
            text += buf;
            text += "\n";
        }
    }
    if (!s.center_name.empty()) {
        text += "CentralBody             ";
        text += s.center_name;
        text += "\n";
    }
    if (!s.frame_name.empty()) {
        text += "CoordinateSystem        ";
        text += s.frame_name;
        text += "\n";
    }
    /* Always stated, never inferred: an omitted DistanceUnit means metres, so a
     * kilometre file that leaves the line out is a file that reads back a
     * thousand times too small. */
    text += "DistanceUnit            ";
    text += opt.meters ? "Meters" : "Kilometers";
    text += "\n\n";

    text += columns == 3   ? "EphemerisTimePosVelAcc"
            : columns == 2 ? "EphemerisTimePosVel"
                           : "EphemerisTimePos";
    text += "\n\n";

    char fmt[16];
    std::snprintf(fmt, sizeof(fmt), "%%.%de", digits - 1);
    for (size_t i = 0; i < s.rows.size(); ++i) {
        const ephem::StateRow& r = s.rows[i];
        double values[10];
        size_t n = 1;
        values[0] = r.epoch;
        for (int c = 0; c < 3; ++c) values[n++] = r.pos[c] * from_km;
        if (columns >= 2) {
            for (int c = 0; c < 3; ++c) values[n++] = r.vel[c] * from_km;
        }
        if (columns == 3) {
            for (int c = 0; c < 3; ++c) values[n++] = r.acc[c] * from_km;
        }
        for (size_t k = 0; k < n; ++k) {
            std::snprintf(buf, sizeof(buf), fmt, values[k]);
            if (k) text += ' ';
            text += buf;
        }
        text += '\n';
    }

    text += "\nEND Ephemeris\n";
    *out = text;
    return ephem::Status::Ok;
}

/* ------------------------------------------------------------------------ */
/* Attitude (.a)                                                             */
/* ------------------------------------------------------------------------ */

/*
 * An attitude row is a time and up to eight components, which covers every
 * quaternion, Euler-angle, YPR and angular-velocity block STK defines. It does
 * NOT cover the direction-cosine-matrix blocks (nine and twelve components);
 * those are refused by name rather than truncated, because a nine-element DCM
 * silently stored as eight is a rotation that is not a rotation.
 *
 * This is deliberately not a rotation type. Projecting these into a CCSDS AEM
 * record is a separate job with its own frame and sequence conventions; what
 * this header owns is READ/WRITE FIDELITY, so the components stay in the file's
 * own order and units.
 */
struct AttitudeRow {
    double epoch = 0.0; /* seconds from the file's ScenarioEpoch */
    double c[8] = {0, 0, 0, 0, 0, 0, 0, 0};
    int n = 0;
};

struct Attitude {
    std::string version; /* the "stk.v.<x>" banner, verbatim */
    std::string epoch_zero_iso;
    std::string coordinate_axes; /* may be several tokens: "Custom MyAxes" */
    std::string type;            /* the data-block keyword, verbatim */
    std::string sequence;
    std::string central_body;
    std::string interpolation_method;
    int interpolation_order = 0;
    int blocking_factor = 0;
    std::vector<AttitudeRow> rows;
};

namespace detail {

/* Component count per data-block keyword. Zero marks a block that exists in the
 * format and does not fit in eight components; it is refused, not adapted. */
inline int attitude_components(const std::string& keyword) {
    if (equals_ignore_case(keyword, "AttitudeTimeQuaternions")) return 4;
    if (equals_ignore_case(keyword, "AttitudeTimeQuatScalarFirst")) return 4;
    if (equals_ignore_case(keyword, "AttitudeTimeQuatAngVels")) return 7;
    if (equals_ignore_case(keyword, "AttitudeTimeAngVels")) return 3;
    if (equals_ignore_case(keyword, "AttitudeTimeEulerAngles")) return 3;
    if (equals_ignore_case(keyword, "AttitudeTimeEulerAngleRates")) return 3;
    if (equals_ignore_case(keyword, "AttitudeTimeEulerAnglesAndRates")) return 6;
    if (equals_ignore_case(keyword, "AttitudeTimeYPRAngles")) return 3;
    if (equals_ignore_case(keyword, "AttitudeTimeYPRAnglesAndRates")) return 6;
    if (equals_ignore_case(keyword, "AttitudeTimeDCM")) return 0;
    if (equals_ignore_case(keyword, "AttitudeTimeDCMAngVels")) return 0;
    return -1;
}

}  // namespace detail

inline ephem::Status read_attitude(const char* text, size_t len, Attitude* out) {
    if (!text || !out) return ephem::Status::Malformed;

    std::vector<std::string> lines;
    detail::lines_of(text, len, &lines);

    *out = Attitude{};
    bool saw_version = false;
    bool saw_begin = false;
    int components = -1;
    long declared_points = -1;
    std::vector<std::string> tokens;

    for (size_t li = 0; li < lines.size(); ++li) {
        const std::string line = detail::trim(lines[li]);
        if (line.empty() || line[0] == '#') continue;

        if (!saw_version) {
            if (line.size() < 6 || line.compare(0, 6, "stk.v.") != 0) {
                return ephem::Status::BadMagic;
            }
            out->version = line;
            saw_version = true;
            continue;
        }

        if (detail::looks_numeric(line)) {
            if (components <= 0) return ephem::Status::Malformed;
            detail::split(line, &tokens);
            if (tokens.size() != static_cast<size_t>(components) + 1) {
                return ephem::Status::Malformed;
            }
            AttitudeRow row;
            row.n = components;
            if (!detail::parse_double(tokens[0], &row.epoch)) return ephem::Status::Malformed;
            for (int i = 0; i < components; ++i) {
                if (!detail::parse_double(tokens[i + 1], &row.c[i])) {
                    return ephem::Status::Malformed;
                }
            }
            out->rows.push_back(row);
            continue;
        }

        detail::split(line, &tokens);
        if (tokens.empty()) continue;
        const std::string& key = tokens[0];

        if (detail::equals_ignore_case(key, "BEGIN")) {
            if (tokens.size() >= 2 && detail::equals_ignore_case(tokens[1], "Attitude")) {
                saw_begin = true;
            }
            continue;
        }
        if (detail::equals_ignore_case(key, "END")) break;

        if (detail::equals_ignore_case(key, "ScenarioEpoch")) {
            const std::string value = detail::trim(line.substr(key.size()));
            const detail::EpochParts parts = detail::parse_epoch(value);
            out->epoch_zero_iso = parts.valid ? detail::to_iso(parts) : value;
            continue;
        }
        if (detail::equals_ignore_case(key, "CoordinateAxes")) {
            out->coordinate_axes = detail::trim(line.substr(key.size()));
            continue;
        }
        if (detail::equals_ignore_case(key, "Sequence")) {
            if (tokens.size() >= 2) out->sequence = tokens[1];
            continue;
        }
        if (detail::equals_ignore_case(key, "CentralBody")) {
            if (tokens.size() >= 2) out->central_body = tokens[1];
            continue;
        }
        if (detail::equals_ignore_case(key, "InterpolationMethod")) {
            if (tokens.size() >= 2) out->interpolation_method = tokens[1];
            continue;
        }
        if (detail::equals_ignore_case(key, "InterpolationOrder")) {
            long v = 0;
            if (tokens.size() >= 2 && detail::parse_int(tokens[1], &v)) {
                out->interpolation_order = static_cast<int>(v);
            }
            continue;
        }
        if (detail::equals_ignore_case(key, "BlockingFactor")) {
            long v = 0;
            if (tokens.size() >= 2 && detail::parse_int(tokens[1], &v)) {
                out->blocking_factor = static_cast<int>(v);
            }
            continue;
        }
        if (detail::equals_ignore_case(key, "NumberOfAttitudePoints")) {
            long v = 0;
            if (tokens.size() >= 2 && detail::parse_int(tokens[1], &v)) declared_points = v;
            continue;
        }

        const int n = detail::attitude_components(key);
        if (n > 0) {
            out->type = key;
            components = n;
            continue;
        }
        if (n == 0) return ephem::Status::UnsupportedVariant;
        /* Unknown keyword: metadata this reader does not model. */
    }

    if (!saw_version) return ephem::Status::BadMagic;
    if (!saw_begin) return ephem::Status::Malformed;
    if (out->rows.empty()) return ephem::Status::NotEnoughStates;
    if (declared_points >= 0 && static_cast<size_t>(declared_points) != out->rows.size()) {
        return ephem::Status::Truncated;
    }
    return ephem::Status::Ok;
}

inline ephem::Status write_attitude(const Attitude& a, std::string* out) {
    if (!out) return ephem::Status::Malformed;
    if (a.rows.empty()) return ephem::Status::NotEnoughStates;
    const int n = detail::attitude_components(a.type);
    if (n <= 0) return ephem::Status::UnsupportedVariant;
    for (size_t i = 0; i < a.rows.size(); ++i) {
        if (a.rows[i].n != n) return ephem::Status::Malformed;
        if (!ephem::is_finite(a.rows[i].epoch)) return ephem::Status::Malformed;
        for (int k = 0; k < n; ++k) {
            if (!ephem::is_finite(a.rows[i].c[k])) return ephem::Status::Malformed;
        }
    }

    std::string text;
    text += a.version.empty() ? "stk.v.11.0" : a.version;
    text += "\n\nBEGIN Attitude\n\n";

    char buf[64];
    std::snprintf(buf, sizeof(buf), "%zu", a.rows.size());
    text += "NumberOfAttitudePoints  ";
    text += buf;
    text += "\n";
    if (a.blocking_factor > 0) {
        std::snprintf(buf, sizeof(buf), "%d", a.blocking_factor);
        text += "BlockingFactor          ";
        text += buf;
        text += "\n";
    }
    if (!a.interpolation_method.empty()) {
        text += "InterpolationMethod     ";
        text += a.interpolation_method;
        text += "\n";
    }
    if (a.interpolation_order > 0) {
        std::snprintf(buf, sizeof(buf), "%d", a.interpolation_order);
        text += "InterpolationOrder      ";
        text += buf;
        text += "\n";
    }
    if (!a.central_body.empty()) {
        text += "CentralBody             ";
        text += a.central_body;
        text += "\n";
    }
    if (!a.epoch_zero_iso.empty()) {
        const detail::EpochParts parts = detail::parse_epoch(a.epoch_zero_iso);
        text += "ScenarioEpoch           ";
        text += parts.valid ? detail::to_stk_epoch(parts) : a.epoch_zero_iso;
        text += "\n";
    }
    if (!a.coordinate_axes.empty()) {
        text += "CoordinateAxes          ";
        text += a.coordinate_axes;
        text += "\n";
    }
    if (!a.sequence.empty()) {
        text += "Sequence                ";
        text += a.sequence;
        text += "\n";
    }
    text += "\n";
    text += a.type;
    text += "\n\n";

    /* 17 significant digits, unconditionally: an attitude component is a
     * direction cosine and the acceptance holds it to 1e-12, so there is no
     * version of this file worth writing with digits missing. */
    for (size_t i = 0; i < a.rows.size(); ++i) {
        std::snprintf(buf, sizeof(buf), "%.16e", a.rows[i].epoch);
        text += buf;
        for (int k = 0; k < n; ++k) {
            std::snprintf(buf, sizeof(buf), "%.16e", a.rows[i].c[k]);
            text += ' ';
            text += buf;
        }
        text += '\n';
    }

    text += "\nEND Attitude\n";
    *out = text;
    return ephem::Status::Ok;
}

}  // namespace stk_ephem

#endif  // ORBIT_PRODUCTS_STK_EPHEMERIS_HPP
