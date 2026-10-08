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
    const std::vector<DynamicParameter>* parameters = nullptr;
    int size = 42;  // the augmented vector's length: 42, or 66 with parameters
};
constexpr int ParameterSize = 42 + 6 * 4;
void derivative(double t, const double* y, double* f, void* opaque) {
    auto& c = *static_cast<Context*>(opaque);
    if(!c.error)c.error=ForceModel::ValidateAccelerationPartials(Vec3(y[0],y[1],y[2]),*c.forces);
    if(c.error) {std::fill(f,f+c.size,0.0);return;}
    const double jd=c.epoch+t/86400.0;
    const auto a = ForceModel::ComputeAccelerationPartials(
        Vec3(y[0],y[1],y[2]), Vec3(y[3],y[4],y[5]), jd,
        *c.forces, c.density);
    // Sensitivities S (6 x np at y[42]): dS/dt = [0 I; da/dr da/dv] S + [0; da/dp].
    const int np=c.parameters?int(c.parameters->size()):0;
    if(c.size>42) {
        std::fill(f+42,f+c.size,0.0);
        for(int k=0;k<np;++k) {
            const Vec3 dp=ForceModel::AccelerationParameterPartial((*c.parameters)[k],Vec3(y[0],y[1],y[2]),Vec3(y[3],y[4],y[5]),jd,*c.forces);
            const double partial[3]={dp.x,dp.y,dp.z};
            for(int i=0;i<3;++i) {
                f[42+i*np+k]=y[42+(i+3)*np+k];
                double value=partial[i];
                for(int j=0;j<3;++j)value+=a.dr[i][j]*y[42+j*np+k]+a.dv[i][j]*y[42+(j+3)*np+k];
                f[42+(i+3)*np+k]=value;
            }
        }
    }
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
// S <- Phi S (6 x np).
void transportSensitivity(const Mat6& phi,std::vector<double>& s,int np) {
    std::vector<double> next(6*np,0.0);
    for(int i=0;i<6;++i)for(int k=0;k<np;++k)for(int j=0;j<6;++j)next[i*np+k]+=phi.m[i][j]*s[j*np+k];
    s.swap(next);
}
VariationalResult scheduled(const StateVector& initial,double dt,const IntegratorConfig& config,
    ForceModel::ForceModelSet& forces,bool analytic,ForceModel::DensityGradient density,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& burns,
    const std::vector<DynamicParameter>& parameters={}) {
    VariationalResult out;out.finalState=initial;
    const int np=analytic?int(parameters.size()):0;
    out.sensitivity.assign(6*np,0.0);
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
        if(analytic)segment=PropagateVariational(out.finalState,duration,config,forces,density,parameters);
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
        // [[Phi2, S2], [0, I]] [[Phi1, S1], [0, I]]: S = Phi2 S1 + S2.
        if(np){transportSensitivity(segment.stm,out.sensitivity,np);for(int i=0;i<6*np;++i)out.sensitivity[i]+=segment.sensitivity[i];}
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
            const Mat6 jump=ForceModel::ImpulsiveManeuverJacobian(out.finalState.position,out.finalState.velocity,b);
            out.stm=multiply(jump,out.stm);
            if(np)transportSensitivity(jump,out.sensitivity,np);
        }
        out.finalState.velocity=ForceModel::ImpulsiveManeuver(out.finalState.velocity,out.finalState.position,b);
    }
    advance(dt);
    return out;
}
}
namespace {
template<int N>
VariationalResult integrateVariational(const StateVector& initial,double dt,
    const IntegratorConfig& config,ForceModel::ForceModelSet& forces,ForceModel::DensityGradient density,
    const std::vector<DynamicParameter>& parameters) {
    VariationalResult out; out.finalState=initial;
    {
        if(const char* error=validateInputs(initial,dt,config))return fail(out,error);
        const bool fixed=config.method==IntegrationMethod::RK4;
        const bool ck=config.method==IntegrationMethod::RKF45||config.method==IntegrationMethod::Cowell;
        if(!fixed&&!ck&&config.method!=IntegrationMethod::RKF78&&config.method!=IntegrationMethod::RK78)
            return fail(out,"ANALYTIC STM supports RK4, RKF45, RKF78, RK78 and COWELL; FINITE_DIFFERENCE additionally supports RKDP87 and BS.");
        double y[N]{},next[N],error[N];
        for(int i=0;i<6;++i){y[i]=component(initial,i);y[6+i*6+i]=1;}
        Context context{&forces,initial.epoch,density};
        context.parameters=&parameters;context.size=N;
        // Dimensionless STM scaling: D^-1 Phi D, D=(r,r,r,v,v,v).
        // Both state and STM participate in ONE acceptance decision; the
        // parameter sensitivities (from index 42) follow the same steps.
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
            if(fixed)rk_detail::rk4Step<N>(t,h,y,next,error,derivative,&context);
            else if(ck)rk_detail::cashKarpStep<N>(t,h,y,next,error,derivative,&context);
            else rk_detail::rkf78Step<N>(t,h,y,next,error,derivative,&context);
            if(context.error)return fail(out,context.error);
            double norm=0;
            for(int i=0;i<N;++i)if(!std::isfinite(next[i])||!std::isfinite(error[i]))return fail(out,"Non-finite variational state or force partial.");
            for(int i=0;i<42;++i) {
                const double unit=i<6?1:scales[(i-6)%6]/scales[(i-6)/6];
                const double scale=config.absTolerance+config.relTolerance*std::abs(next[i]*unit);
                norm=std::max(norm,std::abs(error[i]*unit)/scale);
            }
            if(fixed||norm<=1) {
                std::copy(next,next+N,y);t+=h;++out.steps;
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
        const int np=int(parameters.size());
        out.sensitivity.assign(y+42,y+42+6*np);
    }
    return out;
}
}
VariationalResult PropagateVariational(const StateVector& initial,double dt,
    const IntegratorConfig& config,ForceModel::ForceModelSet& forces,ForceModel::DensityGradient density,
    const std::vector<DynamicParameter>& parameters) {
    if(parameters.size()>4){VariationalResult out;out.finalState=initial;return fail(out,"At most four dynamic parameters.");}
    for(const auto p:parameters)if(const char* error=ForceModel::ValidateParameter(p,forces)){VariationalResult out;out.finalState=initial;return fail(out,error);}
    return parameters.empty()?integrateVariational<42>(initial,dt,config,forces,density,parameters)
                             :integrateVariational<ParameterSize>(initial,dt,config,forces,density,parameters);
}
VariationalResult PropagateWithSTM(const StateVector& initial,double dt,const IntegratorConfig& config,
    ForceModel::ForceModelSet& forces,STMMethod method,ForceModel::DensityGradient density,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& burns,
    const std::vector<DynamicParameter>& parameters) {
    VariationalResult out;out.finalState=initial;
    {
        if(const char* error=validateInputs(initial,dt,config))return fail(out,error);
        if(method!=STMMethod::Analytic&&method!=STMMethod::FiniteDifference)
            return fail(out,"Unknown STM method.");
        if(parameters.size()>4)return fail(out,"At most four dynamic parameters.");
        for(size_t k=0;k<parameters.size();++k) {
            if(const char* error=ForceModel::ValidateParameter(parameters[k],forces))return fail(out,error);
            for(size_t j=0;j<k;++j)if(parameters[j]==parameters[k])return fail(out,"Dynamic parameters must not repeat.");
        }
        out=scheduled(initial,dt,config,forces,method==STMMethod::Analytic,density,burns,parameters);
        if(!out.success)return out;
        out.sensitivity.resize(6*parameters.size(),0.0);
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
            // Parameter columns by central differences of the force set: 0.1 %
            // of the value, or of a scale that moves the trajectory measurably
            // when the value is zero (a rate changing Cd*A/m by 0.1 % over the
            // arc; 1e-9 m/s^2 in track).
            const int np=int(parameters.size());
            out.sensitivity.assign(6*np,0.0);
            for(int k=0;k<np;++k) {
                const auto parameter=parameters[k];
                const double value=ForceModel::ParameterValue(forces,parameter);
                double floor=1e-6;
                if(parameter==DynamicParameter::DragAreaOverMassRate)
                    floor=1e-3*ForceModel::ParameterValue(forces,DynamicParameter::DragAreaOverMass)/std::max(1.0,std::abs(dt));
                if(parameter==DynamicParameter::InTrackAcceleration)floor=1e-9;
                const double d=std::max(1e-3*std::abs(value),floor);
                auto plus=forces,minus=forces;
                ForceModel::PerturbParameter(plus,parameter,d);ForceModel::PerturbParameter(minus,parameter,-d);
                auto fp=scheduled(initial,dt,config,plus,false,density,burns);
                if(!fp.success)return fail(out,fp.errorMessage);
                auto fm=scheduled(initial,dt,config,minus,false,density,burns);
                if(!fm.success)return fail(out,fm.errorMessage);
                for(int i=0;i<6;++i)out.sensitivity[i*np+k]=(component(fp.finalState,i)-component(fm.finalState,i))/(2*d);
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
ParameterCovarianceResult PropagateParameterCovariance(const StateVector& initial,double dt,const IntegratorConfig& config,
    ForceModel::ForceModelSet& forces,STMMethod method,ForceModel::DensityGradient density,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& burns,const std::vector<DynamicParameter>& parameters,
    const std::vector<double>& p0,const ProcessNoise& noise) {
    ParameterCovarianceResult out;out.finalState=initial;
    const unsigned np=unsigned(parameters.size()),n=6+np;
    out.dimension=n;
    if(!p0.empty()&&p0.size()!=n*n){out.success=false;out.errorMessage="Covariance dimension must be six plus the dynamic parameters.";return out;}
    // [[Phi, S], [0, I]] of one span.
    const auto augmented=[&](const VariationalResult& v) {
        std::vector<double> m(n*n,0.0);
        for(unsigned i=0;i<6;++i){for(unsigned j=0;j<6;++j)m[i*n+j]=v.stm.m[i][j];for(unsigned k=0;k<np;++k)m[i*n+6+k]=v.sensitivity[i*np+k];}
        for(unsigned k=0;k<np;++k)m[(6+k)*n+6+k]=1;
        return m;
    };
    const auto product=[&](const std::vector<double>& a,const std::vector<double>& b) {
        std::vector<double> c(n*n,0.0);
        for(unsigned i=0;i<n;++i)for(unsigned k=0;k<n;++k){const double x=a[i*n+k];if(x==0)continue;for(unsigned j=0;j<n;++j)c[i*n+j]+=x*b[k*n+j];}
        return c;
    };
    const auto transport=[&](const std::vector<double>& phi,const std::vector<double>& p) {
        auto tmp=product(phi,p);std::vector<double> t(n*n);
        for(unsigned i=0;i<n;++i)for(unsigned j=0;j<n;++j)t[i*n+j]=phi[j*n+i];
        return product(tmp,t);
    };
    if(!noise.enabled||dt==0) {
        static_cast<VariationalResult&>(out)=PropagateWithSTM(initial,dt,config,forces,method,density,burns,parameters);
        if(!out.success)return out;
        out.phi=augmented(out);
        if(!p0.empty())out.covariance=transport(out.phi,p0);
        return out;
    }
    if(!(noise.interval>0)||!std::isfinite(noise.interval)) {
        out.success=false;out.errorMessage="Process noise needs a positive discretization interval.";return out;
    }
    const double intervals=std::ceil(std::abs(dt)/noise.interval-1e-9);
    if(intervals>100000) {
        out.success=false;out.errorMessage="Process noise discretization exceeds 100000 intervals for this arc.";return out;
    }
    const int count=std::max(1,int(intervals));
    const double step=dt/count;
    StateVector state=initial;
    std::vector<double> phi(n*n,0.0),p=p0;for(unsigned i=0;i<n;++i)phi[i*n+i]=1;
    for(int k=0;k<count;++k) {
        const auto v=PropagateWithSTM(state,step,config,forces,method,density,burns,parameters);
        if(!v.success){out.success=false;out.errorMessage=v.errorMessage;return out;}
        const auto span=augmented(v);
        if(!p.empty()) {
            p=transport(span,p);
            const Mat6 q=WhiteAccelerationNoise(noise,std::abs(step),v.finalState);
            for(unsigned i=0;i<6;++i)for(unsigned j=0;j<6;++j)p[i*n+j]+=q.m[i][j];
        }
        phi=product(span,phi);
        state=v.finalState;
        out.steps+=v.steps;out.rejections+=v.rejections;
    }
    out.finalState=state;out.phi=phi;out.covariance=p;
    for(unsigned i=0;i<6;++i){for(unsigned j=0;j<6;++j)out.stm.m[i][j]=phi[i*n+j];}
    out.sensitivity.assign(6*np,0.0);for(unsigned i=0;i<6;++i)for(unsigned k=0;k<np;++k)out.sensitivity[i*np+k]=phi[i*n+6+k];
    return out;
}
}}
