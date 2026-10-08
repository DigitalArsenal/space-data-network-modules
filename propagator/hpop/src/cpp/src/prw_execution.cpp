#include "hpop/prw_execution.h"
#include "hpop/prw_codec.h"
#include "hpop/prw_covariance.h"
#include "astrodynamics.h"
#include "integrators.h"
#include "variational.h"
#include "finite_burn.h"
#include "force_partials.h"
#include "ephemeris.h"
#include "environment_models.h"
#include "../../../../../files/orbit-products/src/sha256.hpp"
// build.mjs defines both from plugin-manifest.json, the manifest the SDK embeds
// as $PLG, so VERSION_QUERY and the PLG identity cannot disagree.
#if !defined(HPOP_MODULE_ID) || !defined(HPOP_MODULE_VERSION)
#error "HPOP_MODULE_ID and HPOP_MODULE_VERSION come from plugin-manifest.json; build with build.mjs"
#endif
#include <algorithm>
#include <array>
#include <limits>
extern "C" {
#include "nrlmsise-00.h"
}
// Earth orientation: the $EOP reading and interpolation of foundation/frames
// (eop_series.hpp) and its IERS 2010 chain, through the vendored ERFA.
#include "EOP_generated.h"
#include "erfa.h"
#include "erfam.h"
#include "axis_engine.hpp"
#include "eop_series.hpp"
#include <cstdio>
#include <memory>
#include <map>

namespace hpop {
namespace {
using namespace astro;

// GCRF -> ITRF at a TDB Julian date from caller-supplied EOP: IERS
// Conventions 2010, CIO based, IAU 2006/2000A with the EOP's dX/dY, polar
// motion and UT1 (the chain of foundation/frames gcrfToItrf). The
// celestial-to-intermediate matrix and the polar-motion matrix are held for up
// to an hour of TT (they move by milliarcseconds); the Earth rotation angle is
// evaluated at every call.
class EarthRotation {
public:
    std::vector<sdn::frames::eop::Row> rows;
    std::string error;
    static bool midnight(const char* date,double mjd) {
        int y=0,m=0,d=0,h=0,mi=0,n=0;double sec=0,jd0=0,day=0;
        if(std::sscanf(date,"%d-%d-%dT%d:%d:%lf%n",&y,&m,&d,&h,&mi,&sec,&n)!=6)return false;
        return !h&&!mi&&!sec&&eraCal2jd(y,m,d,&jd0,&day)==0&&day==mjd;
    }
    // UTC two-part Julian date at a TT Julian date (ERFA's leap-second table).
    static bool utcAt(double jdTt,double& u1,double& u2) {
        double tai1,tai2;
        return eraTttai(2451545.0,jdTt-2451545.0,&tai1,&tai2)==0&&eraTaiutc(tai1,tai2,&u1,&u2)==0;
    }
    bool covers(double jdTdb) {
        double u1,u2;sdn::frames::EarthOrientation e;
        if(!utcAt(timesys::tdbToTt(jdTdb),u1,u2)){error="eop-out-of-range: Epoch outside the leap-second table.";return false;}
        const std::string reason=sdn::frames::eop::at(rows,u1,u2,&e,midnight);
        if(!reason.empty()){error="invalid-earth-orientation: "+reason;return false;}
        return true;
    }
    void matrix(double jdTdb,double m[3][3]) {
        const double jdTt=timesys::tdbToTt(jdTdb),tt1=2451545.0,tt2=jdTt-2451545.0;
        double u1,u2,ut11,ut12;sdn::frames::EarthOrientation e;
        if(!utcAt(jdTt,u1,u2)||!sdn::frames::eop::at(rows,u1,u2,&e,midnight).empty()||eraUtcut1(u1,u2,e.dut1,&ut11,&ut12)<0) {
            for(int i=0;i<3;++i)for(int j=0;j<3;++j)m[i][j]=std::numeric_limits<double>::quiet_NaN();
            return;
        }
        if(std::abs(jdTt-cachedTt)>1.0/24.0) {
            cachedTt=jdTt;double x,y;
            eraXy06(tt1,tt2,&x,&y);const double s=eraS06(tt1,tt2,x,y);
            eraC2ixys(x+e.dX,y+e.dY,s,rc2i);eraPom00(e.xPole,e.yPole,eraSp00(tt1,tt2),rpom);
        }
        double rc2t[3][3];eraC2tcio(rc2i,eraEra00(ut11,ut12),rpom,rc2t);
        for(int i=0;i<3;++i)for(int j=0;j<3;++j)m[i][j]=rc2t[i][j];
    }
    // UT1 Julian date at a TDB Julian date (NaN outside the table).
    double ut1(double jdTdb) {
        const double jdTt=timesys::tdbToTt(jdTdb);
        double u1,u2,a,b;sdn::frames::EarthOrientation e;
        if(!utcAt(jdTt,u1,u2)||!sdn::frames::eop::at(rows,u1,u2,&e,midnight).empty()||eraUtcut1(u1,u2,e.dut1,&a,&b)<0)
            return std::numeric_limits<double>::quiet_NaN();
        return a+b;
    }
private:
    double cachedTt=-1e300,rc2i[3][3]{},rpom[3][3]{};
};
bool positive(double x) {return std::isfinite(x)&&x>0;}
bool nonnegative(double x) {return std::isfinite(x)&&x>=0;}
// Daily space weather from PRW.SPACE_WEATHER ($SPW rows), read as
// NRLMSISE-00's driver reads its inputs at a UTC instant on day d: F10.7 is the
// observed flux of day d-1, F10.7a the 81-day centred average of observed flux
// on day d, Ap the daily Ap of day d, and Kp (the HWM14 storm winds) the
// three-hour Kp of the interval. These are also Orekit's
// CssiSpaceWeatherData readings for observed and daily-predicted rows. Each
// row is used as published (monthly predictions are not interpolated).
class SpaceWeatherTable {
public:
    struct Day {double f107Obs=0,f107ObsCentred81=0,apDaily=0,kp[8]{};};
    std::map<long,Day> days;  // by MJD (UTC)
    std::string error;
    // Empty string = success.
    std::string add(const flatbuffers::Vector<flatbuffers::Offset<SPW>>* rows) {
        if(!rows||rows->size()==0)return "No SPW rows.";
        long previous=0;bool first=true;
        for(const SPW* row:*rows) {
            int y=0,m=0,d=0;double jd0=0,mjd=0;
            if(!row->DATE()||std::sscanf(row->DATE()->c_str(),"%d-%d-%d",&y,&m,&d)!=3||eraCal2jd(y,m,d,&jd0,&mjd)!=0)return "SPW DATE must be an ISO 8601 calendar date.";
            const long day=long(mjd);
            if(!first&&day<=previous)return "SPW rows must have strictly increasing DATE.";
            first=false;previous=day;
            Day v;v.f107Obs=row->F107_OBS();v.f107ObsCentred81=row->F107_OBS_CENTER81();v.apDaily=row->AP_AVG();
            const int kp[8]={row->KP1(),row->KP2(),row->KP3(),row->KP4(),row->KP5(),row->KP6(),row->KP7(),row->KP8()};
            for(int i=0;i<8;++i)v.kp[i]=kp[i]/10.0;
            if(!positive(v.f107Obs)||!positive(v.f107ObsCentred81)||!nonnegative(v.apDaily))return "SPW F10.7 must be positive and Ap nonnegative.";
            for(const double k:v.kp)if(!nonnegative(k)||k>9)return "SPW Kp must be within 0 to 9.";
            days[day]=v;
        }
        return "";
    }
    // Model inputs at a UTC Julian date; false if a needed day is missing.
    bool at(double jdUtc,SpaceWeatherData& out) const {
        const double mjd=jdUtc-2400000.5;const long day=long(std::floor(mjd));
        const auto today=days.find(day),yesterday=days.find(day-1);
        if(today==days.end()||yesterday==days.end())return false;
        out.F107=yesterday->second.f107Obs;out.F107a=today->second.f107ObsCentred81;out.Ap=today->second.apDaily;
        const int slot=std::min(7,std::max(0,int((mjd-double(day))*8)));
        out.Kp=out.kp3h=today->second.kp[slot];out.epoch=jdUtc;
        return true;
    }
    bool covers(double jdUtc) const {SpaceWeatherData w;return at(jdUtc,w);}
};
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
    // The integration clock (TT), exact; the doubles above are TDB Julian
    // dates kept for ephemeris lookups and the legacy integrator interfaces.
    TTEpoch initialTT, targetTT;
    std::vector<TTEpoch> samplesTT;
    std::vector<ForceModel::ImpulsiveManeuverDef> impulses;
    std::vector<Integrator::FiniteBurn> burns;
    Integrator::ProcessNoise noise;
    // The request's axes are EME2000 (mean equator and equinox of J2000.0):
    // HPOP integrates in GCRF and rotates inputs and outputs by the IAU 2000
    // frame bias (ERFA eraBp00 rb, GCRF -> EME2000; constant).
    bool meanJ2000 = false;
    double bias[3][3] = {{1,0,0},{0,1,0},{0,0,1}};
    // DYNAMIC_PARAMETERS, and the (6 + parameters)^2 initial covariance in km
    // units when they are given with one.
    std::vector<ForceModel::DynamicParameter> parameters;
    std::vector<double> pParameters;
};
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
bool parseForces(const PRWForceConfiguration* in,double epoch,bool hasEarthOrientation,ForceModel::ForceModelSet& out,std::string& error) {
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
    // (HPOP integrates on TT; the TCG-compatible 3.986004418e14 is 7.5e-10
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
    out.dragRateEpochTdb=epoch;
    if(!in->HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S()&&in->DRAG_AREA_OVER_MASS_RATE_M2_KG_S()!=0)
        return prwError(error,"invalid-presence: DRAG_AREA_OVER_MASS_RATE_M2_KG_S requires HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S.");
    if(in->HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S()) {
        if(!std::isfinite(in->DRAG_AREA_OVER_MASS_RATE_M2_KG_S()))return prwError(error,"invalid-forces: The Cd*A/m rate must be finite.");
        if(!out.useDrag)return prwError(error,"invalid-forces: DRAG_AREA_OVER_MASS_RATE_M2_KG_S applies to drag; enable drag.");
        if(!positive(out.drag.area))return prwError(error,"invalid-forces: A Cd*A/m rate needs a positive area.");
        out.dragAreaOverMassRate=in->DRAG_AREA_OVER_MASS_RATE_M2_KG_S();out.dragRateEpochTdb=epoch;
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
    if(!parseIntegrator(in->INTEGRATOR(),out.massDynamics,out.integrator,error)||!parseForces(in->FORCES(),out.initial.epoch,hasEarthOrientation,out.forces,error))return false;
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
            default:return prwError(error,"unsupported-parameter: Unknown dynamic parameter.");
        }
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
bool evaluate(Execution& execution,const PRWExecutionRequest* request,const TTEpoch& epochTT,PRWPropagationSampleT& out,std::string& error) {
    const double epoch=timesys::ttToTdb(epochTT.jdTt());
    if(!preflightKernel(execution,epoch,error))return false;
    const auto frame=std::unique_ptr<RFMCoordinateSystemT>(request->INITIAL()->COORDINATE_SYSTEM()->UnPack());
    // States and matrices leave in the request's axes.
    const auto stateOut=[&](StateVector state){state.position=toRequestAxes(execution,state.position);state.velocity=toRequestAxes(execution,state.velocity);return makeState(state,*frame,request->INITIAL());};
    const auto matrixOut=[&](const double* values,unsigned n,bool covariance){std::vector<double> m(values,values+n*n);rotateMatrix(execution,m.data(),n,true);return matrix(m.data(),n,covariance);};
    // Elapsed time on the integration clock (TT), exact to sub-nanosecond.
    const double seconds=elapsedSeconds(execution.initialTT,epochTT);
    if(execution.massDynamics) {
        const auto value=Integrator::PropagateFiniteBurns(execution.initial,execution.mass,seconds,execution.integrator,execution.forces,execution.burns,execution.density,execution.impulses);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        auto state=value.finalState;state.epoch=epoch;out.STATE=stateOut(state);out.STATE->HAS_MASS_KG=true;out.STATE->MASS_KG=value.massKg;
        Mat6 phi{};for(int i=0;i<6;++i)for(int j=0;j<6;++j)phi.m[i][j]=value.stm[i*7+j];
        out.STM=matrixOut(&phi.m[0][0],6,false);out.MASS_STM=matrixOut(value.stm.data(),7,false);
        if(execution.covariance){const auto p=Integrator::TransportCovariance(phi,execution.p);out.COVARIANCE=matrixOut(&p.m[0][0],6,true);}
        if(execution.massCovariance){const auto p=Integrator::TransportFiniteCovariance(value.stm,execution.p7);out.MASS_COVARIANCE=matrixOut(p.data(),7,true);}
        out.ACCEPTED_STEPS=value.steps;out.REJECTED_STEPS=value.rejections;
        for(size_t i=0;i<value.burns.size();++i) {
            const auto& burn=value.burns[i];auto report=std::make_unique<PRWBurnReportT>();
            report->BURN_INDEX=i;report->STARTED=burn.started;report->STOPPED=burn.stopped;report->START_BY_EVENT=burn.startByEvent;report->STOP_BY_EVENT=burn.stopByEvent;
            report->HAS_START_SECONDS=burn.started;report->HAS_STOP_SECONDS=burn.stopped;
            if(burn.started){report->START_SECONDS=burn.startSeconds;report->START_EPOCH=makeInstant(execution.initial.epoch+burn.startSeconds/86400);}
            if(burn.stopped){report->STOP_SECONDS=burn.stopSeconds;report->STOP_EPOCH=makeInstant(execution.initial.epoch+burn.stopSeconds/86400);}
            report->DELTA_V_M_S=burn.deltaVKmS*1000;report->PROPELLANT_KG=burn.propellantKg;out.BURNS.push_back(std::move(report));
        }
    } else if(execution.variational&&!execution.parameters.empty()) {
        const auto value=Integrator::PropagateParameterCovariance(execution.initial,seconds,execution.integrator,execution.forces,execution.technique,execution.density,execution.impulses,execution.parameters,execution.pParameters,execution.noise);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        auto state=value.finalState;state.epoch=epoch;out.STATE=stateOut(state);out.STM=matrixOut(value.phi.data(),value.dimension,false);
        if(execution.covariance){out.COVARIANCE=matrixOut(value.covariance.data(),value.dimension,true);out.PROCESS_NOISE=prwProcessNoiseRecord(execution.noise);}
        out.ACCEPTED_STEPS=value.steps;out.REJECTED_STEPS=value.rejections;
    } else if(execution.variational) {
        const auto value=Integrator::PropagateCovariance(execution.initial,seconds,execution.integrator,execution.forces,execution.technique,execution.density,execution.impulses,execution.p,execution.noise);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        auto state=value.finalState;state.epoch=epoch;out.STATE=stateOut(state);out.STM=matrixOut(&value.stm.m[0][0],6,false);
        if(execution.covariance){out.COVARIANCE=matrixOut(&value.covariance.m[0][0],6,true);out.PROCESS_NOISE=prwProcessNoiseRecord(execution.noise);}
        out.ACCEPTED_STEPS=value.steps;out.REJECTED_STEPS=value.rejections;
    } else {
        auto config=execution.integrator;
        if(config.method==IntegrationMethod::Cowell)config.method=IntegrationMethod::RKF45;
        if(config.method==IntegrationMethod::RK4 && seconds>0 &&
           std::ceil(seconds/config.initialStep)>config.maxSteps)
            return prwError(error,"invoke-failed: RK4 request exceeds MAXIMUM_STEPS.");
        const auto value=Integrator::PropagateWithResult(execution.initial,seconds,config,execution.forces);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        auto state=value.finalState;state.epoch=epoch;out.STATE=stateOut(state);out.ACCEPTED_STEPS=value.steps;out.REJECTED_STEPS=value.rejections;
    }
    if(request->INITIAL()->HAS_MASS_KG()&&!execution.massDynamics){out.STATE->HAS_MASS_KG=true;out.STATE->MASS_KG=execution.mass;}
    out.STATE->STATE->EPOCH=formatTdb(epochTT);out.STATE->STATE->EPOCH_TIME_SYSTEM="TDB";
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
bool execute(const PRWExecutionRequest* request,const std::shared_ptr<EarthRotation>& earth,const std::shared_ptr<SpaceWeatherTable>& weather,PRWT& response,std::string& error) {
    Execution execution;if(!parseExecution(request,earth!=nullptr,execution,error))return false;
    if(weather) {
        if(!execution.forces.useDrag)return prwError(error,"unsupported-space-weather: Space weather applies to drag; enable drag.");
        if(request->FORCES()->WEATHER())return prwError(error,"invalid-space-weather: Supply WEATHER or the space_weather input, not both.");
        // Every day the arc touches, and the day before it, must be present.
        double first=execution.initial.epoch,last=execution.target;
        for(const double t:execution.samples){last=std::max(last,t);first=std::min(first,t);}
        const auto utc=[](double jdTdb){return timesys::taiToUtc(timesys::ttToTai(timesys::tdbToTt(jdTdb)));};
        for(double t=utc(first);t<utc(last)+1.0;t+=1.0)
            if(!weather->covers(std::min(t,utc(last))))return prwError(error,"space-weather-out-of-range: The SPW rows must cover every day of the arc and the day before it.");
        execution.forces.weatherAt=[weather](double jdUtc,SpaceWeatherData& w){weather->at(jdUtc,w);};
    }
    if(earth) {
        // The EOP must bracket the whole arc; nothing is extrapolated.
        double last=execution.target,first=execution.initial.epoch;
        for(const double t:execution.samples){last=std::max(last,t);first=std::min(first,t);}
        if(!earth->covers(first)||!earth->covers(last)){error=earth->error;return false;}
        execution.forces.earthFixedRotation=[earth](double jdTdb,double m[3][3]){earth->matrix(jdTdb,m);};
        execution.forces.jdUt1At=[earth](double jdTdb){return earth->ut1(jdTdb);};
    }
    auto result=std::make_unique<PRWExecutionResultT>();result->FINAL_SAMPLE=std::make_unique<PRWPropagationSampleT>();
    if(!evaluate(execution,request,execution.targetTT,*result->FINAL_SAMPLE,error))return false;
    for(const auto& epoch:execution.samplesTT){auto sample=std::make_unique<PRWPropagationSampleT>();if(!evaluate(execution,request,epoch,*sample,error))return false;result->SAMPLES.push_back(std::move(sample));}
    result->ELAPSED_SECONDS=elapsedSeconds(execution.initialTT,execution.targetTT);result->EPHEMERIS_SOURCE=Ephemeris::ephemerisSourceName(Ephemeris::selectedEphemerisSource());
    if(execution.variational){result->STM_TECHNIQUE=request->STM_TECHNIQUE();result->DENSITY_TREATMENT=request->DENSITY_TREATMENT();}
    if(request->DYNAMIC_PARAMETERS())for(const auto p:*request->DYNAMIC_PARAMETERS())result->DYNAMIC_PARAMETERS.push_back(p);
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
bool processPrwInvoke(const uint8_t* data,size_t size,const uint8_t* kernel,size_t kernelSize,const uint8_t* eop,size_t eopSize,const uint8_t* spaceWeather,size_t spaceWeatherSize,std::vector<uint8_t>& output,std::string& error) {
    struct KernelLifetime {KernelLifetime(){Ephemeris::clearEphemerisBuffer();}~KernelLifetime(){Ephemeris::clearEphemerisBuffer();}} kernelLifetime;
    const PRW* request=nullptr;if(!verifyPrw(data,size,request,error))return false;
    if(kernelSize&&!loadKernel(kernel,kernelSize,error))return false;
    PRWT response;bool ok=false;
    std::shared_ptr<EarthRotation> earth;
    // The rows point into these PRW buffers, which outlive the invocation.
    if(eopSize) {
        const PRW* root=nullptr;if(!verifyPrw(eop,eopSize,root,error))return false;
        if(!root->EARTH_ORIENTATION())return prwError(error,"invalid-prw-arm: earth_orientation requires EARTH_ORIENTATION.");
        earth=std::make_shared<EarthRotation>();
        const std::string reason=sdn::frames::eop::addRows(root->EARTH_ORIENTATION()->ROWS(),earth->rows);
        if(!reason.empty())return prwError(error,("invalid-earth-orientation: "+reason).c_str());
    }
    std::shared_ptr<SpaceWeatherTable> weather;
    if(spaceWeatherSize) {
        const PRW* root=nullptr;if(!verifyPrw(spaceWeather,spaceWeatherSize,root,error))return false;
        if(!root->SPACE_WEATHER())return prwError(error,"invalid-prw-arm: space_weather requires SPACE_WEATHER.");
        weather=std::make_shared<SpaceWeatherTable>();
        const std::string reason=weather->add(root->SPACE_WEATHER()->ROWS());
        if(!reason.empty())return prwError(error,("invalid-space-weather: "+reason).c_str());
    }
    if(request->EXECUTION_REQUEST())ok=execute(request->EXECUTION_REQUEST(),earth,weather,response,error);
    else if(earth)return prwError(error,"unsupported-earth-orientation: Earth orientation applies to execution requests.");
    else if(weather)return prwError(error,"unsupported-space-weather: Space weather applies to execution requests.");
    else if(request->EPHEMERIS_REQUEST())ok=ephemeris(request->EPHEMERIS_REQUEST(),response,error);
    else if(request->ATMOSPHERE_REQUEST())ok=atmosphere(request->ATMOSPHERE_REQUEST(),response,error);
    else if(request->VERSION_QUERY()){response.VERSION_RESULT=std::make_unique<PRWVersionResultT>();response.VERSION_RESULT->VERSION=HPOP_MODULE_VERSION;response.VERSION_RESULT->MODULE_ID=HPOP_MODULE_ID;ok=true;}
    else return prwError(error,"invalid-prw-arm: invoke requires execution, ephemeris, atmosphere or version query.");
    if(ok)encodePrw(response,output);return ok;
}
} // namespace hpop
