// The SDS $OCM (object API) and the caller's states at its epoch, as the Draft
// vcm_write.hpp formats. Requires the generated OCM and OEM headers.
//
// Which field fills which line (the record's own field wins; the
// USER_DEFINED_PARAMETERS named VCM_* and the PERTURBATIONS comments are the
// layout files/orbit-products' reader writes, read back here by their exact
// names):
//   indicator          HEADER.COMMENT "Message indicator: <text>"
//   MESSAGE TIME       HEADER.CREATION_DATE          CENTER  HEADER.ORIGINATOR
//   SATELLITE NUMBER   METADATA.OBJECT_DESIGNATOR (CATALOG_NAME SATCAT or NORAD), else NORAD_CAT_ID
//   INT. DES.          METADATA.INTERNATIONAL_DESIGNATOR   COMMON NAME  METADATA.OBJECT_NAME
//   EPOCH TIME         MEAN_ELEMENTS.EPOCH, else METADATA.EPOCH_TZERO   EPOCH REV  ORB_REVNUM (when not 0)
//   J2K POS/VEL        STATE_DATA (CARTESIAN_PV, TRAJ_REF_FRAME EME2000, one state at the epoch),
//                      else the 'state' $OEM in EME2000 at the epoch
//   ECI POS/VEL        VCM_ECI_TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE_STATE_KM_KM_PER_S, else the 'state'
//                      $OEM in TEME of date (true equator, mean equinox of date) at the epoch
//   EFG POS/VEL        VCM_EFG_EARTH_FIXED_STATE_KM_KM_PER_S
//   GEOPOTENTIAL       PERTURBATIONS.GRAVITY_MODEL; truncation from the comment "Geopotential truncation:
//                      zonals to degree Z, tesserals to degree and order T", else MAXIMUM_ZONAL_DEGREE
//                      and MAXIMUM_TESSERAL_DEGREE when either is above 0
//   DRAG               PERTURBATIONS.ATMOSPHERIC_MODEL_NAME, else the comment "Drag model: <text>",
//                      else ATMOSPHERIC_MODEL (family and year)
//   LUNAR/SOLAR        ON when N_BODY_PERTURBATIONS names MOON and SUN; OFF when it names neither
//                      and the comments state the other switches
//   SRP, TIDES, THRUST the comments "Solar radiation pressure: ON|OFF", "Solid Earth tides: ...",
//                      "In-track thrust: ..."
//   BALLISTIC COEF     VCM_BALLISTIC_COEF_M2_PER_KG, else MEAN_ELEMENTS.BTERM of an SGP4XP or AP set
//                      (both Cd A/m, m^2/kg)    BDOT  VCM_BDOT_M2_PER_KG_S
//   SRP COEFF          VCM_SOLAR_RAD_PRESS_COEFF_M2_PER_KG, else MEAN_ELEMENTS.AGOM of an SGP4XP or AP
//                      set (both Cr A/m, m^2/kg)     EDR  ORBIT_DETERMINATION.SEDR (when not 0)
//   THRUST ACCEL, C.M. OFFSET   VCM_THRUST_ACCEL_M_PER_S2, VCM_CM_OFFSET_M
//   SOLAR FLUX         PERTURBATIONS.FIXED_F10P7, FIXED_F10P7_MEAN, FIXED_GEOMAG_AP (when F10 is not 0)
//   TAI-UTC, UT1-UTC   METADATA.TAIMUTC_AT_TZERO, UT1MUTC_AT_TZERO (when not 0); UT1 RATE  VCM_UT1_RATE_MS_PER_DAY
//   POLAR MOT, NUTAT   VCM_POLAR_MOTION_XY_ARCSEC, VCM_IAU1980_NUTATION_TERMS
//   LEAP SECOND        METADATA.NEXT_LEAP_EPOCH, else the documented "not known" time
//   INTEGRATOR, STEP MODE, INITIAL STEP   VCM_INTEGRATOR
//   U,V,W SIGMAS       VCM_UVW_POSITION_SIGMAS_KM, VCM_UVW_VELOCITY_SIGMAS_KM_PER_S
//   COVARIANCE         VCM_COVARIANCE_EQUINOCTIAL_DIMENSION, VCM_COVARIANCE_EQUINOCTIAL_LOWER_TRIANGLE;
//                      WTD RMS  ORBIT_DETERMINATION.WEIGHTED_RMS
#ifndef SDN_VCM_DRAFT_HPP
#define SDN_VCM_DRAFT_HPP
#include "vcm_write.hpp"

#include <cmath>
#include <string>
#include <vector>

namespace sdn::vcm::write {

struct Refusal {std::string code,message;};

inline std::string frameName(const RFMT* rfm) {
 if(!rfm)return "";
 if(!rfm->NAME.empty())return rfm->NAME;
 if(const auto* c=rfm->REFERENCE_FRAME.AsCelestialFrameWrapper())return EnumNameCelestialFrame(c->frame);
 return "";
}

inline const std::string* parameter(const OCMT& ocm,const char* name) {
 for(const auto& p:ocm.USER_DEFINED_PARAMETERS)if(p && p->PARAM_NAME==name)return &p->PARAM_VALUE;
 return nullptr;
}

inline bool numbers(const std::string& text,std::vector<double>& out) {
 out.clear();std::vector<std::string> w;words(text,w);
 for(const auto& t:w){double d=0;if(!number(t,d))return false;out.push_back(d);}
 return true;
}

template<size_t N> inline bool fixedCount(const std::string* text,std::optional<std::array<double,N>>& out) {
 if(!text)return true;
 std::vector<double> v;
 if(!numbers(*text,v) || v.size()!=N)return false;
 std::array<double,N> a{};for(size_t i=0;i<N;++i)a[i]=v[i];
 out=a;return true;
}

inline bool scalar(const std::string* text,std::optional<double>& out) {
 if(!text)return true;
 double d=0;if(!number(*text,d))return false;
 out=d;return true;
}

inline std::optional<std::string> commentAfter(const std::vector<std::string>& comments,const std::string& prefix) {
 for(const auto& c:comments)if(startsWith(c,prefix))return c.substr(prefix.size());
 return std::nullopt;
}

inline std::optional<bool> commentSwitch(const std::vector<std::string>& comments,const std::string& prefix) {
 const auto v=commentAfter(comments,prefix);
 if(!v)return std::nullopt;
 if(*v=="ON")return true;
 if(*v=="OFF")return false;
 return std::nullopt;
}

inline bool sameTime(const Date& a,const Date& b) {return a.iso==b.iso;}

// A state at the epoch from one $OEM: its first block's first data line.
struct Supplied {std::string frame;Date epoch;std::array<double,6> state{};};

inline bool supplied(const OEMT& oem,Supplied& out,Refusal& refusal) {
 if(oem.EPHEMERIS_DATA_BLOCK.size()!=1 || !oem.EPHEMERIS_DATA_BLOCK[0]){refusal={"invalid-state","each 'state' $OEM holds one block"};return false;}
 const auto& b=*oem.EPHEMERIS_DATA_BLOCK[0];
 if(b.EPHEMERIS_DATA_LINES.size()!=1 || !b.EPHEMERIS_DATA_LINES[0]){refusal={"invalid-state","each 'state' block holds one state, at the record's epoch"};return false;}
 if(b.TIME_SYSTEM!=timingStandard::UTC){refusal={"invalid-state","a 'state' block's TIME_SYSTEM must be UTC"};return false;}
 if(!b.CENTER_NAME.empty() && b.CENTER_NAME!="EARTH"){refusal={"invalid-state","a 'state' block must be centered on the Earth"};return false;}
 const auto& l=*b.EPHEMERIS_DATA_LINES[0];
 bool sub=false;
 if(!isoDate(l.EPOCH,out.epoch,sub) || sub){refusal={"invalid-state","a 'state' EPOCH must be an ISO 8601 UTC time to the millisecond: "+l.EPOCH};return false;}
 out.state={l.X,l.Y,l.Z,l.X_DOT,l.Y_DOT,l.Z_DOT};
 for(double d:out.state)if(!std::isfinite(d)){refusal={"invalid-state","a 'state' value is not finite"};return false;}
 out.frame=frameName(b.REFERENCE_FRAME.get());
 return true;
}

inline bool draft(const OCMT& ocm,const std::vector<Supplied>& states,Draft& m,Refusal& refusal) {
 m=Draft{};
 auto bad=[&](const char* name){refusal={"invalid-parameter",std::string(name)+" is not the reader's layout"};return false;};
 const auto* header=ocm.HEADER.get();
 const auto* md=ocm.METADATA.get();
 const auto* p=ocm.PERTURBATIONS.get();
 const auto* od=ocm.ORBIT_DETERMINATION.get();
 const auto* me=ocm.MEAN_ELEMENTS.get();
 static const std::vector<std::string> kNone;
 const auto& pc=p?p->COMMENT:kNone;

 // Epoch: the element set's, else the trajectory's zero time.
 const std::string epochText=me && !me->EPOCH.empty()?me->EPOCH:(md?md->EPOCH_TZERO:std::string());
 if(epochText.empty()){refusal={"epoch-missing","the record states no MEAN_ELEMENTS.EPOCH or METADATA.EPOCH_TZERO"};return false;}
 Date epoch;bool sub=false;
 if(!isoDate(epochText,epoch,sub)){refusal={"epoch-missing","the record's epoch is not an ISO 8601 UTC time: "+epochText};return false;}
 if(sub){refusal={"epoch-not-millisecond","the message states its epoch to the millisecond; the record's is finer: "+epochText};return false;}
 if(md && !md->TIME_SYSTEM.empty() && md->TIME_SYSTEM!="UTC"){refusal={"time-system-not-utc","the message is UTC; the record states "+md->TIME_SYSTEM};return false;}
 m.epoch=epoch;
 if(ocm.ORB_REVNUM)m.epochRev=static_cast<long>(ocm.ORB_REVNUM);

 if(header) {
  if(const auto v=commentAfter(header->COMMENT,"Message indicator: "))m.indicator=*v;
  if(!header->CREATION_DATE.empty()) {
   Date d;bool s=false;
   if(!isoDate(header->CREATION_DATE,d,s)){refusal={"invalid-ocm","HEADER.CREATION_DATE is not an ISO 8601 UTC time"};return false;}
   m.messageTime=d;
  }
  if(!header->ORIGINATOR.empty())m.center=header->ORIGINATOR;
 }
 if(md) {
  if(!md->OBJECT_DESIGNATOR.empty() && (md->CATALOG_NAME=="SATCAT" || md->CATALOG_NAME=="NORAD"))m.satelliteNumber=md->OBJECT_DESIGNATOR;
  else if(md->NORAD_CAT_ID)m.satelliteNumber=std::to_string(md->NORAD_CAT_ID);
  if(!md->INTERNATIONAL_DESIGNATOR.empty())m.internationalDesignator=md->INTERNATIONAL_DESIGNATOR;
  if(!md->OBJECT_NAME.empty())m.commonName=md->OBJECT_NAME;
  if(md->TAIMUTC_AT_TZERO!=0)m.taiMinusUtc=md->TAIMUTC_AT_TZERO;
  if(md->UT1MUTC_AT_TZERO!=0)m.ut1MinusUtc=md->UT1MUTC_AT_TZERO;
  if(!md->NEXT_LEAP_EPOCH.empty()) {
   Date d;bool s=false;
   if(!isoDate(md->NEXT_LEAP_EPOCH,d,s)){refusal={"invalid-ocm","METADATA.NEXT_LEAP_EPOCH is not an ISO 8601 UTC time"};return false;}
   m.leapSecond=d;
  }
 }

 // The record's own Cartesian state at its epoch.
 if(ocm.TRAJ_TYPE==trajectoryType::CARTESIAN_PV && ocm.STATE_VECTOR_SIZE==6 && ocm.STATE_DATA.size()==6) {
  const std::string at=!ocm.STATE_EPOCHS.empty()?ocm.STATE_EPOCHS[0]:(md?md->START_TIME:std::string());
  Date d;bool s=false;
  const std::string frame=frameName(ocm.TRAJ_REF_FRAME.get());
  if(isoDate(at,d,s) && !s && sameTime(d,epoch) && (ocm.CENTER_NAME.empty() || ocm.CENTER_NAME=="EARTH") && (frame=="EME2000" || frame=="J2000")) {
   std::array<double,6> v{};for(int i=0;i<6;++i)v[i]=ocm.STATE_DATA[i];
   m.j2k=v;
  }
 }
 for(const auto& s:states) {
  if(!sameTime(s.epoch,epoch)){refusal={"state-epoch-mismatch","a 'state' is at "+s.epoch.iso+", the record's epoch is "+epoch.iso};return false;}
  if(s.frame=="EME2000" || s.frame=="J2000") {
   if(m.j2k){refusal={"state-duplicate","the J2K state is stated twice"};return false;}
   m.j2k=s.state;
  } else if(s.frame=="TEME" || s.frame=="TEMEOFDATE") {
   if(m.eci){refusal={"state-duplicate","the ECI state is stated twice"};return false;}
   m.eci=s.state;
  } else {refusal={"state-frame-unsupported","a 'state' is in "+(s.frame.empty()?std::string("an unnamed frame"):s.frame)+"; the message's frames are EME2000 (J2K) and TEME of date (ECI)"};return false;}
 }
 if(const auto* eci=parameter(ocm,"VCM_ECI_TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE_STATE_KM_KM_PER_S")) {
  if(m.eci){refusal={"state-duplicate","the ECI state is stated twice"};return false;}
  if(!fixedCount<6>(eci,m.eci))return bad("VCM_ECI_TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE_STATE_KM_KM_PER_S");
 }
 if(!fixedCount<6>(parameter(ocm,"VCM_EFG_EARTH_FIXED_STATE_KM_KM_PER_S"),m.efg))return bad("VCM_EFG_EARTH_FIXED_STATE_KM_KM_PER_S");

 if(p) {
  if(!p->GRAVITY_MODEL.empty())m.geopotentialModel=p->GRAVITY_MODEL;
  if(const auto t=commentAfter(pc,"Geopotential truncation: zonals to degree ")) {
   int z=0,o=0;
   if(std::sscanf(t->c_str(),"%d, tesserals to degree and order %d",&z,&o)!=2)return bad("Geopotential truncation comment");
   m.zonalDegree=z;m.tesseralOrder=o;
  } else if(p->MAXIMUM_ZONAL_DEGREE>0 || p->MAXIMUM_TESSERAL_DEGREE>0) {
   m.zonalDegree=p->MAXIMUM_ZONAL_DEGREE;m.tesseralOrder=p->MAXIMUM_TESSERAL_DEGREE;
  }
  if(!p->ATMOSPHERIC_MODEL_NAME.empty())m.dragModel=p->ATMOSPHERIC_MODEL_NAME;
  else if(const auto d=commentAfter(pc,"Drag model: "))m.dragModel=*d;
  else if(p->ATMOSPHERIC_MODEL)m.dragModel=std::string(EnumNameAtmosphericModelFamily(p->ATMOSPHERIC_MODEL->MODEL))+" "+std::to_string(p->ATMOSPHERIC_MODEL->YEAR);
  m.solarRadiationPressure=commentSwitch(pc,"Solar radiation pressure: ");
  m.solidEarthTides=commentSwitch(pc,"Solid Earth tides: ");
  m.inTrackThrust=commentSwitch(pc,"In-track thrust: ");
  bool moon=false,sun=false;
  for(const auto& b:p->N_BODY_PERTURBATIONS){if(b=="MOON")moon=true;if(b=="SUN")sun=true;}
  if(moon && sun)m.lunarSolar=true;
  else if(!moon && !sun && m.solarRadiationPressure && m.solidEarthTides && m.inTrackThrust)m.lunarSolar=false;
  if(p->FIXED_F10P7!=0) {m.f10=p->FIXED_F10P7;m.averageF10=p->FIXED_F10P7_MEAN;m.averageAp=p->FIXED_GEOMAG_AP;}
 }

 const bool xpSet=me && (me->MEAN_ELEMENT_THEORY==meanElementSource::SGP4XP || me->MEAN_ELEMENT_THEORY==meanElementSource::AP);
 if(!scalar(parameter(ocm,"VCM_BALLISTIC_COEF_M2_PER_KG"),m.ballisticCoefficient))return bad("VCM_BALLISTIC_COEF_M2_PER_KG");
 if(!m.ballisticCoefficient && xpSet)m.ballisticCoefficient=me->BTERM;
 if(!scalar(parameter(ocm,"VCM_BDOT_M2_PER_KG_S"),m.ballisticCoefficientRate))return bad("VCM_BDOT_M2_PER_KG_S");
 if(!scalar(parameter(ocm,"VCM_SOLAR_RAD_PRESS_COEFF_M2_PER_KG"),m.solarRadiationPressureCoefficient))return bad("VCM_SOLAR_RAD_PRESS_COEFF_M2_PER_KG");
 if(!m.solarRadiationPressureCoefficient && xpSet)m.solarRadiationPressureCoefficient=me->AGOM;
 if(od && od->SEDR!=0)m.energyDissipationRate=od->SEDR;
 if(!scalar(parameter(ocm,"VCM_THRUST_ACCEL_M_PER_S2"),m.thrustAcceleration))return bad("VCM_THRUST_ACCEL_M_PER_S2");
 if(!scalar(parameter(ocm,"VCM_CM_OFFSET_M"),m.centerOfMassOffset))return bad("VCM_CM_OFFSET_M");
 if(!scalar(parameter(ocm,"VCM_UT1_RATE_MS_PER_DAY"),m.ut1Rate))return bad("VCM_UT1_RATE_MS_PER_DAY");
 if(!fixedCount<2>(parameter(ocm,"VCM_POLAR_MOTION_XY_ARCSEC"),m.polarMotion))return bad("VCM_POLAR_MOTION_XY_ARCSEC");
 if(const auto* t=parameter(ocm,"VCM_IAU1980_NUTATION_TERMS")) {long n=0;if(!integer(*t,n))return bad("VCM_IAU1980_NUTATION_TERMS");m.nutationTerms=static_cast<int>(n);}
 if(const auto* t=parameter(ocm,"VCM_INTEGRATOR")) {
  // "<mode>; COORD SYS <c>; PARTIALS <p>; STEP MODE <s>; FIXED STEP <f>; STEP SIZE SELECTION <z>; INITIAL STEP <x> s; ERROR CONTROL <e>"
  std::vector<std::string> part;size_t a=0;
  while(true){const auto b=t->find("; ",a);part.push_back(t->substr(a,b==std::string::npos?std::string::npos:b-a));if(b==std::string::npos)break;a=b+2;}
  const char* labels[8]={"","COORD SYS ","PARTIALS ","STEP MODE ","FIXED STEP ","STEP SIZE SELECTION ","INITIAL STEP ","ERROR CONTROL "};
  if(part.size()!=8)return bad("VCM_INTEGRATOR");
  for(int i=1;i<8;++i){if(!startsWith(part[i],labels[i]))return bad("VCM_INTEGRATOR");part[i]=part[i].substr(std::strlen(labels[i]));}
  if(part[6].size()<2 || part[6].compare(part[6].size()-2,2," s")!=0)return bad("VCM_INTEGRATOR");
  part[6].resize(part[6].size()-2);
  double step=0,control=0;
  if(!number(part[6],step) || !number(part[7],control))return bad("VCM_INTEGRATOR");
  m.integratorMode=part[0];m.coordinateSystem=part[1];m.partials=part[2];m.stepMode=part[3];m.fixedStep=part[4];m.stepSizeSelection=part[5];
  m.initialStepSize=step;m.errorControl=control;
 }
 if(!fixedCount<3>(parameter(ocm,"VCM_UVW_POSITION_SIGMAS_KM"),m.positionSigmas))return bad("VCM_UVW_POSITION_SIGMAS_KM");
 if(!fixedCount<3>(parameter(ocm,"VCM_UVW_VELOCITY_SIGMAS_KM_PER_S"),m.velocitySigmas))return bad("VCM_UVW_VELOCITY_SIGMAS_KM_PER_S");
 if(const auto* t=parameter(ocm,"VCM_COVARIANCE_EQUINOCTIAL_DIMENSION")) {
  long n=0;
  if(!integer(*t,n) || n<0 || n>30)return bad("VCM_COVARIANCE_EQUINOCTIAL_DIMENSION");
  m.covarianceDimension=static_cast<int>(n);
  if(const auto* c=parameter(ocm,"VCM_COVARIANCE_EQUINOCTIAL_LOWER_TRIANGLE"))
   if(!numbers(*c,m.covariance))return bad("VCM_COVARIANCE_EQUINOCTIAL_LOWER_TRIANGLE");
  if(m.covariance.size()!=static_cast<size_t>(n*(n+1)/2))return bad("VCM_COVARIANCE_EQUINOCTIAL_LOWER_TRIANGLE");
  if(od)m.weightedRms=od->WEIGHTED_RMS;
 }
 return true;
}

}  // namespace sdn::vcm::write
#endif  // SDN_VCM_DRAFT_HPP
