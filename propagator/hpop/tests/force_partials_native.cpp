// Authoritative equations and independent numerical cross-checks.
// Sources:
//  * IERS Conventions 2010, Ch. 6, Eq. (6.1), normalized gravity potential:
//    https://iers-conventions.obspm.fr/content/chapter6/icc6.pdf
//  * Newtonian inverse-square acceleration and its Cartesian derivative:
//    https://www.orekit.org/static/apidocs/org/orekit/forces/gravity/NewtonianAttraction.html
//  * Cannonball photon momentum P=flux/c; force proportional to inverse square
//    distance. SOLAR_FLUX_1AU=1361 W/m^2, c=299792458 m/s, AU=149597870.7 km.
//  * ForceModel's existing atmosphere/ephemeris authorities are tested by
//    environment_conformance.cpp and de440_force_native.cpp. The differences
//    here test the new Jacobian against those separately tested evaluators;
//    they do not substitute for physical validation of those atmosphere models.
//
// Units: r km, v km/s, a km/s^2, da/dr s^-2, da/dv s^-1. Fixed epoch JD
// 2460000.5 TDB; geocentric Cartesian working frame, axes held fixed. No frame
// or time conversions occur in this local Jacobian test. Atmospheric positions
// use the existing body's co-rotating frame convention. Impulses occur at a
// fixed epoch. Baseline force constants and published model coefficients are
// reused as inputs; no new implementation output is used as golden data.
//
// Difference tests use two step sizes, h and h/2. 1 m for local forces,
// 1 km for fully lit SRP and 10 km for distant body terms. The latter avoid
// cancellation from subtracting AU-scale vectors. Velocity differences use
// 1 mm/s. Bounds allow O(h^2) truncation and floating-point cancellation;
// closed-form inverse-square checks use a 2e-14 relative roundoff bound.
#include "force_partials.h"
#include "environment_models.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>

using namespace astro;
using namespace astro::ForceModel;
namespace {
int cases=0,failures=0;
constexpr double jd=2460000.5;
const Vec3 defaultR(6878,150,200),defaultV(-0.2,7.2,2);
double coordinate(const Vec3& v,int i){return i==0?v.x:i==1?v.y:v.z;}
void offset(Vec3& v,int i,double h){if(i==0)v.x+=h;else if(i==1)v.y+=h;else v.z+=h;}
void result(const char* name,double error,double bound){
    ++cases;const bool ok=std::isfinite(error) && error<=bound;
    if(!ok)++failures;
    std::printf("RESULT %s error=%.17g bound=%.17g %s\n",name,error,bound,ok?"PASS":"FAIL");
}

void forceDifference(const char* name,ForceModelSet f,const Vec3& r=defaultR,
                     const Vec3& v=defaultV,double spatialStep=.001,double bound=1e-6){
    const auto a=ComputeAccelerationPartials(r,v,jd,f,DensityGradient::FiniteDifference);
    double worst=0;
    for(double shrink:{1.0,0.5}){
        double error=0,norm=0;
        for(int j=0;j<6;++j){
            Vec3 rh=r,rl=r,vh=v,vl=v;
            const double h=(j<3?spatialStep:1e-6)*shrink;
            if(j<3){offset(rh,j,h);offset(rl,j,-h);}else{offset(vh,j-3,h);offset(vl,j-3,-h);}
            const Vec3 hi=ComputeTotalAcceleration(rh,vh,jd,f),lo=ComputeTotalAcceleration(rl,vl,jd,f);
            for(int i=0;i<3;++i){
                const double expected=(coordinate(hi,i)-coordinate(lo,i))/(2*h);
                const double actual=j<3?a.dr[i][j]:a.dv[i][j-3];
                error+=(expected-actual)*(expected-actual);norm+=expected*expected;
            }
        }
        worst=std::max(worst,std::sqrt(error/norm));
    }
    result(name,worst,bound);
    const Vec3 production=ComputeTotalAcceleration(r,v,jd,f);
    result("acceleration_unchanged",(a.acceleration-production).magnitude(),0);
}

void inverseSquare(const char* name,ForceModelSet f,Vec3 center,double coefficient){
    const auto a=ComputeAccelerationPartials(defaultR,defaultV,jd,f);
    const Vec3 d=defaultR-center;const double r=d.magnitude(),r3=r*r*r,r5=r3*r*r;
    double error=0,norm=0;
    for(int i=0;i<3;++i)for(int j=0;j<3;++j){
        const double expected=coefficient*((i==j?1/r3:0)-3*coordinate(d,i)*coordinate(d,j)/r5);
        error+=(a.dr[i][j]-expected)*(a.dr[i][j]-expected);norm+=expected*expected;
        error+=a.dv[i][j]*a.dv[i][j];
    }
    result(name,std::sqrt(error/norm),2e-14);
}

void impulseChecks(){
    ImpulsiveManeuverDef impulse;impulse.deltaV=Vec3(.02,-.01,.005);impulse.inRTN=false;
    auto identity=ImpulsiveManeuverJacobian(defaultR,defaultV,impulse);
    double identityError=0;
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)identityError=std::max(identityError,std::abs(identity.m[i][j]-(i==j?1:0)));
    result("inertial_impulse_identity",identityError,0);
    impulse.inRTN=true;
    const auto jac=ImpulsiveManeuverJacobian(defaultR,defaultV,impulse);
    double error=0,norm=0;
    for(int j=0;j<6;++j){
        Vec3 rh=defaultR,rl=defaultR,vh=defaultV,vl=defaultV;
        const double h=j<3?.001:1e-6;
        if(j<3){offset(rh,j,h);offset(rl,j,-h);}else{offset(vh,j-3,h);offset(vl,j-3,-h);}
        // Difference delta-v itself, removing the exact identity so that a
        // missing small frame-rotation derivative cannot hide under I.
        Vec3 hi=RTNToInertial(impulse.deltaV,rh,vh),lo=RTNToInertial(impulse.deltaV,rl,vl);
        for(int i=0;i<3;++i){
            double expected=(coordinate(hi,i)-coordinate(lo,i))/(2*h),actual=jac.m[i+3][j]-(i+3==j?1:0);
            error+=(actual-expected)*(actual-expected);norm+=expected*expected;
        }
    }
    result("RTN_impulse_jump",std::sqrt(error/norm),1e-6);
}

void densityModes(){
    ForceModelSet f;f.usePointMass=false;f.useDrag=true;f.dragModel=DragModelType::Exponential;
    const auto omitted=ComputeAccelerationPartials(defaultR,defaultV,jd,f,DensityGradient::Neglected);
    const auto included=ComputeAccelerationPartials(defaultR,defaultV,jd,f,DensityGradient::FiniteDifference);
    double velocityError=0,positionDifference=0;
    for(int i=0;i<3;++i)for(int j=0;j<3;++j){velocityError=std::max(velocityError,std::abs(omitted.dv[i][j]-included.dv[i][j]));positionDifference+=std::abs(omitted.dr[i][j]-included.dr[i][j]);}
    result("density_mode_velocity_invariant",velocityError,0);
    result("density_gradient_enabled",positionDifference>1e-15?0:1,0);
    // Holding density fixed, dv Jacobian is -k rho (|u| I + uu^T/|u|).
    // Recover k*rho from the independently evaluated drag acceleration.
    const Vec3 u=defaultV-Vec3(-OMEGA_EARTH*defaultR.y,OMEGA_EARTH*defaultR.x,0);
    const double speed=u.magnitude(),krho=omitted.acceleration.magnitude()/(speed*speed);
    double error=0,norm=0;
    for(int i=0;i<3;++i)for(int j=0;j<3;++j){
        const double expected=-krho*((i==j?speed:0)+coordinate(u,i)*coordinate(u,j)/speed);
        error+=(omitted.dv[i][j]-expected)*(omitted.dv[i][j]-expected);norm+=expected*expected;
    }
    result("drag_closed_velocity_jacobian",std::sqrt(error/norm),2e-14);
}
void rejectionChecks(){
    ForceModelSet f;f.useEarthAlbedo=true;
    bool rejected=false;try{ComputeAccelerationPartials(defaultR,defaultV,jd,f);}catch(const std::invalid_argument&){rejected=true;}
    result("unsupported_force_rejected",rejected?0:1,0);
    f=ForceModelSet();f.useSRP=true;f.srp.model=SRPModelType::BoxWing;
    rejected=false;try{ComputeAccelerationPartials(defaultR,defaultV,jd,f);}catch(const std::invalid_argument&){rejected=true;}
    result("unsupported_attitude_SRP_rejected",rejected?0:1,0);
    f=ForceModelSet();f.useDrag=true;f.drag.includeWinds=true;
    rejected=false;try{ComputeAccelerationPartials(defaultR,defaultV,jd,f);}catch(const std::invalid_argument&){rejected=true;}
    result("unsupported_wind_rejected",rejected?0:1,0);
}
} // namespace

int main(){
    ForceModelSet f;
    inverseSquare("point_mass_closed_form",f,Vec3(),-MU_EARTH);
    forceDifference("point_mass_FD",f);
    f.gravityMode=GravityMode::J2Only;forceDifference("J2_FD",f);
    f.gravityMode=GravityMode::J2J4;forceDifference("J2J4_FD",f);
    // Isolate each zonal to prevent the much larger point-mass term from
    // masking errors in a small J5/J6 derivative.
    const double jn[]={J2_EARTH,J3_EARTH,J4_EARTH,2.2727e-7*std::sqrt(11.0),-5.4068e-7*std::sqrt(13.0)};
    for(int n=2;n<=6;++n){
        f=ForceModelSet();f.usePointMass=false;f.useContributions=true;f.contributions.count=1;
        auto& c=f.contributions.slots[0];c.kind=ContributionKind::ZonalHarmonic;c.p[0]=MU_EARTH;c.p[1]=RE_EARTH;c.p[2]=n;c.p[3]=jn[n-2];
        char name[40];std::snprintf(name,sizeof(name),"isolated_J%d_FD",n);forceDifference(name,f);
    }
    f=ForceModelSet();f.gravityMode=GravityMode::SphericalHarmonics;f.sphericalHarmonics.maxDegree=6;f.sphericalHarmonics.maxOrder=6;
    forceDifference("spherical_harmonics_6_FD",f);
    f.sphericalHarmonics.maxOrder=0;forceDifference("zonal_harmonics_6_FD",f);
    f.gravityMode=GravityMode::EGM2008;forceDifference("EGM70_FD",f);
    f.egm2008.truncationOrder=0;forceDifference("EGM70_order0_legacy_FD",f);
    // Synthetic coefficient inputs in IERS (6.1), not synthetic expected
    // outputs: a degree-80 term demonstrates that the STM does not truncate
    // loaded fields at either J6 or the embedded EGM2008 degree-70 boundary.
    auto loaded=std::make_shared<ExtendedGravityField>();loaded->allocate(80,80);
    loaded->Cnm[80][20]=1e-4;loaded->Snm[80][20]=-2e-4;
    f=ForceModelSet();f.gravityMode=GravityMode::LoadedField;f.loadedField=loaded;
    forceDifference("loaded_degree80_FD",f);
    f=ForceModelSet();f.usePointMass=false;f.useThirdBody=true;
    f.thirdBody.includeMercury=true;f.thirdBody.includeVenus=true;f.thirdBody.includeMars=true;f.thirdBody.includeJupiter=true;f.thirdBody.includeSaturn=true;f.thirdBody.includeUranus=true;f.thirdBody.includeNeptune=true;
    forceDifference("nine_third_bodies_FD",f,defaultR,defaultV,10);
    f=ForceModelSet();f.usePointMass=false;f.useDrag=true;
    f.dragModel=DragModelType::Exponential;forceDifference("drag_exponential_FD",f);
    f.dragModel=DragModelType::NRLMSISE00;forceDifference("drag_NRLMSISE00_FD",f);
    f.dragModel=DragModelType::HarrisPriester;forceDifference("drag_HarrisPriester_FD",f);
    f.dragModel=DragModelType::USSA1976;f.drag.model=DragModelType::USSA1976;forceDifference("drag_USSA1976_FD",f);
    f.drag.coRotatingAtmosphere=false;forceDifference("drag_nonrotating_FD",f);
    f=ForceModelSet();f.usePointMass=false;f.useSRP=true;f.sunPositionProvided=true;f.sunPosition=Vec3(AU_KM,0,0);
    const double srpCoefficient=SOLAR_FLUX_1AU*AU_KM*AU_KM/299792458.0*f.srp.Cr*f.srp.area/f.srp.mass*1e-3;
    inverseSquare("cannonball_SRP_closed_form",f,f.sunPosition,srpCoefficient);
    forceDifference("cannonball_SRP_lit_FD",f,defaultR,defaultV,1);
    forceDifference("cannonball_SRP_penumbra_FD",f,Vec3(-7000,6370,0));
    const auto umbra=ComputeAccelerationPartials(Vec3(-7000,0,0),defaultV,jd,f);
    double zero=umbra.acceleration.magnitude();for(int i=0;i<3;++i)for(int j=0;j<3;++j)zero+=std::abs(umbra.dr[i][j])+std::abs(umbra.dv[i][j]);
    result("cannonball_SRP_umbra",zero,0);
    f=ForceModelSet();f.usePointMass=false;f.useRelativisticCorrection=true;f.relativistic.lenseThirring=true;f.relativistic.deSitter=true;
    forceDifference("relativity_FD",f);
    impulseChecks();densityModes();rejectionChecks();
    std::printf("%s force partials cases=%d failures=%d\n",failures?"FAIL":"PASS",cases,failures);
    return failures?1:0;
}
