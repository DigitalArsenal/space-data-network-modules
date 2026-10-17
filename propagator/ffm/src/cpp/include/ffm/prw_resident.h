#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace ffm {
// One verified, arena-relative input frame of a resident method and the
// port that supplied it.
struct ResidentInput {
    std::string port;
    const uint8_t* data;
    size_t size;
};
// Public SDK adapters pass verified, arena-relative PRW payloads here. The
// resident implementation never consumes the retired StreamInvoke pointer ABI.
bool processPrwResident(
    const std::string& methodId,
    const std::vector<ResidentInput>& inputs,
    uint32_t outputCap,
    std::vector<std::vector<uint8_t>>& outputs,
    uint64_t& backlog,
    bool& yielded,
    std::string& error);
}
