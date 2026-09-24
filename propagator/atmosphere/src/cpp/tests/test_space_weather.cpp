// Space weather selection for NRLMSISE-00.
//
// Authority for the expected values: nrlmsise-00.h (struct ap_array and notes
// on input variables) —
//   F10.7  = daily flux of the previous day, at the Earth's distance (observed)
//   F10.7A = 81-day average centered on the day
//   ap_a   = daily Ap; 3-hour ap now, 3 h, 6 h and 9 h before; mean of the
//            eight 3-hour ap from 12 to 33 h before; mean of the eight from
//            36 to 57 h before.
// Every expected number below is computed by hand from those definitions.
// Day numbers are checked against Unix time (seconds / 86400).

// These checks must run in every build type, including Release.
#undef NDEBUG

#include "atmosphere/space_weather.h"

#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>

namespace {

using atmosphere::DailySpaceWeather;
using atmosphere::Epoch;
using atmosphere::GeomagneticInput;
using atmosphere::SpaceWeatherError;
using atmosphere::SpaceWeatherSelection;
using atmosphere::SpaceWeatherWindow;

void expectEqual(double actual, double expected, const char* label) {
    if (actual != expected) {
        std::cerr << "FAIL [" << label << "]: expected " << expected << " got " << actual << "\n";
        assert(false);
    }
}

void expectError(SpaceWeatherError actual, SpaceWeatherError expected, const char* label) {
    if (actual != expected) {
        std::cerr << "FAIL [" << label << "]: expected "
                  << atmosphere::spaceWeatherErrorCode(expected) << " got "
                  << atmosphere::spaceWeatherErrorCode(actual) << "\n";
        assert(false);
    }
}

// ap3Hour for day offset o (-3..0) and bin b: 10 * (o + 3) + b + 1, so
// 2024-02-27 holds 1..8, 02-28 11..18, 02-29 21..28, 03-01 31..38.
DailySpaceWeather record(int32_t year, int32_t month, int32_t day, int offset) {
    DailySpaceWeather r;
    r.year = year;
    r.month = month;
    r.day = day;
    r.f107Observed = 100.0 + 10.0 * (offset + 3);
    r.f107ObservedCenter81 = 150.0 + offset;
    r.apDaily = 10.0 * (offset + 3);
    for (int b = 0; b < 8; ++b) {
        r.ap3Hour[b] = 10.0 * (offset + 3) + b + 1;
    }
    return r;
}

SpaceWeatherWindow leapWindow(bool includeFirstDay) {
    SpaceWeatherWindow window;
    if (includeFirstDay) {
        expectError(window.add(record(2024, 2, 27, -3)), SpaceWeatherError::None, "add 02-27");
    }
    expectError(window.add(record(2024, 2, 28, -2)), SpaceWeatherError::None, "add 02-28");
    expectError(window.add(record(2024, 2, 29, -1)), SpaceWeatherError::None, "add 02-29");
    DailySpaceWeather current = record(2024, 3, 1, 0);
    current.f107Observed = 999.0;  // the sample day's own flux must not be used
    expectError(window.add(current), SpaceWeatherError::None, "add 03-01");
    return window;
}

void testDaysFromCivil() {
    expectEqual(static_cast<double>(atmosphere::daysFromCivil(1970, 1, 1)), 0.0, "1970-01-01");
    expectEqual(static_cast<double>(atmosphere::daysFromCivil(1969, 12, 31)), -1.0, "1969-12-31");
    expectEqual(static_cast<double>(atmosphere::daysFromCivil(2000, 1, 1)), 946684800.0 / 86400.0, "2000-01-01");
    expectEqual(static_cast<double>(atmosphere::daysFromCivil(2024, 2, 29)), 1709164800.0 / 86400.0, "2024-02-29");
    expectEqual(static_cast<double>(atmosphere::daysFromCivil(2025, 1, 1)), 1735689600.0 / 86400.0, "2025-01-01");
    std::cout << "  daysFromCivil matches Unix-time day numbers ✓\n";
}

void testHistoryMidDay() {
    // 2024-03-01 is day of year 61; 43300 s is in bin 4 (12-15 UT).
    const auto window = leapWindow(false);
    SpaceWeatherSelection selection;
    expectError(window.select(Epoch{2024, 61, 43300.0}, selection), SpaceWeatherError::None, "select");
    const auto& s = selection.solar;
    expectEqual(s.F107, 120.0, "F107 = 02-29 observed");
    expectEqual(s.F107A, 150.0, "F107A = 03-01 centered");
    expectEqual(s.Ap[0], 30.0, "daily Ap of 03-01");
    expectEqual(s.Ap[1], 35.0, "ap now (03-01 bin 4)");
    expectEqual(s.Ap[2], 34.0, "ap -3 h");
    expectEqual(s.Ap[3], 33.0, "ap -6 h");
    expectEqual(s.Ap[4], 32.0, "ap -9 h");
    // 31, 28, 27, 26, 25, 24, 23, 22
    expectEqual(s.Ap[5], 206.0 / 8.0, "mean ap 12-33 h before");
    // 21, 18, 17, 16, 15, 14, 13, 12
    expectEqual(s.Ap[6], 126.0 / 8.0, "mean ap 36-57 h before");
    assert(s.geomagnetic == GeomagneticInput::ApHistory);
    assert(!selection.forecastInputs);
    std::cout << "  ap history at 13:01 UT spans two previous days ✓\n";
}

void testHistoryEarlyDayNeedsThreeDaysBack() {
    // Bin 0 reaches 57 h back into 02-27.
    const auto window = leapWindow(true);
    SpaceWeatherSelection selection;
    expectError(window.select(Epoch{2024, 61, 100.0}, selection), SpaceWeatherError::None, "select");
    const auto& s = selection.solar;
    expectEqual(s.Ap[1], 31.0, "ap now (03-01 bin 0)");
    expectEqual(s.Ap[2], 28.0, "ap -3 h (02-29 bin 7)");
    expectEqual(s.Ap[3], 27.0, "ap -6 h");
    expectEqual(s.Ap[4], 26.0, "ap -9 h");
    // 25, 24, 23, 22, 21, 18, 17, 16
    expectEqual(s.Ap[5], 166.0 / 8.0, "mean ap 12-33 h before");
    // 15, 14, 13, 12, 11, 8, 7, 6
    expectEqual(s.Ap[6], 86.0 / 8.0, "mean ap 36-57 h before");
    assert(s.geomagnetic == GeomagneticInput::ApHistory);

    // Without 02-27 the history is incomplete: daily Ap only, never a guess.
    const auto partial = leapWindow(false);
    expectError(partial.select(Epoch{2024, 61, 100.0}, selection), SpaceWeatherError::None, "select partial");
    assert(selection.solar.geomagnetic == GeomagneticInput::DailyAp);
    for (int i = 0; i < 7; ++i) {
        expectEqual(selection.solar.Ap[i], 30.0, "daily Ap fills the array");
    }
    std::cout << "  early-day history needs 02-27; without it daily Ap is used ✓\n";
}

void testLeapSecondUsesLastBin() {
    const auto window = leapWindow(false);
    SpaceWeatherSelection selection;
    expectError(window.select(Epoch{2024, 61, 86400.5}, selection), SpaceWeatherError::None, "select");
    expectEqual(selection.solar.Ap[1], 38.0, "23:59:60 is in bin 7");
    std::cout << "  leap second falls in the last 3-hour bin ✓\n";
}

void testYearBoundaryPreviousDay() {
    SpaceWeatherWindow window;
    DailySpaceWeather dec31 = record(2023, 12, 31, -1);
    dec31.f107Observed = 123.0;
    DailySpaceWeather jan1 = record(2024, 1, 1, 0);
    jan1.f107ObservedCenter81 = 131.0;
    expectError(window.add(dec31), SpaceWeatherError::None, "add 2023-12-31");
    expectError(window.add(jan1), SpaceWeatherError::None, "add 2024-01-01");
    SpaceWeatherSelection selection;
    expectError(window.select(Epoch{2024, 1, 80000.0}, selection), SpaceWeatherError::None, "select");
    expectEqual(selection.solar.F107, 123.0, "F107 from 2023-12-31");
    expectEqual(selection.solar.F107A, 131.0, "F107A from 2024-01-01");
    assert(selection.solar.geomagnetic == GeomagneticInput::DailyAp);
    std::cout << "  previous day of 2024-01-01 is 2023-12-31 ✓\n";
}

void testForecastFlag() {
    SpaceWeatherWindow window;
    DailySpaceWeather previous = record(2024, 2, 29, -1);
    previous.f107Forecast = true;
    expectError(window.add(previous), SpaceWeatherError::None, "add");
    expectError(window.add(record(2024, 3, 1, 0)), SpaceWeatherError::None, "add");
    SpaceWeatherSelection selection;
    expectError(window.select(Epoch{2024, 61, 0.0}, selection), SpaceWeatherError::None, "select");
    assert(selection.forecastInputs);
    std::cout << "  forecast flux is reported ✓\n";
}

void testErrors() {
    const auto window = leapWindow(false);
    SpaceWeatherSelection selection;
    expectError(window.select(Epoch{2024, 62, 0.0}, selection),
                SpaceWeatherError::MissingCurrentDay, "no record for 03-02");
    expectError(window.select(Epoch{2024, 59, 0.0}, selection),
                SpaceWeatherError::MissingPreviousDayFlux, "no record for 02-27");
    expectError(window.select(Epoch{2023, 366, 0.0}, selection),
                SpaceWeatherError::InvalidEpoch, "2023 has 365 days");
    expectError(window.select(Epoch{2024, 61, -1.0}, selection),
                SpaceWeatherError::InvalidEpoch, "negative second");
    expectError(window.select(Epoch{2024, 61, 86401.0}, selection),
                SpaceWeatherError::InvalidEpoch, "past the day");
    expectError(window.select(Epoch{2024, 61, std::numeric_limits<double>::quiet_NaN()}, selection),
                SpaceWeatherError::InvalidEpoch, "NaN second");

    SpaceWeatherWindow noFlux;
    DailySpaceWeather previous = record(2024, 2, 29, -1);
    previous.f107Observed = 0.0;
    noFlux.add(previous);
    noFlux.add(record(2024, 3, 1, 0));
    expectError(noFlux.select(Epoch{2024, 61, 0.0}, selection),
                SpaceWeatherError::MissingPreviousDayFlux, "zero previous-day flux");

    SpaceWeatherWindow noMean;
    DailySpaceWeather current = record(2024, 3, 1, 0);
    current.f107ObservedCenter81 = 0.0;
    noMean.add(record(2024, 2, 29, -1));
    noMean.add(current);
    expectError(noMean.select(Epoch{2024, 61, 0.0}, selection),
                SpaceWeatherError::MissingCenteredFlux, "zero centered mean");

    SpaceWeatherWindow invalid;
    expectError(invalid.add(record(2023, 2, 29, 0)), SpaceWeatherError::InvalidDate, "2023-02-29");
    expectError(invalid.add(record(2024, 13, 1, 0)), SpaceWeatherError::InvalidDate, "month 13");
    DailySpaceWeather tooHigh = record(2024, 3, 1, 0);
    tooHigh.ap3Hour[5] = 401.0;
    expectError(invalid.add(tooHigh), SpaceWeatherError::InvalidValue, "ap above 400");
    DailySpaceWeather notFinite = record(2024, 3, 1, 0);
    notFinite.f107Observed = std::numeric_limits<double>::infinity();
    expectError(invalid.add(notFinite), SpaceWeatherError::InvalidValue, "infinite flux");
    expectError(invalid.add(record(2024, 3, 1, 0)), SpaceWeatherError::None, "first 03-01");
    expectError(invalid.add(record(2024, 3, 1, 0)), SpaceWeatherError::DuplicateDay, "second 03-01");
    std::cout << "  missing, invalid and duplicate inputs are refused ✓\n";
}

}  // namespace

int main() {
    std::cout << "=== test_space_weather ===\n";
    testDaysFromCivil();
    testHistoryMidDay();
    testHistoryEarlyDayNeedsThreeDaysBack();
    testLeapSecondUsesLastBin();
    testYearBoundaryPreviousDay();
    testForecastFlag();
    testErrors();
    std::cout << "=== all space weather tests passed ===\n";
    return 0;
}
