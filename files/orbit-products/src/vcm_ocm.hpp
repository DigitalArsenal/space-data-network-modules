// SP Vector/Covariance Message -> SDS $OCM.
//
// Two sources share one projection target: the legacy V2.0 text (vcm.hpp) and
// the superseded SDS $VCM record. Fields map onto CCSDS 502.0-B-3 OCM keywords
// only where the meaning is the same. Everything else is carried verbatim in
// USER_DEFINED_PARAMETERS with its unit in the name; nothing is derived:
//   - the VCM ballistic coefficient is the product Cd*A/m, so it is not split
//     into DRAG_COEFF_NOM and DRAG_CONST_AREA;
//   - the VCM covariance is in an equinoctial-element basis whose element
//     definitions and units the available documentation does not fix, so it
//     is not transformed into a Cartesian COVARIANCE_DATA;
//   - U,V,W sigmas are not turned into a diagonal covariance, which would
//     assert zero correlation.
// Requires the generated OCM and VCM headers (spacedatastandards.org 1.223.0+).
#ifndef SDN_VCM_OCM_HPP
#define SDN_VCM_OCM_HPP
#include "vcm.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

namespace sdn::vcm {

// Shortest decimal text that parses back to exactly `value`.
inline std::string shortest(double value) {
 char buffer[40];
 for(int precision=1;precision<=17;++precision) {
  std::snprintf(buffer,sizeof buffer,"%.*g",precision,value);
  if(std::strtod(buffer,nullptr)==value)break;
 }
 return buffer;
}

inline std::string joined(const double* values,size_t count) {
 std::string out;
 for(size_t i=0;i<count;++i){if(i)out+=' ';out+=shortest(values[i]);}
 return out;
}

inline void addParameter(OCMT& ocm,const std::string& name,const std::string& value) {
 auto p=std::make_unique<UserDefinedParametersT>();
 p->PARAM_NAME=name;p->PARAM_VALUE=value;
 ocm.USER_DEFINED_PARAMETERS.push_back(std::move(p));
}

inline std::unique_ptr<RFMT> celestialFrame(const std::string& name,bool known,CelestialFrame frame) {
 auto rfm=std::make_unique<RFMT>();
 rfm->NAME=name;
 if(known) {
  CelestialFrameWrapperT wrapper;wrapper.frame=frame;
  rfm->REFERENCE_FRAME.Set(std::move(wrapper));
 }
 return rfm;
}

// The legacy text. The J2K state (mean equator and equinox of J2000) becomes
// the trajectory; the ECI (true equator, mean equinox of date) and EFG
// (Earth-fixed) copies of the same state are kept as parameters.
inline void projectLegacy(const Message& m,OCMT& ocm) {
 ocm.HEADER=std::make_unique<HeaderT>();
 ocm.HEADER->CCSDS_OCM_VERS="3.0";
 ocm.HEADER->CREATION_DATE=m.messageTime.iso;
 ocm.HEADER->ORIGINATOR=m.center;
 ocm.HEADER->COMMENT.push_back("Converted from SP Vector/Covariance Message V"+m.version);
 if(!m.indicator.empty())ocm.HEADER->COMMENT.push_back("Message indicator: "+m.indicator);

 ocm.METADATA=std::make_unique<MetadataT>();
 auto& md=*ocm.METADATA;
 if(!m.commonName.empty())md.OBJECT_NAME=m.commonName;
 md.INTERNATIONAL_DESIGNATOR=m.internationalDesignator;
 md.CATALOG_NAME="SATCAT";
 md.OBJECT_DESIGNATOR=m.satelliteNumber;
 md.TIME_SYSTEM="UTC";
 md.EPOCH_TZERO=m.epoch.iso;
 md.START_TIME=m.epoch.iso;
 md.STOP_TIME=m.epoch.iso;
 md.TAIMUTC_AT_TZERO=m.taiMinusUtc;
 md.UT1MUTC_AT_TZERO=m.ut1MinusUtc;
 // The message carries the NEXT leap second when known, otherwise the
 // previous one, otherwise a 2049 placeholder. Only a leap second after the
 // epoch is the next one.
 if(!m.leapSecondUnknown && m.leapSecond.iso>m.epoch.iso)md.NEXT_LEAP_EPOCH=m.leapSecond.iso;

 ocm.TRAJ_TYPE=trajectoryType::CARTESIAN_PV;
 ocm.STATE_VECTOR_SIZE=6;
 ocm.STATE_DATA.assign(m.j2k.begin(),m.j2k.end());
 ocm.CENTER_NAME="EARTH";
 ocm.TRAJ_REF_FRAME=celestialFrame("EME2000",true,CelestialFrame::EME2000);
 if(m.epochRev>=0)ocm.ORB_REVNUM=static_cast<uint32_t>(m.epochRev);

 ocm.PERTURBATIONS=std::make_unique<PerturbationsT>();
 auto& p=*ocm.PERTURBATIONS;
 p.GRAVITY_MODEL=m.geopotentialModel;
 p.GRAVITY_DEGREE=m.zonalDegree>m.tesseralOrder?m.zonalDegree:m.tesseralOrder;
 p.GRAVITY_ORDER=m.tesseralOrder;
 p.COMMENT.push_back("Geopotential truncation: zonals to degree "+std::to_string(m.zonalDegree)+
                     ", tesserals to degree and order "+std::to_string(m.tesseralOrder));
 if(m.lunarSolar){p.N_BODY_PERTURBATIONS.push_back("MOON");p.N_BODY_PERTURBATIONS.push_back("SUN");}
 p.COMMENT.push_back("Drag model: "+m.dragModel);
 p.COMMENT.push_back(std::string("Solar radiation pressure: ")+(m.solarRadiationPressure?"ON":"OFF"));
 p.COMMENT.push_back(std::string("Solid Earth tides: ")+(m.solidEarthTides?"ON":"OFF"));
 p.COMMENT.push_back(std::string("In-track thrust: ")+(m.inTrackThrust?"ON":"OFF"));
 p.FIXED_F10P7=m.f10;
 p.FIXED_F10P7_MEAN=m.averageF10;
 p.FIXED_GEOMAG_AP=m.averageAp;
 p.COMMENT.push_back("FIXED_GEOMAG_AP is the message's AVERAGE AP");

 ocm.ORBIT_DETERMINATION=std::make_unique<OrbitDeterminationT>();
 ocm.ORBIT_DETERMINATION->OD_EPOCH=m.epoch.iso;
 ocm.ORBIT_DETERMINATION->SEDR=m.energyDissipationRate;
 ocm.ORBIT_DETERMINATION->WEIGHTED_RMS=m.weightedRms;

 addParameter(ocm,"VCM_BALLISTIC_COEF_M2_PER_KG",shortest(m.ballisticCoefficient));
 addParameter(ocm,"VCM_BDOT_M2_PER_KG_S",shortest(m.ballisticCoefficientRate));
 addParameter(ocm,"VCM_SOLAR_RAD_PRESS_COEFF_M2_PER_KG",shortest(m.solarRadiationPressureCoefficient));
 addParameter(ocm,"VCM_THRUST_ACCEL_M_PER_S2",shortest(m.thrustAcceleration));
 addParameter(ocm,"VCM_CM_OFFSET_M",shortest(m.centerOfMassOffset));
 addParameter(ocm,"VCM_UVW_POSITION_SIGMAS_KM",joined(m.positionSigmas.data(),3));
 addParameter(ocm,"VCM_UVW_VELOCITY_SIGMAS_KM_PER_S",joined(m.velocitySigmas.data(),3));
 addParameter(ocm,"VCM_COVARIANCE_EQUINOCTIAL_DIMENSION",std::to_string(m.covarianceDimension));
 if(!m.covariance.empty())addParameter(ocm,"VCM_COVARIANCE_EQUINOCTIAL_LOWER_TRIANGLE",joined(m.covariance.data(),m.covariance.size()));
 addParameter(ocm,"VCM_ECI_TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE_STATE_KM_KM_PER_S",joined(m.eci.data(),6));
 addParameter(ocm,"VCM_EFG_EARTH_FIXED_STATE_KM_KM_PER_S",joined(m.efg.data(),6));
 addParameter(ocm,"VCM_POLAR_MOTION_XY_ARCSEC",shortest(m.polarMotionX)+" "+shortest(m.polarMotionY));
 addParameter(ocm,"VCM_UT1_RATE_MS_PER_DAY",shortest(m.ut1Rate));
 addParameter(ocm,"VCM_IAU1980_NUTATION_TERMS",std::to_string(m.nutationTerms));
 addParameter(ocm,"VCM_INTEGRATOR",m.integratorMode+"; COORD SYS "+m.coordinateSystem+"; PARTIALS "+m.partials+
              "; STEP MODE "+m.stepMode+"; FIXED STEP "+m.fixedStep+"; STEP SIZE SELECTION "+m.stepSizeSelection+
              "; INITIAL STEP "+shortest(m.initialStepSize)+" s; ERROR CONTROL "+shortest(m.errorControl));
}

// The superseded SDS $VCM record. `frameFor` maps a frame name onto the
// ratified CelestialFrame roster by exact token.
inline bool projectRecord(const VCM& v,OCMT& ocm,bool (*frameFor)(const std::string&,CelestialFrame*),std::string& error) {
 const auto* sv=v.STATE_VECTOR();
 if(!sv || !sv->EPOCH() || sv->EPOCH()->size()==0){error="$VCM STATE_VECTOR with an EPOCH is required";return false;}
 const double state[6]={sv->X(),sv->Y(),sv->Z(),sv->X_DOT(),sv->Y_DOT(),sv->Z_DOT()};
 for(double d:state)if(!std::isfinite(d)){error="$VCM STATE_VECTOR must be finite";return false;}
 if(!v.REF_FRAME() || v.REF_FRAME()->size()==0){error="$VCM REF_FRAME is required";return false;}
 if(!v.CENTER_NAME() || v.CENTER_NAME()->size()==0){error="$VCM CENTER_NAME is required";return false;}
 if(!v.TIME_SYSTEM() || v.TIME_SYSTEM()->size()==0){error="$VCM TIME_SYSTEM is required";return false;}

 ocm.HEADER=std::make_unique<HeaderT>();
 ocm.HEADER->CCSDS_OCM_VERS="3.0";
 if(v.CREATION_DATE())ocm.HEADER->CREATION_DATE=v.CREATION_DATE()->str();
 if(v.ORIGINATOR())ocm.HEADER->ORIGINATOR=v.ORIGINATOR()->str();
 if(v.CLASSIFICATION_TYPE())ocm.HEADER->CLASSIFICATION=v.CLASSIFICATION_TYPE()->str();
 ocm.HEADER->COMMENT.push_back("Converted from SDS $VCM");

 ocm.METADATA=std::make_unique<MetadataT>();
 auto& md=*ocm.METADATA;
 if(v.OBJECT_NAME())md.OBJECT_NAME=v.OBJECT_NAME()->str();
 if(v.OBJECT_ID())md.INTERNATIONAL_DESIGNATOR=v.OBJECT_ID()->str();
 if(v.NORAD_CAT_ID()){md.CATALOG_NAME="SATCAT";md.OBJECT_DESIGNATOR=std::to_string(v.NORAD_CAT_ID());}
 md.TIME_SYSTEM=v.TIME_SYSTEM()->str();
 md.EPOCH_TZERO=sv->EPOCH()->str();
 md.START_TIME=md.EPOCH_TZERO;
 md.STOP_TIME=md.EPOCH_TZERO;

 ocm.TRAJ_TYPE=trajectoryType::CARTESIAN_PV;
 ocm.STATE_VECTOR_SIZE=6;
 ocm.STATE_DATA.assign(state,state+6);
 ocm.CENTER_NAME=v.CENTER_NAME()->str();
 CelestialFrame frame=CelestialFrame::GCRF;
 const bool known=frameFor(v.REF_FRAME()->str(),&frame);
 ocm.TRAJ_REF_FRAME=celestialFrame(v.REF_FRAME()->str(),known,frame);
 const double rev=v.REV_AT_EPOCH();
 if(rev>0 && rev==std::floor(rev) && rev<4294967296.0)ocm.ORB_REVNUM=static_cast<uint32_t>(rev);

 // CCSDS OPM-style keywords with CCSDS default units (kg, m**2).
 if(v.MASS()>0 || v.DRAG_AREA()>0 || v.DRAG_COEFF()>0 || v.SOLAR_RAD_AREA()>0 || v.SOLAR_RAD_COEFF()>0) {
  ocm.PHYSICAL_PROPERTIES=std::make_unique<PhysicalPropertiesT>();
  auto& pp=*ocm.PHYSICAL_PROPERTIES;
  pp.WET_MASS=v.MASS();pp.DRAG_CONST_AREA=v.DRAG_AREA();pp.DRAG_COEFF_NOM=v.DRAG_COEFF();
  pp.SRP_CONST_AREA=v.SOLAR_RAD_AREA();pp.SOLAR_RAD_COEFF=v.SOLAR_RAD_COEFF();
 }
 ocm.PERTURBATIONS=std::make_unique<PerturbationsT>();
 if(v.GM()>0)ocm.PERTURBATIONS->GM=v.GM();
 if(const auto* a=v.ATMOSPHERIC_MODEL_DATA()) {
  auto& c=ocm.PERTURBATIONS->COMMENT;
  c.push_back(std::string("VCM atmospheric model: ")+EnumNameatmosphericSource(a->ATMOSPHERIC_MODEL()));
  c.push_back(std::string("VCM geopotential model: ")+EnumNamegeopotentialSource(a->GEOPOTENTIAL_MODEL()));
  c.push_back(std::string("VCM lunar/solar perturbation: ")+EnumNameperturbationStatus(a->LUNAR_SOLAR_PERTURBATION()));
  c.push_back(std::string("VCM solar radiation pressure: ")+EnumNameperturbationStatus(a->SOLAR_RADIATION_PRESSURE()));
 }
 if(v.BSTAR()!=0)addParameter(ocm,"VCM_BSTAR_PER_EARTH_RADIUS",shortest(v.BSTAR()));
 if(v.MEAN_MOTION_DOT()!=0)addParameter(ocm,"VCM_MEAN_MOTION_DOT",shortest(v.MEAN_MOTION_DOT()));
 if(v.MEAN_MOTION_DDOT()!=0)addParameter(ocm,"VCM_MEAN_MOTION_DDOT",shortest(v.MEAN_MOTION_DDOT()));
 if(v.ELEMENT_SET_NO())addParameter(ocm,"VCM_ELEMENT_SET_NO",std::to_string(v.ELEMENT_SET_NO()));
 if(const auto* s=v.UVW_SIGMAS()) {
  const double pos[3]={s->U_SIGMA(),s->V_SIGMA(),s->W_SIGMA()},vel[3]={s->UD_SIGMA(),s->VD_SIGMA(),s->WD_SIGMA()};
  addParameter(ocm,"VCM_UVW_POSITION_SIGMAS_KM",joined(pos,3));
  addParameter(ocm,"VCM_UVW_VELOCITY_SIGMAS_KM_PER_S",joined(vel,3));
 }
 if(const auto* c=v.COVARIANCE(); c && c->size()) {
  std::vector<double> values(c->begin(),c->end());
  addParameter(ocm,"VCM_COVARIANCE",joined(values.data(),values.size()));
  if(v.COV_REFERENCE_FRAME())addParameter(ocm,"VCM_COV_REFERENCE_FRAME",v.COV_REFERENCE_FRAME()->str());
 }
 if(const auto* k=v.KEPLERIAN_ELEMENTS()) {
  const double e[6]={k->SEMI_MAJOR_AXIS(),k->ECCENTRICITY(),k->INCLINATION(),k->RA_OF_ASC_NODE(),k->ARG_OF_PERICENTER(),k->ANOMALY()};
  addParameter(ocm,"VCM_KEPLERIAN_A_KM_E_I_RAAN_ARGP_ANOMALY_DEG",joined(e,6)+" "+EnumNameanomalyConvention(k->ANOMALY_TYPE()));
 }
 if(const auto* q=v.EQUINOCTIAL_ELEMENTS()) {
  const double e[6]={q->AF(),q->AG(),q->L(),q->N(),q->CHI(),q->PSI()};
  addParameter(ocm,"VCM_EQUINOCTIAL_AF_AG_L_N_CHI_PSI",joined(e,6));
 }
 return true;
}

}  // namespace sdn::vcm
#endif  // SDN_VCM_OCM_HPP
