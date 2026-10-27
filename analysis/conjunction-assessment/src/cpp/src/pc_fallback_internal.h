#ifndef CONJUNCTION_PC_FALLBACK_INTERNAL_H
#define CONJUNCTION_PC_FALLBACK_INTERNAL_H
#include "conjunction/pc_fallbacks.h"
#include "pc_math.h"
#include <utility>

namespace conjunction::pc_detail {
inline bool valid_encounter(const PcEncounter& e,const PcFallbackOptions& opt) {
    for(double v:e.primary)if(!std::isfinite(v))return false;
    for(double v:e.secondary)if(!std::isfinite(v))return false;
    for(double v:e.covariance_primary)if(!std::isfinite(v))return false;
    for(double v:e.covariance_secondary)if(!std::isfinite(v))return false;
    if(e.apply_cross_correlation)for(double v:e.cross_covariance)if(!std::isfinite(v))return false;
    return std::isfinite(e.combined_radius)&&e.combined_radius>0&&
        std::isfinite(e.gravitational_parameter)&&e.gravitational_parameter>=0&&
        std::isfinite(opt.time_start)&&std::isfinite(opt.time_end)&&
        ((opt.time_start==0&&opt.time_end==0)||opt.time_end>opt.time_start)&&
        std::isfinite(opt.relative_tolerance)&&opt.relative_tolerance>0;
}
inline std::pair<double,double> time_bounds(const PcEncounter& e,const PcFallbackOptions& opt,const PcUsageResult& usage) {
    if(opt.time_end>opt.time_start)return {opt.time_start,opt.time_end};
    double p=std::min(period(e.primary,e.gravitational_parameter),period(e.secondary,e.gravitational_parameter));
    double limit=std::isfinite(p)?p/2:3600;
    if(usage.fully_evaluated&&std::isfinite(usage.time_sigma)&&usage.time_sigma>0) {
        // Include travel through the finite collision sphere, which CARA's
        // small-HBR usage-duration formula intentionally omits.
        double speed=norm(sub(velocity(e.secondary),velocity(e.primary)));
        double pad=e.combined_radius/std::max(speed,1e-10);
        // Do not silently truncate a long or offset encounter to a fraction
        // of an orbit: that would hide precisely the usage violations for
        // which the fallback is needed. Numerical work limits fail closed.
        return {usage.time_start-pad,usage.time_end+pad};
    }
    return {-limit,limit};
}
inline double inward_speed(double mean,double variance) {
    if(!(variance>0))return std::max(0.0,-mean);
    double sigma=std::sqrt(variance),z=mean/sigma;
    // E[max(0,-V)] for V~N(mean,variance), Coppola (2012), equation 36.
    double result=sigma/std::sqrt(2*pi)*std::exp(-0.5*z*z)-0.5*mean*std::erfc(z/std::sqrt(2.0));
    return std::max(0.0,result);
}
} // namespace conjunction::pc_detail
#endif
