#pragma once
#include <map>
#include <string>
#include <vector>
#include <cmath>
#include <limits>
#include <initializer_list>

namespace appearance::wire {
struct Request {
  std::map<std::string,const PCEParameterValue*> values;
  bool ok=false;
  Request() {
    if(plugin_get_input_count()!=1) return;
    const auto* f=plugin_get_input_frame(0);
    if(!f || !f->payload || !f->port_id || std::string(f->port_id)!="request" || f->payload_length>1024*1024) return;
    flatbuffers::Verifier verifier(f->payload,f->payload_length);
    if(!VerifyPCEBuffer(verifier)) return;
    const auto* result=GetPCE(f->payload)->EVALUATION_RESULT();
    if(!result || result->STATUS()!=pceResultStatus::OK || !result->SAMPLES() || result->SAMPLES()->size()!=1) return;
    const auto* sample=result->SAMPLES()->Get(0);
    if(sample->PARAMETER_VALUES()) for(const auto* v:*sample->PARAMETER_VALUES()) {
      if(!v->PROVIDER_DEFINED_NAME() || v->PARAMETER()!=pceParameter::PROVIDER_DEFINED || v->STATUS()!=pceResultStatus::OK) return;
      if(!values.emplace(v->PROVIDER_DEFINED_NAME()->str(),v).second) return;
    }
    ok=true;
  }
  bool only(std::initializer_list<const char*> names) const {
    if(!ok) return false;
    for(const auto& v:values) {
      bool found=false;for(const auto* name:names) if(v.first==name) found=true;
      if(!found) return false;
    }
    return true;
  }
  bool has(const char* name)const {return values.count(name)!=0;}
  double number(const char* name,double fallback=std::numeric_limits<double>::quiet_NaN())const {
    auto it=values.find(name);if(it==values.end())return fallback;
    const auto* v=it->second;
    if(v->VALUES() || v->STRING_VALUE())return std::numeric_limits<double>::quiet_NaN();
    return v->VALUE();
  }
  std::string text(const char* name)const {
    auto it=values.find(name);if(it==values.end() || !it->second->STRING_VALUE() || it->second->VALUES())return {};
    return it->second->STRING_VALUE()->str();
  }
  std::vector<double> vector(const char* name)const {
    auto it=values.find(name);if(it==values.end() || !it->second->VALUES() || it->second->STRING_VALUE())return {};
    const auto* v=it->second->VALUES();return {v->begin(),v->end()};
  }
};
inline int fail(const char* code,const char* message) {plugin_set_error(code,message);return 1;}
struct Result {
  flatbuffers::FlatBufferBuilder b{4096};
  std::vector<flatbuffers::Offset<PCEParameterValue>> values;
  std::vector<flatbuffers::Offset<PCEParameterDescriptor>> descriptors;
  void describe(const char* name,pceDataType type,const char* unit,int count,const char* description="") {
    PCEParameterDescriptorT d;d.PARAMETER=pceParameter::PROVIDER_DEFINED;d.PROVIDER_DEFINED_NAME=name;
    d.OWNER_CLASS=pceOwnerClass::SPACE_POINT;d.DATA_TYPE=type;d.UNIT=pceUnit::PROVIDER_DEFINED;
    d.PROVIDER_DEFINED_UNIT_SYMBOL=unit;d.ELEMENT_COUNT=count;d.AVAILABILITY=pceAvailability::IMPLEMENTED;
    d.DESCRIPTION=description;
    descriptors.push_back(PCEParameterDescriptor::Pack(b,&d));
  }
  void number(const char* name,double v,const char* unit="1",const char* description="") {
    describe(name,pceDataType::REAL_SCALAR,unit,1,description);
    values.push_back(CreatePCEParameterValue(b,pceParameter::PROVIDER_DEFINED,b.CreateString(name),pceResultStatus::OK,v,0,0,0,0,pceUnit::PROVIDER_DEFINED));
  }
  void vector(const char* name,const std::vector<double>& v,const char* unit="1",const char* description="") {
    describe(name,pceDataType::REAL_VECTOR,unit,int(v.size()),description);
    const auto data=b.CreateVector(v);
    values.push_back(CreatePCEParameterValue(b,pceParameter::PROVIDER_DEFINED,b.CreateString(name),pceResultStatus::OK,0,data,0,0,0,pceUnit::PROVIDER_DEFINED));
  }
  void text(const char* name,const std::string& v) {
    describe(name,pceDataType::STRING,"text",1);
    const auto data=b.CreateString(v);
    values.push_back(CreatePCEParameterValue(b,pceParameter::PROVIDER_DEFINED,b.CreateString(name),pceResultStatus::OK,0,0,0,0,data,pceUnit::PROVIDER_DEFINED));
  }
  int emit() {
    const auto params=b.CreateVector(values);
    const auto sample=CreatePCEParameterSample(b,0,0,params);
    const auto samples=b.CreateVector(std::vector<flatbuffers::Offset<PCEParameterSample>>{sample});
    const auto result=CreatePCEEvaluationResult(b,pceResultStatus::OK,0,samples);
    const auto entries=b.CreateVector(descriptors);
    const auto catalog=CreatePCEParameterCatalog(b,b.CreateString("body-appearance/0.1"),b.CreateString("com.digitalarsenal.analysis.body-appearance"),0,entries);
    FinishPCEBuffer(b,CreatePCE(b,catalog,0,result));
    return plugin_push_output("result","PCE.fbs","$PCE",b.GetBufferPointer(),b.GetSize())<0?1:0;
  }
};
}
