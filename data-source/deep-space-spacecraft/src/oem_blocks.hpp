#pragma once
// Multi-block SDS projection and reading. The reusable interpolation implementation
// is included from files/orbit-products/src/ephemeris_series.hpp by the build.
#include "trajectory_rows.hpp"
#include "regime.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace spacecraft_oem {
using Group = trajectory::Block;

inline bool segments(const std::vector<Group>& groups, bool terminal,
                     std::vector<Group>& blocks, std::string& error) {
  blocks.clear();
  if (groups.empty()) { error = "missing-vector-group"; return false; }
  const auto& daily = groups[0];
  for (const auto& g : groups) {
    if (g.step <= 0 || g.stop < g.start || (g.stop - g.start) % g.step ||
        g.data.size() != size_t((g.stop - g.start) / g.step + 1) * 6) {
      error = "incomplete-vector-group"; return false;
    }
    for (double v : g.data) if (!std::isfinite(v)) { error = "nonfinite-state"; return false; }
  }
  auto addDaily = [&](int64_t first, int64_t last) {
    if (last <= first) return; // Fewer than two daily rows.
    const size_t a = size_t((first - daily.start) / daily.step) * 6;
    const size_t b = size_t((last - daily.start) / daily.step + 1) * 6;
    blocks.push_back({first, last, daily.step, "daily",
                      std::vector<double>(daily.data.begin() + a, daily.data.begin() + b)});
  };
  int64_t cursor = daily.start;
  for (size_t i = 1; i < groups.size(); ++i) {
    const auto& w = groups[i];
    if (w.start < cursor || w.stop > daily.stop ||
        (w.start - daily.start) % daily.step || (w.stop - daily.start) % daily.step) {
      error = "invalid-window-grid"; return false;
    }
    addDaily(cursor, w.start);
    blocks.push_back(w);
    cursor = w.stop;
  }
  addDaily(cursor, daily.stop);
  if (blocks.empty()) { error = "empty-trajectory"; return false; }
  if (terminal) blocks.back().label += "; archive terminal event; subsequent phases are separate";
  return true;
}

inline std::vector<uint8_t> build(const notables::Notable& craft,
                                 const std::vector<Group>& blocks,
                                 const std::string& creation, const std::string& catalog,
                                 const std::string& lifecycle) {
  flatbuffers::FlatBufferBuilder fbb(65536);
  std::vector<flatbuffers::Offset<ephemerisDataBlock>> offsets;
  const auto name = fbb.CreateString(craft.name), cospar = fbb.CreateString(craft.cospar);
  CATBuilder cat(fbb);
  cat.add_OBJECT_NAME(name); cat.add_OBJECT_ID(cospar); cat.add_NORAD_CAT_ID(craft.norad);
  const auto object = cat.Finish();
  const auto celestial = CreateCelestialFrameWrapper(fbb, CelestialFrame::ICRF);
  RFMBuilder frame(fbb);
  frame.add_REFERENCE_FRAME_type(RFMUnionTraits<CelestialFrameWrapper>::enum_value);
  frame.add_REFERENCE_FRAME(celestial.Union());
  const auto rfm = frame.Finish();
  const auto interpolation = fbb.CreateString("Hermite");
  for (const auto& b : blocks) {
    const auto center = fbb.CreateString(trajectory::centerName(b.center));
    const auto start = fbb.CreateString(horizons::formatCalendar(b.start));
    const auto stop = fbb.CreateString(horizons::formatCalendar(b.stop));
    const auto comment = fbb.CreateString(std::string("CATALOG: ") + catalog + "\nLIFECYCLE: " + lifecycle + "\nALIASES: " + craft.aliases + "\n" +
        craft.licence + "\n" + craft.credit + "\n" + b.label);
    const auto data = fbb.CreateVector(b.data);
    ephemerisDataBlockBuilder block(fbb);
    block.add_OBJECT(object); block.add_CENTER_NAME(center);
    block.add_OBJECT_NAIF_ID(craft.id); block.add_CENTER_NAIF_ID(b.center);
    block.add_REFERENCE_FRAME(rfm); block.add_TIME_SYSTEM(timingStandard::TDB);
    block.add_START_TIME(start); block.add_STOP_TIME(stop); block.add_STEP_SIZE(double(b.step));
    block.add_STATE_VECTOR_SIZE(6); block.add_EPHEMERIS_DATA(data);
    block.add_INTERPOLATION(interpolation); block.add_INTERPOLATION_DEGREE(7);
    block.add_COMMENT(comment); offsets.push_back(block.Finish());
  }
  const auto data = fbb.CreateVector(offsets);
  const auto origin = fbb.CreateString("NASA/JPL Horizons via SDN data-source/deep-space-spacecraft");
  const auto created = creation.empty() ? flatbuffers::Offset<flatbuffers::String>() : fbb.CreateString(creation);
  OEMBuilder root(fbb);
  root.add_CCSDS_OEM_VERS(3.0); root.add_ORIGINATOR(origin); root.add_EPHEMERIS_DATA_BLOCK(data);
  if (!creation.empty()) root.add_CREATION_DATE(created);
  FinishSizePrefixedOEMBuffer(fbb, root.Finish());
  return {fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize()};
}

inline std::vector<uint8_t> groupRecords(const std::array<size_t, regime::kCatalogCount>& counts,
                                         const std::string& retrieved) {
  std::vector<uint8_t> stream;
  for (size_t i = 0; i < counts.size(); ++i) {
    if (!counts[i]) continue;
    flatbuffers::FlatBufferBuilder b(1024);
    const std::string lane = regime::kIds[i], id = "deep-space-spacecraft/" + lane;
    const bool weekly = lane == "heliocentric" || lane == "sun-earth-l1" || lane == "sun-earth-l2";
    std::vector<std::string> tagText = {weekly ? "cadence:168h" : "cadence:24h", "class:query", "environment:space",
        "provisioner:deep-space-spacecraft", "regime:" + lane, "schema:oem", "source:" + lane};
    std::sort(tagText.begin(), tagText.end());
    tagText.erase(std::unique(tagText.begin(), tagText.end()), tagText.end());
    std::vector<flatbuffers::Offset<flatbuffers::String>> tags;
    for (const auto& tag : tagText) tags.push_back(b.CreateString(tag));
    // The sdn-data-query text the EGP query format names (keys in sorted order); lane ids are plain kebab-case.
    const std::string queryText = std::string(1, '{') + "\"provider_id\":\"deep-space-spacecraft\",\"schema\":\"OEM.fbs\",\"source_name\":\"" + lane + "\"}";
    const auto provenance = CreateEGPProvenanceDirect(b, "NASA/JPL Horizons", "Horizons VECTORS", nullptr,
        "https://ssd.jpl.nasa.gov/api/horizons.api", nullptr, retrieved.c_str(), nullptr,
        notables::kLicence, notables::kCredit, nullptr);
    const auto query = CreateEGPQueryDirect(b, "sdn-data-query", queryText.c_str(),
        retrieved.empty() ? nullptr : retrieved.c_str(), uint32_t(counts[i]), nullptr);
    std::vector<flatbuffers::Offset<EGPProvenance>> provenances = {provenance};
    const std::string description = std::string(regime::kRules[i]) + "; " + std::to_string(counts[i]) +
        " objects. Sun-centered runs shorter than 3 days merge with a neighbor.";
    const auto group = CreateEGPDirect(b, id.c_str(), regime::kNames[i], description.c_str(), &tags,
        egpMembershipMode::QUERY_LIVE, nullptr, query, retrieved.empty() ? nullptr : retrieved.c_str(),
        retrieved.c_str(), &provenances, nullptr);
    FinishSizePrefixedEGPBuffer(b, group);
    stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
  }
  return stream;
}

struct SeriesBlock { ephem::Series series; double step; };
inline bool read(const uint8_t* bytes, size_t size, std::vector<SeriesBlock>& blocks,
                 std::string& error) {
  flatbuffers::Verifier verifier(bytes, size);
  if (!VerifySizePrefixedOEMBuffer(verifier)) { error = "invalid-oem-buffer"; return false; }
  const auto* root = GetSizePrefixedOEM(bytes);
  const auto* data = root->EPHEMERIS_DATA_BLOCK();
  if (!data || data->size() == 0) { error = "empty-oem"; return false; }
  blocks.clear();
  for (const auto* b : *data) {
    const auto* rfm = b->REFERENCE_FRAME();
    const auto* celestial = rfm ? rfm->REFERENCE_FRAME_as_CelestialFrameWrapper() : nullptr;
    if (b->TIME_SYSTEM() != timingStandard::TDB || !celestial || celestial->frame() != CelestialFrame::ICRF) {
      error = "unsupported-oem-frame-or-time"; return false;
    }
    const auto* values = b->EPHEMERIS_DATA();
    double start = 0, stop = 0;
    const double step = b->STEP_SIZE();
    if (!b->START_TIME() || !b->STOP_TIME() || !horizons::parseCalendar(b->START_TIME()->str(), start) ||
        !horizons::parseCalendar(b->STOP_TIME()->str(), stop) || !std::isfinite(step) || step <= 0 ||
        b->STATE_VECTOR_SIZE() != 6 || !values || values->size() < 6 || values->size() % 6 ||
        std::abs(start + double(values->size() / 6 - 1) * step - stop) > 1e-6 || !b->INTERPOLATION()) {
      error = "invalid-oem-grid"; return false;
    }
    SeriesBlock out;
    out.step = step;
    auto& s = out.series;
    s.time_system = "TDB"; s.frame_name = "ICRF";
    s.center_name = b->CENTER_NAME() ? b->CENTER_NAME()->str() : "";
    const std::string rule = b->INTERPOLATION()->str();
    if (rule == "Hermite") s.interp = ephem::Interp::Hermite;
    else if (rule == "Lagrange") s.interp = ephem::Interp::Lagrange;
    else if (rule == "Linear") s.interp = ephem::Interp::Linear;
    else { error = "unsupported-oem-interpolation"; return false; }
    s.interp_degree = int(b->INTERPOLATION_DEGREE());
    if (s.interp_degree <= 0 || s.interp_degree > 31) { error = "unsupported-oem-degree"; return false; }
    s.rows.reserve(values->size() / 6);
    for (size_t i = 0; i < values->size() / 6; ++i) {
      ephem::StateRow row;
      row.epoch = start + double(i) * step; row.has_vel = true;
      for (size_t c = 0; c < 3; ++c) { row.pos[c] = values->Get(i * 6 + c); row.vel[c] = values->Get(i * 6 + c + 3); }
      if (!ephem::row_is_finite(row)) { error = "nonfinite-state"; return false; }
      s.rows.push_back(row);
    }
    blocks.push_back(std::move(out));
  }
  return true;
}

inline bool evaluate(const std::vector<SeriesBlock>& blocks, double jd,
                     size_t& index, ephem::StateRow& row, std::string& error) {
  if (!std::isfinite(jd)) { error = "invalid-epoch"; return false; }
  index = blocks.size();
  for (size_t i = 0; i < blocks.size(); ++i) {
    const auto& b = blocks[i];
    // Compare on the caller's JD axis: a whole grid second loses up to half a
    // JD double ULP on round-trip, including at shared and outer boundaries.
    const double firstJd = 2451545.0 + b.series.rows.front().epoch / 86400.0;
    const double lastJd = 2451545.0 + b.series.rows.back().epoch / 86400.0;
    if (jd >= firstJd && jd <= lastJd &&
        (index == blocks.size() || b.step < blocks[index].step)) index = i;
  }
  if (index == blocks.size()) { error = "epoch-out-of-range"; return false; }
  const auto& series = blocks[index].series;
  const double t = std::clamp((jd - 2451545.0) * 86400.0,
                             series.rows.front().epoch, series.rows.back().epoch);
  const auto status = ephem::evaluate(series, t, &row);
  if (status != ephem::Status::Ok) { error = ephem::status_name(status); return false; }
  return true;
}
} // namespace spacecraft_oem
