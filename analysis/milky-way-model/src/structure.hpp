#pragma once
#include "model_types.hpp"
#include "galactic_constants.hpp"
#include <array>
#include <cmath>
#include <cstdint>

// MULTI-SCALE STRUCTURE (0.5): the flocculent structure of a disc's star
// formation and dust. Elmegreen, Elmegreen & Leitner (2003), ApJ 590, 271
// (arXiv:astro-ph/0305049), abstract and section 3: azimuthal intensity scans
// of spiral galaxies' optical light have power spectra whose slope runs from
// ~ -1 on large scales to ~ -5/3 on small ones, the break at "several hundred
// parsecs ... comparable to the scale height, the inverse of the Jeans
// wavenumber and the size of the largest star complexes"; one-dimensional
// scans are one unit shallower than two-dimensional spectra (their section
// 2), so the field's 2D spectrum here falls as k^-2 above the break and
// k^-8/3 below it, the break at 300 pc (a MODEL CHOICE inside their "several
// hundred").
//
// The field: a deterministic sum of gradient-noise octaves (Perlin 2002's
// quintic fade, a fixed hash; seed `seed`), wavelengths 8 kpc to 62.5 pc, each
// octave's amplitude giving its share of that spectrum (a 2D spectrum
// k^-beta puts variance ~ k^(2 - beta) per octave), normalized to unit
// variance. Sheared along the arms: the noise runs on the cylinder (R,
// R cos phi / A, R sin phi / A), so a structure is A = 3 times longer along
// the rotation than across it (a MODEL CHOICE of the shear's
// elongation; flocculent arms are sheared star-forming regions, Elmegreen et
// al. 2003 section 6).
//
// It modulates the young light and the dust of the thin disc, mean-
// preserving: x -> x exp(sigma S - sigma^2 / 2) for the unit-variance field S.
// The sigmas are the appearance table's (`structure_young_sigma`,
// `structure_dust_sigma`): fitted so the face-on frames' azimuthal-scan
// fluctuation amplitudes match NGC 4414's and M51's (OrbPro
// milky-way-sdss-look E2E, structure).
namespace milky_way::structure {
inline constexpr double break_kpc=0.3,longest_kpc=8.0,elongation=3.0;
inline constexpr int octaves=8; // 8 kpc ... 62.5 pc
inline constexpr uint64_t seed=20261022;
inline double young_sigma=1.5,dust_sigma=2.0;

inline uint32_t hash3(int32_t x,int32_t y,int32_t z,uint32_t s) {
  uint32_t h=uint32_t(x)*0x8da6b343u^uint32_t(y)*0xd8163841u^uint32_t(z)*0xcb1ab31fu^s*0x9e3779b9u;
  h^=h>>13;h*=0x5bd1e995u;h^=h>>15;
  return h;
}
inline double gradient(uint32_t h,double x,double y,double z) {
  // 12 edge directions of the cube (Perlin 2002).
  switch(h%12) {
    case 0: return x+y; case 1: return -x+y; case 2: return x-y; case 3: return -x-y;
    case 4: return x+z; case 5: return -x+z; case 6: return x-z; case 7: return -x-z;
    case 8: return y+z; case 9: return -y+z; case 10: return y-z; default: return -y-z;
  }
}
inline double fade(double t) {return t*t*t*(t*(t*6-15)+10);}
inline double noise(double x,double y,double z,uint32_t s) {
  const double fx=std::floor(x),fy=std::floor(y),fz=std::floor(z);
  const int32_t ix=int32_t(fx),iy=int32_t(fy),iz=int32_t(fz);
  const double dx=x-fx,dy=y-fy,dz=z-fz,u=fade(dx),v=fade(dy),w=fade(dz);
  auto g=[&](int a,int b,int c){return gradient(hash3(ix+a,iy+b,iz+c,s),dx-a,dy-b,dz-c);};
  const double x00=g(0,0,0)+u*(g(1,0,0)-g(0,0,0)),x10=g(0,1,0)+u*(g(1,1,0)-g(0,1,0));
  const double x01=g(0,0,1)+u*(g(1,0,1)-g(0,0,1)),x11=g(0,1,1)+u*(g(1,1,1)-g(0,1,1));
  const double y0=x00+v*(x10-x00),y1=x01+v*(x11-x01);
  return y0+w*(y1-y0);
}
// Octave o's amplitude: variance ~ k^(2 - beta), beta 2 above the break,
// 8/3 below.
inline double amplitude(int o) {
  const double lambda=longest_kpc/std::pow(2.0,o);
  return lambda>=break_kpc?1.0:std::pow(lambda/break_kpc,1.0/3.0);
}
inline const std::array<double,octaves>& amplitudes() {
  static const std::array<double,octaves> a=[] {
    std::array<double,octaves> out{};
    for(int o=0;o<octaves;++o) out[o]=amplitude(o);
    return out;
  }();
  return a;
}
// Octave o's raw term at (x, y, z): its noise on the sheared cylinder, ridged
// (1 - 2|n|) or not. Three-dimensional: the height moves the sample off the
// disc's sheet in noise space along the sheet's unit normal, z / lambda
// lattice units, so clouds decorrelate over a wavelength in z as across it.
// A field of x and y alone stands in columns through the dust layer, which
// oblique rays smear into streaks wherever the layer (~0.1 kpc) is thicker
// than the wavelength; on the kiloparsec octaves the layer moves it little.
inline double octave(double x,double y,double z,int o,uint32_t s,bool ridged) {
  const double r=std::hypot(x,y),phi=std::atan2(y,x);
  const double lambda=longest_kpc/std::pow(2.0,o),c=r/(elongation*lambda);
  const double off=z/lambda/std::sqrt(1+1/(elongation*elongation));
  const double n=noise(r/lambda+0.37*o+off/elongation,(c-off)*std::cos(phi),(c-off)*std::sin(phi),s+uint32_t(o)*7919u);
  return ridged?1-2*std::abs(n):n;
}
// The raw sum at the disc point (x, y) (kpc); `ridged`: each octave as
// 1 - 2|n| (its zero crossings as ridges), the filamentary form of the same
// octave amplitudes (Musgrave's ridged multifractal without the cascade).
inline double raw(double x,double y,uint32_t s,bool ridged=false,double z=0) {
  double sum=0;
  for(int o=0;o<octaves;++o) sum+=amplitudes()[o]*octave(x,y,z,o,s,ridged);
  return sum;
}
// Its mean and standard deviation over the disc (a 0.05 kpc grid within 16
// kpc), once per form.
inline std::array<double,2> raw_moments(bool ridged) {
  double sum=0,sum2=0;long n=0;
  for(double y=-16;y<16;y+=0.05) for(double x=-16;x<16;x+=0.05) {
    if(std::hypot(x,y)>16) continue;
    const double v=raw(x,y,uint32_t(seed),ridged);sum+=v;sum2+=v*v;++n;
  }
  const double mean=sum/n;
  return {mean,std::sqrt(std::max(1e-12,sum2/n-mean*mean))};
}
inline const std::array<double,2>& moments(bool ridged) {
  static const auto smooth=raw_moments(false),ridges=raw_moments(true);
  return ridged?ridges:smooth;
}
// The unit-variance, zero-mean field S at the disc point (x, y).
inline double field(double x,double y,bool ridged=false,double z=0) {
  const auto& m=moments(ridged);
  return (raw(x,y,uint32_t(seed),ridged,z)-m[0])/m[1];
}
// SUB-SLAB DETAIL: the dust field's octaves below the volumes' finest (the
// slab's 62.5 pc texels), 31 and 16 pc, the same spectrum continued, for the
// renderer to add where a pixel resolves them (GalaxyFS): per octave its
// wavelength (kpc), amplitude, the ridged term's mean and variance over the
// disc (as raw_moments), seed and phase. Wright et al. 2023's associations
// reach down to "tens of parsecs"; the renderer evaluates the same noise.
inline constexpr int detail_octaves=2;
struct DetailOctave {double lambda,amplitude,mean,variance,seed,phase;};
inline const std::array<DetailOctave,detail_octaves>& detail() {
  static const std::array<DetailOctave,detail_octaves> out=[] {
    std::array<DetailOctave,detail_octaves> d{};
    for(int k=0;k<detail_octaves;++k) {
      const int o=octaves+k;
      double sum=0,sum2=0;long n=0;
      for(double y=-16;y<16;y+=0.05) for(double x=-16;x<16;x+=0.05) {
        if(std::hypot(x,y)>16) continue;
        const double v=amplitude(o)*octave(x,y,0,o,uint32_t(seed),true);sum+=v;sum2+=v*v;++n;
      }
      const double mean=sum/n;
      d[k]={longest_kpc/std::pow(2.0,o),amplitude(o),mean,std::max(0.0,sum2/n-mean*mean),
            double(uint32_t(seed)+uint32_t(o)*7919u),0.37*o};
    }
    return d;
  }();
  return out;
}
// Near the Sun the sky is measured (Gaia's all-sky maps, the local 3D dust
// map): a statistical dust field there contradicts it (the Gaia check's
// density log r fell from 0.919 to 0.847 with dust sigma 1.5 everywhere). The
// dust's structure fades in from fade_inner to fade_outer kpc from the Sun;
// beyond it nothing measured fixes the clouds' places. The young light's
// structure does not move the Gaia match (0.919 with young sigma 1.5).
inline constexpr double fade_inner_kpc=1.5,fade_outer_kpc=4.0;
inline double away_from_sun(Vec3 p) {
  const double d=std::hypot(p.x+galactic_constants::solar_radius_kpc,p.y);
  const double t=std::clamp((d-fade_inner_kpc)/(fade_outer_kpc-fade_inner_kpc),0.0,1.0);
  return t*t*(3-2*t);
}
// The mean-preserving lognormal modulation exp(sigma S - sigma^2 / 2).
inline double modulation(double x,double y,double sigma,bool ridged=false,double z=0) {
  return sigma>0?std::exp(sigma*field(x,y,ridged,z)-0.5*sigma*sigma):1.0;
}
} // namespace milky_way::structure
