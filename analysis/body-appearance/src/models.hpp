#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <vector>

namespace appearance {
constexpr double pi=3.141592653589793238462643383279502884;
inline double parameter(const std::string& model,const std::string& name) {
  for(const auto& p:parameters_table)if(model==p.model && name==p.name)return p.value;
  return std::numeric_limits<double>::quiet_NaN();
}
inline double wrap(double a) {a=std::fmod(a,2*pi);return a<0?a+2*pi:a;}
inline bool in_range(double v,double a,double b) {return std::isfinite(v) && v>=a && v<=b;}
inline bool integer(double v,double a,double b) {return in_range(v,a,b) && std::floor(v)==v;}

// Snodgrass & Ulrich (1990), Eq. (4), Table 1. SI seconds; sidereal rate.
inline double solar_rate(const std::string& profile,double latitude) {
  const double s=std::sin(latitude),s2=s*s;
  const std::string model="sun:"+profile;
  return 1e-6*(parameter(model,"A")+parameter(model,"B")*s2+parameter(model,"C")*s2*s2);
}

// Neukum et al. (2001), Eq. (2), Table I (new coefficients). Shape is
// normalized at 1 km, separating the caller's retention age from the SFD.
inline const std::array<double,12>& crater_coefficients() {
  static const auto coefficients=[](){std::array<double,12> a{};for(int j=0;j<12;++j)a[j]=parameter("crater:moon:neukum2001","a"+std::to_string(j));return a;}();
  return coefficients;
}
inline double crater_shape(double diameter_m) {
  const double x=std::log10(diameter_m/1000);
  const auto& a=crater_coefficients();double p=a[11];
  for(int j=10;j>=1;--j)p=p*x+a[j];
  return std::pow(10,p*x);
}
inline double crater_differential(double diameter_m) {
  const double x=std::log10(diameter_m/1000);
  const auto& a=crater_coefficients();double p=11*a[11];
  for(int j=10;j>=1;--j)p=p*x+j*a[j];
  return -crater_shape(diameter_m)*p/diameter_m;
}
// Composite Simpson in log diameter: handles many orders of magnitude
// without assigning every decade the resolution of the largest diameter.
template<class F> inline double integrate_log(F f,double lo,double hi,int n=2048) {
  const double a=std::log(lo),h=(std::log(hi)-a)/n;
  double sum=f(lo)*lo+f(hi)*hi;
  for(int i=1;i<n;++i){const double x=std::exp(a+i*h);sum+=(i%2?4:2)*f(x)*x;}
  return sum*h/3;
}
}
