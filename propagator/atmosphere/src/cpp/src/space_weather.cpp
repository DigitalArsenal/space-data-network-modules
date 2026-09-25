/**
 * Space weather selection for NRLMSISE-00.
 *
 * Input semantics come from the NRLMSISE-00 C package (nrlmsise-00.h,
 * struct ap_array and notes on input variables): the daily flux is the
 * previous day's observed F10.7, the mean is the 81-day average centered on
 * the day, and the ap history is relative to the evaluation time.
 */

#include "atmosphere/space_weather.h"

#include <algorithm>
#include <cmath>

namespace atmosphere {

namespace {

constexpr double kSecondsPerApBin = 10800.0;
constexpr double kMaximumAp = 400.0;  // largest value of the ap scale
constexpr int kHistoryBins = 20;      // current bin and the 19 before it

int64_t floorDiv(int64_t value, int64_t divisor) {
    int64_t quotient = value / divisor;
    if ((value % divisor != 0) && ((value < 0) != (divisor < 0))) {
        --quotient;
    }
    return quotient;
}

int32_t daysInMonth(int32_t year, int32_t month) {
    static constexpr int32_t kDays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (month < 1 || month > 12) {
        return 0;
    }
    return month == 2 && isLeapYear(year) ? 29 : kDays[month - 1];
}

bool finiteInRange(double value, double lower, double upper) {
    return std::isfinite(value) && value >= lower && value <= upper;
}

}  // namespace

bool isLeapYear(int32_t year) {
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}

int64_t daysFromCivil(int32_t year, int32_t month, int32_t day) {
    const int64_t y = static_cast<int64_t>(year) - (month <= 2 ? 1 : 0);
    const int64_t era = floorDiv(y, 400);
    const int64_t yearOfEra = y - era * 400;
    const int64_t monthIndex = month > 2 ? month - 3 : month + 9;
    const int64_t dayOfYear = (153 * monthIndex + 2) / 5 + day - 1;
    const int64_t dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear;
    return era * 146097 + dayOfEra - 719468;
}

SpaceWeatherError SpaceWeatherWindow::add(const DailySpaceWeather& record) {
    if (record.day < 1 || record.day > daysInMonth(record.year, record.month)) {
        return SpaceWeatherError::InvalidDate;
    }
    if (!std::isfinite(record.f107Observed) ||
        !std::isfinite(record.f107ObservedCenter81) ||
        !finiteInRange(record.apDaily, 0.0, kMaximumAp)) {
        return SpaceWeatherError::InvalidValue;
    }
    for (double ap : record.ap3Hour) {
        if (!finiteInRange(ap, 0.0, kMaximumAp)) {
            return SpaceWeatherError::InvalidValue;
        }
    }

    const int64_t key = daysFromCivil(record.year, record.month, record.day);
    if (!days_.emplace(key, record).second) {
        return SpaceWeatherError::DuplicateDay;
    }
    return SpaceWeatherError::None;
}

SpaceWeatherError SpaceWeatherWindow::ap3HourAt(const Epoch& epoch, double& ap) const {
    const int32_t yearDays = isLeapYear(epoch.year) ? 366 : 365;
    if (epoch.dayOfYear < 1 || epoch.dayOfYear > yearDays || !std::isfinite(epoch.secondOfDay) ||
        epoch.secondOfDay < 0.0 || epoch.secondOfDay >= 86401.0) {
        return SpaceWeatherError::InvalidEpoch;
    }
    const int64_t day = daysFromCivil(epoch.year, 1, 1) + epoch.dayOfYear - 1;
    const auto current = days_.find(day);
    if (current == days_.end()) {
        return SpaceWeatherError::MissingCurrentDay;
    }
    // A leap second (86400 <= s < 86401) stays in the last bin.
    const int bin = std::min(7, static_cast<int>(epoch.secondOfDay / 10800.0));
    ap = current->second.ap3Hour[bin];
    return SpaceWeatherError::None;
}

SpaceWeatherError SpaceWeatherWindow::select(const Epoch& epoch,
                                             SpaceWeatherSelection& selection) const {
    const int32_t yearDays = isLeapYear(epoch.year) ? 366 : 365;
    // 86401 s admits a UTC leap second in the last minute of the day.
    if (epoch.dayOfYear < 1 || epoch.dayOfYear > yearDays ||
        !std::isfinite(epoch.secondOfDay) ||
        epoch.secondOfDay < 0.0 || epoch.secondOfDay >= 86401.0) {
        return SpaceWeatherError::InvalidEpoch;
    }

    const int64_t day = daysFromCivil(epoch.year, 1, 1) + epoch.dayOfYear - 1;
    const auto current = days_.find(day);
    if (current == days_.end()) {
        return SpaceWeatherError::MissingCurrentDay;
    }
    const auto previous = days_.find(day - 1);
    if (previous == days_.end() || !(previous->second.f107Observed > 0.0)) {
        return SpaceWeatherError::MissingPreviousDayFlux;
    }
    if (!(current->second.f107ObservedCenter81 > 0.0)) {
        return SpaceWeatherError::MissingCenteredFlux;
    }

    SolarActivity solar;
    solar.F107 = previous->second.f107Observed;
    solar.F107A = current->second.f107ObservedCenter81;
    solar.Ap[0] = current->second.apDaily;

    // Bin 7 also holds a leap second at 86400 s.
    const int64_t currentBin = std::min<int64_t>(
        7, static_cast<int64_t>(std::floor(epoch.secondOfDay / kSecondsPerApBin)));
    const int64_t currentIndex = day * 8 + currentBin;

    double bins[kHistoryBins];
    bool historyComplete = true;
    for (int k = 0; k < kHistoryBins && historyComplete; ++k) {
        const int64_t index = currentIndex - k;
        const int64_t binDay = floorDiv(index, 8);
        const auto found = days_.find(binDay);
        if (found == days_.end()) {
            historyComplete = false;
            break;
        }
        bins[k] = found->second.ap3Hour[index - binDay * 8];
    }

    if (historyComplete) {
        solar.Ap[1] = bins[0];
        solar.Ap[2] = bins[1];
        solar.Ap[3] = bins[2];
        solar.Ap[4] = bins[3];
        double earlier = 0.0;
        double earliest = 0.0;
        for (int k = 4; k < 12; ++k) {
            earlier += bins[k];
        }
        for (int k = 12; k < 20; ++k) {
            earliest += bins[k];
        }
        solar.Ap[5] = earlier / 8.0;
        solar.Ap[6] = earliest / 8.0;
        solar.geomagnetic = GeomagneticInput::ApHistory;
    } else {
        for (int i = 1; i < 7; ++i) {
            solar.Ap[i] = solar.Ap[0];
        }
        solar.geomagnetic = GeomagneticInput::DailyAp;
    }

    selection.solar = solar;
    selection.forecastInputs = previous->second.f107Forecast || current->second.f107Forecast;
    return SpaceWeatherError::None;
}

const char* spaceWeatherErrorCode(SpaceWeatherError error) {
    switch (error) {
        case SpaceWeatherError::None: return "ok";
        case SpaceWeatherError::InvalidDate: return "invalid-spw-date";
        case SpaceWeatherError::DuplicateDay: return "duplicate-spw-day";
        case SpaceWeatherError::InvalidValue: return "invalid-spw-value";
        case SpaceWeatherError::InvalidEpoch: return "invalid-sample-epoch";
        case SpaceWeatherError::MissingCurrentDay: return "missing-space-weather-day";
        case SpaceWeatherError::MissingPreviousDayFlux: return "missing-previous-day-f107";
        case SpaceWeatherError::MissingCenteredFlux: return "missing-centered-f107";
    }
    return "space-weather-error";
}

const char* spaceWeatherErrorMessage(SpaceWeatherError error) {
    switch (error) {
        case SpaceWeatherError::None:
            return "OK.";
        case SpaceWeatherError::InvalidDate:
            return "SPW DATE must be a valid UTC calendar date in YYYY-MM-DD form.";
        case SpaceWeatherError::DuplicateDay:
            return "Each UTC day may appear in only one SPW record.";
        case SpaceWeatherError::InvalidValue:
            return "SPW flux values must be finite and Ap values finite within 0-400.";
        case SpaceWeatherError::InvalidEpoch:
            return "Sample epoch is outside its UTC day.";
        case SpaceWeatherError::MissingCurrentDay:
            return "NRLMSISE-00 needs the SPW record for each sample's UTC day.";
        case SpaceWeatherError::MissingPreviousDayFlux:
            return "NRLMSISE-00 needs the observed F10.7 (F107_OBS) of the UTC day before each sample.";
        case SpaceWeatherError::MissingCenteredFlux:
            return "NRLMSISE-00 needs the observed 81-day centered F10.7 (F107_OBS_CENTER81) of each sample's UTC day.";
    }
    return "Space weather error.";
}

}  // namespace atmosphere
