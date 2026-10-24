#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
namespace ffm {
// Configuration buffers are complete size-prefixed published PRW records. Validation and
// dynamics return named statuses; expected failures never use C++ exceptions.
// The optional environment inputs, each a PRW record: earth_orientation
// (EARTH_ORIENTATION, required for anything Earth-fixed), space_weather
// (SPACE_WEATHER, daily rows for NRLMSISE-00) and jb2008_indices
// (JB2008_INDICES, the JB2008 drivers). density_correction is a published
// DCL record (ordinary or size-prefixed), parsed into owned values.
struct PrwEnvironment {
    const uint8_t* earthOrientation = nullptr; size_t earthOrientationSize = 0;
    const uint8_t* spaceWeather = nullptr; size_t spaceWeatherSize = 0;
    const uint8_t* jb2008Indices = nullptr; size_t jb2008IndicesSize = 0;
    const uint8_t* densityCorrection = nullptr; size_t densityCorrectionSize = 0;
    // second_trajectory: an OEM that EVENTS of kind CLOSEST_APPROACH read.
    const uint8_t* secondTrajectory = nullptr; size_t secondTrajectorySize = 0;
};
bool processPrwInvoke(const uint8_t* data,size_t size,const uint8_t* kernel,size_t kernelSize,
                      const PrwEnvironment& environment,
                      std::vector<uint8_t>& output,std::string& error);
}
