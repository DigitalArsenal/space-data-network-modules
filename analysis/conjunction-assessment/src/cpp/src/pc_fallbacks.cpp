#include "pc_fallback_internal.h"
#include "pc_hall.h"
#include <vector>
#include <functional>
#include <map>
#include <set>

namespace conjunction {
using namespace pc_detail;
namespace {
struct SurfacePoint {V3 normal;double weight;};
std::vector<SurfacePoint> canonical_sphere(unsigned order) {
    std::vector<SurfacePoint> out;out.reserve(2*order*order);
    unsigned half=order/2;
    for(unsigned k=0;k<order;++k) {
        double x=std::cos(pi*((k%half)+0.75)/(half+0.5)),derivative=0;
        for(int iter=0;iter<30;++iter) {
            double p=1,q=0;
            for(unsigned j=1;j<=half;++j){double old=p;p=((2*j-1)*x*p-(j-1)*q)/j;q=old;}
            derivative=half*(x*p-q)/(x*x-1);double step=p/derivative;x-=step;if(std::abs(step)<1e-15)break;
        }
        double weight=1/((1-x*x)*derivative*derivative)*pi/order;
        x=k<half?(x-1)/2:(x+1)/2;
        double radial=std::sqrt(std::max(0.0,1-x*x));
        for(unsigned j=0;j<2*order;++j) {
            double az=pi*(j+0.5)/order;
            out.push_back({{x,radial*std::cos(az),radial*std::sin(az)},weight});
        }
    }
    return out;
}
std::vector<SurfacePoint> sphere(unsigned order,const V3& velocity) {
    // Quadrature roots, azimuth trigonometry and weights depend on order only.
    // Each worker owns its reusable small rules; the event only rotates the
    // normals. Large refinements are temporary, bounding retained WASM memory.
    thread_local std::map<unsigned,std::vector<SurfacePoint>> rules;
    std::vector<SurfacePoint> temporary;
    const std::vector<SurfacePoint>* canonical=nullptr;
    if(order<=32) {
        auto found=rules.find(order);
        if(found==rules.end())found=rules.emplace(order,canonical_sphere(order)).first;
        canonical=&found->second;
    } else {temporary=canonical_sphere(order);canonical=&temporary;}
    V3 pole=velocity;double speed=norm(pole);if(speed==0)pole={0,0,1};else for(double& x:pole)x/=speed;
    V3 axis=std::abs(pole[0])<0.8?V3{1,0,0}:V3{0,1,0};
    double projection=dot(axis,pole);for(int i=0;i<3;++i)axis[i]-=projection*pole[i];
    double length=norm(axis);for(double& x:axis)x/=length;
    V3 third={pole[1]*axis[2]-pole[2]*axis[1],pole[2]*axis[0]-pole[0]*axis[2],pole[0]*axis[1]-pole[1]*axis[0]};
    std::vector<SurfacePoint> out;out.reserve(canonical->size());
    for(const auto& point:*canonical) {
        V3 normal{};
        for(int i=0;i<3;++i)normal[i]=point.normal[0]*pole[i]+point.normal[1]*axis[i]+point.normal[2]*third[i];
        out.push_back({normal,point.weight});
    }
    return out;
}
struct Kernel {
    V3 r{},v{};M3 inverse{},conditional{},regression{};double logdet=0;
    double q(const V3& n,double radius)const {
        V3 d{};for(int i=0;i<3;++i)d[i]=radius*n[i]-r[i];return dot(d,mul(inverse,d))+logdet;
    }
    double inward(const V3& n,double radius)const {
        V3 d{};for(int i=0;i<3;++i)d[i]=radius*n[i]-r[i];
        V3 conditional_v=mul(regression,d);for(int i=0;i<3;++i)conditional_v[i]+=v[i];
        return inward_speed(dot(n,conditional_v),dot(n,mul(conditional,n)));
    }
};
bool kernel(const PcEncounter& e,double t,bool two_body,Kernel& k,bool& repaired,const HallModel* hall=nullptr) {
    V6 x{};M6 covariance{};double det=0;
    if(!(hall?hall->at(t,x,covariance,repaired):relative_at(e,t,two_body,x,covariance))||!inverse_position(block(covariance),e.combined_radius,k.inverse,det,repaired))return false;
    k.r=position(x);k.v=velocity(x);k.logdet=std::log(det);
    M3 b=block(covariance,3,0);k.conditional=block(covariance,3,3);
    for(int i=0;i<3;++i)for(int j=0;j<3;++j)for(int h=0;h<3;++h)k.regression[i*3+j]+=b[i*3+h]*k.inverse[h*3+j];
    for(int i=0;i<3;++i)for(int j=0;j<3;++j)for(int h=0;h<3;++h)k.conditional[i*3+j]-=k.regression[i*3+h]*b[j*3+h];
    std::array<double,3> eigenvalues{};M3 eigenvectors{};
    if(!eigen<3>(k.conditional,eigenvalues,eigenvectors))return false;
    // CARA's flux integrand uses the zero-dispersion limit for nonpositive
    // conditional velocity variance. Repair the full conditional matrix
    // once, preserving rotational invariance and reporting the correction.
    double scale=0;for(double value:block(covariance,3,3))scale=std::max(scale,std::abs(value));
    bool clip=false;for(double value:eigenvalues)if(value<0){clip=true;if(value < -1e-12*scale)repaired=true;}
    if(clip){k.conditional.fill(0);for(int h=0;h<3;++h)for(int i=0;i<3;++i)for(int j=0;j<3;++j)
        k.conditional[i*3+j]+=eigenvectors[i*3+h]*eigenvectors[j*3+h]*std::max(0.0,eigenvalues[h]);}
    return true;
}
PcFallbackResult initialize(const PcEncounter& e,const PcFallbackOptions& o,const char* method,const PcUsageResult* usage) {
    PcFallbackResult result;result.pc.method=method;result.usage=usage?*usage:assess_pc_usage(e);
    auto times=time_bounds(e,o,result.usage);result.time_start=times.first;result.time_end=times.second;
    result.limitation="Cartesian Gaussian propagation and Hall/Coppola inward sphere flux; not CARA equinoctial peak-overlap Hall. Nc equals Pc only for an isolated encounter without recrossings.";
    if(!e.has_velocity_covariance)result.limitation+=" Velocity covariance unavailable.";
    return result;
}
double rate(const Kernel& k,const std::vector<SurfacePoint>& points,double radius) {
    double sum=0;for(const auto& point:points)sum+=point.weight*k.inward(point.normal,radius)*std::exp(-0.5*k.q(point.normal,radius));
    return radius*radius*sum/std::pow(2*pi,1.5);
}
double initial_occupancy_upper(const Kernel& k,double radius) {
    std::array<double,3> values{};M3 vectors{};
    if(!eigen<3>(k.inverse,values,vectors))return 1;
    double distance=std::max(0.0,std::sqrt(std::max(0.0,dot(k.r,mul(k.inverse,k.r))))-
        radius*std::sqrt(std::max({0.0,values[0],values[1],values[2]})));
    double logbound=std::log(4*pi/3)+3*std::log(radius)-1.5*std::log(2*pi)-0.5*(k.logdet+distance*distance);
    return std::min(1.0,std::exp(logbound));
}
void mark_count_applicability(PcFallbackResult& result,const PcEncounter& e) {
    const double shorter_period=std::min(period(e.primary,e.gravitational_parameter),period(e.secondary,e.gravitational_parameter));
    const bool repeated_entries_possible=std::isfinite(shorter_period)&&
        result.time_end-result.time_start>=0.5*shorter_period;
    if(result.expected_collisions>1||repeated_entries_possible) {
        result.requires_monte_carlo=true;
        result.limitation+=" POSSIBLE_REPEATED_ENTRIES_REQUIRE_MC: the expected entry count cannot be interpreted as a collision probability over this interval.";
    }
}
bool close(double a,double b,double tolerance) {return std::abs(a-b)<=std::max(1e-15,tolerance*std::max(std::abs(a),std::abs(b)));}

// Partition the observation interval independently from the surface rule.
// Reference retains its original dense grid, including the exact insertion
// order. Screening uses peak-width knots; Simpson's embedded refinement still
// checks every interval, and the full finite observation interval is retained.
std::set<double> nc3_time_knots(const PcFallbackOptions& o,const PcFallbackResult& result,bool expanded_screening_grid) {
    std::set<double> knots{result.time_start,result.time_end};
    const double span=result.time_end-result.time_start;
    const double sigma=result.usage.time_sigma,center=result.usage.time_center;
    if(o.grade==PcGrade::Screening && std::isfinite(sigma)&&sigma>0) {
        auto insert=[&](double offset) {
            const double t=center+offset*sigma;
            if(t>result.time_start&&t<result.time_end)knots.insert(t);
        };
        if(expanded_screening_grid)for(double offset:{-8.0,-4.0,-2.0,-1.0,0.0,1.0,2.0,4.0,8.0})insert(offset);
        else for(double offset:{-2.0,0.0,2.0})insert(offset);
        if(!expanded_screening_grid&&span>20*sigma)for(double t:{center-8*sigma,center+8*sigma})
            if(t>result.time_start&&t<result.time_end)knots.insert(t);
        for(double width=16*sigma;width<2*span;width*=2)
            for(double t:{center-width,center+width})if(t>result.time_start&&t<result.time_end)knots.insert(t);
    } else {
        unsigned intervals=std::clamp(o.time_intervals,16u,1024u);
        for(unsigned i=1;i<intervals;++i)knots.insert(result.time_start+span*i/intervals);
        if(std::isfinite(sigma)&&sigma>0) {
            for(int i=-16;i<=16;++i){double t=center+i*sigma/2;if(t>result.time_start&&t<result.time_end)knots.insert(t);}
            for(double width=8*sigma;width<2*span;width*=2)
                for(double t:{center-width,center+width})if(t>result.time_start&&t<result.time_end)knots.insert(t);
        }
    }
    return knots;
}

// The finite-sphere angular rule and analytic quadratic-Q time integral are
// shared by explicit 2D-Nc and Screening's guarded time approximation. Keep
// the established 2D-Nc arithmetic and refinement order in one place.
bool quadratic_flux(PcFallbackResult& result,const PcEncounter& e,const PcFallbackOptions& o,
                    const Kernel& km,const Kernel& k0,const Kernel& kp,double center,double width) {
    unsigned order=std::clamp(o.angular_order,8u,128u);double previous=-1,current=0;
    for(int refinement=0;refinement<5;++refinement) {
        auto points=sphere(order,k0.v);double sum=0;bool valid=true;
        for(const auto& point:points) {
            double q0=k0.q(point.normal,e.combined_radius),qm=km.q(point.normal,e.combined_radius),qp=kp.q(point.normal,e.combined_radius);
            double qdot=(qp-qm)/(2*width),qddot=(qp-2*q0+qm)/(width*width);
            if(!(qddot>0)){valid=false;break;}
            double sigma=std::sqrt(2/qddot),shift=-qdot/qddot,qstar=q0-0.5*qdot*qdot/qddot;
            double lo=(result.time_start-center-shift)/(sigma*std::sqrt(2.0)),hi=(result.time_end-center-shift)/(sigma*std::sqrt(2.0));
            double fraction=0.5*(std::erf(hi)-std::erf(lo));
            sum+=point.weight*k0.inward(point.normal,e.combined_radius)*sigma*std::exp(-0.5*qstar)*fraction;
        }
        if(!valid)return false;
        current=e.combined_radius*e.combined_radius*sum/(2*pi);result.pc.iterations+=points.size();
        if(previous>=0&&close(current,previous,o.relative_tolerance)){result.pc.converged=true;break;}
        if(order>=512)break;
        previous=current;order=std::min(512u,order*2);
    }
    result.expected_collisions=current;result.pc.probability=std::clamp(current,0.0,1.0);
    return true;
}

bool screening_quadratic_flux(PcFallbackResult& result,const PcEncounter& e,
                             const PcFallbackOptions& o,const HallModel* hall,const Kernel& k0) {
    if(!hall||o.grade!=PcGrade::Screening||!result.usage.fully_evaluated)return false;
    const double center=result.usage.time_center,width=result.usage.time_sigma,radius=e.combined_radius;
    const double orbit=std::min(period(e.primary,e.gravitational_parameter),period(e.secondary,e.gravitational_parameter));
    if(!(width>0)||!std::isfinite(width)||!std::isfinite(orbit)||!(result.time_end-result.time_start<0.02*orbit)||
       !(center-2*width>result.time_start&&center+2*width<result.time_end))return false;
    auto small_sphere=[&](const Kernel& k) {
        double squared_norm=0;for(double a:k.inverse)squared_norm+=a*a;
        const double inverse_bound=std::sqrt(squared_norm);
        // Frobenius norm bounds the largest inverse-covariance eigenvalue.
        // The second bound limits directional density variation on the sphere.
        return std::isfinite(inverse_bound)&&radius*std::sqrt(inverse_bound)<=0.1&&
            radius*norm(mul(k.inverse,k.r))+0.5*radius*radius*inverse_bound<=0.2;
    };
    if(!small_sphere(k0))return false;
    Kernel km,kp,kmm,kpp;bool repaired=result.covariance_repaired;
    if(!kernel(e,center-width,o.two_body,km,repaired,hall)||
       !kernel(e,center+width,o.two_body,kp,repaired,hall)||
       !kernel(e,center-2*width,o.two_body,kmm,repaired,hall)||
       !kernel(e,center+2*width,o.two_body,kpp,repaired,hall))return false;
    for(const Kernel* k:{&km,&kp,&kmm,&kpp})if(!small_sphere(*k))return false;
    const V3 zero{};
    auto temporal_residual=[&](const Kernel& outer,const Kernel& near,const Kernel& far) {
        // q(t,n) is quadratic in surface normal n. This coefficient bound
        // checks every direction at +/-2 sigma, rather than selected normals.
        double matrix_squared=0;V3 linear{};
        const auto a=mul(outer.inverse,outer.r),b=mul(near.inverse,near.r),
                   c=mul(far.inverse,far.r),d=mul(k0.inverse,k0.r);
        for(int i=0;i<3;++i)linear[i]=a[i]-3*b[i]-c[i]+3*d[i];
        for(int i=0;i<9;++i){const double value=outer.inverse[i]-3*near.inverse[i]-far.inverse[i]+3*k0.inverse[i];matrix_squared+=value*value;}
        const double constant=outer.q(zero,radius)-3*near.q(zero,radius)-far.q(zero,radius)+3*k0.q(zero,radius);
        return std::abs(constant)+2*radius*norm(linear)+radius*radius*std::sqrt(matrix_squared);
    };
    const double residual_minus=temporal_residual(kmm,km,kp),residual_plus=temporal_residual(kpp,kp,km);
    if(!std::isfinite(residual_minus)||!std::isfinite(residual_plus)||residual_minus>0.1||residual_plus>0.1)return false;
    const auto points=sphere(8,k0.v);
    double inward0=0;std::array<double,4> changes{};
    for(const auto& point:points) {
        const double base=k0.inward(point.normal,radius);inward0+=point.weight*base;
        size_t i=0;for(const Kernel* k:{&km,&kp,&kmm,&kpp})
            changes[i++]+=point.weight*std::abs(k->inward(point.normal,radius)-base);
    }
    if(!(inward0>0)||!std::isfinite(inward0))return false;
    for(double change:changes)if(!std::isfinite(change)||change>0.05*inward0)return false;
    auto approximation=result;approximation.pc.converged=false;
    if(!quadratic_flux(approximation,e,o,km,k0,kp,center,width)||!approximation.pc.converged)return false;
    approximation.covariance_repaired=repaired;
    approximation.pc.method="3D-NC-HALL-QUADRATIC-TIME";
    approximation.limitation="Screening grade: Hall finite-sphere flux with analytic quadratic-Q time approximation; R/sigma_min<=0.1, log-density variation<=0.2, full-sphere Q fit residual at +/-2 sigma<=0.1, conditional inward-flux variation at +/-sigma and +/-2 sigma<=0.05, observation interval<0.02 orbital period; angular relative tolerance="+
        std::to_string(o.relative_tolerance)+". Nc equals Pc only for an isolated encounter without recrossings or initial occupancy.";
    mark_count_applicability(approximation,e);
    Kernel start;
    if(!kernel(e,approximation.time_start,o.two_body,start,approximation.covariance_repaired,hall)||
       initial_occupancy_upper(start,radius)>std::max(1e-12,std::min(1e-4,o.relative_tolerance)*approximation.expected_collisions)) {
        approximation.requires_monte_carlo=true;
        approximation.limitation+=" INITIAL_OCCUPANCY_REQUIRES_MC: collision-sphere entry flux cannot represent already-overlapping trajectories at the observation interval start.";
    }
    result=std::move(approximation);return true;
}
}

static PcFallbackResult compute_nc3(const PcEncounter& e,const PcFallbackOptions& o,const HallModel* hall,const PcUsageResult* usage,bool expanded_screening_grid=false,bool screening_recovery=false) {
    if(!valid_encounter(e,o)){PcFallbackResult invalid;invalid.pc.method=hall?"3D-NC-HALL":"3D-NC-CARTESIAN";invalid.pc.converged=false;invalid.invalid_inputs=true;return invalid;}
    auto result=initialize(e,o,hall?"3D-NC-HALL":"3D-NC-CARTESIAN",usage);
    if(hall)result.limitation="Hall equinoctial peak-overlap sphere flux; Nc equals Pc for an isolated encounter without recrossings or initial occupancy.";
    const bool global_time_budget=o.grade==PcGrade::Screening&&!expanded_screening_grid;
    const bool stop_on_invalid=o.grade==PcGrade::Screening||screening_recovery;
    if(o.grade==PcGrade::Screening)result.limitation+=std::string(" Screening grade: adaptive peak-width time quadrature with ")+
        (global_time_budget?"global time-error target=0.1*relative tolerance":"expanded peak grid and local relative time-error target")+", relative tolerance="+
        std::to_string(o.relative_tolerance)+", angular order="+std::to_string(o.angular_order)+", at most one angular refinement.";
    if(!(e.combined_radius>0)||!(result.time_end>result.time_start)){result.pc.converged=false;return result;}
    if(o.grade==PcGrade::Screening) {
        // The finite observation window alone can establish repeated-entry
        // ambiguity. Computing an entry count cannot make that count into Pc.
        mark_count_applicability(result,e);
        if(result.requires_monte_carlo) {
            result.pc.converged=false;
            result.limitation+=" Entry flux not evaluated because the observation interval already requires Monte Carlo.";
            return result;
        }
    }
    Kernel initial;
    if(!kernel(e,result.usage.time_center,o.two_body,initial,result.covariance_repaired,hall)){result.pc.converged=false;return result;}
    if(!expanded_screening_grid&&screening_quadratic_flux(result,e,o,hall,initial))return result;
    // Include both a coarse full-window grid and a grid tied to the peak's
    // time width. A days-wide user limit must not erase a subsecond peak.
    const auto knots=nc3_time_knots(o,result,expanded_screening_grid);
    unsigned order=std::clamp(o.angular_order,8u,128u);if(order%2)++order;
    double current=0;result.pc.converged=false;
    // Angular refinement changes only the surface rule. Preserve the costly
    // propagated Gaussian kernels at time nodes already visited.
    std::map<double,Kernel> kernels;
    if(o.grade==PcGrade::Screening)kernels.emplace(result.usage.time_center,initial);
    const int refinements=o.grade==PcGrade::Screening?2:6;
    for(int refinement=0;refinement<refinements;++refinement) {
        auto points=sphere(order,initial.v),coarse_points=sphere(order/2,initial.v);
        struct Rates {double fine=0,coarse=0;};
        std::map<double,Rates> cache;bool valid=true,temporal_ok=true;
        auto evaluate=[&](double t) {
            if(stop_on_invalid&&!valid)return Rates{};
            auto found=cache.find(t);if(found!=cache.end())return found->second;
            auto entry=kernels.find(t);Rates value;
            if(entry==kernels.end()) {
                Kernel k;
                if(!kernel(e,t,o.two_body,k,result.covariance_repaired,hall))valid=false;
                else entry=kernels.emplace(t,std::move(k)).first;
            }
            if(entry!=kernels.end()) {
                value.fine=rate(entry->second,points,e.combined_radius);
                value.coarse=rate(entry->second,coarse_points,e.combined_radius);
            }
            cache.emplace(t,value);return value;
        };
        auto simpson=[](double a,double b,Rates fa,Rates fm,Rates fb) {
            return Rates{(b-a)*(fa.fine+4*fm.fine+fb.fine)/6,(b-a)*(fa.coarse+4*fm.coarse+fb.coarse)/6};
        };
        std::function<Rates(double,double,Rates,Rates,Rates,Rates,int,double)> integrate;
        integrate=[&](double a,double b,Rates fa,Rates fm,Rates fb,Rates whole,int depth,double absolute_budget)->Rates {
            if(stop_on_invalid&&!valid)return Rates{};
            double mid=(a+b)/2;auto fl=evaluate((a+mid)/2),fr=evaluate((mid+b)/2);
            if(stop_on_invalid&&!valid)return Rates{};
            auto left=simpson(a,mid,fa,fl,fm),right=simpson(mid,b,fm,fr,fb);
            Rates sum{left.fine+right.fine,left.coarse+right.coarse};
            if(global_time_budget?
               std::abs(sum.fine-whole.fine)<=15*absolute_budget:
               close(sum.fine,whole.fine,15*o.relative_tolerance))return sum;
            if(depth==0){temporal_ok=false;return sum;}
            left=integrate(a,mid,fa,fl,fm,left,depth-1,absolute_budget/2);right=integrate(mid,b,fm,fr,fb,right,depth-1,absolute_budget/2);
            return {left.fine+right.fine,left.coarse+right.coarse};
        };
        Rates total;auto it=knots.begin();double previous=*it++;
        if(global_time_budget) {
            struct Interval {double a,b;Rates fa,fm,fb,whole;};
            std::vector<Interval> intervals;double estimate=0;
            for(;it!=knots.end();++it) {
                const double next=*it;auto fa=evaluate(previous),fm=evaluate((previous+next)/2),fb=evaluate(next);
                if(!valid)return result;
                const auto whole=simpson(previous,next,fa,fm,fb);
                intervals.push_back({previous,next,fa,fm,fb,whole});estimate+=whole.fine;previous=next;
            }
            // Positive rates cannot cancel. Allocate one global absolute
            // Simpson error budget, rather than requiring relative precision
            // independently in tails that contribute negligibly to Nc. Both
            // the sampled whole-window estimate and peak-width scale bound
            // the budget conservatively; subdivision halves its allocation.
            const double sigma=result.usage.time_sigma;
            if(std::isfinite(sigma)&&sigma>0)estimate=std::min(estimate,
                evaluate(result.usage.time_center).fine*sigma*std::sqrt(2*pi));
            const double budget=std::max(1e-15,0.1*o.relative_tolerance*std::max(0.0,estimate))/intervals.size();
            for(const auto& interval:intervals) {
                const auto part=integrate(interval.a,interval.b,interval.fa,interval.fm,interval.fb,interval.whole,16,budget);
                total.fine+=part.fine;total.coarse+=part.coarse;
            }
        } else {
            for(;it!=knots.end();++it){double next=*it;auto fa=evaluate(previous),fm=evaluate((previous+next)/2),fb=evaluate(next);
                auto part=integrate(previous,next,fa,fm,fb,simpson(previous,next,fa,fm,fb),16,0);
                if(stop_on_invalid&&!valid)break;
                total.fine+=part.fine;total.coarse+=part.coarse;previous=next;}
        }
        current=total.fine;result.pc.iterations+=cache.size();
        if(!valid)return result;
        if(temporal_ok&&close(total.fine,total.coarse,o.relative_tolerance)){result.pc.converged=true;break;}
        if(order>=256||!temporal_ok)break;
        order*=2;
    }
    result.expected_collisions=current;result.pc.probability=std::clamp(current,0.0,1.0);
    mark_count_applicability(result,e);
    Kernel start;
    // The grade controls numerical effort, not whether an expected entry
    // count can be interpreted as total Pc. Retain Reference's occupancy
    // applicability threshold when Screening relaxes quadrature tolerance.
    const double occupancy_tolerance=o.grade==PcGrade::Screening?std::min(1e-4,o.relative_tolerance):o.relative_tolerance;
    if(!kernel(e,result.time_start,o.two_body,start,result.covariance_repaired,hall)||
       initial_occupancy_upper(start,e.combined_radius)>std::max(1e-12,occupancy_tolerance*current)) {
        result.requires_monte_carlo=true;
        result.limitation+=" INITIAL_OCCUPANCY_REQUIRES_MC: collision-sphere entry flux cannot represent already-overlapping trajectories at the observation interval start.";
    }
    return result;
}

static PcFallbackResult compute_nc2(const PcEncounter& e,const PcFallbackOptions& o,const HallModel* hall,const PcUsageResult* usage) {
    if(!valid_encounter(e,o)){PcFallbackResult invalid;invalid.pc.method=hall?"2D-NC-HALL":"2D-NC-CARTESIAN";invalid.pc.converged=false;invalid.invalid_inputs=true;return invalid;}
    auto result=initialize(e,o,hall?"2D-NC-HALL":"2D-NC-CARTESIAN",usage);result.pc.converged=false;
    if(hall)result.limitation="Hall equinoctial peak-overlap model with quadratic time integration; requires an isolated Gaussian-shaped collision-rate peak.";
    const std::string screening_settings=o.grade==PcGrade::Screening?
        " Screening grade: quadratic time integration, relative tolerance="+std::to_string(o.relative_tolerance)+
        ", initial angular order="+std::to_string(o.angular_order)+".":"";
    result.limitation+=screening_settings;
    if(hall&&!result.usage.fully_evaluated){
        result.requires_monte_carlo=true;
        result.limitation="CURVATURE_ANALYSIS_UNCONVERGED_REQUIRES_MC: a reliable quadratic collision-rate peak was not established."+screening_settings;
        return result;
    }
    double center=result.usage.time_center,width=result.usage.time_sigma;
    if(!(width>0)||!std::isfinite(width)||!(e.combined_radius>0))return result;
    Kernel km,k0,kp;
    if(!kernel(e,center-width,o.two_body,km,result.covariance_repaired,hall)||
       !kernel(e,center,o.two_body,k0,result.covariance_repaired,hall)||
       !kernel(e,center+width,o.two_body,kp,result.covariance_repaired,hall))return result;
    if(!quadratic_flux(result,e,o,km,k0,kp,center,width))return result;
    mark_count_applicability(result,e);
    Kernel start;
    const double occupancy_tolerance=o.grade==PcGrade::Screening?std::min(1e-4,o.relative_tolerance):o.relative_tolerance;
    if(!kernel(e,result.time_start,o.two_body,start,result.covariance_repaired,hall)||
       initial_occupancy_upper(start,e.combined_radius)>std::max(1e-12,occupancy_tolerance*result.expected_collisions)) {
        result.requires_monte_carlo=true;
        result.limitation+=" INITIAL_OCCUPANCY_REQUIRES_MC: collision-sphere entry flux cannot represent already-overlapping trajectories at the observation interval start.";
    }
    return result;
}
static PcFallbackResult compute_nc3_for_grade(const PcEncounter& e,const PcFallbackOptions& o,const HallModel* hall,const PcUsageResult* usage) {
    auto result=compute_nc3(e,o,hall,usage);
    if(o.grade==PcGrade::Screening && !result.pc.converged && !result.invalid_inputs && !result.requires_monte_carlo) {
        // Hall's iterative peak model can fail at an isolated time node. The
        // independently refined expanded grid often resolves the same full
        // interval without the far more costly Reference angular/time rules.
        auto expanded=compute_nc3(e,o,hall,&result.usage,true);
        expanded.limitation+=" Screening compact quadrature unavailable; expanded peak-grid recovery used.";
        if(expanded.pc.converged||expanded.invalid_inputs||expanded.requires_monte_carlo)return expanded;
        // A sparse time node or the bounded angular refinement can fail even
        // when Reference quadrature resolves this encounter. Recover with the
        // established Reference rule before requesting a different Pc model.
        // Applicability failures still go directly to Monte Carlo as before.
        auto reference=o;reference.grade=PcGrade::Reference;
        reference.relative_tolerance=1e-4;reference.angular_order=16;reference.time_intervals=128;
        // This is part of a Screening call: after a failed Gaussian kernel,
        // further nodes cannot repair that quadrature. Valid Reference-rule
        // results retain the same arithmetic; ordinary Reference calls keep
        // their original execution path as well as their original result.
        auto recovered=compute_nc3(e,reference,hall,&result.usage,false,true);
        recovered.limitation+=" Screening quadrature unavailable; Reference recovery used relative tolerance=0.0001, angular order=16, time intervals=128.";
        return recovered;
    }
    return result;
}
PcFallbackResult pc_3d_nc_cartesian(const PcEncounter& e,const PcFallbackOptions& o,const PcUsageResult* usage){return compute_nc3_for_grade(e,o,nullptr,usage);}
PcFallbackResult pc_2d_nc_cartesian(const PcEncounter& e,const PcFallbackOptions& o,const PcUsageResult* usage){return compute_nc2(e,o,nullptr,usage);}
PcFallbackResult pc_3d_nc_hall(const PcEncounter& e,const PcFallbackOptions& o,const PcUsageResult* usage){HallModel model(e);return compute_nc3_for_grade(e,o,&model,usage);}
PcFallbackResult pc_2d_nc_hall(const PcEncounter& e,const PcFallbackOptions& o,const PcUsageResult* usage){HallModel model(e);return compute_nc2(e,o,&model,usage);}
} // namespace conjunction
