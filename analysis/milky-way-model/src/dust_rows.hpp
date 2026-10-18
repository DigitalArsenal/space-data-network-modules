#pragma once
#include "dust_map.hpp"
#include "stellar_populations.hpp"
#include <cstring>
#include <map>
#include <string>

// load_dust_map: 1..64 SDS $PCE rows on port "rows", each one z plane of a
// published 3D dust map as data-source/dust-map-3d delivers it. Rows of one
// dataset and geometry accumulate across calls; the map is used once every
// plane has arrived. A row of another dataset or geometry starts a new map.
namespace milky_way::dust_rows {

struct Loaded { const char* error=nullptr; uint32_t rows=0; };

struct Row {
  std::map<std::string,const PCEParameterValue*> values;
  // A row is one $PCE as stored in an SDS stream (size-prefixed, which keeps
  // its 8-byte alignment) or a bare $PCE buffer.
  bool parse(const uint8_t* payload,size_t length) {
    const PCE* root=nullptr;
    uint32_t prefix=0;
    if(length>=8) std::memcpy(&prefix,payload,4);
    if(length>=8&&size_t(prefix)+4==length) {
      flatbuffers::Verifier verifier(payload,length);
      if(!VerifySizePrefixedPCEBuffer(verifier)) return false;
      root=GetSizePrefixedPCE(payload);
    } else {
      flatbuffers::Verifier verifier(payload,length);
      if(!VerifyPCEBuffer(verifier)) return false;
      root=GetPCE(payload);
    }
    const auto* result=root->EVALUATION_RESULT();
    if(!result||!result->SAMPLES()||result->SAMPLES()->size()!=1) return false;
    const auto* params=result->SAMPLES()->Get(0)->PARAMETER_VALUES();
    if(!params) return false;
    for(const auto* v:*params) {
      if(!v->PROVIDER_DEFINED_NAME()||v->PARAMETER()!=pceParameter::PROVIDER_DEFINED) return false;
      if(!values.emplace(v->PROVIDER_DEFINED_NAME()->str(),v).second) return false;
    }
    return true;
  }
  const PCEParameterValue* find(const char* name) const {
    const auto it=values.find(name);return it==values.end()?nullptr:it->second;
  }
  std::vector<double> vector(const char* name) const {
    const auto* v=find(name);
    if(!v||!v->VALUES()) return {};
    return {v->VALUES()->begin(),v->VALUES()->end()};
  }
  double number(const char* name) const {
    const auto* v=find(name);return v?v->VALUE():std::numeric_limits<double>::quiet_NaN();
  }
  std::string text(const char* name) const {
    const auto* v=find(name);return v&&v->STRING_VALUE()?v->STRING_VALUE()->str():std::string();
  }
};

inline bool whole(double v,double lo,double hi) {return std::isfinite(v)&&v>=lo&&v<=hi&&std::floor(v)==v;}

inline Loaded load() {
  Loaded out;
  const uint32_t count=plugin_get_input_count();
  if(count<1||count>64) {out.error="Expected 1 to 64 dust map rows on port rows";return out;}
  auto& g=dust_map::grid();
  for(uint32_t i=0;i<count;++i) {
    const auto* f=plugin_get_input_frame(i);
    if(!f||!f->payload||!f->port_id||std::strcmp(f->port_id,"rows")!=0||f->payload_length>16u*1024u*1024u)
      {out.error="Each dust map row is one $PCE frame on port rows";return out;}
    Row row;
    if(!row.parse(f->payload,f->payload_length)) {out.error="A dust map row is not a valid single-sample $PCE";return out;}
    const auto shape=row.vector("shape"),first=row.vector("first_center"),density=row.vector("density");
    const double plane=row.number("plane"),spacing=row.number("spacing"),radius=row.number("max_radius");
    const double av=row.number("a_v_per_unit");
    const std::string dataset=row.text("dataset"),unit=row.text("unit");
    if(dataset.empty()||shape.size()!=3||first.size()!=3||!whole(shape[0],2,1024)||!whole(shape[1],2,1024)
       ||!whole(shape[2],2,1024)||shape[0]*shape[1]*shape[2]>16e6||!(spacing>0&&spacing<1)
       ||!(radius>0&&radius<=10)||!std::isfinite(first[0])||!std::isfinite(first[1])||!std::isfinite(first[2]))
      {out.error="Dust map row geometry is missing or out of range";return out;}
    if(unit!="E(ZGR23) pc^-1"||!(av>0&&av<10))
      {out.error="Dust map rows must carry E of Zhang, Green & Rix (2023) per pc and its A_V factor";return out;}
    const uint32_t nx=uint32_t(shape[0]),ny=uint32_t(shape[1]),nz=uint32_t(shape[2]);
    if(!whole(plane,0,nz-1)||density.size()!=size_t(nx)*ny)
      {out.error="Dust map row plane index or density length does not match its shape";return out;}
    const bool same=g.dataset==dataset&&g.nx==nx&&g.ny==ny&&g.nz==nz&&g.spacing==spacing&&g.radius==radius
      &&g.first_center.x==first[0]&&g.first_center.y==first[1]&&g.first_center.z==first[2]&&g.a_v_per_unit==av;
    if(!same) {
      g=dust_map::Grid{};
      g.dataset=dataset;g.nx=nx;g.ny=ny;g.nz=nz;g.spacing=spacing;g.radius=radius;g.a_v_per_unit=av;
      g.first_center={first[0],first[1],first[2]};g.unit=unit;
      g.tau_g.assign(size_t(nx)*ny*nz,std::numeric_limits<float>::quiet_NaN());g.have.assign(nz,0);
    }
    g.source=row.text("source");g.license=row.text("license");g.credit=row.text("credit");
    // E per pc -> A_V per kpc -> A_G per kpc -> G optical depth per kpc.
    const double factor=av*1000*populations::a_g_per_a_v/dust_map::pogson;
    float* target=g.tau_g.data()+size_t(plane)*nx*ny;
    for(size_t k=0;k<density.size();++k) {
      const double e=density[k];
      if(std::isnan(e)) {target[k]=std::numeric_limits<float>::quiet_NaN();continue;}
      if(!(e>=0&&e<1e3)) {out.error="Dust map density must be finite and non-negative, or NaN for no data";return out;}
      target[k]=float(e*factor);
    }
    if(!g.have[size_t(plane)]) {g.have[size_t(plane)]=1;++g.loaded;}
    ++out.rows;
  }
  g.ready=g.loaded==g.nz;
  return out;
}

} // namespace milky_way::dust_rows
