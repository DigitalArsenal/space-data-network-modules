#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include <algorithm>
#include <charconv>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace star_guest {
using namespace star_search;
using Params=std::map<std::string,double>;
int fail(const char* message) {plugin_set_error("star-search-failed",message);return 1;}
const plugin_input_frame_t* input(const char* port) {
  const plugin_input_frame_t* result=nullptr;
  for(uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* f=plugin_get_input_frame(i);
    if(f&&f->port_id&&std::string(f->port_id)==port) {if(result)return nullptr;result=f;}
  }
  return result;
}
struct Parameters {
  Params entries; bool valid=true;
  double take(const std::string& name,double fallback=NAN) {
    auto it=entries.find(name);if(it==entries.end()) {if(std::isnan(fallback))valid=false;return fallback;}
    double v=it->second;entries.erase(it);if(std::isnan(v))valid=false;return v;
  }
  uint32_t integer(const std::string& name,uint32_t maximum) {
    double v=take(name);if(!std::isfinite(v)||v<0||v>maximum||std::floor(v)!=v){valid=false;return 0;}return v;
  }
};
bool problem(const SLP& slp,Problem& p,Params& constants,uint32_t& threads) {
  if(!slp.PROBLEM_ID()||!slp.PROPAGATOR_PORT_ID()||!slp.VARIABLES()||slp.VARIABLES()->size()>4096||
     !slp.ATTESTATION()||!slp.ATTESTATION()->SIGNING_PUBLIC_KEY()||slp.ATTESTATION()->SIGNING_PUBLIC_KEY()->size()!=64||
     !slp.ATTESTATION()->SIGNATURE()||slp.ATTESTATION()->SIGNATURE()->size()!=64||
     !slp.ATTESTATION()->CANONICAL_JSON_SIGNATURE()||slp.ATTESTATION()->CANONICAL_JSON_SIGNATURE()->size()!=64) return false;
  Parameters q;
  for(const auto* v:*slp.VARIABLES()) {
    if(!v->VARIABLE_ID()||v->PARAMETER()!=pceParameter_PROVIDER_DEFINED||
       !v->PROVIDER_DEFINED_PARAMETER_NAME()||v->VARIABLE_ID()->str()!=v->PROVIDER_DEFINED_PARAMETER_NAME()->str()||
       !q.entries.emplace(v->VARIABLE_ID()->str(),v->INITIAL_VALUE()).second)return false;
  }
  p.stage_count=q.integer("stage_count",kMaxStages);p.leg_count=q.integer("leg_count",kMaxStages-1);
  p.row_cap=q.integer("row_cap",1000000);p.memory_cap_bytes=q.integer("memory_cap_bytes",1500000000);
  p.work_chunk_rows=q.integer("work_chunk_rows",1000000);threads=q.integer("threads",kMaxThreads);
  p.central_mu_km3_s2=q.take("central_mu_km3_s2");p.dv_total_max_km_s=q.take("dv_total_max_km_s");
  p.escape_altitude_km=q.take("escape_altitude_km");p.insertion_altitude_km=q.take("insertion_altitude_km");
  p.tfilter_enabled=q.integer("tfilter_enabled",1);p.tfilter_preemptive=q.integer("tfilter_preemptive",1);
  std::set<int> bodies;
  for(uint32_t i=0;i<p.stage_count;++i) {
    auto& s=p.stages[i];const std::string prefix="stage."+std::to_string(i)+".";
    s.body_count=q.integer(prefix+"body_count",kMaxBodiesPerStage);
    for(uint32_t j=0;j<s.body_count;++j) {
      s.bodies[j]=q.integer(prefix+"bodies."+std::to_string(j),1000000);bodies.insert(s.bodies[j]);
      s.altitude_km[j]=q.take(prefix+"altitude_km."+std::to_string(j));
    }
    s.t_min_et_s=q.take(prefix+"t_min_et_s");s.t_max_et_s=q.take(prefix+"t_max_et_s");s.dt_et_s=q.take(prefix+"dt_et_s");
    s.vinf_min_km_s=q.take(prefix+"vinf_min_km_s");s.vinf_max_km_s=q.take(prefix+"vinf_max_km_s");
    p.tfilter_dt_s[i]=q.take("tfilter_dt_s."+std::to_string(i));
    for(uint32_t j=0;j<p.stage_count;++j) {
      const std::string t="tof."+std::to_string(i)+"."+std::to_string(j)+".";
      p.tof_min_s[i][j]=q.take(t+"min_s",-INFINITY);p.tof_max_s[i][j]=q.take(t+"max_s",INFINITY);
    }
  }
  for(uint32_t i=0;i<p.leg_count;++i) {
    const auto n="."+std::to_string(i);
    p.null_legs[i]=q.integer("null_legs"+n,1);p.resonant_legs[i]=q.integer("resonant_legs"+n,1);
    p.dv_lev_max_km_s[i]=q.take("dv_lev_max_km_s"+n);p.delta_dv_lev_km_s[i]=q.take("delta_dv_lev_km_s"+n);
    p.lambert_nrev_max[i]=q.integer("lambert_nrev_max"+n,32);
    double hz=q.take("lambert_hz"+n);if(hz!=-1&&hz!=0&&hz!=1)q.valid=false;p.lambert_hz[i]=std::isfinite(hz)?hz:0;
    p.vinf_margin_pre_filter_km_s[i]=q.take("vinf_margin_pre_filter_km_s"+n);
  }
  for(uint32_t i=1;i<p.leg_count;++i) {
    const std::string f="flyby."+std::to_string(i)+".";
    p.flybys[i].trip_tof_min_s=q.take(f+"trip_tof_min_s",-INFINITY);
    p.flybys[i].trip_tof_max_s=q.take(f+"trip_tof_max_s",INFINITY);
    p.flybys[i].dv_patch_max_km_s=q.take(f+"dv_patch_max_km_s");
  }
  for(int body:bodies) for(const auto* field:{"gm_km3_s2","radius_km"}) {
    const std::string key="body."+std::to_string(body)+"."+field;const double v=q.take(key);
    if(!std::isfinite(v)||v<=0)q.valid=false;constants[key]=v;
  }
  return q.valid&&q.entries.empty()&&threads>0&&p.stage_count>=3&&p.leg_count+1==p.stage_count;
}
// Gregorian calendar to continuous TDB seconds from J2000. No UTC conversion.
double epoch(const flatbuffers::String* s) {
  if(!s)return NAN;int y,m,d,h,n,used=0;double seconds;
  if(std::sscanf(s->c_str(),"%d-%d-%dT%d:%d:%lf%n",&y,&m,&d,&h,&n,&seconds,&used)!=6||
     used!=static_cast<int>(s->size())||m<1||m>12||d<1||d>31||h<0||h>23||n<0||n>59||seconds<0||seconds>=60)return NAN;
  y-=m<=2;const int era=(y>=0?y:y-399)/400;const unsigned yo=y-era*400;
  const unsigned doy=(153*(m+(m>2?-3:9))+2)/5+d-1;
  const long days=era*146097L+yo*365+yo/4-yo/100+doy-719468;
  return (days-10957)*86400.0+h*3600+n*60+seconds-43200;
}
bool ephemeris(const OEM& o,const Params& constants,MemoryBudget* budget,Ephemeris& e) {
  if(!o.MESSAGE_ID()||o.MESSAGE_ID()->size()==0||!o.EPHEMERIS_DATA_BLOCK()||o.EPHEMERIS_DATA_BLOCK()->size()>kMaxEphemerisBodies)return false;
  std::set<int> seen;
  for(const auto* block:*o.EPHEMERIS_DATA_BLOCK()) {
    const int id=block->OBJECT_NAIF_ID();const auto key="body."+std::to_string(id)+".";
    if(!seen.insert(id).second||!constants.count(key+"gm_km3_s2")||!block->CENTER_NAME()||block->CENTER_NAME()->str()!="SUN"||
       block->CENTER_NAIF_ID()!=10||block->TIME_SYSTEM()!=timingStandard_TDB||!block->REFERENCE_FRAME()||
       !block->REFERENCE_FRAME()->NAME()||block->REFERENCE_FRAME()->NAME()->str()!="ECLIPJ2000")return false;
    auto& b=e.bodies[e.body_count++];b.body_id=id;b.gm_km3_s2=constants.at(key+"gm_km3_s2");b.mean_radius_km=constants.at(key+"radius_km");
    const auto* lines=block->EPHEMERIS_DATA_LINES();
    if(block->STEP_SIZE()!=0||!lines||lines->size()<2||lines->size()>100000)return false;
    if(b.samples.resize(lines->size(),budget)!=Status::Ok)return false;
    for(size_t i=0;i<lines->size();++i) {
      const auto* v=lines->Get(i);auto& s=b.samples[i];s.epoch_et_s=epoch(v->EPOCH());
      s.state={{v->X(),v->Y(),v->Z()},{v->X_DOT(),v->Y_DOT(),v->Z_DOT()}};
      if(!std::isfinite(s.epoch_et_s)||!std::isfinite(norm(s.state.position_km))||!std::isfinite(norm(s.state.velocity_km_s))||
         (i&&s.epoch_et_s<=b.samples[i-1].epoch_et_s))return false;
    }
    e.total_sample_count+=lines->size();
  }
  return e.body_count>0;
}
std::string quote(const std::string& s) {
  std::string out="\"";const char* hex="0123456789abcdef";
  for(unsigned char c:s) {
    if(c=='"'||c=='\\'){out+='\\';out+=c;}
    else if(c<32){out+="\\u00";out+=hex[c>>4];out+=hex[c&15];}
    else out+=c;
  }return out+'"';
}
// ECMAScript's JSON decimal/exponent thresholds, using shortest round-trip digits.
std::string decimal(double v) {
  if(v==0)return "0";char buf[64];auto r=std::to_chars(buf,buf+64,v);std::string s(buf,r.ptr);
  auto e=s.find('e');if(e==std::string::npos)return s;
  int exponent=std::stoi(s.substr(e+1));std::string mantissa=s.substr(0,e);bool negative=mantissa[0]=='-';
  if(negative)mantissa.erase(0,1);auto dot=mantissa.find('.');if(dot!=std::string::npos)mantissa.erase(dot,1);
  if(exponent>=-6&&exponent<21) {
    int point=exponent+1;
    if(point<=0)s="0."+std::string(-point,'0')+mantissa;
    else if(point>=static_cast<int>(mantissa.size()))s=mantissa+std::string(point-mantissa.size(),'0');
    else s=mantissa.substr(0,point)+"."+mantissa.substr(point);
    return (negative?"-":"")+s;
  }
  return s.substr(0,e)+"e"+(exponent>=0?"+":"-")+std::to_string(std::abs(exponent));
}
std::string canonical(const PSST& p) {
  std::string j="{\"SOLUTION_SET_ID\":"+quote(p.SOLUTION_SET_ID)+",\"PROBLEM_ID\":"+quote(p.PROBLEM_ID)+",\"OBJECTIVE_IDS\":[";
  for(size_t i=0;i<p.OBJECTIVE_IDS.size();++i){if(i)j+=',';j+=quote(p.OBJECTIVE_IDS[i]);}j+="],\"SOLUTIONS\":[";
  for(size_t i=0;i<p.SOLUTIONS.size();++i){if(i)j+=',';const auto& s=*p.SOLUTIONS[i];
    j+="{\"SOLUTION_ID\":"+quote(s.SOLUTION_ID)+",\"STATUS\":\"FEASIBLE\",\"VARIABLES\":[";
    for(size_t k=0;k<s.VARIABLES.size();++k){if(k)j+=',';const auto& v=*s.VARIABLES[k];j+="{\"VARIABLE_ID\":"+quote(v.VARIABLE_ID)+",\"VALUE\":"+decimal(v.VALUE)+"}";}
    j+="],\"OBJECTIVES\":[";
    for(size_t k=0;k<s.OBJECTIVES.size();++k){if(k)j+=',';const auto& v=*s.OBJECTIVES[k];j+="{\"OBJECTIVE_ID\":"+quote(v.OBJECTIVE_ID)+",\"VALUE\":"+decimal(v.VALUE)+"}";}
    const auto& v=*s.PROVENANCE;
    j+="],\"DOMINANCE_RANK\":0,\"CROWDING_DISTANCE\":0,\"VERIFY_BY_PROPAGATION_RESIDUAL\":0,\"PROVENANCE\":{\"SOLVER_MODULE_ID\":"+quote(v.SOLVER_MODULE_ID)+
      ",\"SOLVER_MODULE_VERSION\":"+quote(v.SOLVER_MODULE_VERSION)+",\"SOURCE_SDS_TYPE\":"+quote(v.SOURCE_SDS_TYPE)+",\"SOURCE_RECORD_ID\":"+quote(v.SOURCE_RECORD_ID)+",\"CREATED_AT\":"+quote(v.CREATED_AT)+"}}";
  }
  j+="],\"GENERATED_AT\":"+quote(p.GENERATED_AT)+",\"ATTESTATION\":{\"SIGNING_PUBLIC_KEY\":"+quote(p.ATTESTATION->SIGNING_PUBLIC_KEY)+",\"SIGNED_AT\":"+quote(p.ATTESTATION->SIGNED_AT)+"}}";return j;
}
bool sign(const std::string& slot,const uint8_t* bytes,size_t n,std::vector<uint8_t>& signature) {
  sdn::runtime::Aligned::KeyslotParams p{};p.ALGORITHM=sdn::runtime::Aligned::cryptoAlgorithm_Ed25519;
  if(!sdm_piv::put(p.SLOT_ID,slot))return false;p.set_has_SLOT_ID(true);
  auto r=sdm_piv::call("keyslot.sign","KeyslotParams",p,{sdm_piv::raw("payload",bytes,n)});
  const auto s=r.raw("data");if(!r.ok()||s.size()!=64)return false;signature.assign(s.begin(),s.end());return true;
}
}

extern "C" int search_trajectories(void) {
  using namespace star_guest;
  const auto* pf=input("problem");const auto* ef=input("ephemeris");const auto* cf=input("request");
  if(plugin_get_input_count()!=3||!pf||!ef||!cf||pf->payload_length>1024*1024||ef->payload_length>64*1024*1024||cf->payload_length>65536)return fail("Expected bounded SLP, OEM and PCE frames.");
  flatbuffers::Verifier pv(pf->payload,pf->payload_length),ev(ef->payload,ef->payload_length),cv(cf->payload,cf->payload_length);
  if(!VerifySLPBuffer(pv)||!VerifyOEMBuffer(ev)||!VerifyPCEBuffer(cv))return fail("Malformed typed frame.");
  const auto& slp=*GetSLP(pf->payload);const auto& oem=*GetOEM(ef->payload);
  const auto* cfg=GetPCE(cf->payload)->EVALUATION_RESULT();
  if(!cfg||!cfg->SAMPLES()||cfg->SAMPLES()->size()!=1||!cfg->SAMPLES()->Get(0)->PARAMETER_VALUES())return fail("Missing screening context.");
  std::map<std::string,const PCEParameterValue*> fields;
  for(const auto* v:*cfg->SAMPLES()->Get(0)->PARAMETER_VALUES())
    if(!v->PROVIDER_DEFINED_NAME()||!fields.emplace(v->PROVIDER_DEFINED_NAME()->str(),v).second)return fail("Duplicate context field.");
  auto text=[&](const char* k){auto it=fields.find(k);return it!=fields.end()&&it->second->STRING_VALUE()?it->second->STRING_VALUE()->str():std::string();};
  auto number=[&](const char* k){auto it=fields.find(k);return it!=fields.end()&&it->second->UNIT()==pceUnit_DIMENSIONLESS?it->second->VALUE():NAN;};
  const auto slot=text("signing_slot"),key=text("signing_public_key"),when=text("generated_at"),source=text("ephemeris");
  const double offset=number("page_offset"),size=number("page_size"),cancel=number("cancelled");
  if(slot.empty()||key.size()!=64||key.find_first_not_of("0123456789abcdef")!=std::string::npos||when.empty()||source.empty()||
     !std::isfinite(offset)||offset<0||offset>1000000||std::floor(offset)!=offset||!std::isfinite(size)||size<1||size>1000||std::floor(size)!=size||
     (cancel!=0&&cancel!=1))return fail("Invalid signing context or page controls.");
  Problem p{};Params constants;uint32_t threads=1;
  if(!problem(slp,p,constants,threads))return fail("Invalid SLP search parameters or attestation shape; host must authenticate SLP before invoking.");
  MemoryBudget budget(p.memory_cap_bytes);Ephemeris eph;OutputDB output;StageCounts counts;
  if(!ephemeris(oem,constants,&budget,eph))return fail("OEM must contain bounded Sun-centered ECLIPJ2000/TDB states with source MESSAGE_ID.");
  if(cancel==0) {
    const auto status=run_star_search(p,eph,ThreadOptions{threads,false},&budget,&output,&counts);
    if(status!=Status::Ok)return fail(status_message(status));
  }
  PSST result;result.PROBLEM_ID=slp.PROBLEM_ID()->str();result.SOLUTION_SET_ID=result.PROBLEM_ID+"/page/"+std::to_string(static_cast<size_t>(offset));result.GENERATED_AT=when;
  result.OBJECTIVE_IDS={"star_patch_total_m_s","departure_c3_m2_s2","departure_vinf_m_s","arrival_vinf_m_s","sum_vinf_m_s","parking_injection_m_s","flyby_impulse_m_s","capture_m_s","total_impulse_m_s","star_escape_excess_m_s","star_insertion_excess_m_s","tof_s"};
  for(size_t i=static_cast<size_t>(offset);i<output.rows.size()&&i<offset+size;++i) {
    const auto& r=output.rows[i];auto s=std::make_unique<PSSSolutionT>();s->SOLUTION_ID=std::to_string(r.traj_id);s->STATUS=pssSolutionStatus_FEASIBLE;
    auto variable=[&](std::string id,double value){auto v=std::make_unique<PSSVariableValueT>();v->VARIABLE_ID=id;v->VALUE=value;s->VARIABLES.push_back(std::move(v));};
    for(size_t k=0;k<r.encounter_count;++k){variable("epoch_tdb_s."+std::to_string(k),r.t_et_s[k]);variable("body_naif_id."+std::to_string(k),r.body_ids[k]);}
    double flyby=0;for(size_t k=0;k+1<r.leg_count;++k){flyby+=r.dv_patch_km_s[k]*1000;variable("flyby_impulse_m_s."+std::to_string(k),r.dv_patch_km_s[k]*1000);}
    for(size_t k=0;k<r.leg_count;++k) {
      const double vd[]={r.vinfD_km_s[k].x,r.vinfD_km_s[k].y,r.vinfD_km_s[k].z},va[]={r.vinfA_km_s[k].x,r.vinfA_km_s[k].y,r.vinfA_km_s[k].z};
      for(size_t a=0;a<3;++a){variable("departure_vinf_m_s."+std::to_string(k)+"."+std::to_string(a),vd[a]*1000);variable("arrival_vinf_m_s."+std::to_string(k)+"."+std::to_string(a),va[a]*1000);}
    }
    const auto dk="body."+std::to_string(r.body_ids[0])+".",ak="body."+std::to_string(r.body_ids[r.encounter_count-1])+".";
    const auto b=mission_screening::evaluate(norm(r.vinfD_km_s[0])*1000,norm(r.vinfA_km_s[r.leg_count-1])*1000,flyby,
      constants.at(dk+"gm_km3_s2")*1e9,(constants.at(dk+"radius_km")+p.escape_altitude_km)*1000,
      constants.at(ak+"gm_km3_s2")*1e9,(constants.at(ak+"radius_km")+p.insertion_altitude_km)*1000);
    const double costs[]={r.dv_total_km_s*1000,b.departure_c3,b.departure_vinf,b.arrival_vinf,b.sum_vinf,b.parking_injection,b.flyby_impulse,b.capture,b.total_impulse,r.dv_escape_km_s*1000,r.dv_insertion_km_s*1000,r.tof_total_s};
    for(size_t k=0;k<result.OBJECTIVE_IDS.size();++k){if(!std::isfinite(costs[k]))return fail("Undefined parking budget.");auto v=std::make_unique<PSSObjectiveValueT>();v->OBJECTIVE_ID=result.OBJECTIVE_IDS[k];v->VALUE=costs[k];s->OBJECTIVES.push_back(std::move(v));}
    s->PROVENANCE=std::make_unique<PSSProvenanceT>();auto& v=*s->PROVENANCE;
    v.SOLVER_MODULE_ID="com.digitalarsenal.maneuver.star-search";v.SOLVER_MODULE_VERSION="0.2.0";v.SOURCE_SDS_TYPE="OEM";v.SOURCE_RECORD_ID=oem.MESSAGE_ID()->str();v.CREATED_AT=when;
    result.SOLUTIONS.push_back(std::move(s));
  }
  result.ATTESTATION=std::make_unique<PSSAttestationT>();auto& a=*result.ATTESTATION;a.SIGNING_PUBLIC_KEY=key;a.SIGNED_AT=when;a.SIGNATURE.resize(64);a.CANONICAL_JSON_SIGNATURE.resize(64);
  // Both signatures cover the same fully built record. No unsigned PSS leaves the guest.
  flatbuffers::FlatBufferBuilder builder;FinishSizePrefixedPSSBuffer(builder,CreatePSS(builder,&result));
  const auto json=canonical(result);std::vector<uint8_t> binary_sig,json_sig;
  if(!sign(slot,builder.GetBufferPointer(),builder.GetSize(),binary_sig)||!sign(slot,reinterpret_cast<const uint8_t*>(json.data()),json.size(),json_sig))return fail("PSS signing failed; configure a host Ed25519 keyslot.");
  auto* att=GetMutableSizePrefixedPSS(builder.GetBufferPointer())->mutable_ATTESTATION();
  for(size_t i=0;i<64;++i){att->mutable_SIGNATURE()->Mutate(i,binary_sig[i]);att->mutable_CANONICAL_JSON_SIGNATURE()->Mutate(i,json_sig[i]);}
  if(plugin_push_output("solutions","PSS.fbs","$PSS",builder.GetBufferPointer()+4,builder.GetSize()-4)<0)return fail("Output rejected.");
  PCEParameterSampleT sample;sample.EPOCH="2000-01-01T12:00:00";sample.EPOCH_TIME_SYSTEM="TDB";
  auto report=[&](const char* name,double value,const std::string& string="",pceUnit unit=pceUnit_DIMENSIONLESS){auto v=std::make_unique<PCEParameterValueT>();v->PARAMETER=pceParameter_PROVIDER_DEFINED;v->PROVIDER_DEFINED_NAME=name;v->VALUE=value;v->STRING_VALUE=string;v->UNIT=unit;v->STATUS=pceResultStatus_OK;sample.PARAMETER_VALUES.push_back(std::move(v));};
  report("model",0,"Star ballistic approximate powered flyby; time-bin filter; not a continuous optimizer or Pareto guarantee",pceUnit_UNSPECIFIED);
  report("objective",0,"star_patch_total_m_s excludes escape and insertion",pceUnit_UNSPECIFIED);
  report("ephemeris",0,source,pceUnit_UNSPECIFIED);report("reference_frame",0,"ECLIPJ2000",pceUnit_UNSPECIFIED);report("center",0,"SUN (NAIF 10)",pceUnit_UNSPECIFIED);
  report("source_record",0,oem.MESSAGE_ID()->str(),pceUnit_UNSPECIFIED);report("cancelled",cancel);report("total_solutions",output.rows.size());report("page_offset",offset);report("next_offset",std::min<double>(output.rows.size(),offset+size));
  report("verify_by_propagation_performed",0);report("dominance_ranking_performed",0);report("encounter_rows",counts.encounter_rows);report("peak_memory_bytes",counts.peak_memory_bytes);
  for(size_t i=0;i<p.stage_count;++i)report(("stage_step_s."+std::to_string(i)).c_str(),p.stages[i].dt_et_s,"",pceUnit_SECOND);
  flatbuffers::FlatBufferBuilder rb;const auto rs=CreatePCEParameterSample(rb,&sample);const auto er=CreatePCEEvaluationResult(rb,pceResultStatus_OK,0,rb.CreateVector(&rs,1));FinishPCEBuffer(rb,CreatePCE(rb,0,0,er));
  return plugin_push_output("report","PCE.fbs","$PCE",rb.GetBufferPointer(),rb.GetSize())<0?fail("Output rejected."):0;
}
