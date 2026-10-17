#pragma once
#include "literature_model.hpp"
#include "statistical_stars.hpp"
#include "oracle_metrics.hpp"
#include "ridge_metrics.hpp"
#include "reid_acceptance.hpp"
#include "component_diagnostics.hpp"

namespace milky_way {
std::unique_ptr<Volume> detail;
std::vector<float> last_sky,last_flux;
double active_dust_coefficient=model_choices::dust_solar_per_kpc;
bool finite_vector(const std::vector<double>& values) {
  return std::all_of(values.begin(),values.end(),[](double v){return std::isfinite(v);});
}
bool model_ready() {return volumes && !legacy_active;}
Image read_image(const std::vector<double>& v) {
  if (v.size()!=4 || !finite_vector(v) || v[3]!=4 || v[0]<1 || v[1]<720 || v[2]<360
      || v[1]>16000 || v[2]>8000) return {};
  for (double n:v) if (std::floor(n)!=n) return {};
  const uint64_t bytes=uint64_t(v[1])*uint64_t(v[2])*4,offset=uint64_t(v[0]);
  if (bytes>128*1024*1024 || offset+bytes>uint64_t(__builtin_wasm_memory_size(0))*65536) return {};
  return {reinterpret_cast<const uint8_t*>(uintptr_t(offset)),uint32_t(v[1]),uint32_t(v[2])};
}
}

extern "C" int bake() {
  using namespace milky_way;
  wire::Request request;
  if (!request.ok) return wire::fail("Expected one $PCE request");
  if (!request.values.empty()) return wire::fail("No optional dust grids accepted: Edenhofer license and SDN provenance are unverified");
  volumes=std::make_unique<NestedVolumes>(sun); volumes->bake(literature);legacy_active=false;
  active_dust_coefficient=model_choices::dust_solar_per_kpc;
  // SplitMix64 seed 20261016; periodic texture samples, dimensionless model
  // noise. No inference of observed dust structure from this procedural tile.
  detail=std::make_unique<Volume>(32,32,32,Vec3{0,0,0},Vec3{1,1,1});
  uint64_t seed=20261016;
  for (auto& v:detail->rgba) v=to_half(float(random_uniform(seed)));
  wire::Result r;volume_result(r,"global",volumes->global);volume_result(r,"local",volumes->local);
  volume_result(r,"noise",*detail);r.text("label","model");r.text("noise_label","model");
  r.text("channels","G,BP,RP relative emissivity per kpc; G extinction optical depth per kpc");
  r.text("frame","Galactocentric origin; +x Galactic l=0, +y l=90, +z NGP; static J2000 orientation");
  r.text("calibration","literature geometry; compiled relative Gaia display-map dust fit; morphology acceptance incomplete");
  r.vector("sun",{sun.x,sun.y,sun.z},"kpc");return r.emit();
}

extern "C" int extinction() {
  using namespace milky_way;
  wire::Request request;const auto p=request.vector("points");
  if (!request.ok || !model_ready() || p.empty() || p.size()%3 || p.size()>30000 || !finite_vector(p))
    return wire::fail("Bake model, then supply 1..10000 finite Galactocentric points in kpc");
  if (std::any_of(p.begin(),p.end(),[](double v){return std::abs(v)>100;})) return wire::fail("Point outside supported 100 kpc query domain");
  std::vector<double> ag,color;
  for (size_t i=0;i<p.size();i+=3) {
    const auto e=extinction_to(Vec3{p[i],p[i+1],p[i+2]},[](Vec3 x){return volumes->sample(x);});
    ag.push_back(e.a_g);color.push_back(e.e_bp_rp);
  }
  wire::Result r;r.vector("a_g",ag,"mag");r.vector("e_bp_rp",color,"mag");
  r.text("label","model");return r.emit();
}

extern "C" int sample_stars() {
  using namespace milky_way;
  wire::Request request;const auto bounds=request.vector("bounds");
  const double seed=request.number("seed",1),count=request.number("candidates",4096);
  const double completeness=request.number("completeness"),tier=request.number("tier_limit_g",20.7);
  const double limit=request.number("display_limit_g",30);
  if (!request.ok || !model_ready() || bounds.size()!=6 || !finite_vector(bounds)
      || !std::isfinite(seed) || seed<0 || seed>9007199254740991.0 || seed!=std::floor(seed)
      || !std::isfinite(count) || count<0 || count>100000 || count!=std::floor(count)
      || !std::isfinite(completeness) || completeness<0 || completeness>1
      || !std::isfinite(tier) || !std::isfinite(limit)) return wire::fail("Invalid statistical cell request");
  for (int i=0;i<3;++i) if (!(bounds[i]<bounds[i+3]) || std::abs(bounds[i])>100 || std::abs(bounds[i+3])>100)
    return wire::fail("Cell bounds must be increasing and within 100 kpc");
  StarRequest input;input.minimum={bounds[0],bounds[1],bounds[2]};input.maximum={bounds[3],bounds[4],bounds[5]};
  input.seed=uint64_t(seed);input.candidates=uint32_t(count);input.catalog_completeness=completeness;
  input.delivered_g_limit=tier;input.display_g_limit=limit;
  const auto stars=milky_way::sample_stars(input,[](Vec3 p){return volumes->sample(p);});
  std::vector<double> packed;packed.reserve(stars.size()*7);
  for (const auto& s:stars) packed.insert(packed.end(),{s.position.x,s.position.y,s.position.z,
    s.absolute_g,s.apparent_g,s.a_g,s.weight});
  wire::Result r;r.vector("stars",packed,"kpc,kpc,kpc,mag,mag,mag,relative-density*kpc^3");
  r.number("count",stars.size());r.number("stride",7);r.number("pickable",0);
  r.text("label","model");return r.emit();
}

extern "C" int oracle_metrics() {
  using namespace milky_way;
  wire::Request request;
  const Image flux=read_image(request.vector("flux_image")),density=read_image(request.vector("density_image"));
  if (!request.ok || !model_ready() || !flux.rgba || !density.rgba) return wire::fail("Expected valid RGBA8 oracle arena descriptors after bake");
  auto m=milky_way::oracle_metrics(*volumes,flux,density);
  if (!m.valid) return wire::fail("Oracle map statistics have insufficient valid pixels or nonpositive fit");
  last_sky=std::move(m.model_sky);last_flux=std::move(m.flux_sky);
  wire::Result r;r.number("flux_r",m.flux_r);r.number("density_r",m.density_r);r.number("samples",m.samples);
  r.vector("flux_layout",{double(reinterpret_cast<uintptr_t>(last_flux.data())),double(last_flux.size()*4),720,360,1,1,4},"byte-layout");
  r.number("rift_ratio",m.rift_ratio);r.number("flux_rift_ratio",m.flux_rift_ratio);
  r.number("fit_scale",m.fit_scale);r.number("fit_intercept",m.fit_intercept);r.number("fit_log_rmse",m.fit_log_rmse);
  r.vector("fwhm_model",{m.fwhm_model.begin(),m.fwhm_model.end()},"deg");
  r.vector("fwhm_flux",{m.fwhm_flux.begin(),m.fwhm_flux.end()},"deg");
  r.vector("fwhm_relative_errors",{m.fwhm_relative_errors.begin(),m.fwhm_relative_errors.end()});
  r.vector("sky_layout",{double(reinterpret_cast<uintptr_t>(last_sky.data())),double(last_sky.size()*4),720,360,1,1,4},"byte-layout");
  const auto components=component_diagnostics(m.fit_scale);
  r.vector("component_peaks",components.peaks,"relative G intensity");
  r.vector("component_fwhm",components.widths,"deg");
  r.text("component_order","l=0,90,180,270; thin,thick,arms,bulge,bar,total,total without dust");
  r.text("fit_kind","log display-luminance affine fit; no photometric or morphology calibration");
  return r.emit();
}

extern "C" int calibrate() {
  using namespace milky_way;
  wire::Request request;const Image flux=read_image(request.vector("flux_image"));
  if (!request.ok || !model_ready() || !flux.rgba) return wire::fail("Bake model, then supply a valid flux oracle arena descriptor");
  const auto fit=calibrate_dust(*volumes,flux);
  if (!fit.valid) return wire::fail("Dust calibration has insufficient valid samples");
  for (Volume* v:{&volumes->global,&volumes->local})
    for (size_t i=3;i<v->rgba.size();i+=4) v->rgba[i]=to_half(float(from_half(v->rgba[i])*fit.factor));
  wire::Result r;r.number("dust_factor",fit.factor);r.number("boundary_hit",fit.boundary_hit);
  r.number("training_samples",fit.training_samples);
  r.number("base_dust_coefficient",active_dust_coefficient,"kpc^-1");
  active_dust_coefficient*=fit.factor;
  r.number("fitted_dust_coefficient",active_dust_coefficient,"kpc^-1");
  r.vector("candidate_factors",fit.factors);r.vector("candidate_correlations",fit.correlations);
  r.vector("candidate_log_residuals",fit.residuals);r.vector("candidate_fit_slopes",fit.fit_slopes);
  r.vector("candidate_fit_intercepts",fit.fit_intercepts);
  r.text("objective","maximize positive log flux-display correlation on a 2-degree training grid; no FWHM or threshold fitting");
  r.text("scope","one relative dust normalization; all emission geometry unchanged; display-map fit, not absolute extinction calibration");
  return r.emit();
}

extern "C" int ridge_metrics() {
  using namespace milky_way;
  wire::Request request;const auto m=request.vector("masers");
  if (!request.ok || !model_ready() || m.empty() || m.size()%4 || m.size()>40000 || !finite_vector(m))
    return wire::fail("Expected finite [Galactic longitude deg,latitude deg,parallax mas,arm family] records");
  const auto segments=request.vector("maser_segments"),excluded=request.vector("maser_excluded");
  const auto published=request.vector("published_arms"),errors=request.vector("parallax_errors");
  if (segments.size()!=m.size()/4 || excluded.size()!=segments.size() || published.size()!=49
      || errors.size()!=segments.size() || !finite_vector(errors)
      || !finite_vector(segments) || !finite_vector(excluded) || !finite_vector(published))
    return wire::fail("Expected Table 2 oracle rows, exact segment assignments and explicit exclusion mask");
  for (size_t i=0;i<segments.size();++i)
    if (segments[i]<0 || segments[i]>=7 || std::floor(segments[i])!=segments[i]
        || errors[i]<0 || (excluded[i]!=0 && excluded[i]!=1)) return wire::fail("Invalid oracle segment or exclusion mask");
  for(size_t j=0;j<7;++j) if(published[7*j+6]<=0) return wire::fail("Expected positive intrinsic arm widths");
  double maximum=0,squared=0,analytic_max=0,analytic_squared=0;
  size_t within=0,missing=0;std::vector<double> residuals,analytic_residuals;
  for (size_t i=0;i<m.size();i+=4) {
    if (m[i]<0 || m[i]>=360 || std::abs(m[i+1])>90 || m[i+2]<=0 || m[i+3]<0 || m[i+3]>=arm_count || std::floor(m[i+3])!=m[i+3])
      return wire::fail("Invalid maser coordinates, positive parallax, or arm family");
    const double l=m[i]*galactic_constants::radians_per_degree,b=m[i+1]*galactic_constants::radians_per_degree;
    // Published VLBI parallax (mas) -> distance (kpc); retain every assigned
    // source, including noisy parallaxes/outliers. No oracle-driven clipping.
    const double distance=1/m[i+2];
    const Vec3 p=sun+Vec3{std::cos(b)*std::cos(l),std::cos(b)*std::sin(l),std::sin(b)}*distance;
    const double analytic=arm_distance_kpc(unsigned(m[i+3]),p);
    analytic_residuals.push_back(analytic);analytic_max=std::max(analytic_max,analytic);analytic_squared+=analytic*analytic;
    const auto ridge=baked_arm_ridge(volumes->global,unsigned(m[i+3]),p);
    residuals.push_back(ridge.distance_kpc);
    if (!ridge.found) {++missing;continue;}
    maximum=std::max(maximum,ridge.distance_kpc);squared+=ridge.distance_kpc*ridge.distance_kpc;
    if (ridge.distance_kpc<=0.3) ++within;
  }
  const double count=residuals.size();
  wire::Result r;r.number("count",count);r.number("missing",missing);r.number("max",maximum,"kpc");
  r.number("rms",count>missing?std::sqrt(squared/(count-missing)):std::numeric_limits<double>::infinity(),"kpc");
  r.number("within_fraction",within/count);r.vector("residuals",residuals,"kpc");
  r.number("analytic_max",analytic_max,"kpc");r.number("analytic_rms",std::sqrt(analytic_squared/count),"kpc");
  r.vector("analytic_residuals",analytic_residuals,"kpc");
  const auto acceptance=reid_acceptance(m,segments,excluded,published,errors);
  r.vector("curve_max_errors",acceptance.curve_errors,"kpc");
  r.vector("arm_counts",acceptance.counts);r.vector("arm_rms",acceptance.rms,"kpc");
  r.vector("finite_segment_rms",acceptance.finite_rms,"kpc");
  r.vector("arm_chi2_nu",acceptance.chi2_nu);
  r.number("arm_chi2_limit",2.0);
  r.vector("perpendicular_measurement_sigma",acceptance.measurement_sigma,"kpc");
  r.text("uncertainty_method","first-order parallax propagation to closest-curve distance; mean d_perp^2/(Table2_width^2+sigma_perp^2)");
  r.vector("paper_frame_residuals",acceptance.residuals,"kpc");
  r.number("paper_exclusions",acceptance.excluded);
  r.text("measurement","local associated peak of baked G minus independently interpolated smooth background; unresolved peaks are failures");
  return r.emit();
}
