/*
 * files/rinex — the text helpers every RINEX reader shares: the refusal shape, fixed-column slicing, strict
 * numbers, ASCII line splitting and the civil-date arithmetic. One definition, so the observation and the
 * navigation reader cannot disagree about what a column is.
 */

#ifndef RINEX_RINEX_TEXT_HPP
#define RINEX_RINEX_TEXT_HPP

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
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

/* The file as lines, CR LF or LF, every byte printable ASCII or a tab: RINEX is ASCII text. */
inline bool split_ascii_lines(const char* bytes, size_t length, std::vector<std::string>* lines, Refusal* r) {
    size_t start = 0;
    while (start < length) {
        size_t end = start;
        while (end < length && bytes[end] != '\n') ++end;
        size_t stop = end;
        if (stop > start && bytes[stop - 1] == '\r') --stop;
        lines->emplace_back(bytes + start, stop - start);
        start = end + 1;
    }
    for (const std::string& l : *lines) {
        for (char c : l) {
            const unsigned char u = static_cast<unsigned char>(c);
            if ((u < 0x20 && u != '\t') || u > 0x7e) {
                return fail(r, "bad-encoding", "The file holds a byte that is not printable ASCII; RINEX is ASCII text.");
            }
        }
    }
    return true;
}

namespace detail {

/* Civil date to days since 1970-01-01 (Hinnant); calendar arithmetic, no scale. */
inline long long days_from_civil(long long y, unsigned m, unsigned d) {
    y -= m <= 2;
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<long long>(doe) - 719468;
}

}  // namespace detail

}  // namespace rinex

#endif  // RINEX_RINEX_TEXT_HPP
