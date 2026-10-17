#include "space_data_module_invoke.h"
#include <algorithm>
#include <map>
#include <string>
#include <vector>

namespace {
using Values = std::map<std::string,const PCEParameterValue*>;
int fail(const char* message) { plugin_set_error("invalid-screening-request",message); return 1; }
const PCE* record(const plugin_input_frame_t* f) {
  if (!f || !f->payload || f->payload_length > 1024*1024) return nullptr;
  flatbuffers::Verifier v(f->payload,f->payload_length);
  return VerifyPCEBuffer(v) ? GetPCE(f->payload) : nullptr;
}
bool values(const PCE* p, Values& out) {
  const auto* r=p ? p->EVALUATION_RESULT() : nullptr;
  if (!r || r->STATUS()!=pceResultStatus_OK || !r->SAMPLES() || r->SAMPLES()->size()!=1) return false;
  const auto* vs=r->SAMPLES()->Get(0)->PARAMETER_VALUES();
  if (!vs) return false;
  for (const auto* v:*vs) {
    if (v->PARAMETER()!=pceParameter_PROVIDER_DEFINED || !v->PROVIDER_DEFINED_NAME() ||
        v->STATUS()!=pceResultStatus_OK || !out.emplace(v->PROVIDER_DEFINED_NAME()->str(),v).second) return false;
  }
  return true;
}
const PCEParameterValue* get(const Values& v,const std::string& name) {
  const auto it=v.find(name); return it==v.end()?nullptr:it->second;
}
std::string text(const Values& v,const char* name) {
  const auto* x=get(v,name); return x&&x->STRING_VALUE()?x->STRING_VALUE()->str():"";
}
double scalar(const Values& v,const char* name,pceUnit unit) {
  const auto* x=get(v,name);
  return x && x->UNIT()==unit && !x->VALUES() && !x->STRING_VALUE() ? x->VALUE() : NAN;
}
std::unique_ptr<PCEParameterValueT> number(const std::string& name,double v,pceUnit unit) {
  auto p=std::make_unique<PCEParameterValueT>(); p->PARAMETER=pceParameter_PROVIDER_DEFINED;
  p->PROVIDER_DEFINED_NAME=name;p->STATUS=pceResultStatus_OK;p->VALUE=v;p->UNIT=unit;return p;
}
void add_text(PCEParameterSampleT& s,const std::string& name,const std::string& value) {
  auto v=number(name,0,pceUnit_UNSPECIFIED);v->STRING_VALUE=value;s.PARAMETER_VALUES.push_back(std::move(v));
}
void add_vector(PCEParameterSampleT& s,const std::string& name,const std::vector<double>& data,pceUnit unit) {
  auto v=number(name,0,unit);v->VALUES=data;s.PARAMETER_VALUES.push_back(std::move(v));
}
int emit(const char* port,PCEParameterSampleT& sample,const std::string& trace) {
  flatbuffers::FlatBufferBuilder b;
  const auto s=CreatePCEParameterSample(b,&sample);
  const auto result=CreatePCEEvaluationResult(b,pceResultStatus_OK,0,b.CreateVector(&s,1),0,b.CreateString(trace));
  FinishPCEBuffer(b,CreatePCE(b,0,0,result));
  return plugin_push_output(port,"PCE.fbs","$PCE",b.GetBufferPointer(),b.GetSize());
}
struct Row { const PCE* record; Values fields; size_t count; };
}

extern "C" int screen_grid(void) {
  Values config; const PCE* request=nullptr; std::vector<Row> rows;
  for (uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* f=plugin_get_input_frame(i);
    if (!f || !f->port_id) return fail("Missing port identifier.");
    const std::string port=f->port_id;
    if (port=="request") {
      if (request || !(request=record(f)) || !values(request,config)) return fail("Expected one PCE request.");
    } else if (port=="mesh") {
      Row r{record(f),{},0};
      if (rows.size()==400 || !values(r.record,r.fields)) return fail("Invalid PCE mesh row.");
      const auto* status=get(r.fields,"status");
      if (!status || !status->VALUES() || status->UNIT()!=pceUnit_DIMENSIONLESS ||
          !(r.count=status->VALUES()->size()) || r.count>400) return fail("Invalid grid shape.");
      for (const auto& name:{"departure_dv","arrival_dv","departure_epoch","arrival_epoch","revolutions"}) {
        const auto* v=get(r.fields,name);
        const pceUnit unit=std::string(name).find("epoch")!=std::string::npos ? pceUnit_SECOND :
          std::string(name)=="revolutions"?pceUnit_DIMENSIONLESS:pceUnit_METRE_PER_SECOND;
        if (!v || !v->VALUES() || v->VALUES()->size()!=r.count || v->UNIT()!=unit) return fail("Missing or mismatched mesh columns.");
      }
      rows.push_back(std::move(r));
    } else return fail("Unknown input port.");
  }
  if (!request || rows.empty()) return fail("Request and mesh are required.");
  const std::string objective=text(config,"objective");
  const std::vector<std::string> objectives={"departure_c3","departure_vinf","arrival_vinf","sum_vinf","parking_injection","capture","total_impulse"};
  if (std::find(objectives.begin(),objectives.end(),objective)==objectives.end()) return fail("Unknown objective.");
  for (const char* key:{"ephemeris","center","reference_frame","time_scale","epoch_origin","provenance"})
    if (text(config,key).empty()) return fail("Ephemeris, frame, time scale, center, epoch origin and provenance are required.");
  const double dm=scalar(config,"departure_mu",pceUnit_PROVIDER_DEFINED), dr=scalar(config,"departure_parking_radius",pceUnit_METRE);
  const double am=scalar(config,"arrival_mu",pceUnit_PROVIDER_DEFINED), ar=scalar(config,"arrival_parking_radius",pceUnit_METRE);
  const double step=scalar(config,"grid_step",pceUnit_SECOND);
  const double offset=scalar(config,"page_offset",pceUnit_DIMENSIONLESS), limit=scalar(config,"page_size",pceUnit_DIMENSIONLESS);
  const double cancelled=scalar(config,"cancelled",pceUnit_DIMENSIONLESS);
  for (const char* name:{"departure_mu","arrival_mu"}) {
    const auto* catalog=request->CATALOG(); bool declared=false;
    if (catalog && catalog->ENTRIES()) for (const auto* d:*catalog->ENTRIES())
      if (d->PROVIDER_DEFINED_NAME() && d->PROVIDER_DEFINED_NAME()->str()==name &&
          d->UNIT()==pceUnit_PROVIDER_DEFINED && d->PROVIDER_DEFINED_UNIT_SYMBOL() &&
          d->PROVIDER_DEFINED_UNIT_SYMBOL()->str()=="m^3/s^2") declared=true;
    if (!declared) return fail("Declare each body GM catalog unit as m^3/s^2.");
  }
  if (!std::isfinite(mission_screening::circular_impulse(0,dm,dr)) ||
      !std::isfinite(mission_screening::circular_impulse(0,am,ar)) || !std::isfinite(step) || step<=0 ||
      !std::isfinite(offset) || offset<0 || std::floor(offset)!=offset || offset>160000 ||
      !std::isfinite(limit) || limit<1 || limit>160000 || std::floor(limit)!=limit ||
      (cancelled!=0 && cancelled!=1)) return fail("Invalid body constants, grid step or page controls.");
  const std::string trace=request->EVALUATION_RESULT()->TRACE_ID()?request->EVALUATION_RESULT()->TRACE_ID()->str():"mission-screening";
  auto metadata=[&](PCEParameterSampleT& s) {
    s.EPOCH=text(config,"epoch_origin"); s.EPOCH_TIME_SYSTEM=text(config,"time_scale");
    for (const char* key:{"ephemeris","center","reference_frame","time_scale","epoch_origin","provenance","objective"}) add_text(s,key,text(config,key));
    add_text(s,"model","two-body ballistic; circular parking injection and capture; zero-revolution Lambert branch per cell");
    s.PARAMETER_VALUES.push_back(number("grid_step",step,pceUnit_SECOND));
    s.PARAMETER_VALUES.push_back(number("cancelled",cancelled,pceUnit_DIMENSIONLESS));
  };
  if (cancelled==1) { PCEParameterSampleT s;metadata(s);return emit("best",s,trace)<0?fail("Output rejected."):0; }
  size_t index=0,best_index=0;double best=INFINITY;PCEParameterSampleT best_sample;
  const std::vector<std::string> metrics={"departure_c3","departure_vinf","arrival_vinf","sum_vinf","parking_injection","flyby_impulse","capture","total_impulse"};
  int last=-1;uint64_t sequence=0;
  for (const auto& row:rows) {
    const auto* original=row.record->EVALUATION_RESULT()->SAMPLES()->Get(0);
    if (!original->EPOCH() || original->EPOCH()->str()!=text(config,"epoch_origin") ||
        !original->EPOCH_TIME_SYSTEM() || original->EPOCH_TIME_SYSTEM()->str()!=text(config,"time_scale") ||
        text(row.fields,"reference_frame")!=text(config,"reference_frame")) return fail("Mesh context differs from screening context.");
    std::map<std::string,std::vector<double>> output;
    for (size_t j=0;j<row.count;++j,++index) {
      const double status=get(row.fields,"status")->VALUES()->Get(j);
      if (!std::isfinite(status) || status<0 || status>3 || std::floor(status)!=status)
        return fail("Unknown Lambert cell status.");
      const double d=get(row.fields,"departure_dv")->VALUES()->Get(j),a=get(row.fields,"arrival_dv")->VALUES()->Get(j);
      if (status==0 && (get(row.fields,"revolutions")->VALUES()->Get(j)!=0 || !std::isfinite(d) || d<0 || !std::isfinite(a) || a<0))
        return fail("Screening requires finite zero-revolution cells; multi-revolution objective selection belongs to Lambert.");
      const auto budget=mission_screening::evaluate(d,a,0,dm,dr,am,ar);
      const double numbers[]={budget.departure_c3,budget.departure_vinf,budget.arrival_vinf,budget.sum_vinf,
        budget.parking_injection,budget.flyby_impulse,budget.capture,budget.total_impulse};
      const double cost=numbers[objective=="departure_c3"?0:objective=="departure_vinf"?1:objective=="arrival_vinf"?2:
        objective=="sum_vinf"?3:objective=="parking_injection"?4:objective=="capture"?6:7];
      if (status==0 && cost<best) {
        best=cost;best_index=index;best_sample=PCEParameterSampleT{};metadata(best_sample);
        for (size_t k=0;k<metrics.size();++k) best_sample.PARAMETER_VALUES.push_back(number(metrics[k],numbers[k],k==0?pceUnit_METRE_SQUARED_PER_SECOND_SQUARED:pceUnit_METRE_PER_SECOND));
        for (const char* key:{"departure_epoch","arrival_epoch"}) best_sample.PARAMETER_VALUES.push_back(number(key,get(row.fields,key)->VALUES()->Get(j),pceUnit_SECOND));
      }
      if (index<offset || index>=offset+limit) continue;
      output["cell_index"].push_back(index);output["status"].push_back(status);
      for (const char* key:{"departure_epoch","arrival_epoch"}) output[key].push_back(get(row.fields,key)->VALUES()->Get(j));
      for (size_t k=0;k<metrics.size();++k) output[metrics[k]].push_back(status==0?numbers[k]:NAN);
    }
    if (!output.empty()) {
      PCEParameterSampleT sample;metadata(sample);
      for (const auto& [name,data]:output) add_vector(sample,name,data,
        name=="cell_index"||name=="status"?pceUnit_DIMENSIONLESS:name.find("epoch")!=std::string::npos?pceUnit_SECOND:
        name=="departure_c3"?pceUnit_METRE_SQUARED_PER_SECOND_SQUARED:pceUnit_METRE_PER_SECOND);
      last=emit("mesh",sample,trace);if (last<0) return fail("Output rejected.");
      plugin_set_output_stream_frame(last,sequence++,0);
    }
  }
  if (last>=0) plugin_set_output_stream_frame(last,sequence-1,1);
  if (!std::isfinite(best)) {metadata(best_sample);add_text(best_sample,"result_status","no-valid-cells");}
  else best_sample.PARAMETER_VALUES.push_back(number("cell_index",best_index,pceUnit_DIMENSIONLESS));
  best_sample.PARAMETER_VALUES.push_back(number("total_cells",index,pceUnit_DIMENSIONLESS));
  best_sample.PARAMETER_VALUES.push_back(number("next_offset",std::min<double>(index,offset+limit),pceUnit_DIMENSIONLESS));
  return emit("best",best_sample,trace)<0?fail("Output rejected."):0;
}
