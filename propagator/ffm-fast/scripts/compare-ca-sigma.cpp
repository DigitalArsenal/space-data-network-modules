// Independent acceptance reduction, not a propagation path.
// Reference: the checked-in E14 S3-KC empirical SGP4 prediction-error model.
// Its position covariance is RTN, km^2, stratified by un-Kozai mean altitude,
// eccentricity and prediction age. It is an uncertainty scale for the GP
// inputs, not a calibration claim for FFM. Missing strata fail closed.
// Weyl's inequality: lambda_min(C1+C2) >= lambda_min(C1)+lambda_min(C2),
// irrespective of the two RTN orientations. Normalize both miss change and
// relative-speed * TCA change by this conservative combined 1-sigma bound.
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
using nlohmann::json;
constexpr double pi = 3.14159265358979323846;
double altitude(const json& g) {
    // Same WGS-72 un-Kozai definition as CA::empiricalStratum.
    constexpr double re=6378.135, mu=398600.8, j2=0.001082616;
    const double xke=60/std::sqrt(re*re*re/mu), n=g.at("meanMotion").get<double>()*2*pi/1440;
    const double e=g.at("eccentricity"), c=std::cos(g.at("inclination").get<double>()*pi/180), b=1-e*e;
    if (!(n>0 && b>0)) throw std::runtime_error("invalid mean elements");
    const double ak=std::pow(xke/n,2.0/3), d1=.75*j2*(3*c*c-1)/(std::sqrt(b)*b), del=d1/(ak*ak);
    const double ad=ak*(1-del*del-del*(1.0/3+134*del*del/81));
    return std::pow(xke/(n/(1+d1/(ad*ad))),2.0/3)*re-re;
}
double minimumVariance(const json& packed) {
    double a[3][3]={{packed[0],packed[1],packed[3]}, {packed[1],packed[2],packed[4]}, {packed[3],packed[4],packed[5]}};
    // Symmetric Jacobi rotations; preserve all position cross-correlations.
    for (int k=0;k<64;++k) {
        int p=0,q=1;
        for (int i=0;i<3;++i) for (int j=i+1;j<3;++j) if (std::abs(a[i][j])>std::abs(a[p][q])) {p=i;q=j;}
        if (std::abs(a[p][q])<=1e-15*std::max({std::abs(a[0][0]),std::abs(a[1][1]),std::abs(a[2][2])})) break;
        const double angle=.5*std::atan2(2*a[p][q],a[q][q]-a[p][p]), c=std::cos(angle),s=std::sin(angle);
        const double pp=c*c*a[p][p]-2*s*c*a[p][q]+s*s*a[q][q], qq=s*s*a[p][p]+2*s*c*a[p][q]+c*c*a[q][q];
        for(int j=0;j<3;++j) if(j!=p && j!=q) {const double x=a[p][j],y=a[q][j]; a[p][j]=a[j][p]=c*x-s*y;a[q][j]=a[j][q]=s*x+c*y;}
        a[p][p]=pp;a[q][q]=qq;a[p][q]=a[q][p]=0;
    }
    const double minimum=std::min({a[0][0],a[1][1],a[2][2]});
    if (!(minimum>0 && std::isfinite(minimum))) throw std::runtime_error("nonpositive model covariance");
    return minimum;
}
double variance(const json& model,const json& object,double tca) {
    const double alt=altitude(object), e=object.at("eccentricity"), age=tca-object.at("epochJd").get<double>();
    int r=-1,a=-1;
    for (int i=0;i<int(model.at("regimes").size());++i) {const auto& q=model["regimes"][i];if(alt>=q["altitudeKm"][0] && alt<q["altitudeKm"][1] && e>=q["eccentricity"][0] && e<q["eccentricity"][1]){r=i;break;}}
    for (int i=0;i<int(model.at("ageBinsDays").size());++i){const auto& q=model["ageBinsDays"][i];if(age>=q[0] && (age<q[1] || (i+1==int(model["ageBinsDays"].size()) && age==q[1]))){a=i;break;}}
    for(const auto& q:model.at("strata")) if(q.at("regimeIndex")==r && q.at("ageIndex")==a) return minimumVariance(q.at("covariance"));
    throw std::runtime_error("E14 has no matching regime/age covariance");
}
int main(){try{
    json input;std::cin>>input; double miss=0,tca=0,minSigma=1e300;int covered=0;json missing=json::array();
    for(const auto& item:input.at("pairs")){try{
        const auto& a=item.at("standard");const auto& b=item.at("fast");const double at=a.at("tcaJd");
        const double sigma=1000*std::sqrt(variance(input["model"],item["primary"],at)+variance(input["model"],item["secondary"],at));
        minSigma=std::min(minSigma,sigma);miss=std::max(miss,std::abs(a.at("missM").get<double>()-b.at("missM").get<double>())/sigma);
        tca=std::max(tca,std::abs(at-b.at("tcaJd").get<double>())*86400*std::max(a.at("speedMS").get<double>(),b.at("speedMS").get<double>())/sigma);++covered;
    }catch(const std::exception& e){missing.push_back({{"pair",item.at("key")},{"reason",e.what()}});}}
    const bool pass=covered>0 && missing.empty() && miss<=.01 && tca<=.01;
    std::cout<<json{{"pass",pass},{"eventsCovered",covered},{"missing",missing},{"minimumCombinedSigmaMeters",covered?minSigma:0},{"maximumMissSigmaFraction",miss},{"maximumTcaDisplacementSigmaFraction",tca},{"limit",.01},{"modelId",input.at("model").at("id")}}.dump()<<'\n';
    return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
