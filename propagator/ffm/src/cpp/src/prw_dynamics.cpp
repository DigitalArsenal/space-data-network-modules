#include "ffm/prw_dynamics.h"
#include <algorithm>
#include <limits>

namespace ffm {
namespace dynamics {
using namespace astro;

// GCRF <-> request axes.
Vec3 toRequestAxes(const Execution& e,const Vec3& v) {
    if(!e.meanJ2000)return v;const auto& b=e.bias;
    return Vec3(b[0][0]*v.x+b[0][1]*v.y+b[0][2]*v.z,b[1][0]*v.x+b[1][1]*v.y+b[1][2]*v.z,b[2][0]*v.x+b[2][1]*v.y+b[2][2]*v.z);
}
Vec3 toGcrf(const Execution& e,const Vec3& v) {
    if(!e.meanJ2000)return v;const auto& b=e.bias;
    return Vec3(b[0][0]*v.x+b[1][0]*v.y+b[2][0]*v.z,b[0][1]*v.x+b[1][1]*v.y+b[2][1]*v.z,b[0][2]*v.x+b[1][2]*v.y+b[2][2]*v.z);
}
// M <- R M R^T for an n x n row-major covariance or STM on [r, v, rest],
// R = diag(B, B, I) with B the bias (toRequest) or its transpose.
void rotateMatrix(const Execution& e,double* m,unsigned n,bool toRequest) {
    if(!e.meanJ2000)return;
    double r[3][3];for(int i=0;i<3;++i)for(int j=0;j<3;++j)r[i][j]=toRequest?e.bias[i][j]:e.bias[j][i];
    std::vector<double> big(n*n,0.0),tmp(n*n,0.0);
    for(unsigned i=0;i<n;++i)big[i*n+i]=1;
    for(int k=0;k<2;++k)for(int i=0;i<3;++i)for(int j=0;j<3;++j)big[(3*k+i)*n+3*k+j]=r[i][j];
    for(unsigned i=0;i<n;++i)for(unsigned j=0;j<n;++j){double v=0;for(unsigned k=0;k<n;++k)v+=big[i*n+k]*m[k*n+j];tmp[i*n+j]=v;}
    for(unsigned i=0;i<n;++i)for(unsigned j=0;j<n;++j){double v=0;for(unsigned k=0;k<n;++k)v+=tmp[i*n+k]*big[j*n+k];m[i*n+j]=v;}
}
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
// Radiation pressure family (PRW SDS 1.241.0, lib/gnss_srp.h): the cannonball
// (REFLECTIVITY_COEFFICIENT, AREA_M2), the GNSS box-wing a priori of a GPS
// block at INITIAL_MASS_KG, or none; and ECOM2 added to whichever. NONE is the
// cannonball at Cr 0, which contributes exactly nothing, so ECOM2 alone needs
// no other path. Cr and AREA_M2 belong to the cannonball; the other families
// do not read them.
bool parseRadiationPressure(const PRWForceConfiguration* in,ForceModel::SRPForceConfig& srp,std::string& error) {
    const bool srpOn=in->ENABLE_SRP();
    const auto family=in->RADIATION_PRESSURE_MODEL();
    if(!srpOn&&(family!=prwRadiationPressureFamily::CANNONBALL||in->GNSS_BLOCK()!=prwGnssSpacecraftBlock::UNSPECIFIED||in->ECOM2()))
        return prwError(error,"invalid-forces: RADIATION_PRESSURE_MODEL, GNSS_BLOCK and ECOM2 are radiation pressure; set ENABLE_SRP.");
    if(family!=prwRadiationPressureFamily::GNSS_BOX_WING&&in->GNSS_BLOCK()!=prwGnssSpacecraftBlock::UNSPECIFIED)
        return prwError(error,"invalid-forces: GNSS_BLOCK applies to RADIATION_PRESSURE_MODEL GNSS_BOX_WING.");
    switch(family) {
        case prwRadiationPressureFamily::CANNONBALL:srp.model=ForceModel::SRPModelType::Cannonball;break;
        case prwRadiationPressureFamily::NONE:srp.model=ForceModel::SRPModelType::Cannonball;srp.Cr=0;break;
        case prwRadiationPressureFamily::GNSS_BOX_WING:
            srp.model=ForceModel::SRPModelType::GnssBoxWing;
            switch(in->GNSS_BLOCK()) {
                case prwGnssSpacecraftBlock::GPS_IIR:srp.gnssBoxWing=gnss_srp::GpsBoxWing(gnss_srp::GpsBlock::IIR);break;
                case prwGnssSpacecraftBlock::GPS_IIR_M:srp.gnssBoxWing=gnss_srp::GpsBoxWing(gnss_srp::GpsBlock::IIR_M);break;
                case prwGnssSpacecraftBlock::GPS_IIF:srp.gnssBoxWing=gnss_srp::GpsBoxWing(gnss_srp::GpsBlock::IIF);break;
                case prwGnssSpacecraftBlock::UNSPECIFIED:return prwError(error,"invalid-forces: GNSS_BOX_WING needs GNSS_BLOCK.");
                default:return prwError(error,"unsupported-radiation-pressure: Unknown GNSS spacecraft block.");
            }
            break;
        default:return prwError(error,"unsupported-radiation-pressure: Unknown radiation pressure model.");
    }
    srp.ecom2=gnss_srp::Ecom2();
    if(const auto* e=in->ECOM2()) {
        const double c[11]={e->D0_M_S2(),e->Y0_M_S2(),e->B0_M_S2(),e->D2_COS_M_S2(),e->D2_SIN_M_S2(),e->D4_COS_M_S2(),e->D4_SIN_M_S2(),
                            e->B1_COS_M_S2(),e->B1_SIN_M_S2(),e->B3_COS_M_S2(),e->B3_SIN_M_S2()};
        srp.ecom2.enabled=true;
        // PRWEcom2's order is gnss_srp::Ecom2Term's; both are m/s^2.
        for(int k=0;k<=int(gnss_srp::Ecom2Term::B3s);++k) {
            if(!std::isfinite(c[k]))return prwError(error,"invalid-forces: ECOM2 coefficients must be finite.");
            gnss_srp::Ecom2Coefficient(srp.ecom2,gnss_srp::Ecom2Term(k))=c[k];
        }
    }
    return true;
}
bool parseForces(const PRWForceConfiguration* in,const timesys::Instant& epoch,bool hasEarthOrientation,ForceModel::ForceModelSet& out,std::string& error) {
    if(!in)return prwError(error,"invalid-forces: Missing force configuration.");
    out.usePointMass=in->ENABLE_POINT_MASS();out.mu=in->GRAVITATIONAL_PARAMETER()*1e-9;
    out.useSphericalHarmonics=in->ENABLE_J2()||in->ENABLE_J3()||in->ENABLE_J4()||in->ENABLE_HIGHER_ZONALS();
    out.sphericalHarmonics.includeJ2=in->ENABLE_J2();out.sphericalHarmonics.includeJ3=in->ENABLE_J3();out.sphericalHarmonics.includeJ4=in->ENABLE_J4();out.sphericalHarmonics.includeHigherZonals=in->ENABLE_HIGHER_ZONALS();out.sphericalHarmonics.mu=out.mu;
    // One Earth-fixed field evaluates every gravity selection except the point
    // mass: the embedded EGM2008 coefficients through the Pines/Cunningham
    // recursion (computeExtendedGravity), in Earth-fixed axes. J2_ONLY and
    // J2_TO_J4 are that field to degree 2 or 4, order 0 (the closed forms in
    // force_models.cpp remain as test oracles only; they hold the symmetry axis
    // at inertial z). SPHERICAL_HARMONICS and EGM2008 are the field to the
    // stated degree and order, every coefficient included: the zonal flags
    // gate only INFER_FLAGS, the legacy selection. Before 2026-10-08,
    // SPHERICAL_HARMONICS without the flags silently returned the point mass.
    if(!in->HAS_MAXIMUM_DEGREE()&&in->MAXIMUM_DEGREE())return prwError(error,"invalid-presence: MAXIMUM_DEGREE requires HAS_MAXIMUM_DEGREE.");
    if(!in->HAS_MAXIMUM_ORDER()&&in->MAXIMUM_ORDER())return prwError(error,"invalid-presence: MAXIMUM_ORDER requires HAS_MAXIMUM_ORDER.");
    // EGM96 is the same evaluation of the embedded EGM96 set (lib/egm96_data.h).
    // MAXIMUM_TESSERAL_DEGREE (a VCM's "nnT") drops tesseral and sectorial
    // terms above that degree; the zonals run to MAXIMUM_DEGREE.
    if(!in->HAS_MAXIMUM_TESSERAL_DEGREE()&&in->MAXIMUM_TESSERAL_DEGREE())return prwError(error,"invalid-presence: MAXIMUM_TESSERAL_DEGREE requires HAS_MAXIMUM_TESSERAL_DEGREE.");
    const auto field=[&](int degree,int order,ForceModel::EmbeddedEarthField model)->bool{
        if(degree<2||degree>70)return prwError(error,"unsupported-gravity: The embedded EGM2008 and EGM96 fields support degrees two through seventy.");
        if(order<0||order>degree)return prwError(error,"unsupported-gravity: Field order must be between zero and the degree.");
        out.gravityMode=ForceModel::GravityMode::EGM2008;out.egm2008.truncationDegree=degree;out.egm2008.truncationOrder=order;
        out.egm2008.field=model;out.egm2008.maxTesseralDegree=UINT16_MAX;
        if(in->HAS_MAXIMUM_TESSERAL_DEGREE()) {
            if(in->MAXIMUM_TESSERAL_DEGREE()>degree)return prwError(error,"invalid-forces: MAXIMUM_TESSERAL_DEGREE must not exceed MAXIMUM_DEGREE.");
            out.egm2008.maxTesseralDegree=in->MAXIMUM_TESSERAL_DEGREE();
        }
        out.useSphericalHarmonics=false;
        return true;
    };
    out.sphericalHarmonics.maxOrder=0;out.egm2008.truncationOrder=0;
    switch(in->GRAVITY_CHOICE()) {
    case prwGravitySelection::INFER_FLAGS:
        if(in->HAS_MAXIMUM_TESSERAL_DEGREE())return prwError(error,"invalid-forces: MAXIMUM_TESSERAL_DEGREE applies to SPHERICAL_HARMONICS, EGM2008 and EGM96.");
        out.gravityMode=ForceModel::GravityMode::Infer;
        if(in->HAS_MAXIMUM_DEGREE())out.sphericalHarmonics.maxDegree=in->MAXIMUM_DEGREE();
        if(in->HAS_MAXIMUM_ORDER())out.sphericalHarmonics.maxOrder=in->MAXIMUM_ORDER();
        if(out.useSphericalHarmonics&&out.sphericalHarmonics.maxDegree>20)
            return prwError(error,"unsupported-gravity: The inline spherical-harmonic field supports degrees zero through twenty.");
        break;
    case prwGravitySelection::POINT_MASS:
        if(in->HAS_MAXIMUM_TESSERAL_DEGREE())return prwError(error,"invalid-forces: MAXIMUM_TESSERAL_DEGREE applies to SPHERICAL_HARMONICS, EGM2008 and EGM96.");
        out.gravityMode=ForceModel::GravityMode::PointMass;break;
    case prwGravitySelection::J2_ONLY:
    case prwGravitySelection::J2_TO_J4:
        if(in->HAS_MAXIMUM_DEGREE()||in->HAS_MAXIMUM_ORDER()||in->HAS_MAXIMUM_TESSERAL_DEGREE())
            return prwError(error,"invalid-forces: J2_ONLY and J2_TO_J4 fix their own degree; select SPHERICAL_HARMONICS for another truncation.");
        if(!field(in->GRAVITY_CHOICE()==prwGravitySelection::J2_ONLY?2:4,0,ForceModel::EmbeddedEarthField::EGM2008))return false;
        break;
    case prwGravitySelection::SPHERICAL_HARMONICS:
    case prwGravitySelection::EGM2008:
    case prwGravitySelection::EGM96:
        if(!in->HAS_MAXIMUM_DEGREE()||!in->HAS_MAXIMUM_ORDER())
            return prwError(error,"invalid-forces: A field selection states both MAXIMUM_DEGREE and MAXIMUM_ORDER.");
        if(!field(in->MAXIMUM_DEGREE(),in->MAXIMUM_ORDER(),in->GRAVITY_CHOICE()==prwGravitySelection::EGM96?ForceModel::EmbeddedEarthField::EGM96:ForceModel::EmbeddedEarthField::EGM2008))return false;
        break;
    default:return prwError(error,"unsupported-gravity: Unknown gravity selection.");
    }
    if(!nonnegative(out.mu) || ((out.usePointMass||out.useSphericalHarmonics||out.gravityMode!=ForceModel::GravityMode::Infer)&&out.mu==0))
        return prwError(error,"invalid-forces: Enabled central gravity requires a positive finite SI gravitational parameter.");
    // GRAVITATIONAL_PARAMETER is the central term's GM. The field's harmonics
    // use the field's own, EGM2008's TT-compatible 3.986004415e14 m^3/s^2
    // (FFM integrates on TT; the TCG-compatible 3.986004418e14 is 7.5e-10
    // larger, about 1 m a day along track in LEO).
    // Tesseral terms are Earth-fixed: they need Earth orientation data.
    const bool tesseral=(out.gravityMode==ForceModel::GravityMode::EGM2008&&out.egm2008.truncationOrder>0)||
        (out.gravityMode==ForceModel::GravityMode::Infer&&out.useSphericalHarmonics&&out.sphericalHarmonics.maxOrder>0);
    if(tesseral&&!hasEarthOrientation)
        return prwError(error,"eop-data-required: Tesseral gravity requires Earth orientation data on the earth_orientation input.");
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
    if(!parseRadiationPressure(in,out.srp,error))return false;
    switch(in->ATMOSPHERE_MODEL()) {
        case prwAtmosphereFamily::NRLMSISE00:out.dragModel=ForceModel::DragModelType::NRLMSISE00;break;
        case prwAtmosphereFamily::EXPONENTIAL:out.dragModel=ForceModel::DragModelType::Exponential;break;
        case prwAtmosphereFamily::USSA1976:out.dragModel=ForceModel::DragModelType::USSA1976;break;
        case prwAtmosphereFamily::HARRIS_PRIESTER:out.dragModel=ForceModel::DragModelType::HarrisPriester;break;
        // JB2008 (lib/jb2008.h): geodetic and Sun-relative, so Earth-fixed;
        // its drivers come from the jb2008_indices input only.
        case prwAtmosphereFamily::JB2008:
            if(out.useDrag&&!hasEarthOrientation)return prwError(error,"eop-data-required: JB2008 is evaluated in Earth-fixed axes; supply earth_orientation.");
            if(in->WEATHER())return prwError(error,"invalid-weather: JB2008 reads the jb2008_indices input; omit WEATHER.");
            out.dragModel=ForceModel::DragModelType::JB2008;break;
        // Jacchia-Roberts (lib/jacchia_roberts.h), also Earth-fixed; drivers from
        // WEATHER or the space_weather input like NRLMSISE-00.
        case prwAtmosphereFamily::JACCHIA_ROBERTS:
            if(out.useDrag&&!hasEarthOrientation)return prwError(error,"eop-data-required: Jacchia-Roberts is evaluated in Earth-fixed axes; supply earth_orientation.");
            out.dragModel=ForceModel::DragModelType::JacchiaRoberts;break;
        default:return prwError(error,"unsupported-atmosphere: Unknown atmosphere selection.");
    }
    out.drag.model=out.dragModel;out.explicitEpochContract=true;out.integrationEpochTT=epoch;out.weather.epoch=epoch.utc().jd();
    if(const auto* weather=in->WEATHER()) {
        if(!weather->EPOCH()||weather->EPOCH()->TIME_SYSTEM()!=timingStandard::UTC)return prwError(error,"epoch-time-scale: Space-weather epoch must be UTC.");
        double tdb=0,utc=0;if(!decodeEpoch(weather->EPOCH(),tdb,utc,error))return false;
        out.weather.epoch=utc;out.weather.F107=weather->F107();out.weather.F107a=weather->F107_AVERAGE();out.weather.Ap=weather->AP_INDEX();out.weather.Kp=weather->KP_INDEX();out.weather.kp3h=out.weather.Kp;
        if(!nonnegative(out.weather.F107)||!nonnegative(out.weather.F107a)||!nonnegative(out.weather.Ap)||!nonnegative(out.weather.Kp)||out.weather.Kp>9)
            return prwError(error,"invalid-weather: Space-weather indices must be finite and within their domain.");
    }
    // Solid Earth tides (PRW SOLID_TIDES, SDS 1.240.0).
    switch(in->SOLID_TIDES()) {
        case prwSolidTideModel::NONE:break;
        case prwSolidTideModel::IERS_2010:
            if(!hasEarthOrientation)return prwError(error,"eop-data-required: Solid Earth tides are Earth-fixed; supply earth_orientation.");
            out.useSolidTides=true;out.solidTides=ForceModel::SolidTideConfig();break;
        default:return prwError(error,"unsupported-solid-tides: Unknown solid tide model.");
    }
    // Post-Newtonian terms, IERS Conventions (2010) eq. 10.12 with beta = gamma = 1.
    switch(in->RELATIVITY()) {
        case prwRelativityTerms::NONE:break;
        case prwRelativityTerms::SCHWARZSCHILD:
            out.useRelativisticCorrection=true;out.relativistic.schwarzschild=true;out.relativistic.lenseThirring=out.relativistic.deSitter=false;break;
        case prwRelativityTerms::IERS_2010:
            out.useRelativisticCorrection=true;out.relativistic.schwarzschild=out.relativistic.lenseThirring=out.relativistic.deSitter=true;break;
        default:return prwError(error,"unsupported-relativity: Unknown relativity terms.");
    }
    // Earth radiation pressure (PRW EARTH_RADIATION, SDS 1.243.0): Knocke
    // albedo and infrared (lib/earth_radiation.h) on an isotropic Cr*A/m, the
    // request's own or the cannonball's.
    switch(in->EARTH_RADIATION()) {
        case prwEarthRadiationModel::NONE:
            if(in->HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG())
                return prwError(error,"invalid-forces: EARTH_RADIATION_AREA_OVER_MASS_M2_KG applies to EARTH_RADIATION KNOCKE.");
            break;
        case prwEarthRadiationModel::KNOCKE: {
            const double resolution=in->EARTH_RADIATION_RESOLUTION_DEG();
            if(!(std::isfinite(resolution)&&resolution>=1&&resolution<=45))
                return prwError(error,"invalid-forces: EARTH_RADIATION_RESOLUTION_DEG must lie in [1, 45] degrees.");
            out.useEarthRadiation=true;out.earthRadiation=ForceModel::EarthRadiationConfig();out.earthRadiation.resolutionDeg=resolution;
            if(in->HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG()) {
                const double coefficient=in->EARTH_RADIATION_AREA_OVER_MASS_M2_KG();
                if(!nonnegative(coefficient))return prwError(error,"invalid-forces: EARTH_RADIATION_AREA_OVER_MASS_M2_KG must be finite and non-negative.");
                out.earthRadiation.crAreaOverMass=coefficient;
            } else {
                if(out.srp.model!=ForceModel::SRPModelType::Cannonball)
                    return prwError(error,"invalid-forces: Earth radiation with a GNSS box-wing needs EARTH_RADIATION_AREA_OVER_MASS_M2_KG.");
                out.earthRadiation.sharesSrpCoefficient=true;
            }
            break;
        }
        default:return prwError(error,"unsupported-earth-radiation: Unknown Earth radiation model.");
    }
    // Ocean tides (PRW OCEAN_TIDES, SDS 1.243.0): FES2004, IERS Conventions
    // (2010) section 6.3, to degree and order 50.
    switch(in->OCEAN_TIDES()) {
        case prwOceanTideModel::NONE:break;
        case prwOceanTideModel::FES2004: {
            if(!hasEarthOrientation)return prwError(error,"eop-data-required: Ocean tides are Earth-fixed; supply earth_orientation.");
            const int degree=in->OCEAN_TIDE_MAXIMUM_DEGREE(),order=in->OCEAN_TIDE_MAXIMUM_ORDER();
            if(degree<2||degree>50||order>degree)
                return prwError(error,"invalid-forces: OCEAN_TIDE_MAXIMUM_DEGREE must lie in [2, 50] and OCEAN_TIDE_MAXIMUM_ORDER not exceed it.");
            out.useOceanTides=true;out.oceanTides.maxDegree=static_cast<uint16_t>(degree);out.oceanTides.maxOrder=static_cast<uint16_t>(order);
            out.oceanTideCache=ForceModel::MakeOceanTideCache();break;
        }
        default:return prwError(error,"unsupported-ocean-tides: Unknown ocean tide model.");
    }
    // Constant in-track acceleration (the VCM's in-track thrust): T of RTN.
    if(!in->HAS_IN_TRACK_ACCELERATION_M_S2()&&in->IN_TRACK_ACCELERATION_M_S2()!=0)
        return prwError(error,"invalid-presence: IN_TRACK_ACCELERATION_M_S2 requires HAS_IN_TRACK_ACCELERATION_M_S2.");
    if(in->HAS_IN_TRACK_ACCELERATION_M_S2()) {
        if(!std::isfinite(in->IN_TRACK_ACCELERATION_M_S2()))return prwError(error,"invalid-forces: In-track acceleration must be finite.");
        // A constant RTN contribution (T = N x R, N along r x v), which has
        // analytic partials (force_partials.cpp), unlike EmpiricalAccel.
        out.useContributions=true;out.contributions=ForceModel::ContributionSet();out.contributions.count=1;
        auto& slot=out.contributions.slots[0];
        slot.kind=ForceModel::ContributionKind::ConstantRTN;slot.p[1]=in->IN_TRACK_ACCELERATION_M_S2()*1e-3;
    }
    // Rate of change of Cd*A/m (the VCM's BDOT), from the initial epoch (also
    // the reference of the rate's sensitivity when the rate is zero).
    out.dragRateEpochTT=epoch;
    if(!in->HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S()&&in->DRAG_AREA_OVER_MASS_RATE_M2_KG_S()!=0)
        return prwError(error,"invalid-presence: DRAG_AREA_OVER_MASS_RATE_M2_KG_S requires HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S.");
    if(in->HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S()) {
        if(!std::isfinite(in->DRAG_AREA_OVER_MASS_RATE_M2_KG_S()))return prwError(error,"invalid-forces: The Cd*A/m rate must be finite.");
        if(!out.useDrag)return prwError(error,"invalid-forces: DRAG_AREA_OVER_MASS_RATE_M2_KG_S applies to drag; enable drag.");
        if(!positive(out.drag.area))return prwError(error,"invalid-forces: A Cd*A/m rate needs a positive area.");
        out.dragAreaOverMassRate=in->DRAG_AREA_OVER_MASS_RATE_M2_KG_S();out.dragRateEpochTT=epoch;
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
bool parseExecution(const PRWExecutionRequest* in,bool hasEarthOrientation,Execution& out,std::string& error) {
    if(!in||!in->INITIAL()||!in->INITIAL()->VALID())return prwError(error,"invalid-state: Execution requires a valid initial state.");
    coords::Frame axes=coords::Frame::GCRF;
    if(!decodeResidentState(in->INITIAL(),out.initial,error,&axes)||!decodeStateEpochTT(in->INITIAL(),out.initialTT,error))return false;
    if(axes==coords::Frame::J2000) {
        out.meanJ2000=true;double rp[3][3],rbp[3][3];eraBp00(2451545.0,0.0,out.bias,rp,rbp);
        out.initial.position=toGcrf(out,out.initial.position);out.initial.velocity=toGcrf(out,out.initial.velocity);
    }
    if(!positive(out.initial.position.magnitude())||!std::isfinite(out.initial.velocity.magnitude()))
        return prwError(error,"invalid-state: Initial Cartesian state must have a finite nonzero radius.");
    const auto* initial=in->INITIAL();
    if(initial->HAS_DRAG_AREA_OVER_MASS_M2_KG()||initial->HAS_SRP_AREA_OVER_MASS_M2_KG()||initial->DRAG_AREA_OVER_MASS_M2_KG()!=0||initial->SRP_AREA_OVER_MASS_M2_KG()!=0||
       initial->HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S()||initial->DRAG_AREA_OVER_MASS_RATE_M2_KG_S()!=0||initial->HAS_IN_TRACK_ACCELERATION_M_S2()||initial->IN_TRACK_ACCELERATION_M_S2()!=0)
        return prwError(error,"unsupported-state-coefficients: Supply explicit spacecraft force settings; resident ballistic coefficients are not an additional force source.");
    double utc=0;
    if(!decodeEpochTT(in->TARGET_EPOCH(),out.targetTT,error))return false;
    out.target=timesys::ttToTdb(out.targetTT.jdTt());
    out.massDynamics=in->INCLUDE_MASS_DYNAMICS();
    if(in->FINITE_BURNS()&&in->FINITE_BURNS()->size()&&!out.massDynamics)return prwError(error,"invalid-burn: FINITE_BURNS requires INCLUDE_MASS_DYNAMICS.");
    if(out.massDynamics&&out.target<out.initial.epoch)return prwError(error,"invoke-failed: Finite burns require finite epochs and forward propagation.");
    if(!parseIntegrator(in->INTEGRATOR(),out.massDynamics,out.integrator,error)||!parseForces(in->FORCES(),out.initialTT.instant(),hasEarthOrientation,out.forces,error))return false;
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
    // Dynamic parameters carried after the state (a VCM's B, BDOT, AGOM, T).
    if(in->DYNAMIC_PARAMETERS())for(const auto p:*in->DYNAMIC_PARAMETERS()) {
        ForceModel::DynamicParameter q;
        switch(p) {
            case prwDynamicParameter::DRAG_AREA_OVER_MASS:q=ForceModel::DynamicParameter::DragAreaOverMass;break;
            case prwDynamicParameter::DRAG_AREA_OVER_MASS_RATE:q=ForceModel::DynamicParameter::DragAreaOverMassRate;break;
            case prwDynamicParameter::SRP_AREA_OVER_MASS:q=ForceModel::DynamicParameter::SrpAreaOverMass;break;
            case prwDynamicParameter::IN_TRACK_ACCELERATION:q=ForceModel::DynamicParameter::InTrackAcceleration;break;
            // ECOM2_D0 .. ECOM2_B3_SIN: one ordinal each, in PRWEcom2's order.
            case prwDynamicParameter::ECOM2_D0:case prwDynamicParameter::ECOM2_Y0:case prwDynamicParameter::ECOM2_B0:
            case prwDynamicParameter::ECOM2_D2_COS:case prwDynamicParameter::ECOM2_D2_SIN:case prwDynamicParameter::ECOM2_D4_COS:
            case prwDynamicParameter::ECOM2_D4_SIN:case prwDynamicParameter::ECOM2_B1_COS:case prwDynamicParameter::ECOM2_B1_SIN:
            case prwDynamicParameter::ECOM2_B3_COS:case prwDynamicParameter::ECOM2_B3_SIN:
                q=ForceModel::DynamicParameter(int(ForceModel::DynamicParameter::Ecom2D0)+int(p)-int(prwDynamicParameter::ECOM2_D0));break;
            default:return prwError(error,"unsupported-parameter: Unknown dynamic parameter.");
        }
        if(q==ForceModel::DynamicParameter::SrpAreaOverMass&&in->FORCES()->RADIATION_PRESSURE_MODEL()!=prwRadiationPressureFamily::CANNONBALL)
            return prwError(error,"invalid-parameters: SRP_AREA_OVER_MASS is the cannonball's Cr*A/m; RADIATION_PRESSURE_MODEL must be CANNONBALL.");
        if(std::find(out.parameters.begin(),out.parameters.end(),q)!=out.parameters.end())return prwError(error,"invalid-parameters: DYNAMIC_PARAMETERS must not repeat.");
        if(const char* reason=ForceModel::ValidateParameter(q,out.forces)){error=std::string("invalid-parameters: ")+reason;return false;}
        out.parameters.push_back(q);
    }
    if(!out.parameters.empty()&&(out.massDynamics||in->INITIAL_MASS_COVARIANCE()))
        return prwError(error,"unsupported-configuration: DYNAMIC_PARAMETERS apply to the six-state propagation without mass dynamics.");
    if(initial->COVARIANCE()&&in->INITIAL_COVARIANCE())return prwError(error,"duplicate-covariance: INITIAL.COVARIANCE and INITIAL_COVARIANCE are mutually exclusive.");
    const auto* covariance=in->INITIAL_COVARIANCE()?in->INITIAL_COVARIANCE():initial->COVARIANCE();
    if(covariance&&!out.parameters.empty()) {
        const unsigned n=6+unsigned(out.parameters.size());
        if(covariance->DIMENSION()!=n)return prwError(error,"invalid-covariance: With DYNAMIC_PARAMETERS the covariance is six plus their number square.");
        out.covariance=true;out.pParameters.assign(n*n,0.0);
        if(!prwCovariance(covariance,n,out.pParameters.data(),error))return false;
        rotateMatrix(out,out.pParameters.data(),n,false);
    } else if(covariance) {
        if(covariance->DIMENSION()==7) {
            if(in->INITIAL_MASS_COVARIANCE())return prwError(error,"duplicate-covariance: Multiple seven-state initial covariances.");
            out.massCovariance=true;if(!prwCovariance(covariance,7,out.p7.data(),error))return false;
        } else {out.covariance=true;if(!prwCovariance(covariance,6,&out.p.m[0][0],error))return false;}
    }
    if(in->INITIAL_MASS_COVARIANCE()){out.massCovariance=true;if(!prwCovariance(in->INITIAL_MASS_COVARIANCE(),7,out.p7.data(),error))return false;}
    // Covariances arrive in the request's axes.
    if(out.covariance&&out.parameters.empty())rotateMatrix(out,&out.p.m[0][0],6,false);
    if(out.massCovariance)rotateMatrix(out,out.p7.data(),7,false);
    if(out.massCovariance&&!out.massDynamics)return prwError(error,"invalid-covariance: Seven-state covariance requires INCLUDE_MASS_DYNAMICS.");
    if(!prwProcessNoise(in->PROCESS_NOISE(),out.noise,error))return false;
    if(out.noise.enabled&&(!out.covariance||out.massDynamics))
        return prwError(error,"unsupported-configuration: PROCESS_NOISE applies to a six-state covariance without mass dynamics.");
    if(in->SAMPLE_EPOCHS()) {
        if(in->SAMPLE_EPOCHS()->size()>10000)return prwError(error,"invalid-samples: At most 10000 samples are supported.");
        for(const auto* epoch:*in->SAMPLE_EPOCHS()) {
            TTEpoch tt;if(!decodeEpochTT(epoch,tt,error))return false;
            if(out.massDynamics&&elapsedSeconds(out.initialTT,tt)<0)return prwError(error,"invoke-failed: Finite-burn sample epochs must not precede the initial epoch.");
            out.samplesTT.push_back(tt);out.samples.push_back(timesys::ttToTdb(tt.jdTt()));
        }
    }
    if(in->IMPULSES())for(const auto* impulse:*in->IMPULSES()) {
        ForceModel::ImpulsiveManeuverDef kick;
        TTEpoch tt;
        if(!impulse||!decodeEpochTT(impulse->EPOCH(),tt,error)||!readVector(impulse->DELTA_V(),kick.deltaV,0.001,error))return false;
        kick.epoch=timesys::ttToTdb(tt.jdTt());
        if(impulse->VECTOR_BASIS()!=prwSteeringBasis::INTEGRATION_FRAME&&impulse->VECTOR_BASIS()!=prwSteeringBasis::RTN_AXES)return prwError(error,"unsupported-impulse-frame: Impulses support integration-frame or RTN components.");
        kick.inRTN=impulse->VECTOR_BASIS()==prwSteeringBasis::RTN_AXES;if(!kick.inRTN)kick.deltaV=toGcrf(out,kick.deltaV);
        out.impulses.push_back(kick);
    }
    if(in->FINITE_BURNS()) {
        if(in->FINITE_BURNS()->size()>Integrator::MaxFiniteBurns)return prwError(error,"invalid-burn: At most 16 burns are supported.");
        for(const auto* input:*in->FINITE_BURNS()) {
            Integrator::FiniteBurn burn;if(!parseBurn(input,initial->COORDINATE_SYSTEM()->NAME()->str(),elapsedSeconds(out.initialTT,out.targetTT),burn,error))return false;
            if(burn.frame==Integrator::BurnFrame::Inertial){burn.direction=toGcrf(out,burn.direction);burn.steeringRate=toGcrf(out,burn.steeringRate);}
            out.burns.push_back(std::move(burn));
        }
    }
    out.variational=in->INCLUDE_STM()||out.covariance||out.massCovariance||out.massDynamics||!out.samples.empty()||!out.impulses.empty();
    out.stateOnly=!in->INCLUDE_STM()&&!out.covariance&&!out.massCovariance&&!out.massDynamics&&out.impulses.empty()&&out.burns.empty()&&out.parameters.empty();
    return true;
}
bool preflightKernel(const Execution& in,const timesys::Instant& target,std::string& error) {
    if(Ephemeris::selectedEphemerisSource()==Ephemeris::EphemerisSource::Analytical)return true;
    const auto& f=in.forces;const auto& b=f.thirdBody;
    const std::pair<int,bool> bodies[]={{10,f.useSRP||(f.useThirdBody&&b.includeSun)},{301,f.useThirdBody&&b.includeMoon},{1,f.useThirdBody&&b.includeMercury},{2,f.useThirdBody&&b.includeVenus},{4,f.useThirdBody&&b.includeMars},{5,f.useThirdBody&&b.includeJupiter},{6,f.useThirdBody&&b.includeSaturn},{7,f.useThirdBody&&b.includeUranus},{8,f.useThirdBody&&b.includeNeptune}};
    for(const auto& body:bodies)if(body.second&&(!Ephemeris::getKernelState(body.first,399,in.initialTT.instant()).valid||!Ephemeris::getKernelState(body.first,399,target).valid)) {
        error="ephemeris-failed: "+Ephemeris::ephemerisError();return false;
    }
    return true;
}
double utcJd(const TTEpoch& tt) {return tt.instant().utc().jd();}
// The table's change epochs strictly inside the arc (initial, target and
// samples), ascending.
std::vector<TTEpoch> driverBreaks(const Execution& e) {
    TTEpoch lo=e.initialTT,hi=e.initialTT;
    for(const TTEpoch* t:{&e.targetTT}){if(elapsedSeconds(lo,*t)<0)lo=*t;if(elapsedSeconds(hi,*t)>0)hi=*t;}
    for(const auto& t:e.samplesTT){if(elapsedSeconds(lo,t)<0)lo=t;if(elapsedSeconds(hi,t)>0)hi=t;}
    return driverBreaks(e,lo,hi);
}
std::vector<TTEpoch> driverBreaks(const Execution& e,const TTEpoch& lo,const TTEpoch& hi) {
    std::vector<TTEpoch> out;
    const bool msis=e.forces.dragModel==ForceModel::DragModelType::NRLMSISE00,jr=e.forces.dragModel==ForceModel::DragModelType::JacchiaRoberts;
    if(!e.forces.useDrag||!(msis||jr))return out;
    // UTC seconds since 2000-01-01T12:00 UTC, as parseIsoSeconds counts them.
    const auto utcSeconds=[](const TTEpoch& t){return t.whole+t.fraction-(double(timesys::getLeapSeconds(utcJd(t)))+32.184);};
    const double period=3*3600.0,from=utcSeconds(lo)-period,to=utcSeconds(hi)+period;
    std::vector<double> phases{0.0};
    if(jr)phases.push_back(6.7*3600.0);
    for(const double phase:phases)
        for(double s=std::floor((from+43200.0-phase)/period)*period+phase-43200.0;s<=to;s+=period) {
            TTEpoch tt;std::string ignored;const double whole=std::floor(s);
            if(!toTT(whole,s-whole,2451545.0+s/86400.0,timingStandard::UTC,tt,ignored))continue;
            if(elapsedSeconds(lo,tt)>0&&elapsedSeconds(tt,hi)>0)out.push_back(tt);
        }
    if(e.densityCorrectionBreaks)for(const auto& tt:*e.densityCorrectionBreaks)
        if(elapsedSeconds(lo,tt)>0&&elapsedSeconds(tt,hi)>0)out.push_back(tt);
    std::sort(out.begin(),out.end(),[](const TTEpoch& a,const TTEpoch& b){return elapsedSeconds(a,b)>0;});
    out.erase(std::unique(out.begin(),out.end(),[](const TTEpoch& a,const TTEpoch& b){return elapsedSeconds(a,b)==0;}),out.end());
    return out;
}
// The breaks strictly between from and to, in the direction of travel.
std::vector<TTEpoch> breaksBetween(const Execution& e,const TTEpoch& from,const TTEpoch& to) {
    std::vector<TTEpoch> out;const double span=elapsedSeconds(from,to);
    for(const auto& b:e.breaks){const double s=elapsedSeconds(from,b);if((span>0&&s>0&&s<span)||(span<0&&s<0&&s>span))out.push_back(b);}
    if(span<0)std::reverse(out.begin(),out.end());
    return out;
}
// The span the table is read in while [from, to] is integrated.
void setDriverSpan(Execution& e,const TTEpoch& from,const TTEpoch& to) {
    if(!e.driverSpan)return;
    const double a=utcJd(from),b=utcJd(to);
    *e.driverSpan={std::min(a,b),std::max(a,b)};
}
// The 6-state equations from (state, at) to `to`, span by span through the
// space-weather breaks (one span without them), the force clock restarting
// with each span as the variational path's segments do. state and at
// advance; steps and rejections accumulate.
bool propagateState(Execution& execution,StateVector& state,TTEpoch& at,const TTEpoch& to,uint32_t& steps,uint32_t& rejections,std::string& error) {
    auto config=execution.integrator;
    if(config.method==IntegrationMethod::Cowell)config.method=IntegrationMethod::RKF45;
    const double total=elapsedSeconds(at,to);
    if(config.method==IntegrationMethod::RK4 && total>0 && std::ceil(total/config.initialStep)>config.maxSteps)
        return prwError(error,"invoke-failed: RK4 request exceeds MAXIMUM_STEPS.");
    auto stops=breaksBetween(execution,at,to);stops.push_back(to);
    struct Restore{timesys::Instant& v;timesys::Instant saved;~Restore(){v=saved;}} restore{execution.forces.integrationEpochTT,execution.forces.integrationEpochTT};
    for(const auto& stop:stops) {
        const double span=elapsedSeconds(at,stop);
        setDriverSpan(execution,at,stop);
        if(execution.forces.explicitEpochContract)execution.forces.integrationEpochTT=at.instant();
        const auto value=Integrator::PropagateWithResult(state,span,config,execution.forces);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        // RK4, RKDP87 and BS step forward only; a backward request must not
        // come back as the initial state.
        if(!std::isfinite(value.totalTime)||std::abs(value.totalTime-span)>32*std::numeric_limits<double>::epsilon()*std::max(1.0,std::abs(span)))
            return prwError(error,"invoke-failed: The integrator did not reach the target epoch (RK4, RKDP87 and BS integrate forward only).");
        state=value.finalState;state.epoch=timesys::ttToTdb(stop.jdTt());at=stop;steps+=value.steps;rejections+=value.rejections;
    }
    return true;
}
bool advanceSpan(Execution& execution,Cursor& c,const TTEpoch& to,std::string& error) {
    const double seconds=elapsedSeconds(c.tt,to);
    if(seconds==0)return true;
    struct Restore { timesys::Instant& value; timesys::Instant saved; ~Restore(){value=saved;} }
        restore{execution.forces.integrationEpochTT,execution.forces.integrationEpochTT};
    execution.forces.integrationEpochTT=c.tt.instant();
    setDriverSpan(execution,c.tt,to);
    const unsigned n=6+unsigned(execution.parameters.size());
    std::vector<double> span(n*n,0.0),p;
    StateVector state;uint32_t steps=0,rejections=0;
    if(!execution.parameters.empty()) {
        const auto v=Integrator::PropagateParameterCovariance(c.state,seconds,execution.integrator,execution.forces,execution.technique,execution.density,execution.impulses,execution.parameters,c.p,execution.noise);
        if(!v.success){error="invoke-failed: "+v.errorMessage;return false;}
        span=v.phi;p=v.covariance;state=v.finalState;steps=v.steps;rejections=v.rejections;
    } else {
        Mat6 p0{};if(c.p.size()==36)std::copy(c.p.begin(),c.p.end(),&p0.m[0][0]);
        const auto v=Integrator::PropagateCovariance(c.state,seconds,execution.integrator,execution.forces,execution.technique,execution.density,execution.impulses,p0,execution.noise);
        if(!v.success){error="invoke-failed: "+v.errorMessage;return false;}
        std::copy(&v.stm.m[0][0],&v.stm.m[0][0]+36,span.begin());
        if(execution.covariance)p.assign(&v.covariance.m[0][0],&v.covariance.m[0][0]+36);
        state=v.finalState;steps=v.steps;rejections=v.rejections;
    }
    std::vector<double> phi(n*n,0.0);
    for(unsigned i=0;i<n;++i)for(unsigned k=0;k<n;++k){const double x=span[i*n+k];if(x==0)continue;for(unsigned j=0;j<n;++j)phi[i*n+j]+=x*c.phi[k*n+j];}
    c.phi.swap(phi);c.p.swap(p);
    c.state=state;c.state.epoch=timesys::ttToTdb(to.jdTt());c.tt=to;
    c.steps+=steps;c.rejections+=rejections;
    return true;
}
bool advance(Execution& execution,Cursor& c,const TTEpoch& to,std::string& error) {
    for(const auto& b:breaksBetween(execution,c.tt,to))if(!advanceSpan(execution,c,b,error))return false;
    return advanceSpan(execution,c,to,error);
}

bool loadEnvironment(const PrwEnvironment& frames,bool own,Environment& out,std::string& error) {
    out=Environment();
    // A resident instance keeps a copy of each frame: the EOP rows point into it.
    const auto keep=[&](const uint8_t*& data,size_t size){
        if(!own||!size)return;
        auto copy=std::make_shared<std::vector<uint8_t>>(data,data+size);
        data=copy->data();out.owned.push_back(std::move(copy));
    };
    const uint8_t* eop=frames.earthOrientation;keep(eop,frames.earthOrientationSize);
    const uint8_t* weather=frames.spaceWeather;keep(weather,frames.spaceWeatherSize);
    const uint8_t* jb2008=frames.jb2008Indices;keep(jb2008,frames.jb2008IndicesSize);
    if(frames.earthOrientationSize) {
        const PRW* root=nullptr;if(!verifyPrw(eop,frames.earthOrientationSize,root,error))return false;
        if(!root->EARTH_ORIENTATION())return prwError(error,"invalid-prw-arm: earth_orientation requires EARTH_ORIENTATION.");
        out.earth=std::make_shared<EarthRotation>();
        const std::string reason=sdn::frames::eop::addRows(root->EARTH_ORIENTATION()->ROWS(),out.earth->rows);
        if(!reason.empty())return prwError(error,("invalid-earth-orientation: "+reason).c_str());
    }
    if(frames.spaceWeatherSize) {
        const PRW* root=nullptr;if(!verifyPrw(weather,frames.spaceWeatherSize,root,error))return false;
        if(!root->SPACE_WEATHER())return prwError(error,"invalid-prw-arm: space_weather requires SPACE_WEATHER.");
        out.weather=std::make_shared<SpaceWeatherTable>();
        const std::string reason=out.weather->add(root->SPACE_WEATHER()->ROWS());
        if(!reason.empty())return prwError(error,("invalid-space-weather: "+reason).c_str());
    }
    if(frames.densityCorrectionSize) {
        out.densityCorrection=std::make_shared<DensityCorrection>();
        if(!out.densityCorrection->load(frames.densityCorrection,frames.densityCorrectionSize,error))return false;
    }
    if(frames.jb2008IndicesSize) {
        const PRW* root=nullptr;if(!verifyPrw(jb2008,frames.jb2008IndicesSize,root,error))return false;
        if(!root->JB2008_INDICES())return prwError(error,"invalid-prw-arm: jb2008_indices requires JB2008_INDICES.");
        out.jb2008=std::make_shared<JB2008IndicesTable>();
        const std::string reason=out.jb2008->add(root->JB2008_INDICES()->ROWS());
        if(!reason.empty())return prwError(error,("invalid-jb2008-indices: "+reason).c_str());
    }
    return true;
}
bool attachEnvironment(Execution& execution,const Environment& environment,bool requestWeather,std::string& error) {
    const auto& jb2008=environment.jb2008;const auto& weather=environment.weather;const auto& earth=environment.earth;
    execution.densityCorrectionBreaks.reset();
    execution.forces.densityScaleAt={};
    if(const auto& correction=environment.densityCorrection) {
        if(!execution.forces.useDrag||execution.forces.dragModel!=ForceModel::DragModelType::NRLMSISE00)
            return prwError(error,"unsupported-density-correction: Log-density correction requires NRLMSISE-00 drag.");
        if(!correction->identity) {
            execution.forces.densityScaleAt=[correction](const timesys::Instant& at){return correction->factor(at);};
            if(!correction->knots.empty())execution.densityCorrectionBreaks=
                std::shared_ptr<const std::vector<TTEpoch>>(correction,&correction->knots);
        }
    }
    const bool jb2008Model=execution.forces.useDrag&&execution.forces.dragModel==ForceModel::DragModelType::JB2008;
    if(jb2008Model!=bool(jb2008))return prwError(error,jb2008Model?"jb2008-indices-required: JB2008 reads the jb2008_indices input.":"unsupported-jb2008-indices: jb2008_indices applies to the JB2008 atmosphere.");
    if(jb2008) {
        if(weather)return prwError(error,"unsupported-space-weather: JB2008 reads jb2008_indices, not space_weather.");
        execution.forces.weatherAt=[jb2008](double jdUtc,SpaceWeatherData& w){jb2008->at(jdUtc,w);};
    }
    if(weather) {
        if(!execution.forces.useDrag)return prwError(error,"unsupported-space-weather: Space weather applies to drag; enable drag.");
        if(requestWeather)return prwError(error,"invalid-space-weather: Supply WEATHER or the space_weather input, not both.");
        // Read inside the span being integrated (setDriverSpan), 1e-8 d from its ends.
        const auto span=std::make_shared<std::array<double,2>>(std::array<double,2>{0,0});
        execution.driverSpan=span;
        execution.forces.weatherAt=[weather,span](double jdUtc,SpaceWeatherData& w){
            const double lo=(*span)[0]+1e-8,hi=(*span)[1]-1e-8;
            const double read=(*span)[1]<=(*span)[0]?jdUtc:lo>hi?0.5*((*span)[0]+(*span)[1]):std::min(hi,std::max(lo,jdUtc));
            weather->at(read,w);w.epoch=jdUtc;
        };
    }
    if(earth) {
        execution.forces.earthFixedRotation=[earth](const timesys::Instant& instant,double m[3][3]){earth->matrix(instant,m);};
        execution.forces.jdUt1At=[earth](const timesys::Instant& instant){return earth->ut1(instant);};
    }
    return true;
}
bool environmentCovers(const Execution&,const Environment& environment,timesys::Instant first,timesys::Instant last,std::string& error) {
    if(first.secondsSince(last)>0)std::swap(first,last);
    const auto utc=[](const timesys::Instant& instant){return instant.utc().jd();};
    if(const auto& jb2008=environment.jb2008)
        if(!jb2008->covers(utc(first))||!jb2008->covers(utc(last)))
            return prwError(error,"jb2008-indices-out-of-range: The JB2008 rows must cover the arc, five days before it for Y10 and the hours of DTC.");
    if(const auto& weather=environment.weather) {
        // Every day the arc touches, and the day before it, must be present.
        for(double t=utc(first);t<utc(last)+1.0;t+=1.0)
            if(!weather->covers(std::min(t,utc(last))))return prwError(error,"space-weather-out-of-range: The SPW rows must cover every day of the arc and the day before it.");
    }
    if(const auto& earth=environment.earth) {
        // The EOP must bracket the whole arc; nothing is extrapolated.
        if(!earth->covers(first)||!earth->covers(last)){error=earth->error;return false;}
    }
    return true;
}

} // namespace dynamics
} // namespace ffm
