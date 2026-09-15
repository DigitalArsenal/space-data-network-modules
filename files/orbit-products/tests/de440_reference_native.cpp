// Authoritative JPL DE440 interpolation validation. See fixtures/de440/* and
// docs/de440-validation.md for queries, exact kernel SHA256 and reproduction.
// State references originate in NASA/JPL CSPICE N0067 (via SpiceyPy 8.0.0),
// never in the code under test. Geometric ICRF/J2000; TDB Julian dates; km, km/s.
// Absolute Euclidean-norm tolerances: 1e-6 km, 1e-9 km/s (same-kernel roundoff).
// Horizons currently returns DE441: its distinct smoke-test envelope is 10 m
// and 0.1 mm/s to allow model differences; this does NOT relax DE440 precision.
#include "spk_kernel.hpp"
#ifdef DE440_WITH_HPOP
#include "astrodynamics.h"
#include "ephemeris.h"
#endif
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
#include <string>
#include <vector>

struct Reference { int target, center; double jd; std::array<double,6> state; };
static std::vector<Reference> read_references(const std::string& path) {
    std::ifstream input(path);
    if (!input) throw std::runtime_error("cannot open " + path);
    std::string line;
    std::getline(input,line);
    if(line != "target,center,jd_tdb,x_km,y_km,z_km,vx_km_s,vy_km_s,vz_km_s" &&
       line != "target,center,jd_tdb,x_km,y_km,z_km,vx_km_s,vy_km_s,vz_km_s\r")
        throw std::runtime_error("invalid reference header");
    std::vector<Reference> rows;
    while(std::getline(input,line)) {
        if(line.empty()) continue;
        std::replace(line.begin(),line.end(),',',' ');
        std::istringstream row(line);
        Reference r{};
        if(!(row >> r.target >> r.center >> r.jd)) throw std::runtime_error("invalid reference row");
        for(auto& v:r.state) if(!(row >> v) || !std::isfinite(v)) throw std::runtime_error("invalid state reference");
        rows.push_back(r);
    }
    return rows;
}
static double norm_error(const double* a,const double* b) {
    return std::hypot(std::hypot(a[0]-b[0],a[1]-b[1]),a[2]-b[2]);
}
static int failures=0;
static void result(const char* name,double measured,double limit) {
    const bool pass=std::isfinite(measured) && measured<=limit;
    std::cout<<"RESULT "<<name<<' '<<measured<<' '<<limit<<' '<<(pass?"PASS":"FAIL")<<'\n';
    if(!pass) ++failures;
}
static void validate(const spk::Kernel& kernel,const std::vector<Reference>& refs,
                     const char* prefix,double position_limit,double velocity_limit) {
    double maxp=0,maxv=0;
    std::map<int,std::array<double,2>> body_errors;
    for(const auto& r:refs) {
        ephem::StateRow state;
        const auto status=kernel.state(r.target,r.center,r.jd,&state);
        if(status!=ephem::Status::Ok || !state.has_vel) {
            std::cerr<<"state failed: "<<r.target<<'/'<<r.center<<" JD "<<r.jd<<' '<<ephem::status_name(status)<<'\n';
            ++failures; continue;
        }
        const auto dp=norm_error(state.pos,r.state.data()), dv=norm_error(state.vel,r.state.data()+3);
        if(!std::isfinite(dp) || !std::isfinite(dv)) ++failures;
        maxp=std::max(maxp,dp);maxv=std::max(maxv,dv);
        auto& errors=body_errors[r.target];errors[0]=std::max(errors[0],dp);errors[1]=std::max(errors[1],dv);
        if(dp>position_limit || dv>velocity_limit)
            std::cerr<<"out of tolerance "<<prefix<<' '<<r.target<<'/'<<r.center<<" JD "<<r.jd<<" dp="<<dp<<" dv="<<dv<<'\n';
    }
    for(const auto& [body, errors]:body_errors)
        std::cout<<"BODY "<<prefix<<' '<<body<<' '<<errors[0]<<' '<<errors[1]<<'\n';
    result((std::string(prefix)+"_position_km").c_str(),maxp,position_limit);
    result((std::string(prefix)+"_velocity_km_s").c_str(),maxv,velocity_limit);
}

int main(int argc,char** argv) {
    try {
        if(argc!=2 && argc!=3) throw std::runtime_error("usage: de440_reference_native fixtures/de440 [--excerpt]");
        const bool excerpt=argc==3 && std::string(argv[2])=="--excerpt";
        std::cout<<std::setprecision(17);
        const std::string path=argv[1];
        std::ifstream in(path+(excerpt?"/de440-2026.bsp":"/de440s.bsp"),std::ios::binary);
        if(!in) throw std::runtime_error("missing DE440s; run fixtures/de440/download.py");
        std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)),{});
        spk::Kernel kernel;
        if(kernel.load(bytes.data(),bytes.size())!=ephem::Status::Ok) throw std::runtime_error("DE440s load failed");
        auto cspice=read_references(path+"/cspice-de440.csv");
        const auto horizons=read_references(path+"/horizons.csv");
        if(cspice.size()!=238 || horizons.size()!=48) throw std::runtime_error("incomplete authoritative reference tables");
        if(excerpt) cspice.erase(std::remove_if(cspice.begin(),cspice.end(),[](const auto& r){return r.jd<2461041.5 || r.jd>2461406.5;}),cspice.end());
        if(excerpt && cspice.size()!=221) throw std::runtime_error("incomplete excerpt references");
        validate(kernel,cspice,"de440_cspice",1e-6,1e-9);
        validate(kernel,horizons,"horizons_de441",0.01,1e-7);
#ifdef DE440_WITH_HPOP
        astro::Ephemeris::clearEphemerisBuffer();
        astro::Ephemeris::selectEphemerisSource(astro::Ephemeris::EphemerisSource::Analytical);
        std::vector<std::pair<Reference,astro::Vec3>> analytic;
        for(const auto& r:cspice) {
            if(r.center!=399 || (r.target!=10 && r.target!=301) || r.jd<2461041.5 || r.jd>=2461406.5) continue;
            const auto a=r.target==10?astro::getSunPosition(r.jd):astro::getMoonPosition(r.jd);
            if(!a.valid || a.source!=astro::Ephemeris::EphemerisSource::Analytical) throw std::runtime_error("analytic source selection failed");
            analytic.push_back({r,a.position});
        }
        if(analytic.size()!=24) throw std::runtime_error("incomplete monthly analytic comparison");
        if(!astro::Ephemeris::loadEphemerisBuffer(bytes.data(),bytes.size(),astro::Ephemeris::EphemerisSource::JPL_DE440))
            throw std::runtime_error("HPOP buffer load failed");
        double maxp=0,maxv=0;
        for(const auto& [r,a]:analytic) {
            const auto k=r.target==10?astro::getSunPosition(r.jd):astro::getMoonPosition(r.jd);
            const double av[]={a.x,a.y,a.z}, kp[]={k.position.x,k.position.y,k.position.z}, kv[]={k.velocity.x,k.velocity.y,k.velocity.z};
            const double dp=norm_error(kp,r.state.data()),dv=norm_error(kv,r.state.data()+3);
            if(!k.valid || k.source!=astro::Ephemeris::EphemerisSource::JPL_DE440) throw std::runtime_error("HPOP reported wrong source");
            maxp=std::max(maxp,dp);maxv=std::max(maxv,dv);
            std::cout<<"ANALYTIC "<<r.target<<' '<<r.jd<<' '<<norm_error(av,r.state.data())<<' '<<dp<<'\n';
        }
        result("hpop_de440_position_km",maxp,1e-6);
        result("hpop_de440_velocity_km_s",maxv,1e-9);
        astro::Ephemeris::clearEphemerisBuffer();
#endif
        std::cout<<(failures?"FAIL":"PASS")<<" DE440 authoritative states="<<cspice.size()<<" Horizons states="<<horizons.size()<<" failures="<<failures<<'\n';
        return failures?1:0;
    } catch(const std::exception& error) {
        std::cerr<<"FAIL "<<error.what()<<'\n';return 1;
    }
}
