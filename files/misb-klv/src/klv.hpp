// MISB ST 0601 UAS Datalink Local Set: the fields a frame's ground footprint
// needs, decoded with the standard's own linear mappings, error values
// treated as absent, and the packet refused when its checksum (tag 1) does
// not match. Corner order on output: lower left, lower right, upper right,
// upper left of the image (ST 0601 numbers them from the upper left,
// clockwise).
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

namespace klv {

// 06 0E 2B 34 - 02 0B 01 01 - 0E 01 03 01 - 01 00 00 00
constexpr uint8_t kUasLsKey[16] = {0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01,
                                   0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00};

struct Packet {
  std::optional<uint64_t> timestampUs;  // tag 2, microseconds since 1970 (UTC)
  std::string platform;                 // tag 10
  std::string sensor;                   // tag 11
  std::optional<double> heading, pitch, roll;            // 5, 6/90, 7/91 (degrees)
  std::optional<double> sensorLat, sensorLon;            // 13, 14
  std::optional<double> sensorAltMsl, sensorAltHae;      // 15, 75 (m)
  std::optional<double> hfov, vfov;                      // 16, 17
  std::optional<double> sensorAz, sensorEl, sensorRoll;  // 18, 19, 20
  std::optional<double> slantRange;                      // 21
  std::optional<double> centerLat, centerLon, centerElev;  // 23, 24, 25
  std::optional<double> offsetLat[4], offsetLon[4];        // 26-33 (points 1-4)
  std::optional<double> cornerLat[4], cornerLon[4];        // 82-89 (points 1-4)
  std::optional<int> version;                              // 65
};

inline uint16_t checksum(const uint8_t* p, size_t n) {
  uint16_t bcc = 0;
  for (size_t i = 0; i < n; ++i) bcc = uint16_t(bcc + (uint16_t(p[i]) << (8 * ((i + 1) % 2))));
  return bcc;
}

// BER length at p (short or long form); returns bytes used, 0 on error.
inline size_t berLength(const uint8_t* p, size_t n, size_t* length) {
  if (n < 1) return 0;
  if (p[0] < 0x80) {
    *length = p[0];
    return 1;
  }
  const size_t count = p[0] & 0x7F;
  if (count == 0 || count > 4 || count + 1 > n) return 0;
  size_t v = 0;
  for (size_t i = 0; i < count; ++i) v = (v << 8) | p[1 + i];
  *length = v;
  return count + 1;
}

// BER-OID tag; returns bytes used, 0 on error.
inline size_t berOid(const uint8_t* p, size_t n, uint32_t* tag) {
  uint32_t v = 0;
  for (size_t i = 0; i < n && i < 4; ++i) {
    v = (v << 7) | (p[i] & 0x7F);
    if (!(p[i] & 0x80)) {
      *tag = v;
      return i + 1;
    }
  }
  return 0;
}

inline uint64_t be(const uint8_t* p, size_t n) {
  uint64_t v = 0;
  for (size_t i = 0; i < n; ++i) v = (v << 8) | p[i];
  return v;
}

inline int64_t signedBe(const uint8_t* p, size_t n) {
  const uint64_t v = be(p, n);
  const uint64_t sign = uint64_t(1) << (8 * n - 1);
  return (v & sign) ? int64_t(v) - int64_t(sign << 1) : int64_t(v);
}

// Unsigned value * range / (2^(8n) - 1) + offset.
inline double mapUnsigned(const uint8_t* p, size_t n, double range, double offset) {
  const double max = std::ldexp(1.0, int(8 * n)) - 1.0;
  return double(be(p, n)) * range / max + offset;
}

// Signed value * range / (2^(8n) - 2), the error value (the most negative) absent.
inline std::optional<double> mapSigned(const uint8_t* p, size_t n, double range) {
  const int64_t v = signedBe(p, n);
  const int64_t error = -(int64_t(1) << (8 * n - 1));
  if (v == error) return std::nullopt;
  const double max = std::ldexp(1.0, int(8 * n)) - 2.0;
  return double(v) * range / max;
}

// One packet starting at the UAS LS key. Returns bytes consumed (0 when this
// is not a packet); `out` is filled only when the checksum matches.
inline size_t decode(const uint8_t* p, size_t n, Packet* out, bool* valid) {
  *valid = false;
  if (n < 18 || std::memcmp(p, kUasLsKey, 16) != 0) return 0;
  size_t length = 0;
  const size_t lb = berLength(p + 16, n - 16, &length);
  if (!lb || 16 + lb + length > n) return 0;
  const size_t total = 16 + lb + length;
  const uint8_t* v = p + 16 + lb;
  Packet pkt;
  bool sawChecksum = false;
  size_t i = 0;
  while (i < length) {
    uint32_t tag = 0;
    const size_t tb = berOid(v + i, length - i, &tag);
    if (!tb) return total;
    size_t len = 0;
    const size_t lb2 = berLength(v + i + tb, length - i - tb, &len);
    if (!lb2 || i + tb + lb2 + len > length) return total;
    const uint8_t* d = v + i + tb + lb2;
    switch (tag) {
      case 1: {
        if (len != 2) return total;
        // The sum runs from the key through the checksum's length byte.
        const size_t covered = size_t(d - p);
        if (checksum(p, covered) != uint16_t(be(d, 2))) return total;
        sawChecksum = true;
        break;
      }
      case 2:
        if (len == 8) pkt.timestampUs = be(d, 8);
        break;
      case 5:
        if (len == 2) pkt.heading = mapUnsigned(d, 2, 360.0, 0.0);
        break;
      case 6:
        if (len == 2) pkt.pitch = mapSigned(d, 2, 40.0);
        break;
      case 7:
        if (len == 2) pkt.roll = mapSigned(d, 2, 100.0);
        break;
      case 10:
        pkt.platform.assign(reinterpret_cast<const char*>(d), len);
        break;
      case 11:
        pkt.sensor.assign(reinterpret_cast<const char*>(d), len);
        break;
      case 13:
        if (len == 4) pkt.sensorLat = mapSigned(d, 4, 180.0);
        break;
      case 14:
        if (len == 4) pkt.sensorLon = mapSigned(d, 4, 360.0);
        break;
      case 15:
        if (len == 2) pkt.sensorAltMsl = mapUnsigned(d, 2, 19900.0, -900.0);
        break;
      case 16:
        if (len == 2) pkt.hfov = mapUnsigned(d, 2, 180.0, 0.0);
        break;
      case 17:
        if (len == 2) pkt.vfov = mapUnsigned(d, 2, 180.0, 0.0);
        break;
      case 18:
        if (len == 4) pkt.sensorAz = mapUnsigned(d, 4, 360.0, 0.0);
        break;
      case 19:
        if (len == 4) pkt.sensorEl = mapSigned(d, 4, 360.0);
        break;
      case 20:
        if (len == 4) pkt.sensorRoll = mapUnsigned(d, 4, 360.0, 0.0);
        break;
      case 21:
        if (len == 4) pkt.slantRange = mapUnsigned(d, 4, 5000000.0, 0.0);
        break;
      case 23:
        if (len == 4) pkt.centerLat = mapSigned(d, 4, 180.0);
        break;
      case 24:
        if (len == 4) pkt.centerLon = mapSigned(d, 4, 360.0);
        break;
      case 25:
        if (len == 2) pkt.centerElev = mapUnsigned(d, 2, 19900.0, -900.0);
        break;
      case 26: case 28: case 30: case 32:
        if (len == 2) pkt.offsetLat[(tag - 26) / 2] = mapSigned(d, 2, 0.15);
        break;
      case 27: case 29: case 31: case 33:
        if (len == 2) pkt.offsetLon[(tag - 27) / 2] = mapSigned(d, 2, 0.15);
        break;
      case 65:
        if (len == 1) pkt.version = d[0];
        break;
      case 75:
        if (len == 2) pkt.sensorAltHae = mapUnsigned(d, 2, 19900.0, -900.0);
        break;
      case 82: case 84: case 86: case 88:
        if (len == 4) pkt.cornerLat[(tag - 82) / 2] = mapSigned(d, 4, 180.0);
        break;
      case 83: case 85: case 87: case 89:
        if (len == 4) pkt.cornerLon[(tag - 83) / 2] = mapSigned(d, 4, 360.0);
        break;
      case 90:
        if (len == 4) pkt.pitch = mapSigned(d, 4, 180.0);
        break;
      case 91:
        if (len == 4) pkt.roll = mapSigned(d, 4, 180.0);
        break;
      default:
        break;
    }
    i += tb + lb2 + len;
  }
  if (!sawChecksum) return total;
  *out = std::move(pkt);
  *valid = true;
  return total;
}

}  // namespace klv
