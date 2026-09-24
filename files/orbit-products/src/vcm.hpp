// SP Vector/Covariance Message (VCM) V2.0, the legacy fixed-format ASCII
// message, as documented in spacedatastandards.org
// survey/legacy-messages/vcm/README.md.
// Parsing only: no propagation, frame transformation or covariance conversion.
#ifndef SDN_VCM_FORMAT_HPP
#define SDN_VCM_FORMAT_HPP
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
namespace sdn::vcm {

// yyyy ddd (dd mmm) hh:mm:ss.sss, UTC.
struct Date {
 int year=0,dayOfYear=0,month=0,day=0,hour=0,minute=0;
 double second=0;
 std::string iso;  // YYYY-MM-DDThh:mm:ss.sss
};

struct Message {
 std::string version;           // "2.0"
 std::string indicator;         // REAL, TEST or EXERCISE text; may be empty
 Date messageTime;
 std::string center;
 std::string satelliteNumber;   // as transmitted, leading zeros kept
 std::string internationalDesignator;  // yyyy-lllppp
 std::string commonName;
 Date epoch;
 long epochRev=0;
 std::array<double,6> j2k{},eci{},efg{};  // km, km/s
 std::string geopotentialModel;
 int zonalDegree=0,tesseralOrder=0;
 std::string dragModel;
 bool lunarSolar=false,solarRadiationPressure=false,solidEarthTides=false,inTrackThrust=false;
 double ballisticCoefficient=0;   // m^2/kg
 double ballisticCoefficientRate=0;  // m^2/(kg s)
 double solarRadiationPressureCoefficient=0;  // m^2/kg
 double energyDissipationRate=0;  // W/kg
 double thrustAcceleration=0;     // m/s^2
 double centerOfMassOffset=0;     // m
 double f10=0,averageF10=0,averageAp=0;
 double taiMinusUtc=0,ut1MinusUtc=0,ut1Rate=0;  // s, s, ms/day
 double polarMotionX=0,polarMotionY=0;          // arcsec
 int nutationTerms=0;
 Date leapSecond;
 bool leapSecondUnknown=false;   // the 2049 365 23:59:59.999 placeholder
 std::string integratorMode,coordinateSystem,partials,stepMode,fixedStep,stepSizeSelection;
 double initialStepSize=0,errorControl=0;
 std::array<double,3> positionSigmas{},velocitySigmas{};  // U,V,W: km and km/s
 int covarianceDimension=0;
 double weightedRms=0;
 std::vector<double> covariance;  // lower triangle, row by row, equinoctial-element basis
};

inline std::string trim(const std::string& s) {
 const auto a=s.find_first_not_of(" \t\r");
 return a==std::string::npos?"":s.substr(a,s.find_last_not_of(" \t\r")-a+1);
}

inline bool startsWith(const std::string& s,const std::string& p) {return s.compare(0,p.size(),p)==0;}

// Text after `label` up to `next` (or the end of the line), trimmed.
inline bool field(const std::string& line,const std::string& label,const std::string& next,std::string& out) {
 const auto a=line.find(label);
 if(a==std::string::npos)return false;
 const auto start=a+label.size();
 auto end=next.empty()?std::string::npos:line.find(next,start);
 if(!next.empty() && end==std::string::npos)return false;
 out=trim(line.substr(start,end==std::string::npos?std::string::npos:end-start));
 return true;
}

// Numbers may carry a blank in place of "+" and blanks in place of leading
// zeros, so the blanks inside one field are not significant.
inline bool number(const std::string& text,double& value) {
 std::string s;
 for(char c:text)if(c!=' ')s.push_back(c);
 if(s.empty() || s.size()>40 || s.find_first_not_of("0123456789.eE+-")!=std::string::npos)return false;
 char* end=nullptr;value=std::strtod(s.c_str(),&end);
 return end==s.c_str()+s.size() && std::isfinite(value);
}

inline bool integer(const std::string& text,long& value) {
 double d=0;
 if(!number(text,d) || d!=std::floor(d) || std::fabs(d)>1e12)return false;
 value=static_cast<long>(d);return true;
}

inline bool words(const std::string& text,std::vector<std::string>& out) {
 out.clear();std::string w;
 for(char c:text) {
  if(c==' '){if(!w.empty()){out.push_back(w);w.clear();}}
  else w.push_back(c);
 }
 if(!w.empty())out.push_back(w);
 return true;
}

inline bool onOff(const std::string& text,bool& value) {
 if(text=="ON"){value=true;return true;}
 if(text=="OFF"){value=false;return true;}
 return false;
}

inline bool leap(int y) {return (y%4==0 && y%100!=0) || y%400==0;}

inline bool date(const std::string& text,Date& d) {
 static const char* kMonths[12]={"JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"};
 static const int kDays[12]={31,28,31,30,31,30,31,31,30,31,30,31};
 const auto open=text.find('('),close=text.find(')');
 if(open==std::string::npos || close==std::string::npos || close<open)return false;
 std::vector<std::string> head,paren;
 words(text.substr(0,open),head);words(text.substr(open+1,close-open-1),paren);
 if(head.size()!=2 || paren.size()!=2)return false;
 long y=0,doy=0,dd=0;
 if(!integer(head[0],y) || !integer(head[1],doy) || !integer(paren[0],dd))return false;
 int month=0;
 for(int m=0;m<12;++m)if(paren[1]==kMonths[m])month=m+1;
 if(!month || y<1957 || y>2200)return false;
 const std::string clock=trim(text.substr(close+1));
 const auto c1=clock.find(':'),c2=clock.find(':',c1==std::string::npos?0:c1+1);
 if(c1==std::string::npos || c2==std::string::npos)return false;
 long hh=0,mm=0;double ss=0;
 if(!integer(clock.substr(0,c1),hh) || !integer(clock.substr(c1+1,c2-c1-1),mm) || !number(clock.substr(c2+1),ss))return false;
 int days=kDays[month-1]+(month==2 && leap(static_cast<int>(y))?1:0);
 if(dd<1 || dd>days || hh<0 || hh>23 || mm<0 || mm>59 || ss<0 || ss>=61)return false;
 // The day of year must name the same calendar day as (dd mmm).
 int expected=static_cast<int>(dd);
 for(int m=1;m<month;++m)expected+=kDays[m-1]+(m==2 && leap(static_cast<int>(y))?1:0);
 if(expected!=doy)return false;
 d.year=static_cast<int>(y);d.dayOfYear=static_cast<int>(doy);d.month=month;d.day=static_cast<int>(dd);
 d.hour=static_cast<int>(hh);d.minute=static_cast<int>(mm);d.second=ss;
 // Milliseconds are the message's resolution.
 const long millis=std::lround(ss*1000);
 char buffer[40];
 std::snprintf(buffer,sizeof buffer,"%04d-%02d-%02dT%02d:%02d:%02ld.%03ld",d.year,d.month,d.day,d.hour,d.minute,millis/1000,millis%1000);
 d.iso=buffer;
 return true;
}

inline bool triple(const std::string& text,double* out) {
 std::vector<std::string> w;words(text,w);
 // A blank may replace "+", so "- 1.5" is not produced, but a value may be
 // blank-padded; three tokens are required.
 if(w.size()!=3)return false;
 for(int i=0;i<3;++i)if(!number(w[i],out[i]))return false;
 return true;
}

inline bool designator(const std::string& s) {
 // yyyy-lllppp: launch year, launch number, one to three piece letters.
 if(s.size()<9 || s.size()>11 || s[4]!='-')return false;
 for(int i=0;i<4;++i)if(s[i]<'0' || s[i]>'9')return false;
 for(int i=5;i<8;++i)if(s[i]<'0' || s[i]>'9')return false;
 for(size_t i=8;i<s.size();++i)if(s[i]<'A' || s[i]>'Z')return false;
 return true;
}

inline bool catalogNumber(const std::string& s) {
 if(s.empty() || s.size()>9)return false;
 for(char c:s)if(!((c>='0' && c<='9') || (c>='A' && c<='Z')))return false;
 return true;
}

// Parses one message. Lines not beginning with "<>" are communication-system
// insertions and are skipped; every "<>" line must be accounted for.
inline bool parse(const uint8_t* data,size_t length,Message& m,std::string& error) {
 m=Message{};error.clear();
 auto fail=[&](const std::string& why){error=why;return false;};
 if(!data || !length || length>1024*1024)return fail("empty or oversized message");
 const std::string source(reinterpret_cast<const char*>(data),length);
 if(source.find('\0')!=std::string::npos)return fail("message contains NUL bytes");
 std::vector<std::string> lines;
 size_t a=0;
 while(a<=source.size()) {
  auto b=source.find('\n',a);
  std::string line=source.substr(a,b==std::string::npos?std::string::npos:b-a);
  while(!line.empty() && (line.back()=='\r'))line.pop_back();
  const std::string t=trim(line);
  if(startsWith(t,"<>"))lines.push_back(t.substr(2));
  if(b==std::string::npos)break;
  a=b+1;
 }
 size_t i=0;
 auto next=[&](std::string& out){if(i>=lines.size())return false;out=lines[i++];return true;};
 std::string l,v,w;
 if(!next(l))return fail("no message lines");
 l=trim(l);
 if(!startsWith(l,"SP VECTOR/COVARIANCE MESSAGE"))return fail("not an SP vector/covariance message");
 const auto vp=l.rfind('V');
 if(vp==std::string::npos || vp+1>=l.size())return fail("missing message version");
 m.version=trim(l.substr(vp+1));
 if(!startsWith(m.version,"2."))return fail("only VCM version 2 is documented");
 if(!next(l))return fail("truncated message");
 if(trim(l).rfind("MESSAGE TIME",0)!=0){m.indicator=trim(l);if(!next(l))return fail("truncated message");}
 if(!field(l,"MESSAGE TIME (UTC):","CENTER:",v) || !date(v,m.messageTime) || !field(l,"CENTER:","",m.center))return fail("bad MESSAGE TIME line");
 if(!next(l) || !field(l,"SATELLITE NUMBER:","INT. DES.:",m.satelliteNumber) || !field(l,"INT. DES.:","",m.internationalDesignator))return fail("bad SATELLITE NUMBER line");
 if(!catalogNumber(m.satelliteNumber) || !designator(m.internationalDesignator))return fail("bad satellite number or international designator");
 if(!next(l) || !field(l,"COMMON NAME:","",m.commonName))return fail("bad COMMON NAME line");
 if(!next(l) || !field(l,"EPOCH TIME (UTC):","EPOCH REV:",v) || !date(v,m.epoch) || !field(l,"EPOCH REV:","",w) || !integer(w,m.epochRev))return fail("bad EPOCH TIME line");
 const char* stateLabels[6]={"J2K POS (KM):","J2K VEL (KM/S):","ECI POS (KM):","ECI VEL (KM/S):","EFG POS (KM):","EFG VEL (KM/S):"};
 double* stateTargets[6]={&m.j2k[0],&m.j2k[3],&m.eci[0],&m.eci[3],&m.efg[0],&m.efg[3]};
 for(int k=0;k<6;++k)if(!next(l) || !field(l,stateLabels[k],"",v) || !triple(v,stateTargets[k]))return fail(std::string("bad ")+stateLabels[k]+" line");
 if(!next(l) || !field(l,"GEOPOTENTIAL:","DRAG:",v) || !field(l,"DRAG:","LUNAR/SOLAR:",m.dragModel) || !field(l,"LUNAR/SOLAR:","",w) || !onOff(w,m.lunarSolar))return fail("bad GEOPOTENTIAL line");
 {
  // "EGM-96 70Z,70T": model name, zonal degree and tesseral degree/order.
  const auto z=v.rfind(' ');
  if(z==std::string::npos)return fail("bad geopotential truncation");
  m.geopotentialModel=trim(v.substr(0,z));
  const std::string trunc=v.substr(z+1);
  const auto zp=trunc.find('Z'),comma=trunc.find(','),tp=trunc.find('T');
  long zd=0,to=0;
  if(zp==std::string::npos || comma!=zp+1 || tp!=trunc.size()-1 || !integer(trunc.substr(0,zp),zd) || !integer(trunc.substr(comma+1,tp-comma-1),to))return fail("bad geopotential truncation");
  m.zonalDegree=static_cast<int>(zd);m.tesseralOrder=static_cast<int>(to);
 }
 if(!next(l) || !field(l,"SOLAR RAD PRESS:","SOLID EARTH TIDES:",v) || !onOff(v,m.solarRadiationPressure) ||
    !field(l,"SOLID EARTH TIDES:","IN-TRACK THRUST:",v) || !onOff(v,m.solidEarthTides) ||
    !field(l,"IN-TRACK THRUST:","",v) || !onOff(v,m.inTrackThrust))return fail("bad SOLAR RAD PRESS line");
 if(!next(l) || !field(l,"BALLISTIC COEF (M2/KG):","BDOT (M2/KG-S):",v) || !number(v,m.ballisticCoefficient) ||
    !field(l,"BDOT (M2/KG-S):","",v) || !number(v,m.ballisticCoefficientRate))return fail("bad BALLISTIC COEF line");
 if(!next(l) || !field(l,"SOLAR RAD PRESS COEFF (M2/KG):","EDR(W/KG):",v) || !number(v,m.solarRadiationPressureCoefficient) ||
    !field(l,"EDR(W/KG):","",v) || !number(v,m.energyDissipationRate))return fail("bad SOLAR RAD PRESS COEFF line");
 if(!next(l) || !field(l,"THRUST ACCEL (M/S2):","C.M. OFFSET (M):",v) || !number(v,m.thrustAcceleration) ||
    !field(l,"C.M. OFFSET (M):","",v) || !number(v,m.centerOfMassOffset))return fail("bad THRUST ACCEL line");
 if(!next(l) || !field(l,"SOLAR FLUX: F10:","AVERAGE F10:",v) || !number(v,m.f10) ||
    !field(l,"AVERAGE F10:","AVERAGE AP:",v) || !number(v,m.averageF10) ||
    !field(l,"AVERAGE AP:","",v) || !number(v,m.averageAp))return fail("bad SOLAR FLUX line");
 if(!next(l) || !field(l,"TAI-UTC (S):","UT1-UTC (S):",v) || !number(v,m.taiMinusUtc) ||
    !field(l,"UT1-UTC (S):","UT1 RATE (MS/DAY):",v) || !number(v,m.ut1MinusUtc) ||
    !field(l,"UT1 RATE (MS/DAY):","",v) || !number(v,m.ut1Rate))return fail("bad TAI-UTC line");
 {
  long terms=0;std::vector<std::string> pm;
  if(!next(l) || !field(l,"POLAR MOT X,Y (ARCSEC):","IAU 1980 NUTAT:",v) || !words(v,pm) || pm.size()!=2 ||
     !number(pm[0],m.polarMotionX) || !number(pm[1],m.polarMotionY) ||
     !field(l,"IAU 1980 NUTAT:","TERMS",w) || !integer(w,terms))return fail("bad POLAR MOT line");
  m.nutationTerms=static_cast<int>(terms);
 }
 if(!next(l) || !field(l,"TIME CONST LEAP SECOND TIME (UTC):","",v) || !date(v,m.leapSecond))return fail("bad LEAP SECOND line");
 m.leapSecondUnknown=m.leapSecond.year==2049 && m.leapSecond.dayOfYear==365 && m.leapSecond.hour==23 && m.leapSecond.minute==59;
 if(!next(l) || !field(l,"INTEGRATOR MODE:","COORD SYS:",m.integratorMode) || !field(l,"COORD SYS:","PARTIALS:",m.coordinateSystem) || !field(l,"PARTIALS:","",m.partials))return fail("bad INTEGRATOR MODE line");
 if(!next(l) || !field(l,"STEP MODE:","FIXED STEP:",m.stepMode) || !field(l,"FIXED STEP:","STEP SIZE SELECTION:",m.fixedStep) || !field(l,"STEP SIZE SELECTION:","",m.stepSizeSelection))return fail("bad STEP MODE line");
 if(!next(l) || !field(l,"INITIAL STEP SIZE (S):","ERROR CONTROL:",v) || !number(v,m.initialStepSize) || !field(l,"ERROR CONTROL:","",v) || !number(v,m.errorControl))return fail("bad INITIAL STEP SIZE line");
 if(!next(l) || !field(l,"VECTOR U,V,W SIGMAS (KM):","",v) || !triple(v,m.positionSigmas.data()))return fail("bad position sigma line");
 if(!next(l) || !field(l,"VECTOR UD,VD,WD SIGMAS (KM/S):","",v) || !triple(v,m.velocitySigmas.data()))return fail("bad velocity sigma line");
 if(!next(l) || !field(l,"COVARIANCE MATRIX (EQUINOCTIAL ELS):","WTD RMS:",v) || !field(l,"WTD RMS:","",w) || !number(w,m.weightedRms))return fail("bad COVARIANCE MATRIX line");
 {
  const auto open=v.find('('),x=v.find('x'),close=v.find(')');
  long rows=0,cols=0;
  if(open==std::string::npos || x==std::string::npos || close==std::string::npos || !(open<x && x<close) ||
     !integer(v.substr(open+1,x-open-1),rows) || !integer(v.substr(x+1,close-x-1),cols) || rows!=cols || rows<0 || rows>30)return fail("bad covariance size");
  m.covarianceDimension=static_cast<int>(rows);
 }
 const size_t count=static_cast<size_t>(m.covarianceDimension)*(m.covarianceDimension+1)/2;
 while(m.covariance.size()<count) {
  std::vector<std::string> values;
  if(!next(l))return fail("covariance ends early");
  words(l,values);
  for(const auto& t:values) {
   double d=0;
   if(!number(t,d))return fail("bad covariance value");
   m.covariance.push_back(d);
  }
 }
 if(m.covariance.size()!=count)return fail("covariance has more values than its declared size");
 if(i!=lines.size())return fail("unexpected lines after the covariance");
 return true;
}

}  // namespace sdn::vcm
#endif  // SDN_VCM_FORMAT_HPP
