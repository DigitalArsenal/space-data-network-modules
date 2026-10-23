#include "od/operator_fit.h"
#include "od/frame_transform.h"
#include "od/covariance_validation.h"
#include "ffm/resident_dynamics.h"
#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
#include <ctime>
#include <limits>

namespace od {
namespace {
using V7=Eigen::Matrix<double,7,1>;
using M7=Eigen::Matrix<double,7,7>;
const V7 scale=(V7()<<1,1,1,.001,.001,.001,.01).finished();
struct Sample { EphemerisPoint source; astro::StateVector state; ffm::TTEpoch tt; };

bool samples(const StateSeries& series, std::vector<Sample>& out, std::string& error) {
    for (const auto& p:series.samples) {
        if (!std::isfinite(p.epoch_jd) || (!out.empty() && p.epoch_jd<=out.back().source.epoch_jd)) {
            error="invalid-samples: finite, strictly increasing UTC epochs required";return false;
        }
        Sample s; s.source=p;
        const double sec=(p.epoch_jd-2451545.0)*86400;
        if (!ffm::toTT(std::floor(sec),sec-std::floor(sec),p.epoch_jd,timingStandard::UTC,s.tt,error))return false;
        // Undo the parser's documented J2000->TEME rotation. GCRF input uses
        // that same parser rotation but requires no EME2000 frame bias.
        const auto a=eci_j2000_to_teme_matrix(p.epoch_jd);
        double r[3]{},v[3]{},bias[3][3],precession[3][3],combined[3][3];
        const double pr[3]={p.x,p.y,p.z},pv[3]={p.vx,p.vy,p.vz};
        for(int i=0;i<3;++i)for(int j=0;j<3;++j){r[i]+=a[j][i]*pr[j];v[i]+=a[j][i]*pv[j];}
        eraBp00(2451545.,0,bias,precession,combined);
        double g[3]{},w[3]{};
        const bool gcrf=series.meta.source_frame=="GCRF";
        for(int i=0;i<3;++i)for(int j=0;j<3;++j){const double b=gcrf?double(i==j):bias[j][i];g[i]+=b*r[j];w[i]+=b*v[j];}
        for(double x:g)if(!std::isfinite(x)){error="invalid-state";return false;}
        for(double x:w)if(!std::isfinite(x)){error="invalid-state";return false;}
        s.state.position={g[0],g[1],g[2]};s.state.velocity={w[0],w[1],w[2]};s.state.epoch=p.epoch_jd;
        out.push_back(s);
    }
    return true;
}
V7 parameters(const Sample& s,double b) {
    return (V7()<<s.state.position.x,s.state.position.y,s.state.position.z,
        s.state.velocity.x,s.state.velocity.y,s.state.velocity.z,b).finished();
}
astro::StateVector state(const V7& p,double epoch) {
    astro::StateVector s;s.position={p[0],p[1],p[2]};s.velocity={p[3],p[4],p[5]};s.epoch=epoch;return s;
}
bool evaluate(ffm::ResidentDynamics& model,const std::vector<Sample>& rows,const V7& p,double srp,
              Eigen::VectorXd& residual,std::string& error) {
    model.clearObjects();
    if(!model.addCatalogState(state(p,rows.front().source.epoch_jd),p[6],srp,true,error))return false;
    residual.resize(rows.size()*3);
    for(size_t i=0;i<rows.size();++i){
        astro::StateVector s;if(!model.state(0,rows[i].tt,s,error))return false;
        residual.segment<3>(3*i)<<rows[i].state.position.x-s.position.x,
            rows[i].state.position.y-s.position.y,rows[i].state.position.z-s.position.z;
    }
    return residual.allFinite();
}
// The operator covariance is kept independently of the formal fit covariance.
// UVW is inertial RTN, the same convention as gp-error-model source_covariance.
void source_covariance(const Sample& s, OperatorSegment& result) {
    if(!s.source.has_covariance || !publishable_covariance(s.source.covariance))return;
    namespace ax=sdn::frames;
    ax::Mat3 axes;
    const auto& p=s.state.position;const auto& v=s.state.velocity;
    if(!ax::triadFromPrimarySecondary({p.x,p.y,p.z},{v.x,v.y,v.z},&axes))return;
    const auto r=ax::transpose(axes);
    Eigen::Matrix<double,6,6> rotation=Eigen::Matrix<double,6,6>::Zero(),cov;
    for(int i=0;i<3;++i)for(int j=0;j<3;++j)rotation(i,j)=rotation(i+3,j+3)=r.m[i][j];
    for(int i=0,k=0;i<6;++i)for(int j=0;j<=i;++j)cov(i,j)=cov(j,i)=s.source.covariance[k++];
    cov=(rotation*cov*rotation.transpose()).eval();
    for(int i=0,k=0;i<6;++i)for(int j=0;j<=i;++j)result.operator_covariance[k++]=cov(i,j);
    result.has_operator_covariance=publishable_covariance(result.operator_covariance.data());
}
bool fit(ffm::ResidentDynamics& model,const std::vector<Sample>& rows,const OperatorFitOptions& opt,
         OperatorSegment& result,std::string& error) {
    const auto begin=std::clock();
    V7 p=parameters(rows.front(),opt.ballistic_seed);
    if(opt.warm_start)for(int i=0;i<6;++i)p[i]=opt.warm_state[i];
    Eigen::VectorXd residual;
    if(!evaluate(model,rows,p,opt.srp_area_mass,residual,error))return false;
    double lambda=1e-3;
    Eigen::MatrixXd j(residual.size(),7);
    auto jacobian=[&](){
        for(int k=0;k<7;++k){
            V7 q=p;const double step=scale[k]*.001;q[k]+=step;
            Eigen::VectorXd shifted;if(!evaluate(model,rows,q,opt.srp_area_mass,shifted,error))return false;
            j.col(k)=(residual-shifted)/.001;
        }
        return j.allFinite();
    };
    for(int it=0;it<opt.max_iterations;++it){
        ++result.iterations;
        if(!jacobian())return false;
        const M7 normal=j.transpose()*j;
        M7 damped=normal;
        for(int k=0;k<7;++k)damped(k,k)+=lambda*std::max(normal(k,k),1e-20);
        const V7 delta=damped.ldlt().solve(j.transpose()*residual);
        if(!delta.allFinite()){error="singular-fit";return false;}
        V7 next=p+delta.cwiseProduct(scale);
        next[6]=std::max(0.,next[6]); // FFM's nonnegative net-drag contract
        Eigen::VectorXd candidate;
        if(!evaluate(model,rows,next,opt.srp_area_mass,candidate,error))return false;
        const double before=residual.squaredNorm(),after=candidate.squaredNorm();
        if(after<before){
            p=next;residual=std::move(candidate);lambda=std::max(1e-12,lambda*.2);
            if((before-after)/std::max(before,1e-30)<1e-7 || delta.norm()<1e-7){result.converged=true;break;}
        }else{lambda*=10;if(lambda>1e10)break;}
    }
    if(!jacobian())return false;
    Eigen::JacobiSVD<Eigen::MatrixXd> svd(j,Eigen::ComputeThinV);
    const auto singular=svd.singularValues();
    if(singular[6]>singular[0]*1e-10 && residual.size()>7 && p[6]>0){
        const M7 cov=scale.asDiagonal()*svd.matrixV()*singular.array().square().inverse().matrix().asDiagonal()*
            svd.matrixV().transpose()*scale.asDiagonal()*(residual.squaredNorm()/(residual.size()-7));
        for(int i=0,k=0;i<6;++i)for(int q=0;q<=i;++q)result.formal_covariance[k++]=cov(i,q);
        result.has_formal_covariance=publishable_covariance(result.formal_covariance.data());
    }
    for(int k=0;k<6;++k)result.state[k]=p[k];
    result.ballistic=p[6];result.rms_km=std::sqrt(residual.squaredNorm()/rows.size());
    for(size_t i=0;i<rows.size();++i){const double r=residual.segment<3>(3*i).norm();result.residuals_km.push_back(r);result.maximum_km=std::max(result.maximum_km,r);}
    source_covariance(rows.front(),result);
    result.cpu_seconds=double(std::clock()-begin)/CLOCKS_PER_SEC;
    return true;
}
}
OperatorFitResult fit_operator(const StateSeries& input,const OperatorEnvironment& env,const OperatorFitOptions& opt) {
    OperatorFitResult out;
    if(!(opt.end_seconds>0) || opt.end_seconds>172800){out.error="blend-join: fitting across the 48-hour join is refused";return out;}
    if(!(opt.sample_seconds>0 && opt.sample_seconds<=600) || !(opt.ballistic_seed>=0) || !(opt.srp_area_mass>=0) ||
       opt.max_iterations<1 || opt.max_iterations>100 || !(opt.maneuver_velocity_km_s>0) || !(opt.maneuver_position_km>0)) {
        out.error="invalid-fit-options";return out;
    }
    if(input.meta.position_only || (input.meta.source_frame!="EME2000" && input.meta.source_frame!="J2000" && input.meta.source_frame!="GCRF")) {
        out.error="unsupported-frame: operator FFM requires full EME2000/J2000/GCRF states";return out;
    }
    if(input.samples.size()<8){out.error="insufficient-samples";return out;}
    StateSeries selected;selected.meta=input.meta;
    const double first=input.samples.front().epoch_jd;
    for(const auto& p:input.samples){
        const double t=(p.epoch_jd-first)*86400;
        // The sample AT 48 h belongs to the second forecast, so it is excluded.
        if(t>=opt.end_seconds-1e-4)break;
        if(selected.samples.empty() || (p.epoch_jd-selected.samples.back().epoch_jd)*86400>=opt.sample_seconds-1e-4)selected.samples.push_back(p);
    }
    std::vector<Sample> rows;if(!samples(selected,rows,out.error))return out;
    if(rows.size()<8){out.error="insufficient-samples";return out;}
    ffm::ResidentDynamics::Inputs in;in.configuration=env.configuration.data;in.configurationSize=env.configuration.size;
    in.kernel=env.kernel.data;in.kernelSize=env.kernel.size;
    in.environment.earthOrientation=env.earth_orientation.data;in.environment.earthOrientationSize=env.earth_orientation.size;
    in.environment.spaceWeather=env.space_weather.data;in.environment.spaceWeatherSize=env.space_weather.size;
    in.environment.densityCorrection=env.density_correction.data;in.environment.densityCorrectionSize=env.density_correction.size;
    auto model=ffm::ResidentDynamics::configure(in,ffm::instanceKernels(),out.error);if(!model)return out;
    std::vector<size_t> boundaries{0};
    // One-step prediction from each observed state localizes a discontinuity;
    // no long-arc fitted bias can smear a burn across the window.
    for(size_t i=1;i<rows.size();++i){
        model->clearObjects();
        if(!model->addCatalogState(rows[i-1].state,opt.ballistic_seed,opt.srp_area_mass,true,out.error))return out;
        astro::StateVector predicted;if(!model->state(0,rows[i].tt,predicted,out.error))return out;
        const double dp=(predicted.position-rows[i].state.position).magnitude(),dv=(predicted.velocity-rows[i].state.velocity).magnitude();
        if(dp>opt.maneuver_position_km || dv>opt.maneuver_velocity_km_s){
            out.maneuvers.push_back({rows[i-1].source.epoch_jd,rows[i].source.epoch_jd,dp,dv});boundaries.push_back(i);
        }
    }
    boundaries.push_back(rows.size());
    for(size_t k=1;k<boundaries.size();++k){
        const size_t lo=boundaries[k-1],hi=boundaries[k];
        if(hi-lo<8){out.error="maneuver-segment-too-short: fewer than eight samples";out.segments.clear();return out;}
        std::vector<Sample> arc(rows.begin()+lo,rows.begin()+hi);
        OperatorSegment result;result.source.meta=input.meta;
        for(const auto& s:arc)result.source.samples.push_back(s.source);
        auto options=opt;if(k>1)options.warm_start=false;
        if(!fit(*model,arc,options,result,out.error)){out.segments.clear();return out;}
        out.segments.push_back(std::move(result));
    }
    return out;
}
}
