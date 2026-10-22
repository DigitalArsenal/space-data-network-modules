#pragma once

#include "model_types.hpp"
#include <cstdint>
#include <cstring>
#include <thread>
#include <vector>

namespace milky_way {

// IEEE 754 binary16, round to nearest/even, independent of host endianness.
inline uint16_t to_half(float value) {
  uint32_t bits; std::memcpy(&bits,&value,sizeof(bits));
  const uint16_t sign=static_cast<uint16_t>((bits>>16)&0x8000);
  const uint32_t mantissa=bits&0x7fffff;
  const int exponent=static_cast<int>((bits>>23)&255)-127+15;
  if (((bits>>23)&255)==255) return static_cast<uint16_t>(sign|0x7c00|(mantissa?0x200:0));
  if (exponent>=31) return static_cast<uint16_t>(sign|0x7c00);
  if (exponent<=0) {
    if (exponent<-10) return sign;
    const uint32_t significand=mantissa|0x800000;
    const int shift=14-exponent;
    const uint32_t rounded=(significand+((1u<<(shift-1))-1)+((significand>>shift)&1))>>shift;
    return static_cast<uint16_t>(sign|rounded);
  }
  const uint32_t rounded=mantissa+0xfff+((mantissa>>13)&1);
  const uint32_t result=(static_cast<uint32_t>(exponent)<<10)+(rounded>>13);
  return static_cast<uint16_t>(sign|result);
}

inline float from_half(uint16_t half) {
  const uint32_t sign=static_cast<uint32_t>(half&0x8000)<<16;
  uint32_t mantissa=half&0x3ff,exponent=(half>>10)&31,bits;
  if (exponent==0) {
    if (!mantissa) bits=sign;
    else {
      int e=-14;
      while (!(mantissa&0x400)) { mantissa<<=1; --e; }
      bits=sign|(static_cast<uint32_t>(e+127)<<23)|((mantissa&0x3ff)<<13);
    }
  } else if (exponent==31) bits=sign|0x7f800000|(mantissa<<13);
  else bits=sign|((exponent+112)<<23)|(mantissa<<13);
  float value; std::memcpy(&value,&bits,sizeof(value)); return value;
}

// x varies fastest, then y, then z, then four interleaved binary16 channels.
// x/y are texel-centered. z_mapping=1 is an explicit rectilinear signed-square
// axis, concentrating samples on the thin dust layer. Consumers must use the
// exported z coordinates to map physical positions to texture coordinates.
struct Volume {
  uint32_t nx,ny,nz;
  uint32_t z_mapping;
  Vec3 minimum,maximum;
  std::vector<uint16_t> rgba;
  std::vector<double> z_axis;

  Volume(uint32_t x,uint32_t y,uint32_t z,Vec3 lo,Vec3 hi,uint32_t mapping=0)
    :nx(x),ny(y),nz(z),z_mapping(mapping),minimum(lo),maximum(hi),
     rgba(static_cast<size_t>(x)*y*z*4),z_axis(z) {
    for (uint32_t i=0;i<nz;++i) {
      const double u=2*(i+0.5)/nz-1;
      const double position=z_mapping==1?std::copysign(u*u,u):u;
      z_axis[i]=(minimum.z+maximum.z)/2+position*(maximum.z-minimum.z)/2;
    }
  }
  const std::vector<double>& z_coordinates() const {return z_axis;}
  Vec3 spacing() const { return {(maximum.x-minimum.x)/nx,(maximum.y-minimum.y)/ny,(maximum.z-minimum.z)/nz}; }
  bool contains(Vec3 p) const {
    return p.x>=minimum.x&&p.x<=maximum.x&&p.y>=minimum.y&&p.y<=maximum.y&&p.z>=minimum.z&&p.z<=maximum.z;
  }
  template<class Sampler> void bake(Sampler sample) {
    const Vec3 h=spacing();
    // Disjoint z slabs make scheduling independent of the resulting bytes.
    // The isomorphic wasi-threads build runs these on real shared memory.
    auto slab=[&](uint32_t begin,uint32_t end) {
      size_t offset=static_cast<size_t>(begin)*ny*nx*4;
      for (uint32_t z=begin;z<end;++z) for (uint32_t y=0;y<ny;++y) for (uint32_t x=0;x<nx;++x) {
        const Field f=sample({minimum.x+(x+0.5)*h.x,minimum.y+(y+0.5)*h.y,z_axis[z]});
        for (double v:{f.r,f.g,f.b,f.kappa}) rgba[offset++]=to_half(static_cast<float>(v));
      }
    };
    std::thread a(slab,0,nz/4),b(slab,nz/4,nz/2),c(slab,nz/2,3*nz/4);
    slab(3*nz/4,nz); a.join(); b.join(); c.join();
  }
  Field at(uint32_t x,uint32_t y,uint32_t z) const {
    const size_t i=((static_cast<size_t>(z)*ny+y)*nx+x)*4;
    return {from_half(rgba[i]),from_half(rgba[i+1]),from_half(rgba[i+2]),from_half(rgba[i+3])};
  }
  Field sample(Vec3 p) const {
    if (!contains(p)) return {};
    const Vec3 h=spacing();
    const double u=std::clamp((p.x-minimum.x)/h.x-0.5,0.0,double(nx-1));
    const double v=std::clamp((p.y-minimum.y)/h.y-0.5,0.0,double(ny-1));
    double w=std::clamp((p.z-minimum.z)/h.z-0.5,0.0,double(nz-1));
    if (z_mapping==1) {
      const auto upper=std::upper_bound(z_axis.begin(),z_axis.end(),p.z);
      if (upper==z_axis.begin()) w=0;
      else if (upper==z_axis.end()) w=nz-1;
      else {
        const size_t lower=static_cast<size_t>(upper-z_axis.begin()-1);
        w=lower+(p.z-z_axis[lower])/(z_axis[lower+1]-z_axis[lower]);
      }
    }
    const uint32_t x=static_cast<uint32_t>(u),y=static_cast<uint32_t>(v),z=static_cast<uint32_t>(w);
    const uint32_t xx=std::min(x+1,nx-1),yy=std::min(y+1,ny-1),zz=std::min(z+1,nz-1);
    return mix(mix(mix(at(x,y,z),at(xx,y,z),u-x),mix(at(x,yy,z),at(xx,yy,z),u-x),v-y),
               mix(mix(at(x,y,zz),at(xx,y,zz),u-x),mix(at(x,yy,zz),at(xx,yy,zz),u-x),v-y),w-z);
  }
};

// The global volume covers the disc to 20 kpc and 6 kpc above and below it
// (0.2.0: 16 and 3 kpc, which cut the thick disc's light flat at |z| = 3 kpc
// and the disc at its rim), at 125 pc in x and y and 48 signed-square planes.
// The local one is the Sun's +-1.25 kpc at 19.5 pc. The global volume bakes
// the large-scale dust only; a delivered 3D dust map is baked into the local
// one alone (its 125 pc texels drew the map's clouds as blocks seen from
// outside).
struct NestedVolumes {
  Volume global,local;
  explicit NestedVolumes(Vec3 sun)
    :global(320,320,48,{-20,-20,-6},{20,20,6},1),
     local(128,128,128,sun-Vec3{1.25,1.25,1.25},sun+Vec3{1.25,1.25,1.25}) {}
  template<class Global,class Local> void bake(Global coarse,Local fine) { global.bake(coarse); local.bake(fine); }
  template<class Sampler> void bake(Sampler sample) { bake(sample,sample); }
  Field sample(Vec3 p) const {
    const Field coarse=global.sample(p);
    if (!local.contains(p)) return coarse;
    const double edge=std::min({p.x-local.minimum.x,local.maximum.x-p.x,
      p.y-local.minimum.y,local.maximum.y-p.y,p.z-local.minimum.z,local.maximum.z-p.z});
    return mix(coarse,local.sample(p),smoothstep(0,0.125,edge));
  }
};

} // namespace milky_way
