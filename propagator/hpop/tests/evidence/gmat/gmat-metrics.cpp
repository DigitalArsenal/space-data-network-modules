// Evidence reductions only: propagation remains in the shipped HPOP WASM.
// SI metres, GCRF (EME2000 where the case says so), 2026-08-02 UTC, 24 h.
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <nlohmann/json.hpp>
using Json = nlohmann::json;

int main() {
  try {
    Json in; std::cin >> in;
    const auto mode = in.at("mode").get<std::string>();
    Json out;
    if (mode == "density") {
      out = Json::array();
      for (const auto& row : in.at("rows")) {
        const double eps = row.at("eps"), drag = row.at("dragEffectM");
        const double predicted = eps * drag;
        const double measured = row.at("hpopMinusGmatM");
        const double corrected = row.at("hpopMinusGmatCdScaledM");
        const double fromMeans = row.at("meanDensityGtd7dKgM3").get<double>()
          / row.at("meanDensityGtd7KgM3").get<double>() - 1.0;
        if (std::abs(fromMeans - eps) > 1e-14
            || std::abs(predicted - row.at("epsTimesDragEffectM").get<double>()) > 1e-12)
          throw std::runtime_error("stored density diagnostic arithmetic mismatch");
        out.push_back({{"id", row.at("id")}, {"epsFromMeanDensities", fromMeans},
          {"epsTimesDragEffectM", predicted}, {"predictionMinusObservedM", predicted - measured},
          {"predictionRelativeDifference", (predicted - measured) / measured},
          {"correctedDifferenceM", corrected}, {"correctedMet", corrected <= 1.5},
          {"correctedDefaultMet", corrected <= 0.1}});
      }
    } else if (mode == "positions") {
      const auto& p = in.at("positions"); const auto& samples = in.at("samples");
      if (p.size() != 24 || samples.size() != 25) throw std::runtime_error("expected 24 propagated / 25 reference samples");
      double worst = -1, atHour = 0;
      for (std::size_t k = 0; k < 24; ++k) {
        if (samples[k + 1][0].get<double>() != (k + 1) * 3600.0 || p[k].size() != 3)
          throw std::runtime_error("invalid hourly sample");
        double d[3];
        for (std::size_t j = 0; j < 3; ++j)
          d[j] = p[k][j].get<double>() * in.at("scale").get<double>() - samples[k + 1][j + 1].get<double>();
        const double norm = std::hypot(d[0], d[1], d[2]);
        if (!std::isfinite(norm)) throw std::runtime_error("non-finite position difference");
        if (norm > worst) { worst = norm; atHour = k + 1; }
      }
      out = {{"worstM", worst}, {"atHour", atHour}, {"sampleCount", 24}};
    } else if (mode == "replay-match") {
      // The pinned replay reproduces both historical scores exactly.
      const auto& a = in.at("actual"); const auto& b = in.at("expected");
      out = {{"met", a.at("worstM") == b.at("worstM")
        && a.at("atHour") == b.at("atHour") && a.at("steps") == b.at("steps")},
        {"differenceM", a.at("worstM").get<double>() - b.at("worstM").get<double>()}};
    } else if (mode == "stm") {
      double worst = 0; std::size_t count = 0; Json groups = Json::object();
      for (const auto& row : in.at("cases")) if (row.contains("stm")) {
        ++count; const double v = row.at("stm").at("worst");
        if (v > worst) worst = v;
        const auto group = row.at("row").get<std::string>();
        if (!groups.contains(group) || v > groups[group].get<double>()) groups[group] = v;
      }
      out = {{"caseCount", count}, {"worstRelativeColumnDifference", count ? Json(worst) : Json(nullptr)},
        {"byRow", groups}};
    } else throw std::runtime_error("unknown metrics mode");
    std::cout << out.dump() << '\n';
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
