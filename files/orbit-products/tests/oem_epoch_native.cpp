/*
 * The $OEM epoch formatter, against the parser that reads it back.
 *
 * WHY THIS TEST EXISTS AS ITS OWN LANE
 *
 * `ephem::oem::iso_from_seconds` shipped with the wrong era constant — 730120
 * where Hinnant's shift plus the 1970->2000 offset requires 730425 — and
 * rendered every epoch EXACTLY 305 DAYS EARLY. It is the only date formatter
 * in the $OEM projection, and the ephemeris propagator's `describe_ephemeris`
 * uses it for START_TIME, STOP_TIME and every EPHEMERIS_DATA_LINES EPOCH, so
 * every record the module emitted carried right states and wrong dates.
 *
 * That is the shape that survives everything. A four-container agreement check
 * comparing positions ROW BY ROW passed at 1.3e-12 km with the epoch axis 305
 * days out, because row i of one file still matched row i of another. Only an
 * assertion on the ABSOLUTE INSTANT catches it.
 *
 * So this lane checks the formatter two ways that cannot both be wrong in the
 * same direction: against hand-computed calendar anchors (including both sides
 * of a leap day, which is where an era-shift bug that is NOT a constant offset
 * would show up), and against `ephem::oem_kvn::iso_to_seconds` — a separate
 * implementation in a different header, written for the opposite direction.
 * One implementation checked against itself would have passed the whole time.
 */

#include <cmath>
#include <cstdio>
#include <string>

#include "ephemeris_series.hpp"
#include "../../ccsds-messages/src/kvn.hpp"
#include "containers.hpp"
#include "oem_projection.hpp"

namespace {

int failures = 0;

void expect_text(double seconds, const char* want, const char* name) {
    const std::string got = ephem::oem::iso_from_seconds(seconds);
    const bool ok = got == want;
    if (!ok) ++failures;
    std::printf("RESULT %-34s %-28s %-28s %s\n", name, got.c_str(), want, ok ? "PASS" : "FAIL");
}

}  // namespace

int main() {
    /* Calendar anchors. The J2000 epoch is 12:00, not midnight, which is the
     * other off-by-half-a-day this formatter could carry. */
    expect_text(0.0, "2000-01-01T12:00:00.000000", "epoch.j2000-noon");
    expect_text(-43200.0, "2000-01-01T00:00:00.000000", "epoch.j2000-midnight");
    expect_text(820497600.0, "2026-01-01T00:00:00.000000", "epoch.2026-01-01");
    expect_text(31579200.0, "2001-01-01T00:00:00.000000", "epoch.2001-01-01");
    expect_text(-946684800.0, "1970-01-01T12:00:00.000000", "epoch.unix-zero");

    /* Both sides of a leap day in a year that IS a leap year despite being a
     * century (2000 is divisible by 400). An era-shift error that is not a
     * pure constant offset breaks across this boundary and nowhere else. */
    expect_text(-43200.0 + 59.0 * 86400.0, "2000-02-29T00:00:00.000000", "epoch.leap-day");
    expect_text(-43200.0 + 60.0 * 86400.0, "2000-03-01T00:00:00.000000", "epoch.day-after-leap");
    expect_text(99748800.0, "2003-03-01T00:00:00.000000", "epoch.common-year-march");

    /* Round trip against the INDEPENDENT parser, swept across 110 years so a
     * constant offset cannot hide inside a narrow window. */
    double worst = 0.0;
    std::string worst_text;
    for (long long day = -20000; day <= 20000; day += 7) {
        const double seconds = static_cast<double>(day) * 86400.0 + 12345.678901;
        const std::string text = ephem::oem::iso_from_seconds(seconds);
        double back = 0.0;
        if (!ephem::oem_kvn::iso_to_seconds(text, &back)) {
            std::printf("RESULT %-34s %-28s %-28s FAIL\n", "epoch.roundtrip.parse", text.c_str(), "parsable");
            ++failures;
            break;
        }
        const double err = std::fabs(back - seconds);
        if (err > worst) {
            worst = err;
            worst_text = text;
        }
    }
    const bool rt_ok = worst <= 1e-6;
    if (!rt_ok) ++failures;
    std::printf("RESULT %-34s %.3e %-28s %s (%s)\n", "epoch.roundtrip.max_sec", worst, "1e-6",
                rt_ok ? "PASS" : "FAIL", worst_text.c_str());

    std::printf("%d checks, %d failures\n", 9, failures);
    return failures ? 1 : 0;
}
