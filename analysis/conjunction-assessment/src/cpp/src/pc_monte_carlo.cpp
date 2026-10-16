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
struct SamplePoint {
    V3 relative{},relative_velocity{};
    double distance_squared=0,derivative=0;
};
bool distance_at(const V6& a,const V6& b,double t,double mu,SamplePoint& point) {
    V6 x{},y{};if(!propagate(a,t,mu,x)||!propagate(b,t,mu,y))return false;
    V3 r=sub(position(y),position(x)),v=sub(velocity(y),velocity(x));
    point.relative=r;point.relative_velocity=v;point.distance_squared=dot(r,r);point.derivative=dot(r,v);
    return std::isfinite(point.distance_squared);
}
double acceleration_bound(const V6& state,double mu) {
    // Two-body acceleration never exceeds mu/rp^2. The pericenter follows
    // from angular momentum h and specific energy E:
    // rp=h^2/(mu+sqrt(mu^2+2 E h^2)), for bound and unbound orbits alike.
    // Round h^2 down and E up (with arithmetic error allowances), so rp is
    // a lower bound. A degenerate/nonfinite bound disables the optimization.
    constexpr double eps=std::numeric_limits<double>::epsilon();
    const V3 r=position(state),v=velocity(state);
    const double radius=norm(r),v2=dot(v,v);
    if(!(radius>0)||!std::isfinite(radius)||!std::isfinite(v2))return std::numeric_limits<double>::infinity();
    double h2=0;
    for(int i=0;i<3;++i) {
        const int j=(i+1)%3,k=(i+2)%3;
        const double a=r[j]*v[k],b=r[k]*v[j];
        if(!std::isfinite(a)||!std::isfinite(b)||!std::isfinite(std::abs(a)+std::abs(b)))
            return std::numeric_limits<double>::infinity();
        const double h=std::max(0.0,std::abs(a-b)-8*eps*(std::abs(a)+std::abs(b)));
        h2+=h*h;
    }
    h2*=1-16*eps;
    if(!(h2>0)||!std::isfinite(h2))return std::numeric_limits<double>::infinity();
    const double kinetic=0.5*v2*(1+16*eps),potential=mu/(radius*(1+16*eps));
    const double energy=kinetic-potential+16*eps*(kinetic+potential);
    const double term=2*energy*h2;
    const double discriminant=mu*mu+term+32*eps*(mu*mu+std::abs(term));
    if(!std::isfinite(energy)||!std::isfinite(term)||!std::isfinite(discriminant))
        return std::numeric_limits<double>::infinity();
    const double rp=h2/(mu+std::sqrt(std::max(0.0,discriminant)))*(1-32*eps);
    const double bound=mu/(rp*rp)*(1+32*eps);
    return rp>0&&std::isfinite(rp)&&bound>0&&std::isfinite(bound)?bound:std::numeric_limits<double>::infinity();
}
double linear_minimum(const V3& position,const V3& velocity,double lo,double hi) {
    const double vv=dot(velocity,velocity),rv=dot(position,velocity);
    if(!std::isfinite(vv)||!std::isfinite(rv))return std::numeric_limits<double>::quiet_NaN();
    if(vv==0&&(velocity[0]!=0||velocity[1]!=0||velocity[2]!=0))
        return std::numeric_limits<double>::quiet_NaN();
    const double t=vv>0?std::clamp(-rv/vv,lo,hi):lo;
    V3 nearest=position;for(int i=0;i<3;++i)nearest[i]+=t*velocity[i];
    return norm(nearest);
}
bool chord_excludes_collision(const SamplePoint& a,const SamplePoint& b,double duration,
    double acceleration,double radius,double roundoff) {
    // For any twice-differentiable relative trajectory with |r''|<=A, its
    // departure from the endpoint chord is at most A*duration^2/8. A chord
    // farther than that plus the HBR cannot contain an unobserved collision.
    const double distance=linear_minimum(a.relative,sub(b.relative,a.relative),0,1);
    const double clearance=radius+acceleration*duration*duration/8+roundoff;
    return std::isfinite(distance)&&std::isfinite(clearance)&&distance>clearance;
}
double relative_gravity_bound(const V3& relative,const V3& speed,double extent,
    double mu,double acceleration_a,double acceleration_b,double roundoff) {
    // Each orbital radius is at least its pericenter, bounded below by
    // sqrt(mu / acceleration_bound). While separation D is below that lower
    // radial bound r, a segment joining bodies separated by at most D stays
    // outside r-D/2. Gravity's Jacobian norm is at most L=2*mu/(r-D/2)^3.
    // Gronwall gives separation <= d*cosh(sqrt(L)*T)+v*sinh(sqrt(L)*T)/sqrt(L).
    // A bound below the assumed separation cap establishes that premise by
    // continuity over the full interval. For short times the cheaper bound
    // (d+v*T)/(1-L*T^2/2) suffices. Return a bound on relative acceleration;
    // unresolved samples still use the original full Kepler search.
    constexpr double eps=std::numeric_limits<double>::epsilon();
    const double unavailable=std::numeric_limits<double>::infinity();
    const double largest_acceleration=std::max(acceleration_a,acceleration_b);
    if(!(largest_acceleration>0)||!std::isfinite(largest_acceleration))return unavailable;
    const double radial=std::sqrt(mu/largest_acceleration)*(1-64*eps);
    if(!(radial>0)||!std::isfinite(radial)||!(extent>0)||!std::isfinite(extent))return unavailable;
    const double distance=norm(relative)+roundoff,velocity=norm(speed);
    const double linear_extent=(distance+velocity*extent)*(1+64*eps);
    for(double fraction:{1.0/64,1.0/16,1.0/4,1.0}) {
        const double cap=radial*fraction,segment_radius=radial-cap/2;
        if(!(linear_extent<cap))continue;
        const double rate=2*mu/(segment_radius*segment_radius*segment_radius)*(1+128*eps);
        const double q=0.5*rate*extent*extent*(1+16*eps);
        if(!(rate>0)||!std::isfinite(rate)||!(q>0)||!std::isfinite(q))continue;
        double separation;
        if(q<.25)separation=linear_extent/(1-q)*(1+64*eps);
        else {
            const double argument=std::sqrt(rate)*extent*(1+32*eps);
            if(!(argument>0)||argument>700)continue;
            separation=(distance*std::cosh(argument)+velocity*extent*std::sinh(argument)/argument)*(1+512*eps);
        }
        if(!std::isfinite(separation)||!(separation<cap))continue;
        const double bound=rate*separation*(1+128*eps);
        if(bound>0&&std::isfinite(bound))return bound;
    }
    return unavailable;
}
bool collision(const V6& a,const V6& b,double lo,double hi,double radius,double mu,
    const SamplePoint& start,double acceleration,double acceleration_a,double acceleration_b,
    double roundoff,bool screening,bool& valid) {
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
    if(start.distance_squared<=radius*radius)return true;
    double prev_t=lo;SamplePoint previous=start;
    unsigned next_jump=intervals;
    for(unsigned i=1;i<=intervals;++i) {
        bool certified=false;
        if(screening) {
            // Jump only across certified collision-free spans and land on
            // the original subdivision grid. If a span is not certified,
            // keep the original one-interval derivative/minimum search.
            // Pericenter bounds remain valid at every propagated endpoint.
            unsigned accepted_jump=1;
            for(unsigned jump=std::min(next_jump,intervals-i+1);jump>1;jump/=2) {
                const unsigned endpoint=i+jump-1;
                const double end=lo+(hi-lo)*endpoint/intervals,span=end-prev_t;
                const double local_acceleration=std::min(acceleration,relative_gravity_bound(
                    previous.relative,previous.relative_velocity,span,mu,acceleration_a,acceleration_b,roundoff));
                const double clearance=radius+0.5*local_acceleration*span*span+roundoff;
                const double distance=linear_minimum(previous.relative,previous.relative_velocity,0,span);
                if(std::isfinite(distance)&&std::isfinite(clearance)&&distance>clearance) {
                    i=endpoint;accepted_jump=jump;certified=true;break;
                }
            }
            // Grow gradually after a successful certificate rather than
            // repeatedly retrying the same unresolved long observation span.
            next_jump=std::min(intervals,2*accepted_jump);
        }
        double t=lo+(hi-lo)*i/intervals;
        SamplePoint point;
        if(!distance_at(a,b,t,mu,point)){valid=false;return false;}
        if(point.distance_squared<=radius*radius)return true;
        if(!certified&&previous.derivative<0&&point.derivative>=0) {
            double left=prev_t,right=t;
            SamplePoint left_point=previous,right_point=point;
            // Root of r.v brackets every resolved local minimum; bisection
            // remains valid when nominal relative speed approaches zero.
            for(int k=0;k<48;++k) {
                if(chord_excludes_collision(left_point,right_point,right-left,acceleration,radius,roundoff))break;
                double mid=(left+right)/2;SamplePoint middle;
                if(!distance_at(a,b,mid,mu,middle)){valid=false;return false;}
                if(middle.distance_squared<=radius*radius)return true;
                if(middle.derivative<0){left=mid;left_point=middle;}
                else {right=mid;right_point=middle;}
                if(right-left<1e-8)break;
            }
        }
        prev_t=t;previous=point;
    }
    return false;
}
}

PcFallbackResult pc_monte_carlo(const PcEncounter& e,const PcFallbackOptions& options,const PcUsageResult* usage) {
    PcFallbackResult result;
    result.pc.method=options.two_body&&e.gravitational_parameter>0?"SDMC-TWO-BODY":"SDMC-RECTILINEAR";
    if(!options.include_initial_overlap)result.pc.method+="-ENTRY-ONLY";
    if(!valid_encounter(e,options)){result.pc.converged=false;result.invalid_inputs=true;result.limitation="Invalid Monte Carlo inputs.";return result;}
    result.usage=usage?*usage:assess_pc_usage(e);
    auto bounds=time_bounds(e,options,result.usage);result.time_start=bounds.first;result.time_end=bounds.second;
    result.limitation="Finite-window Monte Carlo; probability resolution and 95% Wilson interval depend on sample count.";
    const bool screening=options.grade==PcGrade::Screening;
    if(screening)result.limitation+=" Screening grade: deterministic adaptive sampling, minimum="+
        std::to_string(std::min(options.minimum_samples,options.samples))+", target_hits="+
        std::to_string(options.target_hits)+", sample_cap="+std::to_string(options.samples)+".";
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
        if(screening&&options.target_hits>0&&k>=options.minimum_samples&&result.hits>=options.target_hits) {
            result.samples=k;break;
        }
        std::array<double,12> z{},delta{};for(double& value:z)value=random.normal();
        for(int i=0;i<12;++i)for(int j=0;j<12;++j)delta[i]+=vectors[i*12+j]*z[j];
        V6 a=e.primary,b=e.secondary;
        for(int i=0;i<6;++i){a[i]+=delta[i];b[i]+=delta[i+6];}
        double acceleration=0,acceleration_a=0,acceleration_b=0,roundoff=0;
        if(mu>0) {
            acceleration_a=acceleration_bound(a,mu);acceleration_b=acceleration_bound(b,mu);
            acceleration=(acceleration_a+acceleration_b)*(1+16*std::numeric_limits<double>::epsilon());
            const double extent=std::max(std::abs(bounds.first),std::abs(bounds.second));
            // Keep marginal cases on the original propagation path, with a
            // conservative guard for state subtraction and Kepler roundoff.
            roundoff=1e-9+1e-10*(norm(position(a))+norm(position(b))+
                extent*(norm(velocity(a))+norm(velocity(b))));
            // Integrating the same acceleration bound twice gives
            // |r(t)-(r0+v0*t)| <= A*t^2/2. This rejects complete sampled
            // trajectories, including initial overlap, without changing the
            // random stream, sample budget, or any collision threshold.
            const double distance=linear_minimum(sub(position(b),position(a)),sub(velocity(b),velocity(a)),bounds.first,bounds.second);
            const double clearance=e.combined_radius+0.5*acceleration*extent*extent+roundoff;
            if(std::isfinite(distance)&&std::isfinite(clearance)&&distance>clearance)continue;
            if(screening) {
                acceleration=std::min(acceleration,relative_gravity_bound(sub(position(b),position(a)),sub(velocity(b),velocity(a)),extent,
                    mu,acceleration_a,acceleration_b,roundoff));
                const double tighter_clearance=e.combined_radius+0.5*acceleration*extent*extent+roundoff;
                if(std::isfinite(distance)&&std::isfinite(tighter_clearance)&&distance>tighter_clearance)continue;
            }
        }
        bool valid=false;SamplePoint start;
        if(!distance_at(a,b,bounds.first,mu,start)){
            result.pc.converged=false;result.limitation="A sampled initial state failed to propagate.";return result;
        }
        if(start.distance_squared<=e.combined_radius*e.combined_radius){
            ++result.initial_hits;valid=true;if(options.include_initial_overlap)++result.hits;
        } else if(collision(a,b,bounds.first,bounds.second,e.combined_radius,mu,start,acceleration,
            acceleration_a,acceleration_b,roundoff,screening,valid)){
            ++result.entry_hits;++result.hits;
        }
        if(!valid){result.pc.converged=false;result.limitation="A sampled trajectory failed to propagate; Pc is unavailable.";return result;}
    }
    double n=static_cast<double>(result.samples),p=static_cast<double>(result.hits)/n;
    constexpr double z=1.959963984540054;double z2=z*z,den=1+z2/n;
    double center=(p+z2/(2*n))/den,half=z*std::sqrt(p*(1-p)/n+z2/(4*n*n))/den;
    result.pc.probability=p;result.pc.lower_probability=std::max(0.0,center-half);
    result.pc.upper_probability=std::min(1.0,center+half);
    // Wilson's zero/all-hit endpoints are exactly 0/1. Non-power-of-two
    // adaptive counts can otherwise leave a tiny cancellation residual.
    // Preserve the Reference arithmetic and expose the exact Screening bounds.
    if(screening) {
        if(result.hits==0)result.pc.lower_probability=0;
        if(result.hits==result.samples)result.pc.upper_probability=1;
    }
    result.pc.iterations=static_cast<int>(std::min<std::uint64_t>(result.samples,2147483647));
    return result;
}
} // namespace conjunction
