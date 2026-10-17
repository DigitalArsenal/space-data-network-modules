#include "space_data_module_invoke.h"
#include "model_types.hpp"
#include "galactic_constants.hpp"
#include "legacy_model.hpp"
#include "volume.hpp"
#include "wire.hpp"
#include <memory>

namespace milky_way {
const Vec3 sun{-galactic_constants::solar_radius_kpc,0,galactic_constants::solar_height_kpc};
std::unique_ptr<NestedVolumes> volumes;
bool legacy_active=false;
void volume_result(wire::Result& r,const char* name,const Volume& v) {
  const std::string prefix(name);
  r.vector((prefix+"_layout").c_str(),{double(reinterpret_cast<uintptr_t>(v.rgba.data())),
    double(v.rgba.size()*sizeof(uint16_t)),double(v.nx),double(v.ny),double(v.nz),4,2},"byte-layout");
  r.vector((prefix+"_bounds").c_str(),{v.minimum.x,v.minimum.y,v.minimum.z,v.maximum.x,v.maximum.y,v.maximum.z},"kpc");
  r.vector((prefix+"_z_coordinates").c_str(),v.z_coordinates(),"kpc");
  r.number((prefix+"_z_mapping").c_str(),v.z_mapping);
}
}
extern "C" int bake_legacy() {
  using namespace milky_way;
  wire::Request request;if (!request.ok) return wire::fail("Expected one $PCE request");
  volumes=std::make_unique<NestedVolumes>(sun); volumes->bake(legacy);legacy_active=true;
  wire::Result r; volume_result(r,"global",volumes->global);volume_result(r,"local",volumes->local);
  r.text("label","model");r.text("channels","legacy RGB emissivity per kpc; extinction optical depth per kpc");return r.emit();
}
extern "C" int verify_legacy() {
  using namespace milky_way;
  wire::Request request;if (!request.ok || !volumes || !legacy_active) return wire::fail("Bake legacy first");
  const auto report=milky_way::verify_legacy(*volumes);
  wire::Result r;r.number("max_error",report.max_error);r.number("rms_error",report.rms_error);
  r.number("samples",report.samples);r.number("tolerance_max",0.08);r.number("tolerance_rms",0.015);
  return r.emit();
}
