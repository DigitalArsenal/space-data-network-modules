#include "hpop/prw_execution.h"
#include "hpop/prw_codec.h"
#include "hpop/prw_covariance.h"
#include "astrodynamics.h"
#include "integrators.h"
#include "variational.h"
#include "finite_burn.h"
#include "force_partials.h"
#include "ephemeris.h"
#include "../../../../../files/orbit-products/src/sha256.hpp"
#include <algorithm>
#include <array>
#include <limits>
extern "C" {
#include "nrlmsise-00.h"
}

namespace hpop {
namespace {
using namespace astro;
struct Execution {
    StateVector initial;
    double target = 0, mass = 1000;
    IntegratorConfig integrator;
    ForceModel::ForceModelSet forces;
    Integrator::STMMethod technique = Integrator::STMMethod::Analytic;
    ForceModel::DensityGradient density = ForceModel::DensityGradient::Neglected;
    bool massDynamics = false, variational = false, covariance = false, massCovariance = false;
    Mat6 p{};
    Integrator::Matrix7 p7{};
    std::vector<double> samples;
    std::vector<ForceModel::ImpulsiveManeuverDef> impulses;
    std::vector<Integrator::FiniteBurn> burns;
    Integrator::ProcessNoise noise;
};
bool positive(double x) {return std::isfinite(x)&&x>0;}
bool nonnegative(double x) {return std::isfinite(x)&&x>=0;}
bool parseIntegrator(const PRWIntegratorSettings* in, bool mass, IntegratorConfig& out, std::string& error) {
    if(!in)return prwError(error,"invalid-integrator: Missing integrator settings.");
    switch(in->ALGORITHM()) {
    case prwSolverAlgorithm::RK4:out.method=IntegrationMethod::RK4;break;
    case prwSolverAlgorithm::RKF45:out.method=IntegrationMethod::RKF45;break;
    case prwSolverAlgorithm::RKF78:out.method=IntegrationMethod::RKF78;break;
    case prwSolverAlgorithm::RK78:out.method=IntegrationMethod::RK78;break;
    case prwSolverAlgorithm::RKDP87:out.method=IntegrationMethod::RKDP87;break;
    case prwSolverAlgorithm::ABM:out.method=IntegrationMethod::ABM;break;
    case prwSolverAlgorithm::BS:out.method=IntegrationMethod::BS;break;
    case prwSolverAlgorithm::COWELL:out.method=IntegrationMethod::Cowell;break;
    case prwSolverAlgorithm::ENCKE:out.method=IntegrationMethod::Encke;break;
    case prwSolverAlgorithm::EQUINOCTIAL_VOP:out.method=IntegrationMethod::EquinoctialVOP;break;
    default:return prwError(error,"unsupported-integrator: ALGORITHM must name a supported solver.");
    }
    if(out.method==IntegrationMethod::ABM||out.method==IntegrationMethod::Encke||out.method==IntegrationMethod::EquinoctialVOP)
        return prwError(error,"unsupported-integrator: This profile has no verified result dispatcher for ABM, ENCKE or EQUINOCTIAL_VOP.");
    out.initialStep=in->INITIAL_STEP_SECONDS();out.minStep=in->MINIMUM_STEP_SECONDS();out.maxStep=in->MAXIMUM_STEP_SECONDS();
    out.relTolerance=in->RELATIVE_TOLERANCE();out.maxSteps=in->MAXIMUM_STEPS();
    if(!positive(out.initialStep)||!positive(out.minStep)||!positive(out.maxStep)||out.maxStep<out.minStep||
       !nonnegative(out.relTolerance)||out.maxSteps<1||out.maxSteps>429496729)
        return prwError(error,"invalid-integrator: Step bounds, relative tolerance and maximum steps must be valid and finite.");
    const auto* tolerances=in->ABSOLUTE_TOLERANCES();
    if(!tolerances||tolerances->size()!=unsigned(mass?7:6))
        return prwError(error,"unsupported-tolerance: Supply six absolute tolerances, or seven for mass dynamics.");
    out.absTolerance=tolerances->Get(0)*0.001;
    for(unsigned i=0;i<tolerances->size();++i) {
        const double t=tolerances->Get(i)*(i<6?0.001:1.0);
        if(!positive(t))return prwError(error,"invalid-integrator: Absolute tolerances must be finite and positive.");
        if(std::abs(t-out.absTolerance)>out.absTolerance*1e-12)
            return prwError(error,"unsupported-tolerance: Component tolerances must map to the existing common km-based scalar tolerance.");
    }
    return true;
}
bool parseForces(const PRWForceConfiguration* in,double epoch,ForceModel::ForceModelSet& out,std::string& error) {
    if(!in)return prwError(error,"invalid-forces: Missing force configuration.");
    out.usePointMass=in->ENABLE_POINT_MASS();out.mu=in->GRAVITATIONAL_PARAMETER()*1e-9;
    out.useSphericalHarmonics=in->ENABLE_J2()||in->ENABLE_J3()||in->ENABLE_J4()||in->ENABLE_HIGHER_ZONALS();
    out.sphericalHarmonics.includeJ2=in->ENABLE_J2();out.sphericalHarmonics.includeJ3=in->ENABLE_J3();out.sphericalHarmonics.includeJ4=in->ENABLE_J4();out.sphericalHarmonics.includeHigherZonals=in->ENABLE_HIGHER_ZONALS();out.sphericalHarmonics.mu=out.mu;
    switch(in->GRAVITY_CHOICE()) {
    case prwGravitySelection::INFER_FLAGS:out.gravityMode=ForceModel::GravityMode::Infer;break;
    case prwGravitySelection::POINT_MASS:out.gravityMode=ForceModel::GravityMode::PointMass;break;
    case prwGravitySelection::J2_ONLY:out.gravityMode=ForceModel::GravityMode::J2Only;break;
    case prwGravitySelection::J2_TO_J4:out.gravityMode=ForceModel::GravityMode::J2J4;break;
    case prwGravitySelection::SPHERICAL_HARMONICS:out.gravityMode=ForceModel::GravityMode::SphericalHarmonics;break;
    case prwGravitySelection::EGM2008:out.gravityMode=ForceModel::GravityMode::EGM2008;break;
    default:return prwError(error,"unsupported-gravity: Unknown gravity selection.");
    }
    if(!nonnegative(out.mu) || ((out.usePointMass||out.useSphericalHarmonics||out.gravityMode!=ForceModel::GravityMode::Infer)&&out.mu==0))
        return prwError(error,"invalid-forces: Enabled central gravity requires a positive finite SI gravitational parameter.");
    if(!in->HAS_MAXIMUM_DEGREE()&&in->MAXIMUM_DEGREE())return prwError(error,"invalid-presence: MAXIMUM_DEGREE requires HAS_MAXIMUM_DEGREE.");
    if(!in->HAS_MAXIMUM_ORDER()&&in->MAXIMUM_ORDER())return prwError(error,"invalid-presence: MAXIMUM_ORDER requires HAS_MAXIMUM_ORDER.");
    // Body-fixed tesseral coefficients require an EOP-backed rotation that
    // this invocation profile cannot supply. Zonal fields are axisymmetric.
    out.sphericalHarmonics.maxOrder=0;out.egm2008.truncationOrder=0;
    if(in->HAS_MAXIMUM_DEGREE())out.sphericalHarmonics.maxDegree=out.egm2008.truncationDegree=in->MAXIMUM_DEGREE();
    if(in->HAS_MAXIMUM_ORDER())out.sphericalHarmonics.maxOrder=out.egm2008.truncationOrder=in->MAXIMUM_ORDER();
    if(in->HAS_MAXIMUM_ORDER()&&in->MAXIMUM_ORDER()>0)
        return prwError(error,"eop-data-required: Tesseral gravity requires Earth orientation data; this PRW profile supports zonal order zero.");
    const bool spherical=out.gravityMode==ForceModel::GravityMode::SphericalHarmonics ||
        (out.gravityMode==ForceModel::GravityMode::Infer&&out.useSphericalHarmonics);
    if(spherical && out.sphericalHarmonics.maxDegree>20)
        return prwError(error,"unsupported-gravity: The inline spherical-harmonic field supports degrees zero through twenty.");
    if(out.gravityMode==ForceModel::GravityMode::EGM2008) {
        if(out.egm2008.truncationDegree<2||out.egm2008.truncationDegree>70)
            return prwError(error,"unsupported-gravity: The embedded EGM2008 field supports degrees two through seventy.");
        if(std::abs(out.mu-MU_EARTH)>MU_EARTH*1e-14)
            return prwError(error,"unsupported-gravity: Embedded EGM2008 requires its published Earth gravitational parameter.");
    }
    out.useThirdBody=in->ENABLE_THIRD_BODY();
    out.thirdBody.includeSun=out.thirdBody.includeMoon=out.thirdBody.includeMercury=out.thirdBody.includeVenus=out.thirdBody.includeMars=out.thirdBody.includeJupiter=out.thirdBody.includeSaturn=out.thirdBody.includeUranus=out.thirdBody.includeNeptune=false;
    if(in->THIRD_BODY_IDS())for(const auto id:*in->THIRD_BODY_IDS())switch(id) {
        case 10:out.thirdBody.includeSun=true;break;case 301:out.thirdBody.includeMoon=true;break;
        case 1:out.thirdBody.includeMercury=true;break;case 2:out.thirdBody.includeVenus=true;break;
        case 4:out.thirdBody.includeMars=true;break;case 5:out.thirdBody.includeJupiter=true;break;
        case 6:out.thirdBody.includeSaturn=true;break;case 7:out.thirdBody.includeUranus=true;break;
        case 8:out.thirdBody.includeNeptune=true;break;
        default:return prwError(error,"unsupported-third-body: Unsupported NAIF force-body ID.");
    }
    out.useSRP=in->ENABLE_SRP();out.useDrag=in->ENABLE_DRAG();
    out.srp.mass=out.drag.mass=in->INITIAL_MASS_KG();out.srp.area=out.drag.area=in->AREA_M2();out.srp.Cr=in->REFLECTIVITY_COEFFICIENT();out.drag.Cd=in->DRAG_COEFFICIENT();
    if(!positive(out.drag.mass)||!nonnegative(out.drag.area)||!nonnegative(out.srp.Cr)||!nonnegative(out.drag.Cd))
        return prwError(error,"invalid-forces: Spacecraft mass, area, Cd and Cr are invalid.");
    switch(in->ATMOSPHERE_MODEL()) {
        case prwAtmosphereFamily::NRLMSISE00:out.dragModel=ForceModel::DragModelType::NRLMSISE00;break;
        case prwAtmosphereFamily::EXPONENTIAL:out.dragModel=ForceModel::DragModelType::Exponential;break;
        case prwAtmosphereFamily::USSA1976:out.dragModel=ForceModel::DragModelType::USSA1976;break;
        case prwAtmosphereFamily::HARRIS_PRIESTER:out.dragModel=ForceModel::DragModelType::HarrisPriester;break;
        default:return prwError(error,"unsupported-atmosphere: Unknown atmosphere selection.");
    }
    out.drag.model=out.dragModel;out.explicitEpochContract=true;out.integrationEpochTDB=epoch;out.weather.epoch=timesys::taiToUtc(timesys::ttToTai(timesys::tdbToTt(epoch)));
    if(const auto* weather=in->WEATHER()) {
        if(!weather->EPOCH()||weather->EPOCH()->TIME_SYSTEM()!=timingStandard::UTC)return prwError(error,"epoch-time-scale: Space-weather epoch must be UTC.");
        double tdb=0,utc=0;if(!decodeEpoch(weather->EPOCH(),tdb,utc,error))return false;
        out.weather.epoch=utc;out.weather.F107=weather->F107();out.weather.F107a=weather->F107_AVERAGE();out.weather.Ap=weather->AP_INDEX();out.weather.Kp=weather->KP_INDEX();out.weather.kp3h=out.weather.Kp;
        if(!nonnegative(out.weather.F107)||!nonnegative(out.weather.F107a)||!nonnegative(out.weather.Ap)||!nonnegative(out.weather.Kp)||out.weather.Kp>9)
            return prwError(error,"invalid-weather: Space-weather indices must be finite and within their domain.");
    }
    if(!in->EPHEMERIS_SOURCE()||in->EPHEMERIS_SOURCE()->size()==0)return prwError(error,"ephemeris-source: An explicit ephemeris source is required.");
    const auto source=in->EPHEMERIS_SOURCE()->str();
    if(source=="Analytical")Ephemeris::selectEphemerisSource(Ephemeris::EphemerisSource::Analytical);
    else if(source!=Ephemeris::ephemerisSourceName(Ephemeris::selectedEphemerisSource()))return prwError(error,"ephemeris-source: Requested ephemeris source does not match the supplied kernel.");
    return true;
}
bool parseCondition(const PCEParameterCondition* in,const std::string& frame,Integrator::BurnEvent& out,std::string& error) {
    if(!in)return true;const auto* p=in->PARAMETER();
    if(!p)return prwError(error,"invalid-burn-event: Missing PCE parameter reference.");
    if(p->PROVIDER_DEFINED_NAME()||p->ELEMENT_INDEX()!=-1||p->SITE_ID()||p->SECOND_OBJECT_ID()||p->OWNER_OBJECT_ID()||p->OWNER_HARDWARE_NAME()||p->TIME_SYSTEM()||
       (p->CENTRAL_BODY_ID()!=0&&p->CENTRAL_BODY_ID()!=399)||
       (p->COORDINATE_SYSTEM_NAME()&&p->COORDINATE_SYSTEM_NAME()->str()!=frame))
        return prwError(error,"unsupported-burn-event: PCE reference must resolve to the current integration state/frame.");
    double scale=0.001;
    switch(p->PARAMETER()) {
        case pceParameter::POSITION_MAGNITUDE:out.kind=Integrator::BurnEventKind::Radius;break;
        case pceParameter::VELOCITY_MAGNITUDE:out.kind=Integrator::BurnEventKind::Speed;break;
        case pceParameter::RADIAL_VELOCITY:out.kind=Integrator::BurnEventKind::RadialVelocity;break;
        case pceParameter::POSITION_Z:out.kind=Integrator::BurnEventKind::Node;break;
        case pceParameter::TOTAL_MASS:out.kind=Integrator::BurnEventKind::Mass;scale=1;break;
        default:return prwError(error,"unsupported-burn-event: Only radius, speed, radial velocity, inertial z and total mass are supported.");
    }
    if(in->OCCURRENCE()>1)return prwError(error,"unsupported-burn-event: This profile supports the first event occurrence.");
    switch(in->DIRECTION()) {
        case pceConditionDirection::ANY_CROSSING:out.direction=0;break;
        case pceConditionDirection::INCREASING:out.direction=1;break;
        case pceConditionDirection::DECREASING:out.direction=-1;break;
        default:return prwError(error,"invalid-burn-event: An explicit crossing direction is required.");
    }
    out.goal=in->GOAL_VALUE()*scale;out.goalTolerance=in->GOAL_TOLERANCE()*scale;
    if(!std::isfinite(out.goal)||!positive(out.goalTolerance))return prwError(error,"invalid-burn-event: Finite goal and positive SI goal tolerance are required.");
    if((out.kind==Integrator::BurnEventKind::Radius||out.kind==Integrator::BurnEventKind::Mass)&&out.goal<=0)return prwError(error,"invalid-burn-event: Radius and mass goals must be positive.");
    if(out.kind==Integrator::BurnEventKind::Speed&&out.goal<0)return prwError(error,"invalid-burn-event: Speed goal must be nonnegative.");
    return true;
}
bool parseBoundary(const PRWBurnBoundary* in,const std::string& frame,double fallback,double& seconds,Integrator::BurnEvent& event,std::string& error) {
    if(!in||(!in->HAS_ELAPSED_SECONDS()&&!in->CONDITION()))return prwError(error,"invalid-burn: Every burn boundary requires elapsed seconds or an event.");
    if(!in->HAS_ELAPSED_SECONDS()&&in->ELAPSED_SECONDS()!=0)return prwError(error,"invalid-presence: ELAPSED_SECONDS requires HAS_ELAPSED_SECONDS.");
    seconds=in->HAS_ELAPSED_SECONDS()?in->ELAPSED_SECONDS():fallback;
    return nonnegative(seconds)?parseCondition(in->CONDITION(),frame,event,error):prwError(error,"invalid-burn: Boundary seconds must be finite and nonnegative.");
}
bool parseBurn(const PRWFiniteBurn* in,const std::string& frame,double target,Integrator::FiniteBurn& out,std::string& error) {
    if(!in)return prwError(error,"invalid-burn: Missing finite burn.");
    if(!parseBoundary(in->START(),frame,0,out.startSeconds,out.startEvent,error)||!parseBoundary(in->STOP(),frame,target,out.stopSeconds,out.stopEvent,error))return false;
    if(out.stopSeconds<=out.startSeconds)return prwError(error,"invalid-burn: Burn stop must be after start.");
    if(in->THRUST_LAW()==prwThrustPrescription::FORCE) {
        if(!in->HAS_FORCE_NEWTONS()||in->HAS_ACCELERATION_M_S2()||in->ACCELERATION_M_S2()!=0)return prwError(error,"invalid-burn: FORCE requires only FORCE_NEWTONS.");
        out.thrustNewtons=in->FORCE_NEWTONS();if(!positive(out.thrustNewtons))return prwError(error,"invalid-burn: Thrust must be positive and finite.");
    } else if(in->THRUST_LAW()==prwThrustPrescription::ACCELERATION) {
        if(!in->HAS_ACCELERATION_M_S2()||in->HAS_FORCE_NEWTONS()||in->FORCE_NEWTONS()!=0)return prwError(error,"invalid-burn: ACCELERATION requires only ACCELERATION_M_S2.");
        out.accelerationKmS2=in->ACCELERATION_M_S2()*0.001;if(!positive(out.accelerationKmS2))return prwError(error,"invalid-burn: Acceleration must be positive and finite.");
    } else return prwError(error,"invalid-burn: Explicit thrust law is required.");
    out.ispSeconds=in->SPECIFIC_IMPULSE_SECONDS();if(!positive(out.ispSeconds))return prwError(error,"invalid-burn: Specific impulse must be positive and finite.");
    switch(in->VECTOR_BASIS()) {
        case prwSteeringBasis::INTEGRATION_FRAME:out.frame=Integrator::BurnFrame::Inertial;break;
        case prwSteeringBasis::RTN_AXES:out.frame=Integrator::BurnFrame::RTN;break;
        case prwSteeringBasis::VNC_AXES:out.frame=Integrator::BurnFrame::VNC;break;
        case prwSteeringBasis::ALONG_VELOCITY:out.frame=Integrator::BurnFrame::Velocity;break;
        case prwSteeringBasis::OPPOSITE_VELOCITY:out.frame=Integrator::BurnFrame::AntiVelocity;break;
        default:return prwError(error,"invalid-burn: Explicit steering basis is required.");
    }
    if(out.frame==Integrator::BurnFrame::Velocity||out.frame==Integrator::BurnFrame::AntiVelocity) {
        if(in->DIRECTION()||in->DIRECTION_RATE())return prwError(error,"invalid-burn: Velocity steering defines its direction and rejects explicit direction/rate.");
    } else {
        if(!readVector(in->DIRECTION(),out.direction,1,error))return false;
        if(in->DIRECTION_RATE()&&!readVector(in->DIRECTION_RATE(),out.steeringRate,1,error))return false;
        if(out.direction.magnitude()==0)return prwError(error,"invalid-burn: Direction must be nonzero.");
    }
    out.linearThrottle=true;
    if(in->THROTTLE()) {
        if(in->THROTTLE()->size()>10000)return prwError(error,"invalid-burn: At most 10000 throttle points are supported.");
        double last=-1;
        for(const auto* p:*in->THROTTLE()) {
            if(!p||!nonnegative(p->ELAPSED_SECONDS())||p->ELAPSED_SECONDS()<=last||!nonnegative(p->FRACTION())||p->FRACTION()>1)
                return prwError(error,"invalid-burn: Throttle points require increasing nonnegative seconds and fractions in [0,1].");
            out.throttle.push_back({p->ELAPSED_SECONDS(),p->FRACTION()});last=p->ELAPSED_SECONDS();
        }
    }
    return true;
}
bool parseExecution(const PRWExecutionRequest* in,Execution& out,std::string& error) {
    if(!in||!in->INITIAL()||!in->INITIAL()->VALID())return prwError(error,"invalid-state: Execution requires a valid initial state.");
    if(!decodeResidentState(in->INITIAL(),out.initial,error))return false;
    if(!positive(out.initial.position.magnitude())||!std::isfinite(out.initial.velocity.magnitude()))
        return prwError(error,"invalid-state: Initial Cartesian state must have a finite nonzero radius.");
    const auto* initial=in->INITIAL();
    if(initial->HAS_DRAG_AREA_OVER_MASS_M2_KG()||initial->HAS_SRP_AREA_OVER_MASS_M2_KG()||initial->DRAG_AREA_OVER_MASS_M2_KG()!=0||initial->SRP_AREA_OVER_MASS_M2_KG()!=0)
        return prwError(error,"unsupported-state-coefficients: Supply explicit spacecraft force settings; resident ballistic coefficients are not an additional force source.");
    double utc=0;if(!decodeEpoch(in->TARGET_EPOCH(),out.target,utc,error))return false;
    if(in->TARGET_EPOCH()->TIME_SYSTEM()!=timingStandard::TDB)return prwError(error,"epoch-time-scale: Execution target and samples require TDB.");
    out.massDynamics=in->INCLUDE_MASS_DYNAMICS();
    if(in->FINITE_BURNS()&&in->FINITE_BURNS()->size()&&!out.massDynamics)return prwError(error,"invalid-burn: FINITE_BURNS requires INCLUDE_MASS_DYNAMICS.");
    if(out.massDynamics&&out.target<out.initial.epoch)return prwError(error,"invoke-failed: Finite burns require finite epochs and forward propagation.");
    if(!parseIntegrator(in->INTEGRATOR(),out.massDynamics,out.integrator,error)||!parseForces(in->FORCES(),out.initial.epoch,out.forces,error))return false;
    if(initial->STATE()->GRAVITATIONAL_PARAMETER()!=0 && initial->STATE()->GRAVITATIONAL_PARAMETER()!=in->FORCES()->GRAVITATIONAL_PARAMETER())
        return prwError(error,"invalid-forces: FRM and force gravitational parameters disagree.");
    if(!initial->HAS_MASS_KG()&&initial->MASS_KG()!=0)return prwError(error,"invalid-presence: MASS_KG requires HAS_MASS_KG.");
    out.mass=initial->HAS_MASS_KG()?initial->MASS_KG():out.forces.drag.mass;
    if(!positive(out.mass))return prwError(error,"invalid-state: Dynamical mass must be positive and finite.");
    if(initial->HAS_MASS_KG())out.forces.drag.mass=out.forces.srp.mass=out.mass;
    switch(in->STM_TECHNIQUE()) {
        case prwDerivativeTechnique::ANALYTIC:out.technique=Integrator::STMMethod::Analytic;break;
        case prwDerivativeTechnique::FINITE_DIFFERENCE:out.technique=Integrator::STMMethod::FiniteDifference;break;
        default:return prwError(error,"unsupported-derivatives: Explicit STM technique is required.");
    }
    if(out.massDynamics&&out.technique!=Integrator::STMMethod::Analytic)return prwError(error,"invoke-failed: Finite burns require STM_METHOD ANALYTIC.");
    switch(in->DENSITY_TREATMENT()) {
        case prwDensityTreatment::NEGLECTED:out.density=ForceModel::DensityGradient::Neglected;break;
        case prwDensityTreatment::FINITE_DIFFERENCE:out.density=ForceModel::DensityGradient::FiniteDifference;break;
        default:return prwError(error,"unsupported-derivatives: Explicit density treatment is required.");
    }
    if(initial->COVARIANCE()&&in->INITIAL_COVARIANCE())return prwError(error,"duplicate-covariance: INITIAL.COVARIANCE and INITIAL_COVARIANCE are mutually exclusive.");
    const auto* covariance=in->INITIAL_COVARIANCE()?in->INITIAL_COVARIANCE():initial->COVARIANCE();
    if(covariance) {
        if(covariance->DIMENSION()==7) {
            if(in->INITIAL_MASS_COVARIANCE())return prwError(error,"duplicate-covariance: Multiple seven-state initial covariances.");
            out.massCovariance=true;if(!prwCovariance(covariance,7,out.p7.data(),error))return false;
        } else {out.covariance=true;if(!prwCovariance(covariance,6,&out.p.m[0][0],error))return false;}
    }
    if(in->INITIAL_MASS_COVARIANCE()){out.massCovariance=true;if(!prwCovariance(in->INITIAL_MASS_COVARIANCE(),7,out.p7.data(),error))return false;}
    if(out.massCovariance&&!out.massDynamics)return prwError(error,"invalid-covariance: Seven-state covariance requires INCLUDE_MASS_DYNAMICS.");
    if(!prwProcessNoise(in->PROCESS_NOISE(),out.noise,error))return false;
    if(out.noise.enabled&&(!out.covariance||out.massDynamics))
        return prwError(error,"unsupported-configuration: PROCESS_NOISE applies to a six-state covariance without mass dynamics.");
    if(in->SAMPLE_EPOCHS()) {
        if(in->SAMPLE_EPOCHS()->size()>10000)return prwError(error,"invalid-samples: At most 10000 samples are supported.");
        for(const auto* epoch:*in->SAMPLE_EPOCHS()) {
            double jd=0;if(!decodeEpoch(epoch,jd,utc,error))return false;
            if(epoch->TIME_SYSTEM()!=timingStandard::TDB)return prwError(error,"epoch-time-scale: Sample epochs must be TDB.");
            if(out.massDynamics&&jd<out.initial.epoch)return prwError(error,"invoke-failed: Finite-burn sample epochs must not precede the initial epoch.");
            out.samples.push_back(jd);
        }
    }
    if(in->IMPULSES())for(const auto* impulse:*in->IMPULSES()) {
        ForceModel::ImpulsiveManeuverDef kick;
        if(!impulse||!decodeEpoch(impulse->EPOCH(),kick.epoch,utc,error)||!readVector(impulse->DELTA_V(),kick.deltaV,0.001,error))return false;
        if(impulse->EPOCH()->TIME_SYSTEM()!=timingStandard::TDB)return prwError(error,"epoch-time-scale: Impulse epochs must be TDB.");
        if(impulse->VECTOR_BASIS()!=prwSteeringBasis::INTEGRATION_FRAME&&impulse->VECTOR_BASIS()!=prwSteeringBasis::RTN_AXES)return prwError(error,"unsupported-impulse-frame: Impulses support integration-frame or RTN components.");
        kick.inRTN=impulse->VECTOR_BASIS()==prwSteeringBasis::RTN_AXES;out.impulses.push_back(kick);
    }
    if(in->FINITE_BURNS()) {
        if(in->FINITE_BURNS()->size()>Integrator::MaxFiniteBurns)return prwError(error,"invalid-burn: At most 16 burns are supported.");
        for(const auto* input:*in->FINITE_BURNS()) {
            Integrator::FiniteBurn burn;if(!parseBurn(input,initial->COORDINATE_SYSTEM()->NAME()->str(),(out.target-out.initial.epoch)*86400.0,burn,error))return false;
            out.burns.push_back(std::move(burn));
        }
    }
    out.variational=in->INCLUDE_STM()||out.covariance||out.massCovariance||out.massDynamics||!out.samples.empty()||!out.impulses.empty();
    return true;
}
std::unique_ptr<PRWStateMatrixT> matrix(const double* values,unsigned n,bool covariance) {
    auto out=std::make_unique<PRWStateMatrixT>();out->DIMENSION=n;out->VALUES.resize(n*n);
    for(unsigned i=0;i<n;++i)for(unsigned j=0;j<n;++j)out->VALUES[i*n+j]=values[i*n+j]*(i<6?1000:1)*(covariance?(j<6?1000:1):(j<6?0.001:1));
    return out;
}
bool preflightKernel(const Execution& in,double target,std::string& error) {
    if(Ephemeris::selectedEphemerisSource()==Ephemeris::EphemerisSource::Analytical)return true;
    const auto& f=in.forces;const auto& b=f.thirdBody;
    const std::pair<int,bool> bodies[]={{10,f.useSRP||(f.useThirdBody&&b.includeSun)},{301,f.useThirdBody&&b.includeMoon},{1,f.useThirdBody&&b.includeMercury},{2,f.useThirdBody&&b.includeVenus},{4,f.useThirdBody&&b.includeMars},{5,f.useThirdBody&&b.includeJupiter},{6,f.useThirdBody&&b.includeSaturn},{7,f.useThirdBody&&b.includeUranus},{8,f.useThirdBody&&b.includeNeptune}};
    for(const auto& body:bodies)if(body.second&&(!Ephemeris::getKernelState(body.first,399,in.initial.epoch).valid||!Ephemeris::getKernelState(body.first,399,target).valid)) {
        error="ephemeris-failed: "+Ephemeris::ephemerisError();return false;
    }
    return true;
}
bool evaluate(Execution& execution,const PRWExecutionRequest* request,double epoch,PRWPropagationSampleT& out,std::string& error) {
    if(!preflightKernel(execution,epoch,error))return false;
    const auto frame=std::unique_ptr<RFMCoordinateSystemT>(request->INITIAL()->COORDINATE_SYSTEM()->UnPack());
    const double seconds=(epoch-execution.initial.epoch)*86400;
    if(execution.massDynamics) {
        const auto value=Integrator::PropagateFiniteBurns(execution.initial,execution.mass,seconds,execution.integrator,execution.forces,execution.burns,execution.density,execution.impulses);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        auto state=value.finalState;state.epoch=epoch;out.STATE=makeState(state,*frame,request->INITIAL());out.STATE->HAS_MASS_KG=true;out.STATE->MASS_KG=value.massKg;
        Mat6 phi{};for(int i=0;i<6;++i)for(int j=0;j<6;++j)phi.m[i][j]=value.stm[i*7+j];
        out.STM=matrix(&phi.m[0][0],6,false);out.MASS_STM=matrix(value.stm.data(),7,false);
        if(execution.covariance){const auto p=Integrator::TransportCovariance(phi,execution.p);out.COVARIANCE=matrix(&p.m[0][0],6,true);}
        if(execution.massCovariance){const auto p=Integrator::TransportFiniteCovariance(value.stm,execution.p7);out.MASS_COVARIANCE=matrix(p.data(),7,true);}
        out.ACCEPTED_STEPS=value.steps;out.REJECTED_STEPS=value.rejections;
        for(size_t i=0;i<value.burns.size();++i) {
            const auto& burn=value.burns[i];auto report=std::make_unique<PRWBurnReportT>();
            report->BURN_INDEX=i;report->STARTED=burn.started;report->STOPPED=burn.stopped;report->START_BY_EVENT=burn.startByEvent;report->STOP_BY_EVENT=burn.stopByEvent;
            report->HAS_START_SECONDS=burn.started;report->HAS_STOP_SECONDS=burn.stopped;
            if(burn.started){report->START_SECONDS=burn.startSeconds;report->START_EPOCH=makeInstant(execution.initial.epoch+burn.startSeconds/86400);}
            if(burn.stopped){report->STOP_SECONDS=burn.stopSeconds;report->STOP_EPOCH=makeInstant(execution.initial.epoch+burn.stopSeconds/86400);}
            report->DELTA_V_M_S=burn.deltaVKmS*1000;report->PROPELLANT_KG=burn.propellantKg;out.BURNS.push_back(std::move(report));
        }
    } else if(execution.variational) {
        const auto value=Integrator::PropagateCovariance(execution.initial,seconds,execution.integrator,execution.forces,execution.technique,execution.density,execution.impulses,execution.p,execution.noise);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        auto state=value.finalState;state.epoch=epoch;out.STATE=makeState(state,*frame,request->INITIAL());out.STM=matrix(&value.stm.m[0][0],6,false);
        if(execution.covariance){out.COVARIANCE=matrix(&value.covariance.m[0][0],6,true);out.PROCESS_NOISE=prwProcessNoiseRecord(execution.noise);}
        out.ACCEPTED_STEPS=value.steps;out.REJECTED_STEPS=value.rejections;
    } else {
        auto config=execution.integrator;
        if(config.method==IntegrationMethod::Cowell)config.method=IntegrationMethod::RKF45;
        if(config.method==IntegrationMethod::RK4 && seconds>0 &&
           std::ceil(seconds/config.initialStep)>config.maxSteps)
            return prwError(error,"invoke-failed: RK4 request exceeds MAXIMUM_STEPS.");
        const auto value=Integrator::PropagateWithResult(execution.initial,seconds,config,execution.forces);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        auto state=value.finalState;state.epoch=epoch;out.STATE=makeState(state,*frame,request->INITIAL());out.ACCEPTED_STEPS=value.steps;out.REJECTED_STEPS=value.rejections;
    }
    if(request->INITIAL()->HAS_MASS_KG()&&!execution.massDynamics){out.STATE->HAS_MASS_KG=true;out.STATE->MASS_KG=execution.mass;}
    if(!Ephemeris::ephemerisError().empty()){error="ephemeris-failed: "+Ephemeris::ephemerisError();return false;}
    for(const auto* m:{out.STM.get(),out.MASS_STM.get(),out.COVARIANCE.get(),out.MASS_COVARIANCE.get()})
        if(m)for(const double value:m->VALUES)if(!std::isfinite(value))
            return prwError(error,"invoke-failed: State matrix transport overflowed its finite SI representation.");
    if(out.STATE->HAS_MASS_KG&&!positive(out.STATE->MASS_KG))
        return prwError(error,"invoke-failed: Propagation returned a nonpositive or nonfinite mass.");
    const auto& state=*out.STATE->STATE;
    if(!std::isfinite(state.POSITION->X)||!std::isfinite(state.POSITION->Y)||!std::isfinite(state.POSITION->Z)||!std::isfinite(state.VELOCITY->X)||!std::isfinite(state.VELOCITY->Y)||!std::isfinite(state.VELOCITY->Z))return prwError(error,"invoke-failed: Integration returned a nonfinite state.");
    return true;
}
bool execute(const PRWExecutionRequest* request,PRWT& response,std::string& error) {
    Execution execution;if(!parseExecution(request,execution,error))return false;
    auto result=std::make_unique<PRWExecutionResultT>();result->FINAL_SAMPLE=std::make_unique<PRWPropagationSampleT>();
    if(!evaluate(execution,request,execution.target,*result->FINAL_SAMPLE,error))return false;
    for(const double epoch:execution.samples){auto sample=std::make_unique<PRWPropagationSampleT>();if(!evaluate(execution,request,epoch,*sample,error))return false;result->SAMPLES.push_back(std::move(sample));}
    result->ELAPSED_SECONDS=(execution.target-execution.initial.epoch)*86400;result->EPHEMERIS_SOURCE=Ephemeris::ephemerisSourceName(Ephemeris::selectedEphemerisSource());
    if(execution.variational){result->STM_TECHNIQUE=request->STM_TECHNIQUE();result->DENSITY_TREATMENT=request->DENSITY_TREATMENT();}
    response.EXECUTION_RESULT=std::move(result);return true;
}
bool loadKernel(const uint8_t* data,size_t size,std::string& error) {
    const PRW* root=nullptr;if(!verifyPrw(data,size,root,error))return false;
    const auto* input=root->NATIVE_INPUT();if(!input)return prwError(error,"invalid-prw-arm: Kernel port requires NATIVE_INPUT.");
    const auto* ncd=input->DESCRIPTOR();const auto* content=input->CONTENT();
    if(!ncd||ncd->FORMAT()!=ncdContainerFormat::SPK_DAF||!content||content->size()==0||ncd->SOURCE_BYTE_LENGTH()!=content->size())return prwError(error,"invalid-kernel: NCD requires SPK_DAF and exact SOURCE_BYTE_LENGTH.");
    if(!ncd->SOURCE_SHA256()||ncd->SOURCE_SHA256()->size()!=64)return prwError(error,"invalid-kernel: NCD requires a 64-character SOURCE_SHA256.");
    auto expected=ncd->SOURCE_SHA256()->str();for(auto& c:expected)if(c>='A'&&c<='F')c+=32;
    if(expected!=ephem::sha256_hex(content->data(),content->size()))return prwError(error,"invalid-kernel: Kernel SOURCE_SHA256 does not match the supplied bytes.");
    if(!Ephemeris::loadEphemerisBuffer(content->data(),content->size())){error="invalid-kernel: "+Ephemeris::ephemerisError();return false;}
    return true;
}
bool ephemeris(const PRWEphemerisRequest* request,PRWT& response,std::string& error) {
    if(Ephemeris::selectedEphemerisSource()==Ephemeris::EphemerisSource::Analytical)return prwError(error,"missing-kernel: NAIF ephemeris query requires a kernel input.");
    if(request->EPOCH()->TIME_SYSTEM()!=timingStandard::TDB)return prwError(error,"epoch-time-scale: Geometric ephemeris query requires TDB.");
    double jd=0,utc=0;if(!decodeEpoch(request->EPOCH(),jd,utc,error))return false;
    const auto value=Ephemeris::getKernelState(request->TARGET_NAIF_ID(),request->CENTER_NAIF_ID(),jd);
    if(!value.valid){error="ephemeris-failed: "+Ephemeris::ephemerisError();return false;}
    auto result=std::make_unique<PRWEphemerisResultT>();result->TARGET_NAIF_ID=request->TARGET_NAIF_ID();result->CENTER_NAIF_ID=request->CENTER_NAIF_ID();
    StateVector state;state.position=value.position;state.velocity=value.velocity;state.epoch=jd;
    auto frame=makeFrame("ICRF/NAIF-"+std::to_string(request->CENTER_NAIF_ID()),rfmAxisType::ICRF,request->CENTER_NAIF_ID());
    if(request->CENTER_NAIF_ID()>=0&&request->CENTER_NAIF_ID()<=9){frame->ORIGIN->KIND=rfmOriginKind::BARYCENTRE;frame->ORIGIN->BARYCENTRE_ID=request->CENTER_NAIF_ID();frame->ORIGIN->CELESTIAL_BODY_ID=0;}
    result->STATE=makeState(state,*frame);result->EPHEMERIS_SOURCE=Ephemeris::ephemerisSourceName(value.source);response.EPHEMERIS_RESULT=std::move(result);return true;
}
bool atmosphere(const PRWAtmosphereRequest* request,PRWT& response,std::string& error) {
    if(request->EPOCH()->TIME_SYSTEM()!=timingStandard::UTC)return prwError(error,"epoch-time-scale: Atmospheric diagnostic epoch must be UTC.");
    double tdb=0,utc=0;if(!decodeEpoch(request->EPOCH(),tdb,utc,error))return false;
    const double altitude=request->ALTITUDE_M(),lat=request->LATITUDE_RAD(),lon=request->LONGITUDE_RAD();
    if(!nonnegative(altitude)||!std::isfinite(lat)||std::abs(lat)>PI/2||!std::isfinite(lon)||std::abs(lon)>PI||!nonnegative(request->F107())||!nonnegative(request->F107_AVERAGE())||!nonnegative(request->AP_INDEX()))
        return prwError(error,"invalid-atmosphere: Atmosphere inputs must be finite and within their physical domain.");
    if(!request->HAS_LOCAL_SOLAR_TIME_HOURS()&&request->LOCAL_SOLAR_TIME_HOURS()!=0)return prwError(error,"invalid-presence: Local solar time requires its presence bit.");
    if(request->HAS_LOCAL_SOLAR_TIME_HOURS()&&(!nonnegative(request->LOCAL_SOLAR_TIME_HOURS())||request->LOCAL_SOLAR_TIME_HOURS()>=24))return prwError(error,"invalid-atmosphere: Local solar time must be in [0,24).");
    auto result=std::make_unique<PRWAtmosphereResultT>();result->ATMOSPHERE_MODEL=request->ATMOSPHERE_MODEL();result->ALTITUDE_M=altitude;
    if(request->ATMOSPHERE_MODEL()==prwAtmosphereFamily::USSA1976) {
        if(altitude>86000)return prwError(error,"unsupported-atmosphere: USSA1976 profile covers 0 to 86 km geometric altitude.");
        if(request->INCLUDE_ANOMALOUS_OXYGEN())return prwError(error,"unsupported-atmosphere: Anomalous oxygen is an NRLMSISE00 option.");
        const auto value=computeUSSA1976(altitude*0.001);result->DENSITY_KG_M3=value.density;result->HAS_TEMPERATURE_K=true;result->TEMPERATURE_K=value.temperature;result->HAS_SCALE_HEIGHT_M=true;result->SCALE_HEIGHT_M=value.scaleHeight*1000;
    } else if(request->ATMOSPHERE_MODEL()==prwAtmosphereFamily::EXPONENTIAL) {
        if(request->INCLUDE_ANOMALOUS_OXYGEN())return prwError(error,"unsupported-atmosphere: Anomalous oxygen is an NRLMSISE00 option.");
        result->DENSITY_KG_M3=exponentialAtmosphereDensity(altitude*0.001);
    } else if(request->ATMOSPHERE_MODEL()==prwAtmosphereFamily::NRLMSISE00) {
        nrlmsise_input input{};nrlmsise_flags flags{};nrlmsise_output value{};
        int month=0,day=0,hour=0,minute=0;double seconds=0;
        timesys::Epoch(utc,timesys::TimeScale::UTC).toComponents(input.year,month,day,hour,minute,seconds);
        input.doy=int(std::floor(utc-timesys::Epoch::fromComponents(input.year,1,1,0,0,0,timesys::TimeScale::UTC).jd))+1;
        input.sec=hour*3600+minute*60+seconds;input.alt=altitude*0.001;input.g_lat=lat*180/PI;input.g_long=lon*180/PI;
        input.lst=request->HAS_LOCAL_SOLAR_TIME_HOURS()?request->LOCAL_SOLAR_TIME_HOURS():std::fmod(input.sec/3600+input.g_long/15+24,24);
        input.f107=request->F107();input.f107A=request->F107_AVERAGE();input.ap=request->AP_INDEX();
        flags.switches[0]=0;for(int i=1;i<24;++i)flags.switches[i]=1;
        if(request->INCLUDE_ANOMALOUS_OXYGEN())gtd7d(&input,&flags,&value);else gtd7(&input,&flags,&value);
        result->VARIANT=request->INCLUDE_ANOMALOUS_OXYGEN()?"gtd7d":"gtd7";result->DENSITY_KG_M3=value.d[5]*1000;result->HAS_TEMPERATURE_K=true;result->TEMPERATURE_K=value.t[1];result->HAS_EXOSPHERIC_TEMPERATURE_K=true;result->EXOSPHERIC_TEMPERATURE_K=value.t[0];
        const int indices[]={0,1,2,3,4,6,7,8};
        for(int i=0;i<8;++i){auto species=std::make_unique<PRWSpeciesDensityT>();species->CONSTITUENT=static_cast<prwDensitySpecies>(i+1);species->NUMBER_PER_M3=value.d[indices[i]]*1e6;result->NUMBER_DENSITIES.push_back(std::move(species));}
    } else return prwError(error,"unsupported-atmosphere: Diagnostic supports NRLMSISE00, USSA1976 and EXPONENTIAL.");
    if(!nonnegative(result->DENSITY_KG_M3))return prwError(error,"invoke-failed: Atmosphere returned an invalid density.");
    response.ATMOSPHERE_RESULT=std::move(result);return true;
}
} // namespace
bool processPrwInvoke(const uint8_t* data,size_t size,const uint8_t* kernel,size_t kernelSize,std::vector<uint8_t>& output,std::string& error) {
    struct KernelLifetime {KernelLifetime(){Ephemeris::clearEphemerisBuffer();}~KernelLifetime(){Ephemeris::clearEphemerisBuffer();}} kernelLifetime;
    const PRW* request=nullptr;if(!verifyPrw(data,size,request,error))return false;
    if(kernelSize&&!loadKernel(kernel,kernelSize,error))return false;
    PRWT response;bool ok=false;
    if(request->EXECUTION_REQUEST())ok=execute(request->EXECUTION_REQUEST(),response,error);
    else if(request->EPHEMERIS_REQUEST())ok=ephemeris(request->EPHEMERIS_REQUEST(),response,error);
    else if(request->ATMOSPHERE_REQUEST())ok=atmosphere(request->ATMOSPHERE_REQUEST(),response,error);
    else if(request->VERSION_QUERY()){response.VERSION_RESULT=std::make_unique<PRWVersionResultT>();response.VERSION_RESULT->VERSION="1.0.0";response.VERSION_RESULT->MODULE_ID="com.orbpro.hpop";ok=true;}
    else return prwError(error,"invalid-prw-arm: invoke requires execution, ephemeris, atmosphere or version query.");
    if(ok)encodePrw(response,output);return ok;
}
} // namespace hpop
