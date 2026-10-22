#pragma once
// Classification only: positions are km, ICRF, seconds since J2000 TDB noon.
// Earth: JPL Approximate Positions of the Planets, Standish Table 1 (1800–2050),
// https://ssd.jpl.nasa.gov/planets/approx_pos.html, EMB minus Moon/82.3005.
// Moon: Meeus, Astronomical Algorithms, ch. 47, first 12 terms of Tables 47.A/B;
// remove general longitude precession to J2000, then use obliquity 23.43928 deg.
// Rules: Earth exclusion 60,000 km; EM L1/L2 0.8369/1.1557 lunar distances,
// neighborhoods 60,000 km; cislunar 500,000 km; solar L1/L2 2,500,000 km,
// half-angle 30 deg. Sun runs shorter than 3 days merge with a neighbor; Sun-Earth L1/L2 runs need 30 days
// and the launch leg 10 days.
// Window rules: Moon maxima 30,000/120,000 km; planets median < 100 mean radii
// (Mercury 2439.7, Venus 6051.8, Mars 3389.5, Jupiter 69911, Saturn 58232 km).
// These analytic approximations are never used to change an ephemeris row.
#include "trajectory_rows.hpp"
#include "../../../common/horizons_vectors.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace regime {
enum class Catalog { LunarOrbit, Cislunar, EarthMoonLagrange, SunEarthL1, SunEarthL2,
                     MercuryOrbit, VenusOrbit, MarsOrbit, JupiterOrbit, SaturnOrbit, Heliocentric, Dropped };
constexpr size_t kCatalogCount = size_t(Catalog::Dropped);
constexpr const char* kIds[] = {"lunar-orbit", "cislunar", "earth-moon-lagrange", "sun-earth-l1", "sun-earth-l2",
    "mercury-orbit", "venus-orbit", "mars-orbit", "jupiter-orbit", "saturn-orbit", "heliocentric"};
constexpr const char* kNames[] = {"Lunar orbit", "Cislunar space", "Earth-Moon Lagrange regions", "Sun-Earth L1",
    "Sun-Earth L2", "Mercury orbit", "Venus orbit", "Mars orbit", "Jupiter orbit", "Saturn orbit", "Heliocentric spacecraft"};
constexpr const char* kRules[] = {"Moon-centered window maximum radius <= 30,000 km",
    "Earth distance <= 500,000 km or remaining Earth/Moon windows outside Earth orbit",
    "Within 60,000 km of Earth-Moon L1/L2, or Moon window maximum radius <= 120,000 km",
    "Earth distance 500,000–2,500,000 km, sunward within 30 degrees of the Sun-Earth line, for at least 30 days",
    "Earth distance 500,000–2,500,000 km, outward within 30 degrees of the Sun-Earth line, for at least 30 days",
    "Mercury window median distance < 100 Mercury radii", "Venus window median distance < 100 Venus radii",
    "Mars window median distance < 100 Mars radii", "Jupiter window median distance < 100 Jupiter radii",
    "Saturn window median distance < 100 Saturn radii", "Remaining Sun-centered segments and distant planet windows"};
constexpr double kPi = 3.14159265358979323846, kRad = kPi / 180.0;
constexpr double kAU = 149597870.7, kObliquity = 23.43928 * kRad, kEarthMoonMass = 82.3005;
constexpr double kEarthExclusion = 60000, kLagrangeRadius = 60000, kCislunarRadius = 500000;
constexpr double kSolarLagrangeRadius = 2500000, kSolarHalfAngle = 45 * kRad;
constexpr double kEmL1 = 0.8369, kEmL2 = 1.1557, kLunarOrbitRadius = 30000, kLunarLagrangeRadius = 120000;
constexpr double kPlanetRadii = 100, kMercuryRadius = 2439.7, kVenusRadius = 6051.8,
    kMarsRadius = 3389.5, kJupiterRadius = 69911, kSaturnRadius = 58232;
// A Sun-centered run shorter than its minimum merges into its previous neighbor (the next one when first).
// Sun-Earth L1/L2 membership means station-keeping there: a flyby crossing the sunward or anti-sunward
// cone (Lucy, OSIRIS-APEX, BepiColombo at their Earth assists) lasts days, a halo orbit months, so those
// runs need 30 days. The launch leg (the first run, 10 days) folds into the regime the craft is sent to.
constexpr int64_t kSmoothDuration = 3 * horizons::kDay, kSolarDwell = 30 * horizons::kDay, kLaunchLeg = 20 * horizons::kDay;
using Vec = std::array<double, 3>;
inline Vec minus(const Vec& a, const Vec& b) { return {a[0]-b[0], a[1]-b[1], a[2]-b[2]}; }
inline Vec scale(const Vec& a, double k) { return {a[0]*k, a[1]*k, a[2]*k}; }
inline double dot(const Vec& a, const Vec& b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
inline double norm(const Vec& a) { return std::sqrt(dot(a, a)); }
inline Vec equatorial(const Vec& a) {
  return {a[0], a[1]*std::cos(kObliquity)-a[2]*std::sin(kObliquity),
          a[1]*std::sin(kObliquity)+a[2]*std::cos(kObliquity)};
}
inline double radians(double degrees) { return std::remainder(degrees, 360.0) * kRad; }

inline Vec moon(double seconds) {
  const double t = seconds / (36525.0 * horizons::kDay), t2 = t*t, t3 = t2*t, t4 = t3*t;
  const double lp = 218.3164477 + 481267.88123421*t - .0015786*t2 + t3/538841 - t4/65194000;
  const double d = radians(297.8501921 + 445267.1114034*t - .0018819*t2 + t3/545868 - t4/113065000);
  const double m = radians(357.5291092 + 35999.0502909*t - .0001536*t2 + t3/24490000);
  const double mp = radians(134.9633964 + 477198.8675055*t + .0087414*t2 + t3/69699 - t4/14712000);
  const double f = radians(93.2720950 + 483202.0175233*t - .0036539*t2 - t3/3526000 + t4/863310000);
  const double e = 1 - .002516*t - .0000074*t2;
  struct Term { int d, m, mp, f; double longitude, distance; };
  constexpr Term lr[] = {
    {0,0,1,0,6288774,-20905355}, {2,0,-1,0,1274027,-3699111}, {2,0,0,0,658314,-2955968},
    {0,0,2,0,213618,-569925}, {0,1,0,0,-185116,48888}, {0,0,0,2,-114332,-3149},
    {2,0,-2,0,58793,246158}, {2,-1,-1,0,57066,-152138}, {2,0,1,0,53322,-170733},
    {2,-1,0,0,45758,-204586}, {0,1,-1,0,-40923,-129620}, {1,0,0,0,-34720,108743}};
  constexpr Term lat[] = {
    {0,0,0,1,5128122,0}, {0,0,1,1,280602,0}, {0,0,1,-1,277693,0}, {2,0,0,-1,173237,0},
    {2,0,-1,1,55413,0}, {2,0,-1,-1,46271,0}, {2,0,0,1,32573,0}, {0,0,2,1,17198,0},
    {2,0,1,-1,9266,0}, {0,0,2,-1,8822,0}, {2,-1,0,-1,8216,0}, {2,0,-2,-1,4324,0}};
  double longitude = 0, latitude = 0, distance = 0;
  const auto factor = [&](int power) { return power == 0 ? 1.0 : std::pow(e, std::abs(power)); };
  for (const auto& a : lr) {
    const double angle = a.d*d + a.m*m + a.mp*mp + a.f*f;
    longitude += a.longitude * factor(a.m) * std::sin(angle);
    distance += a.distance * factor(a.m) * std::cos(angle);
  }
  for (const auto& a : lat) latitude += a.longitude * factor(a.m) * std::sin(a.d*d + a.m*m + a.mp*mp + a.f*f);
  const double precession = (5029.0966*t + 1.11113*t2 - .000006*t3) / 3600.0;
  const double lon = radians(lp + longitude/1e6 - precession), beta = latitude/1e6*kRad;
  const double radius = 385000.56 + distance/1000.0;
  return equatorial({radius*std::cos(beta)*std::cos(lon), radius*std::cos(beta)*std::sin(lon), radius*std::sin(beta)});
}
inline Vec earth(double seconds, const Vec& moonGeo) {
  const double t = seconds / (36525.0 * horizons::kDay);
  const double a = (1.00000261 + .00000562*t) * kAU, e = .01671123 - .00004392*t;
  const double inclination = radians(-.00001531 - .01294668*t);
  const double longitude = 100.46457166 + 35999.37244981*t;
  const double perihelion = 102.93768193 + .32327364*t;
  const double mean = radians(longitude - perihelion), w = radians(perihelion);
  double eccentric = mean;
  for (int i = 0; i < 12; ++i) eccentric -= (eccentric-e*std::sin(eccentric)-mean)/(1-e*std::cos(eccentric));
  const double x = a*(std::cos(eccentric)-e), y = a*std::sqrt(1-e*e)*std::sin(eccentric);
  // Omega is zero in Table 1 for the EMB.
  const Vec emb = equatorial({x*std::cos(w)-y*std::sin(w),
      (x*std::sin(w)+y*std::cos(w))*std::cos(inclination),
      (x*std::sin(w)+y*std::cos(w))*std::sin(inclination)});
  return minus(emb, scale(moonGeo, 1/kEarthMoonMass));
}
inline double lagrangeDistance(const Vec& geocentric, const Vec& moonGeo) {
  return std::min(norm(minus(geocentric, scale(moonGeo, kEmL1))), norm(minus(geocentric, scale(moonGeo, kEmL2))));
}
inline Catalog classifySunRow(int64_t time, const Vec& position) {
  const Vec moonGeo = moon(double(time)), earthHelio = earth(double(time), moonGeo);
  const Vec delta = minus(position, earthHelio);
  const double distance = norm(delta);
  if (distance < kEarthExclusion) return Catalog::Dropped;
  if (lagrangeDistance(delta, moonGeo) <= kLagrangeRadius) return Catalog::EarthMoonLagrange;
  if (distance <= kCislunarRadius) return Catalog::Cislunar;
  const double along = dot(delta, earthHelio) / norm(earthHelio);
  if (distance <= kSolarLagrangeRadius && std::abs(along) >= distance*std::cos(kSolarHalfAngle))
    return along > 0 ? Catalog::SunEarthL2 : Catalog::SunEarthL1;
  return Catalog::Heliocentric;
}
inline Vec position(const trajectory::Block& b, size_t row) { return {b.data[row*6], b.data[row*6+1], b.data[row*6+2]}; }
inline double median(std::vector<double>& values) {
  const size_t middle = values.size()/2;
  std::nth_element(values.begin(), values.begin()+middle, values.end());
  return values.size()%2 ? values[middle] : (values[middle] + *std::max_element(values.begin(), values.begin()+middle))/2;
}
inline Catalog classifyWindow(const trajectory::Block& block) {
  std::vector<double> distances, lagrange;
  for (size_t i = 0; i < block.data.size()/6; ++i) {
    const Vec r = position(block, i);
    distances.push_back(norm(r));
    if (block.center == 399) lagrange.push_back(lagrangeDistance(r, moon(double(block.start + int64_t(i)*block.step))));
  }
  if (distances.empty()) return Catalog::Dropped;
  if (block.center == 301) {
    const double maximum = *std::max_element(distances.begin(), distances.end());
    return maximum <= kLunarOrbitRadius ? Catalog::LunarOrbit :
        maximum <= kLunarLagrangeRadius ? Catalog::EarthMoonLagrange : Catalog::Cislunar;
  }
  const double distance = median(distances);
  if (block.center == 399) {
    if (distance < kEarthExclusion) return Catalog::Dropped;
    return median(lagrange) < kLagrangeRadius ? Catalog::EarthMoonLagrange : Catalog::Cislunar;
  }
  double radius = 0; Catalog orbit = Catalog::Heliocentric;
  switch (block.center) {
    case 199: radius = kMercuryRadius; orbit = Catalog::MercuryOrbit; break;
    case 299: radius = kVenusRadius; orbit = Catalog::VenusOrbit; break;
    case 499: radius = kMarsRadius; orbit = Catalog::MarsOrbit; break;
    case 599: radius = kJupiterRadius; orbit = Catalog::JupiterOrbit; break;
    case 699: radius = kSaturnRadius; orbit = Catalog::SaturnOrbit; break;
  }
  return distance < kPlanetRadii*radius ? orbit : Catalog::Heliocentric;
}
struct Segment { Catalog catalog; trajectory::Block block; };
inline std::vector<Segment> classifySun(const std::vector<trajectory::Block>& blocks) {
  struct Row { int64_t time; Catalog catalog; };
  std::vector<Row> rows;
  for (const auto& b : blocks) for (size_t i = 0; i < b.data.size()/6; ++i) {
    const int64_t time = b.start + int64_t(i)*b.step;
    if (!rows.empty() && rows.back().time == time) continue;
    rows.push_back({time, classifySunRow(time, position(b, i))});
  }
  struct Run { size_t first, last; Catalog catalog; };
  std::vector<Run> runs;
  for (size_t i = 0; i < rows.size(); ++i) {
    if (runs.empty() || runs.back().catalog != rows[i].catalog) runs.push_back({i, i, rows[i].catalog});
    else runs.back().last = i;
  }
  for (size_t i = 0; runs.size() > 1 && i < runs.size();) {
    const auto& r = runs[i];
    const int64_t end = rows[std::min(r.last+1, rows.size()-1)].time;
    int64_t need = kSmoothDuration;
    if (r.catalog == Catalog::SunEarthL1 || r.catalog == Catalog::SunEarthL2) need = kSolarDwell;
    else if (i == 0) need = kLaunchLeg;
    if (end - rows[r.first].time >= need) { ++i; continue; }
    if (i == 0) { runs[1].first = r.first; runs.erase(runs.begin()); }
    else {
      runs[i-1].last = r.last;
      runs.erase(runs.begin()+i);
      if (i < runs.size() && runs[i-1].catalog == runs[i].catalog) {
        runs[i-1].last = runs[i].last;
        runs.erase(runs.begin()+i);
      }
      --i;
    }
  }
  std::vector<Segment> result;
  size_t run = 0;
  for (const auto& b : blocks) {
    const size_t count = b.data.size()/6;
    if (count < 2) continue;
    size_t first = 0;
    while (run+1 < runs.size() && rows[runs[run+1].first].time <= b.start) ++run;
    Catalog catalog = runs[run].catalog;
    const auto add = [&](size_t last) {
      if (last > first && catalog != Catalog::Dropped) result.push_back({catalog, trajectory::slice(b, first, last)});
    };
    for (size_t i = 1; i < count; ++i) {
      const int64_t time = b.start + int64_t(i)*b.step;
      while (run+1 < runs.size() && rows[runs[run+1].first].time <= time) ++run;
      if (runs[run].catalog != catalog) { add(i); first = i; catalog = runs[run].catalog; }
    }
    add(count-1);
  }
  return result;
}
inline std::vector<Segment> classifyPhase(const trajectory::Block& block) {
  if (block.center == 10) return classifySun({block});
  const auto catalog = classifyWindow(block);
  if (catalog == Catalog::Dropped || block.data.size() < 12) return {};
  return {{catalog, block}};
}
} // namespace regime
