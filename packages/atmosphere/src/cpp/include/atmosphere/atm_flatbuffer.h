#ifndef ATMOSPHERE_ATM_FLATBUFFER_H
#define ATMOSPHERE_ATM_FLATBUFFER_H

/**
 * $ATM FlatBuffer Schema — Atmosphere Data Exchange Format
 *
 * This is the wire format for atmospheric data on the SDN bus.
 * Plugins produce/consume this format via shared memory.
 *
 * Layout (little-endian, 8-byte aligned):
 *
 *   Offset  Size  Type     Field
 *   0       4     char[4]  File identifier "$ATM"
 *   4       4     uint32   Version (1)
 *   8       4     uint32   Model enum (0=US76, 1=NRLMSISE00, 2=CUSTOM)
 *   12      4     uint32   Num records
 *   16      N*80  Record[] Records array
 *
 * Record (80 bytes, 8-byte aligned):
 *   Offset  Size  Type     Field
 *   0       8     float64  altitude_m      Geometric altitude [m]
 *   8       8     float64  latitude_rad    Geodetic latitude [rad]
 *   16      8     float64  longitude_rad   Geodetic longitude [rad]
 *   24      8     float64  density         Mass density [kg/m³]
 *   32      8     float64  temperature     Temperature [K]
 *   40      8     float64  pressure        Pressure [Pa]
 *   48      8     float64  speed_of_sound  Speed of sound [m/s]
 *   56      8     float64  wind_north      Wind N component [m/s]
 *   64      8     float64  wind_east       Wind E component [m/s]
 *   72      8     float64  wind_down       Wind D component [m/s]
 *
 * Query format (for requesting atmosphere at specific points):
 *   Same header, but Records contain only (altitude, lat, lon).
 *   Response fills in the remaining fields.
 */

#include <cstdint>
#include <cstring>
#include <vector>
#include "types.h"
#include "models.h"

namespace atmosphere {

// File identifier
static constexpr char ATM_FILE_ID[4] = {'$', 'A', 'T', 'M'};
static constexpr uint32_t ATM_VERSION = 1;
static constexpr size_t ATM_HEADER_SIZE = 16;
static constexpr size_t ATM_RECORD_SIZE = 80;

// Model identifier in binary
enum class AtmModelId : uint32_t {
    US76      = 0,
    NRLMSISE00 = 1,
    CUSTOM    = 2,
};

// Single atmosphere record (wire format, 80 bytes)
struct __attribute__((packed)) AtmRecord {
    double altitude_m;
    double latitude_rad;
    double longitude_rad;
    double density;
    double temperature;
    double pressure;
    double speed_of_sound;
    double wind_north;
    double wind_east;
    double wind_down;
};
static_assert(sizeof(AtmRecord) == ATM_RECORD_SIZE, "AtmRecord must be 80 bytes");

// Header (wire format, 16 bytes)
struct __attribute__((packed)) AtmHeader {
    char     file_id[4];
    uint32_t version;
    uint32_t model;
    uint32_t num_records;
};
static_assert(sizeof(AtmHeader) == ATM_HEADER_SIZE, "AtmHeader must be 16 bytes");

// ---------------------------------------------------------------------------
// Serialize: State → $ATM binary
// ---------------------------------------------------------------------------

inline std::vector<uint8_t> serializeAtm(const std::vector<std::pair<GeoPos, State>>& data,
                                          Model model = Model::US76) {
    size_t bufSize = ATM_HEADER_SIZE + data.size() * ATM_RECORD_SIZE;
    std::vector<uint8_t> buf(bufSize);

    AtmHeader hdr;
    std::memcpy(hdr.file_id, ATM_FILE_ID, 4);
    hdr.version = ATM_VERSION;
    hdr.model = (model == Model::NRLMSISE00) ? 1 : 0;
    hdr.num_records = static_cast<uint32_t>(data.size());
    std::memcpy(buf.data(), &hdr, ATM_HEADER_SIZE);

    for (size_t i = 0; i < data.size(); ++i) {
        AtmRecord rec{};
        rec.altitude_m = data[i].first.alt_m;
        rec.latitude_rad = data[i].first.lat_rad;
        rec.longitude_rad = data[i].first.lon_rad;
        rec.density = data[i].second.density;
        rec.temperature = data[i].second.temperature;
        rec.pressure = data[i].second.pressure;
        rec.speed_of_sound = data[i].second.soundSpeed;
        // Wind not yet implemented
        rec.wind_north = 0;
        rec.wind_east = 0;
        rec.wind_down = 0;
        std::memcpy(buf.data() + ATM_HEADER_SIZE + i * ATM_RECORD_SIZE,
                    &rec, ATM_RECORD_SIZE);
    }

    return buf;
}

// Serialize a single query → response
inline std::vector<uint8_t> serializeSingle(double alt_m, Model model = Model::US76) {
    State s = getAtmosphere(alt_m, model);
    GeoPos pos{0, 0, alt_m};
    std::vector<std::pair<GeoPos, State>> data = {{pos, s}};
    return serializeAtm(data, model);
}

// ---------------------------------------------------------------------------
// Deserialize: $ATM binary → records
// ---------------------------------------------------------------------------

struct AtmResult {
    bool valid = false;
    uint32_t model = 0;
    std::vector<AtmRecord> records;
};

inline AtmResult deserializeAtm(const uint8_t* data, size_t len) {
    AtmResult result;
    if (len < ATM_HEADER_SIZE) return result;

    AtmHeader hdr;
    std::memcpy(&hdr, data, ATM_HEADER_SIZE);

    if (std::memcmp(hdr.file_id, ATM_FILE_ID, 4) != 0) return result;
    if (hdr.version != ATM_VERSION) return result;

    size_t expectedSize = ATM_HEADER_SIZE + hdr.num_records * ATM_RECORD_SIZE;
    if (len < expectedSize) return result;

    result.valid = true;
    result.model = hdr.model;
    result.records.resize(hdr.num_records);

    for (uint32_t i = 0; i < hdr.num_records; ++i) {
        std::memcpy(&result.records[i],
                    data + ATM_HEADER_SIZE + i * ATM_RECORD_SIZE,
                    ATM_RECORD_SIZE);
    }

    return result;
}

}  // namespace atmosphere

#endif  // ATMOSPHERE_ATM_FLATBUFFER_H
