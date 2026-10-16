// Offline evidence reduction, never linked into HPOP. All rotations, clock
// differences and position errors are evaluated in C++ against vendored ERFA.
// Source: ERFA 2.0.1 / SOFA 20231011 nut80, prec76, pmat76, pnm06a; the pinned
// independent pyerfa/SPICE records. Angles are mas, positions metres, dates TT
// unless explicitly UTC. See diagnosis.json for epochs, bounds and rationale.
#include "nlohmann/json.hpp"
#include "coords.cpp"
#include "time_convert.cpp"
#include "axis_engine.hpp"
#include <fstream>
#include <iostream>
#include <map>
#include <array>
#include <iomanip>
using json=nlohmann::json;
using Mat=coords::Matrix3x3;
constexpr double MAS=ERFA_DAS2R/1000, LEO=6778137, GPS=26560000, GEO=42164170;
static const coords::NutationCoeff referenceTerms[]={
#include "erfa-nutation-table.inc"
};
json read(const char* p){std::ifstream f(p);json j;f>>j;return j;}
Mat matrix(const json& j){Mat m;for(int i=0;i<9;i++)m.set(i/3,i%3,j.at(i).get<double>());return m;}
Mat matrix(double m[3][3]){Mat a;for(int i=0;i<3;i++)for(int k=0;k<3;k++)a.set(i,k,m[i][k]);return a;}
json values(const Mat& m){json a=json::array();for(int i=0;i<3;i++)for(int k=0;k<3;k++)a.push_back(m.at(i,k));return a;}
std::array<double,3> rotation(const Mat&a,const Mat&b){auto c=a*b.transpose();return {(c.at(2,1)-c.at(1,2))/2,(c.at(0,2)-c.at(2,0))/2,(c.at(1,0)-c.at(0,1))/2};}
double angle(const Mat&a,const Mat&b){auto v=rotation(a,b);return std::hypot(v[0],v[1],v[2])/MAS;}
json effect(double a){return {{"angleMas",a},{"leoM",a*MAS*LEO},{"gpsM",a*MAS*GPS},{"geoM",a*MAS*GEO}};}
json key(const coords::NutationCoeff& c){return {c.l,c.lp,c.F,c.D,c.Om};}
bool same(const coords::NutationCoeff&a,const coords::NutationCoeff&b){return key(a)==key(b);}
void args(double t,double&a,double&b,double&c,double&d,double&e){
 a=eraAnpm((485866.733+(715922.633+(31.310+0.064*t)*t)*t)*ERFA_DAS2R+std::fmod(1325*t,1)*ERFA_D2PI);
 b=eraAnpm((1287099.804+(1292581.224+(-0.577-0.012*t)*t)*t)*ERFA_DAS2R+std::fmod(99*t,1)*ERFA_D2PI);
 c=eraAnpm((335778.877+(295263.137+(-13.257+0.011*t)*t)*t)*ERFA_DAS2R+std::fmod(1342*t,1)*ERFA_D2PI);
 d=eraAnpm((1072261.307+(1105601.328+(-6.891+0.019*t)*t)*t)*ERFA_DAS2R+std::fmod(1236*t,1)*ERFA_D2PI);
 e=eraAnpm((450160.280+(-482890.539+(7.455+0.008*t)*t)*t)*ERFA_DAS2R+std::fmod(-5*t,1)*ERFA_D2PI);
}
std::array<double,2> sum(double jd,bool kept,bool hpopArgs=false){
 double t=(jd-2451545)/36525,a,b,c,d,e,p=0,q=0;args(t,a,b,c,d,e);
 if(hpopArgs)coords::fundamentalArguments(t,a,b,c,d,e);
 for(const auto& x:referenceTerms){bool found=false;for(const auto&h:coords::NUTATION_COEFFS)found|=same(x,h);if(found!=kept)continue;
 const double arg=x.l*a+x.lp*b+x.F*c+x.D*d+x.Om*e;p+=(x.Sp+x.Cp*t)*std::sin(arg);q+=(x.Se+x.Ce*t)*std::cos(arg);}
 return {p*0.0001*ERFA_DAS2R,q*0.0001*ERFA_DAS2R};
}
Mat nut(double eps,double p,double q){double a[3][3];eraNumat(eps,p,q,a);return matrix(a);}
void maximum(json& obj,const std::string& key,double v,const std::string& utc){if(!obj.contains(key)||v>obj[key]["value"].get<double>())obj[key]={{"value",v},{"utc",utc}};}
void epoch(const std::string& utc,double&u1,double&u2,double&t1,double&t2){int y,m,d,h,n;double s,a,b;std::sscanf(utc.c_str(),"%d-%d-%dT%d:%d:%lf",&y,&m,&d,&h,&n,&s);eraDtf2d("UTC",y,m,d,h,n,s,&u1,&u2);eraUtctai(u1,u2,&a,&b);eraTaitt(a,b,&t1,&t2);}
int main(int argc,char**argv){try{
 std::string mode=argv[1];json H=read(argv[2]),R=read(argv[3]);std::map<std::string,json> refs;for(auto&r:R["epochs"])refs[r["utc"]]=r;
 if(mode=="teme"){
  double worst=0,stored=0,freshBoth=0,referenceReplay=0;for(const auto&h:H["epochs"]){double u1,u2,t1,t2,a,b;epoch(h["utc"],u1,u2,t1,t2);const double jd=u1+u2,day=std::floor(jd-0.5)+0.5;
   sdn::frames::Epoch ep;eraUtctai(day,jd-day,&a,&b);eraTaitt(a,b,&ep.tt1,&ep.tt2);auto hm=sdn::frames::gcrfToTeme(ep);Mat m;for(int i=0;i<3;i++)for(int j=0;j<3;j++)m.set(i,j,hm.m[i][j]);
   double p[3][3];eraPnm06a(t1,t2,p);eraRz(eraEe06a(t1,t2),p);
   stored=std::max(stored,angle(matrix(h["gcrfToTeme"]),matrix(refs[h["utc"]]["gcrfToTemeErfa06"])));worst=std::max(worst,angle(m,matrix(refs[h["utc"]]["gcrfToTemeErfa06"])));referenceReplay=std::max(referenceReplay,angle(matrix(p),matrix(refs[h["utc"]]["gcrfToTemeErfa06"])));freshBoth=std::max(freshBoth,angle(m,matrix(p)));
  }json comparison=json::object();if(argc>4){auto s=read(argv[4]);for(const auto&row:s["rows"])if(row["id"]=="teme"){double expected=row["max"];comparison={{"storedMatches",std::abs(stored-expected)<=1e-21},{"freshMatches",std::abs(worst-expected)<=1e-9},{"freshBothMatches",std::abs(freshBoth-expected)<=1e-8},{"referenceMatches",referenceReplay<=1e-8},{"freshBothToleranceMas",1e-8},{"storedToleranceMas",1e-21},{"freshToleranceMas",1e-9}};}}std::cout<<json({{"comparison",comparison},{"id","teme"},{"max",stored},{"freshMax",worst},{"freshBothMax",freshBoth},{"freshMinusStoredMas",std::abs(worst-stored)},{"referenceReplayMas",referenceReplay},{"epochs",H["epochs"].size()}}).dump()<<'\n';return 0;
 }
 if(mode=="force"){
  auto f=read(argv[4]);auto a=f["withoutEop"]["positionKm"].get<std::array<double,3>>(),b=f["withEop"]["positionKm"].get<std::array<double,3>>();
  f["differenceM"]=std::hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])*1000;std::cout<<f.dump(1)<<'\n';return 0;
 }
 if(mode=="wasm"){
  json W=read(argv[4]),out=json::array();for(const auto&w:W){const auto&r=refs[w["utc"]];auto p=w["positionKm"].get<std::array<double,3>>();auto a=w["ecefM"].get<std::array<double,3>>();double jd=w["jdUtc"],t1,t2,u1,u2;epoch(w["utc"],u1,u2,t1,t2);
   auto target=matrix(r["c2tErfa"]);auto native=coords::gcrfToItrf(jd);double prec[3][3],n[3][3];eraPmat76(2451545,jd-2451545,prec);eraNutm80(2451545,jd-2451545,n);
   auto correctedP=Mat::rotateZ(coords::gast(jd))*coords::nutationMatrix(jd)*matrix(prec);
   auto correctedPN=Mat::rotateZ(coords::gast(jd))*matrix(n)*matrix(prec);
   auto distance=[&](const Mat&m,const Mat*other){double sum=0;auto v=m.apply({p[0],p[1],p[2]});auto b=other?other->apply({p[0],p[1],p[2]}):coords::Vec3(a[0]/1000,a[1]/1000,a[2]/1000);for(double d:{v.x-b.x,v.y-b.y,v.z-b.z})sum+=d*d;return std::sqrt(sum)*1000;};
   out.push_back({{"utc",w["utc"]},{"jdUtc",jd},{"radiusM",w["radiusM"]},{"gcrfPositionKm",p},{"ecefM",a},{"wasmMinusNativeM",distance(native,nullptr)},{"wasmMinusErfaCioM",distance(target,nullptr)},{"precessionOnlyEffectM",distance(correctedP,&native)},{"precessionAndNutationEffectM",distance(correctedPN,&native)}});
  }std::cout<<out.dump(1)<<'\n';return 0;
 }
 json out,measure,coeff=json::array(),omitted=json::array();
 for(const auto&h:coords::NUTATION_COEFFS){bool found=false;for(const auto&r:referenceTerms)if(same(h,r)){found=true;if(h.Sp!=r.Sp||h.Cp!=r.Cp||h.Se!=r.Se||h.Ce!=r.Ce)coeff.push_back({{"multipliers",key(h)},{"hpop",{h.Sp,h.Cp,h.Se,h.Ce}},{"erfa",{r.Sp,r.Cp,r.Se,r.Ce}}});}if(!found)coeff.push_back({{"multipliers",key(h)},{"hpop",{h.Sp,h.Cp,h.Se,h.Ce}},{"erfa",nullptr}});}
 for(const auto&r:referenceTerms){bool found=false;for(const auto&h:coords::NUTATION_COEFFS)found|=same(h,r);if(!found)omitted.push_back(key(r));}
 out["coefficientMismatches"]=coeff;out["retainedTerms"]=coords::NUM_NUTATION_TERMS;out["omittedTerms"]=omitted.size();out["omittedMultipliers"]=omitted;json omittedCoefficients=json::array();double maxOmitted=0;
 for(const auto&r:referenceTerms){bool found=false;for(const auto&h:coords::NUTATION_COEFFS)found|=same(h,r);if(!found){double amplitude=std::max(std::abs(r.Sp),std::abs(r.Se))*0.1;maxOmitted=std::max(maxOmitted,amplitude);omittedCoefficients.push_back({{"multipliers",key(r)},{"longitudeMas",r.Sp*0.1},{"obliquityMas",r.Se*0.1}});}}
 out["omittedCoefficients"]=omittedCoefficients;out["maxOmittedCoefficientMas"]=maxOmitted;
 json epochs=json::array();double clockWorst=0,cachedTt=-1e300,cachedEq=0;Mat cachedNP,cachedCorrectedP,cachedCorrectedPN,cachedAllCorrected;
 for(const auto&h:H["epochs"]){std::string utc=h["utc"];auto r=refs[utc];double jd=h["jdTtUsed"],T=(jd-2451545)/36525,eps=eraObl80(2451545,jd-2451545),u1,u2,t1,t2;epoch(utc,u1,u2,t1,t2);
  double zeta,theta,z;eraPrec76(2451545,0,2451545,jd-2451545,&zeta,&z,&theta);
  double hzeta=((2306.2181+1.39656*T-0.000139*T*T)*T+(0.30188-0.000344*T)*T*T+0.017998*T*T*T)*ERFA_DAS2R;
  double htheta=((2004.3109-0.85330*T-0.000217*T*T)*T-(0.42665+0.000217*T)*T*T-0.041833*T*T*T)*ERFA_DAS2R;
  double hz=((2306.2181+1.39656*T-0.000139*T*T)*T+(1.09468+0.000066*T)*T*T+0.018203*T*T*T)*ERFA_DAS2R;
  auto keep=sum(jd,true),omit=sum(jd,false),ka=sum(jd,true,true);double p,q;coords::nutation(jd,p,q);double ep,eq;eraNut80(2451545,jd-2451545,&ep,&eq);
  auto N=coords::nutationMatrix(jd),Nr=nut(eps,ep,eq),Nk=nut(eps,keep[0],keep[1]),Nka=nut(eps,ka[0],ka[1]);
  auto P=coords::precession(jd);double pm[3][3];eraPmat76(2451545,jd-2451545,pm);auto Pr=matrix(pm);
  if(std::abs(jd-cachedTt)>1.0/24){cachedTt=jd;cachedNP=N*P;cachedCorrectedP=N*Pr;cachedCorrectedPN=Nr*Pr;cachedEq=coords::equationOfEquinoxes(jd);cachedAllCorrected=Mat::rotateZ(eraEqeq94(2451545,jd-2451545))*Nr*Pr;}
  const double ju=timesys::taiToUtc(timesys::ttToTai(jd));auto spin=Mat::rotateZ(coords::gmst(ju)+cachedEq);auto classical=matrix(r["c2tClassicalAtHpopInstant"]);
  maximum(measure,"fallbackReproductionMas",angle(spin*cachedNP,matrix(h["c2tBuiltIn"])),utc);
  maximum(measure,"fallbackClassicalMas",angle(spin*cachedNP,classical),utc);
  maximum(measure,"fallbackCorrectedPrecessionMas",angle(spin*cachedCorrectedP,classical),utc);
  maximum(measure,"fallbackCorrectedPrecessionNutationMas",angle(spin*cachedCorrectedPN,classical),utc);
  maximum(measure,"fallbackCorrectedPrecessionNutationEqeqMas",angle(Mat::rotateZ(coords::gmst(ju))*cachedAllCorrected,classical),utc);
  json row={{"utc",utc},{"jdTt",jd},{"zetaExcessMas",(hzeta-zeta)/MAS},{"thetaExcessMas",(htheta-theta)/MAS},{"zExcessMas",(hz-z)/MAS},{"precessionMas",angle(P,Pr)},
   {"nutationMas",angle(N,Nr)},{"coefficientsMas",angle(N,Nka)},{"omittedMas",angle(Nk,Nr)},{"argumentsMas",angle(Nka,Nk)},{"eps0DifferenceMas",(coords::meanObliquity(jd)-eps)/MAS},
   {"dpsiDifferenceMas",(p-ep)/MAS},{"depsDifferenceMas",(q-eq)/MAS},{"coefficientDpsiMas",(p-ka[0])/MAS},{"coefficientDepsMas",(q-ka[1])/MAS},{"argumentDpsiMas",(ka[0]-keep[0])/MAS},{"argumentDepsMas",(ka[1]-keep[1])/MAS},{"omittedDpsiMas",omit[0]/MAS},{"omittedDepsMas",omit[1]/MAS},
   {"sumVsErfaMas",std::hypot(keep[0]+omit[0]-ep,keep[1]+omit[1]-eq)/MAS},
   {"coordsTemeMas",angle(coords::gcrfToTeme(jd),matrix(r["gcrfToTemeFk5AtHpopInstant"]))},
   {"temeWithCorrectedPrecessionMas",angle(Mat::rotateZ(coords::equationOfEquinoxes(jd))*N*Pr,matrix(r["gcrfToTemeFk5AtHpopInstant"]))},
   {"temeWithCorrectedPrecessionNutationMas",angle(Mat::rotateZ(coords::equationOfEquinoxes(jd))*Nr*Pr,matrix(r["gcrfToTemeFk5AtHpopInstant"]))},{"temeWithCorrectedPrecessionNutationEqeqMas",angle(Mat::rotateZ(ep*std::cos(eps+eq))*Nr*Pr,matrix(r["gcrfToTemeFk5AtHpopInstant"]))},{"temeWithFullErfaEqeqMas",angle(Mat::rotateZ(eraEqeq94(2451545,jd-2451545))*Nr*Pr,matrix(r["gcrfToTemeFk5AtHpopInstant"]))}};
  for(const auto& k:{"precessionMas","nutationMas","coefficientsMas","omittedMas","argumentsMas","sumVsErfaMas","coordsTemeMas","temeWithCorrectedPrecessionMas","temeWithCorrectedPrecessionNutationMas","temeWithCorrectedPrecessionNutationEqeqMas","temeWithFullErfaEqeqMas"})maximum(measure,k,row[k],utc);
  // TT date error is decomposed without subtracting large full Julian dates.
  
  const double usedOffset=(jd-t1)-t2;
  const double roundTripS=usedOffset*86400;
  const double approx=timesys::tdbToTt(h["jdTdb"]),tdb=h["jdTdb"],refDtdb=r["tdbMinusTtErfaS"];
  const double forceOffsetS=((tdb-t1)-t2)*86400-refDtdb;
  const double clock=angle(matrix(r["c2tErfaAtHpopInstant"]),matrix(r["c2tErfa"]));
  row["clock"]={{"forceTdbErrorS",forceOffsetS},{"tdbToTtQuantizedCorrectionS",(tdb-approx)*86400},{"erfaTdbMinusTtS",refDtdb},{"ttInstantErrorS",roundTripS},{"predictedSpinMas",std::abs(roundTripS)*7.29211514670698e-5/MAS},{"measuredClockMas",clock},{"rotationEvaluationResidualMas",clock-std::abs(roundTripS)*7.29211514670698e-5/MAS},{"decompositionSumS",forceOffsetS+refDtdb-(tdb-approx)*86400}};
  if(clock>clockWorst){clockWorst=clock;out["worstClock"]=row["clock"];out["worstClock"]["utc"]=utc;}
  maximum(measure,"forceTdbErrorS",std::abs(forceOffsetS),utc);maximum(measure,"ttInstantErrorS",std::abs(roundTripS),utc);
  epochs.push_back(row);
 }
 out["epochs"]=epochs;out["maxima"]=measure;out["precessionBound"]=effect(measure["precessionMas"]["value"]);out["nutationBound"]=effect(measure["nutationMas"]["value"]);out["clockBound"]=effect(clockWorst);
 double sameInstant=0;for(const auto&h:H["epochs"])sameInstant=std::max(sameInstant,angle(matrix(h["c2t"]),matrix(refs[h["utc"]]["c2tErfaAtHpopInstant"])));out["clockPlusInterpolationBound"]=effect(clockWorst+sameInstant);
 out["clockPrecision"]={{"singleDoubleJdUlpSeconds",(std::nextafter(2461254.5,INFINITY)-2461254.5)*86400},{"earthRotationRadS",7.29211514670698e-5},{"allowedTimeErrorAt022MasS",0.022*MAS/7.29211514670698e-5}};
 double spread=0,comparison=0,trueC2t=0;for(const auto&h:H["epochs"]){auto r=refs[h["utc"]];spread=std::max(spread,angle(matrix(r["c2tErfa"]),matrix(r["c2tSpiceItrf93"])));comparison=std::max(comparison,angle(matrix(h["c2t"]),matrix(r["c2tSpiceItrf93"])));trueC2t=std::max(trueC2t,angle(matrix(h["c2t"]),matrix(r["c2tErfa"])));}
 out["referenceSpread"]={{"spiceErfaMas",spread},{"hpopSpiceMas",comparison},{"hpopErfaMas",trueC2t},{"triangleBoundMas",spread+trueC2t},{"hpopSpiceExcessOverSpreadMas",comparison-spread}};
 json seeds=json::array();const auto&h=H["epochs"][0];double u1,u2,t1,t2;epoch(h["utc"],u1,u2,t1,t2);
 for(double radius:{LEO,GPS,GEO})seeds.push_back({{"utc",h["utc"]},{"jdUtc",u1+u2},{"radiusM",radius},{"positionKm",{radius/1000,0,0}},{"velocityKmS",{0,std::sqrt(398600.4418/(radius/1000)),0}}});
 out["wasmSeeds"]=seeds;std::cout<<out.dump(1)<<'\n';return 0;
 }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
