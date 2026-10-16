#include "conjunction/encounter_geometry.h"
#include "conjunction/conjunction_assessment.h"
#include <cmath>

namespace conjunction {
namespace pc_engine_detail {
std::array<double, 6> state_array(const StateVector& s) {
    return {s.x, s.y, s.z, s.vx, s.vy, s.vz};
}
StateVector state_vector(const std::array<double, 6>& s) {
    StateVector out{};
    out.x=s[0]; out.y=s[1]; out.z=s[2];
    out.vx=s[3]; out.vy=s[4]; out.vz=s[5];
    return out;
}
std::array<double, 36> inertial_covariance(const std::array<double, 21>& packed,
                                         const StateVector& state) {
    std::array<double, 36> matrix{}, out{};
    unsigned k = 0;
    for (int i=0; i<6; ++i) for (int j=0; j<=i; ++j,++k)
        matrix[6*i+j] = matrix[6*j+i] = packed[k];
    for (int bi=0; bi<2; ++bi) for (int bj=0; bj<2; ++bj) {
        Covariance3x3 block;
        for (int i=0; i<3; ++i) for (int j=0; j<3; ++j)
            block.data[3*i+j] = matrix[6*(3*bi+i)+3*bj+j];
        block = covariance_rtn_to_inertial(block,state);
        for (int i=0; i<3; ++i) for (int j=0; j<3; ++j)
            out[6*(3*bi+i)+3*bj+j] = block.data[3*i+j];
    }
    return out;
}
Covariance3x3 position_covariance(const std::array<double,36>& full) {
    Covariance3x3 out;
    for(int i=0;i<3;++i) for(int j=0;j<3;++j) out.data[3*i+j]=full[6*i+j];
    return out;
}
} // namespace pc_engine_detail

PcEncounter make_pc_encounter(const StateVector& a, const StateVector& b,
    const std::array<double, 21>& c1, const std::array<double, 21>& c2, double radius) {
    PcEncounter out;
    out.epoch_jd=a.epoch_jd;
    out.primary=pc_engine_detail::state_array(a);
    out.secondary=pc_engine_detail::state_array(b);
    out.covariance_primary=pc_engine_detail::inertial_covariance(c1,a);
    out.covariance_secondary=pc_engine_detail::inertial_covariance(c2,b);
    out.has_velocity_covariance=true;
    out.combined_radius=radius;
    return out;
}

ConjunctionEvent2 ConjunctionEngine::compute_pc(
    const StateVector& a, const StateVector& b, const Covariance3x3& c1,
    const Covariance3x3& c2, double radius) const {
    PcEncounter input;
    input.epoch_jd=a.epoch_jd;
    input.primary=pc_engine_detail::state_array(a);
    input.secondary=pc_engine_detail::state_array(b);
    input.combined_radius=radius;
    const auto i1=covariance_rtn_to_inertial(c1,a), i2=covariance_rtn_to_inertial(c2,b);
    for(int i=0;i<3;++i) for(int j=0;j<3;++j) {
        input.covariance_primary[6*i+j]=i1.data[3*i+j];
        input.covariance_secondary[6*i+j]=i2.data[3*i+j];
    }
    auto event=compute_pc(input);
    event.state1=a; event.state2=b;
    event.tca_jd=a.epoch_jd; event.tca_iso=jd_to_iso(a.epoch_jd);
    return event;
}

ConjunctionEvent2 ConjunctionEngine::compute_pc(const PcEncounter& encounter) const {
    auto event=evaluate_encounter(encounter);
    if(encounter.apply_cross_correlation && event.has_covariance) {
        PcEncounter independent=encounter;
        independent.apply_cross_correlation=false;
        const auto baseline=evaluate_encounter(independent);
        if(baseline.has_covariance)
            event.pc.decorrelation_probability_change=event.pc.probability-baseline.pc.probability;
    }
    return event;
}

ConjunctionEvent2 ConjunctionEngine::evaluate_encounter(const PcEncounter& input) const {
    ConjunctionEvent2 event;
    event.state1=pc_engine_detail::state_vector(input.primary);
    event.state2=pc_engine_detail::state_vector(input.secondary);
    event.state1.epoch_jd=event.state2.epoch_jd=input.epoch_jd;
    event.tca_jd=input.epoch_jd;
    if(input.epoch_jd>0)event.tca_iso=jd_to_iso(input.epoch_jd);
    event.cov1=pc_engine_detail::position_covariance(input.covariance_primary);
    event.cov2=pc_engine_detail::position_covariance(input.covariance_secondary);
    event.combined_radius_km=input.combined_radius;
    event.radius1_m=event.radius2_m=input.combined_radius*500;
    double dr[3],dv[3];
    for(int i=0;i<3;++i) { dr[i]=input.primary[i]-input.secondary[i]; dv[i]=input.primary[i+3]-input.secondary[i+3]; }
    event.miss_distance_km=std::hypot(dr[0],dr[1],dr[2]);
    event.relative_speed_kms=std::hypot(dv[0],dv[1],dv[2]);
    inertial_to_rtn(event.state1,event.state2,event.rel_r,event.rel_t,event.rel_n,
                    event.rel_vr,event.rel_vt,event.rel_vn);
    const auto combined=pc_engine_detail::position_covariance(relative_pc_covariance(input));
    const Covariance3x3 zero{};
    event.usage=assess_pc_usage(input);
    event.bplane=build_bplane(event.state1,event.state2,combined,zero,input.combined_radius);
    // Both dr and these covariances are inertial; never use input RTN blocks.
    event.mahalanobis_3d=encounter_mahalanobis_3d(dr,combined,zero);

    const auto relative=relative_pc_covariance(input);
    const bool zero_position_covariance=!(relative[0]+relative[7]+relative[14]>0);
    if(zero_position_covariance) {
        // Zero stated position uncertainty carries no covariance information;
        // CARA's NPD remediation must not turn it into a probability.
        event.pc.method="PC-UNAVAILABLE";
        event.pc.converged=false;
        event.pc.failure_reason="Collision probability calculation failed: relative position covariance is zero";
    } else if(event.usage.violated && event.usage.reason.rfind("INVALID_",0)==0) {
        // An unusable covariance is not a 2-D validity problem: no fallback may
        // turn it into a probability.
        event.pc.method="PC-UNAVAILABLE";
        event.pc.converged=false;
        event.pc.failure_reason="Collision probability calculation failed: unusable covariance (" + event.usage.reason + ")";
    } else if(event.usage.violated) {
        if(!input.has_velocity_covariance) {
            event.pc.method="PC-UNAVAILABLE";
            event.pc.converged=false;
            event.pc.failure_reason="Usage violation requires full position/velocity covariance: " + event.usage.reason;
        } else {
            PcFallbackResult fallback;
            if(fallback_==Fallback::MonteCarlo ||
               (fallback_==Fallback::Automatic &&
                (event.usage.low_relative_speed || event.usage.relative_velocity_uncertainty > 0.1 ||
                 event.usage.extended > 0.5 || event.usage.offset > 0.75)))
                fallback=pc_monte_carlo(input,fallback_options_);
            else if(fallback_==Fallback::TwoDimensionalNc)
                fallback=input.gravitational_parameter>0 ? pc_2d_nc_hall(input,fallback_options_)
                                                       : pc_2d_nc_cartesian(input,fallback_options_);
            else fallback=input.gravitational_parameter>0 ? pc_3d_nc_hall(input,fallback_options_)
                                                        : pc_3d_nc_cartesian(input,fallback_options_);
            if ((fallback.requires_monte_carlo ||
                 (fallback_==Fallback::Automatic && !fallback.pc.converged)) &&
                !fallback.invalid_inputs && fallback.samples==0) {
                const std::string reason=fallback.pc.failure_reason + "; " + fallback.limitation;
                fallback=pc_monte_carlo(input,fallback_options_);
                fallback.limitation="Nc unavailable (" + reason + "); " + fallback.limitation;
            }
            event.pc=fallback.pc;
            event.pc.sample_count=fallback.samples;
            event.pc.collision_count=fallback.hits;
            event.pc.initial_overlap_count=fallback.initial_hits;
            event.pc.entry_collision_count=fallback.entry_hits;
            event.pc.covariance_remediated |= fallback.covariance_repaired;
            if(!event.pc.converged && event.pc.failure_reason.empty())
                event.pc.failure_reason=fallback.limitation;
            if(!fallback.limitation.empty()) event.pc.usage_reason=fallback.limitation;
        }
    } else event.pc=pc_method_->compute(event.bplane);
    event.pc.covariance_remediated |= event.usage.covariance_repaired;
    event.pc.usage_checked=event.usage.fully_evaluated;
    event.pc.usage_violation=event.usage.violated;
    if(!event.usage.reason.empty())
        event.pc.usage_reason=event.usage.reason + (event.pc.usage_reason.empty()?"":"; "+event.pc.usage_reason);
    event.pc.cross_correlation_applied=input.apply_cross_correlation;
    event.mahalanobis_2d=event.pc.mahalanobis_2d;
    event.has_covariance=event.pc.converged && std::isfinite(event.pc.probability);
    if(!event.has_covariance) event.probability_failure=event.pc.failure_reason;
    return event;
}
} // namespace conjunction
