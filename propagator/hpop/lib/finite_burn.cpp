#include "finite_burn.h"
#include "rk_augmented.h"
#include "../../events/src/event_locator.hpp"
#include <algorithm>
#include <cmath>
#include <limits>

namespace astro { namespace Integrator {
namespace {
constexpr int N = 7 + 49 + 2 * MaxFiniteBurns;
constexpr double g0 = 9.80665; // exact standard gravity, m/s^2
constexpr double eventTolerance = 1e-9; // seconds, independent of JD rounding
struct Context {
    ForceModel::ForceModelSet forces;
    const std::vector<FiniteBurn>& burns;
    ForceModel::DensityGradient density;
    double epoch;
    std::vector<int> status;
    std::vector<double> throttle;
    const char* error = nullptr;
    bool massStageError = false;
};
double component(const Vec3& v, int i) { return i==0?v.x:i==1?v.y:v.z; }
Vec3 basis(int i) { return Vec3(i==0,i==1,i==2); }
bool finite(const Vec3& v) { return std::isfinite(v.x)&&std::isfinite(v.y)&&std::isfinite(v.z); }
Vec3 unitDerivative(const Vec3& u, const Vec3& dx, double length) {
    return (dx-u*u.dot(dx))/length;
}
// Exact chain rule for normalized direction and moving orbital triads.
bool direction(const FiniteBurn& b, double t, const Vec3& r, const Vec3& v,
               Vec3& u, Vec3 derivatives[6]) {
    if(b.frame==BurnFrame::Velocity||b.frame==BurnFrame::AntiVelocity) {
        const double speed=v.magnitude(); if(!(speed>0))return false;
        const double sign=b.frame==BurnFrame::Velocity?1:-1;
        const Vec3 vh=v/speed; u=vh*sign;
        for(int j=0;j<6;++j) derivatives[j]=j<3?Vec3():unitDerivative(vh,basis(j-3),speed)*sign;
        return true;
    }
    Vec3 d=b.direction+b.steeringRate*t;
    const double length=d.magnitude(); if(!(length>1e-14)||!std::isfinite(length))return false;
    d=d/length;
    if(b.frame==BurnFrame::Inertial) {u=d;for(auto j=0;j<6;++j)derivatives[j]=Vec3();return true;}
    const double rr=r.magnitude(),vv=v.magnitude();
    const Vec3 h=r.cross(v);const double hh=h.magnitude();
    if(!(rr>0&&vv>0&&hh>1e-14*rr*vv))return false;
    const Vec3 normal=h/hh;
    const Vec3 first=b.frame==BurnFrame::RTN?r/rr:v/vv;
    const Vec3 second=b.frame==BurnFrame::RTN?normal.cross(first):normal;
    const Vec3 third=b.frame==BurnFrame::RTN?normal:first.cross(normal);
    u=first*d.x+second*d.y+third*d.z;
    for(int j=0;j<6;++j) {
        const Vec3 dr=j<3?basis(j):Vec3(),dv=j>=3?basis(j-3):Vec3();
        const Vec3 dn=unitDerivative(normal,dr.cross(v)+r.cross(dv),hh);
        const Vec3 df=b.frame==BurnFrame::RTN?unitDerivative(first,dr,rr):unitDerivative(first,dv,vv);
        const Vec3 ds=b.frame==BurnFrame::RTN?dn.cross(first)+normal.cross(df):dn;
        const Vec3 dz=b.frame==BurnFrame::RTN?dn:df.cross(normal)+first.cross(dn);
        derivatives[j]=df*d.x+ds*d.y+dz*d.z;
    }
    return true;
}
void derivative(double t,const double* y,double* f,void* opaque) {
    auto& c=*static_cast<Context*>(opaque);std::fill(f,f+N,0.0);
    if(c.error)return;
    const Vec3 r(y[0],y[1],y[2]),v(y[3],y[4],y[5]);
    const double mass=y[6];
    if(!(mass>0)||!std::isfinite(mass)){c.error="Finite burn exhausted spacecraft mass.";c.massStageError=true;return;}
    c.forces.drag.mass=mass;c.forces.srp.mass=mass;
    if((c.error=ForceModel::ValidateAccelerationPartials(r,c.forces)))return;
    const double jd=c.epoch+t/86400.0;
    auto a=ForceModel::ComputeAccelerationPartials(r,v,jd,c.forces,c.density);
    double A[7][7]{};
    for(int i=0;i<3;++i) {
        f[i]=y[i+3];f[i+3]=component(a.acceleration,i);A[i][i+3]=1;
        for(int j=0;j<3;++j){A[i+3][j]=a.dr[i][j];A[i+3][j+3]=a.dv[i][j];}
    }
    // Drag and cannonball SRP scale exactly as 1/m. Their state partials above
    // use the current mass; this column carries their mass dependence too.
    if(c.forces.useDrag||c.forces.useSRP) {
        auto independent=c.forces;independent.useDrag=false;independent.useSRP=false;
        const auto other=ForceModel::ComputeAccelerationPartials(r,v,jd,independent,c.density);
        for(int i=0;i<3;++i)A[i+3][6]=-(component(a.acceleration,i)-component(other.acceleration,i))/mass;
    }
    for(size_t k=0;k<c.burns.size();++k) if(c.status[k]==1&&c.throttle[k]>0) {
        const auto& b=c.burns[k];Vec3 u,du[6];
        if(!direction(b,t,r,v,u,du)){c.error="Singular finite-burn direction or orbital frame.";return;}
        const bool acceleration=b.accelerationKmS2>0;
        const double thrust=acceleration?1000*mass*b.accelerationKmS2:b.thrustNewtons;
        const double mag=thrust*c.throttle[k]/(1000*mass);
        const double flow=thrust*c.throttle[k]/(b.ispSeconds*g0);
        f[6]-=flow;
        for(int i=0;i<3;++i) {
            f[i+3]+=mag*component(u,i);
            for(int j=0;j<6;++j)A[i+3][j]+=mag*component(du[j],i);
            if(!acceleration)A[i+3][6]-=mag*component(u,i)/mass;
        }
        if(acceleration)A[6][6]-=flow/mass;
        f[56+2*k]=mag;f[57+2*k]=flow;
    }
    for(int i=0;i<7;++i)for(int j=0;j<7;++j)
        for(int k=0;k<7;++k)f[7+i*7+j]+=A[i][k]*y[7+k*7+j];
}
void step(double t,double h,const double* y,double* next,double* error,
          const IntegratorConfig& cfg,Context& c) {
    if(cfg.method==IntegrationMethod::RK4)rk_detail::rk4Step<N>(t,h,y,next,error,derivative,&c);
    else if(cfg.method==IntegrationMethod::RKF45||cfg.method==IntegrationMethod::Cowell)
        rk_detail::cashKarpStep<N>(t,h,y,next,error,derivative,&c);
    else {
        // Fehlberg's 7/8 weights differ only at repeated endpoint abscissae.
        // For a prescribed time force (e.g. T/(m0-mdot*t)) its embedded
        // estimate can be identically zero while quadrature error is finite.
        // Independent step doubling controls this null space as well as Phi.
        double whole[N],wholeError[N],half[N],halfError[N];
        rk_detail::rkf78Step<N>(t,h,y,whole,wholeError,derivative,&c);
        if(c.error)return;
        rk_detail::rkf78Step<N>(t,h*.5,y,half,halfError,derivative,&c);
        if(c.error)return;
        rk_detail::rkf78Step<N>(t+h*.5,h*.5,half,next,error,derivative,&c);
        if(c.error)return;
        for(int j=0;j<N;++j)error[j]=std::max({std::abs(error[j]),std::abs(halfError[j]),
            std::abs(wholeError[j]),std::abs(next[j]-whole[j])});
    }
}
// Reuse the event module's scalar stopping-condition interface. Its state
// source contract is SI; convert at the boundary, never inside HPOP physics.
int32_t scalar(void* opaque,double,const double* si,double* value) {
    const auto kind=*static_cast<const BurnEventKind*>(opaque);
    Vec3 r(si[0]*.001,si[1]*.001,si[2]*.001),v(si[3]*.001,si[4]*.001,si[5]*.001);
    if(kind==BurnEventKind::Radius)*value=r.magnitude();
    else if(kind==BurnEventKind::Speed)*value=v.magnitude();
    else if(kind==BurnEventKind::Node)*value=r.z;
    else if(kind==BurnEventKind::RadialVelocity)*value=r.dot(v)/r.magnitude();
    else return 1;
    return std::isfinite(*value)?0:1;
}
double eventValue(const BurnEvent& e,const double* y) {
    if(e.kind==BurnEventKind::Mass)return y[6]-e.goal;
    double si[6];for(int j=0;j<6;++j)si[j]=y[j]*1000;
    auto kind=e.kind;
    sdn::events::StoppingContext ctx;ctx.scalar=scalar;ctx.scalarContext=&kind;ctx.goal=e.goal;
    double value=std::numeric_limits<double>::quiet_NaN();
    sdn::events::stoppingFunction(&ctx,0,si,&value);return value;
}
std::array<double,7> eventGradient(const BurnEvent& e,const double* y) {
    std::array<double,7> n{};Vec3 r(y[0],y[1],y[2]),v(y[3],y[4],y[5]);
    if(e.kind==BurnEventKind::Radius)for(int j=0;j<3;++j)n[j]=component(r,j)/r.magnitude();
    if(e.kind==BurnEventKind::Speed)for(int j=0;j<3;++j)n[j+3]=component(v,j)/v.magnitude();
    if(e.kind==BurnEventKind::Node)n[2]=1;
    if(e.kind==BurnEventKind::Mass)n[6]=1;
    if(e.kind==BurnEventKind::RadialVelocity){
        const double rr=r.magnitude(),rv=r.dot(v);
        for(int j=0;j<3;++j){n[j]=component(v,j)/rr-rv*component(r,j)/(rr*rr*rr);n[j+3]=component(r,j)/rr;}
    }
    return n;
}
bool crossing(double a,double b,int direction) {
    if(!std::isfinite(a)||!std::isfinite(b)||a==0)return false;
    return (a<0&&b>=0&&direction>=0)||(a>0&&b<=0&&direction<=0);
}
void leftMultiply(double* y,const Matrix7& matrix) {
    double p[49]{};
    for(int i=0;i<7;++i)for(int j=0;j<7;++j)for(int k=0;k<7;++k)
        p[i*7+j]+=matrix[i*7+k]*y[7+k*7+j];
    std::copy(p,p+49,y+7);
}
Matrix7 identity(){Matrix7 m{};for(int i=0;i<7;++i)m[i*7+i]=1;return m;}
}
FiniteBurnResult PropagateFiniteBurns(const StateVector& initial,double mass,double dt,
    const IntegratorConfig& cfg,const ForceModel::ForceModelSet& forces,
    const std::vector<FiniteBurn>& burns,ForceModel::DensityGradient density,
    const std::vector<ForceModel::ImpulsiveManeuverDef>& impulses) {
    FiniteBurnResult out;out.finalState=initial;out.massKg=mass;out.stm=identity();out.burns.resize(burns.size());
    auto fail=[&](const char* msg){out.success=false;out.errorMessage=msg;return out;};
    if(!std::isfinite(dt)||dt<0||!std::isfinite(initial.epoch)||!std::isfinite(initial.epoch+dt/86400)||
       !finite(initial.position)||!finite(initial.velocity)||!(initial.position.magnitude()>0)||
       !std::isfinite(initial.position.magnitude())||!std::isfinite(initial.velocity.magnitude())||
       !(mass>0)||!std::isfinite(mass))return fail("Finite burns require finite forward state, epoch, duration and positive mass.");
    if(!(cfg.initialStep>0&&cfg.minStep>0&&cfg.maxStep>=cfg.minStep&&cfg.absTolerance>0&&cfg.relTolerance>=0&&cfg.maxSteps>0)||
       !std::isfinite(cfg.initialStep+cfg.minStep+cfg.maxStep+cfg.absTolerance+cfg.relTolerance))return fail("Invalid finite-burn step controls.");
    if(cfg.method!=IntegrationMethod::RK4&&cfg.method!=IntegrationMethod::RKF45&&cfg.method!=IntegrationMethod::Cowell&&
       cfg.method!=IntegrationMethod::RKF78&&cfg.method!=IntegrationMethod::RK78)return fail("Finite burns support RK4, RKF45, RKF78, RK78 and COWELL.");
    if(burns.size()>MaxFiniteBurns)return fail("At most 16 finite burns per arc.");
    if(forces.hasFiniteManeuver)return fail("Legacy fixed-mass finite maneuver cannot be combined with mass-state propagation.");
    if(const char* e=ForceModel::ValidateAccelerationPartials(initial.position,forces))return fail(e);
    for(const auto& b:burns) {
        if(!std::isfinite(b.startSeconds+b.stopSeconds)||b.startSeconds<0||!(b.stopSeconds>b.startSeconds)||
           !std::isfinite(b.thrustNewtons+b.accelerationKmS2+b.ispSeconds)||b.thrustNewtons<0||b.accelerationKmS2<0||
           ((b.thrustNewtons>0)==(b.accelerationKmS2>0))||!(b.ispSeconds>0)||!finite(b.direction)||!finite(b.steeringRate))
            return fail("Invalid finite-burn window, thrust/acceleration, Isp or steering.");
        if(b.frame<BurnFrame::Inertial||b.frame>BurnFrame::AntiVelocity)return fail("Invalid finite-burn frame.");
        if(b.frame==BurnFrame::Velocity||b.frame==BurnFrame::AntiVelocity) {
            if(b.steeringRate.magnitude()!=0)return fail("Velocity-aligned burns do not accept steeringRate.");
        } else {
            // A linear steering vector must not cross zero anywhere in its window.
            const double q=b.steeringRate.dot(b.steeringRate);
            const double at=q>0?std::clamp(-b.direction.dot(b.steeringRate)/q,b.startSeconds,b.stopSeconds):b.startSeconds;
            if(!((b.direction+b.steeringRate*at).magnitude()>1e-14))return fail("Linear steering crosses a zero direction.");
        }
        double last=-1;
        for(const auto& p:b.throttle){if(!std::isfinite(p.seconds+p.throttle)||p.seconds<0||p.seconds<=last||p.throttle<0||p.throttle>1)
            return fail("Throttle times must be strictly increasing, nonnegative; throttle must be in [0,1].");last=p.seconds;}
        for(const auto& e:{b.startEvent,b.stopEvent})if(e.kind<BurnEventKind::None||e.kind>BurnEventKind::Mass||
            !std::isfinite(e.goal)||e.direction< -1||e.direction>1)return fail("Invalid finite-burn event condition.");
    }
    auto kicks=impulses;std::stable_sort(kicks.begin(),kicks.end(),[](const auto&a,const auto&b){return a.epoch<b.epoch;});
    for(const auto& b:kicks)if(!std::isfinite(b.epoch)||!finite(b.deltaV))return fail("Invalid impulsive maneuver.");
    Context c{forces,burns,density,initial.epoch,std::vector<int>(burns.size()),std::vector<double>(burns.size(),1)};
    c.forces.weather.epoch=initial.epoch;
    double y[N]{},next[N],error[N];
    for(int j=0;j<3;++j){y[j]=component(initial.position,j);y[j+3]=component(initial.velocity,j);}y[6]=mass;
    for(int j=0;j<7;++j)y[7+j*7+j]=1;
    const double rr=std::max(1.0,initial.position.magnitude()),vv=std::max(1e-6,initial.velocity.magnitude());
    const double scales[]={rr,rr,rr,vv,vv,vv,mass};
    auto norm=[&](const double* next,const double* err){double n=0;
        for(int j=0;j<N;++j){
            if(!std::isfinite(next[j])||!std::isfinite(err[j]))return std::numeric_limits<double>::infinity();
            const double unit=j>=7&&j<56?scales[(j-7)%7]/scales[(j-7)/7]:1;
            n=std::max(n,std::abs(err[j]*unit)/(cfg.absTolerance+cfg.relTolerance*std::abs(next[j]*unit)));
        }return n;};
    double t=0,h=std::clamp(cfg.initialStep,cfg.minStep,cfg.maxStep);uint64_t attempts=0;size_t kick=0;
    auto mark=[&](size_t k,bool start){c.status[k]=start?1:2;auto& s=out.burns[k];
        if(start){s.started=true;s.startSeconds=t;}else{s.stopped=s.started;s.stopSeconds=s.started?t:-1;}};
    while(true) {
        // Scheduled edges are processed between stages, so endpoint stages see
        // the smooth one-sided force of their own segment (including throttle).
        for(size_t k=0;k<burns.size();++k){const auto& b=burns[k];
            if(c.status[k]!=2&&t>=b.stopSeconds)mark(k,false);
            if(c.status[k]==0&&t>=b.startSeconds&&b.startEvent.kind==BurnEventKind::None)mark(k,true);
            c.throttle[k]=1;for(const auto& p:b.throttle)if(p.seconds<=t)c.throttle[k]=p.throttle;else break;
        }
        while(kick<kicks.size()&&(kicks[kick].epoch-initial.epoch)*86400<=t){const auto& b=kicks[kick++];
            if(b.executed||b.epoch<=initial.epoch)continue;
            Vec3 r(y[0],y[1],y[2]),v(y[3],y[4],y[5]);
            if(b.inRTN&&r.cross(v).magnitude()==0)return fail("Singular RTN impulse frame.");
            const Mat6 jump=ForceModel::ImpulsiveManeuverJacobian(r,v,b);Matrix7 m=identity();
            for(int i=0;i<6;++i)for(int j=0;j<6;++j)m[i*7+j]=jump.m[i][j];leftMultiply(y,m);
            v=ForceModel::ImpulsiveManeuver(v,r,b);for(int j=0;j<3;++j)y[j+3]=component(v,j);
        }
        if(t>=dt)break;
        if(out.steps>=cfg.maxSteps||++attempts>uint64_t(cfg.maxSteps)*10)return fail("Finite-burn integration exhausted maxSteps.");
        double edge=dt;
        for(const auto& b:burns){if(b.startSeconds>t)edge=std::min(edge,b.startSeconds);if(b.stopSeconds>t)edge=std::min(edge,b.stopSeconds);
            for(const auto& p:b.throttle)if(p.seconds>t)edge=std::min(edge,p.seconds);}
        if(kick<kicks.size()){double kt=(kicks[kick].epoch-initial.epoch)*86400;if(kt>t)edge=std::min(edge,kt);}
        h=std::min(h,edge-t);if(t+h==t)return fail("Finite-burn integration step underflow.");
        step(t,h,y,next,error,cfg,c);
        // A trial stage may overshoot depletion before a positive-mass cutoff
        // can be bracketed. Reject and retry; only accepted states locate roots.
        if(c.error&&c.massStageError&&h>cfg.minStep){
            c.error=nullptr;c.massStageError=false;++out.rejections;
            h=std::max(cfg.minStep,h*.5);continue;
        }
        if(c.error)return fail(c.error);
        double n=norm(next,error);const bool fixed=cfg.method==IntegrationMethod::RK4;
        const int order=(cfg.method==IntegrationMethod::RKF45||cfg.method==IntegrationMethod::Cowell)?5:8;
        if(!std::isfinite(n))return fail("Non-finite finite-burn state or derivative.");
        if(!fixed&&n>1){++out.rejections;if(h<=cfg.minStep*(1+1e-12))return fail("Finite-burn tolerance cannot be met at minStep.");
            h=std::max(cfg.minStep,ComputeOptimalStep(h,n,order,0.9,0.1,1.0));continue;}
        // Search only accepted steps. The force mode is frozen during root
        // refinement; every candidate is reintegrated from the accepted state.
        int eventIndex=-1;double eventTime=t+h;BurnEvent selected;
        double endpointFlow[N];bool haveEndpointFlow=false;
        for(size_t k=0;k<burns.size();++k) {
            if(c.status[k]==2||t<burns[k].startSeconds)continue;
            const auto& e=c.status[k]==0?burns[k].startEvent:burns[k].stopEvent;
            if(e.kind==BurnEventKind::None)continue;
            double a=eventValue(e,y),b=eventValue(e,next);
            const bool bracketed=crossing(a,b,e.direction);
            bool endpointRoot=false;
            if(!bracketed&&a!=0){
                if(!haveEndpointFlow){derivative(t+h,next,endpointFlow,&c);haveEndpointFlow=true;}
                if(c.error)return fail(c.error);
                const auto gradient=eventGradient(e,next);double rate=0;
                for(int j=0;j<7;++j)rate+=gradient[j]*endpointFlow[j];
                endpointRoot=std::isfinite(rate)&&std::abs(rate)>0&&std::abs(b)<=eventTolerance*std::abs(rate)&&
                    ((a<0&&rate>0&&e.direction>=0)||(a>0&&rate<0&&e.direction<=0));
            }
            if(!bracketed&&!endpointRoot)continue;
            double root=0,residual=0;int32_t iterations=0;
            auto evaluate=[&](double at,double* value){double local[N],err[N];step(t,at-t,y,local,err,cfg,c);
                if(c.error)return false;*value=eventValue(e,local);return std::isfinite(*value);};
            if(endpointRoot)root=t+h;
            else if(!sdn::events::brentRoot(evaluate,t,t+h,a,b,eventTolerance,100,&root,&residual,&iterations))return fail("Finite-burn event refinement failed.");
            if(eventIndex>=0&&std::abs(root-eventTime)<=eventTolerance)return fail("Simultaneous state-triggered burn edges have ambiguous ordering.");
            if(eventIndex<0||root<eventTime){eventTime=root;eventIndex=int(k);selected=e;}
        }
        if(eventIndex>=0){
            // min(event time, scheduled edge) has no unique classical
            // derivative at a tie. Do not present one branch's STM as both.
            auto coincides=[&](double at){return std::abs(eventTime-at)<=eventTolerance;};
            bool ambiguous=coincides(dt);
            for(const auto& b:burns){
                ambiguous=ambiguous||coincides(b.startSeconds)||coincides(b.stopSeconds);
                for(const auto& p:b.throttle)ambiguous=ambiguous||coincides(p.seconds);
            }
            for(const auto& b:kicks)if(!b.executed)ambiguous=ambiguous||coincides((b.epoch-initial.epoch)*86400);
            if(ambiguous)return fail("State-triggered burn edge coincides with a scheduled edge or output epoch; no unique STM.");
            h=eventTime-t;
            // A transverse root can round to the accepted boundary when its
            // residual is at floating-point noise. Switch there, without an
            // artificial minStep delay. The mode changes, so it cannot repeat.
            if(h==0){std::copy(y,y+N,next);std::fill(error,error+N,0.0);}
            else step(t,h,y,next,error,cfg,c);
            if(c.error)return fail(c.error);n=norm(next,error);
            if(!fixed&&n>1){++out.rejections;if(h<=cfg.minStep)return fail("Finite-burn event tolerance cannot be met at minStep.");h=std::max(cfg.minStep,h*.5);continue;}}
        std::copy(next,next+N,y);t=(eventIndex>=0)?eventTime:(h==edge-t?edge:t+h);++out.steps;
        if(eventIndex>=0){
            double before[N],after[N];derivative(t,y,before,&c);const auto gradient=eventGradient(selected,y);
            const bool starting=c.status[eventIndex]==0;
            mark(eventIndex,starting);
            if(starting)out.burns[eventIndex].startByEvent=true;else out.burns[eventIndex].stopByEvent=true;
            derivative(t,y,after,&c);if(c.error)return fail(c.error);
            double denom=0,scale=0;for(int j=0;j<7;++j){denom+=gradient[j]*before[j];scale+=std::abs(gradient[j]*before[j]);}
            if(!std::isfinite(denom)||std::abs(denom)<=1e-12*std::max(1e-12,scale))return fail("Grazing finite-burn event has no finite STM.");
            Matrix7 saltation=identity();for(int i=0;i<7;++i)for(int j=0;j<7;++j)saltation[i*7+j]+=(after[i]-before[i])*gradient[j]/denom;
            leftMultiply(y,saltation);
        }
        h=std::clamp(fixed||h==0?cfg.initialStep:ComputeOptimalStep(h,n,order),cfg.minStep,cfg.maxStep);
    }
    out.finalState.position=Vec3(y[0],y[1],y[2]);out.finalState.velocity=Vec3(y[3],y[4],y[5]);out.finalState.epoch=initial.epoch+dt/86400;
    out.massKg=y[6];std::copy(y+7,y+56,out.stm.begin());
    for(size_t k=0;k<burns.size();++k){out.burns[k].deltaVKmS=y[56+2*k];out.burns[k].propellantKg=y[57+2*k];}
    return out;
}
Matrix7 TransportFiniteCovariance(const Matrix7& phi,const Matrix7& covariance) {
    Matrix7 tmp{},out{};for(int i=0;i<7;++i)for(int j=0;j<7;++j)for(int k=0;k<7;++k)tmp[i*7+j]+=phi[i*7+k]*covariance[k*7+j];
    for(int i=0;i<7;++i)for(int j=0;j<7;++j)for(int k=0;k<7;++k)out[i*7+j]+=tmp[i*7+k]*phi[j*7+k];return out;
}
}}
