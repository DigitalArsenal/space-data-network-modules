// -----------------------------------------------------------------------------
// SDS FlatBuffers views and ISO 8601 UTC times. The $OMM boundary,
// `ingest_omm`, is src/ingest_omm.inc.
// -----------------------------------------------------------------------------

#include "oem_generated.h"

namespace sdnap {

/// A plain view (p, n) of an SDS FlatBuffer given plain or size-prefixed: true when the file identifier
/// `ident` sits at the plain position (p + 4) or, after a 4-byte length that fits, at p + 8.
inline bool plain_view(const uint8_t*& p, uint32_t& n, const char* ident) {
  if (p == nullptr || n < 8) return false;
  if (std::memcmp(p + 4, ident, 4) == 0) return true;
  if (n >= 12 && std::memcmp(p + 8, ident, 4) == 0) {
    uint32_t len;
    std::memcpy(&len, p, 4);
    if (len >= 8 && len <= n - 4) {
      p += 4;
      n = len;
      return true;
    }
  }
  return false;
}

/// Verifies the SDS FlatBuffer (p, n) in which plain_view found the view `view`, from where its builder aligned it: a
/// plain buffer from its start, a size-prefixed one from its prefix (VerifySizePrefixedBuffer on the unstripped bytes).
/// A size-prefixed buffer is aligned to its prefix, so a verifier of the view after it finds every 8-byte field 4 bytes
/// off and refuses it.
template <typename T>
inline bool verify_as_given(const uint8_t* p, uint32_t n, const uint8_t* view, const char* ident) {
  flatbuffers::Verifier verifier(p, n);
  return view == p ? verifier.VerifyBuffer<T>(ident) : verifier.VerifySizePrefixedBuffer<T>(ident);
}

namespace omm {

/// Days from 1970-01-01 of a civil date (proleptic Gregorian).
inline int64_t days_from_civil(int64_t y, int64_t m, int64_t d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const int64_t yoe = y - era * 400;
  const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

/// ISO 8601 "YYYY-MM-DDTHH:MM:SS[.f...][Z]" (UTC) to a split Julian date.
inline bool epoch(const char* s, uint32_t n, double& whole, double& frac) {
  auto digits = [&](uint32_t at, uint32_t count, int64_t& v) {
    if (at + count > n) return false;
    v = 0;
    for (uint32_t i = 0; i < count; ++i) {
      const char c = s[at + i];
      if (c < '0' || c > '9') return false;
      v = v * 10 + (c - '0');
    }
    return true;
  };
  int64_t y, mo, d, h = 0, mi = 0, sec = 0;
  if (!digits(0, 4, y) || n < 10 || s[4] != '-' || !digits(5, 2, mo) || s[7] != '-' || !digits(8, 2, d)) return false;
  double fraction = 0.0;
  if (n >= 19 && (s[10] == 'T' || s[10] == ' ')) {
    if (!digits(11, 2, h) || s[13] != ':' || !digits(14, 2, mi) || s[16] != ':' || !digits(17, 2, sec)) return false;
    if (n > 20 && s[19] == '.') {
      double scale = 0.1;
      for (uint32_t i = 20; i < n && s[i] >= '0' && s[i] <= '9'; ++i, scale *= 0.1) fraction += (s[i] - '0') * scale;
    }
  }
  whole = 2440587.5 + static_cast<double>(days_from_civil(y, mo, d));
  frac = (static_cast<double>(h * 3600 + mi * 60 + sec) + fraction) / 86400.0;
  return true;
}

}  // namespace omm
}  // namespace sdnap
