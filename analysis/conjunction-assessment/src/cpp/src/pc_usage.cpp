#include "conjunction/pc_usage.h"
#include "pc_math.h"
#include "pc_hall.h"

namespace conjunction {
using namespace pc_detail;
std::array<double,36> relative_pc_covariance(const PcEncounter& e) {
    M6 out{};
    for(int i=0;i<6;++i)for(int j=0;j<6;++j) {
        out[i*6+j]=e.covariance_primary[i*6+j]+e.covariance_secondary[i*6+j];
        if(e.apply_cross_correlation)out[i*6+j]-=e.cross_covariance[i*6+j]+e.cross_covariance[j*6+i];
    }
    return out;
}

PcUsageResult assess_pc_usage(const PcEncounter& e) {
    PcUsageResult out;
    auto flag=[&](const char* reason){out.violated=true;if(!out.reason.empty())out.reason+=';';out.reason+=reason;};
    auto c=relative_pc_covariance(e);M3 inv{};double det=0;
    out.cross_correlation_applied=e.apply_cross_correlation;
    if(e.apply_cross_correlation)for(int i=0;i<3;++i)out.covariance_trace_change-=2*e.cross_covariance[i*6+i];
    if(!(e.combined_radius>0)||!inverse_position(block(c),e.combined_radius,inv,det,out.covariance_repaired)){
        flag("INVALID_RELATIVE_COVARIANCE");return out;
    }
    V3 r=sub(position(e.secondary),position(e.primary)),v=sub(velocity(e.secondary),velocity(e.primary));
    const double speed=norm(v);
    if(!std::isfinite(speed)||speed<1e-10){
        out.low_relative_speed=true;out.extended=out.offset=1;
        out.time_sigma=std::numeric_limits<double>::infinity();
        flag("LOW_RELATIVE_SPEED");return out;
    }
    const double vav=dot(v,mul(inv,v)), rav=dot(r,mul(inv,v));
    out.time_center=-rav/vav;out.time_sigma=1/std::sqrt(vav);
    const double original_sigma=out.time_sigma,original_center=out.time_center;
    const double qrl=dot(r,mul(inv,r))-rav*rav/vav+std::log(det);
    // CARA UsageViolationPc2D.m, lines 354-370: gamma=1e-16 and
    // sqrt(2)*erfcinv(gamma), plus the stated 0.02 / 0.01 thresholds.
    constexpr double gaussian_extent=8.304785425194112;
    const double orbital_period=std::min(period(e.primary,e.gravitational_parameter),period(e.secondary,e.gravitational_parameter));
    std::array<double,3>ve{};M3 vectors{};
    if(e.has_velocity_covariance) {
        if(!eigen<3>(block(c,3,3),ve,vectors)){flag("INVALID_VELOCITY_COVARIANCE");return out;}
        double largest=std::max({0.0,ve[0],ve[1],ve[2]});
        if(std::min({ve[0],ve[1],ve[2]}) < -1e-10*largest){flag("INVALID_VELOCITY_COVARIANCE");return out;}
        out.relative_velocity_uncertainty=std::sqrt(largest)/speed;
    }
    bool curvature_ok=false;HallModel hall(e);
    auto qvalue=[&](double t,double& q,double& relative_speed) {
        V6 x{};M6 p{};M3 ai{};double ad=0;bool repaired=false;
        if(!(e.gravitational_parameter>0?hall.at(t,x,p,repaired):relative_at(e,t,false,x,p))||!inverse_position(block(p),e.combined_radius,ai,ad,repaired))return false;
        auto rr=position(x);q=dot(rr,mul(ai,rr))+std::log(ad);relative_speed=norm(velocity(x));
        out.covariance_repaired|=repaired;return std::isfinite(q);
    };
    // Three-point quadratic Q(t) refinement and equinoctial peak-overlap
    // propagation implement CARA's curvature diagnostic.
    if(e.gravitational_parameter>0) {
        double center=original_center,width=original_sigma,q=0,vs=0;
        for(int iter=0;iter<20;++iter) {
            double qm=0,qp=0,dummy=0;
            if(!qvalue(center,q,vs)||!qvalue(center-width,qm,dummy)||!qvalue(center+width,qp,dummy))break;
            double second=(qp-2*q+qm)/(width*width);
            if(!(second>0)) {flag("NONPOSITIVE_Q_CURVATURE");break;}
            double shift=-(qp-qm)/(2*width*second),sigma=std::sqrt(2/second);
            if(!std::isfinite(sigma)||std::abs(shift)>10*std::max(original_sigma,width))break;
            center+=shift;
            if(std::abs(shift)<1e-5*std::max(1.0,sigma)) {
                if(qvalue(center,q,vs)) {
                    out.time_center=center;out.time_sigma=sigma;
                    double logratio=std::log(sigma/original_sigma)+std::log(vs/speed)+(qrl-q)/2;
                    out.inaccurate=-std::expm1(-std::abs(logratio));curvature_ok=true;
                }
                break;
            }
            width=sigma;
        }
    } else curvature_ok=true;
    out.time_start=out.time_center-gaussian_extent*out.time_sigma;
    out.time_end=out.time_center+gaussian_extent*out.time_sigma;
    out.extended=std::min(1.0,(out.time_end-out.time_start)/orbital_period);
    out.offset=std::min(1.0,std::max(std::abs(out.time_start),std::abs(out.time_end))/orbital_period);
    if(out.extended>0.02)flag("EXTENDED_ENCOUNTER");
    if(out.offset>0.01)flag("OFFSET_ENCOUNTER");
    if(out.inaccurate>0.02)flag("CURVILINEAR_PC_CORRECTION");
    // Additional conservative diagnostic, explicitly distinct from CARA's
    // Q-derived indicators: a 1-sigma velocity spread reaches 10% of speed.
    if(out.relative_velocity_uncertainty>0.1)flag("RELATIVE_VELOCITY_UNCERTAINTY");
    if(!curvature_ok&&e.gravitational_parameter>0)flag("CURVATURE_ANALYSIS_UNCONVERGED");
    out.fully_evaluated=curvature_ok&&e.has_velocity_covariance;
    return out;
}
} // namespace conjunction
