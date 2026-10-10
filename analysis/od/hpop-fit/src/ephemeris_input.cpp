#include "ephemeris_input.hpp"

#include <algorithm>
#include <cctype>
#include <string>

#include "formats/formats.hpp"
#include "od/meme_parser.h"
#include "od/oem_fb_reader.h"
#include "od/oem_parser.h"
#include "../../../../files/orbit-products/src/sha256.hpp"

namespace odhpop {

std::string sha256_hex(const uint8_t* bytes, std::size_t size) { return ephem::sha256_hex(bytes, size); }

namespace {

std::string upper_compact(const std::string& token) {
  std::string u;
  for (char c : token) {
    if (c == ' ' || c == '_' || c == '-' || c == '(' || c == ')') continue;
    u.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(c))));
  }
  return u;
}

enum class Axes { GCRF, EME2000, TEME, ITRF, UNSUPPORTED };

Axes axes_of(const std::string& token) {
  const std::string u = upper_compact(token);
  if (u == "GCRF" || u == "ICRF") return Axes::GCRF;
  if (u == "EME2000" || u == "J2000") return Axes::EME2000;
  if (u == "TEME" || u == "TEMEOFDATE" || u == "TRUEEQUATORMEANEQUINOX") return Axes::TEME;
  return od::classify_frame(token) == od::FrameKind::Ecef ? Axes::ITRF : Axes::UNSUPPORTED;
}

ReadResult fail(const std::string& code, const std::string& message) {
  ReadResult r;
  r.error_code = code;
  r.error_message = message;
  return r;
}

// One source sample (km, km/s, source axes) into both working frames.
bool place(Axes axes, const UtcEpoch& t, const double r_km[3], const double v_km[3], bool has_velocity,
           const EarthOrientation* eop, Sample* s, std::string* error) {
  double r[3] = {r_km[0] * 1e3, r_km[1] * 1e3, r_km[2] * 1e3};
  double v[3] = {v_km[0] * 1e3, v_km[1] * 1e3, v_km[2] * 1e3};
  std::array<double, 3> rg{}, vg{};
  switch (axes) {
    case Axes::GCRF:
      rg = {r[0], r[1], r[2]};
      vg = {v[0], v[1], v[2]};
      break;
    case Axes::EME2000: {
      static const Mat3 bias = eme2000_to_gcrf();
      rg = rotate(bias, r);
      vg = rotate(bias, v);
      break;
    }
    case Axes::TEME: {
      const Mat3 m = transpose(gcrf_to_teme(t));
      rg = rotate(m, r);
      vg = rotate(m, v);
      break;
    }
    case Axes::ITRF: {
      if (!eop || !eop->loaded()) {
        *error = "eop-data-required: an Earth-fixed ephemeris needs earth_orientation";
        return false;
      }
      double ro[3], vo[3];
      if (!eop->itrf_to_gcrf(t, r, v, ro, vo, error)) return false;
      rg = {ro[0], ro[1], ro[2]};
      // Position-only: the rotation term alone is not a velocity.
      vg = has_velocity ? std::array<double, 3>{vo[0], vo[1], vo[2]} : std::array<double, 3>{0, 0, 0};
      break;
    }
    default:
      *error = "unsupported-frame";
      return false;
  }
  s->t = t;
  s->has_velocity = has_velocity;
  for (int i = 0; i < 3; ++i) {
    s->gcrf_m[i] = rg[i];
    s->gcrf_m[3 + i] = vg[i];
  }
  const Mat3 teme = gcrf_to_teme(t);
  const auto rt = rotate(teme, rg.data());
  const auto vt = rotate(teme, vg.data());
  for (int i = 0; i < 3; ++i) {
    s->teme_km[i] = rt[i] * 1e-3;
    s->teme_km[3 + i] = vt[i] * 1e-3;
  }
  return true;
}

ReadResult from_source(const od::OEMSourceResult& src, const std::string& format, const EarthOrientation* eop) {
  if (!src.ok) return fail(src.error_code, src.error_message);
  ReadResult out;
  Ephemeris& e = out.ephemeris;
  e.format = format;
  e.source_frame = src.series.meta.source_frame;
  e.time_system = src.series.meta.time_system;
  e.object_name = src.series.meta.object_name;
  e.object_id = src.series.meta.object_id;
  e.norad_cat_id = src.series.meta.norad_cat_id;
  e.segment_count = src.series.meta.segment_count;
  e.position_only = src.series.meta.position_only;
  const Axes axes = axes_of(e.source_frame);
  if (axes == Axes::UNSUPPORTED) return fail("unsupported-frame", "REF_FRAME=" + e.source_frame);
  for (const auto& s : src.series.samples) {
    UtcEpoch t;
    if (!parse_epoch(s.epoch, e.time_system, s.offset_s, &t))
      return fail("parse-failed", "epoch " + s.epoch + " on " + e.time_system);
    Sample x;
    std::string error;
    if (!place(axes, t, s.r, s.v, s.has_velocity, eop, &x, &error)) return fail(error, error);
    x.segment = s.segment;
    e.samples.push_back(x);
  }
  out.ok = true;
  return out;
}

}  // namespace

namespace {

ReadResult from_provider(const std::string& format, const uint8_t* bytes, std::size_t size,
                         const EarthOrientation* eop, const ObjectSelector& select) {
  formats::ParseResult p = formats::parse(format, bytes, size);
  if (!p.ok) return fail(p.error_code, p.error_message);
  const formats::RawSeries* chosen = nullptr;
  for (const auto& o : p.objects) {
    const bool match = (select.norad_cat_id > 0 && o.norad_cat_id == select.norad_cat_id) ||
                       (!select.object_name.empty() && o.object_name == select.object_name) ||
                       (!select.object_id.empty() && o.object_id == select.object_id);
    if (match) {
      chosen = &o;
      break;
    }
  }
  if (!chosen) {
    if (p.objects.size() != 1) {
      std::string names;
      for (std::size_t i = 0; i < p.objects.size() && i < 20; ++i)
        names += (i ? ", " : "") + (p.objects[i].norad_cat_id ? std::to_string(p.objects[i].norad_cat_id) : p.objects[i].object_name);
      return fail("object-selector-required", std::to_string(p.objects.size()) + " objects (" + names + "); select one by noradCatId, objectName or objectId");
    }
    chosen = &p.objects.front();
  }
  ReadResult out;
  Ephemeris& e = out.ephemeris;
  e.format = format;
  e.source_frame = chosen->frame;
  e.time_system = chosen->scale;
  e.object_name = chosen->object_name;
  e.object_id = chosen->object_id;
  e.norad_cat_id = chosen->norad_cat_id;
  const Axes axes = axes_of(e.source_frame);
  if (axes == Axes::UNSUPPORTED) return fail("unsupported-frame", "frame " + e.source_frame);
  bool any_velocity = false;
  int segments = 0;
  for (const auto& s : chosen->samples) {
    UtcEpoch t;
    if (!parse_epoch(s.epoch, e.time_system, s.offset_s, &t)) return fail("parse-failed", "epoch " + s.epoch + " on " + e.time_system);
    Sample x;
    std::string error;
    if (!place(axes, t, s.r_km, s.v_km, s.has_velocity, eop, &x, &error)) return fail(error, error);
    x.segment = s.segment;
    segments = std::max(segments, s.segment + 1);
    any_velocity = any_velocity || s.has_velocity;
    e.samples.push_back(x);
  }
  e.segment_count = segments;
  e.position_only = !any_velocity;
  for (const auto& ev : chosen->events) {
    UtcEpoch t;
    if (parse_epoch(ev.epoch, e.time_system, 0.0, &t)) e.events.push_back({t, ev.text});
  }
  out.ok = true;
  return out;
}

}  // namespace

ReadResult read_ephemeris(const uint8_t* bytes, std::size_t size, const std::string& format_in,
                          const EarthOrientation* eop, const ObjectSelector& select) {
  std::string format = format_in;
  if (format.empty()) {
    if (od::is_oem_flatbuffer(bytes, size)) format = "oem-fb";
    else format = od::looks_like_oem(std::string(reinterpret_cast<const char*>(bytes), std::min<std::size_t>(size, 4096))) ? "oem" : "meme";
  }
  ReadResult out;
  if (format == "oem-fb") {
    out = from_source(od::read_oem_flatbuffer_source(bytes, size), format, eop);
  } else if (format == "oem") {
    out = from_source(od::parse_oem_source(std::string(reinterpret_cast<const char*>(bytes), size)), format, eop);
  } else if (format == "meme") {
    const od::MEMEFile meme = od::parse_meme(std::string(reinterpret_cast<const char*>(bytes), size));
    if (meme.points.empty()) return fail("parse-failed", "MEME payload did not contain any ephemeris points.");
    Ephemeris& e = out.ephemeris;
    e.format = format;
    e.source_frame = "EME2000";  // MEME states are EME2000; UVW names the covariance frame
    e.time_system = "UTC";
    e.object_name = meme.header.object_name;
    e.object_id = meme.header.cospar_id;
    e.norad_cat_id = meme.header.norad_cat_id;
    for (const auto& p : meme.points) {
      UtcEpoch t;
      if (!parse_meme_utc(p.timestamp_str, &t)) return fail("parse-failed", "MEME epoch " + p.timestamp_str);
      const double r[3] = {p.x, p.y, p.z}, v[3] = {p.vx, p.vy, p.vz};
      Sample x;
      std::string error;
      if (!place(Axes::EME2000, t, r, v, true, eop, &x, &error)) return fail(error, error);
      e.samples.push_back(x);
    }
    out.ok = true;
  } else {
    const auto known = formats::formats();
    if (std::find(known.begin(), known.end(), format) == known.end())
      return fail("unsupported-input-format", "inputFormat " + format);
    out = from_provider(format, bytes, size, eop, select);
  }
  if (!out.ok) return out;
  auto& samples = out.ephemeris.samples;
  std::stable_sort(samples.begin(), samples.end(), [](const Sample& a, const Sample& b) {
    return seconds_between(b.t, a.t) < 0;
  });
  // Drop exact duplicate epochs (segment boundaries repeat their seam).
  std::vector<Sample> unique;
  for (const auto& s : samples)
    if (unique.empty() || seconds_between(unique.back().t, s.t) > 1e-6) unique.push_back(s);
  samples.swap(unique);
  if (samples.size() < 4) return fail("empty-ephemeris", "fewer than four states");
  return out;
}

}  // namespace odhpop
