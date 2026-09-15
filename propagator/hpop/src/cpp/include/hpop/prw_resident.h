#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace hpop {
// Public SDK adapters pass verified, arena-relative PRW payloads here. The
// resident implementation never consumes the retired StreamInvoke pointer ABI.
bool processPrwResident(
    const std::string& methodId,
    const std::vector<std::pair<const uint8_t*, size_t>>& inputs,
    uint32_t outputCap,
    std::vector<std::vector<uint8_t>>& outputs,
    uint64_t& backlog,
    bool& yielded,
    std::string& error);
}
