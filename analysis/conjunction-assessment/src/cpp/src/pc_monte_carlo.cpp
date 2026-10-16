#include "pc_fallback_internal.h"

namespace conjunction {
using namespace pc_detail;
namespace {
class NormalStream {
    std::uint64_t state_; bool spare_=false; double next_=0;
    double uniform() {
        std::uint64_t z=(state_+=0x9e3779b97f4a7c15ULL);
        z=(z^(z>>30))*0xbf58476d1ce4e5b9ULL;z=(z^(z>>27))*0x94d049bb133111ebULL;z^=z>>31;
        return (static_cast<double>(z>>11)+0.5)*0x1.0p-53;
    }
public:
    explicit NormalStream(std::uint64_t seed):state_(seed){}
    double normal() {
        if(spare_){spare_=false;return next_;}
        double radius=std::sqrt(-2*std::log(uniform())),angle=2*pi*uniform();
        next_=radius*std::sin(angle);spare_=true;return radius*std::cos(angle);
    }
};
bool distance_at(const V6& a,const V6& b,double t,double mu,double& d2,double& derivative) {
    V6 x{},y{};if(!propagate(a,t,mu,x)||!propagate(b,t,mu,y))return false;
    V3 r=sub(position(y),position(x)),v=sub(velocity(y),velocity(x));
    d2=dot(r,r);derivative=dot(r,v);return std::isfinite(d2);
}
bool collision(const V6& a,const V6& b,double lo,double hi,double radius,double mu,bool& valid) {
    valid=true;
    if(mu<=0) {
        V3 r=sub(position(b),position(a)),v=sub(velocity(b),velocity(a));
        double vv=dot(v,v),t=vv>0?std::clamp(-dot(r,v)/vv,lo,hi):lo;
        for(int i=0;i<3;++i)r[i]+=t*v[i];return dot(r,r)<=radius*radius;
    }
    // Resolve the pericenter timescale, not just the orbital period. A
    // highly eccentric orbit can traverse pericenter far faster than T/64.
    auto pericenter_time=[&](const V6& x) {
        V3 r=position(x),v=velocity(x);double rr=norm(r),vv=dot(v,v),rv=dot(r,v);
        double h2=rr*rr*vv-rv*rv,energy=vv/2-mu/rr;
        double ecc=std::sqrt(std::max(0.0,1+2*energy*h2/(mu*mu)));
        double rp=h2/(mu*(1+ecc));return std::sqrt(rp*rp*rp/mu);
    };
    double step=0.1*std::min(pericenter_time(a),pericenter_time(b));
    double needed=std::ceil((hi-lo)/step);
    if(!(step>0)||!std::isfinite(needed)||needed>4096){valid=false;return false;}
    unsigned intervals=std::max(16u,static_cast<unsigned>(needed));
    double d=0,g=0;if(!distance_at(a,b,lo,mu,d,g)){valid=false;return false;}
    if(d<=radius*radius)return true;
    double prev_t=lo,prev_g=g;
    for(unsigned i=1;i<=intervals;++i) {
        double t=lo+(hi-lo)*i/intervals;
        if(!distance_at(a,b,t,mu,d,g)){valid=false;return false;}
        if(d<=radius*radius)return true;
        if(prev_g<0&&g>=0) {
            double left=prev_t,right=t;
            // Root of r.v brackets every resolved local minimum; bisection
            // remains valid when nominal relative speed approaches zero.
            for(int k=0;k<48;++k) {
                double mid=(left+right)/2,dm=0,gm=0;
                if(!distance_at(a,b,mid,mu,dm,gm)){valid=false;return false;}
                if(dm<=radius*radius)return true;
                if(gm<0)left=mid;else right=mid;
                if(right-left<1e-8)break;
            }
        }
        prev_t=t;prev_g=g;
    }
    return false;
}
}

PcFallbackResult pc_monte_carlo(const PcEncounter& e,const PcFallbackOptions& options) {
    PcFallbackResult result;
    result.pc.method=options.two_body&&e.gravitational_parameter>0?"SDMC-TWO-BODY":"SDMC-RECTILINEAR";
    if(!options.include_initial_overlap)result.pc.method+="-ENTRY-ONLY";
    if(!valid_encounter(e,options)){result.pc.converged=false;result.invalid_inputs=true;result.limitation="Invalid Monte Carlo inputs.";return result;}
    result.usage=assess_pc_usage(e);
    auto bounds=time_bounds(e,options,result.usage);result.time_start=bounds.first;result.time_end=bounds.second;
    result.limitation="Finite-window Monte Carlo; probability resolution and 95% Wilson interval depend on sample count.";
    if(!e.has_velocity_covariance)result.limitation+=" Velocity covariance unavailable; supplied position uncertainty only.";
    std::array<double,144> joint{},vectors{};std::array<double,12> values{};
    for(int i=0;i<6;++i)for(int j=0;j<6;++j) {
        joint[i*12+j]=e.covariance_primary[i*6+j];joint[(i+6)*12+j+6]=e.covariance_secondary[i*6+j];
        if(e.apply_cross_correlation){joint[i*12+j+6]=e.cross_covariance[i*6+j];joint[(j+6)*12+i]=e.cross_covariance[i*6+j];}
    }
    if(!eigen<12>(joint,values,vectors)||!(e.combined_radius>0)||options.samples==0||!(bounds.second>bounds.first)) {
        result.pc.converged=false;result.invalid_inputs=true;result.limitation="Invalid Monte Carlo inputs.";return result;
    }
    double largest=0;for(double v:values)largest=std::max(largest,v);
    for(int k=0;k<12;++k) {
        if(values[k]<-1e-12*largest)result.covariance_repaired=true;
        double sigma=std::sqrt(std::max(0.0,values[k]));
        for(int i=0;i<12;++i)vectors[i*12+k]*=sigma;
    }
    NormalStream random(options.seed);result.samples=options.samples;
    double mu=options.two_body?e.gravitational_parameter:0;
    for(std::uint64_t k=0;k<options.samples;++k) {
        std::array<double,12> z{},delta{};for(double& value:z)value=random.normal();
        for(int i=0;i<12;++i)for(int j=0;j<12;++j)delta[i]+=vectors[i*12+j]*z[j];
        V6 a=e.primary,b=e.secondary;
        for(int i=0;i<6;++i){a[i]+=delta[i];b[i]+=delta[i+6];}
        bool valid=false;double start_distance=0,start_derivative=0;
        if(!distance_at(a,b,bounds.first,mu,start_distance,start_derivative)){
            result.pc.converged=false;result.limitation="A sampled initial state failed to propagate.";return result;
        }
        if(start_distance<=e.combined_radius*e.combined_radius){
            ++result.initial_hits;valid=true;if(options.include_initial_overlap)++result.hits;
        } else if(collision(a,b,bounds.first,bounds.second,e.combined_radius,mu,valid)){
            ++result.entry_hits;++result.hits;
        }
        if(!valid){result.pc.converged=false;result.limitation="A sampled trajectory failed to propagate; Pc is unavailable.";return result;}
    }
    double n=static_cast<double>(result.samples),p=static_cast<double>(result.hits)/n;
    constexpr double z=1.959963984540054;double z2=z*z,den=1+z2/n;
    double center=(p+z2/(2*n))/den,half=z*std::sqrt(p*(1-p)/n+z2/(4*n*n))/den;
    result.pc.probability=p;result.pc.lower_probability=std::max(0.0,center-half);
    result.pc.upper_probability=std::min(1.0,center+half);result.pc.iterations=static_cast<int>(std::min<std::uint64_t>(result.samples,2147483647));
    return result;
}
} // namespace conjunction
