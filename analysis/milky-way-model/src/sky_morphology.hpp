#pragma once
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace milky_way::oracle_detail {
constexpr uint32_t width=720,height=360;
constexpr double missing=std::numeric_limits<double>::quiet_NaN();

// Latitude cut at the stated longitude, averaging the four 0.5 deg cells
// within +/-1 deg longitude. FWHM is the entire band envelope, including an
// intervening extinction dip; its two outer half-height crossings are linearly
// interpolated independently in model and oracle. No fitted morphology.
inline double fwhm(const std::vector<float>& sky,uint32_t longitude_index) {
  std::array<double,height> profile{};
  for (uint32_t y=0;y<height;++y) {
    double sum=0; uint32_t count=0;
    for (int dx=-2;dx<2;++dx) {
      const uint32_t x=static_cast<uint32_t>((int(longitude_index)+dx+int(width))%int(width));
      const double v=sky[static_cast<size_t>(y)*width+x];
      if (std::isfinite(v)) {sum+=v;++count;}
    }
    profile[y]=count?sum/count:missing;
  }
  double baseline=0;uint32_t baseline_count=0;
  for (uint32_t y=0;y<height;++y) {
    const double latitude=90-(y+0.5)*0.5;
    if (std::abs(latitude)>=60&&std::abs(latitude)<80&&std::isfinite(profile[y])) {
      baseline+=profile[y];++baseline_count;
    }
  }
  baseline=baseline_count?baseline/baseline_count:0;
  double peak=baseline;
  for (uint32_t y=120;y<240;++y) if (std::isfinite(profile[y])) peak=std::max(peak,profile[y]);
  if (!(peak>baseline)) return missing;
  const double half=baseline+0.5*(peak-baseline);
  int first=-1,last=-1;
  for (int y=120;y<240;++y) if (profile[y]>=half) {if (first<0)first=y;last=y;}
  while (first>0&&profile[first-1]>=half) --first;
  while (last>=0&&last<int(height)-1&&profile[last+1]>=half) ++last;
  if (first<=0||last<0||last>=int(height)-1) return missing;
  if (!std::isfinite(profile[first-1])||!std::isfinite(profile[last+1])) return missing;
  if (!(profile[first]>profile[first-1])||!(profile[last]>profile[last+1])
      ||profile[first-1]>=half||profile[last+1]>=half) return missing;
  const double top_fraction=(half-profile[first-1])/(profile[first]-profile[first-1]);
  const double bottom_fraction=(half-profile[last])/(profile[last+1]-profile[last]);
  return ((last+bottom_fraction)-(first-1+top_fraction))*0.5;
}

inline double rift_ratio(const std::vector<float>& sky) {
  double center=0,flanks=0;uint32_t n_center=0,n_flanks=0;
  // Cygnus/Aquila Great Rift region: l=60..90 deg. Compare |b|<1 deg
  // against 2<=|b|<5 deg; all regions have matched longitude coverage.
  for (uint32_t y=0;y<height;++y) {
    const double b=std::abs(90-(y+0.5)*0.5);
    if (b>=5||(b>=1&&b<2)) continue;
    for (uint32_t x=120;x<180;++x) {
      const double v=sky[static_cast<size_t>(y)*width+x];
      if (!std::isfinite(v)) continue;
      if (b<1) {center+=v;++n_center;} else {flanks+=v;++n_flanks;}
    }
  }
  return n_center&&n_flanks&&flanks>0?(center/n_center)/(flanks/n_flanks):missing;
}
} // namespace milky_way::oracle_detail
