// Offline ERFA/SPICE evidence reduction. All numerical reductions are C++.
// Sources: pinned pyerfa 2.0.1.5 / CSPICE N0067 records. Frames, units,
// epochs and tolerance rationale are attached by summarize-erfa-spice.mjs.
#include "nlohmann/json.hpp"
#include "coords_types.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
using json=nlohmann::json;
using Mat=coords::Matrix3x3;
constexpr double MAS=3.14159265358979323846/(180.0*3600.0*1000.0);
constexpr double LEO=6778137, GPS=26560000, GEO=42164170;
json read(const char* p){std::ifstream f(p);json j;f>>j;return j;}
Mat matrix(const json& j){Mat m;for(int i=0;i<9;i++)m.m[i]=j.at(i).get<double>();return m;}
std::array<double,3> rotation(const Mat&a,const Mat&b){auto c=a*b.transpose();return {(c.at(2,1)-c.at(1,2))/2,(c.at(0,2)-c.at(2,0))/2,(c.at(1,0)-c.at(0,1))/2};}
double distance(const json&a,const json&b,int first=0){return std::hypot(a[first].get<double>()-b[first].get<double>(),a[first+1].get<double>()-b[first+1].get<double>(),a[first+2].get<double>()-b[first+2].get<double>());}
void maximum(json& row,const std::string& key,double value,const std::string& utc){if(!row.contains(key)||value>row[key].get<double>()){row[key]=value;row[key+"At"]=utc;}}
void rotationScore(json& rows,const char* id,const json& a,const json& b,const std::string& utc){auto v=rotation(matrix(a),matrix(b));const double angle=std::hypot(v[0],v[1],v[2]);auto& row=rows[id];maximum(row,"max",angle/MAS,utc);maximum(row,"poleMas",std::hypot(v[0],v[1])/MAS,utc);maximum(row,"spinMas",std::abs(v[2])/MAS,utc);maximum(row,"leoM",angle*LEO,utc);maximum(row,"gpsM",angle*GPS,utc);maximum(row,"geoM",angle*GEO,utc);}
int main(int argc,char**argv){try{
 if(argc<4){std::cerr<<"usage: frame-diagnostics score hpop.json reference.json\n";return 2;}
 if(std::string(argv[1])=="before-after"){
  const auto B=read(argv[2]),A=read(argv[3]);json out=json::array();
  auto field=[](const json& rows,const std::string& key,const std::string& value){for(const auto&r:rows)if(r.at(key)==value)return r;throw std::runtime_error("Missing row "+value);};
  auto effects=[](double mas,double velocity){const double chord=2*std::sin(mas*MAS/2);return json{{"mas",mas},{"leoM",chord*LEO},{"gpsM",chord*GPS},{"geoM",chord*GEO},{"geoVelocityMS",velocity}};};
  for(const std::string f:{"TEME","MOD","TOD","PEF","ECEF"}){
   json br,ar;for(const auto&r:B["before"]["classicalFrames"]["rows"])if(r["from"]=="GCRF"&&r["to"]==f)br=r;
   for(const auto&r:B["after"]["classicalFrames"]["rows"])if(r["from"]=="GCRF"&&r["to"]==f)ar=r;
   out.push_back({{"frame",f},{"epochs","10,000 UTC epochs, 1990–2040"},{"before",effects(br["rotationMas"],br["velocityMS"])},{"after",effects(ar["rotationMas"],ar["velocityMS"])},{"beforeGeoPositionM",br["positionM"]},{"afterGeoPositionM",ar["positionM"]}});
  }
  for(const std::string id:{"coordsPrecession","coordsNutation","coordsTeme","c2tBuiltInClassical","c2tTrue","coordsEcefCio","sunTrue","moonTrue","forceClock"}){
   json br;for(const auto&r:B["before"]["erfaSpice"]["rows"])if(r["id"]==id)br=r;
   const auto ar=field(A["rows"],"id",id);
   if(!br.is_null())out.push_back({{"frame",id},{"epochs","50 UTC case epochs, June/August 2026"},{"unit",ar["unit"]},{"before",ar["unit"]=="mas"?effects(br["max"],0):json{{"value",br["max"]}}},{"after",ar["unit"]=="mas"?effects(ar["max"],0):json{{"value",ar["max"]}}}});
  }
  std::cout<<out.dump(1)<<'\n';return 0;
 }
 const auto H=read(argv[2]),R=read(argv[3]);std::map<std::string,json> refs;for(auto&r:R["epochs"])refs[r["utc"]]=r;
 json rows=json::object();
 for(const auto&h:H["epochs"]){const std::string utc=h["utc"];const auto&r=refs.at(utc);
  auto scalar=[&](const char* id,double value){maximum(rows[id],"max",std::abs(value),utc);};
  scalar("leap",std::max(std::abs(h["leapSeconds"].get<double>()-r["leapSeconds"].get<double>()),std::abs(h["leapSeconds"].get<double>()-r["leapSecondsSpice"].get<double>())));
  // ERFA supplies independent TT parts. Keep the comparison in C++, with
  // an error-free product residual instead of subtracting full epochs.
  const double refTt2=r["tt2"],refSeconds=refTt2*86400,refWhole=std::floor(refSeconds);
  const double refDaySeconds=(r["tt1"].get<double>()-2451545.0)*86400;
  scalar("tt",(refDaySeconds+refWhole-h["ttWhole"].get<double>())+
    ((refSeconds-refWhole-h["ttFraction"].get<double>())+std::fma(refTt2,86400,-refSeconds)));
  scalar("tdb",h["tdbMinusTtS"].get<double>()-r["tdbMinusTtErfaS"].get<double>());
  scalar("tdbSpice",r["tdbMinusTtSpiceS"].get<double>()-r["tdbMinusTtErfaS"].get<double>());
  scalar("forceClock",r["etHpop"].get<double>()-r["etErfa"].get<double>());
  auto rot=[&](const char* id,const char* hk,const char* rk){rotationScore(rows,id,h[hk],r[rk],utc);};
  rot("c2tSameInstant","c2t","c2tErfaAtHpopInstant");rot("c2tTrue","c2t","c2tErfa");
  rotationScore(rows,"c2tClock",r["c2tErfaAtHpopInstant"],r["c2tErfa"],utc);
  rot("c2tSpice","c2t","c2tSpiceItrf93");rotationScore(rows,"c2tSpiceErfa",r["c2tSpiceItrf93"],r["c2tErfa"],utc);
  scalar("gmstSame",std::remainder(h["gmst"].get<double>()-r["gmst06AtHpopInstant"].get<double>(),2*3.14159265358979323846)/MAS);
  scalar("gmstTrue",std::remainder(h["gmst"].get<double>()-r["gmst06"].get<double>(),2*3.14159265358979323846)/MAS);
  rot("c2tBuiltIn","c2tBuiltIn","c2tErfa");
  rot("coordsPrecession","coordsPrecession","pmat76AtHpopInstant");
  rot("coordsNutation","coordsNutation","nutm80AtHpopInstant");
  rot("coordsTeme","coordsGcrfToTeme","gcrfToTemeFk5AtHpopInstant");
  rot("c2tBuiltInClassical","c2tBuiltIn","c2tClassicalAtHpopInstant");
  rot("teme","gcrfToTeme","gcrfToTemeErfa06");rot("temeFk5","gcrfToTeme","gcrfToTemeFk5");
  rot("coordsEcefCio","coordsEcef","c2tErfa");rot("coordsEcefSpice","coordsEcef","c2tSpiceItrf93");
  for(const std::string body:{"sun","moon"}){
   scalar((body+"Same").c_str(),distance(h[body],r[body+"SpiceAtHpopInstant"])*1000);
   maximum(rows[body+"Same"],"velocityMS",distance(h[body],r[body+"SpiceAtHpopInstant"],3)*1000,utc);
   scalar((body+"True").c_str(),distance(h[body],r[body+"SpiceAtErfaTdb"])*1000);
  }
 }
 if(argc>4){const auto c=read(argv[4]);for(const auto& r:c["rows"]){const double v=r["neglectedRatesMS"];maximum(rows["coordsVelocityRates"],"max",v,r["from"].get<std::string>()+"->"+r["to"].get<std::string>());maximum(rows["coordsVelocityRates"],"leoMS",v*LEO/GEO,"");maximum(rows["coordsVelocityRates"],"gpsMS",v*GPS/GEO,"");}}
 const std::map<std::string,double> limits={{"leap",0},{"tt",1e-9},{"c2tSameInstant",.021},{"c2tTrue",.022},{"gmstSame",.001},{"coordsPrecession",.001},{"coordsNutation",1e-7},{"coordsTeme",1e-7},{"c2tBuiltInClassical",1e-7},{"teme",.001},{"sunSame",.001},{"moonSame",.001},{"c2tSpice",5}};
 for(auto it=rows.begin();it!=rows.end();++it){const auto l=limits.find(it.key());it.value()["tolerance"]=l==limits.end()?json(nullptr):json(l->second);it.value()["met"]=l==limits.end()?json(nullptr):json(it.value()["max"].get<double>()<=l->second);}
 json out={{"epochs",H["epochs"].size()},{"scores",rows}};
 std::cout<<out.dump(1)<<'\n';return 0;
 }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
