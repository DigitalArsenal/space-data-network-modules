// Source-built FFM force clock, Earth orientation and DE440 reads. The exact
// PRW TT instant reaches each force API; single-JD fields below are labels only.
#include "ffm/prw_codec.h"
#include "ffm/prw_environment.h"
#include "force_models.cpp" // file-local tides gmst2006, same implementation
#include "ephemeris.h"
#include "nlohmann/json.hpp"
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>
using json=nlohmann::json;
using ffm::dynamics::EarthRotation;
json values(const double m[3][3]){json a=json::array();for(int i=0;i<3;i++)for(int j=0;j<3;j++)a.push_back(m[i][j]);return a;}
json values(const coords::Matrix3x3&m){json a=json::array();for(double x:m.m)a.push_back(x);return a;}
int main(int argc,char**argv){
 if(argc<2){std::cerr<<"usage: ffm-frames eop.bin [de440.bsp]\n";return 2;}
 std::ifstream in(argv[1],std::ios::binary);std::vector<uint8_t> eop((std::istreambuf_iterator<char>(in)),{});
 EarthRotation earth;auto error=sdn::frames::eop::addPayload(eop.data(),eop.size(),earth.rows);
 if(!error.empty()||!earth.validation().empty()){std::cerr<<error<<earth.validation()<<'\n';return 1;}
 std::vector<uint8_t> kernel;
 if(argc>2){std::ifstream k(argv[2],std::ios::binary);kernel.assign(std::istreambuf_iterator<char>(k),{});
  if(!astro::Ephemeris::loadEphemerisBuffer(kernel.data(),kernel.size(),astro::Ephemeris::EphemerisSource::JPL_DE440)){std::cerr<<astro::Ephemeris::ephemerisError()<<'\n';return 1;}}
 std::string line;
 while(std::getline(std::cin,line)){
  if(line.empty())continue;double whole=0,fraction=0,jdUtc=0;ffm::TTEpoch tt;
  if(!ffm::parseIsoSeconds(line,whole,fraction,jdUtc,error)||!ffm::toTT(whole,fraction,jdUtc,timingStandard::UTC,tt,error)){std::cerr<<error<<'\n';return 1;}
  const auto instant=timesys::Instant::fromTTSeconds(tt.whole,tt.fraction);
  if(!earth.covers(instant)){std::cerr<<earth.error<<'\n';return 1;}
  const auto utc=instant.utc(),ut1=earth.ut1(instant),tdb=instant.tdb();
  double c2t[3][3],builtIn[3][3];earth.matrix(instant,c2t);astro::ForceModel::GcrfToEarthFixed(instant,builtIn);
  const coords::Epoch ep{instant.jd1,instant.jd2,utc.jd1,utc.jd2};
  // SGP4's separate 2006/2000A TEME definition, at its UTC-JD API boundary.
  const double day=std::floor(jdUtc-0.5)+0.5;double tai1,tai2;sdn::frames::Epoch se;
  eraUtctai(day,jdUtc-day,&tai1,&tai2);eraTaitt(tai1,tai2,&se.tt1,&se.tt2);
  const auto teme=sdn::frames::gcrfToTeme(se);
  json h={{"utc",line},{"leapSeconds",timesys::getLeapSeconds(jdUtc)},{"ttWhole",tt.whole},{"ttFraction",tt.fraction},
   {"tt1",instant.jd1},{"tt2",instant.jd2},{"tdb1",tdb.jd1},{"tdb2",tdb.jd2},{"utc1",utc.jd1},{"utc2",utc.jd2},{"ut11",ut1.jd1},{"ut12",ut1.jd2},
   {"tdbMinusTtS",instant.tdbMinusTtSeconds()},{"jdTdb",instant.jdTdb()},{"jdTtUsed",instant.tt()},{"jdUt1",ut1.jd()},
   {"etTdb",tdb.secondsSinceJ2000()},{"gmst",astro::ForceModel::gmst2006(ut1,instant)},
   {"c2t",values(c2t)},{"c2tBuiltIn",values(builtIn)},{"gcrfToTeme",values(teme.m)},
   {"coordsPrecession",values(coords::getTransformMatrix(coords::Frame::GCRF,coords::Frame::MOD,ep))},
   {"coordsNutation",values(coords::getTransformMatrix(coords::Frame::MOD,coords::Frame::TOD,ep))},
   {"coordsGcrfToTeme",values(coords::getTransformMatrix(coords::Frame::GCRF,coords::Frame::TEME,ep))},
   {"coordsEcef",values(coords::getTransformMatrix(coords::Frame::GCRF,coords::Frame::ECEF,jdUtc))}};
  if(argc>2)for(const auto& target:std::vector<std::pair<std::string,int>>{{"sun",10},{"moon",301}}){
   const auto s=astro::Ephemeris::getKernelState(target.second,399,instant);
   if(!s.valid){std::cerr<<astro::Ephemeris::ephemerisError()<<'\n';return 1;}
   h[target.first]={s.position.x,s.position.y,s.position.z,s.velocity.x,s.velocity.y,s.velocity.z};}
  std::cout<<h.dump()<<'\n';
 }
 return 0;
}
