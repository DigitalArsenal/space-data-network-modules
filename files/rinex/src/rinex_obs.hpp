/*
 * files/rinex — RINEX 3.02 to 3.05 observation files.
 *
 * A RINEX observation file is fixed-column text: an 80-column header whose last
 * twenty columns name the record, then data records, each epoch an `>` line
 * followed by one line per satellite with 16 columns per observation (F14.3,
 * the loss-of-lock indicator, the signal-strength indicator). This reads that
 * into a structure and nothing else; `rinex_module.cpp` projects it onto SDS.
 *
 * STRICT, BY NAME, NO GUESSING. The version is read and anything outside
 * 3.02..3.05 is refused with the version it was (a 2.xx file's observation
 * codes mean other things, and a 4.xx file's records are laid out another
 * way). An epoch flag other than 0 is refused: events carry header changes this
 * reader would have to apply, and a power-failure or cycle-slip flag changes
 * what every LLI in the epoch means; none of that has a place in the record, so
 * it is not read as an ordinary epoch. An observation type of I (ionosphere
 * phase delay) or X (receiver channel number) has no member of $GNO's
 * observation-type vocabulary, so a file that declares one is refused rather
 * than read with its columns missing. A satellite whose system the header
 * declared no observation types for, a value that is not a number, an
 * indicator that is not a digit and an epoch count that disagrees with the
 * lines that follow are each refused.
 *
 * WHAT IT KEEPS is every value as the file's text said it (the double nearest
 * the decimal), both indicators, the epoch as the file spelled it, the
 * receiver clock offset when the epoch line states one, and the header facts
 * $GNO and $NCD have a place for. The header records they have no place for are
 * listed by label in `uncarried_labels` so the loss is declared.
 */

#ifndef RINEX_RINEX_OBS_HPP
#define RINEX_RINEX_OBS_HPP

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace rinex {

struct Refusal {
    std::string code;
    std::string message;
};

inline bool fail(Refusal* r, const char* code, const std::string& message) {
    if (r) {
        r->code = code;
        r->message = message;
    }
    return false;
}

inline std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) --b;
    return s.substr(a, b - a);
}

/* Columns [from, from + width) of a line, blank-padded past its end. */
inline std::string cols(const std::string& line, size_t from, size_t width) {
    if (from >= line.size()) return std::string(width, ' ');
    std::string out = line.substr(from, width);
    out.resize(width, ' ');
    return out;
}

/* A strict decimal: the whole trimmed field, finite, nothing after it. */
inline bool to_double(const std::string& field, double* out) {
    const std::string t = trim(field);
    if (t.empty()) return false;
    char* end = nullptr;
    const double v = std::strtod(t.c_str(), &end);
    if (end == t.c_str() || *end != '\0' || !std::isfinite(v)) return false;
    *out = v;
    return true;
}

inline bool to_int(const std::string& field, long long* out) {
    const std::string t = trim(field);
    if (t.empty()) return false;
    char* end = nullptr;
    const long long v = std::strtoll(t.c_str(), &end, 10);
    if (end == t.c_str() || *end != '\0') return false;
    *out = v;
    return true;
}

struct Observation {
    std::string code;   /* the three-character observation code, e.g. C1C */
    double value = 0.0;
    uint8_t lli = 0;
    uint8_t ssi = 0;
};

struct SatelliteRecord {
    std::string id;     /* G05, R24, E11, C21 ... */
    char system = 'G';
    std::vector<Observation> observations;
};

struct Epoch {
    std::string stamp;  /* YYYY-MM-DDThh:mm:ss.fffffff, on the file's time system */
    double seconds_of_day = 0.0; /* for window comparison only; no scale conversion */
    long long day_number = 0;    /* days from 1970-01-01 of the calendar date */
    bool has_clock_offset = false;
    double clock_offset = 0.0;
    size_t declared_satellites = 0;
    std::vector<SatelliteRecord> satellites;
};

struct File {
    double version = 0.0;
    char system = ' ';  /* the header's satellite system: G R E C J I S or M */
    std::string program, run_by, date;
    std::string marker_name;
    std::string receiver_serial, receiver_type, receiver_version;
    std::string antenna_serial, antenna_type;
    bool has_position = false;
    double position[3] = {0.0, 0.0, 0.0};
    bool has_interval = false;
    double interval = 0.0;
    std::string time_system;                       /* GPS GLO GAL QZS BDT IRN */
    std::map<char, std::vector<std::string> > types; /* per system, in header order */
    std::vector<std::string> comments;
    std::vector<std::string> uncarried_labels;     /* header records with no place in $GNO or $NCD */
    std::vector<Epoch> epochs;
};

namespace detail {

inline std::string label_of(const std::string& line) { return trim(cols(line, 60, 20)); }

/* Civil date to days since 1970-01-01 (Hinnant); calendar arithmetic, no scale. */
inline long long days_from_civil(long long y, unsigned m, unsigned d) {
    y -= m <= 2;
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<long long>(doe) - 719468;
}

inline char system_of_header_char(char c) {
    switch (c) {
        case 'G': case 'R': case 'E': case 'C': case 'J': case 'I': case 'S': case 'M': return c;
        case ' ': return 'G'; /* RINEX 2 style blank, kept for the version check to refuse first */
        default: return '?';
    }
}

/* The time system a single-system file without TIME OF FIRST OBS's system field is in. */
inline const char* default_time_system(char system) {
    switch (system) {
        case 'G': case 'S': return "GPS";
        case 'R': return "GLO";
        case 'E': return "GAL";
        case 'C': return "BDT";
        case 'J': return "QZS";
        case 'I': return "IRN";
        default: return "";
    }
}

inline bool known_observation_type(char t) { return t == 'C' || t == 'L' || t == 'D' || t == 'S'; }

}  // namespace detail

/* Read the whole file. `uncarried` collects header labels without a home. */
inline bool parse_observations(const char* bytes, size_t length, File* out, Refusal* r) {
    using namespace detail;
    *out = File{};
    if (!bytes || length == 0) return fail(r, "bad-rinex", "The file is empty.");

    std::vector<std::string> lines;
    {
        size_t start = 0;
        while (start < length) {
            size_t end = start;
            while (end < length && bytes[end] != '\n') ++end;
            size_t stop = end;
            if (stop > start && bytes[stop - 1] == '\r') --stop;
            lines.emplace_back(bytes + start, stop - start);
            start = end + 1;
        }
    }
    for (const std::string& l : lines) {
        for (char c : l) {
            const unsigned char u = static_cast<unsigned char>(c);
            if ((u < 0x20 && u != '\t') || u > 0x7e) {
                return fail(r, "bad-encoding", "The file holds a byte that is not printable ASCII; RINEX is ASCII text.");
            }
        }
    }
    if (lines.empty()) return fail(r, "bad-rinex", "The file is empty.");

    /* ---- header ---------------------------------------------------------- */
    size_t i = 0;
    bool saw_version = false, saw_end = false;
    std::map<char, size_t> declared_count;
    char continuing = 0;
    std::map<std::string, size_t> uncarried;
    for (; i < lines.size(); ++i) {
        const std::string& line = lines[i];
        const std::string label = label_of(line);
        const std::string where = "Header line " + std::to_string(i + 1) + " (" + label + "): ";
        if (label == "RINEX VERSION / TYPE") {
            double version = 0.0;
            if (!to_double(cols(line, 0, 9), &version)) {
                return fail(r, "bad-value", where + "the version is not a number.");
            }
            out->version = version;
            const char type = cols(line, 20, 1)[0];
            if (!(std::fabs(version - 3.02) < 0.004 || std::fabs(version - 3.03) < 0.004 ||
                  std::fabs(version - 3.04) < 0.004 || std::fabs(version - 3.05) < 0.004)) {
                char text[96];
                std::snprintf(text, sizeof(text), "RINEX version %.2f is not one of 3.02, 3.03, 3.04 or 3.05.", version);
                return fail(r, "unsupported-rinex-version", where + text);
            }
            if (type != 'O') {
                return fail(r, "wrong-rinex-type",
                            where + std::string("the file type is \"") + type + "\", not O (observation data).");
            }
            out->system = system_of_header_char(cols(line, 40, 1)[0]);
            if (out->system == '?') {
                return fail(r, "bad-value", where + "the satellite system is not one of G R E C J I S M.");
            }
            saw_version = true;
        } else if (!saw_version) {
            return fail(r, "bad-rinex", "The first header line is not RINEX VERSION / TYPE.");
        } else if (label == "PGM / RUN BY / DATE") {
            out->program = trim(cols(line, 0, 20));
            out->run_by = trim(cols(line, 20, 20));
            out->date = trim(cols(line, 40, 20));
        } else if (label == "COMMENT") {
            out->comments.push_back(trim(cols(line, 0, 60)));
        } else if (label == "MARKER NAME") {
            out->marker_name = trim(cols(line, 0, 60));
        } else if (label == "REC # / TYPE / VERS") {
            out->receiver_serial = trim(cols(line, 0, 20));
            out->receiver_type = trim(cols(line, 20, 20));
            out->receiver_version = trim(cols(line, 40, 20));
        } else if (label == "ANT # / TYPE") {
            out->antenna_serial = trim(cols(line, 0, 20));
            out->antenna_type = trim(cols(line, 20, 20));
        } else if (label == "APPROX POSITION XYZ") {
            for (int k = 0; k < 3; ++k) {
                if (!to_double(cols(line, static_cast<size_t>(k) * 14, 14), &out->position[k])) {
                    return fail(r, "bad-value", where + "a coordinate is not a number.");
                }
            }
            out->has_position = true;
        } else if (label == "INTERVAL") {
            if (!to_double(cols(line, 0, 10), &out->interval)) {
                return fail(r, "bad-value", where + "the interval is not a number.");
            }
            out->has_interval = true;
        } else if (label == "TIME OF FIRST OBS") {
            out->time_system = trim(cols(line, 48, 3));
        } else if (label == "SYS / # / OBS TYPES") {
            char sys = cols(line, 0, 1)[0];
            size_t first = 7;
            if (sys == ' ') {
                if (!continuing) return fail(r, "bad-rinex", where + "a continuation line follows no system.");
                sys = continuing;
            } else {
                long long count = 0;
                if (!to_int(cols(line, 3, 3), &count) || count < 1 || count > 99) {
                    return fail(r, "bad-value", where + "the observation-type count is not a number from 1 to 99.");
                }
                if (system_of_header_char(sys) == '?' || sys == 'M') {
                    return fail(r, "bad-value", where + std::string("\"") + sys + "\" is not a satellite system.");
                }
                if (out->types.count(sys)) {
                    return fail(r, "duplicate-record", where + std::string("system ") + sys + " is declared twice.");
                }
                declared_count[sys] = static_cast<size_t>(count);
                out->types[sys] = std::vector<std::string>();
                continuing = sys;
            }
            for (size_t k = 0; k < 13 && out->types[sys].size() < declared_count[sys]; ++k) {
                const std::string code = trim(cols(line, first + k * 4, 4));
                if (code.size() != 3) {
                    return fail(r, "bad-value", where + "an observation code \"" + code + "\" is not three characters.");
                }
                if (!known_observation_type(code[0])) {
                    return fail(r, "unsupported-observation-type",
                                where + "observation code " + code + " has type " + code[0] +
                                    ", which has no member of $GNO's observation types (C pseudorange, L carrier phase, D Doppler "
                                    "and S signal strength are read; I and X are not).");
                }
                out->types[sys].push_back(code);
            }
        } else if (label == "END OF HEADER") {
            saw_end = true;
            ++i;
            break;
        } else if (!label.empty()) {
            /* A real header record this reader has no home for: counted by label. */
            ++uncarried[label];
        }
    }
    if (!saw_version) return fail(r, "bad-rinex", "The file has no RINEX VERSION / TYPE record.");
    if (!saw_end) return fail(r, "bad-rinex", "The header has no END OF HEADER record.");
    for (const auto& kv : declared_count) {
        if (out->types[kv.first].size() != kv.second) {
            return fail(r, "bad-value", std::string("SYS / # / OBS TYPES declares ") + std::to_string(kv.second) +
                                            " codes for system " + kv.first + " and lists " +
                                            std::to_string(out->types[kv.first].size()) + ".");
        }
    }
    if (out->types.empty()) return fail(r, "missing-record", "The header declares no SYS / # / OBS TYPES.");
    for (const auto& kv : uncarried) {
        out->uncarried_labels.push_back(kv.second > 1 ? kv.first + " (" + std::to_string(kv.second) + ")" : kv.first);
    }
    if (out->time_system.empty()) {
        const char* fallback = default_time_system(out->system);
        if (fallback[0] == '\0') {
            return fail(r, "missing-time-system",
                        "A mixed file must state its time system in TIME OF FIRST OBS; none is stated and none is guessed.");
        }
        out->time_system = fallback;
    }

    /* ---- data ------------------------------------------------------------ */
    for (; i < lines.size(); ++i) {
        const std::string& line = lines[i];
        if (trim(line).empty()) continue;
        const std::string where = "Line " + std::to_string(i + 1) + ": ";
        if (line[0] != '>') {
            if (!out->epochs.empty()) {
                return fail(r, "inconsistent-message",
                            where + "a satellite record outside any epoch: the epoch at " + out->epochs.back().stamp +
                                " declares " + std::to_string(out->epochs.back().declared_satellites) +
                                " satellites and the file holds more.");
            }
            return fail(r, "bad-epoch-record", where + "an epoch record opens with \">\".");
        }
        long long year = 0, month = 0, day = 0, hour = 0, minute = 0, flag = 0, nsat = 0;
        double second = 0.0;
        if (!to_int(cols(line, 2, 4), &year) || !to_int(cols(line, 7, 2), &month) || !to_int(cols(line, 10, 2), &day) ||
            !to_int(cols(line, 13, 2), &hour) || !to_int(cols(line, 16, 2), &minute) ||
            !to_double(cols(line, 18, 11), &second) || !to_int(cols(line, 31, 1), &flag) ||
            !to_int(cols(line, 32, 3), &nsat)) {
            return fail(r, "bad-epoch-record", where + "the epoch record is not \"> yyyy mm dd hh mm ss.sssssss f nnn\".");
        }
        if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
            second < 0.0 || second >= 61.0 || nsat < 0) {
            return fail(r, "bad-epoch-record", where + "a calendar field is out of range.");
        }
        if (flag != 0) {
            return fail(r, "unsupported-epoch-flag",
                        where + "epoch flag " + std::to_string(flag) +
                            " (an event, a power failure or cycle-slip records); only flag 0 epochs are read, since an "
                            "event changes what the file's header or indicators mean and $GNO has no place for that.");
        }
        Epoch epoch;
        {
            char secs[24];
            std::snprintf(secs, sizeof(secs), "%010.7f", second);
            char stamp[64];
            std::snprintf(stamp, sizeof(stamp), "%04lld-%02lld-%02lldT%02lld:%02lld:%s", year, month, day, hour, minute, secs);
            epoch.stamp = stamp;
        }
        epoch.day_number = days_from_civil(year, static_cast<unsigned>(month), static_cast<unsigned>(day));
        epoch.seconds_of_day = static_cast<double>(hour * 3600 + minute * 60) + second;
        epoch.declared_satellites = static_cast<size_t>(nsat);
        {
            const std::string offset = cols(line, 41, 15);
            if (!trim(offset).empty()) {
                if (!to_double(offset, &epoch.clock_offset)) {
                    return fail(r, "bad-epoch-record", where + "the receiver clock offset is not a number.");
                }
                epoch.has_clock_offset = true;
            }
        }
        for (long long s = 0; s < nsat; ++s) {
            ++i;
            if (i >= lines.size()) {
                return fail(r, "truncated", where + "the epoch declares " + std::to_string(nsat) +
                                                " satellites and the file ends after " + std::to_string(s) + ".");
            }
            const std::string& sline = lines[i];
            const std::string swhere = "Line " + std::to_string(i + 1) + ": ";
            if (sline.empty() || sline[0] == '>') {
                return fail(r, "inconsistent-message", swhere + "the epoch at line " + std::to_string(i - static_cast<size_t>(s)) +
                                                           " declares " + std::to_string(nsat) + " satellites and holds " +
                                                           std::to_string(s) + ".");
            }
            SatelliteRecord sat;
            sat.system = sline[0];
            auto type_it = out->types.find(sat.system);
            if (type_it == out->types.end()) {
                return fail(r, "bad-satellite-record", swhere + std::string("system \"") + sat.system +
                                                           "\" has no SYS / # / OBS TYPES in the header.");
            }
            std::string prn = cols(sline, 1, 2);
            if (prn[0] == ' ') prn[0] = '0';
            if (!(prn[0] >= '0' && prn[0] <= '9' && prn[1] >= '0' && prn[1] <= '9')) {
                return fail(r, "bad-satellite-record", swhere + "the satellite number is not two digits.");
            }
            sat.id = std::string(1, sat.system) + prn;
            const std::vector<std::string>& codes = type_it->second;
            if (sline.size() > 3 + 16 * codes.size() + 0 && trim(sline.substr(3 + 16 * codes.size())).size() > 0) {
                return fail(r, "bad-satellite-record", swhere + "the line holds more columns than its system declares " +
                                                           std::to_string(codes.size()) + " observation types for.");
            }
            for (size_t k = 0; k < codes.size(); ++k) {
                const std::string field = cols(sline, 3 + 16 * k, 14);
                const char lli_char = cols(sline, 3 + 16 * k + 14, 1)[0];
                const char ssi_char = cols(sline, 3 + 16 * k + 15, 1)[0];
                if (trim(field).empty()) continue;
                Observation o;
                o.code = codes[k];
                if (!to_double(field, &o.value)) {
                    return fail(r, "bad-value", swhere + sat.id + " " + o.code + ": \"" + trim(field) + "\" is not a number.");
                }
                if (lli_char != ' ') {
                    if (lli_char < '0' || lli_char > '9') {
                        return fail(r, "bad-value", swhere + sat.id + " " + o.code + ": the loss-of-lock indicator \"" + lli_char + "\" is not a digit.");
                    }
                    o.lli = static_cast<uint8_t>(lli_char - '0');
                }
                if (ssi_char != ' ') {
                    if (ssi_char < '0' || ssi_char > '9') {
                        return fail(r, "bad-value", swhere + sat.id + " " + o.code + ": the signal-strength indicator \"" + ssi_char + "\" is not a digit.");
                    }
                    o.ssi = static_cast<uint8_t>(ssi_char - '0');
                }
                sat.observations.push_back(o);
            }
            epoch.satellites.push_back(sat);
        }
        out->epochs.push_back(epoch);
    }
    if (out->epochs.empty()) return fail(r, "missing-record", "The file holds no epoch.");
    return true;
}

}  // namespace rinex

#endif  // RINEX_RINEX_OBS_HPP
