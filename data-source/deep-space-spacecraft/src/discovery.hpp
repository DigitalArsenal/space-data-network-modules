#pragma once
// Discovery: which objects are current in cislunar space, from listings rather
// than a roster. Horizons' spacecraft listing names candidates; a one-day
// geocentric probe at the run's day admits a candidate when it is current and
// inside the cislunar bounds of regime.hpp. NAIF directory indexes name the
// newest mission kernels; spice.hpp turns their segments into rows.
#include "regime.hpp"
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

namespace discovery {
constexpr const char* kListingUrl =
    "https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND=%27MB%27";
// Admission: Earth distance >= 60,000 km (Earth-orbit catalogs own nearer
// objects) and either <= 500,000 km or within 120,000 km of the Moon.
constexpr double kMoonNeighborhood = regime::kLunarLagrangeRadius;
constexpr int64_t kMoonStep = 300, kEarthStep = 900;

struct Listed { int id; std::string name, designation, aliases; };

inline std::string trim(const std::string& s) { return horizons::trim(s); }
inline std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

// The Horizons "MB" listing: columns follow the dash ruler under the header.
inline bool parseListing(const std::string& text, std::vector<Listed>& out, std::string& error) {
  out.clear(); error.clear();
  const size_t header = text.find("ID#");
  const size_t rulerStart = header == std::string::npos ? header : text.find('\n', header);
  if (rulerStart == std::string::npos) { error = "invalid-horizons-listing"; return false; }
  const size_t rulerEnd = text.find('\n', rulerStart + 1);
  if (rulerEnd == std::string::npos) { error = "invalid-horizons-listing"; return false; }
  const std::string ruler = text.substr(rulerStart + 1, rulerEnd - rulerStart - 1);
  std::vector<size_t> starts;
  for (size_t i = 0; i < ruler.size(); ++i) if (ruler[i] == '-' && (i == 0 || ruler[i - 1] == ' ')) starts.push_back(i);
  if (starts.size() != 4) { error = "invalid-horizons-listing"; return false; }
  // A column runs from its ruler start to the next column's start (names may fill the separator).
  const auto field = [&](const std::string& line, size_t column) {
    const size_t a = column == 0 ? 0 : starts[column];
    const size_t b = column + 1 < starts.size() ? starts[column + 1] : line.size();
    return a >= line.size() ? std::string() : trim(line.substr(a, std::min(b, line.size()) - a));
  };
  size_t at = rulerEnd + 1;
  while (at < text.size()) {
    size_t end = text.find('\n', at);
    if (end == std::string::npos) end = text.size();
    std::string line = text.substr(at, end - at);
    at = end + 1;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const std::string idText = field(line, 0);
    if (idText.empty() || idText[0] != '-') continue;
    char* stop = nullptr;
    const long id = std::strtol(idText.c_str(), &stop, 10);
    if (*stop || id >= 0 || id < -2147483647L) continue;
    Listed item{int(id), field(line, 1), field(line, 2), field(line, 3)};
    const std::string name = lower(item.name);
    if (item.name.empty() || name.find("(simulation)") != std::string::npos || name.rfind("neocp", 0) == 0) continue;
    if (std::any_of(out.begin(), out.end(), [&](const Listed& l) { return l.id == item.id; })) continue;
    // Horizons truncates the name column; drop the trailing "(spacecraft..." tag.
    const size_t tag = name.find("(spacec");
    if (tag != std::string::npos) item.name = trim(item.name.substr(0, tag));
    out.push_back(std::move(item));
  }
  if (out.empty()) { error = "empty-horizons-listing"; return false; }
  return true;
}

// The name check for a discovered target: its first word (Horizons' own label).
inline std::string targetName(const std::string& name) {
  const std::string l = lower(name);
  const size_t end = l.find_first_of(" (");
  return end == std::string::npos ? l : l.substr(0, end);
}

enum class Admission { Moon, Earth, NearEarth, Beyond };
inline Admission admit(int64_t time, const regime::Vec& geocentric) {
  const double distance = regime::norm(geocentric);
  if (distance < regime::kEarthExclusion) return Admission::NearEarth;
  const double moon = regime::norm(regime::minus(geocentric, regime::moon(double(time))));
  if (moon <= kMoonNeighborhood) return Admission::Moon;
  return distance <= regime::kCislunarRadius ? Admission::Earth : Admission::Beyond;
}

struct IndexEntry { std::string name, date; double bytes; };
// An Apache directory index: <a href="x.bsp">x.bsp</a>   YYYY-MM-DD HH:MM  7.3M
inline bool parseIndex(const std::string& html, std::vector<IndexEntry>& out, std::string& error) {
  out.clear(); error.clear();
  if (html.find("Index of") == std::string::npos) { error = "invalid-kernel-index"; return false; }
  size_t at = 0;
  while ((at = html.find("<a href=\"", at)) != std::string::npos) {
    at += 9;
    const size_t quote = html.find('"', at);
    if (quote == std::string::npos) break;
    const std::string name = html.substr(at, quote - at);
    const size_t close = html.find("</a>", quote);
    const size_t eol = html.find('\n', quote);
    at = quote;
    if (close == std::string::npos || eol == std::string::npos || close > eol) continue;
    if (name.size() < 5 || lower(name.substr(name.size() - 4)) != ".bsp" ||
        name.find_first_of("/?#%&:") != std::string::npos) continue;
    const std::string tail = trim(html.substr(close + 4, eol - close - 4));
    if (tail.size() < 18 || tail[4] != '-' || tail[7] != '-' || tail[13] != ':') continue;
    const std::string size = trim(tail.substr(16));
    char* stop = nullptr;
    double bytes = std::strtod(size.c_str(), &stop);
    if (stop == size.c_str() || !std::isfinite(bytes) || bytes < 0) continue;
    if (*stop == 'K') bytes *= 1024.0; else if (*stop == 'M') bytes *= 1048576.0; else if (*stop == 'G') bytes *= 1073741824.0;
    out.push_back({name, tail.substr(0, 16), bytes});
  }
  return true;
}

// Newest first: listing time, then name, descending; prefix-filtered and size-capped.
inline std::vector<IndexEntry> newest(std::vector<IndexEntry> entries, const std::string& prefix,
                                      size_t count, double maxBytes) {
  entries.erase(std::remove_if(entries.begin(), entries.end(), [&](const IndexEntry& e) {
    return e.name.rfind(prefix, 0) != 0 || e.bytes > maxBytes;
  }), entries.end());
  std::sort(entries.begin(), entries.end(), [](const IndexEntry& a, const IndexEntry& b) {
    return a.date != b.date ? a.date > b.date : a.name > b.name;
  });
  if (entries.size() > count) entries.resize(count);
  return entries;
}
} // namespace discovery
