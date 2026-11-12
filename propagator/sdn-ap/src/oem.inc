// -----------------------------------------------------------------------------
// $OEM output: the axes of a frame, ISO 8601 UTC text, the output times. The
// output times of a flight are its $PCF OUTPUT's: EPOCHS, or START_TIME and
// STOP_TIME at STEP_SECONDS (defaults: the set's epoch, one day later, 60 s),
// in OUTPUT.FRAME (TEME by default; GCRF or EME2000); one request holds at
// most OUTPUT.MAXIMUM_STATES states. The `propagate` method is ocm.inc's
// flight, propagate.inc.
// -----------------------------------------------------------------------------

#include <cstdio>
#include <vector>

namespace sdnap {
namespace oem {

constexpr double kDefaultStepSeconds = 60.0;
constexpr size_t kMaxStates = 500000;

/// The axes an RFM declares: by its enumeration (CelestialFrameWrapper), its coordinate system (NAME or
/// AXIS_TYPE) or its NAME; Conflict when two of them disagree; Undeclared when none is given.
enum class Axes { Undeclared, Teme, Gcrf, Eme2000, EarthFixed, Other, Conflict };

inline bool same_text(const char* a, const char* b) {
  for (; *a && *b; ++a, ++b) {
    const char x = (*a >= 'a' && *a <= 'z') ? *a - 32 : *a, y = (*b >= 'a' && *b <= 'z') ? *b - 32 : *b;
    if (x != y) return false;
  }
  return *a == *b;
}

inline Axes axes_of_name(const char* s) {
  if (s == nullptr || *s == 0) return Axes::Undeclared;
  if (same_text(s, "TEME") || same_text(s, "TEMEOFDATE")) return Axes::Teme;
  if (same_text(s, "GCRF") || same_text(s, "ICRF")) return Axes::Gcrf;
  if (same_text(s, "EME2000") || same_text(s, "J2000")) return Axes::Eme2000;
  static const char* const fixed[] = {"ITRF", "ITRF93", "ITRF97", "ITRF2000", "ITRF2005", "ITRF2008", "ITRF2014",
                                      "ITRF2020", "ECEF", "EFG", "WGS84", "FIXED_EARTH"};
  for (const char* f : fixed)
    if (same_text(s, f)) return Axes::EarthFixed;
  return Axes::Other;
}

inline Axes axes_of_celestial(CelestialFrame f) {
  switch (f) {
    case CelestialFrame_GCRF:
    case CelestialFrame_ICRF: return Axes::Gcrf;
    case CelestialFrame_J2000:
    case CelestialFrame_EME2000: return Axes::Eme2000;
    case CelestialFrame_TEMEOFDATE: return Axes::Teme;
    case CelestialFrame_ITRF2000:
    case CelestialFrame_ITRF93:
    case CelestialFrame_ITRF97:
    case CelestialFrame_EFG:
    case CelestialFrame_FIXED_EARTH:
    case CelestialFrame_WGS84: return Axes::EarthFixed;
    default: return Axes::Other;
  }
}

inline Axes axes_of(const RFM* f) {
  if (f == nullptr) return Axes::Undeclared;
  Axes by_union = Axes::Undeclared;
  switch (f->REFERENCE_FRAME_type()) {
    case RFMUnion_NONE: break;
    case RFMUnion_CelestialFrameWrapper:
      if (const auto* w = f->REFERENCE_FRAME_as_CelestialFrameWrapper()) by_union = axes_of_celestial(w->frame());
      break;
    case RFMUnion_RFMCoordinateSystemWrapper:
      if (const auto* w = f->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper(); w != nullptr && w->COORDINATE_SYSTEM() != nullptr) {
        const RFMCoordinateSystem* cs = w->COORDINATE_SYSTEM();
        if (cs->NAME() != nullptr && cs->NAME()->size() > 0) by_union = axes_of_name(cs->NAME()->c_str());
        else if (cs->AXIS_TYPE() == rfmAxisType_ICRF) by_union = Axes::Gcrf;
        else if (cs->AXIS_TYPE() == rfmAxisType_MEAN_EQUATOR_EQUINOX_J2000) by_union = Axes::Eme2000;
        else if (cs->AXIS_TYPE() == rfmAxisType_TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE) by_union = Axes::Teme;
        else if (cs->AXIS_TYPE() != rfmAxisType_UNSPECIFIED) by_union = Axes::Other;
      }
      break;
    default: by_union = Axes::Other;
  }
  const Axes by_name = f->NAME() != nullptr ? axes_of_name(f->NAME()->c_str()) : Axes::Undeclared;
  if (by_union != Axes::Undeclared && by_name != Axes::Undeclared && by_union != by_name) return Axes::Conflict;
  return by_union != Axes::Undeclared ? by_union : by_name;
}

/// The RFM this module writes for TEME, GCRF or EME2000 axes: the enumeration and the NAME.
inline flatbuffers::Offset<RFM> rfm_of(flatbuffers::FlatBufferBuilder& fbb, Axes axes) {
  const CelestialFrame f = axes == Axes::Gcrf ? CelestialFrame_GCRF : axes == Axes::Eme2000 ? CelestialFrame_EME2000 : CelestialFrame_TEMEOFDATE;
  const char* name = axes == Axes::Gcrf ? "GCRF" : axes == Axes::Eme2000 ? "EME2000" : "TEME";
  return CreateRFMDirect(fbb, RFMUnion_CelestialFrameWrapper, CreateCelestialFrameWrapper(fbb, f).Union(), 0, name);
}

struct IsoDayCache {
  int64_t days_p1;
  uint8_t valid_4digit;
  char prefix[12];
};
inline thread_local IsoDayCache g_iso_day_cache{};

/// ISO 8601 UTC text of a split Julian date plus minutes.
inline void iso_text(double jd_whole, double jd_frac, double minutes, char* out, size_t size) {
  static constexpr char kDigits2[201] =
      "0001020304050607080910111213141516171819"
      "2021222324252627282930313233343536373839"
      "4041424344454647484950515253545556575859"
      "6061626364656667686970717273747576777879"
      "8081828384858687888990919293949596979899";
  const double day_offset = (jd_whole - 2440587.5);
  double frac = jd_frac + minutes * (1.0 / kMinutesPerDay);
  const double whole_days = std::floor(frac);
  frac -= whole_days;
  int64_t days = static_cast<int64_t>(day_offset + whole_days);
  int64_t us_day = static_cast<int64_t>(frac * 86400000000.0 + 0.5);
  if (us_day >= 86400000000LL) {
    us_day -= 86400000000LL;
    days += 1;
  } else if (us_day < 0) {
    us_day += 86400000000LL;
    days -= 1;
  }
  if (size >= 27) {
    IsoDayCache& dc = g_iso_day_cache;
    const int64_t dp1 = days + 1;
    if (__builtin_expect(dc.days_p1 != dp1, 0)) {
      int64_t z = days + 719468;
      const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
      const int64_t doe = z - era * 146097;
      const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
      int64_t y = yoe + era * 400;
      const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
      const int64_t mp = (5 * doy + 2) / 153;
      const int64_t d = doy - (153 * mp + 2) / 5 + 1;
      const int64_t m = mp + (mp < 10 ? 3 : -9);
      if (m <= 2) ++y;
      dc.days_p1 = dp1;
      dc.valid_4digit = (y >= 0 && y <= 9999) ? 1u : 0u;
      if (dc.valid_4digit) {
        const uint32_t yy = static_cast<uint32_t>(y);
        const uint32_t y_hi = yy / 100, y_lo = yy - y_hi * 100;
        dc.prefix[0] = kDigits2[2 * y_hi];
        dc.prefix[1] = kDigits2[2 * y_hi + 1];
        dc.prefix[2] = kDigits2[2 * y_lo];
        dc.prefix[3] = kDigits2[2 * y_lo + 1];
        dc.prefix[4] = '-';
        const uint32_t mo = static_cast<uint32_t>(m);
        dc.prefix[5] = kDigits2[2 * mo];
        dc.prefix[6] = kDigits2[2 * mo + 1];
        dc.prefix[7] = '-';
        const uint32_t dy = static_cast<uint32_t>(d);
        dc.prefix[8] = kDigits2[2 * dy];
        dc.prefix[9] = kDigits2[2 * dy + 1];
        dc.prefix[10] = 'T';
      }
    }
    if (dc.valid_4digit) {
      std::memcpy(out, dc.prefix, 11);
      const uint32_t total_sec = static_cast<uint32_t>(us_day / 1000000LL);
      uint32_t us = static_cast<uint32_t>(us_day - static_cast<int64_t>(total_sec) * 1000000LL);
      const uint32_t hh = total_sec / 3600u;
      const uint32_t rem = total_sec - hh * 3600u;
      const uint32_t mm = rem / 60u;
      const uint32_t ss = rem - mm * 60u;
      out[11] = kDigits2[2 * hh];
      out[12] = kDigits2[2 * hh + 1];
      out[13] = ':';
      out[14] = kDigits2[2 * mm];
      out[15] = kDigits2[2 * mm + 1];
      out[16] = ':';
      out[17] = kDigits2[2 * ss];
      out[18] = kDigits2[2 * ss + 1];
      if (us == 0u) {
        std::memcpy(out + 19, ".000000", 8);
      } else {
        out[19] = '.';
        const uint32_t u_hi = us / 10000u;
        const uint32_t u_rem = us - u_hi * 10000u;
        const uint32_t u_mid = u_rem / 100u;
        const uint32_t u_lo = u_rem - u_mid * 100u;
        out[20] = kDigits2[2 * u_hi];
        out[21] = kDigits2[2 * u_hi + 1];
        out[22] = kDigits2[2 * u_mid];
        out[23] = kDigits2[2 * u_mid + 1];
        out[24] = kDigits2[2 * u_lo];
        out[25] = kDigits2[2 * u_lo + 1];
        out[26] = '\0';
      }
      return;
    }
  }
  int64_t z = days + 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const int64_t doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = yoe + era * 400;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  const int64_t d = doy - (153 * mp + 2) / 5 + 1;
  const int64_t m = mp + (mp < 10 ? 3 : -9);
  if (m <= 2) ++y;
  const int64_t total_sec = us_day / 1000000LL;
  uint32_t us = static_cast<uint32_t>(us_day - total_sec * 1000000LL);
  const uint32_t hh = static_cast<uint32_t>(total_sec / 3600);
  const uint32_t rem = static_cast<uint32_t>(total_sec - hh * 3600);
  const uint32_t mm = rem / 60;
  const uint32_t ss = rem - mm * 60;
  std::snprintf(out, size, "%04d-%02d-%02dT%02d:%02d:%09.6f", static_cast<int>(y), static_cast<int>(m),
                static_cast<int>(d), static_cast<int>(hh), static_cast<int>(mm),
                static_cast<double>(ss) + static_cast<double>(us) * 1e-6);
}

inline int refuse(const char* code, const char* message) {
  // a state the flight could not reach for want of memory is refused as such (SPEC 1.6), not as the theory's failure
  if (std::strcmp(code, "propagation-failed") == 0 && mem::refuse_if_out_of_memory()) return 3;
  plugin_set_error(code, message);
  return 3;
}

/// The output times: explicit UTC epochs, or start / stop / step (defaults: the set's epoch, one day, 60 s).
struct Grid {
  Axes axes = Axes::Teme;
  bool explicit_times = false;
  std::vector<double> whole, frac;
  bool has_start = false, has_stop = false;
  double start_w = 0.0, start_f = 0.0, stop_w = 0.0, stop_f = 0.0;
  double step = kDefaultStepSeconds;
};

/// The call's output times from its $PCF OUTPUT: FRAME (UNSPECIFIED: TEME), STEP_SECONDS, EPOCHS or START_TIME / STOP_TIME.
inline Grid output_grid() {
  const pcf::Options& o = pcf::options();
  Grid g;
  g.axes = o.output_frame == pcfOutputFrame_GCRF ? Axes::Gcrf : o.output_frame == pcfOutputFrame_EME2000 ? Axes::Eme2000 : Axes::Teme;
  g.step = o.output_step_s;
  if (!o.epochs_w.empty()) {
    g.explicit_times = true;
    g.whole = o.epochs_w;
    g.frac = o.epochs_f;
  }
  g.has_start = o.has_start;
  g.has_stop = o.has_stop;
  g.start_w = o.start_w;
  g.start_f = o.start_f;
  g.stop_w = o.stop_w;
  g.stop_f = o.stop_f;
  return g;
}

inline bool text_epoch(const flatbuffers::String* s, double& whole, double& frac) {
  return s != nullptr && s->size() > 0 && omm::epoch(s->c_str(), s->size(), whole, frac);
}

/// The UTC epochs of a grid for a set whose epoch is whole + frac (explicit epochs, or start / stop / step with the
/// set's epoch and one day as defaults), charged to the state budget; 0 or a named refusal (3).
inline int grid_epochs(const Grid& g, double whole, double frac, size_t& budget, std::vector<double>& tw, std::vector<double>& tf) {
  if (g.explicit_times) {
    tw = g.whole;
    tf = g.frac;
  } else {
    const double sw = g.has_start ? g.start_w : whole, sf = g.has_start ? g.start_f : frac;
    const double span = g.has_stop ? ((g.stop_w - sw) + (g.stop_f - sf)) * 86400.0 : 86400.0;
    if (!(span >= 0.0) || !(g.step > 0.0)) return refuse("bad-grid", "The grid's span or step is not positive.");
    const double count_d = std::floor(span / g.step + 1e-9) + 1.0;
    if (count_d > static_cast<double>(budget)) return refuse("too-many-states", "The request asks for more than OUTPUT.MAXIMUM_STATES states.");
    const size_t n_pts = static_cast<size_t>(count_d);
    tw.assign(n_pts, sw);
    tf.resize(n_pts);
    for (size_t k = 0; k < n_pts; ++k) {
      tf[k] = sf + static_cast<double>(k) * g.step / 86400.0;
    }
  }
  if (tw.empty()) return refuse("bad-grid", "The grid holds no epochs.");
  if (tw.size() > budget) return refuse("too-many-states", "The request asks for more than OUTPUT.MAXIMUM_STATES states.");
  budget -= tw.size();
  return 0;
}

inline int push_oem(flatbuffers::FlatBufferBuilder& fbb, std::vector<flatbuffers::Offset<ephemerisDataBlock>>& blocks) {
  const auto root = CreateOEMDirect(fbb, nullptr, 3.0, nullptr, "SDN", &blocks);
  FinishOEMBuffer(fbb, root);
  if (plugin_push_output("ephemeris", "OEM.fbs", "$OEM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
    plugin_set_error("output-failed", "The $OEM could not be emitted.");
    return 3;
  }
  return 0;
}

}  // namespace oem
}  // namespace sdnap

