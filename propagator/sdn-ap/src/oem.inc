// -----------------------------------------------------------------------------
// The invoke surface: `propagate` takes SDS $OMM records (SGP4 or SGP4XP)
// and returns one $OEM per record, km and km/s, UTC, on the grid an
// optional 'grid' $OEM names (as modules propagator/sgp4-xp reads it): each grid
// block gives either explicit EPOCHs or START_TIME / STOP_TIME / STEP_SIZE
// (defaults: the set's epoch, one day later, 60 s) and its axes (TEME by
// default; GCRF or EME2000). The grid's span decides how far a set runs; one
// request holds at most 500,000 states.
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

/// One grid block: explicit UTC epochs, or start / stop / step (defaults: the set's epoch, one day, 60 s).
struct Grid {
  Axes axes = Axes::Teme;
  int center = 0;  ///< the template's CENTER_NAME: 0 not given, 1 EARTH, 4 another body
  bool explicit_times = false;
  std::vector<double> whole, frac;
  bool has_start = false, has_stop = false;
  double start_w = 0.0, start_f = 0.0, stop_w = 0.0, stop_f = 0.0;
  double step = kDefaultStepSeconds;
};

/// A grid with the call's $PCF OUTPUT defaults: FRAME (UNSPECIFIED: TEME) and STEP_SECONDS.
inline Grid default_grid() {
  Grid g;
  const int fr = pcf::options().output_frame;
  g.axes = fr == pcfOutputFrame_GCRF ? Axes::Gcrf : fr == pcfOutputFrame_EME2000 ? Axes::Eme2000 : Axes::Teme;
  g.step = pcf::options().output_step_s;
  return g;
}

inline bool text_epoch(const flatbuffers::String* s, double& whole, double& frac) {
  return s != nullptr && s->size() > 0 && omm::epoch(s->c_str(), s->size(), whole, frac);
}

/// The blocks of the optional 'grid' $OEM inputs (plain or size-prefixed); 0 or a named refusal.
inline int read_grids(std::vector<Grid>& grids) {
  const uint32_t frames = plugin_get_input_count();
  for (uint32_t i = 0; i < frames; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "grid") != 0) continue;
    const uint8_t* p = f->payload;
    uint32_t n = f->payload_length;
    if (!plain_view(p, n, "$OEM")) return refuse("invalid-grid", "A 'grid' payload is not an SDS $OEM.");
    flatbuffers::Verifier verifier(p, n);
    if (!VerifyOEMBuffer(verifier)) return refuse("invalid-grid", "The grid $OEM does not verify.");
    const auto* blocks = GetOEM(p)->EPHEMERIS_DATA_BLOCK();
    if (blocks == nullptr) continue;
    for (const ephemerisDataBlock* blk : *blocks) {
      Grid g = default_grid();
      if (blk->TIME_SYSTEM() != timingStandard_UTC) return refuse("invalid-grid", "The grid's TIME_SYSTEM must be UTC.");
      const Axes axes = axes_of(blk->REFERENCE_FRAME());
      if (axes == Axes::Conflict) return refuse("invalid-grid", "The grid's REFERENCE_FRAME enumeration and NAME disagree.");
      if (axes == Axes::EarthFixed || axes == Axes::Other)
        return refuse("invalid-grid", "The grid asks for axes this module does not write; it writes TEME, GCRF and EME2000.");
      if (axes != Axes::Undeclared) {
        if (pcf::options().output_frame != pcfOutputFrame_UNSPECIFIED && axes != g.axes)
          return pcf::refuse("OUTPUT.FRAME", "the grid template names other axes");
        g.axes = axes;
      }
      if (blk->CENTER_NAME() != nullptr && blk->CENTER_NAME()->size() > 0) g.center = same_text(blk->CENTER_NAME()->c_str(), "EARTH") ? 1 : 4;
      const auto* lines = blk->EPHEMERIS_DATA_LINES();
      if (lines != nullptr && lines->size() > 0) {
        g.explicit_times = true;
        for (const ephemerisDataLine* L : *lines) {
          double w, fr;
          if (L == nullptr || !text_epoch(L->EPOCH(), w, fr)) return refuse("invalid-grid", "A grid EPOCH is not an ISO 8601 UTC time.");
          g.whole.push_back(w);
          g.frac.push_back(fr);
        }
      } else {
        if (blk->START_TIME() != nullptr && blk->START_TIME()->size() > 0) {
          if (!text_epoch(blk->START_TIME(), g.start_w, g.start_f)) return refuse("invalid-grid", "START_TIME is not an ISO 8601 UTC time.");
          g.has_start = true;
        }
        if (blk->STOP_TIME() != nullptr && blk->STOP_TIME()->size() > 0) {
          if (!text_epoch(blk->STOP_TIME(), g.stop_w, g.stop_f)) return refuse("invalid-grid", "STOP_TIME is not an ISO 8601 UTC time.");
          g.has_stop = true;
        }
        if (blk->STEP_SIZE() > 0.0) g.step = blk->STEP_SIZE();
      }
      grids.push_back(std::move(g));
    }
  }
  return 0;
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
    if (count_d > static_cast<double>(budget)) return refuse("too-many-states", "The request asks for more than 500,000 states.");
    for (size_t k = 0; k < static_cast<size_t>(count_d); ++k) {
      tw.push_back(sw);
      tf.push_back(sf + static_cast<double>(k) * g.step / 86400.0);
    }
  }
  if (tw.empty()) return refuse("bad-grid", "The grid holds no epochs.");
  if (tw.size() > budget) return refuse("too-many-states", "The request asks for more than 500,000 states.");
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

extern "C" int propagate(void) {
  plugin_reset_output_state();
  if (const int rc = sdnap::pcf::read(sdnap::pcf::kPropagate)) return rc;
  if (const int rc = sdnap::atm::prepare()) return rc;  // SPEC 15: the drag atmosphere the call selects
  sdnap::atm::Scope scope;
  std::vector<sdnap::oem::Grid> grids;
  if (const int rc = sdnap::oem::read_grids(grids)) return rc;
  if (grids.empty()) grids.push_back(sdnap::oem::default_grid());
  size_t budget = sdnap::pcf::options().maximum_states;
  const uint32_t frames = plugin_get_input_count();
  uint32_t count = 0;
  for (uint32_t i = 0; i < frames; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr) continue;
    if (std::strcmp(f->port_id, "omm") != 0) continue;
    ++count;
    sdnap::ElementRow row{};
    if (!sdnap::omm::decode(f->payload, f->payload_length, row)) {
      if (sdnap::omm::center_refused()) {
        plugin_set_error("unsupported-center", "An 'omm' record is not centered on the Earth (CENTER_NAME); the theories here are geocentric.");
        return 3;
      }
      plugin_set_error("invalid-omm", "An 'omm' payload is not a decodable SGP4 or SGP4XP $OMM record.");
      return 3;
    }
    const sdnap::Elements e = sdnap::elements_of(row);
    if (const int tc = sdnap::pcf::check_set_theory(e.theory)) return tc;
    sdnap::xpt::XpSat* xs = nullptr;
    sdnap::Sat sat{};
    double* nodes = nullptr;
    bool refused;
    if (e.theory == sdnap::kTheorySgp4Xp) {
      xs = static_cast<sdnap::xpt::XpSat*>(std::malloc(sizeof(sdnap::xpt::XpSat)));
      sdnap::drag::table();
      refused = xs == nullptr || sdnap::xpt::xp_init(e, *xs) != sdnap::kPropOk;
    } else {
      refused = sdnap::sat_init(e, sdnap::gravity_wgs72(), sat) != sdnap::kPropOk;
      if (!refused && sat.deep.iresfl != 0) {
        nodes = static_cast<double*>(std::malloc(sizeof(double) * 4u * sdnap::kCheckpointNodes));
        if (nodes != nullptr) {
          sat.checkpoint_count = sdnap::kCheckpointNodes;
          sdnap::fill_checkpoints(sat, nodes, sdnap::kCheckpointNodes);
        }
      }
    }
    if (refused) {
      if (xs != nullptr) sdnap::xpt::xp_release(*xs);
      std::free(xs);
      plugin_set_error("element-set-refused", "The element set describes no orbit this module propagates.");
      return 3;
    }
    // SPEC 12: an SGP4XP set carrying COVARIANCE gets its propagated covariance beside every state
    sdnap::cov::Propagator cprop;
    bool with_cov = false;
    if (xs != nullptr) {
      sdnap::cov::Set cs;
      const int cr = sdnap::cov::read(f->payload, f->payload_length, row, cs);
      const int pr = cr == 1 ? sdnap::cov::prepare(cs, cprop) : 0;
      if (cr < 0 || pr != 0) {
        sdnap::xpt::xp_release(*xs);
        std::free(xs);
        plugin_set_error("invalid-covariance", cr < 0 ? "The set's COVARIANCE or its USER_DEFINED_SDNAP_COV rows are malformed."
                                                      : "The set's covariance does not map onto its parameters (the theory refuses a moved set or the epoch columns are singular).");
        return 3;
      }
      with_cov = cr == 1;
    }
    flatbuffers::FlatBufferBuilder fbb(1 << 16);
    std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks;
    char text[48], start[48], stop[48], why[160];
    int rc = 0;
    // The object the set describes (NORAD number, name, designator) goes to every block, so a fit of the ephemeris names its set.
    flatbuffers::Offset<CAT> object_offset;
    {
      const uint8_t* ob = f->payload;
      uint32_t ol = f->payload_length;
      if (sdnap::plain_view(ob, ol, "$OMM")) {
        // a record cut from a size-prefixed stream is aligned to its prefix, not to its own start
        flatbuffers::Verifier::Options vopt;
        vopt.check_alignment = false;
        flatbuffers::Verifier vo(ob, ol, vopt);
        if (VerifyOMMBuffer(vo)) {
          const OMM* om = GetOMM(ob);
          const bool named = om->OBJECT_NAME() != nullptr && om->OBJECT_NAME()->size() > 0;
          const bool designated = om->OBJECT_ID() != nullptr && om->OBJECT_ID()->size() > 0;
          if (om->NORAD_CAT_ID() != 0 || named || designated) {
            const auto s_name = named ? fbb.CreateString(om->OBJECT_NAME()->c_str()) : 0;
            const auto s_id = designated ? fbb.CreateString(om->OBJECT_ID()->c_str()) : 0;
            CATBuilder cb(fbb);
            if (om->NORAD_CAT_ID() != 0) cb.add_NORAD_CAT_ID(om->NORAD_CAT_ID());
            if (named) cb.add_OBJECT_NAME(s_name);
            if (designated) cb.add_OBJECT_ID(s_id);
            object_offset = cb.Finish();
          }
        }
      }
    }
    for (const sdnap::oem::Grid& g : grids) {
      if (g.center != 0 && g.center != 1) { rc = sdnap::oem::refuse("grid-center-mismatch", "The grid names a center other than the set's (EARTH)."); break; }
      std::vector<double> tw, tf;
      if (g.explicit_times) {
        tw = g.whole;
        tf = g.frac;
      } else {
        const double sw = g.has_start ? g.start_w : e.epoch_jd_whole, sf = g.has_start ? g.start_f : e.epoch_jd_frac;
        const double span = g.has_stop ? ((g.stop_w - sw) + (g.stop_f - sf)) * 86400.0 : 86400.0;
        if (!(span >= 0.0) || !(g.step > 0.0)) { rc = sdnap::oem::refuse("bad-grid", "The grid's span or step is not positive."); break; }
        const double count_d = std::floor(span / g.step + 1e-9) + 1.0;
        if (count_d > static_cast<double>(budget)) { rc = sdnap::oem::refuse("too-many-states", "The request asks for more than 500,000 states."); break; }
        const size_t states = static_cast<size_t>(count_d);
        for (size_t k = 0; k < states; ++k) {
          tw.push_back(sw);
          tf.push_back(sf + static_cast<double>(k) * g.step / 86400.0);
        }
      }
      if (tw.empty()) { rc = sdnap::oem::refuse("bad-grid", "The grid holds no epochs."); break; }
      if (tw.size() > budget) { rc = sdnap::oem::refuse("too-many-states", "The request asks for more than 500,000 states."); break; }
      budget -= tw.size();
      std::vector<flatbuffers::Offset<ephemerisDataLine>> lines;
      std::vector<flatbuffers::Offset<covarianceMatrixLine>> cov_lines;
      lines.reserve(tw.size());
      double bias[3][3];
      if (g.axes == sdnap::oem::Axes::Eme2000) sdnap::frames::frame_bias(bias);
      for (size_t k = 0; k < tw.size(); ++k) {
        const double t = ((tw[k] - e.epoch_jd_whole) + (tf[k] - e.epoch_jd_frac)) * sdnap::kMinutesPerDay;
        double r[3], v[3];
        const int32_t status = xs != nullptr ? sdnap::xpt::xp_propagate(*xs, t, r, v) : sdnap::sat_propagate(sat, nodes, t, r, v);
        sdnap::oem::iso_text(tw[k], tf[k], 0.0, text, sizeof text);
        if (status != sdnap::kPropOk) {
          std::snprintf(why, sizeof why, "NORAD %u does not propagate to %s (code %d).", e.norad, text, static_cast<int>(status));
          rc = sdnap::oem::refuse("propagation-failed", why);
          break;
        }
        double P[36];
        if (with_cov) {
          double rq[3], vq[3];
          if (!sdnap::cov::eval(cprop, t, rq, vq, P)) {
            std::snprintf(why, sizeof why, "NORAD %u: no covariance at %s.", e.norad, text);
            rc = sdnap::oem::refuse("propagation-failed", why);
            break;
          }
        }
        double axes[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};  // output = axes TEME
        if (g.axes != sdnap::oem::Axes::Teme) {
          double m[3][3];
          if (sdnap::frames::gcrf_to_teme(tw[k], tf[k], m) < 0) {
            std::snprintf(why, sizeof why, "No GCRF axes at %s (outside ERFA's calendar).", text);
            rc = sdnap::oem::refuse("frame-failed", why);
            break;
          }
          double rg[3], vg[3];
          sdnap::frames::apply_transpose(m, r, rg);
          sdnap::frames::apply_transpose(m, v, vg);
          if (g.axes == sdnap::oem::Axes::Eme2000) {
            sdnap::frames::apply(bias, rg, r);
            sdnap::frames::apply(bias, vg, v);
          } else {
            std::memcpy(r, rg, sizeof r);
            std::memcpy(v, vg, sizeof v);
          }
          for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) {
              double a = 0.0;
              if (g.axes == sdnap::oem::Axes::Eme2000)
                for (int q = 0; q < 3; ++q) a += bias[i][q] * m[j][q];
              else
                a = m[j][i];
              axes[i][j] = a;
            }
        }
        lines.push_back(CreateephemerisDataLineDirect(fbb, text, r[0], r[1], r[2], v[0], v[1], v[2]));
        if (with_cov) {
          // P' = B P B^T, B = diag(axes, axes)
          double B[36] = {}, BP[36], C[36];
          for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) B[i * 6 + j] = B[(3 + i) * 6 + 3 + j] = axes[i][j];
          for (int i = 0; i < 6; ++i)
            for (int j = 0; j < 6; ++j) {
              double a = 0.0;
              for (int q = 0; q < 6; ++q) a += B[i * 6 + q] * P[q * 6 + j];
              BP[i * 6 + j] = a;
            }
          for (int i = 0; i < 6; ++i)
            for (int j = 0; j < 6; ++j) {
              double a = 0.0;
              for (int q = 0; q < 6; ++q) a += BP[i * 6 + q] * B[j * 6 + q];
              C[i * 6 + j] = a;
            }
          auto c = [&](int i, int j) { return 0.5 * (C[i * 6 + j] + C[j * 6 + i]); };
          cov_lines.push_back(CreatecovarianceMatrixLineDirect(fbb, text, c(0, 0), c(1, 0), c(1, 1), c(2, 0), c(2, 1), c(2, 2), c(3, 0),
                                                                c(3, 1), c(3, 2), c(3, 3), c(4, 0), c(4, 1), c(4, 2), c(4, 3), c(4, 4),
                                                                c(5, 0), c(5, 1), c(5, 2), c(5, 3), c(5, 4), c(5, 5)));
        }
      }
      if (rc != 0) break;
      sdnap::oem::iso_text(tw.front(), tf.front(), 0.0, start, sizeof start);
      sdnap::oem::iso_text(tw.back(), tf.back(), 0.0, stop, sizeof stop);
      const auto frame = sdnap::oem::rfm_of(fbb, g.axes);
      const auto cov_frame = with_cov ? sdnap::oem::rfm_of(fbb, g.axes) : flatbuffers::Offset<RFM>(0);
      blocks.push_back(CreateephemerisDataBlockDirect(fbb, nullptr, object_offset, "EARTH", frame, nullptr, cov_frame, timingStandard_UTC, start,
                                                      nullptr, nullptr, stop, nullptr, 0, g.explicit_times ? 0.0 : g.step, 6,
                                                      nullptr, &lines, with_cov ? &cov_lines : nullptr));
    }
    if (xs != nullptr) sdnap::xpt::xp_release(*xs);
    std::free(xs);
    std::free(nodes);
    if (rc != 0) return rc;
    const auto root = CreateOEMDirect(fbb, nullptr, 3.0, nullptr, "SDN", &blocks);
    FinishOEMBuffer(fbb, root);
    if (plugin_push_output("ephemeris", "OEM.fbs", "$OEM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
      plugin_set_error("output-failed", "The $OEM could not be emitted.");
      return 3;
    }
  }
  if (count == 0) {
    plugin_set_error("missing-omm", "An 'omm' input frame is required.");
    return 3;
  }
  return sdnap::atm::coverage();
}
