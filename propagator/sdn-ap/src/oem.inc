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

/// ISO 8601 UTC text of a split Julian date plus minutes.
inline void iso_text(double jd_whole, double jd_frac, double minutes, char* out, size_t size) {
  const double day_offset = (jd_whole - 2440587.5);
  double frac = jd_frac + minutes / kMinutesPerDay;
  const double whole_days = std::floor(frac);
  frac -= whole_days;
  int64_t days = static_cast<int64_t>(day_offset + whole_days);
  double seconds = frac * 86400.0;
  seconds = std::round(seconds * 1e6) / 1e6;
  if (seconds >= 86400.0) {
    seconds -= 86400.0;
    days += 1;
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
  const int hh = static_cast<int>(seconds / 3600.0);
  const int mm = static_cast<int>((seconds - hh * 3600.0) / 60.0);
  const double ss = seconds - hh * 3600.0 - mm * 60.0;
  std::snprintf(out, size, "%04d-%02d-%02dT%02d:%02d:%09.6f", static_cast<int>(y), static_cast<int>(m),
                static_cast<int>(d), hh, mm, ss);
}

inline int refuse(const char* code, const char* message) {
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
    for (size_t k = 0; k < static_cast<size_t>(count_d); ++k) {
      tw.push_back(sw);
      tf.push_back(sf + static_cast<double>(k) * g.step / 86400.0);
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

