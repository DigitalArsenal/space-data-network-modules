/*
 * gps_time.hpp — GPS-epoch time conversion helpers (A2.2c-2 promotion).
 *
 * PROMOTED (A2.2c-2, 2026-07-13): these helpers were first written in
 * data-source/oneweb-source/src/oneweb_source.cpp (A2.2c-1, which decoded the
 * LTEF element epoch from GPS-epoch seconds). A2.2c-1's completion note flagged
 * them for promotion to common/ alongside the GPS almanac adapter (adapter #3),
 * since GNSS sources routinely carry GPS-system time. They are extracted
 * VERBATIM (same function bodies, same constant) so the oneweb dist rebuilds
 * BYTE-IDENTICAL — only the definition site moved (into namespace
 * provider_source, resolved via the -I common include path build.mjs already
 * adds). Adapters include it by bare name:  #include "gps_time.hpp"
 *
 * CONVENTION (honest, matches the sources these serve): GPS system time has NO
 * leap-second offset from its own continuous count; these helpers convert a
 * GPS-epoch-seconds count (seconds since 1980-01-06T00:00:00) to a calendar
 * ISO 8601 string WITHOUT applying any GPS->UTC leap-second correction. That is
 * the correct GPS-time calendar representation. A caller that needs UTC owns the
 * leap-second conversion (the same "the consumer/OD owns the transform" split
 * used for reference frames in A2.2a) and must label TIME_SYSTEM accordingly.
 *
 * LINKAGE (deliberate): these are INTERNAL-linkage (static) definitions, exactly
 * mirroring the anonymous-namespace definitions they were extracted from. This is
 * what keeps the oneweb dist BYTE-IDENTICAL across the promotion: external/vague
 * `inline` linkage biases the optimizer to inline gps_seconds_to_iso into every
 * call site, which changed the WASM code section even though behavior was
 * identical; internal linkage reproduces the original out-of-line codegen exactly
 * (proven: dist hashes unchanged). Each single-TU adapter that includes this gets
 * its own internal copy, which is the same shape as the original per-adapter
 * anonymous-namespace helper.
 */
#ifndef SDN_GPS_TIME_HPP
#define SDN_GPS_TIME_HPP

#include <string>

namespace provider_source {

// GPS-epoch (1980-01-06T00:00:00) expressed as Unix seconds. Adding this offset
// to a GPS-epoch-seconds count yields the Unix-seconds count of the same
// calendar instant in GPS time (no leap correction).
static const long kGpsUnixOffsetSec = 315964800;

// Howard Hinnant's civil_from_days: days since 1970-01-01 -> (y, m, d).
static void civil_from_days(long z, long* y, unsigned* m, unsigned* d) {
    z += 719468;
    long era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned doe = static_cast<unsigned>(z - era * 146097);          // [0, 146096]
    unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;  // [0, 399]
    long yy = static_cast<long>(yoe) + era * 400;
    unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);          // [0, 365]
    unsigned mp = (5 * doy + 2) / 153;                               // [0, 11]
    *d = doy - (153 * mp + 2) / 5 + 1;                               // [1, 31]
    *m = mp < 10 ? mp + 3 : mp - 9;                                  // [1, 12]
    *y = yy + (*m <= 2 ? 1 : 0);
}

static void pad2(std::string* s, long v) {
    if (v < 10) s->push_back('0');
    *s += std::to_string(v);
}

// Convert GPS-epoch seconds to a calendar ISO 8601 string (YYYY-MM-DDThh:mm:ssZ),
// no leap-second correction (GPS-time calendar representation).
static std::string gps_seconds_to_iso(long gps_seconds) {
    long unix = gps_seconds + kGpsUnixOffsetSec;
    long days = unix / 86400;
    long sod = unix - days * 86400;
    if (sod < 0) { sod += 86400; days -= 1; }
    long y; unsigned mo, da;
    civil_from_days(days, &y, &mo, &da);
    long hh = sod / 3600, mm = (sod % 3600) / 60, ss = sod % 60;
    std::string s = std::to_string(y);
    s.push_back('-'); pad2(&s, static_cast<long>(mo));
    s.push_back('-'); pad2(&s, static_cast<long>(da));
    s.push_back('T'); pad2(&s, hh);
    s.push_back(':'); pad2(&s, mm);
    s.push_back(':'); pad2(&s, ss);
    s.push_back('Z');
    return s;
}

}  // namespace provider_source

#endif  // SDN_GPS_TIME_HPP
