#pragma once
#include "ffm_gj_shadow.h"
#include "integrators.h"
#include "reentry.h"
#include "rk_augmented.h"

namespace ffm_fast {
// Forward GJ8 PEC on an absolute TT lattice shared by all objects in a regime.
// The initial tight RK bridge spans at most one grid step. Ghost history uses
// a smooth selected sun/calendar branch; exported derivatives are physical.
class GjRun {
    using Forces = astro::ForceModel::ForceModelSet;
    using Point = gj::Point<3>;
    using Core = gj::Integrator<3>;
    using State = std::array<double, 6>;
    Forces& forces_;
    GjClock clock_;
    astro::IntegratorConfig config_;
    Core core_;
    Point point_;
    State y_{}, derivative_{};
    double spanOffset_ = 0, t_ = 0;
    int64_t calendarDay_ = 0;
    uint32_t steps_ = 0;
    bool ready_ = false, haveDerivative_ = false, sunlit_ = true;
    bool stepOrdinate_ = false;   // point_.a is the accepted step's own force call
    bool rkBranch_ = false, startupOutOfDomain_ = false;

    timesys::Instant instant(double x) const { return clock_.at(x); }
    gj::Vector<3> acceleration(const Point& p, bool selectedBranch) {
        const auto r=gjshadow::vector(p.r), v=gjshadow::vector(p.v);
        const auto at=instant(p.x);
        double state[6]={r.x,r.y,r.z,v.x,v.y,v.z};
        if (astro::stopAt(state,at)) return {};
        auto a=astro::ForceModel::ComputeTotalAcceleration(r,v,at,forces_);
        a+=gjforces::calendarCorrection(forces_,r,v,at,calendarDay_);
        if (selectedBranch) a+=gjforces::srpCorrection(forces_,at,r,v,sunlit_);
        if (!std::isfinite(a.x) || !std::isfinite(a.y) || !std::isfinite(a.z))
            { astro::flagIntegrationFailure("nonfinite GJ acceleration"); return {}; }
        return {a.x,a.y,a.z};
    }
    static void rkDerivative(double x,const double* y,double* f,void* opaque) {
        auto& self=*static_cast<GjRun*>(opaque);
        Point p; p.x=x;
        for (int j=0;j<3;++j) { p.r[j]=y[j]; p.v[j]=y[j+3]; }
        const auto a=self.acceleration(p,self.rkBranch_);
        for (int j=0;j<3;++j) { f[j]=y[j+3]; f[j+3]=a[j]; }
    }
    Point rk(Point p,double target,bool selectedBranch) {
        rkBranch_=selectedBranch;
        double y[6],next[6],error[6],k[6];
        for (int j=0;j<3;++j) { y[j]=p.r[j]; y[j+3]=p.v[j]; }
        const int direction=target>p.x?1:-1;
        double x=p.x, h=direction*std::min(std::abs(target-x),core_.h/2);
        for (int attempts=0; direction*(target-x)>1e-12; ++attempts) {
            if (attempts>=100000) { astro::flagIntegrationFailure("GJ startup RK attempt limit"); return p; }
            h=direction*std::min({std::abs(h),std::abs(target-x),core_.h/2});
            rkDerivative(x,y,k,this);
            astro::rk_detail::rkf78StepFrom<6>(x,h,y,k,next,error,rkDerivative,this);
            if (astro::propagationStop().active) return p;
            double norm=0;
            for (int j=0;j<6;++j) norm=std::max(norm,std::abs(error[j])/(1e-13*(1+std::max(std::abs(y[j]),std::abs(next[j])))));
            if (!std::isfinite(norm)) { astro::flagIntegrationFailure("nonfinite GJ startup RK error"); return p; }
            if (norm>1 && std::abs(h)>1e-8) { h*=std::max(.1,.8*std::pow(norm,-1./8)); continue; }
            std::copy(next,next+6,y); x+=h;
            h*=norm>1e-12?std::min(2.,.8*std::pow(norm,-1./8)):2.;
        }
        p.x=target;
        for (int j=0;j<3;++j) { p.r[j]=y[j]; p.v[j]=y[j+3]; }
        return p;
    }
    bool startup() {
        // Only artificial history may request fallback. A stop at the last
        // accepted physical state remains a real propagation failure.
        if (astro::stopAt(y_.data(),instant(point_.x))) return false;
        const auto previousStop=astro::propagationStop(), previousCallStop=astro::callStop();
        auto historyStopped=[&]() {
            if (!astro::propagationStop().active) return false;
            if (std::string(astro::propagationStop().code) != "reentry" &&
                std::string(astro::propagationStop().code) != "invalid-state") return true;
            astro::propagationStop()=previousStop;
            astro::callStop()=previousCallStop;
            startupOutOfDomain_=true;
            return true;
        };
        sunlit_=gjforces::shadowValues(forces_,instant(point_.x),gjshadow::vector(point_.r)).midpoint>=0;
        std::array<Point,9> nodes{}; nodes[4]=point_;
        for (int j=3;j>=0;--j) {
            nodes[j]=rk(nodes[j+1],point_.x+(j-4)*core_.h,true);
            if (historyStopped()) return false;
        }
        for (int j=5;j<9;++j) {
            nodes[j]=rk(nodes[j-1],point_.x+(j-4)*core_.h,true);
            if (historyStopped()) return false;
        }
        auto eval=[&](const Point& p) { return acceleration(p,true); };
        for (auto& p:nodes) p.a=eval(p);
        if (historyStopped()) return false;
        core_.initialize(nodes,eval,2e-13,64);
        if (historyStopped()) return false;
        if (!core_.startupConverged) { astro::flagIntegrationFailure("GJ startup corrector did not converge"); return false; }
        // Convert centered ordinates into nine backward nodes ending at the
        // requested lattice point, without consuming future output.
        std::reverse(core_.history.begin(),core_.history.end()); core_.h=-core_.h; core_.resetSums();
        for (int j=0;j<4;++j) {
            core_.step(eval,true);
            if (historyStopped()) return false;
        }
        std::reverse(core_.history.begin(),core_.history.end()); core_.h=-core_.h; core_.resetSums();
        point_=core_.current(); ready_=true;
        return true;
    }
    void accept(const Point& p,double time,bool stepOrdinate=false) {
        point_=p; t_=time;
        for (int j=0;j<3;++j) { y_[j]=p.r[j]; y_[j+3]=p.v[j]; }
        haveDerivative_=false; stepOrdinate_=stepOrdinate; ++steps_;
    }
    // A PEC step's ordinate is the force on its selected shadow branch at the
    // predicted state, which the corrector moves by its truncation error
    // only. Clear of the penumbra on the branch's own side, the selected
    // branch is the physical force (srpCorrection vanishes), so the ordinate
    // is the node's physical acceleration to that difference. The margin far
    // exceeds the switching functions' disagreement with the conical shadow
    // function's own arithmetic; nodes within it take a fresh force call.
    bool physicalOrdinate() const {
        if (!stepOrdinate_) return false;
        if (!forces_.useSRP) return true;
        constexpr double margin=1e-9;   // rad
        const auto s=gjforces::shadowValues(forces_,instant(point_.x),gjshadow::vector(point_.r));
        return sunlit_ ? s.penumbra>margin : s.umbra< -margin;
    }
public:
    GjRun(const astro::StateVector& initial,const timesys::Instant& epoch,
          const astro::IntegratorConfig& config,Forces& forces,double h)
        : forces_(forces),clock_(epoch),config_(config),core_(h) {
        spanOffset_=epoch.secondsSince(clock_.at(0));
        point_.x=spanOffset_;
        point_.r={initial.position.x,initial.position.y,initial.position.z};
        point_.v={initial.velocity.x,initial.velocity.y,initial.velocity.z};
        for (int j=0;j<3;++j) { y_[j]=point_.r[j]; y_[j+3]=point_.v[j]; }
        calendarDay_=gjforces::calendarDay(epoch.plusSeconds(1e-3));
    }
    double time() const { return t_; }
    uint32_t acceptedSteps() const { return steps_; }
    bool needsRkFallback() const { return startupOutOfDomain_; }
    const State& state() const { return y_; }
    const State& derivative() {
        if (!haveDerivative_) {
            // PEC's stored ordinate is evaluated at its predictor: the
            // node's physical acceleration where physicalOrdinate() holds,
            // else a fresh force call at the corrected state.
            const auto a=physicalOrdinate()?point_.a:acceleration(point_,false);
            for (int j=0;j<3;++j) { derivative_[j]=point_.v[j]; derivative_[j+3]=a[j]; }
            haveDerivative_=true;
        }
        return derivative_;
    }
    bool endedOnBoundary() const { return false; }
    bool running(double target) const { return target>t_ && steps_<config_.maxSteps && !astro::propagationStop().active; }
    timesys::Instant nextInstant() const {
        const double grid=std::floor(point_.x/core_.h+1e-10)+1;
        return instant(grid*core_.h);
    }
    double gridStep() const { return core_.h; }
    bool attempt(double target) {
        if (!running(target)) return false;
        const double aligned=std::round(point_.x/core_.h)*core_.h;
        if (!ready_ && std::abs(aligned-point_.x)>1e-8) {
            const double next=std::min(std::ceil(point_.x/core_.h)*core_.h,spanOffset_+target);
            const auto p=rk(point_,next,false);
            if (astro::propagationStop().active) return false;
            accept(p, next==spanOffset_+target?target:next-spanOffset_);
            return true;
        }
        if (!ready_) {
            point_.x=aligned;
            if (!startup()) return false;
        }
        const double next=point_.x+core_.h;
        if (next>spanOffset_+target+1e-8) {
            // Exceptional off-grid driver endpoints (for example a leap
            // second) use a tight physical landing and a fresh startup.
            const auto p=rk(point_,spanOffset_+target,false);
            if (astro::propagationStop().active) return false;
            ready_=false; accept(p,target); return true;
        }
        const auto p=gjshadow::step(core_,forces_,clock_,sunlit_,[&](const Point& q) { return acceleration(q,true); });
        if (astro::propagationStop().active) return false;
        accept(p,std::abs(next-(spanOffset_+target))<1e-8?target:next-spanOffset_,true);
        return true;
    }
    // Normal UTC-midnight endpoints lie on the lattice. Retain all nine
    // states, extend the new calendar/weather branch through their forces,
    // and reconstruct sums; no RK startup is repeated.
    void continueSpan(const timesys::Instant& epoch) {
        if (!ready_) {
            // Re-anchor after an exceptional off-grid landing (leap second).
            clock_=GjClock(epoch);
            point_.x=epoch.secondsSince(clock_.at(0));
        }
        spanOffset_=epoch.secondsSince(clock_.at(0)); t_=0;
        calendarDay_=gjforces::calendarDay(epoch.plusSeconds(1e-3));
        if (ready_) core_.rebase([&](const Point& p) { return acceleration(p,true); });
        haveDerivative_=false; stepOrdinate_=false;   // the new span's drivers
    }
};
} // namespace ffm_fast
