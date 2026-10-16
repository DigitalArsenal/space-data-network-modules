#include "conjunction/pc_fallbacks.h"
#include "../src/pc_math.h"
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <vector>

using namespace conjunction;
using namespace conjunction::pc_detail;
namespace {
int passed=0,failed=0;
void check(bool condition,const std::string& label) {
    if(condition)++passed;else{++failed;std::cerr<<"FAIL: "<<label<<'\n';}
}
std::vector<std::vector<std::string>> csv(const char* name) {
    std::ifstream in(std::string(CONJUNCTION_TEST_FIXTURE_DIR)+"/"+name);
    std::vector<std::vector<std::string>> rows;std::string line;
    std::getline(in,line);
    while(std::getline(in,line)){std::stringstream stream(line);std::vector<std::string> row;std::string word;while(std::getline(stream,word,','))row.push_back(word);rows.push_back(row);}
    check(!rows.empty(),std::string("fixture loaded: ")+name);return rows;
}
PcEncounter straight() {
    PcEncounter e;e.gravitational_parameter=0;e.combined_radius=0.02;e.has_velocity_covariance=true;
    e.secondary[4]=0.1;
    for(int i=0;i<3;++i)e.covariance_primary[i*6+i]=0.01;
    return e;
}
BPlaneGeometry bplane(const PcEncounter& e) {
    auto r=sub(position(e.secondary),position(e.primary)),v=sub(velocity(e.secondary),velocity(e.primary));
    double speed=norm(v);for(auto& x:v)x/=speed;
    V3 x=r;double along=dot(x,v);for(int i=0;i<3;++i)x[i]-=along*v[i];
    double distance=norm(x);for(auto& value:x)value/=distance;
    V3 z={x[1]*v[2]-x[2]*v[1],x[2]*v[0]-x[0]*v[2],x[0]*v[1]-x[1]*v[0]};
    M3 cov=block(relative_pc_covariance(e));BPlaneGeometry b;
    b.xi=norm(r);b.zeta=0;b.sigma_xx=dot(x,mul(cov,x));b.sigma_xz=dot(x,mul(cov,z));b.sigma_zz=dot(z,mul(cov,z));b.combined_radius=e.combined_radius;return b;
}
PcEncounter usage_case(const std::vector<std::string>& row) {
    PcEncounter e;size_t k=1;
    for(int i=0;i<6;++i)e.primary[i]=std::stod(row[k++]);
    for(int i=0;i<6;++i)e.secondary[i]=std::stod(row[k++]);
    for(double& x:e.covariance_primary)x=std::stod(row[k++]);
    for(double& x:e.covariance_secondary)x=std::stod(row[k++]);
    e.combined_radius=std::stod(row[k++]);e.has_velocity_covariance=true;return e;
}
void closed_form_tests() {
    // Source: exact integral of a centered isotropic 2D normal over a disk,
    // Pc=1-exp(-R^2/(2 sigma^2)). Inertial km, km/s, relative t=0; mu=0.
    // 5e-5 relative allows the independently refined sphere quadrature error.
    auto e=straight();double exact=-std::expm1(-0.02);
    PcFallbackOptions o;o.two_body=false;o.time_start=-10;o.time_end=10;o.relative_tolerance=2e-5;
    auto nc2=pc_2d_nc_cartesian(e,o),nc3=pc_3d_nc_cartesian(e,o);
    std::cout<<"closed-form centered disk: exact="<<exact<<" Nc2="<<nc2.pc.probability<<" Nc3="<<nc3.pc.probability<<'\n';
    check(std::abs(nc2.pc.probability/exact-1)<5e-5,"2D-Nc closed-form disk");
    check(std::abs(nc3.pc.probability/exact-1)<5e-5,"3D-Nc closed-form disk");
    check(nc2.pc.converged,"2D-Nc numerical convergence");
    check(nc3.pc.converged,"3D-Nc numerical convergence");
    o.samples=131072;o.seed=173;
    auto mc=pc_monte_carlo(e,o),repeat=pc_monte_carlo(e,o);
    double five_sigma=5*std::sqrt(exact*(1-exact)/o.samples);
    check(mc.pc.converged&&std::abs(mc.pc.probability-exact)<five_sigma,"SDMC disk within five binomial sigma");
    check(mc.hits==repeat.hits,"SDMC repeated seed reproduces hits");
    check(mc.pc.lower_probability<=mc.pc.probability&&mc.pc.upper_probability>=mc.pc.probability,"SDMC interval contains estimate");
    o.seed=174;auto different=pc_monte_carlo(e,o);check(mc.hits!=different.hits,"SDMC seed selects a different stream");
    // Static, centered, isotropic Gaussian sphere: Maxwell CDF, erf(a/sqrt2)
    // - sqrt(2/pi)*a*exp(-a^2/2), a=R/sigma; independent of time window.
    e.secondary[4]=0;e.combined_radius=0.1;double sphere_exact=std::erf(1/std::sqrt(2.0))-std::sqrt(2/pi)*std::exp(-0.5);
    auto static_mc=pc_monte_carlo(e,o);
    check(std::abs(static_mc.pc.probability-sphere_exact)<5*std::sqrt(sphere_exact*(1-sphere_exact)/o.samples),"low-speed SDMC Maxwell CDF");
    auto usage=assess_pc_usage(e);check(usage.violated&&usage.low_relative_speed,"zero relative speed explicitly flagged");
    e=straight();e.covariance_primary[21]=e.covariance_primary[28]=e.covariance_primary[35]=0.01;
    check(assess_pc_usage(e).reason.find("RELATIVE_VELOCITY_UNCERTAINTY")!=std::string::npos,"relative velocity uncertainty flagged");
    e=straight();e.covariance_primary[0]=-1e-8;
    check(assess_pc_usage(e).covariance_repaired,"NPD positional covariance repair reported");
}
void correlation_tests() {
    std::cout<<"CARA optional cross-correlation (upstream rtol 0.005)\n";
    for(const auto& row:csv("cara_correlation.csv")) {
        PcEncounter e;e.gravitational_parameter=0;size_t k=1;
        for(int i=0;i<6;++i)e.secondary[i]=std::stod(row[k++]);
        for(double& x:e.covariance_primary)x=std::stod(row[k++]);
        for(int i=0;i<3;++i)for(int j=0;j<3;++j)e.cross_covariance[i*6+j]=std::stod(row[k++]);
        e.combined_radius=std::stod(row[k++]);double expected=std::stod(row[k++]),rtol=std::stod(row[k++]);
        auto independent=Foster2D().compute(bplane(e));check(!assess_pc_usage(e).cross_correlation_applied,"cross-correlation off by default");
        e.apply_cross_correlation=true;auto corrected=Foster2D().compute(bplane(e));auto usage=assess_pc_usage(e);
        double error=std::abs(corrected.probability/expected-1);
        std::cout<<row[0]<<" expected="<<expected<<" corrected="<<corrected.probability<<" independent="<<independent.probability<<" relerr="<<error<<'\n';
        check(error<=rtol,row[0]+" CARA corrected Pc");
        check(usage.cross_correlation_applied&&usage.covariance_trace_change!=0,row[0]+" correction effect reported");
        check(corrected.probability!=independent.probability,row[0]+" explicit option changes Pc");
    }
}
void usage_tests() {
    std::cout<<"CARA usage examples (upstream codes: 100=inaccurate, 111=all indicators)\n";
    for(const auto& row:csv("cara_usage.csv")) {
        auto e=usage_case(row);auto u=assess_pc_usage(e);int code=std::stoi(row[86]);
        std::cout<<row[0]<<" upstream="<<code<<" flagged="<<u.violated<<" extended="<<u.extended<<" offset="<<u.offset<<" inaccurate="<<u.inaccurate<<" reason="<<u.reason<<'\n';
        if(code)check(u.violated,row[0]+" published usage violation flagged");
        else check(!u.violated,row[0]+" published acceptable example remains accepted");
    }
}
void nc2_hall_tests() {
    // Source: NASA CARA_PcMethod_Test_Conjunctions.xlsx Nc2D column.
    // Inertial km/km-s at each fixture's UTC epoch. Relative 1e-4 allows
    // independently computed Jacobian/time derivatives; it is stricter than
    // CARA MD2MinRefine's 1e-3 relative time-refinement stopping criterion.
    std::cout<<"CARA 2D-Nc Hall spreadsheet references (relative tolerance 1e-4)\n";double maximum=0;
    for(const auto& row:csv("cara_usage.csv")) {
        auto e=usage_case(row);auto actual=pc_2d_nc_hall(e);int code=std::stoi(row[86]);
        if(code==111){check(!actual.pc.converged&&actual.requires_monte_carlo,row[0]+" unresolved quadratic peak fails closed");continue;}
        double expected=std::stod(row[87]),error=std::abs(actual.expected_collisions/expected-1);maximum=std::max(maximum,error);
        std::cout<<row[0]<<" expected="<<expected<<" actual="<<actual.expected_collisions<<" relerr="<<error<<'\n';
        check(actual.pc.converged&&error<1e-4,row[0]+" published 2D-Nc Hall");
    }
    std::cout<<"CARA 2D-Nc Hall max relative error="<<maximum<<'\n';
}
void hall_tests() {
    std::cout<<"CARA Hall cases (upstream relative tolerance 0.001)\n";double max_error=0;
    for(const auto& row:csv("cara_hall.csv")) {
        auto e=usage_case(row);PcFallbackOptions options;options.time_start=std::stod(row[88]);options.time_end=std::stod(row[89]);
        options.angular_order=16;options.relative_tolerance=1e-4;
        auto actual=pc_3d_nc_hall(e,options);double expected=std::stod(row[86]),tolerance=std::stod(row[87]);
        double error=std::abs(actual.pc.probability/expected-1);max_error=std::max(max_error,error);
        std::cout<<row[0]<<" expected="<<expected<<" actual="<<actual.pc.probability<<" relerr="<<error<<" converged="<<actual.pc.converged<<std::endl;
        check(actual.pc.converged&&error<=tolerance,row[0]+" Hall reference");
    }
    std::cout<<"CARA Hall max relative error="<<max_error<<'\n';
}
}
int main(int argc,char** argv) {
    std::cout<<std::setprecision(12);
    if(argc>1&&std::string(argv[1])=="--hall")hall_tests();
    else{closed_form_tests();correlation_tests();usage_tests();nc2_hall_tests();}
    std::cout<<"Pc fallback tests: "<<passed<<" passed, "<<failed<<" failed\n";
    return failed?1:0;
}
