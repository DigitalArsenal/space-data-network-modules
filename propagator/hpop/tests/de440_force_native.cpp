// Focused force-consumption proof, independent of the new ephemeris evaluator.
// Authority: published JPL DE440s via NAIF CSPICE N0067; committed source vectors
// and full provenance in files/orbit-products/tests/fixtures/de440/.
// Geometric ICRF/J2000, JD2461041.5 TDB, km and km/s. Acceleration km/s^2.
// Expected third-body acceleration is independently evaluated Newtonian
// differential gravity in long double: mu*((R-r)/|R-r|^3 - R/|R|^3).
// HPOP's existing documented GM constants are explicit model inputs here; this
// check validates consumption/frame/centre, not an update to its GM constants.
// Expected SRP is photon momentum flux F/c * Cr*A/m * (AU/d)^2 away from Sun.
// F=1361 W/m^2 (IAU2015 B3 nominal irradiance), c=299792458 m/s (SI exact),
// AU=149597870.7 km (IAU2012 B2 exact), Cr=1.5, A=10m^2, m=1000kg.
// References: https://iauarchive.eso.org/static/resolutions/IAU2015_English.pdf
// https://iau-a3.gitlab.io/res.html
// Absolute norm tolerance1e-18km/s^2: double-precision gravity cancellation
// and coefficient evaluation only; no model/observational accuracy claim.
#include "astrodynamics.h"
#include "ephemeris.h"
#include "force_models.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <map>
#include <sstream>
#include <stdexcept>
#include <vector>

using V=std::array<long double,3>;
static long double norm(const V& r) {return std::sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2]);}
static V gravity(const V& r,const V& R,long double mu) {
    V delta={R[0]-r[0],R[1]-r[1],R[2]-r[2]}, a{};
    const auto d=norm(delta),b=norm(R);
    for(int i=0;i<3;++i) a[i]=mu*(delta[i]/(d*d*d)-R[i]/(b*b*b));
    return a;
}
static long double error(const astro::Vec3& actual,const V& expected) {
    return norm({actual.x-expected[0],actual.y-expected[1],actual.z-expected[2]});
}
static int failures=0;
static void check(const char* name,long double value) {
    constexpr long double tolerance=1e-18L;
    const bool ok=std::isfinite(value)&&value<=tolerance;
    std::cout<<"RESULT "<<name<<' '<<value<<" 1e-18 "<<(ok?"PASS":"FAIL")<<'\n';
    if(!ok) ++failures;
}
int main(int argc,char** argv) {
 try {
    if(argc!=2) throw std::runtime_error("usage: de440-force fixtures/de440");
    std::cout<<std::setprecision(17);
    const std::string fixtures=argv[1];
    std::ifstream input(fixtures+"/de440-2026.bsp",std::ios::binary);
    if(!input) throw std::runtime_error("missing committed DE440 excerpt");
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(input)),{});
    if(!astro::Ephemeris::loadEphemerisBuffer(bytes.data(),bytes.size(),astro::Ephemeris::EphemerisSource::JPL_DE440))
        throw std::runtime_error("kernel load failed");
    std::ifstream csv(fixtures+"/cspice-de440.csv");
    std::string line;std::getline(csv,line);
    std::map<int,V> positions;
    while(std::getline(csv,line)) {
        std::replace(line.begin(),line.end(),',',' ');std::istringstream row(line);
        int target,center;double jd;V state{};
        if(!(row>>target>>center>>jd>>state[0]>>state[1]>>state[2])) throw std::runtime_error("bad CSPICE row");
        if(center==399 && jd==2461041.5) positions[target]=state;
    }
    using Config=astro::ForceModel::ThirdBodyPerturbConfig;
    struct Body {const char* name;int id;double gm;bool Config::*flag;};
    const Body bodies[]={
        {"Sun",10,1.32712440018e11,&Config::includeSun},{"Moon",301,4902.800066,&Config::includeMoon},
        {"Mercury",1,22031.868551,&Config::includeMercury},{"Venus",2,324858.592000,&Config::includeVenus},
        {"Mars",4,42828.375816,&Config::includeMars},{"Jupiter",5,126712764.100000,&Config::includeJupiter},
        {"Saturn",6,37940584.841800,&Config::includeSaturn},{"Uranus",7,5794556.400000,&Config::includeUranus},
        {"Neptune",8,6836527.100580,&Config::includeNeptune}};
    const V satellite={7000,-1200,900};
    const astro::Vec3 r(7000,-1200,900);
    for(const auto& body:bodies) {
        Config config;config.includeSun=false;config.includeMoon=false;config.*(body.flag)=true;
        const auto actual=astro::ForceModel::ThirdBody(r,2461041.5,config);
        check(body.name,error(actual,gravity(satellite,positions.at(body.id),body.gm)));
    }
    // Place satellite between Earth and Sun: full illumination is geometric,
    // not inferred from the implementation's eclipse helper.
    const V sun=positions.at(10);const auto sunDistance=norm(sun);
    V lit={},towardSun={};
    for(int i=0;i<3;++i) {lit[i]=7000.0L*sun[i]/sunDistance;towardSun[i]=sun[i]-lit[i];}
    const auto distance=norm(towardSun);
    const auto acceleration=1361.0L/299792458.0L*std::pow(149597870.7L/distance,2)*1.5L*10.0L/1000.0L*1e-3L;
    V expected{};for(int i=0;i<3;++i) expected[i]=-towardSun[i]/distance*acceleration;
    astro::ForceModel::ForceModelSet forces;
    forces.gravityMode=astro::ForceModel::GravityMode::PointMass;forces.mu=0;
    forces.useThirdBody=false;forces.useSRP=true;
    forces.srp.mass=1000;forces.srp.area=10;forces.srp.Cr=1.5;
    const auto actual=astro::ForceModel::ComputeTotalAcceleration({double(lit[0]),double(lit[1]),double(lit[2])},{},2461041.5,forces);
    check("SRP_kernel_sun",error(actual,expected));
    if(!astro::Ephemeris::ephemerisError().empty()) throw std::runtime_error(astro::Ephemeris::ephemerisError());
    astro::Ephemeris::clearEphemerisBuffer();
    std::cout<<(failures?"FAIL":"PASS")<<" DE440 force cases=10 failures="<<failures<<'\n';
    return failures?1:0;
 } catch(const std::exception& e) {std::cerr<<"FAIL "<<e.what()<<'\n';return 1;}
}
