// ONE E2E's native producer and reducer. Independent references: pyerfa
// ERFA 2.0.1 pmat76/nutm80/pnm80/eqeq94/gst94/pom00, UTC->TAI->TT.
// Positions metres, velocities m/s, angular errors mas. All eight public frame
// values, 10,000 epochs 1990-2040, six GEO directions. 1 um and 1 nm/s budgets
// cover roundoff only: both sides implement the same published ERFA model.
#include "coords.h"
#include "nlohmann/json.hpp"
#include <array>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <limits>
#include <iostream>
#include <string>
using json = nlohmann::json;
using Mat = coords::Matrix3x3;
using Vec = coords::Vec3;
constexpr double GEO=42164170.0, GPS=26560000.0, LEO=6778137.0;
constexpr double MAS=3.14159265358979323846/(180*3600*1000);
const char* names[]={"TEME","GCRF","ITRF","J2000","ECEF","PEF","TOD","MOD"};
bool rotating(int f){return f==2||f==4||f==5;}
Mat pair(const std::array<Mat,8>& b,int from,int to){
 if(from==to||(from==1&&to==3)||(from==3&&to==1)||
   (rotating(from)&&rotating(to)))return Mat();
 // Direct MOD/TOD retains the independently provided bases' roundoff only.
 return b[to]*b[from].transpose();
}
double angular(const Mat&a,const Mat&b){
 auto m=a*b.transpose();
 double s=std::hypot(m.m[7]-m.m[5],m.m[2]-m.m[6],m.m[3]-m.m[1])/2;
 double c=(m.m[0]+m.m[4]+m.m[8]-1)/2;
 return std::atan2(s,c)/MAS;
}
void maximum(json& row,const char* key,double value,double jd){
 if(!row.contains(key)||value>row[key].get<double>()){
  row[key]=value;row[std::string(key)+"AtUtcJd"]=jd;
 }
}
Vec velocity(const Mat&m,Vec r,Vec v,int from,int to,double spin){
 Vec result=m.apply(v),position=m.apply(r),omega(0,0,spin);
 if(rotating(to)&&!rotating(from))result=result-omega.cross(position);
 if(rotating(from)&&!rotating(to))result=result+m.apply(omega.cross(r));
 return result;
}
std::array<Vec,6> directions(){return {Vec(1,0,0),Vec(0,1,0),Vec(0,0,1),
 Vec(1,1,1).normalize(),Vec(-1,2,3).normalize(),Vec(3,-2,1).normalize()};}
int main(int argc,char**argv){
 std::cout<<std::setprecision(17);
 const std::string mode=argc>1?argv[1]:"";
 if(mode=="epochs"){
  uint32_t seed=0x76a1980u;
  for(int i=0;i<10000;i++){
   seed=1664525u*seed+1013904223u;
   double jitter=(double(seed)/4294967296.0-0.5)*0.8;
   double jd=2447892.5+(2466154.5-2447892.5)*double(i)/9999.0+jitter/86400;
   if(i==0)jd=2447892.5;if(i==9999)jd=2466154.5;
   std::cout<<jd<<'\n';
  }return 0;
 }
 if(mode=="wasm-seeds"){
  json seeds=json::array();std::ifstream in(argv[2]);double jd;int i=0;
  while(in>>jd){if(i%1000==0||i==9999)seeds.push_back({{"jdUtc",jd},
   {"positionKm",{GEO/1000,0,0}},{"velocityKmS",{0,3.07466,0}}});++i;}
  std::cout<<seeds.dump();return 0;
 }
 if(mode=="wasm"){
  std::ifstream in(argv[2]);json rows;in>>rows;json out={{"samples",rows.size()},{"maxPositionM",0.0},{"rows",json::array()}};
  for(auto&r:rows){Vec p(r["positionKm"][0],r["positionKm"][1],r["positionKm"][2]);
   Vec e=coords::getTransformMatrix(coords::Frame::GCRF,coords::Frame::ECEF,r["jdUtc"]).apply(p)*1000;
   Vec w(r["ecefM"][0],r["ecefM"][1],r["ecefM"][2]);maximum(out,"maxPositionM",(e-w).magnitude(),r["jdUtc"]);
   out["rows"].push_back({{"jdUtc",r["jdUtc"]},{"nativeM",{e.x,e.y,e.z}},{"wasmM",r["ecefM"]},{"differenceM",(e-w).magnitude()}});}
  out["met"]=out["maxPositionM"].get<double>()==0;std::cout<<out.dump();return 0;
 }
 if(mode!="compare"&&mode!="matrix-compare")return 2;
 const bool matricesOnly=mode=="matrix-compare";
 std::ifstream in(argv[2],std::ios::binary);std::array<double,222> data{};
 std::array<json,64> stats;json diagnostic;size_t count=0;double allP=0,allV=0;
 for(int f=0;f<8;f++)for(int t=0;t<8;t++)stats[f*8+t]={{"from",names[f]},{"to",names[t]}};
 while(in.read(reinterpret_cast<char*>(data.data()),sizeof(data))){
  const double jd=data[0],spin=data[5];std::array<Mat,8> b,bm,bp;
  for(int f=0;f<8;f++){b[f]=Mat(data.data()+6+f*9);bm[f]=Mat(data.data()+78+f*9);bp[f]=Mat(data.data()+150+f*9);}
  for(int f=0;f<8;f++)for(int t=0;t<8;t++){
   auto from=static_cast<coords::Frame>(f),to=static_cast<coords::Frame>(t);
   const Mat actual=coords::getTransformMatrix(from,to,jd),ref=pair(b,f,t),m=pair(bm,f,t),p=pair(bp,f,t);
   auto& row=stats[f*8+t];maximum(row,"rotationMas",angular(actual,ref),jd);
#ifdef HPOP_COORDS_EPOCH
   const coords::Epoch epoch{data[1],data[2],data[3],data[4]};
   const Mat explicitMatrix=coords::getTransformMatrix(from,to,epoch);
   maximum(row,"epochOverloadMatrixMas",angular(explicitMatrix,actual),jd);
#endif
   for(auto direction:directions()){
    Vec r=direction*GEO,v=Vec(-direction.y,direction.x,direction.z).normalize()*3074.66;
    auto state=matricesOnly?coords::StateVec(actual.apply(r),velocity(actual,r,v,f,t,spin)):
     coords::transform(coords::StateVec(r,v),from,to,jd);
    Vec refP=ref.apply(r),refV=velocity(ref,r,v,f,t,spin);
    double pe=(state.position-refP).magnitude(),ve=(state.velocity-refV).magnitude();
#ifdef HPOP_COORDS_EPOCH
    auto explicitState=matricesOnly?state:coords::transform(coords::StateVec(r,v),from,to,epoch);
    maximum(row,"epochOverloadPositionM",(explicitState.position-refP).magnitude(),jd);
    maximum(row,"epochOverloadVelocityMS",(explicitState.velocity-refV).magnitude(),jd);
    pe=std::max(pe,(explicitState.position-refP).magnitude());
    ve=std::max(ve,(explicitState.velocity-refV).magnitude());
#endif
    maximum(row,"positionM",pe,jd);maximum(row,"velocityMS",ve,jd);
    allP=std::max(allP,pe);allV=std::max(allV,ve);
    Vec full=ref.apply(v)+(p.apply(r)-m.apply(r))*0.5;
    maximum(row,"neglectedRatesMS",(refV-full).magnitude(),jd);
   }
  }
  ++count;
 }
 json rows=json::array();bool pass=count==10000;
#ifdef HPOP_COORDS_EPOCH
 const double nan=std::numeric_limits<double>::quiet_NaN();
 const auto badFrame=static_cast<coords::Frame>(255);
 const coords::Epoch goodEpoch{2451545.0,0,2451545.0,0},badEpoch{nan,0,2451545.0,0};
 auto flagged=[](const Mat& matrix){for(double value:matrix.m)if(!std::isnan(value))return false;return true;};
 const bool invalidMatrixFlagged=flagged(coords::getTransformMatrix(badFrame,coords::Frame::GCRF,goodEpoch))&&
  flagged(coords::getTransformMatrix(badFrame,badFrame,goodEpoch))&&
  flagged(coords::getTransformMatrix(coords::Frame::GCRF,coords::Frame::GCRF,badEpoch))&&
  flagged(coords::getTransformMatrix(coords::Frame::GCRF,coords::Frame::GCRF,nan));
 const auto badState=coords::transform(coords::StateVec(Vec(1,2,3),Vec(4,5,6)),badFrame,coords::Frame::GCRF,goodEpoch);
 const bool invalidStateFlagged=std::isnan(badState.position.x)&&std::isnan(badState.position.y)&&std::isnan(badState.position.z)&&
  std::isnan(badState.velocity.x)&&std::isnan(badState.velocity.y)&&std::isnan(badState.velocity.z);
 pass=pass&&invalidMatrixFlagged&&invalidStateFlagged;
#endif
 for(auto&row:stats){row["positionToleranceM"]=1e-6;row["velocityToleranceMS"]=1e-9;
  row["met"]=row["positionM"].get<double>()<=1e-6&&row["velocityMS"].get<double>()<=1e-9;
  row["positionBounds"]={{"leoM",row["rotationMas"].get<double>()*MAS*LEO},{"gpsM",row["rotationMas"].get<double>()*MAS*GPS},{"geoM",row["rotationMas"].get<double>()*MAS*GEO}};
  pass=pass&&row["met"].get<bool>();rows.push_back(row);
 }
 // Isolate the wrong-pole transport from matrix defects at the case epoch.
 double jd=2461254.5;Mat m=coords::getTransformMatrix(coords::Frame::GCRF,coords::Frame::ECEF,jd);
 json axis;
 for(auto entry:std::array<std::pair<const char*,double>,3>{{{"leoMS",LEO},{"gpsMS",GPS},{"geoMS",GEO}}}){
  double worst=0;for(auto d:directions()){
   const Vec r=d*entry.second;
   const auto actual=coords::transform(coords::StateVec(r,Vec()),coords::Frame::GCRF,coords::Frame::ECEF,jd);
   const double t=(jd-2451545.0)/36525.0;
   const double rate=(1+(8640184.812866+(2*0.093104-3*6.2e-6*t)*t)/(36525.0*86400.0))*(2*3.14159265358979323846/86400.0);
   const Vec expected=velocity(m,r,Vec(),1,4,rate);
   worst=std::max(worst,(actual.velocity-expected).magnitude());
  }axis[entry.first]=worst;
 }
 axis["epochUtc"]="2026-08-02T00:00:00.000";axis["poleSeparationArcsec"]=std::acos(std::clamp(m.m[8],-1.0,1.0))/MAS/1000;
 json out={{"epochs",count},{"pairs",64},{"directions",6},{"rows",rows},{"maxPositionM",allP},{"maxVelocityMS",allV},{"velocityAxisDefect",axis},{"met",pass},
 {"reference","Independent pyerfa ERFA 2.0.1 classical FK5 chain, exact UTC day/fraction to TT; UT1=UTC, xp=yp=0, no frame bias"},
 {"diagnostic","neglectedRatesMS: full ERFA chain central difference, delta=1 s, versus Earth-rotation-only rule; includes finite-difference truncation/roundoff"}};
#ifdef HPOP_COORDS_EPOCH
 out["invalidInputs"]={{"matrixFlagged",invalidMatrixFlagged},{"stateFlagged",invalidStateFlagged}};
#endif
 std::cout<<out.dump(1)<<'\n';return 0;
}
