// Independent closed-form frame/geometry cases: km, km/s, inertial XYZ at
// JD 2451545.0 (UTC for metadata only). Tolerances cover binary64 rotation
// and adaptive quadrature, not uncertain physical model inputs.
#include "conjunction/encounter_geometry.h"
#include <cstdio>
#include <cmath>

using namespace conjunction;
namespace {
int passed=0,failed=0;
void check(bool value,const char* message) {
    if(value) ++passed;
    else {++failed;std::printf("FAIL: %s\n",message);}
}
}
int main() {
    ConjunctionEngine engine;
    StateVector a{2451545.0,0,7000,0,-7.5,0,0};
    StateVector b{2451545.0,0,7000.1,0,-7.5,0,1};
    auto cov=Covariance3x3::from_rtn_diagonal(0.1,1,1);
    Covariance3x3 zero{};
    auto event=engine.compute_pc(a,b,cov,zero,.01);
    // R is inertial +Y and T is -X: Md=0.1/0.1=1; unrotated RTN gives .1.
    check(std::abs(event.mahalanobis_3d-1)<1e-10,"3D Mahalanobis rotates RTN covariance");
    check(std::abs(event.cov1.data[4]-.01)<1e-15,"radial variance lies on inertial Y");
    check(event.pc.method=="FOSTER-2D" && event.has_covariance,"integral remains ordinary encounter default");
    check(!event.pc.usage_checked,"position-only input reports incomplete velocity assessment");

    b.vz=0;
    auto low=engine.compute_pc(a,b,cov,zero,.01);
    check(low.usage.low_relative_speed && low.pc.usage_violation,"zero speed is flagged");
    check(!low.has_covariance && !low.pc.converged,"missing velocity covariance prevents a fabricated fallback");
    check(low.pc.method=="PC-UNAVAILABLE" && low.pc.usage_reason.find("LOW_RELATIVE_SPEED")!=std::string::npos,
          "unavailable event has method and reason");
    check(low.bplane.sigma_xx==0 && low.bplane.sigma_zz==0,"low speed never invents 1 m sigma");

    std::array<double,21> c1{},c2{};
    c1[0]=.01;c1[2]=1;c1[5]=1;c1[9]=1e-6;c1[14]=4e-6;c1[20]=9e-6;
    b.vz=1;
    auto encounter=make_pc_encounter(a,b,c1,c2,.01);
    check(encounter.has_velocity_covariance && std::abs(encounter.covariance_primary[28]-1e-6)<1e-18,
          "full velocity block rotates in the same frame as position");

    // Rectilinear, isotropic relative covariance: Pc=1-exp(-R^2/(2*sigma^2)).
    // Optional C12 halves relative variance (C1=C2=.01I, C12=.005I).
    PcEncounter direct;
    direct.primary={7000,0,0,0,0,0};direct.secondary={7000,0,0,0,1,0};
    direct.gravitational_parameter=0; direct.combined_radius=.1;
    direct.has_velocity_covariance=true;
    for(int i=0;i<3;++i) {
        direct.covariance_primary[i*6+i]=.01;
        direct.covariance_secondary[i*6+i]=.01;
        direct.cross_covariance[i*6+i]=.005;
    }
    auto independent=engine.compute_pc(direct);
    check(independent.has_covariance && !independent.pc.cross_correlation_applied,"decorrelation off by default");
    check(std::abs(independent.pc.probability+std::expm1(-.25))<1e-12,"independent Gaussian disk closed form");
    direct.apply_cross_correlation=true;
    auto correlated=engine.compute_pc(direct);
    check(correlated.has_covariance && correlated.pc.cross_correlation_applied,"decorrelation explicitly applied");
    check(std::abs(correlated.pc.probability+std::expm1(-.5))<1e-12,"cross-covariance Gaussian disk closed form");
    check(std::abs(correlated.pc.decorrelation_probability_change-(correlated.pc.probability-independent.pc.probability))<1e-14,
          "decorrelation reports probability change");

    // In a finite +/-1 s linear window, exactly zero relative motion with
    // nonzero velocity uncertainty requires MC. A fixed seed is reproducible.
    direct.apply_cross_correlation=false;direct.secondary[4]=0;
    direct.covariance_secondary[28]=.01;
    PcFallbackOptions options; options.time_start=-1;options.time_end=1;
    options.samples=4096;options.seed=17;options.two_body=false;
    engine.set_pc_fallback(ConjunctionEngine::Fallback::MonteCarlo,options);
    auto sampled=engine.compute_pc(direct), again=engine.compute_pc(direct);
    check(sampled.pc.method.find("MC")!=std::string::npos && sampled.pc.usage_violation,"violating full-state event routed to MC");
    check(sampled.has_covariance && sampled.pc.probability==again.pc.probability,"seeded fallback deterministic");
    check(sampled.pc.upper_probability>sampled.pc.lower_probability,"MC reports sampling interval");
    // A zero stated position covariance is unusable, never remediated into Pc.
    PcEncounter nothing=direct;
    for(int i=0;i<36;++i) nothing.covariance_primary[i]=nothing.covariance_secondary[i]=0;
    nothing.secondary[4]=1;
    auto unusable=engine.compute_pc(nothing);
    check(!unusable.has_covariance && unusable.pc.method=="PC-UNAVAILABLE" &&
          unusable.probability_failure.find("covariance is zero")!=std::string::npos,
          "zero position covariance yields no probability");
    std::printf("Engine assertions: %d passed, %d failed\n",passed,failed);
    return failed?1:0;
}
