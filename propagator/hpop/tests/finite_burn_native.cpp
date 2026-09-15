// Independent finite-burn acceptance evidence (TMPL lane 04).
// [R] NASA Glenn ideal rocket equation: dv=Isp*g0*ln(m0/mf).
// https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/ideal-rocket-equation/
// [S] MIT 16.522 Spring 2015 lecture 6, equations 4-6 and 9: near-circular
// tangential spiral a=a0/(1-dv/v0)^2; approximate, not an exact orbit solution.
// https://ocw.mit.edu/courses/16-522-space-propulsion-spring-2015/7f725e54b9be201164d56ebbd5e08023_MIT16_522S15_Lecture6.pdf
// [O] Orekit 13.0.1 ConstantThrustManeuverTest.testRoughBehaviour, lines 268-321
// and setup line 851; published final mass, inclination and semi-major axis.
// https://www.orekit.org/site-orekit-13.0.1/xref-test/org/orekit/forces/maneuvers/ConstantThrustManeuverTest.html#L268
// https://raw.githubusercontent.com/CS-SI/Orekit/13.0.1/src/test/java/org/orekit/forces/maneuvers/ConstantThrustManeuverTest.java
// [L] Orekit LOFType: QSW/RTN (R,T,N); VNC (velocity, momentum, V cross N).
// https://www.orekit.org/site-orekit-12.0.1/apidocs/org/orekit/frames/LOFType.html
// [H] Kong et al., Saltation Matrices (2023), identity-reset specialization.
// https://arxiv.org/abs/2306.06862
// ALL cases: position km, velocity km/s, mass kg, thrust N, Isp s, g0=9.80665
// m/s^2, elapsed dynamical seconds, inertial Cartesian axes. Unless stated,
// epoch JD2451545 TDB in Earth-centred J2000 axes. No environmental forces.
// Orekit uses EME2000 and UTC epoch 2004-01-01T23:30:00; autonomous point-mass
// dynamics make the absolute epoch irrelevant: preserve its exact elapsed
// durations and EME2000 axes, label the test's JD only as a computational origin.
// Each check gives tolerance/rationale below. No new-code goldens are used.
#include "finite_burn.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
using namespace astro;
using namespace astro::Integrator;
constexpr double G0=9.80665, MU=398600.4418, PI_=3.14159265358979323846;
static int failures=0, checks=0;
static void check(const std::string& name,double error,double bound) {
 const bool ok=std::isfinite(error)&&error<=bound; ++checks; if(!ok)++failures;
 std::cout<<"RESULT "<<name<<" error="<<error<<" tolerance="<<bound<<' '<<(ok?"PASS":"FAIL")<<'\n';
}
static IntegratorConfig controls(double maxStep=15) {
 IntegratorConfig c;c.method=IntegrationMethod::RKF78;c.absTolerance=2e-13;c.relTolerance=2e-13;
 c.minStep=1e-6;c.maxStep=maxStep;c.initialStep=maxStep;c.maxSteps=1000000;return c;
}
static ForceModel::ForceModelSet gravity(double mu=MU) {
 ForceModel::ForceModelSet f;f.gravityMode=ForceModel::GravityMode::PointMass;f.mu=mu;return f;
}
static ForceModel::ForceModelSet vacuum() {
 ForceModel::ForceModelSet f;f.gravityMode=ForceModel::GravityMode::Infer;f.usePointMass=false;return f;
}
static StateVector initial() {return {{7000,0,0},{0,std::sqrt(MU/7000),0},2451545};}
static FiniteBurnResult run(const StateVector& s,double m,double dt,const ForceModel::ForceModelSet& f,
 const std::vector<FiniteBurn>& burns,const IntegratorConfig& c=controls()) {
 auto r=PropagateFiniteBurns(s,m,dt,c,f,burns);
 if(!r.success) throw std::runtime_error(r.errorMessage);return r;
}
static double semimajor(const StateVector& s,double mu) {
 return 1/(2/s.position.magnitude()-s.velocity.magnitudeSq()/mu);
}
static StateVector elements(double a,double e,double i,double w,double O,double nu,double mu) {
 // Independent classical perifocal->inertial basis, explicit radian inputs.
 const Vec3 p{std::cos(O)*std::cos(w)-std::sin(O)*std::sin(w)*std::cos(i),
              std::sin(O)*std::cos(w)+std::cos(O)*std::sin(w)*std::cos(i),std::sin(w)*std::sin(i)};
 const Vec3 q{-std::cos(O)*std::sin(w)-std::sin(O)*std::cos(w)*std::cos(i),
              -std::sin(O)*std::sin(w)+std::cos(O)*std::cos(w)*std::cos(i),std::cos(w)*std::sin(i)};
 const double l=a*(1-e*e),r=l/(1+e*std::cos(nu));
 return {p*(r*std::cos(nu))+q*(r*std::sin(nu)),
         (p*(-std::sin(nu))+q*(e+std::cos(nu)))*std::sqrt(mu/l),2451545};
}
static void orekit() {
 const double d=PI_/180,mu=398600.47;
 auto s=elements(24396.159,.72831215,7*d,180*d,261*d,0,mu);
 FiniteBurn b;b.startSeconds=17134.08;b.stopSeconds=b.startSeconds+3653.99;
 b.thrustNewtons=420;b.ispSeconds=318;
 b.direction={std::cos(-7.4978*d)*std::cos(351*d),std::cos(-7.4978*d)*std::sin(351*d),std::sin(-7.4978*d)};
 const auto r=run(s,2500,20934.08,gravity(mu),{b},controls(30));
 const double inc=std::acos(r.finalState.position.cross(r.finalState.velocity).normalized().z)/d;
 // Bounds on i and a are exactly the published [O] assertion bounds, reflecting
 // rounded expected values. Mass 1e-8kg allows floating RK summation only.
 check("Orekit_mass_kg",std::abs(r.massKg-2007.8824544261233),1e-8);
 check("Orekit_inclination_deg",std::abs(inc-2.6872),1e-4);
 check("Orekit_semimajor_km",std::abs(semimajor(r.finalState,mu)-28970),1);
 std::cout<<"MEASURED Orekit mass_kg="<<r.massKg<<" inclination_deg="<<inc<<" semimajor_km="<<semimajor(r.finalState,mu)<<'\n';
}
static void rocketSpiral() {
 const double m0=1000,T=.1,isp=3000,dt=86400;
 FiniteBurn b;b.stopSeconds=dt;b.thrustNewtons=T;b.ispSeconds=isp;b.frame=BurnFrame::Velocity;
 const auto r=run(initial(),m0,dt,gravity(),{b},controls(30));
 const double mf=m0-T*dt/(isp*G0),dv=isp*G0*std::log(m0/mf)/1000;
 // [R] exact integrated scalar propulsion dv, not |v_final-v_initial|.
 check("Tsiolkovsky_mass_kg",std::abs(r.massKg-mf),2e-8);
 check("Tsiolkovsky_deltaV_km_s",std::abs(r.burns[0].deltaVKmS-dv),2e-11);
 check("Tsiolkovsky_propellant_kg",std::abs(r.burns[0].propellantKg-(m0-mf)),2e-8);
 const double a0=7000,v0=std::sqrt(MU/a0),approx=a0/std::pow(1-dv/v0,2);
 // [S] epsilon=T/m/(mu/r²)=1.23e-5; near-circular model error dominates.
 // 0.5 m is conservative for neglected O(e²) energy terms, while expected
 // growth exceeds 16 km. This is a physical approximation, not solver accuracy.
 check("Edelbaum_spiral_semimajor_km",std::abs(semimajor(r.finalState,MU)-approx),5e-4);
 std::cout<<"MEASURED spiral mass_kg="<<r.massKg<<" deltaV_km_s="<<r.burns[0].deltaVKmS
          <<" semimajor_km="<<semimajor(r.finalState,MU)<<" approximation_km="<<approx<<'\n';
}
static void impulsiveLimit() {
 auto s=initial();const double m=1000,isp=300,dv=.001,center=100,end=400;
 ForceModel::ImpulsiveManeuverDef impulse;impulse.epoch=s.epoch+center/86400;impulse.deltaV={0,dv,0};impulse.inRTN=false;
 auto f=gravity();auto ref=PropagateWithSTM(s,end,controls(2),f,STMMethod::Analytic,
 ForceModel::DensityGradient::Neglected,{impulse});
 if(!ref.success)throw std::runtime_error(ref.errorMessage);
 const double representedCenter=(impulse.epoch-s.epoch)*86400;
 double prior=0;
 for(double dur:{10.,1.,.1}) {
  FiniteBurn b;b.startSeconds=representedCenter-dur/2;b.stopSeconds=representedCenter+dur/2;b.ispSeconds=isp;b.direction={0,1,0};
  b.thrustNewtons=m*isp*G0*(-std::expm1(-dv*1000/(isp*G0)))/dur;
  const auto r=run(s,m,end,gravity(),{b},controls(2));
  const double error=(r.finalState.position-ref.finalState.position).magnitude()+1000*(r.finalState.velocity-ref.finalState.velocity).magnitude();
  // [R] holds integrated dv fixed while duration shrinks. Symmetric timing
  // gives O(duration²) gravitational averaging plus small mass-weighting shift.
  if(prior>0)check("impulsive_limit_monotone_"+std::to_string(dur),error/prior,.25);prior=error;
  std::cout<<"MEASURED impulsive duration_s="<<dur<<" balanced_error_km="<<error<<'\n';
 }
 // 2 cm final balanced error is conservative including binary-JD impulse epoch.
 check("impulsive_limit_final_balanced_km",prior,2e-5);
}
static void framesAndProfiles() {
 StateVector s{{7000,100,-50},{1,7,.4},2451545};const double dt=.01,a=1e-4;
 const Vec3 R=s.position.normalized(),N=s.position.cross(s.velocity).normalized(),T=N.cross(R),V=s.velocity.normalized(),C=V.cross(N);
 const Vec3 d=Vec3{.4,.8,-.2}.normalized();
 const std::array<BurnFrame,5> frames{BurnFrame::Inertial,BurnFrame::RTN,BurnFrame::VNC,BurnFrame::Velocity,BurnFrame::AntiVelocity};
 const std::array<Vec3,5> expected{d,R*d.x+T*d.y+N*d.z,V*d.x+N*d.y+C*d.z,V,-V};
 for(size_t j=0;j<frames.size();++j) {
  FiniteBurn b;b.stopSeconds=dt;b.accelerationKmS2=a;b.frame=frames[j];b.direction=d;
  auto r=run(s,1000,dt,vacuum(),{b},controls(dt));
  // [L] one short kick, 2e-5 relative allows O(dt) rotation of the local axes.
  check("frame_direction_"+std::to_string(j),((r.finalState.velocity-s.velocity)/(a*dt)-expected[j]).magnitude(),2e-5);
 }
 FiniteBurn b;b.stopSeconds=300;b.accelerationKmS2=1e-5;b.ispSeconds=300;b.direction={1,0,0};b.steeringRate={0,.003,0};
 auto r=run(s,1000,300,vacuum(),{b});const double k=.003,D=300;
 const Vec3 exact{b.accelerationKmS2*std::asinh(k*D)/k,b.accelerationKmS2*(std::sqrt(1+k*k*D*D)-1)/k,0};
 // Independent elementary integrals of normalize([1,k*t,0]); 1e-11 km/s
 // permits integrator rounding, far below the 2.5m/s steering effect.
 check("linear_steering_integral_km_s",(r.finalState.velocity-s.velocity-exact).magnitude(),1e-11);
 // Full-span initial step also exercises error control for explicit-time
 // steering, for which the Fehlberg embedded pair can share stage values.
 const auto coarseSteering=run(s,1000,300,vacuum(),{b},controls(300));
 check("linear_steering_coarse_integral_km_s",(coarseSteering.finalState.velocity-s.velocity-exact).magnitude(),1e-11);
 check("acceleration_mode_exponential_mass_kg",std::abs(r.massKg-1000*std::exp(-1000*b.accelerationKmS2*D/(b.ispSeconds*G0))),1e-8);
 b={};b.startSeconds=10;b.stopSeconds=110;b.thrustNewtons=12;b.ispSeconds=300;
 b.throttle={{30,.5},{70,0},{90,1}};
 r=run(s,1000,120,vacuum(),{b},controls(17));
 const double mf=1000-12*60/(300*G0),dv=300*G0*std::log(1000/mf)/1000;
 // Exact ZOH area: 20*1+40*.5+20*0+20*1=60 seconds. All knots are
 // deliberately off-grid relative to maxStep=17s; tests edge clipping.
 check("throttle_mass_kg",std::abs(r.massKg-mf),1e-8);
 check("throttle_deltaV_km_s",std::abs(r.burns[0].deltaVKmS-dv),1e-11);
}
static std::array<double,7> state7(const FiniteBurnResult& r) {
 return {r.finalState.position.x,r.finalState.position.y,r.finalState.position.z,r.finalState.velocity.x,r.finalState.velocity.y,r.finalState.velocity.z,r.massKg};
}
static double stmFD(const StateVector& s,double mass,double dt,const std::vector<FiniteBurn>& burns,const ForceModel::ForceModelSet& f,double perturb=1) {
 const auto base=run(s,mass,dt,f,burns,controls(5));
 const double unit[]={1,1,1,.001,.001,.001,1};double e2=0,n2=0;
 for(int j=0;j<7;++j) {
  const double h=unit[j]*.02*perturb;auto p=s,n=s;double mp=mass,mn=mass;
  const Vec3 axis{double(j%3==0),double(j%3==1),double(j%3==2)};
  if(j<3){p.position+=axis*h;n.position-=axis*h;}
  else if(j<6){p.velocity+=axis*h;n.velocity-=axis*h;}else {mp+=h;mn-=h;}
  auto xp=state7(run(p,mp,dt,f,burns,controls(5))),xn=state7(run(n,mn,dt,f,burns,controls(5)));
  for(int i=0;i<7;++i) {
   const double fd=(xp[i]-xn[i])/(2*h)*unit[j]/unit[i],actual=base.stm[i*7+j]*unit[j]/unit[i];
   e2+=(fd-actual)*(fd-actual);n2+=fd*fd;
  }
 }
 return std::sqrt(e2/n2);
}
static void stmAndEvents() {
 const auto s=elements(7500,.03,.3,.5,.7,1,MU);
 for(auto frame:{BurnFrame::Inertial,BurnFrame::RTN,BurnFrame::VNC,BurnFrame::Velocity,BurnFrame::AntiVelocity}) {
  FiniteBurn b;b.startSeconds=25;b.stopSeconds=200;b.thrustNewtons=20;b.ispSeconds=310;b.frame=frame;b.direction={.4,.8,-.2};if(frame!=BurnFrame::Velocity&&frame!=BurnFrame::AntiVelocity)b.steeringRate={.0002,0,.0001};
  // Independent whole-arc central differences of all 7 initial coordinates.
  // 20m, 2cm/s and .02kg steps balance cancellation and O(h²) truncation.
  // Balanced Frobenius tolerance 3e-6 is much larger than normal RK error.
  check("STM7_frame_"+std::to_string(int(frame)),stmFD(s,1000,250,{b},gravity()),3e-6);
 }
 // Each event is transverse. Check two FD step sizes, so a single accidental
 // cancellation cannot create event-STM evidence. [H] supplies the theory;
 // these are supplementary derivative checks, not independent orbit goldens.
 for(auto kind:{BurnEventKind::Radius,BurnEventKind::Speed,BurnEventKind::RadialVelocity,BurnEventKind::Node,BurnEventKind::Mass}) {
  StateVector x{{7000,0,-10},{.1,7.5,.1},2451545};FiniteBurn b;
  b.stopSeconds=200;b.thrustNewtons=100;b.direction={1,1,.1};b.ispSeconds=300;
  b.stopEvent.kind=kind;
  if(kind==BurnEventKind::Radius){b.stopEvent.goal=7007;b.stopEvent.direction=1;}
  if(kind==BurnEventKind::Speed){b.stopEvent.goal=x.velocity.magnitude()+.003;b.stopEvent.direction=1;}
  if(kind==BurnEventKind::RadialVelocity){b.stopEvent.goal=.4;b.stopEvent.direction=1;}
  if(kind==BurnEventKind::Node){b.stopEvent.goal=0;b.stopEvent.direction=1;}
  if(kind==BurnEventKind::Mass){b.stopEvent.goal=997;b.stopEvent.direction=-1;}
  const auto r=run(x,1000,250,vacuum(),{b},controls(5));
  check("event_fired_"+std::to_string(int(kind)),r.burns[0].stopByEvent?0:1,0);
  check("event_STM7_"+std::to_string(int(kind)),stmFD(x,1000,250,{b},vacuum()),5e-6);
  check("event_STM7_half_step_"+std::to_string(int(kind)),stmFD(x,1000,250,{b},vacuum(),.5),5e-6);
 }
 // Node start depends on initial z and vz; its changed event time must enter
 // the post-burn STM through [H], including initial-mass sensitivity.
 StateVector x{{7000,0,-10},{.1,7.5,.1},2451545};FiniteBurn start;
 start.stopSeconds=200;start.thrustNewtons=100;start.direction={1,1,.1};
 start.startEvent={BurnEventKind::Node,0,1};
 const auto r=run(x,1000,250,vacuum(),{start},controls(5));
 check("event_start_fired",r.burns[0].startByEvent?0:1,0);
 check("event_start_epoch_s",std::abs(r.burns[0].startSeconds-100),1e-8);
 check("event_start_mass_kg",std::abs(r.massKg-(1000-100*100/(300*G0))),1e-8);
 check("event_start_STM7",stmFD(x,1000,250,{start},vacuum()),5e-6);
 check("event_start_STM7_half_step",stmFD(x,1000,250,{start},vacuum(),.5),5e-6);
 start.startEvent.goal=100000;const auto missed=run(x,1000,250,vacuum(),{start});
 check("unmet_start_event_reported",missed.burns[0].started?1:0,0);
 check("unmet_start_event_mass_kg",std::abs(missed.massKg-1000),1e-12);
}
static void overlappingImpulses() {
 StateVector s{{7000,100,-50},{1,7,.4},2451545};const double end=200,isp=300;
 FiniteBurn x;x.startSeconds=10;x.stopSeconds=110;x.accelerationKmS2=1e-5;x.ispSeconds=isp;x.direction={1,0,0};
 FiniteBurn y=x;y.startSeconds=50;y.stopSeconds=150;y.accelerationKmS2=2e-5;y.direction={0,1,0};
 ForceModel::ImpulsiveManeuverDef kick;kick.epoch=s.epoch+100/86400.;kick.inRTN=false;kick.deltaV={1e-4,-2e-4,3e-5};
 auto r=PropagateFiniteBurns(s,1000,end,controls(7),vacuum(),{x,y},ForceModel::DensityGradient::Neglected,{kick});
 if(!r.success)throw std::runtime_error(r.errorMessage);
 const double kt=(kick.epoch-s.epoch)*86400,decay=std::exp(-1000*(x.accelerationKmS2*100+y.accelerationKmS2*100)/(isp*G0));
 const Vec3 vx=x.direction*(x.accelerationKmS2*100),vy=y.direction*(y.accelerationKmS2*100);
 const Vec3 expectedV=s.velocity+vx+vy+kick.deltaV;
 const Vec3 expectedR=s.position+s.velocity*end+vx*(end-x.startSeconds-50)+vy*(end-y.startSeconds-50)+kick.deltaV*(end-kt);
 // Independent constant-acceleration kinematics plus [R]'s exponential mass.
 // 10 micrometres position / 1e-11km/s velocity / 1e-8kg allow RK summation.
 check("overlap_impulse_position_km",(r.finalState.position-expectedR).magnitude(),1e-8);
 check("overlap_impulse_velocity_km_s",(r.finalState.velocity-expectedV).magnitude(),1e-11);
 check("overlap_impulse_mass_kg",std::abs(r.massKg-1000*decay),1e-8);
 Matrix7 expected{};for(int i=0;i<6;++i)expected[i*7+i]=1;
 for(int i=0;i<3;++i)expected[i*7+i+3]=end;expected[48]=decay;
 double error=0;for(int i=0;i<49;++i)error=std::max(error,std::abs(r.stm[i]-expected[i]));
 check("acceleration_mode_exact_STM7",error,1e-10);
 Matrix7 covariance{};const double variance[]={1,4,9,.0001,.0004,.0009,25};
 for(int i=0;i<7;++i)covariance[i*7+i]=variance[i];
 const auto transported=TransportFiniteCovariance(r.stm,covariance);double covarianceError=0;
 // Direct elementary independent covariance law for r=r0+v0*t and m=m0*decay.
 for(int i=0;i<7;++i)for(int j=0;j<7;++j){
  double c=0;if(i==j)c=i<3?variance[i]+end*end*variance[i+3]:i==6?variance[6]*decay*decay:variance[i];
  if(i<3&&j==i+3)c=end*variance[j];if(j<3&&i==j+3)c=end*variance[i];
  covarianceError=std::max(covarianceError,std::abs(transported[i*7+j]-c));
 }
 check("acceleration_mode_exact_covariance7",covarianceError,1e-10);
}
static void environmentMassColumn() {
 // Supplementary derivatives of the existing lane03 atmosphere/cannonball
 // force laws, not a new environmental-model accuracy claim. GCRF/J2000 at
 // JD2451545 TDB, km/km/s/kg; deliberately large areas make each 1/m signal
 // resolvable. The short arc remains illuminated and above the drag cutoff.
 StateVector s{{6778,0,0},{0,7.6,.5},2451545};FiniteBurn b;
 b.startSeconds=10;b.stopSeconds=100;b.thrustNewtons=.1;b.ispSeconds=300;b.direction={1,.3,.2};
 const double m=1000,dt=120;const auto c=controls(3);
 for(int kind=0;kind<3;++kind) {
  auto f=gravity();f.useDrag=kind!=1;f.useSRP=kind!=0;
  f.dragModel=ForceModel::DragModelType::Exponential;f.drag.model=ForceModel::DragModelType::Exponential;
  f.drag.area=10000;f.drag.Cd=2.2;f.srp.area=100000;f.srp.Cr=1.5;
  const auto evaluate=[&](double mass,const ForceModel::ForceModelSet& force){
   auto r=PropagateFiniteBurns(s,mass,dt,c,force,{b},ForceModel::DensityGradient::FiniteDifference);
   if(!r.success)throw std::runtime_error(r.errorMessage);return r;
  };
  const auto base=evaluate(m,f),without=evaluate(m,gravity());double signal=0;
  for(int i=0;i<6;++i){const double unit=i<3?1:.001,d=(base.stm[i*7+6]-without.stm[i*7+6])/unit;signal+=d*d;}
  // The environment must contribute enough that omitting its mass column
  // cannot be concealed by the burn column or a numerically zero SRP shadow.
  check("environment_mass_signal_"+std::to_string(kind),std::sqrt(signal)>1e-5?0:1,0);
  for(double h:{.1,.05}) {
   const auto p=state7(evaluate(m+h,f)),n=state7(evaluate(m-h,f));double error=0,scale=0;
   for(int i=0;i<6;++i){const double unit=i<3?1:.001;
    const double fd=(p[i]-n[i])/(2*h)/unit,actual=base.stm[i*7+6]/unit;
    error+=(actual-fd)*(actual-fd);scale+=fd*fd;
   }
   // Whole-arc initial-mass central differences: .1/.05 kg, relative 1e-5
   // against the balanced six dynamical components only. Excluding Phi_mm=1
   // prevents a trivial unit mass derivative from hiding missing force terms.
   check("environment_mass_column_"+std::to_string(kind)+"_h"+std::to_string(h),std::sqrt(error/scale),1e-5);
  }
 }
}
static void dryMassEdge() {
 StateVector s{{7000,100,-50},{1,7,.4},2451545};FiniteBurn b;
 b.stopSeconds=10;b.thrustNewtons=980.665;b.ispSeconds=100;b.direction={1,0,0};
 b.stopEvent={BurnEventKind::Mass,.5,-1};
 auto coarse=run(s,1,2,vacuum(),{b},controls(2)),fine=run(s,1,2,vacuum(),{b},controls(.02));
 // [R] mdot=1kg/s exactly, trigger at .5s and .5kg. A 2s tentative
 // step exhausts mass before root detection; adaptive retry must locate the
 // earlier physical cutoff rather than report false fuel exhaustion.
 check("dry_mass_event_fired",coarse.burns[0].stopByEvent?0:1,0);
 check("dry_mass_event_epoch_s",std::abs(coarse.burns[0].stopSeconds-.5),1e-9);
 check("dry_mass_final_kg",std::abs(coarse.massKg-.5),1e-9);
 check("dry_mass_rocket_deltaV_km_s",std::abs(coarse.burns[0].deltaVKmS-100*G0*std::log(2.)/1000),1e-9);
 check("dry_mass_step_refinement_position_km",(coarse.finalState.position-fine.finalState.position).magnitude(),1e-8);
 check("dry_mass_fixed_endpoint_mass_derivative",std::abs(coarse.stm[48]),1e-10);
}
static void invalid() {
 FiniteBurn b;b.stopSeconds=100;b.thrustNewtons=10;
 const auto rejects=[&](const std::string& n,double mass,FiniteBurn burn,IntegratorConfig c) {
  try {auto r=PropagateFiniteBurns(initial(),mass,200,c,gravity(),{burn});check(n,r.success?1:0,0);}
  catch(const std::exception&){check(n,0,0);}
 };
 auto bad=b;bad.ispSeconds=0;rejects("reject_zero_Isp",1000,bad,controls());
 bad=b;bad.direction={0,0,0};rejects("reject_zero_direction",1000,bad,controls());
 bad=b;bad.frame=BurnFrame::Velocity;bad.steeringRate={0,.1,0};rejects("reject_velocity_steering",1000,bad,controls());
 bad=b;bad.throttle={{0,1.1}};rejects("reject_throttle_above_one",1000,bad,controls());
 rejects("reject_zero_mass",0,b,controls());
 auto c=controls();c.maxSteps=1;rejects("reject_step_budget",1000,b,c);
 bad=b;bad.thrustNewtons=1000000;rejects("reject_mass_exhaustion",1,bad,controls());
 // Event and scheduled window tie at exactly t=100s: min(event,window) is
 // not classically differentiable, so exposing a single STM must be refused.
 StateVector x{{7000,0,-10},{.1,7.5,.1},2451545};
 bad=b;bad.direction={1,0,0};bad.stopEvent={BurnEventKind::Node,0,1};
 const auto tie=PropagateFiniteBurns(x,1000,200,controls(5),vacuum(),{bad});
 check("reject_event_scheduled_tie",tie.success?1:0,0);
}
int main() {
 std::cout<<std::setprecision(16);
 const auto test=[](const char* name,auto fn){try{fn();}catch(const std::exception& e){++checks;++failures;std::cout<<"FAIL "<<name<<" exception="<<e.what()<<'\n';}};
 test("orekit",orekit);test("rocket_spiral",rocketSpiral);test("impulsive_limit",impulsiveLimit);
 test("frames_profiles",framesAndProfiles);test("stm_events",stmAndEvents);test("overlapping_impulses",overlappingImpulses);test("environment_mass",environmentMassColumn);test("dry_mass",dryMassEdge);test("invalid",invalid);
 std::cout<<(failures?"FAIL":"PASS")<<" HPOP finite burns checks="<<checks<<" failures="<<failures<<'\n';return failures?1:0;
}
