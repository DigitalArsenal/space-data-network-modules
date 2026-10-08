// SDS $EOP rows as one Earth-orientation series, and its value at a UTC
// epoch. Shared by foundation/frames (eop_table.hpp reads the rows from the
// SDK input frames) and propagator/hpop (its earth_orientation input), so
// there is one reading of $EOP and one interpolation rule in the tree.
//
// Needs, ahead of it in the translation unit: the generated EOP bindings
// (EOP_generated.h), axis_engine.hpp and the ERFA declarations.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

namespace sdn {
namespace frames {
namespace eop {

struct Row {
  const EOP* row;
  EarthOrientation value;
};

// Presence is per field. An explicitly encoded double zero is authoritative.
inline double hp(const EOP* row, flatbuffers::voffset_t field, double hpValue,
                 double legacy) {
  return reinterpret_cast<const flatbuffers::Table*>(row)->CheckField(field)
             ? hpValue
             : legacy;
}

inline EarthOrientation values(const EOP* row) {
  EarthOrientation e;
  e.xPole = hp(row, EOP::VT_X_POLE_WANDER_RADIANS_HP,
               row->X_POLE_WANDER_RADIANS_HP(), row->X_POLE_WANDER_RADIANS());
  e.yPole = hp(row, EOP::VT_Y_POLE_WANDER_RADIANS_HP,
               row->Y_POLE_WANDER_RADIANS_HP(), row->Y_POLE_WANDER_RADIANS());
  e.dut1 = hp(row, EOP::VT_UT1_MINUS_UTC_SECONDS_HP,
              row->UT1_MINUS_UTC_SECONDS_HP(), row->UT1_MINUS_UTC_SECONDS());
  e.dX = hp(row, EOP::VT_X_CELESTIAL_POLE_OFFSET_RADIANS_HP,
            row->X_CELESTIAL_POLE_OFFSET_RADIANS_HP(),
            row->X_CELESTIAL_POLE_OFFSET_RADIANS());
  e.dY = hp(row, EOP::VT_Y_CELESTIAL_POLE_OFFSET_RADIANS_HP,
            row->Y_CELESTIAL_POLE_OFFSET_RADIANS_HP(),
            row->Y_CELESTIAL_POLE_OFFSET_RADIANS());
  e.lengthOfDay = hp(row, EOP::VT_LENGTH_OF_DAY_CORRECTION_SECONDS_HP,
                     row->LENGTH_OF_DAY_CORRECTION_SECONDS_HP(),
                     row->LENGTH_OF_DAY_CORRECTION_SECONDS());
  e.dPsi = row->NUTATION_DPSI_RADIANS();
  e.dEpsilon = row->NUTATION_DEPS_RADIANS();
  return e;
}

inline bool valid(const EarthOrientation& e) {
  return std::isfinite(e.xPole) && std::isfinite(e.yPole) &&
         std::isfinite(e.dut1) && std::isfinite(e.dX) && std::isfinite(e.dY) &&
         std::isfinite(e.lengthOfDay) && std::isfinite(e.dPsi) &&
         std::isfinite(e.dEpsilon);
}

// One $EOP record. `bytes` is a plain buffer, or with `sizePrefixed` a
// record of a length-prefixed stream, prefix included. Writers align such a
// record two ways: as a FlatBuffers size-prefixed buffer (finishSizePrefixed:
// alignment counted from the prefix) or as a plain buffer after a separately
// written length (alignment counted from four bytes in). Either verifies.
inline bool addRow(const uint8_t* bytes, size_t size, std::vector<Row>& rows,
                   bool sizePrefixed = false) {
  if (size < 8 || rows.size() >= 366) return false;
  const EOP* row = nullptr;
  if (!sizePrefixed) {
    flatbuffers::Verifier verifier(bytes, size);
    if (VerifyEOPBuffer(verifier)) row = GetEOP(bytes);
  } else {
    flatbuffers::Verifier prefixed(bytes, size);
    if (VerifySizePrefixedEOPBuffer(prefixed)) {
      row = GetSizePrefixedEOP(bytes);
    } else {
      flatbuffers::Verifier plain(bytes + 4, size - 4);
      if (VerifyEOPBuffer(plain)) row = GetEOP(bytes + 4);
    }
  }
  if (!row) return false;
  auto value = values(row);
  if (!valid(value)) return false;
  rows.push_back({row, value});
  return true;
}

// One payload: a single $EOP row, or a size-prefixed EOP stream. The rows
// point into `data`, which must outlive them. Empty string = success.
inline std::string addPayload(const uint8_t* data, size_t size,
                              std::vector<Row>& rows) {
  if (!data || size < 8) return "Invalid EOP buffer.";
  if (EOPBufferHasIdentifier(data)) {
    if (!addRow(data, size, rows))
      return "Invalid EOP row or table exceeds 366 rows.";
    return "";
  }
  size_t at = 0;
  while (at < size) {
    if (size - at < 4) return "Truncated size-prefixed EOP stream.";
    uint32_t length = flatbuffers::ReadScalar<uint32_t>(data + at);
    if (length > size - at - 4 || !addRow(data + at, length + 4, rows, true))
      return "Invalid size-prefixed EOP record.";
    at += 4 + length;
  }
  return "";
}

// Rows inside an enclosing FlatBuffer already verified with it (propagator/
// hpop's PRW.EARTH_ORIENTATION). They point into that buffer. Empty string =
// success.
inline std::string addRows(const flatbuffers::Vector<flatbuffers::Offset<EOP>>* list,
                           std::vector<Row>& rows) {
  if (!list || list->size() == 0) return "No EOP rows.";
  if (rows.size() + list->size() > 366) return "EOP table exceeds 366 rows.";
  for (const EOP* row : *list) {
    auto value = values(row);
    if (!valid(value)) return "Invalid EOP row.";
    rows.push_back({row, value});
  }
  return "";
}

inline std::string text(const flatbuffers::String* s) {
  return s ? s->str() : "";
}

inline bool sameSeries(const EOP* a, const EOP* b) {
  return a->SERIES() == b->SERIES() &&
         a->IAU_CONVENTION() == b->IAU_CONVENTION() &&
         text(a->DATA_SET_CID()) == text(b->DATA_SET_CID()) &&
         text(a->DATA_SET_EPOCH()) == text(b->DATA_SET_EPOCH());
}

inline bool dat(double mjd, double* value) {
  int y, m, d;
  double fd;
  return eraJd2cal(2400000.5, mjd, &y, &m, &d, &fd) == 0 &&
         eraDat(y, m, d, fd, value) == 0;
}

// The series checks and its value at UTC (utc1 + utc2, a two-part JD).
// `dateMatchesMjd` checks a row's DATE text against its MJD at 00:00 UTC.
// Empty string = success. A single row is an instantaneous EOP, used as is.
inline std::string at(const std::vector<Row>& rows, double utc1, double utc2,
                      EarthOrientation* out,
                      const std::function<bool(const char*, double)>& dateMatchesMjd) {
  if (rows.empty()) return "No EOP rows.";
  auto first = rows.front().row;
  if (first->IAU_CONVENTION() != iauPrecessionNutationModel::UNSPECIFIED &&
      first->IAU_CONVENTION() != iauPrecessionNutationModel::IAU_2000A &&
      first->IAU_CONVENTION() != iauPrecessionNutationModel::IAU_2006)
    return "Unsupported EOP IAU convention; use IAU_2000A or IAU_2006.";
  const double mjd = (utc1 - 2400000.5) + utc2;
  *out = rows.front().value;
  if (rows.size() == 1) return "";
  for (size_t i = 0; i < rows.size(); ++i) {
    auto row = rows[i].row;
    if (!sameSeries(first, row))
      return "EOP table mixes series, IAU conventions, or data-set "
             "provenance.";
    if (i && row->MJD() <= rows[i - 1].row->MJD())
      return "EOP table must have strictly increasing MJDs.";
    if (row->DATE() && !dateMatchesMjd(row->DATE()->c_str(), row->MJD()))
      return "EOP table DATE must match MJD at 00:00 UTC.";
  }
  if (mjd < first->MJD() || mjd > rows.back().row->MJD())
    return "EOP table does not bracket EPOCH; extrapolation is disabled.";
  size_t upper = 0;
  while (upper < rows.size() && rows[upper].row->MJD() < mjd) ++upper;
  if (mjd == rows[upper].row->MJD()) {
    *out = rows[upper].value;
    return "";
  }
  const auto& a = rows[upper - 1];
  const auto& b = rows[upper];
  double da, db, dq;
  if (!dat(a.row->MJD(), &da) || !dat(b.row->MJD(), &db) || !dat(mjd, &dq))
    return "EOP interpolation is outside the ERFA leap-second table.";
  double ta1, ta2, tb1, tb2, tq1, tq2;
  if (eraUtctai(2400000.5, a.row->MJD(), &ta1, &ta2) ||
      eraUtctai(2400000.5, b.row->MJD(), &tb1, &tb2) ||
      eraUtctai(utc1, utc2, &tq1, &tq2))
    return "Cannot convert EOP epochs to TAI.";
  const double t = ((tq1 - ta1) + (tq2 - ta2)) / ((tb1 - ta1) + (tb2 - ta2));
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
  return "";
}

}  // namespace eop
}  // namespace frames
}  // namespace sdn
