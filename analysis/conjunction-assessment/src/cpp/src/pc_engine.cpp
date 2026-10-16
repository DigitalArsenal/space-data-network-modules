#include "conjunction/encounter_geometry.h"
#include "conjunction/conjunction_assessment.h"
#include "conjunction/pc_maximum.h"
#include "conjunction/error_status.h"
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#ifndef CONJUNCTION_SINGLE_THREAD
#include <thread>
#endif

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
PcFallbackOptions event_options(const PcEncounter& input, const PcFallbackOptions& options) {
    auto out=options;
    // Hash the encounter's IEEE-754 values, not an index or worker identity.
    // The same event therefore uses the same samples in serial, reordered,
    // and parallel batches. Explicit low-level MC APIs retain their raw seed.
    auto add=[&](double value) {
        std::uint64_t bits=0;
        std::memcpy(&bits,&value,sizeof(bits));
        out.seed^=bits+0x9e3779b97f4a7c15ULL+(out.seed<<6)+(out.seed>>2);
    };
    add(input.epoch_jd);add(input.combined_radius);add(input.gravitational_parameter);
    for(double value:input.primary)add(value);
    for(double value:input.secondary)add(value);
    for(double value:input.covariance_primary)add(value);
    for(double value:input.covariance_secondary)add(value);
    if(input.apply_cross_correlation)for(double value:input.cross_covariance)add(value);
    return out;
}
PcFallbackOptions grade_options(const PcFallbackOptions& configured, PcGrade grade,
    bool explicit_sample_budget) {
    auto options=configured;
    options.grade=grade;
    if(grade==PcGrade::Screening) {
        options.relative_tolerance=1e-2;
        options.angular_order=8;
        options.time_intervals=16;
        if(!explicit_sample_budget)options.samples=kDefaultScreeningPcSampleCap;
    }
    return options;
}
PcFallbackResult evaluate_fallback(const PcEncounter& input,
    const PcUsageResult& usage, ConjunctionEngine::Fallback policy, bool direct_monte_carlo,
    const PcFallbackOptions& configured_options) {
    const auto options=event_options(input,configured_options);
    const auto* prepared_usage=(usage.fully_evaluated ||
        (options.grade==PcGrade::Screening && !usage.curvature_skipped)) ? &usage : nullptr;
    PcFallbackResult fallback;
    if(policy==ConjunctionEngine::Fallback::MonteCarlo || direct_monte_carlo)
        fallback=pc_monte_carlo(input,options,prepared_usage);
    else if(policy==ConjunctionEngine::Fallback::TwoDimensionalNc)
        fallback=input.gravitational_parameter>0 ? pc_2d_nc_hall(input,options,prepared_usage)
                                               : pc_2d_nc_cartesian(input,options,prepared_usage);
    else fallback=input.gravitational_parameter>0 ? pc_3d_nc_hall(input,options,prepared_usage)
                                                : pc_3d_nc_cartesian(input,options,prepared_usage);
    if((fallback.requires_monte_carlo ||
        (policy==ConjunctionEngine::Fallback::Automatic && !fallback.pc.converged)) &&
       !fallback.invalid_inputs && fallback.samples==0) {
        const std::string reason=fallback.pc.failure_reason + "; " + fallback.limitation;
        fallback=pc_monte_carlo(input,options,&fallback.usage);
        fallback.limitation="Nc unavailable (" + reason + "); " + fallback.limitation;
    }
    return fallback;
}
PcResult fallback_probability(const PcFallbackResult& fallback) {
    auto pc=fallback.pc;
    pc.sample_count=fallback.samples;
    pc.collision_count=fallback.hits;
    pc.initial_overlap_count=fallback.initial_hits;
    pc.entry_collision_count=fallback.entry_hits;
    pc.covariance_remediated|=fallback.covariance_repaired;
    if(!pc.converged && pc.failure_reason.empty())pc.failure_reason=fallback.limitation;
    if(!fallback.limitation.empty())pc.usage_reason=fallback.limitation;
    return pc;
}
PcResult unavailable(const std::string& reason) {
    PcResult pc;
    pc.method="PC-UNAVAILABLE";
    pc.converged=false;
    pc.failure_reason=reason;
    return pc;
}
bool usable_probability(const PcResult& pc) {
    return pc.converged && std::isfinite(pc.probability) &&
        pc.probability>=0 && pc.probability<=1;
}
bool finite_encounter(const PcEncounter& input) {
    if(!std::isfinite(input.epoch_jd) || !std::isfinite(input.combined_radius) ||
       !std::isfinite(input.gravitational_parameter))return false;
    for(double value:input.primary)if(!std::isfinite(value))return false;
    for(double value:input.secondary)if(!std::isfinite(value))return false;
    for(double value:input.covariance_primary)if(!std::isfinite(value))return false;
    for(double value:input.covariance_secondary)if(!std::isfinite(value))return false;
    if(input.apply_cross_correlation)
        for(double value:input.cross_covariance)if(!std::isfinite(value))return false;
    return true;
}
std::string usage_reason(const PcUsageResult& usage) {
    if(!usage.violated)return usage.reason;
    char quantities[256];
    std::snprintf(quantities,sizeof(quantities),
        "; low_relative_speed=%s; relative_velocity_uncertainty=%.9g; duration/period=%.9g; offset/period=%.9g",
        usage.low_relative_speed?"true":"false",usage.relative_velocity_uncertainty,
        usage.extended,usage.offset);
    return usage.reason+quantities;
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

bool ConjunctionEngine::set_pc_tier_options(const PcTierOptions& options) {
    if(!std::isfinite(options.reporting_floor) || !std::isfinite(options.monte_carlo_floor) ||
       options.reporting_floor<0 || options.reporting_floor>1 ||
       options.reporting_floor>options.monte_carlo_floor)return false;
    tier_options_=options;
    return true;
}

std::vector<ConjunctionEvent2> ConjunctionEngine::compute_pc_batch(
    const std::vector<PcEncounter>& encounters, unsigned threads) const {
    std::vector<ConjunctionEvent2> results(encounters.size());
    if(encounters.empty())return results;
    std::atomic<size_t> next{0};
    auto work=[&] {
        // Keep the caller's status intact, but isolate each event's failure so
        // it cannot poison another event or disappear on a worker thread.
        const std::string previous_error=error_message();
        for(size_t index=next.fetch_add(1);index<encounters.size();index=next.fetch_add(1)) {
            clear_error();
            auto event=compute_pc(encounters[index]);
            if(has_error()) {
                event.has_covariance=false;
                event.pc.method="PC-UNAVAILABLE";
                event.pc.converged=false;
                event.pc.failure_reason=error_message();
                event.probability_failure=event.pc.failure_reason;
            }
            results[index]=std::move(event);
        }
        clear_error();
        if(!previous_error.empty())set_error(previous_error);
    };
#ifndef CONJUNCTION_SINGLE_THREAD
    const size_t worker_count=std::min(encounters.size(),static_cast<size_t>(std::max(1u,threads)));
    std::vector<std::thread> workers;
    workers.reserve(worker_count-1);
    for(size_t worker=1;worker<worker_count;++worker)workers.emplace_back(work);
    work();
    for(auto& worker:workers)worker.join();
#else
    (void)threads;
    work();
#endif
    return results;
}

ConjunctionEvent2 ConjunctionEngine::evaluate_encounter(const PcEncounter& input) const {
    ConjunctionEvent2 event;
    event.state1=pc_engine_detail::state_vector(input.primary);
    event.state2=pc_engine_detail::state_vector(input.secondary);
    event.state1.epoch_jd=event.state2.epoch_jd=input.epoch_jd;
    event.tca_jd=input.epoch_jd;
    // Validate every supplied covariance block even when the tier gate will
    // avoid a full-state fallback. The 2D projection alone cannot see invalid
    // position/velocity cross terms. Finite NPD position repair is unchanged.
    if(!pc_engine_detail::finite_encounter(input) || input.gravitational_parameter<0) {
        event.pc=pc_engine_detail::unavailable(
            "Collision probability calculation failed: invalid encounter state or covariance");
        event.usage.violated=event.pc.usage_violation=true;
        event.usage.reason=event.pc.usage_reason="INVALID_ENCOUNTER";
        if(pc_grade_==PcGrade::Screening)event.pc.usage_reason+="; grade=Screening; invalid encounter";
        event.probability_failure=event.pc.failure_reason;
        return event;
    }
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
    const auto relative=relative_pc_covariance(input);
    const auto combined=pc_engine_detail::position_covariance(relative);
    const Covariance3x3 zero{};
    event.usage=assess_pc_usage(input,fallback_==Fallback::Automatic
        ? PcUsageEvaluation::StopOnRectilinearViolation : PcUsageEvaluation::Full);
    event.bplane=build_bplane(event.state1,event.state2,combined,zero,input.combined_radius);
    // Both dr and these covariances are inertial; never use input RTN blocks.
    event.mahalanobis_3d=encounter_mahalanobis_3d(dr,combined,zero);

    const bool zero_position_covariance=!(relative[0]+relative[7]+relative[14]>0);
    if(zero_position_covariance) {
        // Zero stated position uncertainty carries no covariance information;
        // CARA's NPD remediation must not turn it into a probability.
        event.pc=pc_engine_detail::unavailable(
            "Collision probability calculation failed: relative position covariance is zero");
    } else if(event.usage.violated && event.usage.reason.rfind("INVALID_",0)==0) {
        // An unusable covariance is not a 2-D validity problem: no fallback may
        // turn it into a probability.
        event.pc=pc_engine_detail::unavailable(
            "Collision probability calculation failed: unusable covariance (" + event.usage.reason + ")");
    } else {
        // A zero-speed encounter has no plane. Foster's covariance remediation
        // must never manufacture a plane or a probability for that case.
        auto pc2d=event.usage.low_relative_speed
            ? pc_engine_detail::unavailable("No encounter plane at low relative speed")
            : pc_grade_==PcGrade::Screening ? screening_foster_2d(event.bplane)
                                          : Foster2D().compute(event.bplane);
        if(pc_grade_==PcGrade::Screening && fallback_==Fallback::Automatic &&
           pc2d.converged && (pc2d.iterations==48 || pc2d.iterations==576)) {
            // A faster quadrature must not move an encounter across a tier
            // boundary when its bounded numerical uncertainty overlaps it.
            for(double floor:{tier_options_.reporting_floor,tier_options_.monte_carlo_floor})
                if(std::abs(pc2d.probability-floor)<=1e-5*std::max(pc2d.probability,floor)) {
                    pc2d=Foster2D().compute(event.bplane);break;
                }
        }
        const bool has_pc2d=pc_engine_detail::usable_probability(pc2d);
        if(!event.usage.violated) {
            event.pc=pc_method_->name()=="FOSTER-2D" ? pc2d : pc_method_->compute(event.bplane);
            event.pc.tier="FOSTER-2D";
        } else {
            double gate=has_pc2d ? pc2d.probability : std::numeric_limits<double>::quiet_NaN();
            if(!has_pc2d && fallback_==Fallback::Automatic) {
                const auto maximum=shape_scaled_maximum(event.bplane).pc;
                if(pc_engine_detail::usable_probability(maximum))gate=maximum.probability;
            }
            if(fallback_==Fallback::Automatic && gate<tier_options_.reporting_floor) {
                event.pc=pc2d;
                event.pc.tier="usage-violation, below floor";
            } else if(!input.has_velocity_covariance) {
                event.pc=pc_engine_detail::unavailable(
                    "Usage violation requires full position/velocity covariance: " + event.usage.reason);
            } else {
                const bool direct_monte_carlo=fallback_==Fallback::Automatic &&
                    gate>=tier_options_.monte_carlo_floor;
                const auto fallback=pc_engine_detail::evaluate_fallback(
                    input,event.usage,fallback_,direct_monte_carlo,
                    pc_engine_detail::grade_options(fallback_options_,pc_grade_,fallback_options_configured_));
                // A fallback evaluates full curvature for its bounds. Preserve
                // those complete diagnostics now that their cost has been paid.
                if(!fallback.invalid_inputs)event.usage=fallback.usage;
                event.pc=pc_engine_detail::fallback_probability(fallback);
                event.pc.tier=event.pc.method.rfind("SDMC-",0)==0
                    ? "usage-violation, Monte Carlo" : "usage-violation, 3D-Nc";
            }
        }
        if(has_pc2d)event.pc.probability_2d=pc2d.probability;
        event.pc.covariance_remediated|=pc2d.covariance_remediated;
    }
    event.pc.covariance_remediated |= event.usage.covariance_repaired;
    event.pc.usage_checked=event.usage.fully_evaluated;
    event.pc.usage_violation=event.usage.violated;
    if(!event.usage.reason.empty())
        event.pc.usage_reason=pc_engine_detail::usage_reason(event.usage) +
            (event.pc.usage_reason.empty()?"":"; "+event.pc.usage_reason);
    if(pc_grade_==PcGrade::Screening)
        event.pc.usage_reason+=(event.pc.usage_reason.empty()?"":"; ")+
            std::string("grade=Screening; Foster disk relative error budget=1e-5");
    event.pc.cross_correlation_applied=input.apply_cross_correlation;
    event.mahalanobis_2d=event.pc.mahalanobis_2d;
    event.has_covariance=pc_engine_detail::usable_probability(event.pc);
    if(!event.has_covariance)event.pc.method="PC-UNAVAILABLE";
    if(!event.has_covariance) event.probability_failure=event.pc.failure_reason;
    return event;
}
} // namespace conjunction
