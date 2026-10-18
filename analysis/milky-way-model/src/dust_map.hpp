#pragma once
#include "galactic_constants.hpp"
#include "model_types.hpp"
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

// A published local 3D dust map, delivered over SDN as SDS $PCE rows by
// data-source/dust-map-3d (one row per heliocentric z plane) and loaded with
// load_dust_map before bake. Inside the map's coverage it replaces the
// Drimmel & Spergel 2001 dust; beyond its radius DS2001 continues, blended
// over the outer blend_kpc. Without a loaded map the bake is DS2001 alone.
namespace milky_way::dust_map {

// Edenhofer et al. (2024), A&A 685, A82, section 5: A_V(540 nm) = 2.8 E of
// Zhang, Green & Rix (2023). A_G/A_V = 0.789 (Wang & Chen 2019 Table 3).
// Optical depth tau = A / (2.5/ln 10).
inline constexpr double blend_kpc=0.1;
inline constexpr double pogson=1.0857362047581294;

struct Grid {
  bool ready=false;
  std::string dataset,source,license,credit,unit;
  uint32_t nx=0,ny=0,nz=0,loaded=0;
  Vec3 first_center{};      // heliocentric kpc of cell (0,0,0)
  double spacing=0,radius=0,a_v_per_unit=0;
  std::vector<float> tau_g; // G optical depth per kpc; NaN = no data
  std::vector<uint8_t> have;
};

inline Grid& grid() {static Grid g;return g;}

inline double sample(Vec3 heliocentric) {
  const Grid& g=grid();
  const double u=(heliocentric.x-g.first_center.x)/g.spacing;
  const double v=(heliocentric.y-g.first_center.y)/g.spacing;
  const double w=(heliocentric.z-g.first_center.z)/g.spacing;
  constexpr double nan=std::numeric_limits<double>::quiet_NaN();
  if(!(u>=0&&v>=0&&w>=0&&u<=g.nx-1&&v<=g.ny-1&&w<=g.nz-1)) return nan;
  const uint32_t x=std::min(uint32_t(u),g.nx-2),y=std::min(uint32_t(v),g.ny-2),z=std::min(uint32_t(w),g.nz-2);
  const double fx=u-x,fy=v-y,fz=w-z;
  double sum=0;
  for(unsigned dz=0;dz<2;++dz) for(unsigned dy=0;dy<2;++dy) for(unsigned dx=0;dx<2;++dx) {
    const double value=g.tau_g[(size_t(z+dz)*g.ny+(y+dy))*g.nx+(x+dx)];
    if(!std::isfinite(value)) return nan;
    sum+=value*(dx?fx:1-fx)*(dy?fy:1-fy)*(dz?fz:1-fz);
  }
  return sum;
}

// The map where it has data, DS2001 beyond its radius or outside its grid.
inline double blend(Vec3 p,double large_scale) {
  const Grid& g=grid();
  if(!g.ready) return large_scale;
  const Vec3 h{p.x+galactic_constants::solar_radius_kpc,p.y,p.z-galactic_constants::solar_height_kpc};
  const double r=length(h);
  if(r>=g.radius) return large_scale;
  const double map=sample(h);
  if(!std::isfinite(map)) return large_scale;
  const double inside=smoothstep(g.radius,g.radius-blend_kpc,r);
  return inside*map+(1-inside)*large_scale;
}

} // namespace milky_way::dust_map
