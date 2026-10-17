#pragma once
// One resident-run interface keeps orbit policy separate from dense output.
#include "ffm_sundman_run.h"
#include "ffm_gj_run.h"

namespace ffm_fast {
struct Orbit {
    double a=0, e=0, perigee=0, apogee=0, periodMinutes=0;
    bool elliptic=false;
};
inline Orbit orbit(const astro::StateVector& initial,double mu) {
    Orbit o;
    const auto r=initial.position, v=initial.velocity;
    const double radius=r.magnitude();
    if (!(radius>0 && mu>0)) return o;
    o.a=1/(2/radius-v.dot(v)/mu);
    o.e=(v.cross(r.cross(v))*(1/mu)-r*(1/radius)).magnitude();
    o.elliptic=o.a>0 && o.e>=0 && o.e<1 && std::isfinite(o.a);
    if (!o.elliptic) return o;
    o.perigee=o.a*(1-o.e)-astro::RE_EARTH;
    o.apogee=o.a*(1+o.e)-astro::RE_EARTH;
    o.periodMinutes=2*std::acos(-1.)*std::sqrt(o.a*o.a*o.a/mu)/60;
    return o;
}
inline bool fixedStep(const astro::IntegratorConfig& config) {
    return config.initialStep==config.minStep && config.minStep==config.maxStep;
}
inline unsigned sundmanGrid(const astro::StateVector& initial,double mu) {
    const auto o=orbit(initial,mu);
    if (!o.elliptic || o.e<.25) return 0;
    return o.perigee<1000 && o.apogee>30000 && o.apogee<45000?300:200;
}
inline double gjGrid(const astro::StateVector& initial,double mu) {
    const auto o=orbit(initial,mu);
    if (!o.elliptic || o.e>=.25) return 0;
    if (o.apogee<2000) {
        if (o.perigee<300) return 10;
        if (o.perigee<450) return 15;
        if (o.perigee<650) return 12;
        return 24;
    }
    // Use half the study's coarse GPS/GEO grids; qualification must retain
    // the existing 0.1 mm no-regression floor and FIT/SCREEN grades.
    if (o.e<.05 && o.periodMinutes>1400 && o.periodMinutes<1480) return 600;
    if (o.e<.05 && o.periodMinutes>600 && o.periodMinutes<800) return 150;
    // The heterogeneous MEO bins have no coarse-grid qualification. Retain
    // a conservative LEO-sized grid until a broader orbit study supports it.
    return 24;
}
class Run {
    std::unique_ptr<astro::Integrator::ForceRun> rk_;
    std::unique_ptr<SundmanRun> sundman_;
    std::unique_ptr<GjRun> gj_;
    timesys::Instant epoch_;
    unsigned sundmanGrid_ = 0;
public:
    static double candidateGjGrid(const astro::StateVector& reference,int direction,
                                  const astro::IntegratorConfig& config,
                                  const astro::ForceModel::ForceModelSet& forces) {
        return direction>0 && !fixedStep(config) && gjforces::supported(forces)?gjGrid(reference,forces.mu):0;
    }
    Run(const astro::StateVector& initial,const astro::StateVector& reference,
        const timesys::Instant& epoch,int direction,const astro::IntegratorConfig& config,
        astro::ForceModel::ForceModelSet& forces,bool allowGj=true) : epoch_(epoch) {
        const auto sundman=!fixedStep(config) && direction>0?sundmanGrid(reference,forces.mu):0;
        const auto gj=allowGj?candidateGjGrid(reference,direction,config,forces):0;
        sundmanGrid_=sundman;
        if (sundman) sundman_=std::make_unique<SundmanRun>(initial,epoch,config,forces,sundman,reference);
        else if (gj) gj_=std::make_unique<GjRun>(initial,epoch,config,forces,gj);
        else rk_=std::make_unique<astro::Integrator::ForceRun>(initial,direction,config,forces,true);
    }
    double time() const { return gj_?gj_->time():sundman_?sundman_->time():rk_->run().time(); }
    const std::array<double,6>& state() const { return gj_?gj_->state():sundman_?sundman_->state():rk_->run().state(); }
    const std::array<double,6>& derivative() { return gj_?gj_->derivative():sundman_?sundman_->derivative():rk_->run().derivative(); }
    bool running(double target) const { return gj_?gj_->running(target):sundman_?sundman_->running(target):rk_->run().running(target); }
    bool attempt(double target) { return gj_?gj_->attempt(target):sundman_?sundman_->attempt(target):rk_->run().attempt(target); }
    bool endedOnBoundary() const { return gj_?gj_->endedOnBoundary():sundman_?sundman_->endedOnBoundary():rk_->run().endedOnBoundary(); }
    std::string description() const {
        if (gj_) return "GJ8 PEC at " + std::to_string(static_cast<unsigned>(gj_->gridStep())) + " s";
        if (sundman_) return "RK78 Sundman alpha=1.5 at " + std::to_string(sundmanGrid_) + "/orbit";
        return "RK78";
    }
    double gridStep() const { return gj_?gj_->gridStep():0; }
    timesys::Instant nextInstant() const { return gj_?gj_->nextInstant():epoch_.plusSeconds(time()); }
    bool continueSpan(const timesys::Instant& epoch) {
        if (gj_) gj_->continueSpan(epoch);
        else if (sundman_) sundman_->continueSpan(epoch);
        else return false;
        epoch_=epoch;
        return true;
    }
};
} // namespace ffm_fast
