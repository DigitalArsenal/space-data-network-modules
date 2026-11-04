// -----------------------------------------------------------------------------
// The invoke surface: `propagate`. Each 'ocm' frame's element set (an $OCM,
// plain or size-prefixed: SGP4, SGP4XP or AP, ocm.inc) flies under the forces
// its record states, on the daily rows and density-correction nodes it
// carries, to one $OEM: km and km/s, UTC, at the $PCF OUTPUT times (EPOCHS, or
// START_TIME to STOP_TIME at STEP_SECONDS; defaults: the set's epoch, one day,
// 60 s) in OUTPUT.FRAME (TEME, GCRF or EME2000), with a covariance line per
// state when the set carries COVARIANCE_DATA (SPEC 12). The $PCF is optional:
// a lone $OCM flies. One request holds at most OUTPUT.MAXIMUM_STATES states.
// -----------------------------------------------------------------------------

extern "C" int propagate(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  uint32_t count = 0;
  if (const int rc = ocm::admit(count)) return rc;
  if (const int rc = pcf::read(pcf::kPropagate, true)) return rc;
  const oem::Grid g = oem::output_grid();
  size_t budget = pcf::options().maximum_states;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "ocm") != 0) continue;
    ocm::Set set;
    if (const int rc = ocm::decode(f->payload, f->payload_length, set)) return rc;
    if (const int tc = pcf::check_set_theory(set.theory)) return tc;
    const Elements e = elements_of(set.row);
    // the output times, charged to the budget, and the rows they need: every day from the earlier of the epoch and
    // the first time through the later of the epoch and the last
    std::vector<double> tw, tf;
    if (const int rc = oem::grid_epochs(g, e.epoch_jd_whole, e.epoch_jd_frac, budget, tw, tf)) return rc;
    {
      int32_t lo = ocm::mjd_of(e.epoch_jd_whole, e.epoch_jd_frac), hi = lo;
      for (size_t k = 0; k < tw.size(); ++k) {
        const int32_t d = ocm::mjd_of(tw[k], tf[k]);
        lo = std::min(lo, d);
        hi = std::max(hi, d);
      }
      if (const int rc = ocm::rows_cover(set, lo, hi)) return rc;
    }
    atm::Atmosphere atmosphere;
    ocm::atmosphere_of(set, atmosphere);
    xpt::XpSat* xs = nullptr;
    Sat sat{};
    double* nodes = nullptr;
    bool refused;
    cov::Propagator cprop;
    bool with_cov = false;
    {
      ocm::Bind bind(set.forces, &atmosphere);
      if (e.theory == kTheorySgp4Xp) {
        xs = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
        drag::table();
        refused = xs == nullptr || xpt::xp_init(e, *xs) != kPropOk;
      } else {
        refused = sat_init(e, gravity_wgs72(), sat) != kPropOk;
        if (!refused && sat.deep.iresfl != 0) {
          nodes = static_cast<double*>(std::malloc(sizeof(double) * 4u * kCheckpointNodes));
          if (nodes != nullptr) {
            sat.checkpoint_count = kCheckpointNodes;
            fill_checkpoints(sat, nodes, kCheckpointNodes);
          }
        }
      }
      if (refused) {
        if (xs != nullptr) xpt::xp_release(*xs);
        std::free(xs);
        plugin_set_error("element-set-refused", "The element set describes no orbit this module propagates.");
        return 3;
      }
      // SPEC 12: an SGP4XP or AP set carrying COVARIANCE_DATA gets its propagated covariance beside every state
      if (xs != nullptr) {
        cov::Set cs;
        const int cr = cov::read(set.record, set.row, cs);
        const int pr = cr == 1 ? cov::prepare(cs, cprop) : 0;
        if (cr < 0 || pr != 0) {
          xpt::xp_release(*xs);
          std::free(xs);
          return ocm::refuse(cr == -2 ? "cov-parameter-kind-unspecified" : cr == -3 ? "cov-propagation-invariant" : "invalid-covariance",
                             cr < 0 ? "The set's COVARIANCE_DATA, COV_PARAMETER_KINDS or COV_PROPAGATION are malformed."
                                    : "The set's covariance does not map onto its parameters (the theory refuses a moved set or the epoch columns are singular).");
        }
        with_cov = cr == 1;
      }
    }
    flatbuffers::FlatBufferBuilder fbb(1 << 16);
    std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks;
    char text[48], start[48], stop[48], why[160];
    int rc = 0;
    // The object the set describes (NORAD number, name, designator) goes to the block, so a fit of the ephemeris names its set.
    flatbuffers::Offset<CAT> object_offset;
    {
      const bool named = !set.id.object_name.empty(), designated = !set.id.object_id.empty();
      if (set.id.norad != 0 || named || designated) {
        const auto s_name = named ? fbb.CreateString(set.id.object_name) : 0;
        const auto s_id = designated ? fbb.CreateString(set.id.object_id) : 0;
        CATBuilder cb(fbb);
        if (set.id.norad != 0) cb.add_NORAD_CAT_ID(set.id.norad);
        if (named) cb.add_OBJECT_NAME(s_name);
        if (designated) cb.add_OBJECT_ID(s_id);
        object_offset = cb.Finish();
      }
    }
    {
      std::vector<flatbuffers::Offset<ephemerisDataLine>> lines;
      std::vector<flatbuffers::Offset<covarianceMatrixLine>> cov_lines;
      lines.reserve(tw.size());
      double bias[3][3];
      if (g.axes == oem::Axes::Eme2000) frames::frame_bias(bias);
      for (size_t k = 0; k < tw.size(); ++k) {
        const double t = ((tw[k] - e.epoch_jd_whole) + (tf[k] - e.epoch_jd_frac)) * kMinutesPerDay;
        double r[3], v[3];
        const int32_t status = xs != nullptr ? xpt::xp_propagate(*xs, t, r, v) : sat_propagate(sat, nodes, t, r, v);
        oem::iso_text(tw[k], tf[k], 0.0, text, sizeof text);
        if (status != kPropOk) {
          std::snprintf(why, sizeof why, "NORAD %u does not propagate to %s (code %d).", e.norad, text, static_cast<int>(status));
          rc = oem::refuse("propagation-failed", why);
          break;
        }
        double P[36];
        if (with_cov) {
          double rq[3], vq[3];
          if (!cov::eval(cprop, t, rq, vq, P)) {
            std::snprintf(why, sizeof why, "NORAD %u: no covariance at %s.", e.norad, text);
            rc = oem::refuse("propagation-failed", why);
            break;
          }
        }
        double axes[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};  // output = axes TEME
        if (g.axes != oem::Axes::Teme) {
          double m[3][3];
          if (frames::gcrf_to_teme(tw[k], tf[k], m) < 0) {
            std::snprintf(why, sizeof why, "No GCRF axes at %s (outside ERFA's calendar).", text);
            rc = oem::refuse("frame-failed", why);
            break;
          }
          double rg[3], vg[3];
          frames::apply_transpose(m, r, rg);
          frames::apply_transpose(m, v, vg);
          if (g.axes == oem::Axes::Eme2000) {
            frames::apply(bias, rg, r);
            frames::apply(bias, vg, v);
          } else {
            std::memcpy(r, rg, sizeof r);
            std::memcpy(v, vg, sizeof v);
          }
          for (int a = 0; a < 3; ++a)
            for (int j = 0; j < 3; ++j) {
              double sum = 0.0;
              if (g.axes == oem::Axes::Eme2000)
                for (int q = 0; q < 3; ++q) sum += bias[a][q] * m[j][q];
              else
                sum = m[j][a];
              axes[a][j] = sum;
            }
        }
        lines.push_back(CreateephemerisDataLineDirect(fbb, text, r[0], r[1], r[2], v[0], v[1], v[2]));
        if (with_cov) {
          // P' = B P B^T, B = diag(axes, axes)
          double B[36] = {}, BP[36], C[36];
          for (int a = 0; a < 3; ++a)
            for (int j = 0; j < 3; ++j) B[a * 6 + j] = B[(3 + a) * 6 + 3 + j] = axes[a][j];
          for (int a = 0; a < 6; ++a)
            for (int j = 0; j < 6; ++j) {
              double sum = 0.0;
              for (int q = 0; q < 6; ++q) sum += B[a * 6 + q] * P[q * 6 + j];
              BP[a * 6 + j] = sum;
            }
          for (int a = 0; a < 6; ++a)
            for (int j = 0; j < 6; ++j) {
              double sum = 0.0;
              for (int q = 0; q < 6; ++q) sum += BP[a * 6 + q] * B[j * 6 + q];
              C[a * 6 + j] = sum;
            }
          auto c = [&](int a, int j) { return 0.5 * (C[a * 6 + j] + C[j * 6 + a]); };
          cov_lines.push_back(CreatecovarianceMatrixLineDirect(fbb, text, c(0, 0), c(1, 0), c(1, 1), c(2, 0), c(2, 1), c(2, 2), c(3, 0),
                                                                c(3, 1), c(3, 2), c(3, 3), c(4, 0), c(4, 1), c(4, 2), c(4, 3), c(4, 4),
                                                                c(5, 0), c(5, 1), c(5, 2), c(5, 3), c(5, 4), c(5, 5)));
        }
      }
      if (rc == 0) {
        oem::iso_text(tw.front(), tf.front(), 0.0, start, sizeof start);
        oem::iso_text(tw.back(), tf.back(), 0.0, stop, sizeof stop);
        const auto frame = oem::rfm_of(fbb, g.axes);
        const auto cov_frame = with_cov ? oem::rfm_of(fbb, g.axes) : flatbuffers::Offset<RFM>(0);
        blocks.push_back(CreateephemerisDataBlockDirect(fbb, nullptr, object_offset, "EARTH", frame, nullptr, cov_frame, timingStandard_UTC, start,
                                                        nullptr, nullptr, stop, nullptr, 0, g.explicit_times ? 0.0 : g.step, 6,
                                                        nullptr, &lines, with_cov ? &cov_lines : nullptr));
      }
    }
    if (xs != nullptr) xpt::xp_release(*xs);
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
  return 0;
}
