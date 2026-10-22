// E13 PLAN section 4 / S3 direct NRLMSISE-00 energy arcs. FFM owns propagation
// and force partials; density-calibration owns the Jacobi energy above. All
// estimates, covariance rotations and time arithmetic execute in this WASM.
#include "ffm/prw_execution.h"
#include <cerrno>
#include <exception>
namespace {
std::string utc_iso(double mjd){
  int y,m,d,hmsf[4];if(eraD2dtf("UTC",6,2400000.5,mjd,&y,&m,&d,hmsf)<0)return "";
  char text[40];std::snprintf(text,sizeof(text),"%04d-%02d-%02dT%02d:%02d:%02d.%06d",y,m,d,hmsf[0],hmsf[1],hmsf[2],hmsf[3]);return text;
}
std::unique_ptr<TIMInstantT> instant(double mjd){auto t=std::make_unique<TIMInstantT>();t->TIME_SYSTEM=timingStandard::UTC;t->EPOCH_FORMAT=timEpochRepresentation::ISO8601;t->ISO8601=utc_iso(mjd);return t;}
std::unique_ptr<FRMVector3T> vector3(const double* x){auto v=std::make_unique<FRMVector3T>();v->X=x[0];v->Y=x[1];v->Z=x[2];return v;}
bool arc_propagate(const OrbitalState& a,double to,double B,const plugin_input_frame_t* kernel,const ffm::PrwEnvironment& env,OrbitalState& end,double phi[36],double sensitivity[6],std::string& error){
  PRWT request;request.EXECUTION_REQUEST=std::make_unique<PRWExecutionRequestT>();auto& r=*request.EXECUTION_REQUEST;
  r.INITIAL=std::make_unique<PRWResidentStateT>();r.INITIAL->STATE=std::make_unique<FRMStateVectorT>();auto& st=*r.INITIAL->STATE;
  st.REPRESENTATION=frmStateRepresentation::CARTESIAN;st.POSITION=vector3(a.r);st.VELOCITY=vector3(a.v);st.COORDINATE_SYSTEM_NAME="GCRF";st.EPOCH=utc_iso(a.mjd);st.EPOCH_TIME_SYSTEM="UTC";
  r.INITIAL->COORDINATE_SYSTEM=std::make_unique<RFMCoordinateSystemT>();auto& frame=*r.INITIAL->COORDINATE_SYSTEM;
  frame.NAME="GCRF";frame.AXIS_TYPE=rfmAxisType::ICRF;frame.AXIS_REFERENCE_BODY_ID=399;frame.ORIGIN=std::make_unique<RFMOriginT>();frame.ORIGIN->KIND=rfmOriginKind::CELESTIAL_BODY;frame.ORIGIN->CELESTIAL_BODY_ID=399;
  r.TARGET_EPOCH=instant(to);r.SAMPLE_EPOCHS.push_back(instant(to));
  r.FORCES=std::make_unique<PRWForceConfigurationT>();auto& f=*r.FORCES;
  f.GRAVITY_CHOICE=prwGravitySelection::EGM2008;f.ENABLE_POINT_MASS=true;f.GRAVITATIONAL_PARAMETER=3.986004418e14;
  f.HAS_MAXIMUM_DEGREE=true;f.MAXIMUM_DEGREE=24;f.HAS_MAXIMUM_ORDER=true;f.MAXIMUM_ORDER=24;
  f.ENABLE_THIRD_BODY=true;f.THIRD_BODY_IDS={10,301};f.ENABLE_SRP=true;f.ENABLE_DRAG=true;f.INITIAL_MASS_KG=1;f.AREA_M2=1;f.REFLECTIVITY_COEFFICIENT=0.0135;f.DRAG_COEFFICIENT=B;
  f.RADIATION_PRESSURE_MODEL=prwRadiationPressureFamily::CANNONBALL;f.ATMOSPHERE_MODEL=prwAtmosphereFamily::NRLMSISE00;f.EPHEMERIS_SOURCE="JPL_SPK";f.SOLID_TIDES=prwSolidTideModel::IERS_2010;
  r.INTEGRATOR=std::make_unique<PRWIntegratorSettingsT>();auto& it=*r.INTEGRATOR;
  it.ALGORITHM=prwSolverAlgorithm::RK78;it.INITIAL_STEP_SECONDS=30;it.MINIMUM_STEP_SECONDS=0.01;it.MAXIMUM_STEP_SECONDS=75;it.ABSOLUTE_TOLERANCES.assign(6,1e-8);it.RELATIVE_TOLERANCE=1e-11;it.MAXIMUM_STEPS=2000000;
  r.INCLUDE_STM=true;r.STM_TECHNIQUE=prwDerivativeTechnique::ANALYTIC;r.DENSITY_TREATMENT=prwDensityTreatment::FINITE_DIFFERENCE;r.DYNAMIC_PARAMETERS={prwDynamicParameter::DRAG_AREA_OVER_MASS};
  fb::FlatBufferBuilder b;FinishSizePrefixedPRWBuffer(b,PRW::Pack(b,&request));std::vector<uint8_t> output;
  if(!ffm::processPrwInvoke(b.GetBufferPointer(),b.GetSize(),kernel->payload,kernel->payload_length,env,output,error))return false;
  fb::Verifier verifier(output.data(),output.size());if(!VerifySizePrefixedPRWBuffer(verifier)){error="FFM returned invalid PRW";return false;}
  auto result=GetSizePrefixedPRW(output.data())->EXECUTION_RESULT();
  if(!result||!result->SAMPLES()||result->SAMPLES()->size()!=1){error="FFM returned no endpoint";return false;}
  auto point=result->SAMPLES()->Get(0);if(!point->STATE()||!point->STATE()->STATE()||!point->STM()||point->STM()->DIMENSION()!=7||!point->STM()->VALUES()||point->STM()->VALUES()->size()!=49){error="FFM returned no 7x7 transition matrix";return false;}
  auto state=point->STATE()->STATE();if(!state->POSITION()||!state->VELOCITY()){error="FFM returned no state";return false;}
  end.mjd=to;end.r[0]=state->POSITION()->X();end.r[1]=state->POSITION()->Y();end.r[2]=state->POSITION()->Z();end.v[0]=state->VELOCITY()->X();end.v[1]=state->VELOCITY()->Y();end.v[2]=state->VELOCITY()->Z();
  for(int i=0;i<6;++i){sensitivity[i]=point->STM()->VALUES()->Get(i*7+6);for(int j=0;j<6;++j)phi[i*6+j]=point->STM()->VALUES()->Get(i*7+j);}
  return true;
}
// RTN sigmas frozen in E13: [4,10,2] m and [10,3,2.5] mm/s.
bool state_covariance(const OrbitalState& s,double C[36]){
  double R[3],N[3],T[3];const double radius=std::sqrt(dot(s.r,s.r));cross(s.r,s.v,N);const double norm=std::sqrt(dot(N,N));if(!(radius>0&&norm>0))return false;
  for(int k=0;k<3;++k){R[k]=s.r[k]/radius;N[k]/=norm;}cross(N,R,T);
  const double* axes[]={R,T,N};const double variances[]={16,100,4,0.0001,0.000009,0.00000625};
  std::fill(C,C+36,0);for(int block=0;block<2;++block)for(int i=0;i<3;++i)for(int j=0;j<3;++j)for(int k=0;k<3;++k)C[(block*3+i)*6+block*3+j]+=axes[k][i]*variances[block*3+k]*axes[k][j];return true;
}
double quadratic(const double x[6],const double C[36]){double total=0;for(int i=0;i<6;++i){double row=0;for(int j=0;j<6;++j)row+=C[i*6+j]*x[j];total+=x[i]*row;}return total;}
std::unique_ptr<dclObjectT> fit_arc(const std::string& id,const OrbitalState& a,const OrbitalState& observed,double B,const plugin_input_frame_t* kernel,const ffm::PrwEnvironment& env){
  auto out=std::make_unique<dclObjectT>();out->ID=id;out->FIRST_MS=ms_of_mjd(a.mjd);out->LAST_MS=ms_of_mjd(observed.mjd);
  double Ca[36],Cb[36];if(!state_covariance(a,Ca)||!state_covariance(observed,Cb)){out->SKIPPED_REASON="invalid RTN covariance";return out;}
  EarthOrientation eo;const auto obs=orbital_energy(eo,observed,36,36,kMu,kOmegaEarth,true);if(!obs.ok){out->SKIPPED_REASON="invalid endpoint energy";return out;}
  for(int iteration=0;iteration<6;++iteration){
    OrbitalState end;double phi[36],sensitivity[6];std::string error;
    if(!arc_propagate(a,observed.mjd,B,kernel,env,end,phi,sensitivity,error)){out->SKIPPED_REASON=error;return out;}
    const auto pred=orbital_energy(eo,end,36,36,kMu,kOmegaEarth,true);if(!pred.ok){out->SKIPPED_REASON="invalid predicted energy";return out;}
    double SE=0;for(int i=0;i<6;++i)SE+=pred.gradient[i]*sensitivity[i];
    double left[36]={},transported[36]={};for(int i=0;i<6;++i)for(int j=0;j<6;++j)for(int k=0;k<6;++k)left[i*6+j]+=phi[i*6+k]*Ca[k*6+j];
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)for(int k=0;k<6;++k)transported[i*6+j]+=left[i*6+k]*phi[j*6+k];
    const double variance=quadratic(obs.gradient,Cb)+quadratic(pred.gradient,transported),next=B+(obs.value-pred.value)/SE,sigma=std::sqrt(variance)/std::abs(SE);
    if(!positive(next)||!std::isfinite(sigma)){out->SKIPPED_REASON="non-positive or non-finite energy fit";return out;}
    out->BALLISTIC_COEFFICIENT_M2_KG=next;out->LN_B=std::log(next);out->LN_B_SIGMA=sigma/next;
    out->FIT=std::make_unique<dclFitStatisticsT>();out->FIT->ITERATIONS=iteration+1;out->FIT->CONVERGED=std::abs(next-B)/B<1e-3;
    if(out->FIT->CONVERGED)break;B=next;
  }
  out->OK=out->FIT->CONVERGED&&out->LN_B_SIGMA<=0.5;
  if(!out->OK)out->SKIPPED_REASON=out->FIT->CONVERGED?"relative uncertainty above 0.5":"energy fit not converged";
  return out;
}
}
extern "C" int fit_energy_arcs(){
  const auto input=[](const char* port){int i=plugin_find_input_index(port,0);return i<0?nullptr:plugin_get_input_frame(i);};
  const auto* kernel=input("kernel"),*eop=input("earth_orientation"),*weather=input("space_weather");
  if(!kernel||!eop||!weather)return fail("missing-environment","E13 energy fits require kernel, Earth orientation and licensed NRLMSISE-00 weather.");
  ffm::PrwEnvironment env;env.earthOrientation=eop->payload;env.earthOrientationSize=eop->payload_length;env.spaceWeather=weather->payload;env.spaceWeatherSize=weather->payload_length;
  DCLT output;output.ATMOSPHERE=std::make_unique<ATMT>();output.ATMOSPHERE->MODEL=AtmosphericModelFamily::NRLMSIS00E;output.STATUS=dclStatus::Solved;
  try{
    for(uint32_t i=0;i<plugin_get_input_count();++i){const auto* f=plugin_get_input_frame(i);if(!f->port_id||std::strcmp(f->port_id,"request"))continue;
      fb::Verifier verifier(f->payload,f->payload_length);if(!VerifyDCLBuffer(verifier))return fail("invalid-request","Expected a private DCL state series.");auto* r=GetDCL(f->payload);
      if(!r->ID()||r->CREATED_AT_MS()<=0)return fail("invalid-request","State series needs ID and issue time.");
      if(output.CREATED_AT_MS&&output.CREATED_AT_MS!=r->CREATED_AT_MS())return fail("invalid-request","Mixed issue times refused.");output.CREATED_AT_MS=r->CREATED_AT_MS();
      if(!output.PROVENANCE&&r->PROVENANCE())output.PROVENANCE.reset(r->PROVENANCE()->UnPack());
      std::vector<OrbitalState> states;auto error=load_states(r,states);if(!error.empty()||states.size()>33)return fail("invalid-states",error.empty()?"State budget exceeded":error);
      double B=positive(r->BALLISTIC_COEFFICIENT_M2_KG())?r->BALLISTIC_COEFFICIENT_M2_KG():0.02;
      for(size_t j=1;j<states.size();++j){const double hours=(states[j].mjd-states[j-1].mjd)*24;if(hours<20||hours>28)continue;
        auto fit=fit_arc(r->ID()->str(),states[j-1],states[j],B,kernel,env);if(fit->OK)B=fit->BALLISTIC_COEFFICIENT_M2_KG;output.OBJECTS.push_back(std::move(fit));
      }
    }
  }catch(const std::exception& e){return fail("energy-fit-failed",e.what());}
  if(output.OBJECTS.empty())return fail("insufficient-arcs","No 20–28 hour state pairs.");
  fb::FlatBufferBuilder b;return emit("arcs",b,DCL::Pack(b,&output));
}
// FFM's SDK adapter owns these for its standalone artifact. This module uses
// the same ctor lifetime/futex accommodation while keeping its own SDK entry.
extern "C" void __real___wasm_call_ctors(void);
extern "C" void __wrap___wasm_call_ctors(void){static bool initialized=false;if(!initialized){initialized=true;__real___wasm_call_ctors();}}
extern "C" void __wasm_call_ctors(void);
extern "C" void ffm_initialize(void){static bool initialized=false;if(!initialized){initialized=true;__wasm_call_ctors();}}
extern "C" int emscripten_futex_wait(volatile void* address,uint32_t expected,double timeoutMs){const int64_t timeout=std::isfinite(timeoutMs)?static_cast<int64_t>(timeoutMs*1000000.0):-1;const int r=__builtin_wasm_memory_atomic_wait32(const_cast<int32_t*>(static_cast<volatile int32_t*>(address)),static_cast<int32_t>(expected),timeout);return r==0?0:r==1?-EWOULDBLOCK:-ETIMEDOUT;}
extern "C" int emscripten_futex_wake(volatile void* address,int count){return __builtin_wasm_memory_atomic_notify(const_cast<int32_t*>(static_cast<volatile int32_t*>(address)),count);}

// OEM metadata truthfully declares Planet's TT epochs and EME2000 axes. This
// transform is the same ERFA IAU-2006 J2000 bias as foundation/frames, and the
// same TT -> TAI -> UTC conversion as foundation/time; no JS approximation.
extern "C" int prepare_operator_states(){
  const int index=plugin_find_input_index("operator_states",0);if(index<0)return fail("invalid-request","One private OEM required.");
  const auto* f=plugin_get_input_frame(index);fb::Verifier verifier(f->payload,f->payload_length);if(!VerifySizePrefixedOEMBuffer(verifier))return fail("invalid-request","Expected size-prefixed OEM.");
  const auto* oem=GetSizePrefixedOEM(f->payload);double issue=0;if(!mjd_of_iso(oem->CREATION_DATE(),issue))return fail("invalid-request","OEM needs UTC issue time.");
  if(!oem->EPHEMERIS_DATA_BLOCK()||oem->EPHEMERIS_DATA_BLOCK()->size()>36)return fail("invalid-request","Expected at most 36 calibration Doves.");
  double rb[3][3],rp[3][3],rbp[3][3];eraBp06(2451545.0,0,rb,rp,rbp);
  for(const auto* block:*oem->EPHEMERIS_DATA_BLOCK()){
    if(block->TIME_SYSTEM()!=timingStandard::TT||!block->REFERENCE_FRAME()||!block->REFERENCE_FRAME()->NAME()||block->REFERENCE_FRAME()->NAME()->str()!="EME2000"||!block->OBJECT()||!block->OBJECT()->OBJECT_ID()||!block->EPHEMERIS_DATA_LINES()||block->EPHEMERIS_DATA_LINES()->size()>33)return fail("invalid-request","Planet series needs explicit TT/EME2000 and bounded states.");
    DCLT out;out.ID=block->OBJECT()->OBJECT_ID()->str();out.CREATED_AT_MS=ms_of_mjd(issue);out.BALLISTIC_COEFFICIENT_M2_KG=0.02;out.STATES=std::make_unique<dclStatesT>();out.STATES->EPHEMERIS=std::make_unique<ephemerisDataBlockT>();auto& states=*out.STATES->EPHEMERIS;
    out.PROVENANCE=std::make_unique<PVNT>();if(oem->COMMENT())out.PROVENANCE->LINEAGE=oem->COMMENT()->str();
    int64_t previous=0;
    for(const auto* line:*block->EPHEMERIS_DATA_LINES()){
      double tt,tai1,tai2,utc1,utc2;if(!mjd_of_iso(line->EPOCH(),tt)||eraTttai(2400000.5,tt,&tai1,&tai2)||eraTaiutc(tai1,tai2,&utc1,&utc2)<0)return fail("invalid-time","Planet TT conversion refused.");
      const int64_t ms=ms_of_mjd((utc1-2400000.5)+utc2);if(ms<=previous)return fail("invalid-time","Planet epochs must increase.");previous=ms;
      auto target=std::make_unique<ephemerisDataLineT>();target->EPOCH=utc_iso(mjd_of_ms(ms));
      double r[3]={line->X(),line->Y(),line->Z()},v[3]={line->X_DOT(),line->Y_DOT(),line->Z_DOT()},rr[3],vv[3];eraTrxp(rb,r,rr);eraTrxp(rb,v,vv);
      target->X=rr[0];target->Y=rr[1];target->Z=rr[2];target->X_DOT=vv[0];target->Y_DOT=vv[1];target->Z_DOT=vv[2];states.EPHEMERIS_DATA_LINES.push_back(std::move(target));
    }
    fb::FlatBufferBuilder b;if(emit("request",b,DCL::Pack(b,&out)))return 1;
  }
  return 0;
}
