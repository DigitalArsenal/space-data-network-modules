// jd_to_iso rounds a Julian date to the printed millisecond before splitting
// it, so a millisecond that rounds up carries through the second, minute,
// hour, day, month and year instead of printing second 60.
//
// Source of the expected text: the Gregorian calendar, by exact arithmetic
// from JD 2461227.5 = 2026-07-06T00:00:00Z (Meeus, Astronomical Algorithms,
// 2nd ed., ch. 7; 2027 is a common year, 2028 a leap year). UTC, no leap
// seconds in these intervals. A JD near 2.46e6 resolves 2^-31 day (40.2 us),
// so each input sits at least 100 us from a millisecond rounding boundary.
#include "conjunction/conjunction_assessment.h"

#include <cstdio>
#include <string>

using namespace conjunction;

static int tests_passed = 0;
static int tests_failed = 0;

static void check(const std::string& actual, const char* expected, const char* what) {
    if (actual == expected) {
        std::printf("PASS: %s (%s)\n", what, actual.c_str());
        tests_passed++;
    } else {
        std::printf("FAIL: %s: got %s, expected %s\n", what, actual.c_str(), expected);
        tests_failed++;
    }
}

int main() {
    const double july6 = 2461227.5;              // 2026-07-06T00:00:00Z
    const double jan1_2027 = july6 + 179.0;      // 26 + 31 + 30 + 31 + 30 + 31 days
    const double mar1_2028 = jan1_2027 + 365.0 + 31.0 + 29.0;
    const double step = 60.0 / 86400.0;

    check(jd_to_iso(july6 + 12.3454 / 86400.0), "2026-07-06T00:00:12.345Z", "millisecond rounds down");
    check(jd_to_iso(july6 + 59.9994 / 86400.0), "2026-07-06T00:00:59.999Z", "last millisecond of a minute");
    check(jd_to_iso(july6 + 2737 * step), "2026-07-07T21:37:00.000Z",
          "coarse epoch 21:37 carries into the minute (printed 21:36:60.000 before)");
    check(jd_to_iso(july6 + 3599.9996 / 86400.0), "2026-07-06T01:00:00.000Z", "carry into the hour");
    check(jd_to_iso(july6 + 86399.9996 / 86400.0), "2026-07-07T00:00:00.000Z", "carry into the day");
    check(jd_to_iso(july6 + 25.0 - 0.0004 / 86400.0), "2026-07-31T00:00:00.000Z", "day 30 -> 31 of July");
    check(jd_to_iso(july6 + 26.0 - 0.0004 / 86400.0), "2026-08-01T00:00:00.000Z", "carry into the month");
    check(jd_to_iso(jan1_2027 - 0.0004 / 86400.0), "2027-01-01T00:00:00.000Z", "carry into the year");
    check(jd_to_iso(mar1_2028 - 1.0 - 0.0004 / 86400.0), "2028-02-29T00:00:00.000Z", "leap day");
    check(jd_to_iso(mar1_2028 - 0.0004 / 86400.0), "2028-03-01T00:00:00.000Z", "carry out of the leap day");

    // Every coarse epoch of a seven-day, 60 s screening grid is a whole minute.
    int not_whole_minute = 0;
    for (int k = 0; k <= 7 * 1440; ++k) {
        const std::string text = jd_to_iso(july6 + k * step);
        if (text.substr(16) != ":00.000Z") not_whole_minute++;
    }
    if (not_whole_minute == 0) {
        std::printf("PASS: every coarse epoch of a 7-day 60 s grid prints a whole minute\n");
        tests_passed++;
    } else {
        std::printf("FAIL: %d coarse epochs of a 7-day 60 s grid do not print a whole minute\n", not_whole_minute);
        tests_failed++;
    }

    std::printf("passed=%d failed=%d\n", tests_passed, tests_failed);
    return tests_failed == 0 ? 0 : 1;
}
