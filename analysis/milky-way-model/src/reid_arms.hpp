#pragma once

#include "galactic_constants.hpp"
#include "model_types.hpp"
#include <array>
#include <limits>

namespace milky_way {

inline constexpr unsigned arm_count = 6;

struct ArmSegment {
  const char* name;
  unsigned family;
  double beta_min_deg, beta_max_deg, beta_kink_deg, radius_kpc;
  double pitch_before_deg, pitch_after_deg, width_kpc;
  double beta_kink, tan_before, tan_after, cos_before, cos_after;
  ArmSegment(const char* n,unsigned f,double lo,double hi,double kink,double r,
             double before,double after,double width)
      : name(n),family(f),beta_min_deg(lo),beta_max_deg(hi),beta_kink_deg(kink),
        radius_kpc(r),pitch_before_deg(before),pitch_after_deg(after),width_kpc(width),
        beta_kink(kink*galactic_constants::radians_per_degree),
        tan_before(std::tan(before*galactic_constants::radians_per_degree)),
        tan_after(std::tan(after*galactic_constants::radians_per_degree)),
        cos_before(std::cos(before*galactic_constants::radians_per_degree)),
        cos_after(std::cos(after*galactic_constants::radians_per_degree)) {}
};

// Reid et al. (2019), ApJ 885, 131, doi:10.3847/1538-4357/ab4a11,
// Table 2 central values, transcribed from the locally saved author TeX.
// The table has SEVEN fitted segments for SIX physical arm families: Norma and
// Outer share a family. beta is measured toward Galactic rotation from the Sun
// ray; degrees, kpc, Gaussian one-sigma width. beta_min/max delimit the measured
// parallax coverage, NOT measured boundaries of the arms. Reid used R0=8.15 kpc;
// we keep its fitted radii unchanged while adopting the task's R0=8.178 kpc.
inline const std::array<ArmSegment,7> reid_segments = {{
  {"3-kpc(N)",0, 15,18,15,3.52,-4.2,-4.2,0.18},
  {"Norma",1, 5,54,18,4.46,-1.0,19.5,0.14},
  {"Scutum-Centaurus",2, 0,104,23,4.91,14.1,12.1,0.23},
  {"Sagittarius-Carina",3, 2,97,24,6.04,17.1,1.0,0.27},
  {"Local",4, -8,34,9,8.26,11.4,11.4,0.31},
  {"Perseus",5, -23,115,40,8.87,10.3,8.7,0.35},
  {"Outer",1, -16,71,18,12.24,3.0,9.4,0.65}
}};

inline double arm_radius_kpc(const ArmSegment& a,double beta) {
  const double pitch=beta<=a.beta_kink?a.tan_before:a.tan_after;
  return a.radius_kpc*std::exp(-(beta-a.beta_kink)*pitch);
}

// Shared physical domain for baking and both independent ridge estimators.
// Reid 2019 section 3.2.2 extends Scutum counterclockwise past the far side
// into OSC (G007.47+00.05). A principal-angle wrap at kink +/- pi cuts that
// continuation off. Its outward endpoint is the model's 16-kpc radial edge;
// its inner endpoint is the tabulated 104-degree coverage. Other major arms
// retain explicitly illustrative one-revolution extensions; Local/3-kpc stay
// within their measured coverage. No maser is used to tune a curve here.
inline std::array<double,2> arm_beta_domain(const ArmSegment& a) {
  if(a.family==0||a.family==4)
    return {a.beta_min_deg*galactic_constants::radians_per_degree,
            a.beta_max_deg*galactic_constants::radians_per_degree};
  if(a.family==2)
    return {a.beta_kink-std::log(16.0/a.radius_kpc)/a.tan_before,
            a.beta_max_deg*galactic_constants::radians_per_degree};
  return {a.beta_kink-galactic_constants::pi,a.beta_kink+galactic_constants::pi};
}

inline double model_beta(const ArmSegment& a,double beta) {
  const auto domain=arm_beta_domain(a);
  constexpr double turn=2*galactic_constants::pi;
  // Unwrap around this segment's domain, not around its kink: the observed
  // far-side OSC continuation is at negative unwrapped Galactic azimuth.
  const double middle=(domain[0]+domain[1])/2;
  beta+=turn*std::round((middle-beta)/turn);
  return std::clamp(beta,domain[0],domain[1]);
}

// Euclidean closest-point distance to a kinked logarithmic curve. The two
// smooth sides are minimized separately so Newton iteration never crosses a
// discontinuity in pitch. Used for validation, not the volume's hot loop.
struct ArmClosestPoint {Vec3 point;double beta,distance;};

inline ArmClosestPoint arm_closest_point(const ArmSegment& a,Vec3 p,std::array<double,2> domain) {
  const double beta0=std::atan2(p.y,-p.x);
  ArmClosestPoint best{{},0,std::numeric_limits<double>::infinity()};
  const double domain_lo=domain[0],domain_hi=domain[1];
  for(int side=0;side<2;++side) {
    const double lo=side?std::max(domain_lo,a.beta_kink):domain_lo;
    const double hi=side?domain_hi:std::min(domain_hi,a.beta_kink);
    if(hi<lo) continue;
    const double tangent=side?a.tan_after:a.tan_before;
    for(int wrap=-1;wrap<=1;++wrap) {
      double beta=std::clamp(beta0+wrap*2*galactic_constants::pi,lo,hi);
      for(int iteration=0;iteration<8;++iteration) {
        const double r=arm_radius_kpc(a,beta),c=std::cos(beta),s=std::sin(beta);
        const double x=-r*c,y=r*s,dx=r*(tangent*c+s),dy=r*(-tangent*s+c);
        const double ddx=r*((1-tangent*tangent)*c-2*tangent*s);
        const double ddy=r*((tangent*tangent-1)*s-2*tangent*c);
        const double gradient=(x-p.x)*dx+(y-p.y)*dy;
        const double curvature=dx*dx+dy*dy+(x-p.x)*ddx+(y-p.y)*ddy;
        if(curvature<=0) break;
        beta=std::clamp(beta-std::clamp(gradient/curvature,-0.25,0.25),lo,hi);
      }
      for(double candidate:{lo,beta,hi}) {
        const double r=arm_radius_kpc(a,candidate);
        const Vec3 point{-r*std::cos(candidate),r*std::sin(candidate),0};
        const double distance=std::hypot(p.x-point.x,p.y-point.y);
        if(distance<best.distance) best={point,candidate,distance};
      }
    }
  }
  return best;
}

inline ArmClosestPoint arm_segment_closest_point(const ArmSegment& a,Vec3 p) {
  return arm_closest_point(a,p,arm_beta_domain(a));
}

// Table 2 beta_min/max describe observed parallax coverage, not boundaries of
// the fitted logarithmic spiral (Reid 2019 III.1). A distance to an arbitrary
// endpoint is not d_perp. Continue each side over a full turn for the offline
// likelihood, retaining Scutum's longer far-side continuation. The authored
// finite Local/3-kpc rendering geometry remains unchanged.
inline ArmClosestPoint published_arm_closest_point(const ArmSegment& a,Vec3 p) {
  auto domain=arm_beta_domain(a);
  domain[0]=std::min(domain[0],a.beta_kink-galactic_constants::pi);
  domain[1]=std::max(domain[1],a.beta_kink+galactic_constants::pi);
  return arm_closest_point(a,p,domain);
}

inline double arm_segment_distance_kpc(const ArmSegment& a,Vec3 p) {
  return arm_segment_closest_point(a,p).distance;
}

inline double arm_distance_kpc(unsigned family,Vec3 p) {
  double best=std::numeric_limits<double>::infinity();
  for(const auto& a:reid_segments) if(a.family==family)
    best=std::min(best,arm_segment_distance_kpc(a,p));
  return best;
}


// THE ARMS THE LIGHT AND DUST FOLLOW (0.3.0). Inside each segment's measured
// coverage (Table 2 beta_min..beta_max) the arm is Reid's fitted curve. Beyond
// it the major arms continue as logarithmic spirals at the Galaxy's mean arm
// pitch, 12 deg (Vallee 2017, Ap&SS 362, 79, as the 0.1.0 model cited), for at
// most light_reach_deg, fading over the last light_fade_deg and kept between
// light_inner_kpc and light_outer_kpc. 0.2.0 continued each segment's own
// end pitch a whole turn instead; where that pitch is 1 deg (Sagittarius-
// Carina after its kink, Norma before its) the continuation is a circle, which
// drew the arms as concentric rings. Scutum-Centaurus keeps its own pitch
// outward past the far side (Reid 2019 section 3.2.2, the OSC masers), as
// 0.2.0 did. The extension is a MODEL CHOICE, not a fit; the 3-kpc and Local
// segments stay within their coverage. Validation (arm_beta_domain,
// arm_radius_kpc, ridge and acceptance metrics) keeps Reid's curves unchanged.
namespace arm_light {
inline constexpr double mean_pitch_deg=12.0;
inline constexpr double light_reach_deg=160.0,light_fade_deg=70.0;
inline constexpr double light_inner_kpc=3.2,light_outer_kpc=17.0;
inline const double tan_mean=std::tan(mean_pitch_deg*galactic_constants::radians_per_degree);
inline const double cos_mean=std::cos(mean_pitch_deg*galactic_constants::radians_per_degree);
inline bool finite_segment(const ArmSegment& a) {return a.family==0||a.family==4;}
inline double coverage_lo(const ArmSegment& a) {return a.beta_min_deg*galactic_constants::radians_per_degree;}
inline double coverage_hi(const ArmSegment& a) {return a.beta_max_deg*galactic_constants::radians_per_degree;}
// Outward (decreasing beta) beyond the coverage: Scutum's own pitch, else the mean.
inline double outward_tan(const ArmSegment& a) {return a.family==2?a.tan_before:tan_mean;}
inline double radius(const ArmSegment& a,double beta) {
  if(finite_segment(a)) return arm_radius_kpc(a,beta);
  const double lo=coverage_lo(a),hi=coverage_hi(a);
  if(beta<lo) return arm_radius_kpc(a,lo)*std::exp((lo-beta)*outward_tan(a));
  if(beta>hi) return arm_radius_kpc(a,hi)*std::exp(-(beta-hi)*tan_mean);
  return arm_radius_kpc(a,beta);
}
inline double cos_pitch(const ArmSegment& a,double beta) {
  if(!finite_segment(a)) {
    if(beta<coverage_lo(a)) return a.family==2?a.cos_before:cos_mean;
    if(beta>coverage_hi(a)) return cos_mean;
  }
  return beta<=a.beta_kink?a.cos_before:a.cos_after;
}
// The azimuth range drawn: the coverage, extended to the reach or to the radii.
inline std::array<double,2> domain(const ArmSegment& a) {
  const double lo=coverage_lo(a),hi=coverage_hi(a);
  if(finite_segment(a)) return {lo,hi};
  const double reach=light_reach_deg*galactic_constants::radians_per_degree;
  const double r_lo=arm_radius_kpc(a,lo),r_hi=arm_radius_kpc(a,hi);
  const double out=a.family==2?std::log(std::max(1.0,16.0/r_lo))/outward_tan(a)
                              :std::min(reach,std::log(std::max(1.0,light_outer_kpc/r_lo))/outward_tan(a));
  const double in=std::min(reach,std::log(std::max(1.0,r_hi/light_inner_kpc))/tan_mean);
  return {lo-out,hi+in};
}
// 1 inside the coverage; beyond it, 1 falling to 0 over the extension's last
// light_fade_deg (Scutum's observed far-side continuation is not faded).
inline double weight(const ArmSegment& a,double beta) {
  if(finite_segment(a)) return 1;
  const auto d=domain(a);
  const double fade=light_fade_deg*galactic_constants::radians_per_degree;
  double w=1;
  if(beta<coverage_lo(a)&&a.family!=2) w*=smoothstep(d[0],std::min(coverage_lo(a),d[0]+fade),beta);
  if(beta>coverage_hi(a)) w*=1-smoothstep(std::max(coverage_hi(a),d[1]-fade),d[1],beta);
  return w;
}
struct Hit {double separation,radius,cos_pitch,weight;};
// Every winding of segment a through the azimuth of p within its domain: the
// separation across the arm (radial offset times cos pitch) and the arm's
// radius there. Finite segments (3-kpc, Local) are distances to the curve
// clamped to their coverage, as 0.2.0 drew them.
template<class F> inline void for_each_hit(const ArmSegment& a,Vec3 p,F f) {
  const double r=std::hypot(p.x,p.y),beta0=std::atan2(p.y,-p.x);
  constexpr double turn=2*galactic_constants::pi;
  if(finite_segment(a)) {
    const double beta=model_beta(a,beta0),ra=arm_radius_kpc(a,beta);
    f(Hit{std::hypot(p.x+ra*std::cos(beta),p.y-ra*std::sin(beta)),ra,cos_pitch(a,beta),1.0});
    return;
  }
  const auto d=domain(a);
  for(int k=-2;k<=2;++k) {
    const double beta=beta0+k*turn;
    if(beta<d[0]||beta>d[1]) continue;
    const double ra=radius(a,beta),c=cos_pitch(a,beta);
    f(Hit{std::abs(r-ra)*c,ra,c,weight(a,beta)});
  }
}
} // namespace arm_light

} // namespace milky_way
