#pragma once
#include "literature_model.hpp"
#include "statistical_stars.hpp"
#include "oracle_metrics.hpp"
#include "ridge_metrics.hpp"
#include "reid_acceptance.hpp"
#include "component_diagnostics.hpp"
#include "face_on.hpp"
#include "dust_rows.hpp"

namespace milky_way {
std::unique_ptr<Volume> detail;
std::vector<float> last_sky,last_flux,last_face_on;
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
  // The only values a bake takes: overrides of the appearance table (the
  // SDSS analog fit's trials), each within its fit bounds.
  struct Override {const char* name;double* value;double lo,hi;};
  const Override overrides[]={{"appearance_young_length_kpc",&appearance::young_length_kpc,1.0,12.0},
    {"appearance_central_light",&appearance::central_light,0.2,3.0},{"appearance_bulge_size",&appearance::bulge_size,0.2,3.0},
    {"appearance_bulge_height",&appearance::bulge_height,0.2,3.0},{"appearance_arm_dust",&drimmel2001::arm_dust_scale,0.1,30.0},
    {"appearance_structure_young_sigma",&structure::young_sigma,0.0,3.0},{"appearance_structure_dust_sigma",&structure::dust_sigma,0.0,3.0},
    {"appearance_structure_lane_sigma",&structure::lane_sigma,0.0,3.0},
    {"appearance_structure_fade_inner",&structure::fade_inner_kpc,0.0,4.0},{"appearance_structure_fade_outer",&structure::fade_outer_kpc,0.1,6.0},
    {"display_basis",&eye::basis,0.0,1.0},{"look_good",&look::on,0.0,1.0}};
  eye::basis=0;look::on=0;
  for (const auto& [name,value]:request.values) {
    const auto* o=std::find_if(std::begin(overrides),std::end(overrides),[&](const Override& x){return name==x.name;});
    const double v=request.number(name.c_str(),NAN);
    if (o==std::end(overrides) || !std::isfinite(v) || v<o->lo || v>o->hi)
      return wire::fail("bake takes only appearance_* overrides within their fit bounds, display_basis (0 SDSS r,g,i; 1 CIE X,Y,Z) and look_good (0 TRUE PHYSICS; 1 LOOK GOOD); deliver a 3D dust map with load_dust_map first");
    *o->value=v;
  }
  const auto& loaded=dust_map::grid();
  if (loaded.nz && !loaded.ready) return wire::fail("A 3D dust map is partly loaded; deliver every plane or none");
  volumes=std::make_unique<NestedVolumes>(sun);
  volumes->bake([](Vec3 p){return literature(p,false);},[](Vec3 p){return literature(p,true);});legacy_active=false;
  // SplitMix64 seed 20261016; periodic texture samples, dimensionless model
  // noise. No inference of observed dust structure from this procedural tile.
  detail=std::make_unique<Volume>(32,32,32,Vec3{0,0,0},Vec3{1,1,1});
  uint64_t seed=20261016;
  for (auto& v:detail->rgba) v=to_half(float(random_uniform(seed)));
  wire::Result r;volume_result(r,"global",volumes->global);volume_result(r,"slab",volumes->slab);
  volume_result(r,"local",volumes->local);volume_result(r,"noise",*detail);r.text("label","model");r.text("noise_label","model");
  r.text("channels",eye::on()?"CIE Y,Z,X relative emissivity per kpc (eye); G extinction optical depth per kpc"
    :"SDSS r,g,i relative emissivity per kpc; G extinction optical depth per kpc");
  r.text("display_basis",eye::on()?"eye":"sdss");
  r.text("frame","Galactocentric origin; +x Galactic l=0, +y l=90, +z NGP; static J2000 orientation");
  r.text("calibration",loaded.ready
    ?"Local 3D dust map inside its coverage, Drimmel & Spergel 2001 disk, arm dust and local segment beyond; spiral light from DS2001 B_K and Flynn 2006; independent of Gaia"
    :"Drimmel & Spergel 2001 disk, separate arm dust and local segment; spiral light from DS2001 B_K and Flynn 2006; independent of Gaia");
  r.text("dust_map",loaded.ready?(loaded.dataset+": "+loaded.source+"; "+loaded.license).c_str():"none");
  r.number("dust_map_radius",loaded.ready?loaded.radius:0,"kpc");
  r.vector("sun",{sun.x,sun.y,sun.z},"kpc");
  // The bar as the model draws it (bulge_bar_shapes): its angle from the
  // Sun-centre line, the near end toward positive longitude (Wegg & Gerhard
  // 2013), its half-length (the long bar, Wegg, Gerhard & Portail 2015), and
  // the near end's unit vector in the Galactocentric frame.
  r.number("bar_angle_deg",model_choices::bar_angle_rad/galactic_constants::radians_per_degree,"deg from the Sun-centre line, near end at l > 0 (Wegg & Gerhard 2013)");
  r.number("bar_half_length_kpc",model_choices::bar_half_length_kpc,"kpc (Wegg, Gerhard & Portail 2015 long bar)");
  r.vector("bar_near_end_axis",{-std::cos(model_choices::bar_angle_rad),std::sin(model_choices::bar_angle_rad),0.0},"Galactocentric unit vector");
  r.text("display_mode",look::active()?"beauty":"physical");
  r.vector("look_good_gains",{look::young_gain(),look::hii_gain(),look::active()?look::hii_saturation:1.0,look::major_arm_gain(),look::disc_display()},
    "young gain, HII gain, HII saturation, major-arm wave gain, eye display luminance of the solar-circle disc (look.hpp)");
  r.number("look_good_softening",look::softening(display::q),"asinh Q of the eye display");
  r.vector("appearance",{appearance::young_length_kpc,appearance::central_light,appearance::bulge_size,appearance::bulge_height},
    "young length kpc, central light, bulge size, bulge height (fitted to SDSS MW analogs, Licquia 2015)");
  // Renderer fields. Each light channel's optical depth per kpc is this
  // multiple of the G optical depth channel (Wang & Chen 2019 Table 3).
  const double* ratios=model_choices::channel_ratios();
  r.vector("extinction_ratios",{ratios[0],ratios[1],ratios[2]},eye::on()?"A_Y/A_G,A_Z/A_G,A_X/A_G (CCM89)":"A_r/A_G,A_g/A_G,A_i/A_G");
  // One unit of each band (emissivity per kpc x kpc) in physical units: the
  // model's own local mid-plane G emissivity carries Flynn et al. 2006's
  // 0.056 Lsun,V pc^-3; a band unit is the G unit's light at zero color term
  // (stellar_populations.hpp, sdss), so all three share its zero point.
  const double local=literature_g({-galactic_constants::solar_radius_kpc,0,0});
  const double column=populations::unit_column_lsun_v_pc2/local;
  const double mu_g=populations::sun_absolute_v+21.572-2.5*std::log10(column)+populations::g_minus_v_local();
  r.number("radiance_scale",std::pow(10.0,-0.4*mu_g),"G=0 (Vega) flux arcsec^-2");
  r.number("radiance_scale_mag_arcsec2",mu_g,"mag_G arcsec^-2 = mag_r, mag_g, mag_i (AB) arcsec^-2 per band unit");
  r.number("radiance_scale_lsun_v_pc2",column,"Lsun,V pc^-2");
  r.text("radiance_scale_basis","Flynn et al. 2006 Table 4 local V luminosity density 0.056 Lsun pc^-3 at the model's local mid-plane G emissivity; M_V,sun=4.81 (Willmer 2018); G-V of (V-I)=0.82 by Gaia EDR3 Table 5.7; SDSS g, r, i by Riello et al. 2021 Table C.2");
  // The display (stellar_populations.hpp, display): the SDSS ImgCutout
  // transfer, Lupton et al. (2004) asinh stretch of the r, g, i light in
  // band-weighted SDSS counts, then a gamma.
  const auto counts=display::counts_per_unit(mu_g);
  // The eye: the same stretch on the luminance, no desaturation (the
  // chromaticity kept), one count scale for X, Y and Z (eye_color.hpp).
  const double eye_counts=eye::counts_per_unit(counts);
  // The eye's exposure (0.5): alpha such that the face-on disc at the solar
  // circle (the median of 24 columns at R0, the model's own light and dust)
  // shows at the display luminance look::disc_display() through the stretch
  // and gamma; the SDSS transfer keeps its fitted alpha (the checks').
  double alpha=display::alpha_per_count;
  if(eye::on()) {
    std::vector<double> ys;
    for(int k=0;k<24;++k) {
      const double phi=2*galactic_constants::pi*k/24,x=galactic_constants::solar_radius_kpc*std::cos(phi),y=galactic_constants::solar_radius_kpc*std::sin(phi);
      double light=0,transmit=1;
      const double* ratios=model_choices::channel_ratios();
      for(double z=1.5;z>-1.5;) {
        const double dz=std::abs(z)<0.6?0.005:0.05,zm=z-dz/2;
        const Field f=literature({x,y,zm});const double kb=std::max(0.0,f.kappa)*ratios[0],tau=kb*dz;
        light+=transmit*std::max(0.0,f.r)*(tau>1e-10?-std::expm1(-tau)/kb:dz);transmit*=std::exp(-tau);z-=dz;
      }
      ys.push_back(light);
    }
    std::nth_element(ys.begin(),ys.begin()+12,ys.end());
    const double q=look::softening(display::q);
    const double intensity=ys[12]*eye_counts,stretched=std::pow(look::disc_display(),1/display::gamma);
    alpha=std::sinh(q*stretched)/(q*intensity);
  }
  r.vector("display_asinh",{eye::on()?look::softening(display::q):display::q,alpha,display::gamma,eye::on()?1.0:display::saturation},"Q,alpha per count,gamma,saturation");
  if(eye::on()) r.vector("display_counts_per_unit",{eye_counts,eye_counts,eye_counts},"SDSS-transfer counts per 0.396 arcsec pixel per Y,Z,X unit (the old disc's luminance at its SDSS intensity)");
  else r.vector("display_counts_per_unit",{counts[0],counts[1],counts[2]},"weighted SDSS counts per 0.396 arcsec pixel per r,g,i unit");
  r.vector("display_band_weights",{display::weights[0],display::weights[1],display::weights[2]},"r,g,i");
  // The dust structure's sub-slab octaves (structure.hpp, detail), for the
  // renderer to continue below the slab's texels: the ridged field's
  // standard deviation, the shear's elongation, the dust sigma, the Sun's
  // (x, y) and the fade's radii about it (kpc), then per octave its
  // wavelength (kpc), amplitude, mean, variance, seed (high and low 16 bits:
  // a float holds neither whole) and phase.
  {
    std::vector<double> v{structure::moments(true)[1],structure::elongation,structure::dust_sigma,
      -galactic_constants::solar_radius_kpc,0.0,structure::fade_inner_kpc,structure::fade_outer_kpc};
    for(const auto& o:structure::detail()) {
      const uint32_t s=uint32_t(o.seed);
      v.insert(v.end(),{o.lambda,o.amplitude,o.mean,o.variance,double(s>>16),double(s&0xffffu),o.phase});
    }
    r.vector("structure_detail",v,"std,elongation,dust sigma,sun x,sun y,fade inner,fade outer kpc; per octave lambda kpc,amplitude,mean,variance,seed hi16,seed lo16,phase");
    // The young light's share of the same octaves (the plain, not ridged,
    // term: structure::field(.., false)): its field's standard deviation and
    // sigma, per octave the plain term's mean and variance; and the baked
    // channels of one unit of young light and of the old disc's, so a
    // renderer can tell a sample's young light from the rest.
    const auto& e=eye::bands();const bool eye_on=eye::on();
    const sdss::Bands& yb=eye_on?e.young:colors::young_bands;const sdss::Bands& db=eye_on?e.disc:colors::disc_bands;
    std::vector<double> y{structure::moments(false)[1],structure::young_sigma};
    for(const auto& o:structure::detail()) y.insert(y.end(),{o.smooth_mean,o.smooth_variance});
    y.insert(y.end(),{yb.r,yb.g,yb.i,db.r,db.g,db.i});
    r.vector("structure_detail_young",y,"std,young sigma; per octave plain mean,variance; young light channels 0-2; old disc channels 0-2");
  }
  r.vector("display_nanomaggies_per_count",{display::nanomaggies_per_count[0],display::nanomaggies_per_count[1],
    display::nanomaggies_per_count[2]},"nanomaggies per SDSS count, r,g,i");
  r.text("display_asinh_basis",display::basis);
  return r.emit();
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
  // Keep the method ID so old callers receive an explicit failure; the run-four
  // production model must never mutate its dust using the acceptance oracle.
  return milky_way::wire::fail("Gaia dust calibration retired by run-four decision; use literature bake");
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

extern "C" int face_on_metrics() {
  using namespace milky_way;
  wire::Request request;
  if (!request.ok || !model_ready()) return wire::fail("Bake the literature model first");
  auto f=milky_way::face_on(*volumes);
  if (!f.valid) return wire::fail("Face-on image has too few disc pixels, arm crossings or light");
  last_face_on=std::move(f.rgb);
  wire::Result r;
  r.vector("face_on_layout",{double(reinterpret_cast<uintptr_t>(last_face_on.data())),double(last_face_on.size()*4),
    double(FaceOnReport::size),double(FaceOnReport::size),3,1,4},"byte-layout");
  r.vector("face_on_extent",{-FaceOnReport::half_extent_kpc,-FaceOnReport::half_extent_kpc,
    FaceOnReport::half_extent_kpc,FaceOnReport::half_extent_kpc},"kpc");
  r.number("camera_height",FaceOnReport::camera_kpc,"kpc");
  r.number("arm_contrast",f.arm_contrast);
  r.number("arm_contrast_mag",f.arm_contrast>0?2.5*std::log10(f.arm_contrast):0,"mag");
  r.vector("arm_crossings",f.crossings_deg,"deg");
  r.vector("arm_crossing_contrasts",f.crossing_contrasts);
  r.number("arc_max_over_min",f.arc_max_over_min);
  r.vector("arc_profile",f.arc_profile,"G units");
  r.number("bar_a2",f.bar_a2);r.number("bar_phase",f.bar_phase_deg,"deg");
  r.number("bar_expected_phase",f.bar_expected_deg,"deg");
  r.number("lane_g_i",f.lane_color,"mag");r.number("disc_g_i",f.disc_color,"mag");
  r.number("lane_reddening",f.lane_color-f.disc_color,"mag");
  r.number("lane_pixels",double(f.lane_pixels));r.number("disc_pixels",double(f.disc_pixels));
  r.number("lane_tau_threshold",f.lane_tau_threshold);
  r.text("method","face-on from 48 kpc, 0.125-kpc pixels; arm contrast 2 I_arm/(I_inter1+I_inter2) on the R0 azimuthal scan at drifted major-arm crossings (Elmegreen et al. 2011); bar m=2 amplitude over 1.5-4.5 kpc; lanes = most opaque tenth of 3-12 kpc");
  return r.emit();
}

extern "C" int load_dust_map() {
  using namespace milky_way;
  const auto loaded=dust_rows::load();
  if (loaded.error) return wire::fail(loaded.error);
  wire::Result r;
  const auto& g=dust_map::grid();
  r.number("planes_loaded",g.loaded);r.number("planes",g.nz);r.number("ready",g.ready?1:0);
  r.text("dataset",g.dataset.c_str());r.number("rows",loaded.rows);
  return r.emit();
}

// The arm curves the model draws: each Reid et al. (2019) Table 2 segment as a
// polyline in the Galactocentric plane (kpc, x then y), over its measured
// parallax coverage (beta_min..beta_max) and over the domain the light uses
// (reid_arms.hpp, arm_light). Needs no bake.
extern "C" int arm_curves() {
  using namespace milky_way;
  wire::Request request;
  if (!request.ok) return wire::fail("Expected one $PCE request");
  wire::Result r;
  r.number("arm_count",double(reid_segments.size()));
  auto polyline=[](const ArmSegment& a,double lo,double hi) {
    std::vector<double> xy;
    const int n=std::max(2,int(std::ceil((hi-lo)/(0.5*galactic_constants::radians_per_degree))));
    for (int i=0;i<=n;++i) {
      const double beta=lo+(hi-lo)*i/n,radius=arm_radius_kpc(a,beta);
      xy.push_back(-radius*std::cos(beta));xy.push_back(radius*std::sin(beta));
    }
    return xy;
  };
  for (size_t i=0;i<reid_segments.size();++i) {
    const auto& a=reid_segments[i];
    const std::string p="arm_"+std::to_string(i);
    r.text((p+"_name").c_str(),a.name);
    r.vector((p+"_measured_xy").c_str(),polyline(a,a.beta_min_deg*galactic_constants::radians_per_degree,
      a.beta_max_deg*galactic_constants::radians_per_degree),"kpc");
    std::vector<double> drawn;
    const auto light=arm_light::domain(a);
    const int n=std::max(2,int(std::ceil((light[1]-light[0])/(0.5*galactic_constants::radians_per_degree))));
    for (int k=0;k<=n;++k) {
      const double beta=light[0]+(light[1]-light[0])*k/n,radius=arm_light::radius(a,beta);
      drawn.push_back(-radius*std::cos(beta));drawn.push_back(radius*std::sin(beta));
    }
    r.vector((p+"_extended_xy").c_str(),drawn,"kpc");
  }
  r.text("source","Reid et al. 2019, ApJ 885, 131, Table 2 (central values)");
  return r.emit();
}

// The model's own face-on light: at each (x, y) the r, g and i radiance of a
// vertical column from z = +6 to -6 kpc, integrated from the model itself
// (literature(), no baked volume) as the renderer integrates a ray: per step
// light gained T j (1 - e^-tau) / tau, transmittance falling by e^-tau, each
// band with its extinction ratio to G; 5 pc steps within 0.6 kpc of the
// plane, 50 pc beyond. The reference the renderer's face-on frames are
// measured against (how much of a profile's width is the model's).
extern "C" int face_on_columns() {
  using namespace milky_way;
  wire::Request request;const auto p=request.vector("points");
  if (!request.ok || p.empty() || p.size()%2 || p.size()>40000 || !finite_vector(p))
    return wire::fail("Expected 1..20000 finite Galactocentric (x, y) points in kpc");
  if (std::any_of(p.begin(),p.end(),[](double v){return std::abs(v)>24;})) return wire::fail("Point outside the 24 kpc disc");
  std::vector<double> out[3],tau_g;
  const double* ratios=model_choices::channel_ratios();
  for (size_t k=0;k<p.size();k+=2) {
    double light[3]={0,0,0},transmit[3]={1,1,1},column=0;
    for (double z=6.0;z>-6.0;) {
      const double dz=std::min(z+6.0,std::abs(z)<0.6?0.005:0.05),zm=z-dz/2;
      const Field f=literature({p[k],p[k+1],zm});
      const double emission[3]={std::max(0.0,f.r),std::max(0.0,f.g),std::max(0.0,f.b)},kappa=std::max(0.0,f.kappa);
      column+=kappa*dz;
      for (int b=0;b<3;++b) {
        const double kb=kappa*ratios[b],tau=kb*dz;
        light[b]+=transmit[b]*emission[b]*(tau>1e-10?-std::expm1(-tau)/kb:dz);
        transmit[b]*=std::exp(-tau);
      }
      z-=dz;
    }
    for (int b=0;b<3;++b) out[b].push_back(light[b]);
    tau_g.push_back(column);
  }
  wire::Result r;r.vector("r",out[0],"band units");r.vector("g",out[1],"band units");r.vector("i",out[2],"band units");
  r.vector("tau_g",tau_g,"the vertical column's G optical depth");
  r.number("a_i_per_tau_g",2.5*std::log10(std::exp(1.0))*sdss::i_per_big_g_extinction,"A_i (mag) per unit tau_G (Wang & Chen 2019)");
  r.text("method","vertical columns of literature() with dust, 5 pc steps within 0.6 kpc of the plane, 50 pc beyond");
  return r.emit();
}

// The HII regions as built (literature_model.hpp, hii): each region's
// luminosity draw (the luminosity function's L, L_min = 1) and Gaussian
// sigma (kpc), for the luminosity function and size checks.
extern "C" int hii_population() {
  using namespace milky_way;
  const auto& pop=hii::population();
  std::vector<double> l,s;
  for(const auto& k:pop.knots) {l.push_back(k.luminosity);s.push_back(k.sigma);}
  wire::Result r;r.vector("luminosity",l,"L / L_min");r.vector("sigma_kpc",s,"kpc");
  r.number("count",double(pop.knots.size()),"regions");
  r.text("basis","dN/dL ~ L^-2 over 1-100 (Kennicutt, Edgar & Hodge 1989); sigma = 30 pc (L/L_min)^(1/3), at most 140 pc (Stromgren 1939)");
  return r.emit();
}
