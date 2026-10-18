#pragma once
#include <map>
#include <string>
#include <vector>
#include <cstdint>

namespace milky_way::wire {
using Value = flatbuffers::Offset<PCEParameterValue>;
struct Request {
  std::map<std::string,const PCEParameterValue*> values;
  bool ok = false;
  Request() {
    if (plugin_get_input_count()!=1) return;
    const auto* f=plugin_get_input_frame(0);
    if (!f || !f->payload || !f->port_id || std::string(f->port_id)!="request" || f->payload_length>16*1024*1024) return;
    flatbuffers::Verifier verifier(f->payload,f->payload_length);
    if (!VerifyPCEBuffer(verifier)) return;
    const auto* result=GetPCE(f->payload)->EVALUATION_RESULT();
    if (!result || !result->SAMPLES() || result->SAMPLES()->size()!=1) return;
    const auto* sample=result->SAMPLES()->Get(0);
    if (!sample->PARAMETER_VALUES()) {ok=true;return;}
    for (const auto* v:*sample->PARAMETER_VALUES()) {
      if (!v->PROVIDER_DEFINED_NAME() || v->PARAMETER()!=pceParameter::PROVIDER_DEFINED || v->STATUS()!=pceResultStatus::OK) return;
      if (!values.emplace(v->PROVIDER_DEFINED_NAME()->str(),v).second) return;
    }
    ok=true;
  }
  std::vector<double> vector(const char* name) const {
    const auto it=values.find(name);
    if (it==values.end() || !it->second->VALUES()) return {};
    const auto* v=it->second->VALUES(); return {v->begin(),v->end()};
  }
  double number(const char* name,double fallback=0) const {
    const auto it=values.find(name); return it==values.end()?fallback:it->second->VALUE();
  }
};
inline int fail(const char* message) {plugin_set_error("invalid-model-request",message);return 1;}
struct Result {
  flatbuffers::FlatBufferBuilder b{4096};
  std::vector<Value> values;
  std::vector<flatbuffers::Offset<PCEParameterDescriptor>> descriptors;
  void describe(const char* name,pceDataType type,const char* unit,int count=1) {
    PCEParameterDescriptorT d;
    d.PARAMETER=pceParameter::PROVIDER_DEFINED; d.PROVIDER_DEFINED_NAME=name;
    d.OWNER_CLASS=pceOwnerClass::SOLVER; d.DATA_TYPE=type;
    d.UNIT=pceUnit::PROVIDER_DEFINED; d.PROVIDER_DEFINED_UNIT_SYMBOL=unit;
    d.ELEMENT_COUNT=count;
    descriptors.push_back(PCEParameterDescriptor::Pack(b,&d));
  }
  void number(const char* name,double value,const char* unit="1") {
    describe(name,pceDataType::REAL_SCALAR,unit);
    values.push_back(CreatePCEParameterValue(b,pceParameter::PROVIDER_DEFINED,b.CreateString(name),
      pceResultStatus::OK,value,0,0,0,0,pceUnit::PROVIDER_DEFINED));
  }
  void vector(const char* name,const std::vector<double>& value,const char* unit="1") {
    describe(name,pceDataType::REAL_VECTOR,unit,int(value.size()));
    const auto data=b.CreateVector(value);
    values.push_back(CreatePCEParameterValue(b,pceParameter::PROVIDER_DEFINED,b.CreateString(name),
      pceResultStatus::OK,0,data,0,0,0,pceUnit::PROVIDER_DEFINED));
  }
  void text(const char* name,const char* value) {
    describe(name,pceDataType::STRING,"text");
    const auto text=b.CreateString(value);
    values.push_back(CreatePCEParameterValue(b,pceParameter::PROVIDER_DEFINED,b.CreateString(name),
      pceResultStatus::OK,0,0,0,0,text,pceUnit::PROVIDER_DEFINED));
  }
  int emit() {
    const auto params=b.CreateVector(values);
    const auto sample=CreatePCEParameterSample(b,0,0,params);
    const auto samples=b.CreateVector(std::vector<flatbuffers::Offset<PCEParameterSample>>{sample});
    const auto result=CreatePCEEvaluationResult(b,pceResultStatus::OK,0,samples);
    const auto entries=b.CreateVector(descriptors);
    const auto catalog=CreatePCEParameterCatalog(b,b.CreateString("milky-way-model/0.2"),
      b.CreateString("com.digitalarsenal.analysis.milky-way-model"),0,entries);
    const auto root=CreatePCE(b,catalog,0,result);
    FinishPCEBuffer(b,root);
    return plugin_push_output("result","PCE.fbs","$PCE",b.GetBufferPointer(),b.GetSize())<0?1:0;
  }
};
} // namespace milky_way::wire
