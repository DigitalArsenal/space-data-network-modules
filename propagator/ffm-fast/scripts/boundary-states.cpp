// Initial states for public-SDS E2E cases on either side of automatic policy
// boundaries. Only C++ computes states: two-body energy/angular momentum at
// perigee, in GCRF, with the configured TT-compatible GM supplied in m^3/s^2.
// The subsequent trajectories are compared with unchanged standard T3 WASM.
#include "astrodynamics_types.h"
#include "shadow.h"
#include <algorithm>
#include <limits>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <string>

int main(int argc,char** argv) {
    if (argc==2 && std::string(argv[1])=="--startup-state") {
        // A short ascending physical arc is valid above the stop surface,
        // even when artificial backward startup history would cross it.
        std::cout<<std::setprecision(17)<<"["<<(astro::RE_EARTH+100.1)*1000<<",0,0,700,8000,0]\n";
        return 0;
    }
    if (argc==2 && std::string(argv[1])=="--audit-shadow") {
        double t,x,y,z,sx,sy,sz,previous[3]={1,1,1},minimum[3]={1,1,1};
        double probes[3]={NAN,NAN,NAN};
        unsigned crossings[3]={0,0,0},samples=0;
        while (std::cin>>t>>x>>y>>z>>sx>>sy>>sz) {
            const astro::Vec3 r(x/1000,y/1000,z/1000), d=astro::Vec3(sx/1000,sy/1000,sz/1000)-r;
            const double a=std::asin(astro::shadow::SUN_RADIUS_KM/d.magnitude());
            const double b=std::asin(astro::RE_EARTH/r.magnitude());
            const double c=std::atan2(r.cross(d).magnitude(),-r.dot(d));
            const double g[3]={c-a-b,c-b+a,c-b};
            for (int i=0;i<3;++i) if (t==600+300*i) probes[i]=g[0];
            for (int i=0;i<3;++i) {
                if (samples && ((g[i]<0)!=(previous[i]<0))) ++crossings[i];
                minimum[i]=std::min(minimum[i],g[i]); previous[i]=g[i];
            }
            ++samples;
        }
        std::cout<<std::setprecision(17)<<"{\"samples\":"<<samples<<",\"penumbraCrossings\":"<<crossings[0]
                 <<",\"umbraCrossings\":"<<crossings[1]<<",\"midpointCrossings\":"<<crossings[2]
                 <<",\"minimumPenumbra\":"<<minimum[0]<<",\"minimumUmbra\":"<<minimum[1]
                 <<",\"minimumMidpoint\":"<<minimum[2];
        if (std::all_of(probes,probes+3,[](double x) { return std::isfinite(x); }))
            std::cout<<",\"penumbraAtStepStart\":"<<probes[0]<<",\"penumbraAtStepMidpoint\":"<<probes[1]
                     <<",\"penumbraAtStepEnd\":"<<probes[2];
        std::cout<<"}\n";
        return 0;
    }
    if (argc!=2 && argc!=8) return 2;
    const double mu=std::stod(argv[1])/1e9, re=astro::RE_EARTH, pi=std::acos(-1.);
    bool first=true;
    auto emit=[&](const std::string& name,double a,double e,const std::string& expected) {
        const double r=a*(1-e), v=std::sqrt(mu*(1+e)/r), inclination=.7;
        if (!first) std::cout << ','; first=false;
        std::cout << "{\"name\":\"" << name << "\",\"expected\":\"" << expected << "\",\"state\":["
                  << r*1000 << ",0,0,0," << v*std::cos(inclination)*1000 << ',' << v*std::sin(inclination)*1000 << "]}";
    };
    auto gj=[](int step) { return "GJ8 PEC at "+std::to_string(step)+" s"; };
    auto sundman=[](int steps) { return "RK78 Sundman alpha=1.5 at "+std::to_string(steps)+"/orbit"; };
    auto periodA=[&](double minutes) { return std::cbrt(mu*std::pow(minutes*60/(2*pi),2)); };
    std::cout << std::setprecision(17) << '[';
    for (const double sign:{-1.,1.}) {
        const std::string side=sign<0?" below":" above";
        emit("perigee 300 km"+side,(re+300+sign*.001)/.999,.001,gj(sign<0?10:15));
        emit("perigee 450 km"+side,(re+450+sign*.001)/.999,.001,gj(sign<0?15:12));
        emit("perigee 650 km"+side,(re+650+sign*.001)/.999,.001,gj(sign<0?12:24));
        emit("apogee 2000 km"+side,(re+2000+sign*.001)/1.001,.001,gj(24));
        emit("eccentricity 0.25"+side,10000,.25+sign*.000001,sign<0?gj(24):sundman(200));
        emit("period 600 min"+side,periodA(600+sign*.001),.01,gj(sign<0?24:150));
        emit("period 800 min"+side,periodA(800+sign*.001),.01,gj(sign<0?150:24));
        emit("period 1400 min"+side,periodA(1400+sign*.001),.01,gj(sign<0?24:600));
        emit("period 1480 min"+side,periodA(1480+sign*.001),.01,gj(sign<0?600:24));
        emit("GPS eccentricity 0.05"+side,periodA(720),.05+sign*.000001,gj(sign<0?150:24));
        emit("GEO eccentricity 0.05"+side,periodA(1440),.05+sign*.000001,gj(sign<0?600:24));
        auto apsides=[&](const std::string& name,double hp,double ha,int n) {
            const double rp=re+hp,ra=re+ha;
            emit(name+side,(rp+ra)/2,(ra-rp)/(ra+rp),sundman(n));
        };
        apsides("GTO perigee 1000 km",1000+sign*.001,36000,sign<0?300:200);
        apsides("GTO apogee 30000 km",500,30000+sign*.001,sign<0?200:300);
        apsides("GTO apogee 45000 km",500,45000+sign*.001,sign<0?300:200);
    }
    if (argc==8) {
        const double radius=42164, speed=std::sqrt(mu/radius), rate=speed/radius;
        // Retain narrow same-sign grazes. The larger-area case is offset
        // from the step midpoint to exercise the multiple-crossing scan.
        for (const double depth:{1e-7,3e-7,1e-6,3e-6,1.5e-4}) {
            const bool strong=depth==1.5e-4;
            const int index=strong?5:2;
            const astro::Vec3 sun(std::stod(argv[index])/1000,std::stod(argv[index+1])/1000,std::stod(argv[index+2])/1000);
            const auto direction=sun*(1/sun.magnitude());
            const auto u0=astro::Vec3(0,0,1).cross(direction), u=u0*(1/u0.magnitude());
            const auto perpendicular=direction.cross(u);
            const double center=strong?1050.123:917.123;
            double beta=std::asin(re/radius)+std::asin(astro::shadow::SUN_RADIUS_KM/sun.magnitude())-depth;
            astro::Vec3 normal, middle, tangent;
            for (int iteration=0;iteration<4;++iteration) {
                normal=direction*std::sin(beta)+perpendicular*std::cos(beta);
                const auto projected=direction*(-1)+normal*std::sin(beta);
                middle=projected*(1/projected.magnitude()); tangent=normal.cross(middle);
                const auto r=middle*radius, d=sun-r;
                const double separation=std::atan2(r.cross(d).magnitude(),-r.dot(d));
                beta+=std::asin(re/radius)+std::asin(astro::shadow::SUN_RADIUS_KM/d.magnitude())-depth-separation;
            }
            const double phase=-rate*center;
            const auto r=(middle*std::cos(phase)+tangent*std::sin(phase))*radius;
            const auto v=(middle*(-std::sin(phase))+tangent*std::cos(phase))*speed;
            std::cout<<",{\"name\":\"penumbra graze "<<depth<<"\",\"expected\":\""<<gj(600)
                     <<"\",\"graze\":true,\"crAm\":"<<(strong?20:.02)
                     <<",\"strongGraze\":"<<(strong?"true":"false")
                     <<",\"grazeCenterSeconds\":"<<center
                     <<",\"auditHalfWidthSeconds\":"<<(strong?450:60)
                     <<",\"state\":["<<r.x*1000<<','<<r.y*1000<<','<<r.z*1000<<','
                     <<v.x*1000<<','<<v.y*1000<<','<<v.z*1000<<"]}";
        }
    }
    std::cout << "]\n";
}
