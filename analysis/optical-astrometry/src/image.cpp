// Frame decoding: FITS (NASA/IAU FITS Standard 4.0, primary HDU, BITPIX 8,
// 16, 32, -32, -64 with BZERO/BSCALE) and binary PGM (Netpbm P5, 8 or 16 bit).
// Pixels become floats, row 0 the first row stored. FITS header cards are
// kept as text for DATE-OBS, EXPTIME and the site keywords.
namespace oa {

struct Image {
  int width = 0;
  int height = 0;
  double saturation = 255.0;     // largest representable value after scaling
  std::vector<float> pixels;     // row-major
  std::map<std::string, std::string> header;  // FITS cards (keyword -> raw value text)
  float at(int x, int y) const { return pixels[static_cast<size_t>(y) * width + x]; }
};

namespace detail {
inline bool pgm_token(const uint8_t* p, size_t n, size_t* at, long* value) {
  while (*at < n) {
    if (p[*at] == '#') {
      while (*at < n && p[*at] != '\n') ++*at;
    } else if (std::isspace(p[*at])) {
      ++*at;
    } else {
      break;
    }
  }
  if (*at >= n || !std::isdigit(p[*at])) return false;
  long v = 0;
  while (*at < n && std::isdigit(p[*at])) v = v * 10 + (p[(*at)++] - '0');
  *value = v;
  return true;
}
inline std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(' ');
  size_t b = s.find_last_not_of(' ');
  return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}
}  // namespace detail

inline bool decode_pgm(const uint8_t* p, size_t n, Image* out, std::string* error) {
  if (n < 2 || p[0] != 'P' || p[1] != '5') { *error = "not a binary PGM (P5)"; return false; }
  size_t at = 2;
  long w = 0, h = 0, maxval = 0;
  if (!detail::pgm_token(p, n, &at, &w) || !detail::pgm_token(p, n, &at, &h) || !detail::pgm_token(p, n, &at, &maxval) ||
      w <= 0 || h <= 0 || maxval <= 0 || maxval > 65535) {
    *error = "PGM header unreadable";
    return false;
  }
  ++at;  // the single whitespace after maxval
  const size_t bytes = maxval > 255 ? 2 : 1;
  if (n < at + static_cast<size_t>(w) * h * bytes) { *error = "PGM truncated"; return false; }
  out->width = static_cast<int>(w);
  out->height = static_cast<int>(h);
  out->saturation = static_cast<double>(maxval);
  out->pixels.resize(static_cast<size_t>(w) * h);
  for (size_t i = 0; i < out->pixels.size(); ++i)
    out->pixels[i] = bytes == 1 ? p[at + i] : static_cast<float>((p[at + 2 * i] << 8) | p[at + 2 * i + 1]);
  return true;
}

inline bool decode_fits(const uint8_t* p, size_t n, Image* out, std::string* error) {
  if (n < 2880 || std::memcmp(p, "SIMPLE  =", 9) != 0) { *error = "not a FITS primary HDU"; return false; }
  size_t at = 0;
  bool ended = false;
  while (!ended && at + 80 <= n) {
    const std::string card(reinterpret_cast<const char*>(p + at), 80);
    at += 80;
    const std::string key = detail::trim(card.substr(0, 8));
    if (key == "END") { ended = true; break; }
    if (card.size() > 9 && card[8] == '=' ) {
      std::string value = card.substr(10);
      // Strip a trailing comment outside quotes.
      bool quoted = false;
      for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] == '\'') quoted = !quoted;
        if (value[i] == '/' && !quoted) { value = value.substr(0, i); break; }
      }
      value = detail::trim(value);
      if (value.size() >= 2 && value.front() == '\'' && value.back() == '\'') value = detail::trim(value.substr(1, value.size() - 2));
      out->header[key] = value;
    }
  }
  if (!ended) { *error = "FITS header has no END card"; return false; }
  const size_t data = ((at + 2879) / 2880) * 2880;
  auto num = [&](const char* k, double fallback) {
    const auto it = out->header.find(k);
    return it == out->header.end() ? fallback : std::atof(it->second.c_str());
  };
  const int bitpix = static_cast<int>(num("BITPIX", 0));
  const int naxis = static_cast<int>(num("NAXIS", 0));
  const long w = static_cast<long>(num("NAXIS1", 0));
  const long h = static_cast<long>(num("NAXIS2", 0));
  if (naxis < 2 || (naxis == 3 && num("NAXIS3", 1) != 1) || naxis > 3 || w <= 0 || h <= 0) {
    *error = "FITS image must be two-dimensional";
    return false;
  }
  const double bzero = num("BZERO", 0), bscale = num("BSCALE", 1);
  const size_t bytes = static_cast<size_t>(std::abs(bitpix) / 8);
  if (!(bitpix == 8 || bitpix == 16 || bitpix == 32 || bitpix == -32 || bitpix == -64)) { *error = "unsupported BITPIX"; return false; }
  if (n < data + static_cast<size_t>(w) * h * bytes) { *error = "FITS data truncated"; return false; }
  out->width = static_cast<int>(w);
  out->height = static_cast<int>(h);
  out->pixels.resize(static_cast<size_t>(w) * h);
  const uint8_t* d = p + data;
  for (size_t i = 0; i < out->pixels.size(); ++i) {
    const uint8_t* q = d + i * bytes;
    double v = 0;
    if (bitpix == 8) v = q[0];
    else if (bitpix == 16) v = static_cast<int16_t>((q[0] << 8) | q[1]);
    else if (bitpix == 32) v = static_cast<int32_t>((uint32_t(q[0]) << 24) | (uint32_t(q[1]) << 16) | (uint32_t(q[2]) << 8) | q[3]);
    else if (bitpix == -32) { uint32_t u = (uint32_t(q[0]) << 24) | (uint32_t(q[1]) << 16) | (uint32_t(q[2]) << 8) | q[3]; float f; std::memcpy(&f, &u, 4); v = f; }
    else { uint64_t u = 0; for (int k = 0; k < 8; ++k) u = (u << 8) | q[k]; double f; std::memcpy(&f, &u, 8); v = f; }
    out->pixels[i] = static_cast<float>(bzero + bscale * v);
  }
  const double datamax = num("DATAMAX", kNaN);
  const double satlevel = num("SATURATE", kNaN);
  if (std::isfinite(satlevel)) out->saturation = satlevel;
  else if (std::isfinite(datamax)) out->saturation = datamax;
  else if (bitpix == 8) out->saturation = bzero + bscale * 255;
  else if (bitpix == 16) out->saturation = bzero + bscale * 32767;
  else out->saturation = std::numeric_limits<double>::infinity();
  return true;
}

inline bool decode_image(const uint8_t* p, size_t n, Image* out, std::string* error) {
  if (n >= 2 && p[0] == 'P' && p[1] == '5') return decode_pgm(p, n, out, error);
  if (n >= 9 && std::memcmp(p, "SIMPLE  =", 9) == 0) return decode_fits(p, n, out, error);
  *error = "frame is neither FITS nor binary PGM";
  return false;
}

}  // namespace oa
