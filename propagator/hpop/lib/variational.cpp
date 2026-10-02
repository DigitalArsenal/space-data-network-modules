#include "variational.h"
#include "rk_augmented.h"
#include <algorithm>
#include <cmath>
#include <limits>

namespace astro { namespace Integrator {
namespace {
struct Context {
    ForceModel::ForceModelSet* forces;
    double epoch;
    ForceModel::DensityGradient density;
    const char* error = nullptr;
};
void derivative(double t, const double* y, double* f, void* opaque) {
    auto& c = *static_cast<Context*>(opaque);
    if(!c.error)c.error=ForceModel::ValidateAccelerationPartials(Vec3(y[0],y[1],y[2]),*c.forces);
    if(c.error) {std::fill(f,f+42,0.0);return;}
    const auto a = ForceModel::ComputeAccelerationPartials(
        Vec3(y[0],y[1],y[2]), Vec3(y[3],y[4],y[5]), c.epoch+t/86400.0,
        *c.forces, c.density);
    f[0]=y[3]; f[1]=y[4]; f[2]=y[5];
    f[3]=a.acceleration.x; f[4]=a.acceleration.y; f[5]=a.acceleration.z;
    // dPhi/dt = [0 I; da/dr da/dv] Phi, at the SAME stage as dx/dt.
    for (int i=0;i<3;++i) for (int j=0;j<6;++j) {
        f[6+i*6+j]=y[6+(i+3)*6+j];
        double value=0;
        for (int k=0;k<3;++k)
            value+=a.dr[i][k]*y[6+k*6+j]+a.dv[i][k]*y[6+(k+3)*6+j];
        f[6+(i+3)*6+j]=value;
    }
}
Mat6 multiply(const Mat6& a, const Mat6& b) {
    Mat6 c{};
    for(int i=0;i<6;++i) for(int j=0;j<6;++j) {
        c.m[i][j]=0;
        for(int k=0;k<6;++k)c.m[i][j]+=a.m[i][k]*b.m[k][j];
    }
    return c;
}
double component(const StateVector& s,int i) {
    const double a[]={s.position.x,s.position.y,s.position.z,s.velocity.x,s.velocity.y,s.velocity.z};
    return a[i];
}
void perturb(StateVector& s,int i,double d) {
    if(i==0)s.position.x+=d; if(i==1)s.position.y+=d; if(i==2)s.position.z+=d;
    if(i==3)s.velocity.x+=d; if(i==4)s.velocity.y+=d; if(i==5)s.velocity.z+=d;
}
const char* validateInputs(const StateVector& initial, double dt, const IntegratorConfig& config) {
    if(!std::isfinite(dt)||!std::isfinite(initial.epoch)||!std::isfinite(initial.epoch+dt/86400.0))
        return "Non-finite propagation epoch or duration.";
    for(int i=0;i<6;++i)if(!std::isfinite(component(initial,i)))
        return "Non-finite state.";
    if(!(initial.position.magnitude()>0)||!std::isfinite(initial.position.magnitude())||
       !std::isfinite(initial.velocity.magnitude()))
        return "Invalid Cartesian state magnitude.";
    if(!(config.initialStep>0 && config.minStep>0 && config.maxStep>=config.minStep &&
         config.absTolerance>0 && config.relTolerance>=0 && config.maxSteps>0) ||
       !std::isfinite(config.initialStep+config.minStep+config.maxStep+config.absTolerance+config.relTolerance))
        return "Invalid variational step controls.";
    return nullptr;
}
// The legacy result dispatcher silently defaults several named methods to
// RKF78. Refuse those here rather than advertise a cross-check of another
// integrator. Cowell explicitly uses the existing Cash-Karp implementation.
bool finiteDifferenceConfig(const IntegratorConfig& config,IntegratorConfig& selected) {
    selected=config;
    if(selected.method==IntegrationMethod::Cowell)selected.method=IntegrationMethod::RKF45;
    switch(selected.method) {
        case IntegrationMethod::RK4:
        case IntegrationMethod::RKF45:
        case IntegrationMethod::RKF78:
        case IntegrationMethod::RK78:
        case IntegrationMethod::RKDP87:
        case IntegrationMethod::BS:
            return true;
        default:
            return false;
    }
}
struct WeatherEpochScope {
    double& epoch;
    const double saved;
    WeatherEpochScope(double& value,double replacement):epoch(value),saved(value){epoch=replacement;}
    ~WeatherEpochScope(){epoch=saved;}
};
VariationalResult fail(VariationalResult& out,const std::string& error) {
    out.success=false;out.errorMessage=error;return out;
}
VariationalResult scheduled(const StateVector& initial,double dt,const IntegratorConfig& config,
    ForceModel::ForceModelSet& forces,bool analytic,ForceModel::DensityGradient density,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& burns) {
    VariationalResult out;out.finalState=initial;
    if(dt<0 && !burns.empty())return fail(out,"Backward propagation with scheduled impulses is unsupported.");
    auto sorted=burns;
    for(const auto& b:sorted)
        if(!std::isfinite(b.epoch)||!std::isfinite(b.deltaV.x)||!std::isfinite(b.deltaV.y)||!std::isfinite(b.deltaV.z))
            return fail(out,"Impulse epoch and deltaV must be finite.");
    std::stable_sort(sorted.begin(),sorted.end(),[](const auto& a,const auto& b){return a.epoch<b.epoch;});
    auto dispatch=config;
    if(!analytic&&!finiteDifferenceConfig(config,dispatch))
        return fail(out,"FINITE_DIFFERENCE STM supports RK4, RKF45, RKF78, RK78, COWELL, RKDP87 and BS; this integrator has no verified result dispatcher.");
    double elapsed=0;
    auto advance=[&](double until) {
        if(until==elapsed)return true;
        WeatherEpochScope epochScope(forces.explicitEpochContract ? forces.integrationEpochTDB : forces.weather.epoch,out.finalState.epoch);
        const double duration=until-elapsed;
        VariationalResult segment;
        if(analytic)segment=PropagateVariational(out.finalState,duration,config,forces,density);
        else {
            auto r=PropagateWithResult(out.finalState,duration,dispatch,forces);
            segment.finalState=r.finalState;segment.success=r.success;segment.errorMessage=r.errorMessage;
            segment.steps=r.steps;segment.rejections=r.rejections;
            const double timeTolerance=32*std::numeric_limits<double>::epsilon()*std::max(1.0,std::abs(duration));
            if(!std::isfinite(r.totalTime)||std::abs(r.totalTime-duration)>timeTolerance) {
                segment.success=false;
                segment.errorMessage="Finite-difference integration did not reach the requested duration.";
            }
        }
        if(!segment.success) {
            out.success=false;out.errorMessage=segment.errorMessage.empty()?"STM propagation failed.":segment.errorMessage;return false;
        }
        if(!std::isfinite(segment.finalState.epoch)) {
            out.success=false;out.errorMessage="Non-finite propagated epoch.";return false;
        }
        for(int i=0;i<6;++i)if(!std::isfinite(component(segment.finalState,i))) {
            out.success=false;out.errorMessage="Non-finite propagated state.";return false;
        }
        out.finalState=segment.finalState;
        out.stm=multiply(segment.stm,out.stm);
        out.steps+=segment.steps;out.rejections+=segment.rejections;
        elapsed=until;return true;
    };
    for(const auto& b:sorted) {
        const double when=(b.epoch-initial.epoch)*86400.0;
        if(b.executed||when<=0||when>dt)continue;
        if(!advance(when))return out;
        if(analytic) {
            if(b.inRTN&&(out.finalState.position.magnitude()==0||out.finalState.position.cross(out.finalState.velocity).magnitude()==0))
                return fail(out,"RTN impulse STM requires nonzero radius and angular momentum");
            out.stm=multiply(ForceModel::ImpulsiveManeuverJacobian(out.finalState.position,out.finalState.velocity,b),out.stm);
        }
        out.finalState.velocity=ForceModel::ImpulsiveManeuver(out.finalState.velocity,out.finalState.position,b);
    }
    advance(dt);
    return out;
}
}
VariationalResult PropagateVariational(const StateVector& initial,double dt,
    const IntegratorConfig& config,ForceModel::ForceModelSet& forces,ForceModel::DensityGradient density) {
    VariationalResult out; out.finalState=initial;
    {
        if(const char* error=validateInputs(initial,dt,config))return fail(out,error);
        const bool fixed=config.method==IntegrationMethod::RK4;
        const bool ck=config.method==IntegrationMethod::RKF45||config.method==IntegrationMethod::Cowell;
        if(!fixed&&!ck&&config.method!=IntegrationMethod::RKF78&&config.method!=IntegrationMethod::RK78)
            return fail(out,"ANALYTIC STM supports RK4, RKF45, RKF78, RK78 and COWELL; FINITE_DIFFERENCE additionally supports RKDP87 and BS.");
        double y[42]{},next[42],error[42];
        for(int i=0;i<6;++i){y[i]=component(initial,i);y[6+i*6+i]=1;}
        Context context{&forces,initial.epoch,density};
        // Dimensionless STM scaling: D^-1 Phi D, D=(r,r,r,v,v,v).
        // Both state and STM participate in ONE acceptance decision.
        const double r=std::max(1.0,initial.position.magnitude());
        const double v=std::max(1e-6,initial.velocity.magnitude());
        double scales[]={r,r,r,v,v,v};
        double t=0, sign=dt<0?-1:1;
        double h=sign*std::clamp(config.initialStep,config.minStep,config.maxStep);
        uint64_t attempts=0;
        while(sign*(dt-t)>0) {
            if(out.steps>=config.maxSteps||++attempts>uint64_t(config.maxSteps)*10)
                return fail(out,"Variational integration exhausted maxSteps.");
            h=sign*std::min(std::abs(h),std::abs(dt-t));
            if(t+h==t)return fail(out,"Variational step underflow.");
            if(fixed)rk_detail::rk4Step<42>(t,h,y,next,error,derivative,&context);
            else if(ck)rk_detail::cashKarpStep<42>(t,h,y,next,error,derivative,&context);
            else rk_detail::rkf78Step<42>(t,h,y,next,error,derivative,&context);
            if(context.error)return fail(out,context.error);
            double norm=0;
            for(int i=0;i<42;++i) {
                if(!std::isfinite(next[i])||!std::isfinite(error[i]))return fail(out,"Non-finite variational state or force partial.");
                const double unit=i<6?1:scales[(i-6)%6]/scales[(i-6)/6];
                const double scale=config.absTolerance+config.relTolerance*std::abs(next[i]*unit);
                norm=std::max(norm,std::abs(error[i]*unit)/scale);
            }
            if(fixed||norm<=1) {
                std::copy(next,next+42,y);t+=h;++out.steps;
                const double proposed=fixed?config.initialStep:ComputeOptimalStep(std::abs(h),norm,ck?5:8);
                h=sign*std::clamp(proposed,config.minStep,config.maxStep);
            } else {
                ++out.rejections;
                if(std::abs(h)<=config.minStep*(1+1e-12))
                    return fail(out,"Variational tolerance cannot be met at minStep.");
                h=sign*std::max(config.minStep,ComputeOptimalStep(std::abs(h),norm,ck?5:8,0.9,0.1,1.0));
            }
        }
        out.finalState.position=Vec3(y[0],y[1],y[2]);out.finalState.velocity=Vec3(y[3],y[4],y[5]);
        out.finalState.epoch=initial.epoch+dt/86400.0;
        for(int i=0;i<6;++i)for(int j=0;j<6;++j)out.stm.m[i][j]=y[6+i*6+j];
    }
    return out;
}
VariationalResult PropagateWithSTM(const StateVector& initial,double dt,const IntegratorConfig& config,
    ForceModel::ForceModelSet& forces,STMMethod method,ForceModel::DensityGradient density,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& burns) {
    VariationalResult out;out.finalState=initial;
    {
        if(const char* error=validateInputs(initial,dt,config))return fail(out,error);
        if(method!=STMMethod::Analytic&&method!=STMMethod::FiniteDifference)
            return fail(out,"Unknown STM method.");
        out=scheduled(initial,dt,config,forces,method==STMMethod::Analytic,density,burns);
        if(!out.success)return out;
        if(method==STMMethod::FiniteDifference && dt!=0) {
            const double dr=std::max(1e-6,1e-8*std::max(1.0,initial.position.magnitude()));
            const double dv=std::max(1e-9,1e-8*std::max(1.0,initial.velocity.magnitude()));
            for(int j=0;j<6;++j) {
                auto p=initial,m=initial;double d=j<3?dr:dv;perturb(p,j,d);perturb(m,j,-d);
                auto fp=scheduled(p,dt,config,forces,false,density,burns);
                if(!fp.success)return fail(out,fp.errorMessage);
                auto fm=scheduled(m,dt,config,forces,false,density,burns);
                if(!fm.success)return fail(out,fm.errorMessage);
                for(int i=0;i<6;++i)out.stm.m[i][j]=(component(fp.finalState,i)-component(fm.finalState,i))/(2*d);
            }
        }
    }
    return out;
}
Mat6 TransportCovariance(const Mat6& phi,const Mat6& covariance) {
    auto tmp=multiply(phi,covariance);Mat6 transpose;
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)transpose.m[i][j]=phi.m[j][i];
    return multiply(tmp,transpose);
}
// White acceleration noise over one interval h at state s: per axis k with
// spectral density q_k, q_k [[h^3/3, h^2/2], [h^2/2, h]] on that axis's
// position and velocity components; RTN axes from s.
Mat6 WhiteAccelerationNoise(const ProcessNoise& noise,double h,const StateVector& s) {
    Vec3 axes[3]={Vec3(1,0,0),Vec3(0,1,0),Vec3(0,0,1)};
    if(noise.rtn) {
        const Vec3 r=s.position.normalized(),n=s.position.cross(s.velocity).normalized();
        axes[0]=r;axes[1]=n.cross(r);axes[2]=n;
    }
    Mat6 q{};
    for(int k=0;k<3;++k) {
        const double a=noise.q[k]*h*h*h/3,b=noise.q[k]*h*h/2,c=noise.q[k]*h;
        const double u[3]={axes[k].x,axes[k].y,axes[k].z};
        for(int i=0;i<3;++i)for(int j=0;j<3;++j) {
            const double w=u[i]*u[j];
            q.m[i][j]+=a*w;q.m[i][3+j]+=b*w;q.m[3+i][j]+=b*w;q.m[3+i][3+j]+=c*w;
        }
    }
    return q;
}
CovarianceResult PropagateCovariance(const StateVector& initial,double dt,const IntegratorConfig& config,
    ForceModel::ForceModelSet& forces,STMMethod method,ForceModel::DensityGradient density,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& burns,const Mat6& p0,const ProcessNoise& noise) {
    CovarianceResult out;
    if(!noise.enabled||dt==0) {
        static_cast<VariationalResult&>(out)=PropagateWithSTM(initial,dt,config,forces,method,density,burns);
        if(out.success)out.covariance=TransportCovariance(out.stm,p0);
        return out;
    }
    out.finalState=initial;
    if(!(noise.interval>0)||!std::isfinite(noise.interval)) {
        out.success=false;out.errorMessage="Process noise needs a positive discretization interval.";return out;
    }
    const double intervals=std::ceil(std::abs(dt)/noise.interval-1e-9);
    if(intervals>100000) {
        out.success=false;out.errorMessage="Process noise discretization exceeds 100000 intervals for this arc.";return out;
    }
    const int n=std::max(1,int(intervals));
    const double step=dt/n;
    StateVector state=initial;Mat6 phi=Mat6::identity(),p=p0;
    for(int k=0;k<n;++k) {
        const auto v=PropagateWithSTM(state,step,config,forces,method,density,burns);
        if(!v.success){out.success=false;out.errorMessage=v.errorMessage;return out;}
        p=TransportCovariance(v.stm,p);
        const Mat6 q=WhiteAccelerationNoise(noise,std::abs(step),v.finalState);
        for(int i=0;i<6;++i)for(int j=0;j<6;++j)p.m[i][j]+=q.m[i][j];
        phi=multiply(v.stm,phi);
        state=v.finalState;
        out.steps+=v.steps;out.rejections+=v.rejections;
    }
    out.finalState=state;out.stm=phi;out.covariance=p;
    return out;
}
}}
