// SP Vector/Covariance Message V2.0 parser.
//
// Authority: the published sample and format description in
// spacedatastandards.org survey/legacy-messages/vcm (fixtures/PROVENANCE.md).
// Field checks are transcriptions of that sample. Frame checks are closed-form
// invariants: J2K, ECI and EFG are rotations of one another, so the position
// magnitude is shared, and EFG is ECI rotated about Z, so their Z components
// and in-plane magnitudes are equal. Tolerance 1e-7 km: the sample prints
// positions to 1e-8 km.

#include "vcm.hpp"

#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

namespace {
int cases=0,failures=0;
void check(bool ok,const char* name){++cases;if(!ok){++failures;std::printf("FAIL %s\n",name);}}
bool parseText(const std::string& text,sdn::vcm::Message& m,std::string& error){
 return sdn::vcm::parse(reinterpret_cast<const uint8_t*>(text.data()),text.size(),m,error);
}
std::string replace(std::string s,const std::string& from,const std::string& to){
 const auto p=s.find(from);if(p!=std::string::npos)s.replace(p,from.size(),to);return s;
}
double norm3(const double* v){return std::sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);}
}  // namespace

int main(int argc,char** argv){
 if(argc<2){std::printf("usage: vcm-native <fixture>\n");return 2;}
 std::ifstream in(argv[1],std::ios::binary);std::stringstream buffer;buffer<<in.rdbuf();
 const std::string sample=buffer.str();
 sdn::vcm::Message m;std::string error;
 check(parseText(sample,m,error),"sample parses");
 if(!error.empty())std::printf("error: %s\n",error.c_str());

 check(m.version=="2.0","version");
 check(m.indicator.empty(),"blank indicator line");
 check(m.messageTime.iso=="2023-01-07T22:45:06.000","message time");
 check(m.center=="FAKE_CENTER","center");
 check(m.satelliteNumber=="00000" && m.internationalDesignator=="0000-000A","identity");
 check(m.commonName.empty(),"blank common name");
 check(m.epoch.iso=="2023-01-07T21:39:08.414" && m.epoch.dayOfYear==7,"blank-padded epoch seconds");
 check(m.epochRev==37693,"epoch rev");
 check(m.j2k[0]==369.89521989 && m.j2k[5]==3.279477293781,"J2K state");
 check(m.eci[1]==5104.90725904 && m.efg[3]==-4.235735566625,"ECI and EFG states");
 check(m.geopotentialModel=="EGM-96" && m.zonalDegree==70 && m.tesseralOrder==70,"geopotential");
 check(m.dragModel=="JAC70/MSIS90" && m.lunarSolar,"drag model and lunar/solar");
 check(!m.solarRadiationPressure && m.solidEarthTides && !m.inTrackThrust,"perturbation switches");
 check(m.ballisticCoefficient==0.826455E-02 && m.ballisticCoefficientRate==0.0,"ballistic coefficient");
 check(m.solarRadiationPressureCoefficient==0.0 && m.energyDissipationRate==0.39E-02,"SRP coefficient and EDR");
 check(m.f10==153 && m.averageF10==137 && m.averageAp==10.0,"solar flux");
 check(m.taiMinusUtc==37 && m.ut1MinusUtc==-0.01719 && m.ut1Rate==0.384,"time offsets");
 check(m.polarMotionX==0.0505 && m.polarMotionY==0.2109 && m.nutationTerms==4,"polar motion and nutation");
 check(m.leapSecondUnknown && m.leapSecond.iso=="2049-12-31T23:59:59.999","leap second placeholder");
 check(m.integratorMode=="ASW" && m.coordinateSystem=="J2000" && m.partials=="FAST NUM","integrator");
 check(m.stepMode=="AUTO" && m.fixedStep=="OFF" && m.stepSizeSelection=="MANUAL","step mode");
 check(m.initialStepSize==20.0 && m.errorControl==0.100E-13,"step size and error control");
 check(m.positionSigmas[1]==0.0402 && m.velocitySigmas[0]==0.0,"UVW sigmas");
 check(m.covarianceDimension==7 && m.covariance.size()==28 && m.weightedRms==0.11498E+01,"covariance size");
 check(m.covariance.size()==28 && m.covariance.front()==0.20458E-11 && m.covariance.back()==0.13665E-02,"covariance values");

 const double rJ=norm3(&m.j2k[0]),rI=norm3(&m.eci[0]),rE=norm3(&m.efg[0]);
 check(std::fabs(rJ-rI)<1e-7 && std::fabs(rI-rE)<1e-7,"frames share the position magnitude");
 check(m.eci[2]==m.efg[2] && m.eci[5]==m.efg[5],"EFG is ECI rotated about Z");
 check(std::fabs(std::hypot(m.eci[0],m.eci[1])-std::hypot(m.efg[0],m.efg[1]))<1e-7,"in-plane magnitude");

 // Communication-system insertions and CRLF line ends are tolerated.
 std::string crlf;for(char c:sample){if(c=='\n')crlf+="\r\n";else crlf+=c;}
 sdn::vcm::Message m2;
 check(parseText("ZCZC PAGE 1 OF 2\n"+replace(crlf,"<> MESSAGE TIME","PAGE 1\r\n<> MESSAGE TIME"),m2,error) && m2.epoch.iso==m.epoch.iso,"insertions and CRLF");
 // An exercise indicator line is kept.
 check(parseText(replace(sample,"<>\n<> MESSAGE","<> EXERCISE//NAME//EXERCISE\n<> MESSAGE"),m2,error) && m2.indicator=="EXERCISE//NAME//EXERCISE","indicator line");
 // Alpha-5 catalog numbers are accepted.
 check(parseText(replace(sample,"SATELLITE NUMBER: 00000","SATELLITE NUMBER: A1234"),m2,error) && m2.satelliteNumber=="A1234","alpha-5 number");

 // Refusals.
 check(!parseText(replace(sample,"2023 007 (07 JAN) 21:39","2023 008 (07 JAN) 21:39"),m2,error),"day of year disagrees with date");
 check(!parseText(replace(sample,"( 7x 7)","( 8x 8)"),m2,error),"covariance shorter than declared");
 check(!parseText(replace(sample,"( 7x 7)","( 6x 6)"),m2,error),"covariance longer than declared");
 check(!parseText(replace(sample,"LUNAR/SOLAR:  ON","LUNAR/SOLAR:  MAYBE"),m2,error),"bad switch");
 check(!parseText(replace(sample,"J2K POS (KM):       369.89521989","J2K POS (KM):       369.8952X989"),m2,error),"bad number");
 check(!parseText(replace(sample,"INT. DES.: 0000-000A","INT. DES.: 000-000A"),m2,error),"bad designator");
 check(!parseText(sample.substr(0,sample.find("<> EFG VEL")),m2,error),"truncated message");
 check(!parseText(replace(sample,"V2.0","V1.0"),m2,error),"undocumented version");

 std::printf("%s vcm parser cases=%d failures=%d\n",failures==0?"PASS":"FAIL",cases,failures);
 return failures==0?0:1;
}
