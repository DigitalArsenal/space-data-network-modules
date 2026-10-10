// "css-oem-zip": China Manned Space Agency (CMSE / BACC) weekly Tiangong
// ephemeris, www.cmse.gov.cn/gfgg/zgkjzgdcs/: a zip holding a CCSDS OEM in KVN
// text. Spec: CCSDS 502.0-B-3 Orbit Data Messages, section 5 (OEM): META_START
// ... META_STOP blocks (section 5.2.4), data lines "epoch x y z vx vy vz
// [ax ay az]" in km and km/s (5.2.5), optional COVARIANCE_START/STOP blocks
// (5.2.6, skipped), COMMENT lines (5.2.3).
//
// One RawSeries per distinct (OBJECT_NAME, OBJECT_ID, REF_FRAME, TIME_SYSTEM);
// each META block is a segment. REF_FRAME and TIME_SYSTEM are reported exactly
// as written. COMMENT lines announcing a maneuver or event go to events, with
// the epoch written in the comment, else the epoch of the next data line.
#include <cctype>

#include "formats_support.hpp"

namespace odhpop::formats::detail {
namespace {

constexpr std::size_t kZipLimit = 128u * 1024 * 1024;

bool digits_at(std::string_view s, std::size_t i, std::size_t n) {
  if (i + n > s.size()) return false;
  for (std::size_t k = 0; k < n; ++k)
    if (!std::isdigit(static_cast<unsigned char>(s[i + k]))) return false;
  return true;
}

// The first "YYYY-MM-DDTHH:MM:SS[.f]" / "YYYY-DDDTHH:MM:SS[.f]" (a space may
// replace the T) written in `text`; empty when there is none.
std::string epoch_in(std::string_view text) {
  for (std::size_t i = 0; i + 17 <= text.size(); ++i) {
    if (!digits_at(text, i, 4) || text[i + 4] != '-') continue;
    std::size_t j = i + 5;
    if (digits_at(text, j, 2) && j + 2 < text.size() && text[j + 2] == '-') {
      if (!digits_at(text, j + 3, 2)) continue;
      j += 5;
    } else if (digits_at(text, j, 3)) {
      j += 3;
    } else {
      continue;
    }
    if (j >= text.size() || (text[j] != 'T' && text[j] != ' ')) continue;
    ++j;
    if (!digits_at(text, j, 2) || j + 2 >= text.size() || text[j + 2] != ':' || !digits_at(text, j + 3, 2) ||
        j + 5 >= text.size() || text[j + 5] != ':' || !digits_at(text, j + 6, 2))
      continue;
    j += 8;
    if (j < text.size() && text[j] == '.') {
      ++j;
      while (j < text.size() && std::isdigit(static_cast<unsigned char>(text[j]))) ++j;
    }
    std::string e(text.substr(i, j - i));
    if (e[e.find_first_of("T ", 4)] == ' ') e[e.find(' ', 4)] = 'T';
    return e;
  }
  return {};
}

bool announces_event(std::string_view text) {
  const std::string u = upper(text);
  for (const char* k : {"MANEUVER", "MANOEUVRE", "BURN", "THRUST", "DELTA-V", "DELTA V", "DELTAV", "REBOOST", "ATTITUDE",
                        "DOCKING", "UNDOCKING", "ENGINE", "EVENT", "ORBIT CONTROL", "ORBIT RAISE"})
    if (u.find(k) != std::string::npos) return true;
  return false;
}

std::string key_value(std::string_view line, std::string_view* value) {
  const std::size_t eq = line.find('=');
  if (eq == std::string_view::npos) return {};
  *value = trim(line.substr(eq + 1));
  return upper(trim(line.substr(0, eq)));
}

// Parses one OEM; false with *error set on failure. Appends to `objects`.
bool parse_oem(const uint8_t* bytes, std::size_t size, int* segment_counter,
               std::vector<RawSeries>* objects, std::string* error) {
  const std::vector<std::string_view> lines = lines_of(bytes, size);
  bool in_meta = false, in_cov = false, saw_data = false;
  std::string name, id, frame, scale, center;
  RawSeries* series = nullptr;
  int segment = 0;
  std::vector<RawEvent> pending;  // announced events; an empty epoch takes the next data epoch
  auto flush_pending = [&](const std::string& data_epoch) {
    for (RawEvent& ev : pending) {
      if (ev.epoch.empty()) ev.epoch = data_epoch;
      series->events.push_back(ev);
    }
    pending.clear();
  };

  for (std::size_t n = 0; n < lines.size(); ++n) {
    const std::string_view line = trim(lines[n]);
    if (line.empty()) continue;
    const std::string where = " (line " + std::to_string(n + 1) + ")";
    if (starts_with(line, "COMMENT")) {
      const std::string_view text = trim(line.substr(7));
      if (announces_event(text)) pending.push_back({epoch_in(text), std::string(text)});
      continue;
    }
    if (line == "META_START") {
      in_meta = true;
      name.clear(); id.clear(); frame.clear(); scale.clear(); center.clear();
      series = nullptr;
      continue;
    }
    if (line == "META_STOP") {
      if (!in_meta) { *error = "META_STOP without META_START" + where; return false; }
      in_meta = false;
      if (frame.empty() || scale.empty()) { *error = "META block without REF_FRAME/TIME_SYSTEM" + where; return false; }
      if (!center.empty() && upper(center) != "EARTH") { *error = "unsupported-center: CENTER_NAME=" + center + where; return false; }
      for (RawSeries& s : *objects)
        if (s.object_name == name && s.object_id == id && s.frame == frame && s.scale == scale) series = &s;
      if (!series) {
        objects->emplace_back();
        series = &objects->back();
        series->object_name = name;
        series->object_id = id;
        series->frame = frame;
        series->scale = scale;
        long long norad;
        if (to_int(id, &norad) && norad > 0) series->norad_cat_id = static_cast<int>(norad);
      }
      segment = (*segment_counter)++;
      continue;
    }
    if (line == "COVARIANCE_START") { in_cov = true; continue; }
    if (line == "COVARIANCE_STOP") { in_cov = false; continue; }
    if (in_cov) continue;
    if (in_meta) {
      std::string_view value;
      const std::string key = key_value(line, &value);
      if (key == "OBJECT_NAME") name = std::string(value);
      else if (key == "OBJECT_ID") id = std::string(value);
      else if (key == "REF_FRAME") frame = std::string(value);
      else if (key == "TIME_SYSTEM") scale = std::string(value);
      else if (key == "CENTER_NAME") center = std::string(value);
      continue;
    }
    if (line.find('=') != std::string_view::npos) continue;  // header keywords
    // A data line.
    if (!series) { *error = "data line outside a META block" + where; return false; }
    const std::vector<std::string_view> t = tokens(line);
    if (t.size() != 7 && t.size() != 10) { *error = "OEM data line needs 7 or 10 fields" + where; return false; }
    RawSample s;
    s.epoch = std::string(t[0]);
    if (!digits_at(t[0], 0, 4) || t[0][4] != '-') { *error = "bad OEM epoch " + s.epoch + where; return false; }
    for (int k = 0; k < 3; ++k)
      if (!to_double(t[1 + k], &s.r_km[k]) || !to_double(t[4 + k], &s.v_km[k])) {
        *error = "bad OEM state component" + where;
        return false;
      }
    s.segment = segment;
    series->samples.push_back(s);
    saw_data = true;
    flush_pending(s.epoch);
  }
  if (!saw_data) { *error = "OEM holds no data lines"; return false; }
  // Comments after the last data line of a series.
  if (series && !pending.empty() && !series->samples.empty()) flush_pending(series->samples.back().epoch);
  return true;
}

}  // namespace

ParseResult parse_css_oem_zip(const uint8_t* bytes, std::size_t size) {
  std::vector<ZipMember> members;
  const std::string e = unzip(bytes, size, kZipLimit, &members);
  if (!e.empty()) return failure("parse-failed", "zip: " + e);
  std::vector<const ZipMember*> oems;
  for (const ZipMember& m : members) {
    const std::string_view head(reinterpret_cast<const char*>(m.data.data()), m.data.size() < 4096 ? m.data.size() : 4096);
    if (head.find("CCSDS_OEM_VERS") != std::string_view::npos) oems.push_back(&m);
  }
  if (oems.empty()) return failure("parse-failed", "zip holds no CCSDS OEM KVN member");
  for (std::size_t i = 1; i < oems.size(); ++i)  // name order, as the getter picks
    for (std::size_t j = i; j > 0 && oems[j]->name < oems[j - 1]->name; --j) std::swap(oems[j], oems[j - 1]);
  ParseResult r;
  int segments = 0;
  for (const ZipMember* m : oems) {
    std::string err;
    if (!parse_oem(m->data.data(), m->data.size(), &segments, &r.objects, &err))
      return failure(err.rfind("unsupported-center", 0) == 0 ? "unsupported-center" : "parse-failed",
                     m->name + ": " + err);
  }
  r.ok = true;
  return r;
}

}  // namespace odhpop::formats::detail
