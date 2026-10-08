// Control-flow tests, not numerical physics acceptance vectors. They assert
// documented rejection, dispatch and restoration behavior of the STM wrapper.
#include "variational.h"
#include <cmath>
#include <iostream>
#include <limits>
#include <string>

using namespace astro;
using namespace astro::Integrator;

int main() {
    int cases=0,failures=0;
    auto check=[&](bool ok,const char* label){
        ++cases;if(!ok)++failures;
        std::cout<<(ok?"PASS ":"FAIL ")<<label<<'\n';
    };
    StateVector initial{{7000,0,0},{0,7.5,1},2451545.0};
    auto config=CreateLEOConfig();
    ForceModel::ForceModelSet forces;
    forces.usePointMass=true;
    forces.gravityMode=ForceModel::GravityMode::PointMass;
    forces.useSphericalHarmonics=false;
    forces.useThirdBody=false;forces.useDrag=false;forces.useSRP=false;
    const double savedEpoch=2400000.5;
    forces.weather.epoch=savedEpoch;
    const double nan=std::numeric_limits<double>::quiet_NaN();

    for(auto method:{STMMethod::Analytic,STMMethod::FiniteDifference}) {
        auto bad=initial;bad.epoch=nan;
        check(!PropagateWithSTM(bad,0,config,forces,method).success,"reject nonfinite epoch at zero duration");
        check(!PropagateWithSTM(initial,nan,config,forces,method).success,"reject nonfinite duration");
        bad=initial;bad.position.x=nan;
        check(!PropagateWithSTM(bad,0,config,forces,method).success,"reject nonfinite state at zero duration");
        auto invalid=config;invalid.initialStep=0;
        check(!PropagateWithSTM(initial,0,invalid,forces,method).success,"reject invalid control at zero duration");
    }
    auto unsupported=config;unsupported.method=IntegrationMethod::ABM;
    const auto refused=PropagateWithSTM(initial,30,unsupported,forces,STMMethod::FiniteDifference);
    check(!refused.success&&refused.errorMessage.find("no verified result dispatcher")!=std::string::npos,
          "refuse unsupported FD dispatcher without silent RKF78 fallback");

    auto cowell=config; cowell.method=IntegrationMethod::Cowell;
    auto cashKarp=config; cashKarp.method=IntegrationMethod::RKF45;
    const auto a=PropagateWithSTM(initial,60,cowell,forces,STMMethod::FiniteDifference);
    const auto b=PropagateWithSTM(initial,60,cashKarp,forces,STMMethod::FiniteDifference);
    bool equal=a.success&&b.success&&a.steps==b.steps&&a.rejections==b.rejections;
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)equal=equal&&a.stm.m[i][j]==b.stm.m[i][j];
    check(equal,"Cowell finite difference dispatches Cash-Karp");

    auto rk4=config;rk4.method=IntegrationMethod::RK4;
    const auto incomplete=PropagateWithSTM(initial,-30,rk4,forces,STMMethod::FiniteDifference);
    check(!incomplete.success&&incomplete.errorMessage.find("did not reach")!=std::string::npos,
          "reject legacy RK4 incomplete backward integration");

    forces.useOceanTides=true;
    check(!PropagateWithSTM(initial,30,config,forces).success,"unsupported force derivative fails");
    check(forces.weather.epoch==savedEpoch,"weather epoch restored after force derivative failure");
    forces.useOceanTides=false;
    auto limited=config;limited.maxSteps=1;
    check(!PropagateWithSTM(initial,3000,limited,forces,STMMethod::FiniteDifference).success,
          "finite difference exhaustion cannot report success");
    check(forces.weather.epoch==savedEpoch,"weather epoch restored after finite difference failure");

    ForceModel::ImpulsiveManeuverDef invalidBurn;invalidBurn.epoch=nan;
    check(!PropagateWithSTM(initial,30,config,forces,STMMethod::Analytic,
        ForceModel::DensityGradient::Neglected,{invalidBurn}).success,"reject invalid burn before sorting");
    std::cout<<(failures?"FAIL ":"PASS ")<<"HPOP variational controls cases="<<cases<<" failures="<<failures<<'\n';
    return failures?1:0;
}
