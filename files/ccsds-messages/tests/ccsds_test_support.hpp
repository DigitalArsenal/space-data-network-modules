// ccsds_test_support.hpp — the measuring apparatus the two native harnesses
// share, and nothing that either of them measures.
//
// TWO HARNESSES, BECAUSE THEY HAVE DIFFERENT DEPENDENCIES
//
// `ccsds_native.cpp` proves "every KVN keyword round-trips exactly" and needs
// nothing but `-I src` — no SDS schema, no FlatBuffers runtime, no generated
// header. `ccsds_projection_native.cpp` proves the `$AEM` / `$TDM` projection
// and necessarily needs all three. Keeping them in one translation unit would
// have made the first measurement unbuildable whenever the second's toolchain
// was unavailable, which is the wrong way round: the KVN layer is the floor
// everything else stands on and it must be measurable on its own.
//
// So the SCAFFOLDING lives here — the RESULT printer, the structural document
// comparison, the independent line scans, the epoch arithmetic — and each
// harness carries only its own assertions. Nothing in this file knows about
// SDS, and it must stay that way: the moment it includes a generated header the
// KVN lane inherits the dependency this split exists to avoid.

#ifndef CCSDS_MESSAGES_TEST_SUPPORT_HPP
#define CCSDS_MESSAGES_TEST_SUPPORT_HPP

#include "kvn.hpp"

#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

/* True only when the WHOLE token is a number, so `PATH = 2,1` is not compared
 * as the number two. Restated here rather than taken from the projection
 * headers because this file must not depend on them. */
inline bool parses_fully(const std::string& s, double* out) {
    if (s.empty()) return false;
    char* end = nullptr;
    const double v = std::strtod(s.c_str(), &end);
    if (!end || end == s.c_str()) return false;
    while (*end != '\0' && kvn::is_space(*end)) ++end;
    if (*end != '\0') return false;
    if (out) *out = v;
    return true;
}

int checks = 0;
int failures = 0;

std::string sfmt(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    return std::string(buf);
}

void result(const std::string& name, const std::string& value, const std::string& bound,
            bool ok) {
    ++checks;
    if (!ok) ++failures;
    std::printf("RESULT %-46s %-28s %-24s %s\n", name.c_str(), value.c_str(), bound.c_str(),
                ok ? "PASS" : "FAIL");
}

/* ---------------------------------------------------------------------- */
/* Files                                                                   */
/* ---------------------------------------------------------------------- */

bool read_file(const std::string& path, std::string* out) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    char buf[8192];
    out->clear();
    size_t n = 0;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) out->append(buf, n);
    std::fclose(f);
    return true;
}

/* ---------------------------------------------------------------------- */
/* Structural document comparison                                          */
/* ---------------------------------------------------------------------- */

struct Diff {
    size_t compared = 0;
    size_t differences = 0;
    std::string first;
    // Set only for the RECORD round trip. See cmp_value.
    bool numeric_values = false;
};

void cmp_str(Diff* d, const std::string& what, const std::string& a, const std::string& b) {
    ++d->compared;
    if (a != b) {
        ++d->differences;
        if (d->first.empty()) d->first = what + ": '" + a + "' vs '" + b + "'";
    }
}

// A value the RECORD carries as an IEEE double is compared as a NUMBER, not as
// text: `2.6862511e+002` and `268.62511` are the same measurement and different
// files, and $AEM/$TDM store the measurement. Everything else — keys, order,
// epochs, units, comments, string-valued metadata — must still come back byte
// for byte, and `parse_full_number` on BOTH sides is what decides which rule
// applies, so a value that merely looks numeric (`PATH = 2,1`) stays a text
// comparison. The KVN round trip leaves this off and compares every value as
// text, which is why its numbers come back exactly 0.0 different.
void cmp_value(Diff* d, const std::string& what, const std::string& a, const std::string& b) {
    if (d->numeric_values) {
        double va = 0.0;
        double vb = 0.0;
        if (parses_fully(a, &va) && parses_fully(b, &vb)) {
            ++d->compared;
            if (va != vb) {
                ++d->differences;
                if (d->first.empty()) d->first = what + ": " + a + " vs " + b;
            }
            return;
        }
    }
    cmp_str(d, what, a, b);
}

void cmp_size(Diff* d, const std::string& what, size_t a, size_t b) {
    ++d->compared;
    if (a != b) {
        ++d->differences;
        if (d->first.empty()) d->first = what + ": " + std::to_string(a) + " vs " +
                                         std::to_string(b);
    }
}

void cmp_bool(Diff* d, const std::string& what, bool a, bool b) {
    ++d->compared;
    if (a != b) {
        ++d->differences;
        if (d->first.empty()) d->first = what + ": " + (a ? "true" : "false") + " vs " +
                                         (b ? "true" : "false");
    }
}

void cmp_comments(Diff* d, const std::string& where, const std::vector<std::string>& a,
                  const std::vector<std::string>& b) {
    cmp_size(d, where + ".comments", a.size(), b.size());
    const size_t n = a.size() < b.size() ? a.size() : b.size();
    for (size_t i = 0; i < n; ++i) {
        cmp_str(d, where + ".comment[" + std::to_string(i) + "]", a[i], b[i]);
    }
}

void cmp_entries(Diff* d, const std::string& where, const std::vector<kvn::Entry>& a,
                 const std::vector<kvn::Entry>& b) {
    cmp_size(d, where + ".count", a.size(), b.size());
    const size_t n = a.size() < b.size() ? a.size() : b.size();
    for (size_t i = 0; i < n; ++i) {
        const std::string at = where + "[" + std::to_string(i) + "]";
        cmp_str(d, at + ".key", a[i].key, b[i].key);
        cmp_value(d, at + ".value", a[i].value, b[i].value);
        cmp_str(d, at + ".units", a[i].units, b[i].units);
        cmp_bool(d, at + ".standalone", a[i].is_standalone_comment, b[i].is_standalone_comment);
        cmp_comments(d, at, a[i].comments_before, b[i].comments_before);
    }
}

void cmp_data(Diff* d, const std::string& where, const std::vector<kvn::DataLine>& a,
              const std::vector<kvn::DataLine>& b) {
    cmp_size(d, where + ".count", a.size(), b.size());
    const size_t n = a.size() < b.size() ? a.size() : b.size();
    for (size_t i = 0; i < n; ++i) {
        const std::string at = where + "[" + std::to_string(i) + "]";
        cmp_str(d, at + ".key", a[i].key, b[i].key);
        cmp_str(d, at + ".epoch", a[i].epoch, b[i].epoch);
        cmp_bool(d, at + ".standalone", a[i].is_standalone_comment, b[i].is_standalone_comment);
        cmp_size(d, at + ".tokens", a[i].tokens.size(), b[i].tokens.size());
        const size_t t = a[i].tokens.size() < b[i].tokens.size() ? a[i].tokens.size()
                                                                 : b[i].tokens.size();
        for (size_t j = 0; j < t; ++j) {
            cmp_value(d, at + ".token[" + std::to_string(j) + "]", a[i].tokens[j], b[i].tokens[j]);
        }
        cmp_comments(d, at, a[i].comments_before, b[i].comments_before);
    }
}

Diff compare_documents(const kvn::Document& a, const kvn::Document& b,
                       bool numeric_values = false) {
    Diff d;
    d.numeric_values = numeric_values;
    cmp_str(&d, "message_type", a.message_type, b.message_type);
    cmp_entries(&d, "header", a.header, b.header);
    cmp_size(&d, "segments", a.segments.size(), b.segments.size());
    const size_t n = a.segments.size() < b.segments.size() ? a.segments.size()
                                                           : b.segments.size();
    for (size_t i = 0; i < n; ++i) {
        const std::string at = "segment[" + std::to_string(i) + "]";
        cmp_bool(&d, at + ".has_data", a.segments[i].has_data_block, b.segments[i].has_data_block);
        cmp_entries(&d, at + ".meta", a.segments[i].metadata, b.segments[i].metadata);
        cmp_data(&d, at + ".data", a.segments[i].data, b.segments[i].data);
    }
    return d;
}

/* ---------------------------------------------------------------------- */
/* Keyword sets                                                            */
/* ---------------------------------------------------------------------- */

void add_unique(std::vector<std::string>* set, const std::string& s) {
    for (size_t i = 0; i < set->size(); ++i) {
        if ((*set)[i] == s) return;
    }
    set->push_back(s);
}

bool set_contains(const std::vector<std::string>& set, const std::string& s) {
    for (size_t i = 0; i < set.size(); ++i) {
        if (set[i] == s) return true;
    }
    return false;
}

bool sets_equal(const std::vector<std::string>& a, const std::vector<std::string>& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (!set_contains(b, a[i])) return false;
    }
    return true;
}

std::vector<std::string> lines_of(const std::string& text) {
    std::vector<std::string> out;
    size_t i = 0;
    while (i <= text.size()) {
        const size_t start = i;
        while (i < text.size() && text[i] != '\n') ++i;
        out.push_back(kvn::trim(text.substr(start, i - start)));
        if (i >= text.size()) break;
        ++i;
    }
    return out;
}

bool is_marker_line(const std::string& l) {
    return l == "META_START" || l == "META_STOP" || l == "DATA_START" || l == "DATA_STOP";
}

bool is_comment_line(const std::string& l) {
    return l.rfind("COMMENT", 0) == 0 && (l.size() == 7 || kvn::is_space(l[7]));
}

// The INDEPENDENT reader. It knows four rules and nothing about kvn.hpp:
// a bare block marker is a keyword; a COMMENT line is the keyword COMMENT; a
// line whose text before the first '=' is a single uppercase-initial token is
// that keyword; everything else is a data row and contributes nothing.
std::vector<std::string> scan_keywords(const std::string& text) {
    std::vector<std::string> out;
    const std::vector<std::string> lines = lines_of(text);
    for (size_t i = 0; i < lines.size(); ++i) {
        const std::string& l = lines[i];
        if (l.empty()) continue;
        if (is_marker_line(l)) { add_unique(&out, l); continue; }
        if (is_comment_line(l)) { add_unique(&out, "COMMENT"); continue; }
        const size_t eq = l.find('=');
        if (eq == std::string::npos) continue;
        const std::string key = kvn::trim(l.substr(0, eq));
        if (key.empty()) continue;
        if (!(key[0] >= 'A' && key[0] <= 'Z')) continue;
        bool single_token = true;
        for (size_t j = 0; j < key.size(); ++j) {
            if (kvn::is_space(key[j])) single_token = false;
        }
        if (!single_token) continue;
        add_unique(&out, key);
    }
    return out;
}

// The same set as the PARSER recovered it. Markers are reconstructed from the
// document's structure, which is exactly the claim being tested: that the
// structure carries what the marker lines said.
std::vector<std::string> document_keywords(const kvn::Document& doc) {
    std::vector<std::string> out;
    for (size_t i = 0; i < doc.header.size(); ++i) {
        if (!doc.header[i].comments_before.empty()) add_unique(&out, "COMMENT");
        add_unique(&out, doc.header[i].key);
    }
    for (size_t s = 0; s < doc.segments.size(); ++s) {
        add_unique(&out, "META_START");
        add_unique(&out, "META_STOP");
        const kvn::Segment& seg = doc.segments[s];
        for (size_t i = 0; i < seg.metadata.size(); ++i) {
            if (!seg.metadata[i].comments_before.empty()) add_unique(&out, "COMMENT");
            add_unique(&out, seg.metadata[i].key);
        }
        if (!seg.has_data_block) continue;
        add_unique(&out, "DATA_START");
        add_unique(&out, "DATA_STOP");
        for (size_t i = 0; i < seg.data.size(); ++i) {
            if (!seg.data[i].comments_before.empty()) add_unique(&out, "COMMENT");
            if (!seg.data[i].key.empty()) add_unique(&out, seg.data[i].key);
        }
    }
    return out;
}

std::string set_difference_text(const std::vector<std::string>& a,
                                const std::vector<std::string>& b) {
    std::string out;
    for (size_t i = 0; i < a.size(); ++i) {
        if (!set_contains(b, a[i])) { if (!out.empty()) out += ","; out += a[i]; }
    }
    return out;
}

/* ---------------------------------------------------------------------- */
/* Epochs — DIAGNOSTIC ONLY                                                */
/* ---------------------------------------------------------------------- */

// Neither kvn.hpp nor the views do time math, and this is not a time library
// either. It converts an epoch to (day number, integer second of day,
// fractional second) so that a DIFFERENCE between two epochs in one segment
// can be reported. It has no leap-second table, so a difference spanning a
// leap second is off by one second — which is why it lives in the test as a
// step-size diagnostic and never in a header.
//
// The split matters: adding the day number into the seconds first would put
// the fraction at 1e9 magnitude, where a double resolves about 2e-7 s, and the
// 0.125 s uniformity of Figure G-5 could not be measured at all.
struct Epoch {
    long long day = 0;
    long long sod_int = 0;
    double sod_frac = 0.0;
    bool ok = false;
};

long long days_from_civil(long long y, long long m, long long d) {
    y -= (m <= 2) ? 1 : 0;
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const long long yoe = y - era * 400;
    const long long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097LL + doe - 719468LL;
}

std::vector<std::string> split_on(const std::string& s, char c) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = 0; i <= s.size(); ++i) {
        if (i == s.size() || s[i] == c) {
            out.push_back(s.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

Epoch parse_epoch(const std::string& s) {
    Epoch e;
    const size_t t = s.find('T');
    if (t == std::string::npos) return e;
    const std::vector<std::string> date = split_on(s.substr(0, t), '-');
    const std::vector<std::string> time = split_on(s.substr(t + 1), ':');
    if (time.size() != 3) return e;
    if (date.size() == 3) {
        e.day = days_from_civil(std::atoll(date[0].c_str()), std::atoll(date[1].c_str()),
                                std::atoll(date[2].c_str()));
    } else if (date.size() == 2) {
        // Day-of-year form, as Figure G-5 writes it: 2006-090T05:00:00.071.
        e.day = days_from_civil(std::atoll(date[0].c_str()), 1, 1) +
                std::atoll(date[1].c_str()) - 1;
    } else {
        return e;
    }
    const std::vector<std::string> sec = split_on(time[2], '.');
    e.sod_int = std::atoll(time[0].c_str()) * 3600LL + std::atoll(time[1].c_str()) * 60LL +
                std::atoll(sec[0].c_str());
    e.sod_frac = (sec.size() > 1 && !sec[1].empty())
                     ? std::strtod(("0." + sec[1]).c_str(), nullptr)
                     : 0.0;
    e.ok = true;
    return e;
}

// b - a, in seconds.
double epoch_diff(const Epoch& b, const Epoch& a) {
    return static_cast<double>((b.day - a.day) * 86400LL + (b.sod_int - a.sod_int)) +
           (b.sod_frac - a.sod_frac);
}

/* ---------------------------------------------------------------------- */
/* Independent data-block scans                                            */
/* ---------------------------------------------------------------------- */

// Every columnar data row's first token, read straight off the text. Used to
// prove the parser did not reformat, reorder or drop an epoch.
std::vector<std::string> scan_columnar_epochs(const std::string& text) {
    std::vector<std::string> out;
    const std::vector<std::string> lines = lines_of(text);
    bool in_data = false;
    for (size_t i = 0; i < lines.size(); ++i) {
        const std::string& l = lines[i];
        if (l == "DATA_START") { in_data = true; continue; }
        if (l == "DATA_STOP") { in_data = false; continue; }
        if (!in_data || l.empty() || is_comment_line(l)) continue;
        const std::vector<std::string> tok = kvn::split_tokens(l);
        if (!tok.empty()) out.push_back(tok[0]);
    }
    return out;
}

struct ScannedObservation {
    std::string keyword;
    std::string epoch;
    std::string first_value;
};

std::vector<ScannedObservation> scan_observations(const std::string& text) {
    std::vector<ScannedObservation> out;
    const std::vector<std::string> lines = lines_of(text);
    bool in_data = false;
    for (size_t i = 0; i < lines.size(); ++i) {
        const std::string& l = lines[i];
        if (l == "DATA_START") { in_data = true; continue; }
        if (l == "DATA_STOP") { in_data = false; continue; }
        if (!in_data || l.empty() || is_comment_line(l)) continue;
        const size_t eq = l.find('=');
        if (eq == std::string::npos) continue;
        ScannedObservation o;
        o.keyword = kvn::trim(l.substr(0, eq));
        const std::vector<std::string> tok = kvn::split_tokens(l.substr(eq + 1));
        if (!tok.empty()) o.epoch = tok[0];
        if (tok.size() > 1) o.first_value = tok[1];
        out.push_back(o);
    }
    return out;
}

/* ---------------------------------------------------------------------- */
/* Fixtures                                                                */
/* ---------------------------------------------------------------------- */

struct Fixture {
    const char* id;
    const char* file;
    const char* type;
};

const Fixture FIXTURES[] = {
    {"aem-g4", "ccsds-504.0-B-2-figure-G-4-aem.txt", "AEM"},
    {"aem-g5", "ccsds-504.0-B-2-figure-G-5-aem-spinner.txt", "AEM"},
    {"tdm-e16", "ccsds-503.0-B-2-figure-E-16-tdm-optical.txt", "TDM"},
    {"tdm-e17", "ccsds-503.0-B-2-figure-E-17-tdm-radar.txt", "TDM"},
    {"tdm-e18", "ccsds-503.0-B-2-figure-E-18-tdm-phase.txt", "TDM"},
};
const size_t FIXTURE_COUNT = sizeof(FIXTURES) / sizeof(FIXTURES[0]);

struct Loaded {
    std::string text;
    kvn::Document parsed;      // the file
    kvn::Document reparsed;    // parse(serialize(parsed))
};

Loaded LOADED[FIXTURE_COUNT];

double relative_difference(double a, double b) {
    const double d = std::fabs(a - b);
    const double m = std::fabs(a) > 1.0 ? std::fabs(a) : 1.0;
    return d / m;
}



}  // namespace

#endif  // CCSDS_MESSAGES_TEST_SUPPORT_HPP
