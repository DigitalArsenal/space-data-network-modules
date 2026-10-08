#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
namespace hpop {
// All buffers are complete size-prefixed published PRW records. Validation and
// dynamics return named statuses; expected failures never use C++ exceptions.
// eop: an optional $EOP row or size-prefixed $EOP stream (the
// earth_orientation input); it is required for tesseral gravity.
bool processPrwInvoke(const uint8_t* data,size_t size,const uint8_t* kernel,size_t kernelSize,
                      const uint8_t* earthOrientation,size_t earthOrientationSize,
                      const uint8_t* spaceWeather,size_t spaceWeatherSize,
                      std::vector<uint8_t>& output,std::string& error);
}
