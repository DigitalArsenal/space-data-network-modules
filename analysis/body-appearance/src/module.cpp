#include "space_data_module_invoke.h"
#include "wire.hpp"
#include "models.hpp"
#include "photometry.hpp"
#include "disk_photometry.hpp"
#include "placement.hpp"

extern "C" int parameters() {
  using namespace appearance;
  wire::Request request;
  if(!request.only({"model"}))return wire::fail("invalid-input","Expected one typed PCE request with model only.");
  const auto model=request.text("model");wire::Result r;size_t count=0;
  for(const auto& p:parameters_table)if(model==p.model) {
    const std::string citation=std::string("doi:")+p.doi+"; "+p.locator+"; "+p.scope;
    r.number(p.name,p.value,p.unit,citation.c_str());++count;
  }
  if(!count)return wire::fail("model-unavailable","No primary-source parameter table for this model; no neighboring class is substituted.");
  r.text("model",model);return r.emit();
}

extern "C" int rotate() {
  using namespace appearance;
  wire::Request q;
  if(!q.only({"profile","latitude_rad","longitude_rad","epoch_tai_s","scene_tai_s","frame_rate_rad_s"}))
    return wire::fail("invalid-input","Invalid rotation request.");
  const auto profile=q.text("profile");
  const double lat=q.number("latitude_rad"),lon=q.number("longitude_rad"),epoch=q.number("epoch_tai_s"),scene=q.number("scene_tai_s"),frame=q.number("frame_rate_rad_s",0);
  if((profile!="doppler" && profile!="magnetic" && profile!="spectroscopic") || !in_range(lat,-pi/2,pi/2) ||
     !in_range(lon,-2*pi,2*pi) || !in_range(epoch,-1e12,1e12) || !in_range(scene,-1e12,1e12) || !in_range(frame,-1e-3,1e-3))
    return wire::fail("invalid-input","Require a named solar profile, finite SI angles and TAI times; latitude must be within the poles.");
  const double omega=solar_rate(profile,lat),delta=omega*(scene-epoch),angle=wrap(lon+(omega-frame)*(scene-epoch));
  wire::Result r;r.number("latitude_rad",lat,"rad");r.number("longitude_rad",angle,"rad");
  r.number("sidereal_rate_rad_s",omega,"rad/s");r.number("sidereal_advance_rad",delta,"rad");
  r.text("citation","doi:10.1086/168467; Table 1 and Eq. (4)");
  r.text("frame","Longitude increases in the rotation direction relative to caller's uniformly rotating frame; frame_rate=0 is sidereal.");
  return r.emit();
}

extern "C" int phase_curve() {
  using namespace appearance;
  wire::Request q;
  if(!q.only({"model","phase_rad","G1","G2"}))return wire::fail("invalid-input","Invalid phase-curve request.");
  const auto model=q.text("model");
  if(model!="hg1g2" && model!="moon:muinonen2010")return wire::fail("model-unavailable","Independent planetary photometric calibration is unavailable.");
  if(model=="moon:muinonen2010" && (q.has("G1") || q.has("G2")))return wire::fail("invalid-input","The named lunar fit cannot be silently overwritten.");
  const double g1=model=="hg1g2"?q.number("G1"):parameter(model,"G1"),g2=model=="hg1g2"?q.number("G2"):parameter(model,"G2");
  const auto angles=q.vector("phase_rad");
  if(!in_range(g1,0,1) || !in_range(g2,0,1-g1) || angles.empty() || angles.size()>4096)
    return wire::fail("invalid-input","Require physical G1,G2 weights and 1 to 4096 phase angles.");
  std::vector<double> flux,mag;
  for(double angle:angles) {
    if(!in_range(angle,0,150*pi/180))return wire::fail("out-of-domain","H,G1,G2 spline is limited to 0..150 degrees.");
    const double f=hg_flux(angle,g1,g2);
    if(!(f>0))return wire::fail("out-of-domain","The requested phase weights yield zero brightness.");
    flux.push_back(f);mag.push_back(-2.5*std::log10(f));
  }
  wire::Result r;r.vector("relative_flux",flux);r.vector("dimming_mag",mag,"mag");
  r.text("citation","doi:10.1016/j.icarus.2010.04.003; Eq. (18), Tables 3/4; lunar weights Table 6");
  r.text("normalization","Unity at zero phase; no absolute magnitude or albedo supplied.");return r.emit();
}

extern "C" int disk_photometry() {
  using namespace appearance;
  wire::Request q;
  if(!q.only({"model","phase_rad","radius_m","sun_distance_au","observer_distance_m","solar_magnitude","surface_albedo"}))
    return wire::fail("invalid-input","Invalid disk-photometry request.");
  const auto model=q.text("model");
  const bool lambert=model=="sphere:lambert",jupiter=model=="jupiter:heng2021:550nm";
  const bool saturn=model=="saturn:dyudina2016:640nm" || model=="saturn:dyudina2016:440nm";
  if(!lambert && !jupiter && !saturn)return wire::fail("model-unavailable","No independently sourced disk scattering model for this identifier.");
  const double radius=q.number("radius_m"),sun=q.number("sun_distance_au"),observer=q.number("observer_distance_m"),solar_mag=q.number("solar_magnitude");
  const double albedo=q.number("surface_albedo");
  const auto angles=q.vector("phase_rad");
  if(!in_range(radius,1,1e9) || !in_range(sun,.001,1e6) || !in_range(observer,100*radius,1e20) ||
     !in_range(solar_mag,-100,100) || angles.empty() || angles.size()>256 ||
     (lambert?!in_range(albedo,0,1):q.has("surface_albedo")))
    return wire::fail("invalid-input","Require finite far-field geometry, matched-band solar magnitude at 1 au, and 1..256 angles; only Lambert accepts surface_albedo.");
  std::vector<double> disk,ratio,magnitude;
  for(double angle:angles) {
    const double limit=lambert?pi:(jupiter?140:150)*pi/180;
    if(!in_range(angle,0,limit) || angle==pi)return wire::fail("out-of-domain","Phase outside the documented model range or zero-flux endpoint.");
    const double p=disk_albedo(model,angle,albedo),flux=p*std::pow(radius/observer/sun,2);
    if(!(flux>0) || !std::isfinite(flux))return wire::fail("out-of-domain","The requested geometry produces no finite positive reflected flux.");
    disk.push_back(p);ratio.push_back(flux);magnitude.push_back(solar_mag-2.5*std::log10(flux));
  }
  wire::Result r;r.vector("disk_albedo",disk);r.vector("solar_flux_ratio",ratio);r.vector("apparent_magnitude",magnitude,"mag");
  r.text("model",model);
  r.text("band",lambert?"Caller-defined Lambert band":(jupiter?"550 nm; NOT Johnson V":(model=="saturn:dyudina2016:640nm"?"Pioneer red, 640 nm; NOT Johnson V":"Pioneer blue, 440 nm; NOT Johnson V")));
  r.text("citation",lambert?"Closed-form Lambert sphere; unit diffuse surface albedo has geometric albedo 2/3":(jupiter?"doi:10.3847/2041-8213/abe872; Table 1, 0.55 um; doi:10.1038/s41550-021-01444-7; Eqs. (6),(23)":"doi:10.3847/0004-637X/822/2/76; Eq. (4), Table 3; piecewise-linear interpolation in phase"));
  r.text("scope","Static homogeneous sphere; Saturn globe only; supplied radius is the spherical model radius. Solar magnitude must match the model band. No fit to Mallama-Hilton.");
  return r.emit();
}

extern "C" int place() {
  using namespace appearance;
  wire::Request q;
  if(!q.only({"body_id","level","x","y","seed","radius_m","rock_abundance","rock_min_m","rock_max_m","rock_q_per_m","rock_law_source","crater_n1_km2","crater_min_m","crater_max_m"}))
    return wire::fail("invalid-input","Invalid placement request or unknown parameter.");
  const double body=q.number("body_id"),level=q.number("level"),x=q.number("x"),y=q.number("y"),seed=q.number("seed"),radius=q.number("radius_m");
  if(!integer(body,-2147483648.0,2147483647) || !integer(level,0,24) || !integer(x,0,std::ldexp(1.0,int(level))-1) ||
     !integer(y,0,std::ldexp(1.0,int(level))-1) || !integer(seed,0,4294967295.0) || !in_range(radius,1,1e9))
    return wire::fail("invalid-input","Require valid equirectangular tile indices, uint32 seed and positive body radius in meters.");
  const double k=q.number("rock_abundance",0),n1=q.number("crater_n1_km2",0);
  if(!in_range(k,0,1) || !in_range(n1,0,1e8))return wire::fail("invalid-input","Abundance must be a fraction and crater density nonnegative.");
  Tile tile(uint32_t(level),uint32_t(x),uint32_t(y),uint32_t(seed),int32_t(body),radius);
  Population rock,crater;
  if(k>0) {
    const double lo=q.number("rock_min_m"),hi=q.number("rock_max_m");
    double decay=q.number("rock_q_per_m");
    if(q.has("rock_q_per_m")) {
      if(q.text("rock_law_source").empty())return wire::fail("missing-source","An explicit rock decay coefficient requires its source.");
    } else if(body==499)decay=parameter("rock:mars","q_intercept")+parameter("rock:mars","q_inverse_abundance")/k;
    else return wire::fail("model-unavailable","The Mars rock-size calibration is not silently applied to another body; supply a cited decay coefficient.");
    if(!in_range(lo,1e-4,1e6) || !in_range(hi,lo,1e6) || hi<=lo || !in_range(decay,1e-9,1e6))
      return wire::fail("invalid-input","Require 0 < rock_min < rock_max and a finite positive decay coefficient.");
    if(!rocks(tile,k,decay,lo,hi,rock))return wire::fail("budget-exceeded","Rock count or sampling work exceeds the per-tile budget; request a finer tile.");
  }
  if(n1>0) {
    if(body!=301)return wire::fail("model-unavailable","The lunar Neukum production function is not a calibration for other bodies.");
    const double lo=q.number("crater_min_m"),hi=q.number("crater_max_m");
    if(!in_range(lo,10,300000) || !in_range(hi,lo,300000) || hi<=lo)
      return wire::fail("out-of-domain","Neukum Table I is valid from 10 m to 300 km; no sub-10-meter extrapolation.");
    if(!craters(tile,n1,lo,hi,crater))return wire::fail("budget-exceeded","Crater count or area exceeds the per-tile budget; request a finer tile or lower retention density.");
  }
  wire::Result r;r.number("tile_area_m2",tile.area,"m2");rock.emit(r,"rock");crater.emit(r,"crater");
  r.text("cfa_convention","Sum of circular projected footprints divided by spherical tile area within the requested diameter range; overlaps are not unioned.");
  r.text("rock_law_source",q.has("rock_q_per_m")?q.text("rock_law_source"):"doi:10.1029/2021EA001959; Section 1; Golombek-Rapp area law, Mars only");
  r.text("crater_law_source","doi:10.1023/A:1011989004263; Eq. (2), Table I; lunar shape, caller N(1 km)");
  r.text("orientation_model","Uniform azimuth is an explicit isotropic placement assumption, not measured geology.");
  return r.emit();
}
