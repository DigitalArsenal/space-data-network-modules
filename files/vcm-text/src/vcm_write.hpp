// SDS $OCM -> SP Vector/Covariance Message (VCM) V2.0 text, the legacy
// fixed-format layout of spacedatastandards.org
// survey/legacy-messages/vcm/README.md.
//
// The inverse of files/orbit-products' reader (vcm.hpp parse, vcm_ocm.hpp
// projectLegacy): a record that reader wrote comes back as the message it read,
// value for value. Any other $OCM is written from its typed fields. Nothing is
// derived here: no propagation, no frame rotation, no covariance conversion.
//   - Each value comes from a field that states it; a field the record has no
//     value for is left blank and a line with no value at all is left out.
//   - Two lines have a documented "not known" form, and only those use it: the
//     leap second line (2049 365 (31 DEC) 23:59:59.999) and the covariance
//     size (0x0, no data), the latter only when the record states the size.
//   - States come from the record's own Cartesian state at its epoch (TRAJ_REF_FRAME
//     EME2000 for J2K) or from the caller's $OEM at that epoch (EME2000 for J2K,
//     TEME of date for ECI); the EFG line only from the reader's parameter.
//   - The equinoctial covariance block, the U,V,W sigmas, the integrator lines,
//     polar motion, nutation terms, thrust and center-of-mass offset come only from
//     the reader's USER_DEFINED_PARAMETERS: no typed $OCM field states them in the
//     message's own basis and units.
// Numbers print in the message's columns. A value the column's digits cannot
// hold exactly (an E field) prints with the digits it needs instead; fixed-point
// state fields keep the documented decimals (8 for km, 12 for km/s).
#ifndef SDN_VCM_WRITE_HPP
#define SDN_VCM_WRITE_HPP
#include "vcm.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

namespace sdn::vcm::write {

// What the message will state. An empty optional is a blank field.
struct Draft {
 std::optional<std::string> indicator;
 std::optional<Date> messageTime;
 std::optional<std::string> center;
 std::optional<std::string> satelliteNumber,internationalDesignator,commonName;
 std::optional<Date> epoch;
 std::optional<long> epochRev;
 std::optional<std::array<double,6>> j2k,eci,efg;
 std::optional<std::string> geopotentialModel;
 std::optional<int> zonalDegree,tesseralOrder;
 std::optional<std::string> dragModel;
 std::optional<bool> lunarSolar,solarRadiationPressure,solidEarthTides,inTrackThrust;
 std::optional<double> ballisticCoefficient,ballisticCoefficientRate,solarRadiationPressureCoefficient,energyDissipationRate;
 std::optional<double> thrustAcceleration,centerOfMassOffset;
 std::optional<double> f10,averageF10,averageAp;
 std::optional<double> taiMinusUtc,ut1MinusUtc,ut1Rate;
 std::optional<std::array<double,2>> polarMotion;
 std::optional<int> nutationTerms;
 std::optional<Date> leapSecond;  // empty: the documented "not known" time
 std::optional<std::string> integratorMode,coordinateSystem,partials,stepMode,fixedStep,stepSizeSelection;
 std::optional<double> initialStepSize,errorControl;
 std::optional<std::array<double,3>> positionSigmas,velocitySigmas;
 std::optional<int> covarianceDimension;
 std::vector<double> covariance;
 std::optional<double> weightedRms;
};

// ---- number text -----------------------------------------------------------

// Shortest decimal text that parses back to exactly `value` (%g digits).
inline int shortestDigits(double value) {
 char buffer[40];
 for(int precision=1;precision<=17;++precision) {
  std::snprintf(buffer,sizeof buffer,"%.*E",precision-1,value);
  if(std::strtod(buffer,nullptr)==value)return precision;
 }
 return 17;
}

// "±d.ddddddE±dd" with `digits` significant digits, more when the value needs them.
inline std::string exp(double value,int digits) {
 const int need=shortestDigits(value);
 char buffer[48];
 std::snprintf(buffer,sizeof buffer,"% .*E",(need>digits?need:digits)-1,value);
 return buffer;
}

// Fixed point with `decimals` when that is exact, else the shortest exact text.
inline std::string fixedOrExact(double value,int decimals) {
 char buffer[48];
 std::snprintf(buffer,sizeof buffer,"%.*f",decimals,value);
 if(std::strtod(buffer,nullptr)==value)return buffer;
 std::snprintf(buffer,sizeof buffer,"%.*g",shortestDigits(value),value);
 return buffer;
}

inline std::string padLeft(const std::string& s,size_t width) {return s.size()>=width?s:std::string(width-s.size(),' ')+s;}

inline std::string fixed(double value,int width,int decimals) {
 char buffer[64];
 std::snprintf(buffer,sizeof buffer,"%*.*f",width,decimals,value);
 return buffer;
}

// ---- dates -------------------------------------------------------------------

// "YYYY-MM-DDThh:mm:ss[.f...][Z]" to a Date; false when the text is not that.
// subMillisecond: the text carries time below the message's millisecond. With
// roundToMillisecond the Date is that time rounded to the nearest millisecond
// (a remainder of half a millisecond or more rounds up, carried through the
// second, minute, hour, day, month and year; a carry past second 59, or past a
// stated second 60, goes to the next minute); without it the digits below the
// millisecond are dropped.
inline bool isoDate(const std::string& text,Date& d,bool& subMillisecond,bool roundToMillisecond=false) {
 static const int kDays[12]={31,28,31,30,31,30,31,31,30,31,30,31};
 subMillisecond=false;
 std::string t=text;
 if(!t.empty() && (t.back()=='Z' || t.back()=='z'))t.pop_back();
 if(t.size()<19 || t[4]!='-' || t[7]!='-' || (t[10]!='T' && t[10]!=' ') || t[13]!=':' || t[16]!=':')return false;
 auto digits=[&](size_t a,size_t n,int& out){out=0;for(size_t i=a;i<a+n;++i){if(t[i]<'0'||t[i]>'9')return false;out=out*10+(t[i]-'0');}return true;};
 int y,mo,dd,h,mi,s;
 if(!digits(0,4,y)||!digits(5,2,mo)||!digits(8,2,dd)||!digits(11,2,h)||!digits(14,2,mi)||!digits(17,2,s))return false;
 long millis=0;
 bool roundUp=false;
 if(t.size()>19) {
  if(t[19]!='.' || t.size()==20)return false;
  for(size_t i=20;i<t.size();++i) {
   if(t[i]<'0'||t[i]>'9')return false;
   const int k=static_cast<int>(i-20);
   if(k<3)millis=millis*10+(t[i]-'0');
   else if(t[i]!='0')subMillisecond=true;
   if(k==3)roundUp=t[i]>='5';
  }
  for(size_t k=t.size()-20;k<3;++k)millis*=10;
 }
 if(mo<1||mo>12||y<1957||y>2200)return false;
 const auto daysIn=[&](int year,int month){return kDays[month-1]+(month==2 && leap(year)?1:0);};
 if(dd<1||dd>daysIn(y,mo)||h>23||mi>59||s>60)return false;
 if(roundToMillisecond && roundUp && ++millis==1000) {
  millis=0;
  const int lastSecond=s==60?60:59;
  if(++s>lastSecond) {
   s=0;
   if(++mi>59){mi=0;if(++h>23){h=0;if(++dd>daysIn(y,mo)){dd=1;if(++mo>12){mo=1;++y;}}}}
  }
 }
 int doy=dd;
 for(int m=1;m<mo;++m)doy+=kDays[m-1]+(m==2 && leap(y)?1:0);
 d=Date{};d.year=y;d.dayOfYear=doy;d.month=mo;d.day=dd;d.hour=h;d.minute=mi;d.second=s+millis/1000.0;
 char buffer[40];
 std::snprintf(buffer,sizeof buffer,"%04d-%02d-%02dT%02d:%02d:%02d.%03ld",y,mo,dd,h,mi,s,millis);
 d.iso=buffer;
 return true;
}

inline std::string vcmDate(const Date& d) {
 static const char* kMonths[12]={"JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"};
 const long millis=std::lround(d.second*1000);
 char buffer[48];
 std::snprintf(buffer,sizeof buffer,"%04d %03d (%02d %s) %02d:%02d:%02ld.%03ld",d.year,d.dayOfYear,d.day,kMonths[d.month-1],d.hour,d.minute,millis/1000,millis%1000);
 return buffer;
}

// ---- the message ---------------------------------------------------------------

inline std::string onOff(const std::optional<bool>& v) {return v?(*v?" ON":"OFF"):"";}
template<class T> inline bool any(const T& v) {return v.has_value();}

// One "<>" line per stated line, in the documented order, CR LF ends each line.
inline std::string format(const Draft& m) {
 std::vector<std::string> out;
 auto line=[&](const std::string& s){out.push_back("<> "+s);};
 auto opt=[](const std::optional<std::string>& s){return s?*s:std::string();};
 line("SP VECTOR/COVARIANCE MESSAGE - V2.0");
 if(m.indicator)line(*m.indicator);
 if(m.messageTime || m.center)
  line("MESSAGE TIME (UTC): "+(m.messageTime?vcmDate(*m.messageTime):std::string())+"  CENTER: "+opt(m.center));
 if(m.satelliteNumber || m.internationalDesignator)
  line("SATELLITE NUMBER: "+opt(m.satelliteNumber)+"  INT. DES.: "+opt(m.internationalDesignator));
 // The format states "no common name" with a blank field (the line stays with the satellite number).
 if(m.commonName || m.satelliteNumber || m.internationalDesignator)line("COMMON NAME: "+opt(m.commonName));
 if(m.epoch || m.epochRev)
  line("EPOCH TIME (UTC): "+(m.epoch?vcmDate(*m.epoch):std::string())+"  EPOCH REV: "+(m.epochRev?std::to_string(*m.epochRev):std::string()));
 auto state=[&](const char* name,const std::optional<std::array<double,6>>& s) {
  if(!s)return;
  line(std::string(name)+" POS (KM): "+fixed((*s)[0],16,8)+" "+fixed((*s)[1],16,8)+" "+fixed((*s)[2],16,8));
  line(std::string(name)+" VEL (KM/S): "+fixed((*s)[3],16,12)+" "+fixed((*s)[4],16,12)+" "+fixed((*s)[5],16,12));
 };
 state("J2K",m.j2k);state("ECI",m.eci);state("EFG",m.efg);
 if(m.geopotentialModel || m.dragModel || m.lunarSolar) {
  std::string g=opt(m.geopotentialModel);
  if(m.zonalDegree && m.tesseralOrder)g+=" "+std::to_string(*m.zonalDegree)+"Z,"+std::to_string(*m.tesseralOrder)+"T";
  line("GEOPOTENTIAL: "+g+"  DRAG: "+opt(m.dragModel)+"  LUNAR/SOLAR: "+onOff(m.lunarSolar));
 }
 if(m.solarRadiationPressure || m.solidEarthTides || m.inTrackThrust)
  line("SOLAR RAD PRESS: "+onOff(m.solarRadiationPressure)+"  SOLID EARTH TIDES: "+onOff(m.solidEarthTides)+"  IN-TRACK THRUST: "+onOff(m.inTrackThrust));
 auto e=[](const std::optional<double>& v,int digits){return v?exp(*v,digits):std::string();};
 if(m.ballisticCoefficient || m.ballisticCoefficientRate)
  line("BALLISTIC COEF (M2/KG): "+e(m.ballisticCoefficient,7)+" BDOT (M2/KG-S): "+e(m.ballisticCoefficientRate,7));
 if(m.solarRadiationPressureCoefficient || m.energyDissipationRate)
  line("SOLAR RAD PRESS COEFF (M2/KG): "+e(m.solarRadiationPressureCoefficient,7)+"  EDR(W/KG): "+e(m.energyDissipationRate,3));
 if(m.thrustAcceleration || m.centerOfMassOffset)
  line("THRUST ACCEL (M/S2): "+e(m.thrustAcceleration,7)+"  C.M. OFFSET (M): "+e(m.centerOfMassOffset,7));
 auto f=[](const std::optional<double>& v,int decimals){return v?fixedOrExact(*v,decimals):std::string();};
 if(m.f10 || m.averageF10 || m.averageAp)
  line("SOLAR FLUX: F10: "+f(m.f10,0)+"  AVERAGE F10: "+f(m.averageF10,0)+"  AVERAGE AP: "+f(m.averageAp,1));
 if(m.taiMinusUtc || m.ut1MinusUtc || m.ut1Rate)
  line("TAI-UTC (S): "+f(m.taiMinusUtc,0)+"  UT1-UTC (S): "+f(m.ut1MinusUtc,5)+"  UT1 RATE (MS/DAY): "+f(m.ut1Rate,3));
 if(m.polarMotion || m.nutationTerms)
  line("POLAR MOT X,Y (ARCSEC): "+(m.polarMotion?fixedOrExact((*m.polarMotion)[0],4)+" "+fixedOrExact((*m.polarMotion)[1],4):std::string())+
       " IAU 1980 NUTAT: "+(m.nutationTerms?padLeft(std::to_string(*m.nutationTerms),3):std::string())+" TERMS");
 line("TIME CONST LEAP SECOND TIME (UTC): "+(m.leapSecond?vcmDate(*m.leapSecond):std::string("2049 365 (31 DEC) 23:59:59.999")));
 if(m.integratorMode || m.coordinateSystem || m.partials)
  line("INTEGRATOR MODE: "+opt(m.integratorMode)+"  COORD SYS: "+opt(m.coordinateSystem)+"  PARTIALS: "+opt(m.partials));
 if(m.stepMode || m.fixedStep || m.stepSizeSelection)
  line("STEP MODE: "+opt(m.stepMode)+"  FIXED STEP: "+opt(m.fixedStep)+"  STEP SIZE SELECTION: "+opt(m.stepSizeSelection));
 if(m.initialStepSize || m.errorControl)
  line("INITIAL STEP SIZE (S): "+f(m.initialStepSize,3)+"  ERROR CONTROL: "+e(m.errorControl,4));
 auto triple=[](const std::array<double,3>& v,int decimals){return padLeft(fixedOrExact(v[0],decimals),10)+" "+padLeft(fixedOrExact(v[1],decimals),10)+" "+padLeft(fixedOrExact(v[2],decimals),10);};
 if(m.positionSigmas)line("VECTOR U,V,W SIGMAS (KM): "+triple(*m.positionSigmas,4));
 if(m.velocitySigmas)line("VECTOR UD,VD,WD SIGMAS (KM/S): "+triple(*m.velocitySigmas,4));
 if(m.covarianceDimension) {
  char size[24];
  std::snprintf(size,sizeof size,"(%2dx%2d)",*m.covarianceDimension,*m.covarianceDimension);
  line(std::string("COVARIANCE MATRIX (EQUINOCTIAL ELS): ")+size+" WTD RMS: "+e(m.weightedRms,5));
  for(size_t i=0;i<m.covariance.size();i+=5) {
   std::string row;
   for(size_t k=i;k<i+5 && k<m.covariance.size();++k)row+=(k>i?" ":"")+exp(m.covariance[k],5);
   line(row);
  }
 }
 std::string text;
 for(const auto& l:out)text+=l+"\r\n";
 return text;
}

}  // namespace sdn::vcm::write
#endif  // SDN_VCM_WRITE_HPP
