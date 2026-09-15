// Independent HPOP variational-equation acceptance evidence.
// Sources (Richard H. Battin, MIT 16.346, Fall 2008):
// [K] Lecture 4, equations (4.41), (4.43), eccentric-anomaly initial value solution:
// https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/87431d1d0bfd2488fe402067e0afcb59_lec_04.pdf
// [C] Lecture 26, circular two-body relative-motion solution (RTN rearrangement):
// https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/e4f0632a9f1c98f7e9b25492e1a30eb1_lec_26.pdf
// [S] Lecture 19, dPhi/dt=A Phi and Phi^T J Phi=J for symmetric gravity Hessians:
// https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/a88bf1b4e2238cd921b395993a22bb28_lec_19.pdf
// [P] Lecture 22, covariance as the second central moment:
// https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/311d5c5c6ad73b874fc534fb20e2081a_lec_22.pdf
// [W] NIST, Wishart distribution of Gaussian sample variance-covariance matrices:
// https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/wishrand.htm
// Units/frame/time for ALL cases: km, km/s, seconds; Earth-centred inertial
// J2000 axes, initial epoch JD2451545.0 TDB, elapsed dynamical seconds. Gravity
// constants are explicit model inputs, NOT claimed observational estimates.
// Phi has rr,vv dimensionless, rv seconds, vr inverse seconds. Compare
// D^-1 Phi D, D=diag(1,1,1,n,n,n), a units-balanced nondimensional matrix.
// References are evaluated from closed-form equations or statistical identities,
// never captured outputs of the new implementation. Native evidence supplements
// (does not substitute for) the SDK's same-byte WASM/runtime checks.

#include "variational.h"
#include "integrators.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace astro;
using Matrix = std::array<std::array<long double, 6>, 6>;
using Vector = std::array<long double, 6>;
constexpr long double mu = 398600.4418L;
constexpr long double pi = 3.141592653589793238462643383279502884L;
static int failures = 0, cases = 0;

static Vector values(const StateVector& s) {
    return {s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z};
}
static StateVector state(const Vector& x) {
    return {{double(x[0]), double(x[1]), double(x[2])},
            {double(x[3]), double(x[4]), double(x[5])}, 2451545.0};
}
static Matrix matrix(const Mat6& a) {
    Matrix result{};
    for (int i=0;i<6;++i) for (int j=0;j<6;++j) result[i][j]=a.m[i][j];
    return result;
}
static Matrix identity() {
    Matrix a{}; for(int i=0;i<6;++i) a[i][i]=1; return a;
}
static Matrix multiply(const Matrix& a,const Matrix& b) {
    Matrix c{};
    for(int i=0;i<6;++i) for(int j=0;j<6;++j) for(int k=0;k<6;++k) c[i][j]+=a[i][k]*b[k][j];
    return c;
}
static Matrix transpose(const Matrix& a) {
    Matrix b{};for(int i=0;i<6;++i) for(int j=0;j<6;++j) b[i][j]=a[j][i];return b;
}
static Matrix balanced(Matrix a,long double n) {
    for(int i=0;i<6;++i) for(int j=0;j<6;++j) a[i][j]*=(j<3?1:n)/(i<3?1:n);
    return a;
}
static long double relative(const Matrix& actual,const Matrix& expected,long double n) {
    const auto a=balanced(actual,n),b=balanced(expected,n);long double error=0,scale=0;
    for(int i=0;i<6;++i) for(int j=0;j<6;++j) {error+=(a[i][j]-b[i][j])*(a[i][j]-b[i][j]);scale+=b[i][j]*b[i][j];}
    return std::sqrt(error/scale);
}
static long double determinant(Matrix a) {
    long double d=1;
    for(int k=0;k<6;++k) {
        int pivot=k;for(int i=k+1;i<6;++i) if(std::abs(a[i][k])>std::abs(a[pivot][k])) pivot=i;
        if(pivot!=k) {std::swap(a[pivot],a[k]);d=-d;}
        d*=a[k][k];
        if(a[k][k]==0) return 0;
        for(int i=k+1;i<6;++i) {const auto factor=a[i][k]/a[k][k];for(int j=k+1;j<6;++j) a[i][j]-=factor*a[k][j];}
    }
    return d;
}
static long double symplectic(const Matrix& phi,long double n) {
    Matrix j{};for(int i=0;i<3;++i) {j[i][i+3]=1;j[i+3][i]=-1;}
    const auto p=balanced(phi,n),q=multiply(multiply(transpose(p),j),p);long double error=0;
    for(int i=0;i<6;++i) for(int k=0;k<6;++k) error=std::max(error,std::abs(q[i][k]-j[i][k]));
    return error;
}
static void check(const std::string& name,long double value,long double tolerance) {
    const bool ok=std::isfinite(value)&&value<=tolerance;++cases;if(!ok) ++failures;
    std::cout<<"RESULT "<<name<<' '<<value<<' '<<tolerance<<' '<<(ok?"PASS":"FAIL")<<'\n';
}

// Exact first derivative of the nonlinear Kepler flow from [K]. Derivatives of
// the eccentric anomaly follow implicit differentiation of (4.43), not finite
// differences, automatic differentiation of HPOP, or another ODE integration.
static Matrix keplerSTM(const StateVector& initial,long double dt,Vector* finalState=nullptr) {
    const auto x=values(initial);
    const long double r=std::sqrt(x[0]*x[0]+x[1]*x[1]+x[2]*x[2]);
    const long double vv=x[3]*x[3]+x[4]*x[4]+x[5]*x[5];
    const long double sigma=(x[0]*x[3]+x[1]*x[4]+x[2]*x[5])/std::sqrt(mu);
    const long double a=1/(2/r-vv/mu),rootA=std::sqrt(a),n=std::sqrt(mu/(a*a*a));
    const long double beta=sigma/rootA,gamma=1-r/a;
    long double e=n*dt;
    for(int k=0;k<30;++k) {
        const auto residual=e+beta*(1-std::cos(e))-gamma*std::sin(e)-n*dt;
        e-=residual/(1+beta*std::sin(e)-gamma*std::cos(e));
    }
    const long double c=std::cos(e),s=std::sin(e),q=1-c;
    const long double R=a+(r-a)*c+sigma*rootA*s;
    const long double f=1-a/r*q,g=(a*sigma*q+r*rootA*s)/std::sqrt(mu);
    const long double k=std::sqrt(mu*a)/(R*r),fd=-k*s,gd=1-a/R*q;
    if(finalState) for(int i=0;i<3;++i) {
        (*finalState)[i]=f*x[i]+g*x[i+3];(*finalState)[i+3]=fd*x[i]+gd*x[i+3];
    }
    Matrix result{};
    for(int j=0;j<6;++j) {
        const long double dr=j<3?x[j]/r:0;
        const long double dvv=j>=3?2*x[j]:0;
        const long double dsigma=(j<3?x[j+3]:x[j-3])/std::sqrt(mu);
        const long double da=a*a*(2*dr/(r*r)+dvv/mu),dn=-1.5L*n*da/a;
        const long double dbeta=dsigma/rootA-.5L*beta*da/a,dgamma=-dr/a+r*da/(a*a);
        const long double de=(dn*dt-dbeta*q+dgamma*s)/(1+beta*s-gamma*c),dq=s*de;
        const long double df=-(da/r-a*dr/(r*r))*q-a/r*dq;
        const long double dg=((da*sigma+a*dsigma)*q+a*sigma*dq+
                             (dr*rootA+r*.5L*da/rootA)*s+r*rootA*c*de)/std::sqrt(mu);
        const long double dR=da+(dr-da)*c-(r-a)*s*de+
                             (dsigma*rootA+sigma*.5L*da/rootA)*s+sigma*rootA*c*de;
        const long double dk=k*(.5L*da/a-dR/R-dr/r),dfd=-dk*s-k*c*de;
        const long double dgd=-(da/R-a*dR/(R*R))*q-a/R*dq;
        for(int i=0;i<3;++i) {
            result[i][j]=df*x[i]+dg*x[i+3]+(j==i?f:0)+(j==i+3?g:0);
            result[i+3][j]=dfd*x[i]+dgd*x[i+3]+(j==i?fd:0)+(j==i+3?gd:0);
        }
    }
    return result;
}

// [C], radial/along-track/normal convention. Convert rotating velocities at
// BOTH endpoints: delta_v_inertial = R(delta_v_RTN + Omega delta_r_RTN).
static Matrix circularSTM(long double n,long double t) {
    const auto theta=n*t,c=std::cos(theta),s=std::sin(theta);Matrix cw{};
    cw[0][0]=4-3*c;cw[0][3]=s/n;cw[0][4]=2*(1-c)/n;
    cw[1][0]=6*(s-theta);cw[1][1]=1;cw[1][3]=2*(c-1)/n;cw[1][4]=(4*s-3*theta)/n;
    cw[2][2]=c;cw[2][5]=s/n;
    cw[3][0]=3*n*s;cw[3][3]=c;cw[3][4]=2*s;
    cw[4][0]=6*n*(c-1);cw[4][3]=-2*s;cw[4][4]=4*c-3;
    cw[5][2]=-n*s;cw[5][5]=c;
    auto initial=identity(),final=identity();initial[3][1]=n;initial[4][0]=-n;
    final[3][1]=-n;final[4][0]=n;
    Matrix rotation{};
    for(int offset:{0,3}) {rotation[offset][offset]=c;rotation[offset][offset+1]=-s;
        rotation[offset+1][offset]=s;rotation[offset+1][offset+1]=c;rotation[offset+2][offset+2]=1;}
    return multiply(multiply(rotation,final),multiply(cw,initial));
}

static IntegratorConfig accurateConfig(double maxStep=20) {
    IntegratorConfig c;c.method=IntegrationMethod::RKF78;c.initialStep=10;c.minStep=.001;
    c.maxStep=maxStep;c.absTolerance=1e-14;c.relTolerance=1e-14;c.maxSteps=1000000;return c;
}
static Integrator::VariationalResult analytic(const StateVector& s,double dt,
        const IntegratorConfig& config,ForceModel::ForceModelSet& force) {
    const auto result=Integrator::PropagateVariational(s,dt,config,force);
    if(!result.success) throw std::runtime_error("variational failure: "+result.errorMessage);
    return result;
}
static StateVector propagate(const StateVector& s,double dt,
        const IntegratorConfig& config,ForceModel::ForceModelSet& force) {
    const auto result=Integrator::PropagateWithResult(s,dt,config,force);
    if(!result.success) throw std::runtime_error("state failure: "+result.errorMessage);
    return result.finalState;
}
static Matrix finiteDifference(const StateVector& s,double dt,const IntegratorConfig& config,
        ForceModel::ForceModelSet& force,long double h=0.01L) {
    Matrix result{};
    for(int j=0;j<6;++j) {
        const auto step=j<3?h:h*.001L;auto plus=values(s),minus=plus;plus[j]+=step;minus[j]-=step;
        // Use the actual representable initial-state separation in the quotient.
        const auto p=state(plus),m=state(minus);
        const auto denominator=values(p)[j]-values(m)[j];
        const auto yp=values(propagate(p,dt,config,force)),ym=values(propagate(m,dt,config,force));
        for(int i=0;i<6;++i) result[i][j]=(yp[i]-ym[i])/denominator;
    }
    return result;
}

// Synthetic elliptic J2000 test state, independent perifocal geometry: a=9000km,
// e=.2, eccentric anomaly=.7rad, inclination=.63rad, node=.4rad.
static StateVector eccentricState() {
    constexpr long double a=9000,e=.2L,E=.7L,inc=.63L,node=.4L;
    const long double c=std::cos(E),s=std::sin(E),r=a*(1-e*c),beta=std::sqrt(1-e*e);
    const long double p[3]={std::cos(node),std::sin(node),0};
    const long double q[3]={-std::sin(node)*std::cos(inc),std::cos(node)*std::cos(inc),std::sin(inc)};
    Vector x{};
    for(int i=0;i<3;++i) {x[i]=a*((c-e)*p[i]+beta*s*q[i]);x[i+3]=std::sqrt(mu*a)/r*(-s*p[i]+beta*c*q[i]);}
    return state(x);
}

static void testKepler() {
    ForceModel::ForceModelSet force;force.gravityMode=ForceModel::GravityMode::PointMass;
    force.mu=double(mu);const auto config=accurateConfig();
    const long double radius=7000,n=std::sqrt(mu/(radius*radius*radius)),period=2*pi/n;
    const StateVector circular({double(radius),0,0},{0,double(n*radius),0},2451545.0);
    // 1e-9 normalized relative: integration-only numerical error, no physical
    // model discrepancy. Interior points prevent full-period cancellation masks.
    for(double fraction:{.125,.5,1.0}) {
        const double dt=double(fraction*period);
        const auto actual=matrix(analytic(circular,dt,config,force).stm);
        const auto cw=circularSTM(n,dt),kepler=keplerSTM(circular,dt);
        check("circular_references_"+std::to_string(fraction),relative(kepler,cw,n),1e-12L);
        check("kepler_circular_"+std::to_string(fraction),relative(actual,cw,n),1e-9L);
    }
    const auto s=eccentricState();const long double ne=std::sqrt(mu/(9000.L*9000.L*9000.L)),T=2*pi/ne;
    for(double fraction:{.125,.5,1.0}) {
        const double dt=double(fraction*T);const auto actual=matrix(analytic(s,dt,config,force).stm);
        const std::string name=fraction==1?"kepler_eccentric_1_orbit":"kepler_eccentric_"+std::to_string(fraction);
        check(name,relative(actual,keplerSTM(s,dt),ne),1e-9L);
    }
}

static StateVector leoState() {
    // 7000km radius, circular osculating speed, 51.6-degree inclination.
    const double v=std::sqrt(double(mu)/7000),i=51.6*double(pi)/180;
    return {{7000,0,0},{0,v*std::cos(i),v*std::sin(i)},2451545.0};
}
static void testJ2() {
    // J2 finite-difference cross-check of the FULL nonlinear flow; [S] supplies
    // independent Hamiltonian invariants. Force coefficients: mu above,
    // Re=6378.137km, J2=1.08262668e-3; fixed inertial symmetry axis z.
    auto force=ForceModel::ForceModelSet{};force.gravityMode=ForceModel::GravityMode::J2Only;
    const auto s=leoState();const long double n=std::sqrt(mu/(7000.L*7000.L*7000.L));
    const auto dt=double(2*pi/n);const auto config=accurateConfig(15);
    const auto actual=matrix(analytic(s,dt,config,force).stm);
    const auto coarse=finiteDifference(s,dt,config,force,.02L),fine=finiteDifference(s,dt,config,force,.01L);
    Matrix richardson{};
    for(int i=0;i<6;++i) for(int j=0;j<6;++j) richardson[i][j]=(4*fine[i][j]-coarse[i][j])/3;
    // h=20m/2cm/s and h/2, fourth-order Richardson cancellation. Tighter second
    // integration confirms the differencing error is below the requested1e-6.
    auto refined=config;refined.maxStep=7.5;refined.initialStep=7.5;
    const auto refinedFD=finiteDifference(s,dt,refined,force,.01L);
    check("J2_FD_step_convergence",relative(coarse,fine,n),1e-6L);
    check("J2_FD_integration_convergence",relative(fine,refinedFD,n),1e-6L);
    check("J2_STM_Richardson",relative(actual,richardson,n),1e-6L);
    // Unit determinant alone is necessary but insufficient: check the full
    // balanced symplectic matrix identity separately to1e-9, per [S].
    check("J2_determinant",std::abs(determinant(actual)-1),1e-9L);
    check("J2_symplectic",symplectic(actual,n),1e-9L);
}

// Platform-independent seeded uniforms + Box-Muller normals. No library-
// specific normal_distribution and no selection of seeds based on outcomes.
struct NormalGenerator {
    uint64_t state=0x202609150003ULL;
    long double uniform() {state+=0x9e3779b97f4a7c15ULL;auto z=state;z=(z^(z>>30))*0xbf58476d1ce4e5b9ULL;
        z=(z^(z>>27))*0x94d049bb133111ebULL;z^=z>>31;return ((z>>11)+.5L)/9007199254740992.L;}
    long double normal() {const auto u=uniform(),v=uniform();return std::sqrt(-2*std::log(u))*std::cos(2*pi*v);}
};
static Matrix sampleCovariance(const std::vector<Vector>& samples) {
    Vector mean{};for(const auto& x:samples) for(int i=0;i<6;++i) mean[i]+=x[i]/samples.size();
    Matrix covariance{};
    for(const auto& x:samples) for(int i=0;i<6;++i) for(int j=0;j<6;++j)
        covariance[i][j]+=(x[i]-mean[i])*(x[j]-mean[j])/(samples.size()-1);
    return covariance;
}
static void testCovariance() {
    // [P,W]: for N independent Gaussian states, Var(S_ij) =
    // (C_ij^2+C_ii*C_jj)/(N-1). All21 unique covariance entries must lie within
    // 4 standard errors; Gaussian-tail union bound is approximately0.0014.
    // sigmas10m and1cm/s keep nonlinear corrections small over one LEO orbit.
    // This is statistical consistency, not a claim of arbitrary covariance
    // linearity. A paired finite-sample check isolates the nonlinear residual.
    constexpr int count=1000;NormalGenerator random;
    const auto initial=leoState();const auto base=values(initial);
    const auto dt=double(2*pi/std::sqrt(mu/(7000.L*7000.L*7000.L)));
    auto force=ForceModel::ForceModelSet{};force.gravityMode=ForceModel::GravityMode::J2Only;
    const auto config=accurateConfig(30);const auto nominal=analytic(initial,dt,config,force);
    const auto phi=matrix(nominal.stm);const auto nominalValues=values(nominal.finalState);
    Mat6 covariance;for(int i=0;i<6;++i) covariance.m[i][i]=i<3?1e-4:1e-10;
    const auto predicted=matrix(Integrator::TransportCovariance(nominal.stm,covariance));
    std::vector<Vector> starts,ends;starts.reserve(count);ends.reserve(count);
    for(int k=0;k<count;++k) {
        auto x=base;Vector delta{};
        for(int i=0;i<6;++i) {delta[i]=random.normal()*(i<3?.01L:1e-5L);x[i]+=delta[i];}
        auto propagated=values(propagate(state(x),dt,config,force));
        for(int i=0;i<6;++i) propagated[i]-=nominalValues[i];
        starts.push_back(delta);ends.push_back(propagated);
    }
    const auto empirical=sampleCovariance(ends);
    const auto paired=multiply(multiply(phi,sampleCovariance(starts)),transpose(phi));
    long double maxZ=0,maxDiagonalRelative=0,nonlinear=0,scale=0;
    for(int i=0;i<6;++i) for(int j=i;j<6;++j) {
        const auto standardError=std::sqrt((predicted[i][j]*predicted[i][j]+predicted[i][i]*predicted[j][j])/(count-1));
        maxZ=std::max(maxZ,std::abs(empirical[i][j]-predicted[i][j])/standardError);
        if(i==j) maxDiagonalRelative=std::max(maxDiagonalRelative,std::abs(empirical[i][i]/predicted[i][i]-1));
        const auto normalization=std::sqrt(predicted[i][i]*predicted[j][j]);
        nonlinear+=std::pow((empirical[i][j]-paired[i][j])/normalization,2);scale+=1;
    }
    check("covariance_1000_Wishart_z",maxZ,4);
    check("covariance_1000_nonlinear_RMS",std::sqrt(nonlinear/scale),1e-3L);
    std::cout<<"METRIC covariance_1000_max_diagonal_relative="<<maxDiagonalRelative<<" seed=0x202609150003\n";
}

static void testScheduledImpulses() {
    // [K,S] plus the chain rule for a prescribed, fixed-time instantaneous
    // change: r+=r-, v+=v-+deltaV. Inertial constant deltaV has jump derivative
    // I. RTN deltaV differentiates the moving orbital triad; full scheduled
    // propagation is independently cross-checked by perturbing initial states.
    // DeltaV km/s, fixed burn epochs TDB; no uncertainty in execution epoch.
    ForceModel::ForceModelSet force;force.gravityMode=ForceModel::GravityMode::PointMass;
    const auto config=accurateConfig(20);const auto initial=leoState();
    const auto n=std::sqrt(mu/(7000.L*7000.L*7000.L)),period=2*pi/n;
    ForceModel::ImpulsiveManeuverDef inertial,rtn;
    inertial.epoch=initial.epoch+double(.3L*period)/86400;inertial.inRTN=false;
    inertial.deltaV={.008,-.011,.003};
    rtn.epoch=initial.epoch+double(.7L*period)/86400;rtn.inRTN=true;
    rtn.deltaV={-.007,.013,.009};
    const std::vector<ForceModel::ImpulsiveManeuverDef> burns={inertial,rtn};
    const double firstDuration=(inertial.epoch-initial.epoch)*86400;
    const auto atFirst=Integrator::PropagateWithSTM(initial,firstDuration,config,force,
        Integrator::STMMethod::Analytic,ForceModel::DensityGradient::Neglected,burns);
    if(!atFirst.success) throw std::runtime_error(atFirst.errorMessage);
    Vector expectedState{};const auto expectedSTM=keplerSTM(initial,firstDuration,&expectedState);
    expectedState[3]+=inertial.deltaV.x;expectedState[4]+=inertial.deltaV.y;expectedState[5]+=inertial.deltaV.z;
    const auto actualState=values(atFirst.finalState);long double stateError=0,stateScale=0;
    for(int i=0;i<6;++i) {const auto scale=i<3?1:1/n;
        stateError+=std::pow((actualState[i]-expectedState[i])*scale,2);stateScale+=std::pow(expectedState[i]*scale,2);}
    check("impulse_inertial_endpoint_state",std::sqrt(stateError/stateScale),1e-10L);
    check("impulse_inertial_endpoint_STM",relative(matrix(atFirst.stm),expectedSTM,n),1e-9L);
    // Each sample starts from the original epoch, so the second and final
    // samples include both earlier jumps instead of resetting covariance/STM.
    const std::array<double,3> targets={inertial.epoch,rtn.epoch,initial.epoch+double(period)/86400};
    for(int sample=0;sample<3;++sample) {
        const auto dt=(targets[sample]-initial.epoch)*86400;
        const auto a=Integrator::PropagateWithSTM(initial,dt,config,force,Integrator::STMMethod::Analytic,
            ForceModel::DensityGradient::Neglected,burns);
        const auto f=Integrator::PropagateWithSTM(initial,dt,config,force,Integrator::STMMethod::FiniteDifference,
            ForceModel::DensityGradient::Neglected,burns);
        if(!a.success||!f.success) throw std::runtime_error("scheduled impulse propagation: "+a.errorMessage+f.errorMessage);
        check("impulse_chain_sample_"+std::to_string(sample),relative(matrix(a.stm),matrix(f.stm),n),1e-6L);
        check("impulse_sample_epoch_"+std::to_string(sample),std::abs(a.finalState.epoch-targets[sample]),0);
    }
}

static void benchmark() {
    // Reproducible native microbenchmark, not a production-WASM speed claim.
    // Same J2 LEO arc, RKF78 tolerances1e-12 and max step60s in both paths.
    // The retained algorithm needs nominal+12 perturbed full integrations for
    // a central6-column STM. A/B/A controls drift; report raw durations, no
    // speed gate (host scheduling is not a numerical correctness condition).
    auto force=ForceModel::ForceModelSet{};force.gravityMode=ForceModel::GravityMode::J2Only;
    const auto s=leoState();auto config=accurateConfig(60);config.initialStep=30;
    config.relTolerance=1e-12;config.absTolerance=1e-12;
    using Clock=std::chrono::steady_clock;volatile double sink=0;
    constexpr int repetitions=100;
    const auto runAnalytic=[&]() {const auto start=Clock::now();for(int k=0;k<repetitions;++k) sink+=analytic(s,86400,config,force).stm.m[0][0];
        return std::chrono::duration<double,std::milli>(Clock::now()-start).count()/repetitions;};
    // Warm both implementations and memory before timing.
    sink+=analytic(s,600,config,force).stm.m[0][0];sink+=propagate(s,600,config,force).position.x;
    const double first=runAnalytic();const auto start=Clock::now();
    for(int k=0;k<repetitions;++k) {
        const auto result=Integrator::PropagateWithSTM(s,86400,config,force,Integrator::STMMethod::FiniteDifference);
        if(!result.success) throw std::runtime_error("finite-difference benchmark failure: "+result.errorMessage);
        sink+=result.finalState.position.x+result.stm.m[0][0];
    }
    const double finite=std::chrono::duration<double,std::milli>(Clock::now()-start).count()/repetitions;
    const double second=runAnalytic(),average=(first+second)/2;
    std::cout<<"TIMING 24h_LEO_J2 analytic_before_ms="<<first<<" finite_difference_ms="<<finite
             <<" analytic_after_ms="<<second<<" speedup="<<finite/average<<" repetitions="<<repetitions<<" nominal_plus_perturbed=13 sink="<<sink<<'\n';
}

// Deterministic oracle fixture generation from [K] alone; no production
// propagation, force evaluator, or STM implementation is called here.
static void emitReference() {
    std::cout<<std::setprecision(17);
    std::cout<<"{\n  \"source\": \"Battin, MIT16.346 Fall2008 lecture4 equations4.41 and4.43; analytic implicit differentiation; lecture26 circular CW independently cross-checks\",\n"
             <<"  \"source_url\": \"https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/87431d1d0bfd2488fe402067e0afcb59_lec_04.pdf\",\n"
             <<"  \"generator\": \"variational_native.cpp --emit-reference (independent closed-form Kepler flow only)\",\n"
             <<"  \"units\": \"state: km, km/s; stm: rr/vv dimensionless, rv s, vr 1/s; duration s\",\n"
             <<"  \"frame\": \"Earth-centred J2000 inertial\",\n  \"time_scale\": \"TDB\",\n  \"epoch_jd\": 2451545.0,\n"
             <<"  \"mu_km3_s2\": 398600.4418,\n  \"relative_stm_tolerance\": 1e-9,\n"
             <<"  \"tolerance_rationale\": \"Integration numerical error only; relative Frobenius of D^-1 Phi D with D=diag(1,1,1,n,n,n); no force model discrepancy\",\n"
             <<"  \"cases\": [\n";
    bool first=true;
    for(bool eccentric:{false,true}) {
        const long double a=eccentric?9000:7000,n=std::sqrt(mu/(a*a*a));
        const auto initial=eccentric?eccentricState():StateVector({7000,0,0},{0,double(n*7000),0},2451545.0);
        for(double fraction:{.3,1.0}) {
            // Invoke inputs serialize JD as doubles. Derive the duration from
            // that exact representable JD so an epoch-rounding difference does
            // not masquerade as a physical propagation error in strict tests.
            const double target=initial.epoch+double(2*pi/n*fraction)/86400;
            const double dt=(target-initial.epoch)*86400;
            Vector finalState{};const auto phi=keplerSTM(initial,dt,&finalState);
            if(!first) std::cout<<",\n";first=false;
            std::cout<<"    {\"name\": \""<<(eccentric?"eccentric":"circular")<<"_"<<(fraction==1?"1":"0.3")<<"_orbit\", \"mean_motion_rad_s\": "<<n
                     <<", \"target_jd\": "<<target<<", \"duration_s\": "<<dt<<", \"initial_state\": [";
            const auto initialValues=values(initial);
            for(int i=0;i<6;++i) std::cout<<(i?", ":"")<<initialValues[i];
            std::cout<<"], \"state\": [";for(int i=0;i<6;++i) std::cout<<(i?", ":"")<<finalState[i];
            std::cout<<"], \"stm\": [";for(int i=0;i<6;++i) for(int j=0;j<6;++j) std::cout<<(i||j?", ":"")<<phi[i][j];
            std::cout<<"]}";
        }
    }
    std::cout<<"\n  ]\n}\n";
}

int main(int argc,char** argv) {
    try {
        if(argc==2 && std::string(argv[1])=="--emit-reference") {emitReference();return 0;}
        std::cout<<std::setprecision(17);
        std::cout<<"CONTEXT J2000 km km/s JD2451545.0_TDB elapsed_seconds mu=398600.4418 relative_metric=Frobenius(D^-1_Phi_D)\n";
        testKepler();testJ2();testCovariance();testScheduledImpulses();
        if(!(argc==2 && std::string(argv[1])=="--skip-timing")) benchmark();
        std::cout<<(failures?"FAIL":"PASS")<<" HPOP variational cases="<<cases<<" failures="<<failures<<'\n';
        return failures?1:0;
    } catch(const std::exception& e) {std::cerr<<"FAIL "<<e.what()<<'\n';return 1;}
}
