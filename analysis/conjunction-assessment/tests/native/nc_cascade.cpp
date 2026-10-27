// Full-state engine E2E: public NASA CARA vectors, then analytic Gaussian
// disk/sphere encounters. Units, epochs and original reference tolerances are
// in src/cpp/tests/fixtures/NOTICE.md and each CSV row. No generated goldens.
#include "conjunction/conjunction_engine.h"
#include <fstream>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <vector>
#include <stdexcept>

using namespace conjunction;
namespace {
void require(bool ok,const std::string& label){if(!ok)throw std::runtime_error(label);}
std::vector<std::vector<std::string>> rows(const std::string& file){
    std::ifstream in(file);require(bool(in),"missing public fixture "+file);
    std::string line;std::getline(in,line);std::vector<std::vector<std::string>> out;
    while(std::getline(in,line)){std::stringstream s(line);std::vector<std::string> row;std::string x;while(std::getline(s,x,','))row.push_back(x);out.push_back(row);}
    return out;
}
PcEncounter encounter(const std::vector<std::string>& row){
    PcEncounter e;size_t k=1;e.has_velocity_covariance=true;
    for(double& x:e.primary)x=std::stod(row[k++]);
    for(double& x:e.secondary)x=std::stod(row[k++]);
    for(double& x:e.covariance_primary)x=std::stod(row[k++]);
    for(double& x:e.covariance_secondary)x=std::stod(row[k++]);
    e.combined_radius=std::stod(row[k]);return e;
}
void relative(double actual,double expected,double tolerance,const std::string& label){
    require(std::isfinite(actual)&&std::abs(actual/expected-1)<=tolerance,label+" relative error="+std::to_string(std::abs(actual/expected-1)));
}
void probability(const ConjunctionEvent2& event){
    require(event.has_covariance&&event.pc.converged,"engine has no converged probability: "+event.pc.usage_reason);
    require(event.pc.probability>=0&&event.pc.probability<=1,"invalid probability");
    if(event.pc.sample_count)require(event.pc.upper_probability>event.pc.lower_probability,"sampling interval missing");
}
void public_cases(const std::string& fixture){
    unsigned accepted2=0;double maximum2=0,maximum3=0;
    for(const auto& row:rows(fixture+"/cara_usage.csv")){
        const auto e=encounter(row);const int code=std::stoi(row[86]);
        const auto two=pc_2d_nc_hall(e);
        if(two.pc.converged){double error=std::abs(two.expected_collisions/std::stod(row[87])-1);maximum2=std::max(maximum2,error);require(error<1e-4,row[0]+" published 2D-Nc");}
        else require(two.requires_3d,row[0]+" failed series must escalate");
        require(assess_pc_usage(e).violated==(code!=0),row[0]+" published usage classification");
        ConjunctionEngine engine;PcFallbackOptions options;options.samples=32768;options.seed=173;
        engine.set_pc_fallback(ConjunctionEngine::Fallback::Automatic,options);
        const auto event=engine.compute_pc(e);probability(event);
        if(event.pc.method=="2D-NC-HALL"){
            accepted2++;require(!two.requires_3d&&!two.requires_monte_carlo,"unusable 2D-Nc accepted");
            relative(event.pc.probability,std::stod(row[87]),1e-4,row[0]+" engine 2D-Nc");
        }else if(event.pc.method=="3D-NC-HALL")relative(event.pc.probability,std::stod(row[88]),1e-3,row[0]+" engine 3D-Nc");
        else if(event.pc.sample_count){
            // A small sample cannot match a multi-million-trial CI exactly.
            // Bernstein 1% family-wise allowance across these eight rows,
            // maximized over the published Monte Carlo 95% reference interval.
            const double lo=std::stod(row[90]),hi=std::stod(row[91]);
            const double p=std::clamp(.5,lo,hi),L=std::log(2*8/.01),n=options.samples;
            const double allowance=std::sqrt(2*p*(1-p)*L/n)+2*L/(3*n);
            require(event.pc.probability>=std::max(0.0,lo-allowance)&&event.pc.probability<=std::min(1.0,hi+allowance),row[0]+" sampled reference consistency");
        }
        if(code)require(event.pc.usage_reason.find("2D-NC-HALL")!=std::string::npos,"automatic route skipped 2D-Nc");
        std::cout<<row[0]<<" method="<<event.pc.method<<" Pc="<<event.pc.probability<<" Nc2 checks="<<two.nc_extended<<","<<two.nc_offset<<","<<two.nc_inaccurate<<std::endl;
    }
    require(accepted2>0,"no published violating encounter completed at 2D-Nc");
    for(const auto& row:rows(fixture+"/cara_hall.csv")){
        const auto e=encounter(row);PcFallbackOptions options;
        options.time_start=std::stod(row[88]);options.time_end=std::stod(row[89]);options.angular_order=16;
        const auto three=pc_3d_nc_hall(e,options);
        require(three.pc.converged,row[0]+" 3D-Nc numerical convergence");
        relative(three.expected_collisions,std::stod(row[86]),std::stod(row[87]),row[0]+" published 3D-Nc");
        maximum3=std::max(maximum3,std::abs(three.expected_collisions/std::stod(row[86])-1));
        std::cout<<row[0]<<" Nc="<<three.expected_collisions<<std::endl;
    }
    std::cout<<"Published max relative errors: Nc2="<<maximum2<<" Nc3="<<maximum3<<std::endl;
}
void analytic_cascade(){
    // Inertial km/km-s, JD 2451545; mu=0 selects rectilinear dynamics.
    // Infinite-window parallel-line crossing: centered Gaussian disk CDF.
    // At +/-10000 s the omitted near-zero-velocity measure is <1e-4;
    // the 1e-3 comparison also covers the independently refined quadrature.
    PcEncounter e;e.epoch_jd=2451545;e.gravitational_parameter=0;e.has_velocity_covariance=true;
    e.primary={7000,0,0,0,0,0};e.secondary={7000,0,0,0,.1,0};e.combined_radius=.02;
    for(int i=0;i<3;++i)e.covariance_primary[i*6+i]=.01;
    e.covariance_primary[28]=.04;
    PcFallbackOptions options;options.two_body=false;options.time_start=-10000;options.time_end=10000;
    ConjunctionEngine engine;engine.set_pc_fallback(ConjunctionEngine::Fallback::Automatic,options);
    const auto event=engine.compute_pc(e);probability(event);
    std::cout<<"velocity-dispersed disk method="<<event.pc.method<<" Pc="<<event.pc.probability<<" reason="<<event.pc.usage_reason<<std::endl;
    require(event.pc.method=="3D-NC-CARTESIAN","series inconsistency must refine to 3D-Nc");
    relative(event.pc.probability,-std::expm1(-.02),1e-3,"finite-window disk");
    // Zero relative motion, isotropic static Gaussian: exact Maxwell CDF.
    e.secondary[4]=0;e.covariance_primary[28]=0;e.combined_radius=.1;
    options.time_start=-1;options.time_end=1;options.samples=65536;options.seed=173;
    engine.set_pc_fallback(ConjunctionEngine::Fallback::Automatic,options);
    const auto sampled=engine.compute_pc(e);probability(sampled);
    const double pi=std::acos(-1.0),exact=std::erf(1/std::sqrt(2.0))-std::sqrt(2/pi)*std::exp(-.5);
    require(sampled.pc.method=="SDMC-RECTILINEAR","initial occupancy must reach sampled total probability");
    require(std::abs(sampled.pc.probability-exact)<5*std::sqrt(exact*(1-exact)/options.samples),"static Gaussian sphere within five binomial sigma");
    const auto& trace=sampled.pc.usage_reason;
    require(trace.find("2D-NC-CARTESIAN rejected")<trace.find("3D-NC-CARTESIAN rejected"),"sequential rejection trace missing");
    require(sampled.pc.initial_overlap_count==sampled.pc.collision_count,"static collisions retain initial-occupancy provenance");
    e.covariance_primary.fill(0);const auto invalid=engine.compute_pc(e);
    require(!invalid.has_covariance&&invalid.pc.method=="PC-UNAVAILABLE","invalid input must not escalate into a probability");
}
}
int main(int argc,char** argv){
    try{require(argc==2,"fixture directory required");std::cout<<std::setprecision(13);public_cases(argv[1]);analytic_cascade();std::cout<<"NC CASCADE NATIVE E2E PASS\n";return 0;}
    catch(const std::exception& e){std::cerr<<"FAIL: "<<e.what()<<std::endl;return 1;}
}
