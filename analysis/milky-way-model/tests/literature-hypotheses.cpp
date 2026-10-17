// Native independent evidence, NOT an additional acceptance test. The one
// browser E2E remains authoritative. Usage: executable flux.rgba density.rgba
#include "literature-hypotheses.hpp"
#include "../src/oracle_metrics.hpp"
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>

using namespace milky_way;
std::vector<uint8_t> read(const char* path,size_t size) {
  std::vector<uint8_t> bytes(size);
  std::ifstream file(path,std::ios::binary);
  if(!file.read(reinterpret_cast<char*>(bytes.data()),size)||file.peek()!=EOF)
    throw std::runtime_error("Wrong RGBA byte count");
  return bytes;
}

void report(const char* name,const OracleReport& m) {
  std::cout<<name<<','<<m.flux_r<<','<<m.density_r;
  for(double w:m.fwhm_model)std::cout<<','<<w;
  std::cout<<','<<m.rift_ratio<<','<<m.fit_scale;
  unsigned failed=(m.flux_r<.85)+(m.density_r<.75)+!(m.rift_ratio>0&&m.rift_ratio<1);
  for(double e:m.fwhm_relative_errors)failed+=!(e<=.25);
  std::cout<<','<<failed<<std::endl;
}

void normalization(const NestedVolumes& v) {
  for(double z:{0.,galactic_constants::solar_height_kpc,.3,.9}) {
    const Vec3 p{-galactic_constants::solar_radius_kpc,0,z};
    const auto exact=literature(p),coarse=v.global.sample(p),local=v.local.sample(p),blend=v.sample(p);
    std::cerr<<"local_R0 z="<<z<<" analytic/global/local/blend G="<<exact.r<<'/'<<coarse.r<<'/'<<local.r<<'/'<<blend.r
      <<" kappa="<<exact.kappa<<'/'<<coarse.kappa<<'/'<<local.kappa<<'/'<<blend.kappa<<'\n';
  }
  // Both sides of every local cube face, including bright plane crossings.
  double seam=0,grid_difference=0;
  for(unsigned axis=0;axis<3;++axis)for(int side:{-1,1})
    for(int a=-10;a<=10;++a)for(int b=-10;b<=10;++b) {
      double p[3]={-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
      p[axis]+=side*1.25;p[(axis+1)%3]+=a*.125;p[(axis+2)%3]+=b*.125;
      Vec3 center{p[0],p[1],p[2]};auto c=v.global.sample(center),l=v.local.sample(center);
      if(c.r>1e-4)grid_difference=std::max(grid_difference,std::abs(l.r/c.r-1));
      p[axis]-=side*1e-6;auto inside=v.sample({p[0],p[1],p[2]});
      p[axis]+=side*2e-6;auto outside=v.sample({p[0],p[1],p[2]});
      if(outside.r>1e-4)seam=std::max(seam,std::abs(inside.r/outside.r-1));
    }
  std::cerr<<"max local/global face G relative difference="<<grid_difference
    <<" max blended +/-1e-6 kpc seam="<<seam<<'\n';
}

void measurement_audit(const OracleReport& m) {
  std::vector<float> fitted(m.model_sky.size()),logmodel(fitted.size()),logflux(fitted.size());
  for(size_t i=0;i<fitted.size();++i) {
    fitted[i]=std::exp(m.fit_intercept+m.fit_scale*oracle_detail::log_intensity(m.model_sky[i]));
    logmodel[i]=oracle_detail::log_intensity(fitted[i]);
    logflux[i]=oracle_detail::log_intensity(m.flux_sky[i]);
  }
  std::cerr<<"audit longitude linear_model linear_flux log_model log_flux raw_model\n";
  for(unsigned i=0;i<4;++i)std::cerr<<90*i<<' '<<oracle_detail::fwhm(fitted,180*i)
    <<' '<<oracle_detail::fwhm(m.flux_sky,180*i)<<' '<<oracle_detail::fwhm(logmodel,180*i)
    <<' '<<oracle_detail::fwhm(logflux,180*i)<<' '<<oracle_detail::fwhm(m.model_sky,180*i)<<'\n';
  // Add the same arbitrary constant to every pixel of each map: a shared
  // floor-subtracted FWHM must be invariant. This is a measurement audit,
  // not an added physical halo, and does not change acceptance.
  auto offset_model=fitted,offset_flux=m.flux_sky;
  for(auto& x:offset_model)x+=1;
  for(auto& x:offset_flux)x+=1;
  std::cerr<<"audit +constant FWHM model/oracle ";
  for(unsigned i=0;i<4;++i)std::cerr<<oracle_detail::fwhm(offset_model,180*i)<<'/'
    <<oracle_detail::fwhm(offset_flux,180*i)<<' ';
  std::cerr<<"\nGaia Rift="<<m.flux_rift_ratio<<'\n';
}

int main(int argc,char**argv) {
  if(argc<3||argc>4)throw std::runtime_error("Expected flux.rgba density.rgba [first-case-index]");
  const auto f=read(argv[1],4000*2000*4),d=read(argv[2],1500*750*4);
  const Image flux{f.data(),4000,2000},density{d.data(),1500,750};
  const Vec3 sun{-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
  std::cout<<std::setprecision(12)<<"case,flux_r,density_r,fwhm0,fwhm90,fwhm180,fwhm270,rift,slope,failed\n";
  std::cerr<<std::setprecision(12);
  unsigned case_index=0;
  for(const auto& h:hypotheses::cases) {
    if(argc==4&&case_index++<unsigned(std::stoi(argv[3])))continue;
    NestedVolumes v(sun);v.bake([&](Vec3 p){return hypotheses::sample(p,h);});
    if(h.global_only)v.local.bake([&](Vec3 p){return v.global.sample(p);});
    auto m=oracle_metrics(v,flux,density);report(h.name,m);
    if(std::string(h.name)=="baseline") {normalization(v);measurement_audit(m);}
  }
}
