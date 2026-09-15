#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
namespace hpop {
// All buffers are complete size-prefixed published PRW records. Validation and
// dynamics return named statuses; expected failures never use C++ exceptions.
bool processPrwInvoke(const uint8_t* data,size_t size,const uint8_t* kernel,size_t kernelSize,
                      std::vector<uint8_t>& output,std::string& error);
}
