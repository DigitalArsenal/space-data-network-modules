#include "pc_fallback_internal.h"
#include "pc_hall.h"
#include "pc_sphere_quadrature.h"
#include "conjunction/encounter_geometry.h"
#include <vector>
#include <functional>
#include <map>
#include <set>
#include <sstream>

namespace conjunction {
using namespace pc_detail;
namespace {
struct Kernel {
    V3 r{},v{};M3 covariance{},inverse{},conditional{},regression{};double logdet=0;
    bool finite_inward_bound(double radius)const {
        // Surface normals are unit length; using 2 per component also bounds
        // rotation roundoff. Prove all inward-speed intermediates finite before
        // eliding a zero-density product, so 0*NaN/Inf is never hidden.
        double mean=0,variance=0;
        for(int i=0;i<3;++i){
            double component=std::abs(v[i]);
            for(int j=0;j<3;++j){
                component+=std::abs(regression[i*3+j])*(2*radius+std::abs(r[j]));
                variance+=4*std::abs(conditional[i*3+j]);
            }
            mean+=2*component;
        }
        return std::isfinite(mean+std::sqrt(variance));
    }
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
    k.r=position(x);k.v=velocity(x);k.covariance=block(covariance);k.logdet=std::log(det);
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
PcFallbackResult initialize(const PcEncounter& e,const PcFallbackOptions& o,const char* method) {
    PcFallbackResult result;result.pc.method=method;result.usage=assess_pc_usage(e);
    auto times=time_bounds(e,o,result.usage);result.time_start=times.first;result.time_end=times.second;
    result.limitation="Cartesian Gaussian propagation and Hall/Coppola inward sphere flux; not CARA equinoctial peak-overlap Hall. Nc equals Pc only for an isolated encounter without recrossings.";
    if(!e.has_velocity_covariance)result.limitation+=" Velocity covariance unavailable.";
    return result;
}
double rate(const Kernel& k,const std::vector<SurfacePoint>& points,double radius) {
    const bool finite_inward=k.finite_inward_bound(radius);
    double sum=0;for(const auto& point:points){
        const double density=std::exp(-0.5*k.q(point.normal,radius));
        if(density==0&&finite_inward)continue;
        sum+=point.weight*k.inward(point.normal,radius)*density;
    }
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

// Pc2D_Hall.m effective-plane calculation: conditional velocity at R=0,
// retaining the peak-overlap position covariance. Projection removes the
// along-velocity shift to effective TCA without changing that covariance.
PcResult effective_plane(const Kernel& k,double radius) {
    const V3 v=sub(k.v,mul(k.regression,k.r));
    if(!(norm(v)>=1e-10)) {PcResult r;r.converged=false;return r;}
    StateVector a{},b{};b.x=k.r[0];b.y=k.r[1];b.z=k.r[2];
    b.vx=v[0];b.vy=v[1];b.vz=v[2];
    Covariance3x3 c{},zero{};std::copy(k.covariance.begin(),k.covariance.end(),c.data);
    return Foster2D().compute(build_bplane(a,b,c,zero,radius));
}
void mark_nc2_usage(PcFallbackResult& result,const PcEncounter& e,const Kernel& k) {
    const double shorter=std::min(period(e.primary,e.gravitational_parameter),period(e.secondary,e.gravitational_parameter));
    constexpr double extent=8.304785425194112; // gamma=1e-16, CARA PcMultiStep.
    const double half=extent*result.rate_time_sigma;
    result.nc_extended=2*half/shorter;
    result.nc_offset=(std::abs(result.rate_time_center)+half)/shorter;
    const auto alternate=effective_plane(k,e.combined_radius);
    const double sum=alternate.probability+result.expected_collisions;
    result.nc_inaccurate=alternate.converged&&std::isfinite(sum)&&sum>=0
        ? (sum==0?0:2*std::abs(alternate.probability-result.expected_collisions)/sum) : 2;
    auto flag=[&](const char* reason){result.requires_3d=true;result.limitation+=" ";result.limitation+=reason;};
    // These are the 2D-Nc thresholds, distinct from the 2D-Pc checks.
    if(!std::isfinite(result.nc_extended)||result.nc_extended>0.05)flag("NC2_EXTENDED_REQUIRES_3D");
    if(!std::isfinite(result.nc_offset)||result.nc_offset>0.1)flag("NC2_OFFSET_REQUIRES_3D");
    if(!std::isfinite(result.nc_inaccurate)||result.nc_inaccurate>0.1)flag("NC2_EFFECTIVE_PLANE_DISAGREEMENT_REQUIRES_3D");
    std::ostringstream details;details.precision(12);
    details<<" NC2_USAGE duration/period="<<result.nc_extended<<" offset/period="<<result.nc_offset
           <<" effective_plane_relative_difference="<<result.nc_inaccurate;
    result.limitation+=details.str();
}
}

static PcFallbackResult compute_nc3(const PcEncounter& e,const PcFallbackOptions& o,const HallModel* hall) {
    if(!valid_encounter(e,o)){PcFallbackResult invalid;invalid.pc.method=hall?"3D-NC-HALL":"3D-NC-CARTESIAN";invalid.pc.converged=false;invalid.invalid_inputs=true;return invalid;}
    auto result=initialize(e,o,hall?"3D-NC-HALL":"3D-NC-CARTESIAN");
    if(hall)result.limitation="Hall equinoctial peak-overlap sphere flux; Nc equals Pc for an isolated encounter without recrossings or initial occupancy.";
    if(o.time_start==0&&o.time_end==0&&!result.usage.fully_evaluated) {
        result.pc.converged=false;result.requires_monte_carlo=true;
        result.limitation+=" NC3_UNRESOLVED_DURATION_REQUIRES_MC: no reliable peak bounds were established; sampling uses the documented finite observation window.";
        return result;
    }
    if(!(e.combined_radius>0)||!(result.time_end>result.time_start)){result.pc.converged=false;return result;}
    Kernel initial;
    if(!kernel(e,result.usage.time_center,o.two_body,initial,result.covariance_repaired,hall)){result.pc.converged=false;return result;}
    // Include both a coarse full-window grid and a grid tied to the peak's
    // time width. A days-wide user limit must not erase a subsecond peak.
    std::set<double> knots{result.time_start,result.time_end};
    unsigned intervals=std::clamp(o.time_intervals,16u,1024u);
    for(unsigned i=1;i<intervals;++i)knots.insert(result.time_start+(result.time_end-result.time_start)*i/intervals);
    double sigma=result.usage.time_sigma,center=result.usage.time_center;
    if(std::isfinite(sigma)&&sigma>0) {
        for(int i=-16;i<=16;++i){double t=center+i*sigma/2;if(t>result.time_start&&t<result.time_end)knots.insert(t);}
        for(double width=8*sigma;width<2*(result.time_end-result.time_start);width*=2)
            for(double t:{center-width,center+width})if(t>result.time_start&&t<result.time_end)knots.insert(t);
    }
    struct Rates {double fine=0,coarse=0;};
    struct TimeSeries {Rates total;bool valid=true,temporal_ok=true;};
    // Geometry and covariance are independent of the angular rule. Share
    // them across independent rule checks without changing time refinement.
    std::map<double,Kernel> kernels;
    auto integrate_rules=[&](const std::vector<SurfacePoint>& points,const std::vector<SurfacePoint>& coarse_points) {
        TimeSeries series;std::map<double,Rates> cache;
        if(points.empty()||coarse_points.empty()){series.valid=false;return series;}
        auto evaluate=[&](double t) {
            auto found=cache.find(t);if(found!=cache.end())return found->second;
            auto geometry=kernels.find(t);Rates value;
            if(geometry==kernels.end()) {
                Kernel k;if(!kernel(e,t,o.two_body,k,result.covariance_repaired,hall)){series.valid=false;return value;}
                geometry=kernels.emplace(t,k).first;
            }
            value.fine=rate(geometry->second,points,e.combined_radius);
            value.coarse=rate(geometry->second,coarse_points,e.combined_radius);
            if(!std::isfinite(value.fine)||!std::isfinite(value.coarse))series.valid=false;
            cache.emplace(t,value);return value;
        };
        auto simpson=[](double a,double b,Rates fa,Rates fm,Rates fb) {
            return Rates{(b-a)*(fa.fine+4*fm.fine+fb.fine)/6,(b-a)*(fa.coarse+4*fm.coarse+fb.coarse)/6};
        };
        std::function<Rates(double,double,Rates,Rates,Rates,Rates,int)> integrate;
        integrate=[&](double a,double b,Rates fa,Rates fm,Rates fb,Rates whole,int depth)->Rates {
            double mid=(a+b)/2;auto fl=evaluate((a+mid)/2),fr=evaluate((mid+b)/2);
            auto left=simpson(a,mid,fa,fl,fm),right=simpson(mid,b,fm,fr,fb);
            Rates sum{left.fine+right.fine,left.coarse+right.coarse};
            if(close(sum.fine,whole.fine,15*o.relative_tolerance)&&
               close(sum.coarse,whole.coarse,15*o.relative_tolerance))return sum;
            if(depth==0){series.temporal_ok=false;return sum;}
            left=integrate(a,mid,fa,fl,fm,left,depth-1);right=integrate(mid,b,fm,fr,fb,right,depth-1);
            return {left.fine+right.fine,left.coarse+right.coarse};
        };
        Rates total;auto it=knots.begin();double previous=*it++;
        for(;it!=knots.end();++it){double next=*it;auto fa=evaluate(previous),fm=evaluate((previous+next)/2),fb=evaluate(next);
            auto part=integrate(previous,next,fa,fm,fb,simpson(previous,next,fa,fm,fb),16);
            total.fine+=part.fine;total.coarse+=part.coarse;previous=next;}
        series.total=total;result.pc.iterations+=cache.size();return series;
    };
    // Lebedev integrates the time series of sphere fluxes. Because the
    // inward flux may have a kink or a concentrated angular peak, agreement
    // between two Lebedev rules is checked against an independently refined
    // hemisphere product rule before accepting its estimate.
    const auto lebedev=integrate_rules(lebedev_sphere(5810,initial.v),lebedev_sphere(3890,initial.v));
    result.pc.converged=false;if(!lebedev.valid)return result;
    unsigned order=std::clamp(o.angular_order,8u,128u);if(order%2)++order;
    double current=0;
    for(int refinement=0;refinement<6;++refinement) {
        const auto product=integrate_rules(product_sphere(order,initial.v),product_sphere(order/2,initial.v));
        current=product.total.fine;
        if(!product.valid)return result;
        if(product.temporal_ok&&close(product.total.fine,product.total.coarse,o.relative_tolerance)){
            result.pc.converged=true;
            if(lebedev.temporal_ok&&close(lebedev.total.fine,lebedev.total.coarse,o.relative_tolerance)&&
               close(lebedev.total.fine,current,o.relative_tolerance)){
                current=lebedev.total.fine;
                result.limitation+=" SPHERE_QUADRATURE=LEBEDEV points=5810 independently_verified_by_product_order="+std::to_string(order);
            }else result.limitation+=" SPHERE_QUADRATURE=PRODUCT_REFINEMENT after_LEBEDEV=5810 order="+std::to_string(order);
            break;
        }
        if(order>=256||!product.temporal_ok)break;
        order*=2;
    }
    if(!result.pc.converged)result.limitation+=" SPHERE_QUADRATURE_UNCONVERGED after_LEBEDEV_and_PRODUCT";
    result.expected_collisions=current;result.pc.probability=std::clamp(current,0.0,1.0);
    mark_count_applicability(result,e);
    Kernel start;
    if(!kernel(e,result.time_start,o.two_body,start,result.covariance_repaired,hall)||
       initial_occupancy_upper(start,e.combined_radius)>std::max(1e-12,o.relative_tolerance*current)) {
        result.requires_monte_carlo=true;
        result.limitation+=" INITIAL_OCCUPANCY_REQUIRES_MC: collision-sphere entry flux cannot represent already-overlapping trajectories at the observation interval start.";
    }
    // A window estimated from one R=0 peak must not silently truncate an
    // extended or blended event. Explicit windows retain finite-window meaning.
    if(o.time_start==0&&o.time_end==0) {
        if(result.usage.extended>0.05||result.usage.offset>0.75) {
            result.requires_monte_carlo=true;
            result.limitation+=" NC3_DURATION_OR_OFFSET_REQUIRES_MC";
        }
        Kernel end;
        if(!kernel(e,result.time_end,o.two_body,end,result.covariance_repaired,hall)||
           initial_occupancy_upper(end,e.combined_radius)>std::max(1e-12,o.relative_tolerance*current)) {
            result.requires_monte_carlo=true;
            result.limitation+=" NC3_ACTIVE_END_BOUNDARY_REQUIRES_MC: the estimated encounter window has non-negligible overlap at its end.";
        }
    }
    return result;
}

static PcFallbackResult compute_nc2(const PcEncounter& e,const PcFallbackOptions& o,const HallModel* hall) {
    if(!valid_encounter(e,o)){PcFallbackResult invalid;invalid.pc.method=hall?"2D-NC-HALL":"2D-NC-CARTESIAN";invalid.pc.converged=false;invalid.invalid_inputs=true;return invalid;}
    auto result=initialize(e,o,hall?"2D-NC-HALL":"2D-NC-CARTESIAN");result.pc.converged=false;
    if(hall)result.limitation="Hall equinoctial peak-overlap model with quadratic time integration; requires an isolated Gaussian-shaped collision-rate peak.";
    if(hall&&!result.usage.fully_evaluated){
        result.requires_3d=true;
        result.limitation="CURVATURE_ANALYSIS_UNCONVERGED_REQUIRES_3D: a reliable quadratic collision-rate peak was not established.";
        return result;
    }
    double center=result.usage.time_center,width=result.usage.time_sigma;
    if(!(width>0)||!std::isfinite(width)||!(e.combined_radius>0))return result;
    Kernel km,k0,kp;
    if(!kernel(e,center-width,o.two_body,km,result.covariance_repaired,hall)||
       !kernel(e,center,o.two_body,k0,result.covariance_repaired,hall)||
       !kernel(e,center+width,o.two_body,kp,result.covariance_repaired,hall))return result;
    struct TimeIntegral {double value=0,center=0,sigma=0;bool valid=true;unsigned significant=0;};
    auto integrate=[&](const std::vector<SurfacePoint>& points) {
        TimeIntegral integral;double sum=0,mass=0,first=0,second=0,maximum=0;
        if(points.empty()){integral.valid=false;return integral;}
        std::vector<double> contributions;contributions.reserve(points.size());
        for(const auto& point:points) {
            double q0=k0.q(point.normal,e.combined_radius),qm=km.q(point.normal,e.combined_radius),qp=kp.q(point.normal,e.combined_radius);
            double qdot=(qp-qm)/(2*width),qddot=(qp-2*q0+qm)/(width*width);
            if(!(qddot>0)||!std::isfinite(qddot)){integral.valid=false;break;}
            double sigma=std::sqrt(2/qddot),shift=-qdot/qddot,qstar=q0-0.5*qdot*qdot/qddot;
            if(!std::isfinite(qstar)||qstar<k0.logdet-1e-10){integral.valid=false;break;}
            double lo=(result.time_start-center-shift)/(sigma*std::sqrt(2.0)),hi=(result.time_end-center-shift)/(sigma*std::sqrt(2.0));
            double fraction=0.5*(std::erf(hi)-std::erf(lo));
            const double weight=point.weight*k0.inward(point.normal,e.combined_radius)*sigma*std::exp(-0.5*qstar);
            sum+=weight*fraction;mass+=weight;first+=weight*shift;second+=weight*(shift*shift+sigma*sigma);
            contributions.push_back(weight*fraction);maximum=std::max(maximum,contributions.back());
        }
        integral.value=e.combined_radius*e.combined_radius*sum/(2*pi);
        integral.center=center+(mass>0?first/mass:0);
        integral.sigma=mass>0?std::sqrt(std::max(0.0,second/mass-(first/mass)*(first/mass))):width;
        for(double value:contributions)if(value>1e-3*maximum)++integral.significant;
        integral.valid=integral.valid&&std::isfinite(integral.value)&&integral.value>=0&&
            std::isfinite(integral.center)&&std::isfinite(integral.sigma);
        result.pc.iterations+=points.size();return integral;
    };
    auto agree=[&](const TimeIntegral& a,const TimeIntegral& b){
        return close(a.value,b.value,o.relative_tolerance)&&
            std::abs(a.center-b.center)<=o.relative_tolerance*width&&close(a.sigma,b.sigma,o.relative_tolerance);
    };
    TimeIntegral previous,current;bool have_previous=false;unsigned stable=0,used=0;
    const auto alternate=effective_plane(k0,e.combined_radius);
    // CARA uses the 5810 point rule and requests full sphere refinement for
    // concentrated contributions, Pc >= 5e-5, or effective-plane disagreement.
    // Here independently increasing rules also verify the value AND moments.
    for(unsigned size:{590u,974u,2030u,3890u,5810u}){
        current=integrate(lebedev_sphere(size,k0.v));used=size;
        if(!current.valid){result.requires_3d=true;result.limitation+=" NC2_SERIES_BREAKDOWN_REQUIRES_3D";return result;}
        stable=have_previous&&agree(current,previous)?stable+1:0;
        const bool well_sampled=current.significant>0.025*size;
        const bool plane_agrees=alternate.converged&&std::abs(alternate.probability-current.value)<=0.1*current.value;
        if(stable>=2&&well_sampled&&current.value>0&&current.value<5e-5&&plane_agrees){result.pc.converged=true;break;}
        previous=current;have_previous=true;
    }
    if(result.pc.converged)result.limitation+=" SPHERE_QUADRATURE=LEBEDEV points="+std::to_string(used);
    else{
        result.limitation+=" SPHERE_QUADRATURE=PRODUCT_REFINEMENT after_LEBEDEV="+std::to_string(used);
        unsigned order=std::clamp(o.angular_order,8u,128u);have_previous=false;
        for(int refinement=0;refinement<5;++refinement){
            current=integrate(product_sphere(order,k0.v));
            if(!current.valid){result.requires_3d=true;result.limitation+=" NC2_SERIES_BREAKDOWN_REQUIRES_3D";return result;}
            if(have_previous&&agree(current,previous)){result.pc.converged=true;break;}
            if(order>=512)break;
            previous=current;have_previous=true;order=std::min(512u,order*2);
        }
    }
    result.rate_time_center=current.center;result.rate_time_sigma=current.sigma;
    result.expected_collisions=current.value;result.pc.probability=std::clamp(current.value,0.0,1.0);
    mark_nc2_usage(result,e,k0);
    mark_count_applicability(result,e);
    Kernel start;
    if(!kernel(e,result.time_start,o.two_body,start,result.covariance_repaired,hall)||
       initial_occupancy_upper(start,e.combined_radius)>std::max(1e-12,o.relative_tolerance*current.value)) {
        result.requires_monte_carlo=true;
        result.limitation+=" INITIAL_OCCUPANCY_REQUIRES_MC: collision-sphere entry flux cannot represent already-overlapping trajectories at the observation interval start.";
    }
    return result;
}
PcFallbackResult pc_3d_nc_cartesian(const PcEncounter& e,const PcFallbackOptions& o){return compute_nc3(e,o,nullptr);}
PcFallbackResult pc_2d_nc_cartesian(const PcEncounter& e,const PcFallbackOptions& o){return compute_nc2(e,o,nullptr);}
PcFallbackResult pc_3d_nc_hall(const PcEncounter& e,const PcFallbackOptions& o){HallModel model(e);return compute_nc3(e,o,&model);}
PcFallbackResult pc_2d_nc_hall(const PcEncounter& e,const PcFallbackOptions& o){HallModel model(e);return compute_nc2(e,o,&model);}
} // namespace conjunction
