// Orekit evidence reductions: SI metres, GCRF/EME2000, hourly UTC samples.
// Propagation remains in the shipped HPOP WASM; no orbital maths is in JS.
#include <algorithm>
#include <cmath>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <nlohmann/json.hpp>
using Json = nlohmann::json;
double number(const Json& x) {
  const double n = x.get<double>();
  if (!std::isfinite(n)) throw std::runtime_error("nonfinite value");
  return n;
}
double norm(const double* x) { return std::hypot(x[0], x[1], x[2]); }
Json score(const Json& in) {
  const auto& c = in.at("reference");
  const auto& samples = in.at("samples");
  if (samples.size() != 24 || c.at("samples").size() != 25) throw std::runtime_error("expected 24 hourly propagated samples");
  Json positions = Json::array(), parameters = Json::object();
  double worst = -1, atHour = 0, stm = 0;
  for (const auto& p : c.value("parameters", Json::array())) parameters[p.get<std::string>()] = 0.0;
  for (std::size_t k = 0; k < samples.size(); ++k) {
    double delta[3]; Json p = Json::array();
    for (std::size_t j = 0; j < 3; ++j) {
      const double v = number(samples[k].at("position")[j]) * 1000;
      p.push_back(v); delta[j] = v - number(c.at("samples")[k + 1][j + 1]);
    }
    positions.push_back(p);
    if (norm(delta) > worst) { worst = norm(delta); atHour = number(c.at("samples")[k + 1][0]) / 3600; }
    if (!in.value("jacobians", false)) continue;
    const auto& matrix = in.at("matrices")[k];
    const auto n = matrix.at("DIMENSION").get<std::size_t>(), np = c.at("parameters").size();
    if (n != 6 + np || matrix.at("VALUES").size() != n * n) throw std::runtime_error("invalid STM dimensions");
    for (std::size_t j = 0; j < n; ++j) for (std::size_t row : {0u, 3u}) {
      double d[3], b[3];
      for (std::size_t i = 0; i < 3; ++i) {
        b[i] = j < 6 ? number(c.at("stm")[k + 1][(row + i) * 6 + j])
          : number(c.at("parameterJacobian")[k + 1][(row + i) * np + j - 6]);
        d[i] = number(matrix.at("VALUES")[(row + i) * n + j]) - b[i];
      }
      const double relative = norm(b) > 0 ? norm(d) / norm(b) : norm(d);
      if (j < 6) stm = std::max(stm, relative);
      else { const auto key = c.at("parameters")[j - 6].get<std::string>(); parameters[key] = std::max(number(parameters[key]), relative); }
    }
  }
  Json result = {{"worstM", worst}, {"atHour", atHour}, {"positions", positions}};
  if (in.value("jacobians", false)) result["jacobians"] = {{"stm", stm}, {"parameters", parameters}};
  return result;
}
Json difference(const Json& in) {
  const auto& a = in.at("a"); const auto& b = in.at("b");
  if (a.size() != b.size()) throw std::runtime_error("trajectory size mismatch");
  double worst = 0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    double d[3];
    for (std::size_t k = 0; k < 3; ++k) {
      d[k] = number(b[i][k]) - number(a[i][k]);
      if (in.contains("referenceA")) d[k] -= number(in.at("referenceB")[i + 1][k + 1]) - number(in.at("referenceA")[i + 1][k + 1]);
    }
    worst = std::max(worst, norm(d));
  }
  return worst;
}
Json reduction(const Json& in) {
  const auto mode = in.at("mode");
  if (mode == "sample-difference") {
    const auto& a=in.at("a");const auto& b=in.at("b");
    if(a.size()!=b.size())throw std::runtime_error("sample count mismatch");
    double worst=0,at=0;
    for(std::size_t i=0;i<a.size();++i) {
      if(a[i][0]!=b[i][0])throw std::runtime_error("sample epoch mismatch");
      double d[3];for(std::size_t k=0;k<3;++k)d[k]=number(a[i][k+1])-number(b[i][k+1]);
      const double n=norm(d);if(n>worst){worst=n;at=number(a[i][0]);}
    }
    return {{"worst",worst},{"worstAt",at}};
  }
  if (mode == "samples-si") {
    const auto& reference=in.at("reference"),positions=in.at("positions");
    if(reference.size()!=positions.size()+1)throw std::runtime_error("propagated sample count mismatch");
    Json out=Json::array();out.push_back(reference[0]);
    for(std::size_t i=0;i<positions.size();++i)out.push_back({reference[i+1][0],number(positions[i][0])*1000,number(positions[i][1])*1000,number(positions[i][2])*1000});
    return out;
  }
  if (mode == "maximum") {
    if (in.at("values").empty()) throw std::runtime_error("empty maximum");
    double result = 0; for (const auto& value : in.at("values")) result = std::max(result, number(value)); return result;
  }
  if (mode == "met") return number(in.at("value")) <= number(in.at("limit"));
  if (mode == "verdict") {
    int met = 0; const auto& values = in.at("values"), limits = in.at("limits");
    if (values.size() != limits.size()) throw std::runtime_error("verdict limit count differs");
    Json flags = Json::array();
    for (std::size_t i = 0; i < values.size(); ++i) { const bool passed = number(values[i]) <= number(limits[i]); if (passed) ++met; flags.push_back(passed); }
    return {{"total", values.size()}, {"met", met}, {"missed", values.size() - met}, {"flags", flags}};
  }
  const double value = number(in.at("value")); std::ostringstream out;
  if (mode == "format-xval") {
    if(value<1)out<<std::fixed<<std::setprecision(value<0.01?2:1)<<value*1000<<" mm";
    else out<<std::fixed<<std::setprecision(value<100?2:0)<<value<<" m";
  }
  else if (mode == "format-mm") out << std::fixed << std::setprecision(3) << value * 1000;
  else if (mode == "format-scientific") out << std::scientific << std::setprecision(2) << value;
  else if (value < 0.01) out << std::fixed << std::setprecision(value * 1000 < 10 ? 2 : 1) << value * 1000 << " mm";
  else out << std::fixed << std::setprecision(value < 0.1 ? 1 : 0) << value * 100 << " cm";
  return out.str();
}
int main() {
  try { Json in; std::cin >> in; std::cout << (in.at("mode") == "score" ? score(in) : in.at("mode") == "difference" ? difference(in) : reduction(in)).dump() << '\n'; }
  catch (const std::exception& e) { std::cerr << "Orekit metrics: " << e.what() << '\n'; return 1; }
}
