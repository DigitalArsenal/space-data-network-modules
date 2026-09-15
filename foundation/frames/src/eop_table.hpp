// SDS EOP invoke adapter. Inlined after generated bindings and axis_engine.hpp.
// No new schema: one row, several frames, or a size-prefixed EOP stream.
#include <string>
#include <vector>
namespace {
struct EopSample {
  const EOP* row;
  ax::EarthOrientation value;
};

double eop_hp(const EOP* row, flatbuffers::voffset_t field, double hp,
              double legacy) {
  // Presence is per field. An explicitly encoded double zero is authoritative.
  return reinterpret_cast<const flatbuffers::Table*>(row)->CheckField(field)
             ? hp
             : legacy;
}
ax::EarthOrientation eop_values(const EOP* row) {
  ax::EarthOrientation e;
  e.xPole =
      eop_hp(row, EOP::VT_X_POLE_WANDER_RADIANS_HP,
             row->X_POLE_WANDER_RADIANS_HP(), row->X_POLE_WANDER_RADIANS());
  e.yPole =
      eop_hp(row, EOP::VT_Y_POLE_WANDER_RADIANS_HP,
             row->Y_POLE_WANDER_RADIANS_HP(), row->Y_POLE_WANDER_RADIANS());
  e.dut1 =
      eop_hp(row, EOP::VT_UT1_MINUS_UTC_SECONDS_HP,
             row->UT1_MINUS_UTC_SECONDS_HP(), row->UT1_MINUS_UTC_SECONDS());
  e.dX = eop_hp(row, EOP::VT_X_CELESTIAL_POLE_OFFSET_RADIANS_HP,
                row->X_CELESTIAL_POLE_OFFSET_RADIANS_HP(),
                row->X_CELESTIAL_POLE_OFFSET_RADIANS());
  e.dY = eop_hp(row, EOP::VT_Y_CELESTIAL_POLE_OFFSET_RADIANS_HP,
                row->Y_CELESTIAL_POLE_OFFSET_RADIANS_HP(),
                row->Y_CELESTIAL_POLE_OFFSET_RADIANS());
  e.lengthOfDay = eop_hp(row, EOP::VT_LENGTH_OF_DAY_CORRECTION_SECONDS_HP,
                         row->LENGTH_OF_DAY_CORRECTION_SECONDS_HP(),
                         row->LENGTH_OF_DAY_CORRECTION_SECONDS());
  e.dPsi = row->NUTATION_DPSI_RADIANS();
  e.dEpsilon = row->NUTATION_DEPS_RADIANS();
  return e;
}
bool valid_eop(const ax::EarthOrientation& e) {
  return std::isfinite(e.xPole) && std::isfinite(e.yPole) &&
         std::isfinite(e.dut1) && std::isfinite(e.dX) && std::isfinite(e.dY) &&
         std::isfinite(e.lengthOfDay) && std::isfinite(e.dPsi) &&
         std::isfinite(e.dEpsilon);
}
bool add_eop(const uint8_t* bytes, size_t size, std::vector<EopSample>& rows) {
  if (size < 8 || rows.size() >= 366) return false;
  flatbuffers::Verifier verifier(bytes, size);
  if (!VerifyEOPBuffer(verifier)) return false;
  auto row = GetEOP(bytes);
  auto value = eop_values(row);
  if (!valid_eop(value)) return false;
  rows.push_back({row, value});
  return true;
}
std::string eop_string(const flatbuffers::String* s) {
  return s ? s->str() : "";
}
bool same_eop_series(const EOP* a, const EOP* b) {
  return a->SERIES() == b->SERIES() &&
         a->IAU_CONVENTION() == b->IAU_CONVENTION() &&
         eop_string(a->DATA_SET_CID()) == eop_string(b->DATA_SET_CID()) &&
         eop_string(a->DATA_SET_EPOCH()) == eop_string(b->DATA_SET_EPOCH());
}
bool eop_dat(double mjd, double* dat) {
  int y, m, d;
  double fd;
  return eraJd2cal(2400000.5, mjd, &y, &m, &d, &fd) == 0 &&
         eraDat(y, m, d, fd, dat) == 0;
}
// Empty string = success (including no row); errors are explicit INVALID_INPUT.
std::string read_eop_table(double utc1, double utc2, ax::EarthOrientation* out,
                           const EOP** provenance, bool* supplied) {
  std::vector<EopSample> rows;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    auto frame = plugin_get_input_frame(i);
    if (!frame || !frame->port_id ||
        std::strcmp(frame->port_id, "earth_orientation") != 0)
      continue;
    auto data = frame->payload;
    size_t size = frame->payload_length;
    if (!data || size < 8) return "Invalid EOP buffer.";
    if (EOPBufferHasIdentifier(data)) {
      if (!add_eop(data, size, rows))
        return "Invalid EOP row or table exceeds 366 rows.";
    } else {
      size_t at = 0;
      while (at < size) {
        if (size - at < 4) return "Truncated size-prefixed EOP stream.";
        uint32_t length = flatbuffers::ReadScalar<uint32_t>(data + at);
        at += 4;
        if (length > size - at || !add_eop(data + at, length, rows))
          return "Invalid size-prefixed EOP record.";
        at += length;
      }
    }
  }
  if (rows.empty()) return "";
  auto first = rows.front().row;
  if (first->IAU_CONVENTION() != iauPrecessionNutationModel::UNSPECIFIED &&
      first->IAU_CONVENTION() != iauPrecessionNutationModel::IAU_2000A &&
      first->IAU_CONVENTION() != iauPrecessionNutationModel::IAU_2006)
    return "Unsupported EOP IAU convention; use IAU_2000A or IAU_2006.";
  const double mjd = (utc1 - 2400000.5) + utc2;
  // A single row preserves the established caller-supplied instantaneous EOP
  // contract.
  *out = rows.front().value;
  if (rows.size() > 1) {
    for (size_t i = 0; i < rows.size(); ++i) {
      auto row = rows[i].row;
      if (!same_eop_series(first, row))
        return "EOP table mixes series, IAU conventions, or data-set "
               "provenance.";
      if (i && row->MJD() <= rows[i - 1].row->MJD())
        return "EOP table must have strictly increasing MJDs.";
      if (row->DATE()) {
        int y, m, d, h, minute;
        double second, jd0, day;
        if (!parse_iso_utc(row->DATE()->c_str(), &y, &m, &d, &h, &minute,
                           &second) ||
            h || minute || second || eraCal2jd(y, m, d, &jd0, &day) != 0 ||
            day != row->MJD())
          return "EOP table DATE must match MJD at 00:00 UTC.";
      }
    }
    if (mjd < first->MJD() || mjd > rows.back().row->MJD())
      return "EOP table does not bracket EPOCH; extrapolation is disabled.";
    size_t upper = 0;
    while (upper < rows.size() && rows[upper].row->MJD() < mjd) ++upper;
    if (mjd == rows[upper].row->MJD())
      *out = rows[upper].value;
    else {
      const auto& a = rows[upper - 1];
      const auto& b = rows[upper];
      double da, db, dq;
      if (!eop_dat(a.row->MJD(), &da) || !eop_dat(b.row->MJD(), &db) ||
          !eop_dat(mjd, &dq))
        return "EOP interpolation is outside the ERFA leap-second table.";
      double ta1, ta2, tb1, tb2, tq1, tq2;
      if (eraUtctai(2400000.5, a.row->MJD(), &ta1, &ta2) ||
          eraUtctai(2400000.5, b.row->MJD(), &tb1, &tb2) ||
          eraUtctai(utc1, utc2, &tq1, &tq2))
        return "Cannot convert EOP epochs to TAI.";
      const double t =
          ((tq1 - ta1) + (tq2 - ta2)) / ((tb1 - ta1) + (tb2 - ta2));
      auto lerp = [t](double x, double y) { return x + t * (y - x); };
      out->xPole = lerp(a.value.xPole, b.value.xPole);
      out->yPole = lerp(a.value.yPole, b.value.yPole);
      // UT1-TAI is continuous through leap seconds; UT1-UTC is not.
      out->dut1 = lerp(a.value.dut1 - da, b.value.dut1 - db) + dq;
      out->dX = lerp(a.value.dX, b.value.dX);
      out->dY = lerp(a.value.dY, b.value.dY);
      out->lengthOfDay = lerp(a.value.lengthOfDay, b.value.lengthOfDay);
      out->dPsi = lerp(a.value.dPsi, b.value.dPsi);
      out->dEpsilon = lerp(a.value.dEpsilon, b.value.dEpsilon);
    }
  }
  *provenance = first;
  *supplied = true;
  return "";
}
}  // namespace
