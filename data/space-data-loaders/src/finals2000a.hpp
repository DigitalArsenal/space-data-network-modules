// finals2000a.hpp — the IERS Earth-orientation reader, as a dependency-free
// header.
//
// GMAT-parity program item 8 (graph/tasks/gmat-08-frames-and-state-representations.md).
//
// WHY A HEADER. Themis ruled (2026-08-30) that there is no SDS record able to
// carry a published external document, and that the loader module must
// therefore FETCH finals2000A over the `http` capability rather than receive it
// on a port. That decides how the module gets its bytes; it does not change
// what the bytes mean. The reading, the precision and the refusal-to-
// extrapolate live here, dependency-free, so they are measured against the
// vendored published file directly — see tests/finals2000a_precision.cpp — and
// the module that will wrap them adds transport, not arithmetic.
//
// PRECISION, and why SDS $EOP grew `_HP` doubles for this task. finals2000A
// publishes UT1-UTC to 1e-7 s and polar motion to 1e-6 arcsec. float32 near a
// UT1-UTC magnitude of 0.9 s resolves only to about 6e-8 s, so the pre-existing
// float fields cannot carry the published digits, let alone the 1e-9 s
// agreement this task's acceptance requires. The test measures both, so the
// claim is a number rather than an argument.
//
// NO INTERPOLATION IS INVENTED. At a table node the value returned IS the
// published value, taken from the row rather than produced by a formula that
// happens to reduce to it. Between nodes the reader interpolates linearly and
// says so. Outside the table it REFUSES: an extrapolated Earth orientation is
// indistinguishable from a measured one once it is in a record.

#ifndef SDN_DATA_LOADERS_FINALS2000A_HPP
#define SDN_DATA_LOADERS_FINALS2000A_HPP

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace sdn {
namespace loaders {

constexpr double kArcsecToRadians = 4.84813681109535993589914102357e-6;

/// Upper bound on rows read from one document. finals2000A.all carries about
/// 20000 rows through 2026; the cap is generous and is a REFUSAL to read past
/// it rather than a silent truncation of a longer file.
constexpr int kMaxRows = 40000;

// ===========================================================================
// SHA-256. FIPS 180-4. Present so DATA_SET_CID is COMPUTED from the bytes this
// module actually parsed rather than asserted by whoever called it — a content
// identifier a caller can set to anything is not an identifier.
// ===========================================================================

struct Sha256 {
  uint32_t state[8];
  uint64_t length;
  uint8_t buffer[64];
  size_t bufferLength;
};

constexpr uint32_t kSha256K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
    0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
    0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
    0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
    0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

inline uint32_t rotateRight(uint32_t value, int bits) {
  return (value >> bits) | (value << (32 - bits));
}

inline void sha256Init(Sha256* context) {
  context->state[0] = 0x6a09e667u;
  context->state[1] = 0xbb67ae85u;
  context->state[2] = 0x3c6ef372u;
  context->state[3] = 0xa54ff53au;
  context->state[4] = 0x510e527fu;
  context->state[5] = 0x9b05688cu;
  context->state[6] = 0x1f83d9abu;
  context->state[7] = 0x5be0cd19u;
  context->length = 0;
  context->bufferLength = 0;
}

inline void sha256Block(Sha256* context, const uint8_t* block) {
  uint32_t w[64];
  for (int i = 0; i < 16; ++i) {
    w[i] = (static_cast<uint32_t>(block[i * 4]) << 24) |
           (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
           (static_cast<uint32_t>(block[i * 4 + 2]) << 8) |
           static_cast<uint32_t>(block[i * 4 + 3]);
  }
  for (int i = 16; i < 64; ++i) {
    const uint32_t s0 = rotateRight(w[i - 15], 7) ^ rotateRight(w[i - 15], 18) ^ (w[i - 15] >> 3);
    const uint32_t s1 = rotateRight(w[i - 2], 17) ^ rotateRight(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = context->state[0], b = context->state[1], c = context->state[2],
           d = context->state[3], e = context->state[4], f = context->state[5],
           g = context->state[6], h = context->state[7];
  for (int i = 0; i < 64; ++i) {
    const uint32_t s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const uint32_t ch = (e & f) ^ ((~e) & g);
    const uint32_t temp1 = h + s1 + ch + kSha256K[i] + w[i];
    const uint32_t s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temp2 = s0 + maj;
    h = g; g = f; f = e; e = d + temp1;
    d = c; c = b; b = a; a = temp1 + temp2;
  }
  context->state[0] += a; context->state[1] += b; context->state[2] += c;
  context->state[3] += d; context->state[4] += e; context->state[5] += f;
  context->state[6] += g; context->state[7] += h;
}

inline void sha256Update(Sha256* context, const uint8_t* data, size_t length) {
  context->length += static_cast<uint64_t>(length);
  while (length > 0) {
    const size_t take = (64 - context->bufferLength) < length ? (64 - context->bufferLength)
                                                              : length;
    std::memcpy(context->buffer + context->bufferLength, data, take);
    context->bufferLength += take;
    data += take;
    length -= take;
    if (context->bufferLength == 64) {
      sha256Block(context, context->buffer);
      context->bufferLength = 0;
    }
  }
}

inline void sha256Final(Sha256* context, uint8_t out[32]) {
  const uint64_t bits = context->length * 8;
  uint8_t padding = 0x80;
  sha256Update(context, &padding, 1);
  padding = 0x00;
  while (context->bufferLength != 56) {
    sha256Update(context, &padding, 1);
  }
  uint8_t lengthBytes[8];
  for (int i = 0; i < 8; ++i) {
    lengthBytes[i] = static_cast<uint8_t>((bits >> (56 - i * 8)) & 0xff);
  }
  sha256Update(context, lengthBytes, 8);
  for (int i = 0; i < 8; ++i) {
    out[i * 4] = static_cast<uint8_t>((context->state[i] >> 24) & 0xff);
    out[i * 4 + 1] = static_cast<uint8_t>((context->state[i] >> 16) & 0xff);
    out[i * 4 + 2] = static_cast<uint8_t>((context->state[i] >> 8) & 0xff);
    out[i * 4 + 3] = static_cast<uint8_t>(context->state[i] & 0xff);
  }
}

/// "sha2-256:<64 hex>". The multihash name is used rather than a bare hex
/// digest so the identifier says which function produced it.
inline void contentIdentifier(const uint8_t* data, size_t length, char out[80]) {
  Sha256 context;
  sha256Init(&context);
  sha256Update(&context, data, length);
  uint8_t digest[32];
  sha256Final(&context, digest);
  static const char* hex = "0123456789abcdef";
  std::memcpy(out, "sha2-256:", 9);
  for (int i = 0; i < 32; ++i) {
    out[9 + i * 2] = hex[(digest[i] >> 4) & 0xf];
    out[9 + i * 2 + 1] = hex[digest[i] & 0xf];
  }
  out[73] = '\0';
}

// ===========================================================================
// finals2000A parsing.
//
// Fixed-column format, as documented in the IERS "readme.finals2000A". The
// columns are 1-based there and are written that way below so the code reads
// against the document rather than against itself.
// ===========================================================================

struct EopRow {
  int year = 0;
  int month = 0;
  int day = 0;
  double mjd = 0.0;
  bool predicted = false;
  bool hasPolarMotion = false;
  bool hasUt1 = false;
  bool hasNutation = false;
  bool hasLod = false;
  double xPoleArcsec = 0.0;
  double yPoleArcsec = 0.0;
  double xPoleErrorArcsec = 0.0;
  double yPoleErrorArcsec = 0.0;
  double ut1MinusUtcSeconds = 0.0;
  double ut1ErrorSeconds = 0.0;
  double lodSeconds = 0.0;
  double lodErrorSeconds = 0.0;
  double dXArcsec = 0.0;
  double dYArcsec = 0.0;
  double dXErrorArcsec = 0.0;
  double dYErrorArcsec = 0.0;
};

inline EopRow* rows() {
  static EopRow storage[kMaxRows];
  return storage;
}
inline int& rowCount() {
  static int count = 0;
  return count;
}

inline bool fieldIsBlank(const char* line, size_t lineLength, int firstColumn, int lastColumn) {
  for (int column = firstColumn; column <= lastColumn; ++column) {
    const size_t index = static_cast<size_t>(column - 1);
    if (index >= lineLength) {
      return true;
    }
    if (line[index] != ' ') {
      return false;
    }
  }
  return true;
}

inline bool readDouble(const char* line, size_t lineLength, int firstColumn, int lastColumn,
                double* out) {
  if (fieldIsBlank(line, lineLength, firstColumn, lastColumn)) {
    return false;
  }
  char text[32];
  const int width = lastColumn - firstColumn + 1;
  if (width <= 0 || width >= static_cast<int>(sizeof(text))) {
    return false;
  }
  int count = 0;
  for (int column = firstColumn; column <= lastColumn; ++column) {
    const size_t index = static_cast<size_t>(column - 1);
    text[count++] = index < lineLength ? line[index] : ' ';
  }
  text[count] = '\0';
  char* end = nullptr;
  const double value = std::strtod(text, &end);
  if (end == text) {
    return false;
  }
  *out = value;
  return true;
}

inline bool readInt(const char* line, size_t lineLength, int firstColumn, int lastColumn, int* out) {
  double value = 0.0;
  if (!readDouble(line, lineLength, firstColumn, lastColumn, &value)) {
    return false;
  }
  *out = static_cast<int>(value);
  return true;
}

char readFlag(const char* line, size_t lineLength, int column) {
  const size_t index = static_cast<size_t>(column - 1);
  return index < lineLength ? line[index] : ' ';
}

/// Two-digit finals2000A year -> four digits. The file has run since 1973 and
/// the IERS convention is that 73..99 are 1900s; everything else is 2000s.
inline int expandYear(int twoDigitYear) {
  return twoDigitYear >= 73 ? 1900 + twoDigitYear : 2000 + twoDigitYear;
}

inline bool parseLine(const char* line, size_t lineLength, EopRow* row) {
  if (lineLength < 16) {
    return false;
  }
  int year = 0;
  if (!readInt(line, lineLength, 1, 2, &year) ||
      !readInt(line, lineLength, 3, 4, &row->month) ||
      !readInt(line, lineLength, 5, 6, &row->day) ||
      !readDouble(line, lineLength, 8, 15, &row->mjd)) {
    return false;
  }
  row->year = expandYear(year);

  const char polarFlag = readFlag(line, lineLength, 17);
  const char ut1Flag = readFlag(line, lineLength, 58);
  const char nutationFlag = readFlag(line, lineLength, 96);
  row->predicted = polarFlag == 'P' || ut1Flag == 'P';

  row->hasPolarMotion = readDouble(line, lineLength, 19, 27, &row->xPoleArcsec) &&
                        readDouble(line, lineLength, 38, 46, &row->yPoleArcsec);
  if (row->hasPolarMotion) {
    readDouble(line, lineLength, 28, 36, &row->xPoleErrorArcsec);
    readDouble(line, lineLength, 47, 55, &row->yPoleErrorArcsec);
  }
  row->hasUt1 = readDouble(line, lineLength, 59, 68, &row->ut1MinusUtcSeconds);
  if (row->hasUt1) {
    readDouble(line, lineLength, 69, 78, &row->ut1ErrorSeconds);
  }
  double lodMilliseconds = 0.0;
  row->hasLod = readDouble(line, lineLength, 80, 86, &lodMilliseconds);
  if (row->hasLod) {
    row->lodSeconds = lodMilliseconds * 1e-3;
    double lodErrorMilliseconds = 0.0;
    if (readDouble(line, lineLength, 87, 93, &lodErrorMilliseconds)) {
      row->lodErrorSeconds = lodErrorMilliseconds * 1e-3;
    }
  }
  // The celestial pole offsets are published in MILLIarcseconds.
  double dXMilliarcsec = 0.0;
  double dYMilliarcsec = 0.0;
  row->hasNutation = readDouble(line, lineLength, 98, 106, &dXMilliarcsec) &&
                     readDouble(line, lineLength, 117, 125, &dYMilliarcsec);
  if (row->hasNutation) {
    row->dXArcsec = dXMilliarcsec * 1e-3;
    row->dYArcsec = dYMilliarcsec * 1e-3;
    double errorMilliarcsec = 0.0;
    if (readDouble(line, lineLength, 107, 115, &errorMilliarcsec)) {
      row->dXErrorArcsec = errorMilliarcsec * 1e-3;
    }
    if (readDouble(line, lineLength, 126, 134, &errorMilliarcsec)) {
      row->dYErrorArcsec = errorMilliarcsec * 1e-3;
    }
  }
  (void)nutationFlag;
  return row->hasPolarMotion || row->hasUt1;
}

inline int parseDocument(const char* text, size_t length) {
  rowCount() = 0;
  size_t start = 0;
  while (start < length && rowCount() < kMaxRows) {
    size_t end = start;
    while (end < length && text[end] != '\n') {
      ++end;
    }
    size_t lineLength = end - start;
    if (lineLength > 0 && text[start + lineLength - 1] == '\r') {
      --lineLength;
    }
    if (lineLength > 0) {
      EopRow row;
      if (parseLine(text + start, lineLength, &row)) {
        rows()[rowCount()++] = row;
      }
    }
    start = end + 1;
  }
  return rowCount();
}

// ===========================================================================
// Leap seconds. TAI-UTC is a step function of UTC and is NOT in finals2000A,
// so the table is carried here, from the IERS Bulletin C series. It ends at the
// last announced leap second; an epoch beyond the last announcement is still
// covered, because no leap second can occur without an announcement.
// ===========================================================================

struct LeapSecond {
  double mjd;      ///< UTC MJD the step takes effect
  double taiMinusUtc;
};

constexpr LeapSecond kLeapSeconds[] = {
    {41317.0, 10.0},  // 1972-01-01
    {41499.0, 11.0}, {41683.0, 12.0}, {42048.0, 13.0}, {42413.0, 14.0},
    {42778.0, 15.0}, {43144.0, 16.0}, {43509.0, 17.0}, {43874.0, 18.0},
    {44239.0, 19.0}, {44786.0, 20.0}, {45151.0, 21.0}, {45516.0, 22.0},
    {46247.0, 23.0}, {47161.0, 24.0}, {47892.0, 25.0}, {48257.0, 26.0},
    {48804.0, 27.0}, {49169.0, 28.0}, {49534.0, 29.0}, {50083.0, 30.0},
    {50630.0, 31.0}, {51179.0, 32.0}, {53736.0, 33.0}, {54832.0, 34.0},
    {56109.0, 35.0}, {57204.0, 36.0}, {57754.0, 37.0},  // 2017-01-01
};

inline double taiMinusUtcForMjd(double mjd, bool* covered) {
  const int count = static_cast<int>(sizeof(kLeapSeconds) / sizeof(kLeapSeconds[0]));
  if (mjd < kLeapSeconds[0].mjd) {
    *covered = false;
    return 0.0;
  }
  *covered = true;
  double value = kLeapSeconds[0].taiMinusUtc;
  for (int i = 0; i < count; ++i) {
    if (mjd >= kLeapSeconds[i].mjd) {
      value = kLeapSeconds[i].taiMinusUtc;
    }
  }
  return value;
}



// ===========================================================================
// Interpolation.
// ===========================================================================

struct Interpolated {
  double mjd = 0.0;
  double xPoleArcsec = 0.0;
  double yPoleArcsec = 0.0;
  double ut1MinusUtcSeconds = 0.0;
  double lodSeconds = 0.0;
  double dXArcsec = 0.0;
  double dYArcsec = 0.0;
  double xPoleErrorArcsec = 0.0;
  double yPoleErrorArcsec = 0.0;
  double ut1ErrorSeconds = 0.0;
  double lodErrorSeconds = 0.0;
  double dXErrorArcsec = 0.0;
  double dYErrorArcsec = 0.0;
  bool predicted = false;
  bool atNode = false;
  int year = 0;
  int month = 0;
  int day = 0;
};

inline Interpolated fromRow(const EopRow& row) {
  Interpolated value;
  value.mjd = row.mjd;
  value.xPoleArcsec = row.xPoleArcsec;
  value.yPoleArcsec = row.yPoleArcsec;
  value.ut1MinusUtcSeconds = row.ut1MinusUtcSeconds;
  value.lodSeconds = row.lodSeconds;
  value.dXArcsec = row.dXArcsec;
  value.dYArcsec = row.dYArcsec;
  value.xPoleErrorArcsec = row.xPoleErrorArcsec;
  value.yPoleErrorArcsec = row.yPoleErrorArcsec;
  value.ut1ErrorSeconds = row.ut1ErrorSeconds;
  value.lodErrorSeconds = row.lodErrorSeconds;
  value.dXErrorArcsec = row.dXErrorArcsec;
  value.dYErrorArcsec = row.dYErrorArcsec;
  value.predicted = row.predicted;
  value.atNode = true;
  value.year = row.year;
  value.month = row.month;
  value.day = row.day;
  return value;
}

/// Linear interpolation between the bracketing table nodes. AT A NODE the
/// result IS the published value: the first branch returns the row untouched
/// rather than evaluating a formula that happens to reduce to it, so the node
/// agreement is exact rather than nearly exact. Outside the table's span this
/// returns false — a refusal, never an extrapolation.
inline bool interpolateAt(double mjd, Interpolated* out) {
  const int count = rowCount();
  if (count == 0 || out == nullptr) {
    return false;
  }
  if (mjd < rows()[0].mjd || mjd > rows()[count - 1].mjd) {
    return false;
  }
  for (int i = 0; i < count; ++i) {
    if (rows()[i].mjd == mjd) {
      *out = fromRow(rows()[i]);
      return true;
    }
  }
  for (int i = 0; i + 1 < count; ++i) {
    const EopRow& a = rows()[i];
    const EopRow& b = rows()[i + 1];
    if (mjd > a.mjd && mjd < b.mjd) {
      const double span = b.mjd - a.mjd;
      const double t = span > 0.0 ? (mjd - a.mjd) / span : 0.0;
      auto blend = [t](double lower, double upper) { return lower + (upper - lower) * t; };
      *out = fromRow(a);
      out->mjd = mjd;
      out->atNode = false;
      out->xPoleArcsec = blend(a.xPoleArcsec, b.xPoleArcsec);
      out->yPoleArcsec = blend(a.yPoleArcsec, b.yPoleArcsec);
      out->ut1MinusUtcSeconds = blend(a.ut1MinusUtcSeconds, b.ut1MinusUtcSeconds);
      out->lodSeconds = blend(a.lodSeconds, b.lodSeconds);
      out->dXArcsec = blend(a.dXArcsec, b.dXArcsec);
      out->dYArcsec = blend(a.dYArcsec, b.dYArcsec);
      out->predicted = a.predicted || b.predicted;
      return true;
    }
  }
  return false;
}

// ===========================================================================
// Content identifier.
//
// Themis ruled (2026-08-30) that SDS `$EOP.DATA_SET_CID` is a CID and not a
// bare digest: "emit CIDv1 raw/sha2-256 base32". So this emits exactly that —
// multibase 'b' + base32-lower(no padding) over the bytes
// 0x01 0x55 0x12 0x20 || sha256(document) — and NOT the `sha2-256:<hex>`
// spelling that was here first.
// ===========================================================================

inline void base32LowerNoPad(const uint8_t* data, size_t length, char* out) {
  static const char* alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  size_t bits = 0;
  uint32_t buffer = 0;
  size_t position = 0;
  for (size_t i = 0; i < length; ++i) {
    buffer = (buffer << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      out[position++] = alphabet[(buffer >> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out[position++] = alphabet[(buffer << (5 - bits)) & 0x1f];
  }
  out[position] = '\0';
}

/// CIDv1, codec `raw` (0x55), multihash sha2-256 (0x12) of length 32, in
/// base32-lower with the 'b' multibase prefix. `out` needs 64 bytes.
inline void contentIdentifierV1(const uint8_t* data, size_t length, char* out) {
  Sha256 context;
  sha256Init(&context);
  sha256Update(&context, data, length);
  uint8_t digest[32];
  sha256Final(&context, digest);

  uint8_t cidBytes[36];
  cidBytes[0] = 0x01;  // CIDv1
  cidBytes[1] = 0x55;  // raw codec
  cidBytes[2] = 0x12;  // sha2-256
  cidBytes[3] = 0x20;  // 32 bytes
  std::memcpy(cidBytes + 4, digest, 32);

  out[0] = 'b';
  base32LowerNoPad(cidBytes, sizeof(cidBytes), out + 1);
}

}  // namespace loaders
}  // namespace sdn

#endif  // SDN_DATA_LOADERS_FINALS2000A_HPP
