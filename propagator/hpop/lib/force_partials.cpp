#include "force_partials.h"
#include "astrodynamics.h"
#include "environment_models.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace astro {
namespace ForceModel {
namespace {

// Forward automatic differentiation is the analytical chain rule applied to
// every operation, not a finite difference. Six seeds are Cartesian r and v.
// This mirrors Orekit's CalculusFieldElement force evaluation design:
// https://www.orekit.org/static/apidocs/org/orekit/forces/ForceModel.html
struct D {
    double value;
    double d[6]{};
    D(double v = 0.0) : value(v) {}
    static D seed(double value, int i) { D a(value); a.d[i] = 1.0; return a; }
    D& operator+=(const D& b) { value += b.value; for (int i=0;i<6;++i) d[i]+=b.d[i]; return *this; }
};
D operator+(D a, const D& b) { return a += b; }
D operator-(const D& a) { D c(-a.value); for(int i=0;i<6;++i)c.d[i]=-a.d[i]; return c; }
D operator-(const D& a, const D& b) { return a + (-b); }
D operator*(const D& a, const D& b) { D c(a.value*b.value); for(int i=0;i<6;++i)c.d[i]=a.d[i]*b.value+a.value*b.d[i]; return c; }
D operator/(const D& a, const D& b) { D c(a.value/b.value); for(int i=0;i<6;++i)c.d[i]=(a.d[i]-c.value*b.d[i])/b.value; return c; }
D sqrt(const D& a) { D c(std::sqrt(a.value)); if(c.value>0)for(int i=0;i<6;++i)c.d[i]=a.d[i]/(2*c.value); return c; }
D sin(const D& a) { D c(std::sin(a.value)); const double k=std::cos(a.value); for(int i=0;i<6;++i)c.d[i]=k*a.d[i]; return c; }
D cos(const D& a) { D c(std::cos(a.value)); const double k=-std::sin(a.value); for(int i=0;i<6;++i)c.d[i]=k*a.d[i]; return c; }
D atan2(const D& a, const D& b) { D c(std::atan2(a.value,b.value)); const double q=a.value*a.value+b.value*b.value; if(q>0)for(int i=0;i<6;++i)c.d[i]=(b.value*a.d[i]-a.value*b.d[i])/q; return c; }
D powi(D a, int n) { D result(1.0); for(int i=0;i<n;++i)result=result*a; return result; }

struct V {
    D x,y,z;
    V() = default;
    V(D x_,D y_,D z_):x(x_),y(y_),z(z_){}
    V(const Vec3& a):x(a.x),y(a.y),z(a.z){}
    D dot(const V& b)const{return x*b.x+y*b.y+z*b.z;}
    V cross(const V& b)const{return V(y*b.z-z*b.y,z*b.x-x*b.z,x*b.y-y*b.x);}
    D norm()const{return sqrt(dot(*this));}
};
V operator+(const V&a,const V&b){return V(a.x+b.x,a.y+b.y,a.z+b.z);}
V operator-(const V&a,const V&b){return V(a.x-b.x,a.y-b.y,a.z-b.z);}
V operator*(const V&a,const D&b){return V(a.x*b,a.y*b,a.z*b);}
V operator/(const V&a,const D&b){return V(a.x/b,a.y/b,a.z/b);}
V unit(const V&a){const D n=a.norm();return n.value>0 ? a/n : V();}
V positionSeed(const Vec3&r){return V(D::seed(r.x,0),D::seed(r.y,1),D::seed(r.z,2));}
V velocitySeed(const Vec3&v){return V(D::seed(v.x,3),D::seed(v.y,4),D::seed(v.z,5));}

V pointMass(const V& r,double mu,double floor=1.0) {
    D radius=r.norm(); if(radius.value<floor)radius=D(floor);
    return r*(-mu/(radius*radius*radius));
}

// P_n and its derivative via polynomial recurrences: no polar division by
// (u^2-1). The acceleration is grad[-mu J_n R^n P_n(z/r)/r^(n+1)].
V zonal(const V& r,double mu,double radius,int n,double jn) {
    if(n<2 || r.norm().value<=0)return V();
    const D rr=r.norm(),u=r.z/rr;
    D p0(1),p1=u,q0(0),q1(1);
    for(int k=2;k<=n;++k){
        D p=((2.0*k-1)*u*p1-(k-1.0)*p0)/k;
        D q=((2.0*k-1)*(p1+u*q1)-(k-1.0)*q0)/k;
        p0=p1;p1=p;q0=q1;q1=q;
    }
    const D common=mu*jn*powi(radius/rr,n)/(rr*rr);
    return (r/rr)*(((n+1.0)*p1+u*q1)*common)-V(0,0,1)*(q1*common);
}

GravityFieldCoefficients inlineCoefficients(const SphericalHarmonicsConfig& c) {
    GravityFieldCoefficients f;
    f.mu=c.mu;f.referenceRadius=c.referenceRadius;
    f.maxDegree=std::min<uint16_t>(c.maxDegree,20);f.maxOrder=std::min(c.maxOrder,f.maxDegree);
    if(c.Cnm && c.Snm){
        for(int n=0;n<=f.maxDegree;++n)for(int m=0;m<=std::min<int>(n,f.maxOrder);++m){
            f.Cnm[n][m]=c.Cnm[n*21+m];f.Snm[n][m]=c.Snm[n*21+m];
        }
        return f;
    }
    if(c.includeJ2)f.Cnm[2][0]=-J2_EARTH/std::sqrt(5.0);
    if(c.includeJ3)f.Cnm[3][0]=-J3_EARTH/std::sqrt(7.0);
    if(c.includeJ4)f.Cnm[4][0]=-J4_EARTH/3.0;
    if(c.includeHigherZonals){f.Cnm[5][0]=-2.2727e-7;f.Cnm[6][0]=5.4068e-7;}
    if(f.maxOrder>=2){f.Cnm[2][2]=2.43914e-6;f.Snm[2][2]=-1.40017e-6;f.Cnm[2][1]=-2e-10;f.Snm[2][1]=1.4e-9;}
    if(f.maxOrder>=3 && f.maxDegree>=3){
        f.Cnm[3][1]=2.03e-6;f.Snm[3][1]=2.48e-7;f.Cnm[3][2]=9.05e-7;f.Snm[3][2]=-6.19e-7;f.Cnm[3][3]=7.21e-7;f.Snm[3][3]=1.41e-6;
    }
    if(f.maxOrder>=4 && f.maxDegree>=4){
        f.Cnm[4][1]=-5.36e-7;f.Snm[4][1]=-4.74e-7;f.Cnm[4][2]=3.50e-7;f.Snm[4][2]=6.62e-7;f.Cnm[4][3]=9.91e-7;f.Snm[4][3]=-2.01e-7;f.Cnm[4][4]=-1.88e-7;f.Snm[4][4]=3.09e-7;
    }
    return f;
}

// Differentiate the same normalized Legendre acceleration used by the inline
// production model. No added degree truncation: the original model caps at 20.
V inlineGravity(const V& r,const GravityFieldCoefficients& f) {
    D rr=r.norm();if(rr.value<100)rr=D(100);
    const D rxy=sqrt(r.x*r.x+r.y*r.y);
    // The inline production longitude is singular on the pole. A zonal-only
    // field has the regular polynomial limit, and can be evaluated there.
    if(rxy.value<1e-12 && r.norm().value>=100){
        if(f.maxOrder>0)throw std::invalid_argument("ANALYTIC STM: inline tesseral gravity at polar coordinate singularity; use loaded field or FINITE_DIFFERENCE");
        V a=pointMass(r,f.mu,100);
        for(int n=2;n<=f.maxDegree;++n)a=a+zonal(r,f.mu,f.referenceRadius,n,-f.Cnm[n][0]*std::sqrt(2.0*n+1));
        return a;
    }
    const D lat=atan2(r.z,rxy),lon=atan2(r.y,r.x),sl=sin(lat),cl=cos(lat),so=sin(lon),co=cos(lon);
    D p[21][21]{},q[21][21]{};
    p[0][0]=1;
    if(f.maxDegree>=1){p[1][0]=std::sqrt(3.0)*sl;p[1][1]=std::sqrt(3.0)*cl;q[1][0]=std::sqrt(3.0)*cl;q[1][1]=-std::sqrt(3.0)*sl;}
    for(int n=2;n<=f.maxDegree;++n)for(int m=0;m<=n;++m){
        if(m==n){const double k=std::sqrt((2.0*n+1)/(2.0*n));p[n][m]=k*cl*p[n-1][m-1];q[n][m]=k*(-sl*p[n-1][m-1]+cl*q[n-1][m-1]);}
        else if(m==n-1){const double k=std::sqrt(2.0*n+1);p[n][m]=k*sl*p[n-1][m];q[n][m]=k*(cl*p[n-1][m]+sl*q[n-1][m]);}
        else{const double a=std::sqrt((4.0*n*n-1)/(n*n-m*m)),b=std::sqrt(((n-1.0)*(n-1.0)-m*m)/(4*(n-1.0)*(n-1.0)-1));p[n][m]=a*(sl*p[n-1][m]-b*p[n-2][m]);q[n][m]=a*(cl*p[n-1][m]+sl*q[n-1][m]-b*q[n-2][m]);}
    }
    D coslon[21]{},sinlon[21]{};coslon[0]=1;
    if(f.maxOrder>=1){coslon[1]=co;sinlon[1]=so;}
    for(int m=2;m<=f.maxOrder;++m){coslon[m]=2*co*coslon[m-1]-coslon[m-2];sinlon[m]=2*co*sinlon[m-1]-sinlon[m-2];}
    D ar,alat,along,ratio=f.referenceRadius/rr,rp=ratio*ratio;
    for(int n=2;n<=f.maxDegree;++n){
        D an,bn,cn;
        for(int m=0;m<=std::min<int>(n,f.maxOrder);++m){
            const D cs=f.Cnm[n][m]*coslon[m]+f.Snm[n][m]*sinlon[m];
            an+=(n+1)*p[n][m]*cs;bn+=q[n][m]*cs;
            if(m>0)cn+=m*p[n][m]*(f.Snm[n][m]*coslon[m]-f.Cnm[n][m]*sinlon[m]);
        }
        ar+=an*rp;alat+=bn*rp;along+=cn*rp;rp=rp*ratio;
    }
    const D scale=f.mu/(rr*rr);
    return pointMass(r,f.mu,100)+V(cl*co,cl*so,sl)*(-ar*scale)+V(-sl*co,-sl*so,cl)*(alat*scale)+V(-so,co,0)*(along*scale/(cl+1e-20));
}

// Differentiate the normalized Cunningham/Pines recursion and its Cartesian
// acceleration contractions. The degree, order and coefficient cutoffs match
// computeExtendedGravity exactly; there is no STM-specific truncation.
V extendedGravity(const V& r,const ExtendedGravityField& f) {
    const D rr=r.norm();if(rr.value<100)return V();
    V a=pointMass(r,f.mu);if(f.maxDegree<2)return a;
    const D r2=rr*rr,x=r.x*f.referenceRadius/r2,y=r.y*f.referenceRadius/r2,z=r.z*f.referenceRadius/r2,s=(f.referenceRadius/rr)*(f.referenceRadius/rr);
    const int nmax=f.maxDegree;
    std::vector<std::vector<D>> v(nmax+4),w(nmax+4);
    for(int n=0;n<nmax+4;++n){v[n].resize(n+2);w[n].resize(n+2);}
    v[0][0]=f.referenceRadius/rr;
    v[1][0]=std::sqrt(3.0)*z*v[0][0];v[1][1]=std::sqrt(3.0)*x*v[0][0];w[1][1]=std::sqrt(3.0)*y*v[0][0];
    for(int n=2;n<=nmax+1;++n){
        const double k=std::sqrt((2.0*n+1)/(2.0*n));
        v[n][n]=k*(x*v[n-1][n-1]-y*w[n-1][n-1]);w[n][n]=k*(x*w[n-1][n-1]+y*v[n-1][n-1]);
    }
    for(int n=2;n<=nmax+1;++n){const double k=std::sqrt(2.0*n+1);v[n][n-1]=k*z*v[n-1][n-1];w[n][n-1]=k*z*w[n-1][n-1];}
    for(int m=0;m<=std::min<int>(f.maxOrder,nmax);++m)for(int n=m+2;n<=nmax+1;++n){
        const double nm=n-m,np=n+m,alpha=std::sqrt((2.0*n-1)*(2.0*n+1)/(nm*np)),beta=std::sqrt((2.0*n+1)*(nm-1)*(np-1)/((2.0*n-3)*nm*np));
        v[n][m]=alpha*z*v[n-1][m]-beta*s*v[n-2][m];w[n][m]=alpha*z*w[n-1][m]-beta*s*w[n-2][m];
    }
    const double k=f.mu/(f.referenceRadius*f.referenceRadius);
    for(int n=2;n<=nmax;++n)for(int m=0;m<=std::min<int>(n,f.maxOrder);++m){
        const double c=f.getC(n,m),sine=f.getS(n,m),u=2.0*n+1,t=2.0*n+3;
        if(std::abs(c)<1e-30 && std::abs(sine)<1e-30)continue;
        if(m==0){const double gp=std::sqrt(u*(n+1)*(n+2)/(2*t)),gz=std::sqrt(u/t);a=a+V(-k*c*gp*v[n+1][1],-k*c*gp*w[n+1][1],-k*(n+1)*gz*c*v[n+1][0]);}
        else{
            const double gp=std::sqrt(u*(n+m+1)*(n+m+2)/t),gm=m==1?std::sqrt(2*u*n*(n+1)/t):std::sqrt(u*(n-m+1)*(n-m+2)/t),gz=(n-m+1)*std::sqrt(u*(n+m+1)/(t*(n-m+1)));
            a=a+V(0.5*k*(-gp*(c*v[n+1][m+1]+sine*w[n+1][m+1])+gm*(c*v[n+1][m-1]+sine*w[n+1][m-1])),0.5*k*(gp*(sine*v[n+1][m+1]-c*w[n+1][m+1])+gm*(c*w[n+1][m-1]-sine*v[n+1][m-1])),-k*gz*(c*v[n+1][m]+sine*w[n+1][m]));
        }
    }
    return a;
}

V centralGravity(const V& r,const ForceModelSet& f) {
    GravityMode mode=f.gravityMode;
    if(mode==GravityMode::Infer){
        if(f.useLoadedField && f.loadedField)mode=GravityMode::LoadedField;
        else if(f.useEGM2008)mode=GravityMode::EGM2008;
        else if(f.useSphericalHarmonics)mode=GravityMode::SphericalHarmonics;
        else if(f.usePointMass)mode=GravityMode::PointMass;
        else return V();
    }
    switch(mode){
        case GravityMode::PointMass:return pointMass(r,f.mu);
        case GravityMode::J2Only:return pointMass(r,f.mu)+zonal(r,f.mu,RE_EARTH,2,J2_EARTH);
        case GravityMode::J2J4:return pointMass(r,f.mu)+zonal(r,f.mu,RE_EARTH,2,J2_EARTH)+zonal(r,f.mu,RE_EARTH,3,J3_EARTH)+zonal(r,f.mu,RE_EARTH,4,J4_EARTH);
        case GravityMode::LoadedField:return f.loadedField ? extendedGravity(r,*f.loadedField):pointMass(r,f.mu);
        case GravityMode::EGM2008:{
            static ExtendedGravityField field;static uint16_t degree=0,order=0;
            if(degree!=f.egm2008.truncationDegree || order!=f.egm2008.truncationOrder){
                EGM2008Config c;c.maxDegree=f.egm2008.truncationDegree;c.maxOrder=f.egm2008.truncationOrder;field=initEGM2008Extended(c);degree=c.maxDegree;order=c.maxOrder;
            }
            return extendedGravity(r,field);
        }
        default:return inlineGravity(r,inlineCoefficients(f.sphericalHarmonics));
    }
}

V thirdBodySingle(const V& r,const Vec3& body,double mu) {
    const V d=V(body)-r;const D rr=d.norm();const double rb=body.magnitude();
    if(rr.value<1 || rb<1)return V();
    return d*(mu/(rr*rr*rr))+V(body)*(-mu/(rb*rb*rb));
}
V thirdBodies(const V& r,double jd,const ThirdBodyPerturbConfig& c) {
    V a;
    if(c.includeSun){const auto b=getSunPosition(jd);if(b.valid)a=a+thirdBodySingle(r,b.position,MU_SUN);}
    if(c.includeMoon){const auto b=getMoonPosition(jd);if(b.valid)a=a+thirdBodySingle(r,b.position,MU_MOON);}
    const CelestialBody bodies[]={CelestialBody::Mercury,CelestialBody::Venus,CelestialBody::Mars,CelestialBody::Jupiter,CelestialBody::Saturn,CelestialBody::Uranus,CelestialBody::Neptune};
    const bool enabled[]={c.includeMercury,c.includeVenus,c.includeMars,c.includeJupiter,c.includeSaturn,c.includeUranus,c.includeNeptune};
    const double gm[]={MU_MERCURY,MU_VENUS,MU_MARS,MU_JUPITER,MU_SATURN,MU_URANUS,MU_NEPTUNE};
    for(int i=0;i<7;++i)if(enabled[i]){const auto b=getPlanetPosition(bodies[i],jd);if(b.valid)a=a+thirdBodySingle(r,b.position+getSunPosition(jd).position,gm[i]);}
    return a;
}

V cannonball(const V& r,const Vec3& sun,const SRPForceConfig& c) {
    const V d=V(sun)-r;const D distance=d.norm();const V direction=unit(d);
    D lit(1);const D projection=-r.dot(direction);
    if(projection.value>=0){
        const double sunRadius=696000,sd=sun.magnitude();
        const double umbraAngle=std::asin((sunRadius-RE_EARTH)/sd),penumbraAngle=std::asin((sunRadius+RE_EARTH)/sd),length=RE_EARTH/std::sin(umbraAngle);
        if(projection.value<=length){
            const D perpendicular=(r+direction*projection).norm(),ur=RE_EARTH-projection*std::tan(umbraAngle),pr=RE_EARTH+projection*std::tan(penumbraAngle);
            if(perpendicular.value<ur.value)lit=D(0);
            else if(perpendicular.value<pr.value)lit=1-(pr-perpendicular)/(pr-ur);
        }
    }
    if(lit.value<1e-6)return V();
    const D ratio=AU_KM/distance;
    return direction*(-SOLAR_FLUX_1AU*ratio*ratio/299792458.0*c.Cr*c.area/c.mass*1e-3*lit);
}

double density(const Vec3& r,double jd,const ForceModelSet& f) {
    const double alt=r.magnitude()-RE_EARTH;
    switch(f.dragModel){
        case DragModelType::Exponential:return alt>2500 ? 0 : exponentialAtmosphereDensity(std::max(0.0,alt));
        case DragModelType::HarrisPriester:{const auto sun=getSunPosition(jd);return computeHarrisPriester(r,sun.valid?sun.position:Vec3(1,0,0),f.harrisPriesterExponent).density;}
        case DragModelType::NRLMSISE00:{
            AtmosphereConfig c;c.model=AtmosphereModelType::NRLMSISE00;c.includeWinds=f.drag.includeWinds;c.coRotatingAtmosphere=f.drag.coRotatingAtmosphere;c.diurnalVariation=f.nrlmsise00.diurnalVariation;c.geomagneticEffects=f.nrlmsise00.geomagneticActivity;c.minAltitude=f.drag.minAltitude;c.maxAltitude=f.drag.maxAltitude;
            return computeNRLMSISE00(r,jd,f.weather,c).density;
        }
        case DragModelType::USSA1976:
            if(alt<f.drag.minAltitude || alt>f.drag.maxAltitude)return 0;
            // AtmosphericDrag selects by drag.model, separately from the
            // ForceModelSet dispatch. Preserve that legacy distinction.
            switch(f.drag.model){
                case DragModelType::Exponential:return exponentialAtmosphereDensity(alt);
                case DragModelType::USSA1976:return computeUSSA1976(alt).density;
                case DragModelType::JB2008:return computeJB2008(r,jd,f.weather).density;
                case DragModelType::DTM2020:return computeDTM2020(r,jd,f.weather).density;
                default:{AtmosphereConfig c;c.minAltitude=f.drag.minAltitude;c.maxAltitude=f.drag.maxAltitude;c.coRotatingAtmosphere=f.drag.coRotatingAtmosphere;c.includeWinds=f.drag.includeWinds;return computeNRLMSISE00(r,jd,f.weather,c).density;}
            }
        case DragModelType::JB2008:return computeJB2008(r,jd,f.weather).density;
        case DragModelType::DTM2020:return computeDTM2020(r,jd,f.weather).density;
    }
    return 0;
}
V drag(const V& r,const V& v,const Vec3& position,double jd,const ForceModelSet& f,DensityGradient gradient) {
    D rho=density(position,jd,f);if(rho.value<1e-20)return V();
    if(gradient==DensityGradient::FiniteDifference){
        constexpr double h=0.001; // km: 1 m, well above density input roundoff.
        for(int i=0;i<3;++i){
            Vec3 hi=position,lo=position;
            if(i==0){hi.x+=h;lo.x-=h;}else if(i==1){hi.y+=h;lo.y-=h;}else{hi.z+=h;lo.z-=h;}
            rho.d[i]=(density(hi,jd,f)-density(lo,jd,f))/(2*h);
        }
    }
    const bool rotation=f.dragModel==DragModelType::Exponential || f.drag.coRotatingAtmosphere;
    const V vr=v-(rotation?V(-OMEGA_EARTH*r.y,OMEGA_EARTH*r.x,0):V());
    const D speed=vr.norm();if(speed.value<1e-6)return V();
    return vr*(-500.0*f.drag.Cd*f.drag.area/f.drag.mass*rho*speed);
}

V rtn(const Vec3& dv,const V& r,const V& v) {
    const V radial=unit(r),normal=unit(r.cross(v)),transverse=normal.cross(radial);
    return radial*dv.x+transverse*dv.y+normal*dv.z;
}

V relativity(const V& r,const V& v,double jd,const ForceModelSet& f) {
    V a;const D radius=r.norm(),r2=radius*radius,r3=r2*radius;
    if(f.relativistic.schwarzschild){const D k=f.mu/(SPEED_OF_LIGHT*SPEED_OF_LIGHT*r3);a=a+r*((4*f.mu/radius-v.dot(v))*k)+v*(4*r.dot(v)*k);}
    if(f.relativistic.lenseThirring){const V spin(0,0,1);a=a+(r.cross(v)*(3*r.z/r2)+v.cross(spin))*(2*4.35e-3/r3);}
    if(f.relativistic.deSitter){const auto sun=getSunPosition(jd);const double radiusSun=sun.position.magnitude();if(sun.valid && radiusSun>1e3){const Vec3 earthV=sun.velocity*(-1),earthA=sun.position*(MU_SUN/(radiusSun*radiusSun*radiusSun));a=a+V(earthV.cross(earthA)).cross(v)*(-3/(2*f.relativistic.c*f.relativistic.c));}}
    return a;
}

const char* configError(const ForceModelSet& f) {
    if(f.useEarthAlbedo || f.useThermalReradiation || f.useSolidTides || f.useOceanTides || f.usePoleTide || f.useEmpiricalAccel || f.hasFiniteManeuver)
        return "ANALYTIC STM: albedo, thermal, tides, empirical and finite-thrust partials are unavailable; select FINITE_DIFFERENCE";
    if(f.useSRP && f.srp.model!=SRPModelType::Cannonball)
        return "ANALYTIC STM requires cannonball SRP; select FINITE_DIFFERENCE for attitude-dependent SRP";
    if(f.useDrag && f.drag.includeWinds && f.dragModel!=DragModelType::Exponential)
        return "ANALYTIC STM does not support atmosphere wind gradients; select FINITE_DIFFERENCE";
    return nullptr;
}
} // namespace

const char* ValidateAccelerationPartials(const Vec3& position,const ForceModelSet& f) {
    if(const char* error=configError(f))return error;
    if(std::sqrt(position.x*position.x+position.y*position.y)<1e-12 && position.magnitude()>=100) {
        GravityMode mode=f.gravityMode;
        bool hasCentral=true;
        if(mode==GravityMode::Infer) {
            if(f.useLoadedField&&f.loadedField)mode=GravityMode::LoadedField;
            else if(f.useEGM2008)mode=GravityMode::EGM2008;
            else if(f.useSphericalHarmonics)mode=GravityMode::SphericalHarmonics;
            else if(f.usePointMass)mode=GravityMode::PointMass;
            else hasCentral=false;
        }
        const bool inlineCentral=hasCentral && mode!=GravityMode::PointMass &&
            mode!=GravityMode::J2Only && mode!=GravityMode::J2J4 &&
            mode!=GravityMode::LoadedField && mode!=GravityMode::EGM2008;
        if((inlineCentral&&f.sphericalHarmonics.maxDegree>0&&f.sphericalHarmonics.maxOrder>0)||
           (f.useGRGM1200A&&f.grgm1200a.truncationOrder>0))
            return "ANALYTIC STM: inline tesseral gravity at polar coordinate singularity; use loaded field or FINITE_DIFFERENCE";
    }
    return nullptr;
}

AccelerationPartials ComputeAccelerationPartials(const Vec3& position,const Vec3& velocity,double jd,ForceModelSet& f,DensityGradient gradient) {
    if(const char* error=ValidateAccelerationPartials(position,f))throw std::invalid_argument(error);
    const V r=positionSeed(position),v=velocitySeed(velocity);
    V a=centralGravity(r,f);
    if(f.useGRGM1200A)a=a+inlineGravity(r,initGRGM1200A(std::min<uint16_t>(f.grgm1200a.truncationDegree,20),std::min<uint16_t>(f.grgm1200a.truncationOrder,20)));
    if(f.useThirdBody)a=a+thirdBodies(r,jd,f.thirdBody);
    if(f.useSRP){const Vec3 sun=f.sunPositionProvided?f.sunPosition:getSunPosition(jd).position;a=a+cannonball(r,sun,f.srp);}
    if(f.useDrag)a=a+drag(r,v,position,jd,f,gradient);
    if(f.useRelativisticCorrection)a=a+relativity(r,v,jd,f);
    if(f.useContributions)for(int i=0;i<std::min(f.contributions.count,ContributionSet::MAX_SLOTS);++i){
        const auto& c=f.contributions.slots[i];if(!c.enabled)continue;
        switch(c.kind){
            case ContributionKind::ConstantInertial:case ContributionKind::None:break;
            case ContributionKind::ConstantRTN:
                if(r.cross(v).norm().value>0)a=a+rtn(Vec3(c.p[0],c.p[1],c.p[2]),r,v);
                break;
            case ContributionKind::ZonalHarmonic:a=a+zonal(r,c.p[0],c.p[1],static_cast<int>(c.p[2]),c.p[3]);break;
            case ContributionKind::PointMassAt:{const V d=r-V(c.p[1],c.p[2],c.p[3]);if(d.norm().value>0)a=a+pointMass(d,c.p[0],0);break;}
        }
    }
    AccelerationPartials result;
    result.acceleration=ComputeTotalAcceleration(position,velocity,jd,f);
    const D components[]={a.x,a.y,a.z};
    for(int i=0;i<3;++i)for(int j=0;j<3;++j){result.dr[i][j]=components[i].d[j];result.dv[i][j]=components[i].d[j+3];}
    return result;
}

Mat6 ImpulsiveManeuverJacobian(const Vec3& position,const Vec3& velocity,const ImpulsiveManeuverDef& maneuver) {
    Mat6 result=Mat6::identity();if(!maneuver.inRTN)return result;
    if(position.magnitude()==0 || position.cross(velocity).magnitude()==0)
        throw std::invalid_argument("RTN impulse STM requires nonzero radius and angular momentum");
    const V jump=rtn(maneuver.deltaV,positionSeed(position),velocitySeed(velocity));
    const D components[]={jump.x,jump.y,jump.z};
    for(int i=0;i<3;++i)for(int j=0;j<6;++j)result.m[i+3][j]+=components[i].d[j];
    return result;
}

} // namespace ForceModel
} // namespace astro
