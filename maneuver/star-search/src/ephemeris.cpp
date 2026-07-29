#include "ephemeris.hpp"

#include <cmath>
#include <cstring>

namespace star_search {
namespace {

class Reader {
  public:
    Reader(const std::uint8_t* bytes, std::size_t size) : bytes_(bytes), size_(size), offset_(0U) {}

    bool raw(void* output, std::size_t count) {
        if (output == nullptr || count > size_ - (offset_ <= size_ ? offset_ : size_)) {
            return false;
        }
        std::memcpy(output, bytes_ + offset_, count);
        offset_ += count;
        return true;
    }

    bool u32(std::uint32_t* output) {
        std::uint8_t value[4]{};
        if (!raw(value, sizeof(value)) || output == nullptr) {
            return false;
        }
        *output = static_cast<std::uint32_t>(value[0]) |
                  (static_cast<std::uint32_t>(value[1]) << 8U) |
                  (static_cast<std::uint32_t>(value[2]) << 16U) |
                  (static_cast<std::uint32_t>(value[3]) << 24U);
        return true;
    }

    bool i32(std::int32_t* output) {
        std::uint32_t value = 0U;
        if (!u32(&value) || output == nullptr) {
            return false;
        }
        std::memcpy(output, &value, sizeof(value));
        return true;
    }

    bool u64(std::uint64_t* output) {
        std::uint8_t value[8]{};
        if (!raw(value, sizeof(value)) || output == nullptr) {
            return false;
        }
        std::uint64_t result = 0U;
        for (std::uint32_t shift = 0U; shift < 64U; shift += 8U) {
            result |= static_cast<std::uint64_t>(value[shift / 8U]) << shift;
        }
        *output = result;
        return true;
    }

    bool f64(double* output) {
        std::uint64_t bits = 0U;
        if (!u64(&bits) || output == nullptr) {
            return false;
        }
        std::memcpy(output, &bits, sizeof(bits));
        return true;
    }

    bool exhausted() const { return offset_ == size_; }

  private:
    const std::uint8_t* bytes_;
    std::size_t size_;
    std::size_t offset_;
};

const EphemerisBody* find_body(const Ephemeris& ephemeris, std::int32_t body_id) {
    for (std::uint32_t index = 0U; index < ephemeris.body_count; ++index) {
        if (ephemeris.bodies[index].body_id == body_id) {
            return &ephemeris.bodies[index];
        }
    }
    return nullptr;
}

double component(const State6& state, std::size_t index) {
    switch (index) {
        case 0U:
            return state.position_km.x;
        case 1U:
            return state.position_km.y;
        case 2U:
            return state.position_km.z;
        case 3U:
            return state.velocity_km_s.x;
        case 4U:
            return state.velocity_km_s.y;
        default:
            return state.velocity_km_s.z;
    }
}

void set_component(State6* state, std::size_t index, double value) {
    if (index == 0U) {
        state->position_km.x = value;
    } else if (index == 1U) {
        state->position_km.y = value;
    } else if (index == 2U) {
        state->position_km.z = value;
    } else if (index == 3U) {
        state->velocity_km_s.x = value;
    } else if (index == 4U) {
        state->velocity_km_s.y = value;
    } else {
        state->velocity_km_s.z = value;
    }
}

}  // namespace

Status decode_ephemeris(
    const std::uint8_t* bytes,
    std::size_t byte_count,
    std::size_t sample_cap,
    MemoryBudget* budget,
    Ephemeris* output) {
    if (bytes == nullptr || budget == nullptr || output == nullptr || sample_cap == 0U) {
        return Status::InvalidInput;
    }

    char magic[8]{};
    Reader reader(bytes, byte_count);
    std::uint32_t version = 0U;
    std::uint32_t body_count = 0U;
    std::uint64_t total_count = 0U;
    if (!reader.raw(magic, sizeof(magic)) || std::memcmp(magic, "STAREPH\0", 8U) != 0 ||
        !reader.u32(&version) || version != 1U || !reader.u32(&body_count) ||
        !reader.u64(&total_count) || body_count == 0U || body_count > kMaxEphemerisBodies ||
        total_count > sample_cap) {
        return Status::InvalidFormat;
    }

    output->body_count = 0U;
    output->total_sample_count = 0U;
    std::uint64_t observed_total = 0U;
    for (std::uint32_t body_index = 0U; body_index < body_count; ++body_index) {
        EphemerisBody& body = output->bodies[body_index];
        std::uint32_t reserved = 0U;
        std::uint64_t sample_count_u64 = 0U;
        if (!reader.i32(&body.body_id) || !reader.u32(&reserved) || reserved != 0U ||
            !reader.f64(&body.gm_km3_s2) || !reader.f64(&body.mean_radius_km) ||
            !reader.u64(&sample_count_u64) || sample_count_u64 == 0U ||
            sample_count_u64 > sample_cap || sample_count_u64 > total_count ||
            !std::isfinite(body.gm_km3_s2) || body.gm_km3_s2 <= 0.0 ||
            !std::isfinite(body.mean_radius_km) || body.mean_radius_km <= 0.0) {
            return Status::InvalidFormat;
        }
        for (std::uint32_t previous = 0U; previous < body_index; ++previous) {
            if (output->bodies[previous].body_id == body.body_id) {
                return Status::InvalidFormat;
            }
        }
        const std::size_t sample_count = static_cast<std::size_t>(sample_count_u64);
        Status status = body.samples.resize(sample_count, budget);
        if (status != Status::Ok) {
            return status;
        }
        for (std::size_t sample_index = 0U; sample_index < sample_count; ++sample_index) {
            EphemerisSample& sample = body.samples[sample_index];
            if (!reader.f64(&sample.epoch_et_s) ||
                !reader.f64(&sample.state.position_km.x) ||
                !reader.f64(&sample.state.position_km.y) ||
                !reader.f64(&sample.state.position_km.z) ||
                !reader.f64(&sample.state.velocity_km_s.x) ||
                !reader.f64(&sample.state.velocity_km_s.y) ||
                !reader.f64(&sample.state.velocity_km_s.z) ||
                !std::isfinite(sample.epoch_et_s) ||
                !std::isfinite(sample.state.position_km.x) ||
                !std::isfinite(sample.state.position_km.y) ||
                !std::isfinite(sample.state.position_km.z) ||
                !std::isfinite(sample.state.velocity_km_s.x) ||
                !std::isfinite(sample.state.velocity_km_s.y) ||
                !std::isfinite(sample.state.velocity_km_s.z)) {
                return Status::InvalidFormat;
            }
            if (sample_index > 0U &&
                !(body.samples[sample_index - 1U].epoch_et_s < sample.epoch_et_s)) {
                return Status::InvalidFormat;
            }
        }
        observed_total += sample_count_u64;
        output->body_count = body_index + 1U;
    }
    if (observed_total != total_count || !reader.exhausted()) {
        return Status::InvalidFormat;
    }
    output->total_sample_count = total_count;
    return Status::Ok;
}

Status query_ephemeris(
    const Ephemeris& ephemeris,
    std::int32_t body_id,
    double epoch_et_s,
    State6* output) {
    if (output == nullptr || !std::isfinite(epoch_et_s)) {
        return Status::InvalidInput;
    }
    const EphemerisBody* body = find_body(ephemeris, body_id);
    if (body == nullptr) {
        return Status::EphemerisBodyNotFound;
    }
    const std::size_t count = body->samples.size();
    if (count == 0U || epoch_et_s < body->samples[0U].epoch_et_s ||
        epoch_et_s > body->samples[count - 1U].epoch_et_s) {
        return Status::EphemerisOutOfRange;
    }

    std::size_t low = 0U;
    std::size_t high = count;
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2U;
        if (body->samples[middle].epoch_et_s < epoch_et_s) {
            low = middle + 1U;
        } else {
            high = middle;
        }
    }
    if (low < count && body->samples[low].epoch_et_s == epoch_et_s) {
        *output = body->samples[low].state;
        return Status::Ok;
    }

    const std::size_t width = count < 8U ? count : 8U;
    std::size_t start = low > width / 2U ? low - width / 2U : 0U;
    if (start + width > count) {
        start = count - width;
    }

    State6 interpolated{};
    for (std::size_t axis = 0U; axis < 6U; ++axis) {
        double sum = 0.0;
        for (std::size_t local_i = 0U; local_i < width; ++local_i) {
            const std::size_t i = start + local_i;
            const double ti = body->samples[i].epoch_et_s;
            double basis = 1.0;
            for (std::size_t local_j = 0U; local_j < width; ++local_j) {
                if (local_j == local_i) {
                    continue;
                }
                const double tj = body->samples[start + local_j].epoch_et_s;
                basis *= (epoch_et_s - tj) / (ti - tj);
            }
            sum += component(body->samples[i].state, axis) * basis;
        }
        set_component(&interpolated, axis, sum);
    }
    *output = interpolated;
    return Status::Ok;
}

Status ephemeris_body_constants(
    const Ephemeris& ephemeris,
    std::int32_t body_id,
    double* gm_km3_s2,
    double* mean_radius_km) {
    if (gm_km3_s2 == nullptr || mean_radius_km == nullptr) {
        return Status::InvalidInput;
    }
    const EphemerisBody* body = find_body(ephemeris, body_id);
    if (body == nullptr) {
        return Status::EphemerisBodyNotFound;
    }
    *gm_km3_s2 = body->gm_km3_s2;
    *mean_radius_km = body->mean_radius_km;
    return Status::Ok;
}

}  // namespace star_search
