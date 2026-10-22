#pragma once
#include <cstdint>

namespace appearance {
// A counter-derived integer generator. All arithmetic is explicitly modulo
// 2^64; the top 52 bits map to the OPEN unit interval. No host random/clock.
// 52 bits leave room for the exact half-unit offset; 53 could round up to 1.
struct Random {
  uint64_t state;
  uint64_t next() {
    uint64_t z=(state+=UINT64_C(0x9e3779b97f4a7c15));
    z=(z^(z>>30))*UINT64_C(0xbf58476d1ce4e5b9);
    z=(z^(z>>27))*UINT64_C(0x94d049bb133111eb);
    return z^(z>>31);
  }
  double uniform(){return (double(next()>>12)+0.5)/4503599627370496.0;}
};
struct Tile {
  uint32_t level,x,y,seed;int32_t body;
  double radius,west,east,south_sin,north_sin,area;
  Tile(uint32_t l,uint32_t tx,uint32_t ty,uint32_t s,int32_t b,double r):level(l),x(tx),y(ty),seed(s),body(b),radius(r) {
    const double n=std::ldexp(1.0,int(level));
    west=-pi+2*pi*x/n;east=-pi+2*pi*(x+1)/n;
    north_sin=std::sin(pi/2-pi*y/n);south_sin=std::sin(pi/2-pi*(y+1)/n);
    area=r*r*(east-west)*(north_sin-south_sin);
  }
  Random random(uint32_t kind)const {
    Random r{seed};
    for(uint64_t v:{uint64_t(uint32_t(body)),uint64_t(level),uint64_t(x),uint64_t(y),uint64_t(kind)})r.state=r.next()^v;
    return r;
  }
};
struct Population {
  std::vector<double> position,diameter,azimuth,shape_seed;
  double expected_count=0,expected_cfa=0,actual_cfa=0;
  void append(const Tile& tile,Random& rng,double d) {
    const double lon=tile.west+(tile.east-tile.west)*rng.uniform();
    const double s=tile.south_sin+(tile.north_sin-tile.south_sin)*rng.uniform(),c=std::sqrt(std::max(0.0,1-s*s));
    position.insert(position.end(),{tile.radius*c*std::cos(lon),tile.radius*c*std::sin(lon),tile.radius*s});
    diameter.push_back(d);azimuth.push_back(2*pi*rng.uniform());shape_seed.push_back(double(uint32_t(rng.next())));
    actual_cfa+=pi*d*d/(4*tile.area);
  }
  void emit(wire::Result& r,const std::string& prefix)const {
    r.number((prefix+"_count").c_str(),diameter.size());
    r.number((prefix+"_expected_count").c_str(),expected_count);
    r.number((prefix+"_expected_cfa").c_str(),expected_cfa);
    r.number((prefix+"_actual_cfa").c_str(),actual_cfa);
    r.vector((prefix+"_position_m").c_str(),position,"m","Body-centered, body-fixed XYZ; +Z north, +X prime meridian, +Y east.");
    r.vector((prefix+"_diameter_m").c_str(),diameter,"m");
    r.vector((prefix+"_azimuth_rad").c_str(),azimuth,"rad","Uniform rotation about the local surface normal; clockwise from local north.");
    r.vector((prefix+"_shape_seed").c_str(),shape_seed,"uint32");
  }
};
constexpr double population_limit=250000;
inline uint32_t rounded_count(double mean,Random& rng) {return uint32_t(std::floor(mean)+(rng.uniform()<mean-std::floor(mean)));}
// F(D)=k exp(-qD) is an AREA survival function. The NUMBER density is
// -F'(D)/(pi D^2/4), not an exponential density. The inverse-square proposal
// has an analytic inverse and exp(-q(D-lo)) is its rejection probability.
inline bool rocks(const Tile& tile,double k,double q,double lo,double hi,Population& out) {
  if(k==0)return true;
  out.expected_cfa=k*(std::exp(-q*lo)-std::exp(-q*hi));
  out.expected_count=tile.area*4*k*q/pi*integrate_log([&](double d){return std::exp(-q*d)/(d*d);},lo,hi);
  if(!in_range(out.expected_count,0,population_limit))return false;
  auto rng=tile.random(1);const uint32_t count=rounded_count(out.expected_count,rng);
  uint64_t attempts=0;
  while(out.diameter.size()<count) {
    if(++attempts>UINT64_C(10000000))return false;
    const double d=1/(1/lo-rng.uniform()*(1/lo-1/hi));
    if(rng.uniform()>std::exp(-q*(d-lo)))continue;
    out.append(tile,rng,d);
  }
  return true;
}
inline bool craters(const Tile& tile,double n1_km2,double lo,double hi,Population& out) {
  if(n1_km2==0)return true;
  const double nl=crater_shape(lo),nh=crater_shape(hi);
  out.expected_count=tile.area*n1_km2/1e6*(nl-nh);
  out.expected_cfa=n1_km2/1e6*integrate_log([](double d){return pi*d*d/4*crater_differential(d);},lo,hi);
  if(!in_range(out.expected_count,0,population_limit) || !in_range(out.expected_cfa,0,1))return false;
  auto rng=tile.random(2);const uint32_t count=rounded_count(out.expected_count,rng);
  for(uint32_t i=0;i<count;++i) {
    const double target=nl-rng.uniform()*(nl-nh);
    double a=lo,b=hi;
    for(int j=0;j<48;++j){const double mid=std::sqrt(a*b);if(crater_shape(mid)>target)a=mid;else b=mid;}
    out.append(tile,rng,std::sqrt(a*b));
  }
  return true;
}
}
