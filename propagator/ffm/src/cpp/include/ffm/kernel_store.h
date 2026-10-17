#pragma once
// The JPL SPK kernels a module instance keeps. A PRW.NATIVE_INPUT kernel is
// verified once: its declared SHA-256 against its bytes, and the DAF it
// holds. A later input with the same SHA-256 and length whose bytes equal a
// kept copy is not hashed again (one comparison of the bytes instead). The
// ephemeris reads the kept copy, so a resident instance's kernel outlives the
// invocation that supplied it.
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ffm {

class KernelStore {
public:
    using Bytes = std::shared_ptr<const std::vector<uint8_t>>;
    // The kept kernel of a PRW NATIVE_INPUT frame (verified, or matched to a
    // kept copy). `resident`: the copy serves a resident instance; otherwise
    // it replaces the previous execution kernel.
    Bytes accept(const uint8_t* frame, size_t size, bool resident, std::string& error);
    // The active ephemeris: `kernel`, or the analytical series for nullptr.
    static bool activate(const Bytes& kernel, std::string& error);
private:
    struct Entry { std::string sha256; Bytes bytes; };
    Entry resident_, execution_;
};

// The instance's store (one per module instance).
KernelStore& instanceKernels();

} // namespace ffm
