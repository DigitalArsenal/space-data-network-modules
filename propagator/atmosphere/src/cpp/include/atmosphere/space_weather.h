#ifndef ATMOSPHERE_SDN_SPACE_WEATHER_H
#define ATMOSPHERE_SDN_SPACE_WEATHER_H

#include "types.h"

#include <cstddef>
#include <cstdint>
#include <map>

namespace atmosphere {

// ---------------------------------------------------------------------------
// Space weather for NRLMSISE-00, assembled from daily records
// ---------------------------------------------------------------------------

/// One UTC day of space weather, in the layout of the SDS SPW record.
struct DailySpaceWeather {
    int32_t year  = 0;
    int32_t month = 0;
    int32_t day   = 0;
    double f107Observed         = 0.0;  // SPW F107_OBS [SFU]; <= 0 means absent
    double f107ObservedCenter81 = 0.0;  // SPW F107_OBS_CENTER81 [SFU]; <= 0 means absent
    bool   f107Forecast         = false; // SPW F107_DATA_TYPE is PRD or PRM
    double ap3Hour[8] = {};             // SPW AP1..AP8: 00-03 ... 21-24 UT
    double apDaily    = 0.0;            // SPW AP_AVG
};

enum class SpaceWeatherError : uint8_t {
    None = 0,
    InvalidDate,
    DuplicateDay,
    InvalidValue,
    InvalidEpoch,
    MissingCurrentDay,
    MissingPreviousDayFlux,
    MissingCenteredFlux,
};

struct SpaceWeatherSelection {
    SolarActivity solar;
    /// The previous-day flux or the sample day's record is a forecast.
    bool forecastInputs = false;
};

/// A set of daily records keyed by UTC day.
///
/// For a sample at UTC day D (nrlmsise-00.h, notes on input variables):
///   F10.7  = observed flux of day D-1
///   F10.7A = observed 81-day centered mean of day D
///   Ap[0]  = daily Ap of day D
/// When the 3-hour ap bins covering the 57 hours before the sample are all
/// present, Ap[1..6] follow the epoch-relative ap_array layout and the
/// selection uses GeomagneticInput::ApHistory; otherwise it uses DailyAp.
class SpaceWeatherWindow {
public:
    SpaceWeatherError add(const DailySpaceWeather& record);
    SpaceWeatherError select(const Epoch& epoch, SpaceWeatherSelection& selection) const;
    std::size_t size() const { return days_.size(); }

private:
    std::map<int64_t, DailySpaceWeather> days_;
};

/// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's
/// days_from_civil).
int64_t daysFromCivil(int32_t year, int32_t month, int32_t day);

bool isLeapYear(int32_t year);

const char* spaceWeatherErrorCode(SpaceWeatherError error);
const char* spaceWeatherErrorMessage(SpaceWeatherError error);

}  // namespace atmosphere

#endif  // ATMOSPHERE_SDN_SPACE_WEATHER_H
