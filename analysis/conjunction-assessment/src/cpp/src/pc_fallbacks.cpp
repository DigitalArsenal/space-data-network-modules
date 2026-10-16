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
std::vector<SurfacePoint> sphere(unsigned order,const V3& velocity) {
    std::vector<SurfacePoint> out;out.reserve(2*order*order);
    V3 pole=velocity;double speed=norm(pole);if(speed==0)pole={0,0,1};else for(double& x:pole)x/=speed;
    V3 axis=std::abs(pole[0])<0.8?V3{1,0,0}:V3{0,1,0};
    double projection=dot(axis,pole);for(int i=0;i<3;++i)axis[i]-=projection*pole[i];
    double length=norm(axis);for(double& x:axis)x/=length;
    V3 third={pole[1]*axis[2]-pole[2]*axis[1],pole[2]*axis[0]-pole[0]*axis[2],pole[0]*axis[1]-pole[1]*axis[0]};
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
            double az=pi*(j+0.5)/order;V3 n{};
            for(int i=0;i<3;++i)n[i]=x*pole[i]+radial*(std::cos(az)*axis[i]+std::sin(az)*third[i]);
            out.push_back({n,weight});
        }
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
PcFallbackResult initialize(const PcEncounter& e,const PcFallbackOptions& o,const char* method) {
    PcFallbackResult result;result.pc.method=method;result.usage=assess_pc_usage(e);
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
}

static PcFallbackResult compute_nc3(const PcEncounter& e,const PcFallbackOptions& o,const HallModel* hall) {
    if(!valid_encounter(e,o)){PcFallbackResult invalid;invalid.pc.method=hall?"3D-NC-HALL":"3D-NC-CARTESIAN";invalid.pc.converged=false;invalid.invalid_inputs=true;return invalid;}
    auto result=initialize(e,o,hall?"3D-NC-HALL":"3D-NC-CARTESIAN");
    if(hall)result.limitation="Hall equinoctial peak-overlap sphere flux; Nc equals Pc for an isolated encounter without recrossings or initial occupancy.";
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
    unsigned order=std::clamp(o.angular_order,8u,128u);if(order%2)++order;
    double current=0;result.pc.converged=false;
    for(int refinement=0;refinement<6;++refinement) {
        auto points=sphere(order,initial.v),coarse_points=sphere(order/2,initial.v);
        struct Rates {double fine=0,coarse=0;};
        std::map<double,Rates> cache;bool valid=true,temporal_ok=true;
        auto evaluate=[&](double t) {
            auto found=cache.find(t);if(found!=cache.end())return found->second;
            Kernel k;Rates value;
            if(!kernel(e,t,o.two_body,k,result.covariance_repaired,hall))valid=false;
            else{value.fine=rate(k,points,e.combined_radius);value.coarse=rate(k,coarse_points,e.combined_radius);}
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
            if(close(sum.fine,whole.fine,15*o.relative_tolerance))return sum;
            if(depth==0){temporal_ok=false;return sum;}
            left=integrate(a,mid,fa,fl,fm,left,depth-1);right=integrate(mid,b,fm,fr,fb,right,depth-1);
            return {left.fine+right.fine,left.coarse+right.coarse};
        };
        Rates total;auto it=knots.begin();double previous=*it++;
        for(;it!=knots.end();++it){double next=*it;auto fa=evaluate(previous),fm=evaluate((previous+next)/2),fb=evaluate(next);
            auto part=integrate(previous,next,fa,fm,fb,simpson(previous,next,fa,fm,fb),16);
            total.fine+=part.fine;total.coarse+=part.coarse;previous=next;}
        current=total.fine;result.pc.iterations+=cache.size();
        if(!valid)return result;
        if(temporal_ok&&close(total.fine,total.coarse,o.relative_tolerance)){result.pc.converged=true;break;}
        if(order>=256||!temporal_ok)break;
        order*=2;
    }
    result.expected_collisions=current;result.pc.probability=std::clamp(current,0.0,1.0);
    mark_count_applicability(result,e);
    Kernel start;
    if(!kernel(e,result.time_start,o.two_body,start,result.covariance_repaired,hall)||
       initial_occupancy_upper(start,e.combined_radius)>std::max(1e-12,o.relative_tolerance*current)) {
        result.requires_monte_carlo=true;
        result.limitation+=" INITIAL_OCCUPANCY_REQUIRES_MC: collision-sphere entry flux cannot represent already-overlapping trajectories at the observation interval start.";
    }
    return result;
}

static PcFallbackResult compute_nc2(const PcEncounter& e,const PcFallbackOptions& o,const HallModel* hall) {
    if(!valid_encounter(e,o)){PcFallbackResult invalid;invalid.pc.method=hall?"2D-NC-HALL":"2D-NC-CARTESIAN";invalid.pc.converged=false;invalid.invalid_inputs=true;return invalid;}
    auto result=initialize(e,o,hall?"2D-NC-HALL":"2D-NC-CARTESIAN");result.pc.converged=false;
    if(hall)result.limitation="Hall equinoctial peak-overlap model with quadratic time integration; requires an isolated Gaussian-shaped collision-rate peak.";
    if(hall&&!result.usage.fully_evaluated){
        result.requires_monte_carlo=true;
        result.limitation="CURVATURE_ANALYSIS_UNCONVERGED_REQUIRES_MC: a reliable quadratic collision-rate peak was not established.";
        return result;
    }
    double center=result.usage.time_center,width=result.usage.time_sigma;
    if(!(width>0)||!std::isfinite(width)||!(e.combined_radius>0))return result;
    Kernel km,k0,kp;
    if(!kernel(e,center-width,o.two_body,km,result.covariance_repaired,hall)||
       !kernel(e,center,o.two_body,k0,result.covariance_repaired,hall)||
       !kernel(e,center+width,o.two_body,kp,result.covariance_repaired,hall))return result;
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
        if(!valid)return result;
        current=e.combined_radius*e.combined_radius*sum/(2*pi);result.pc.iterations+=points.size();
        if(previous>=0&&close(current,previous,o.relative_tolerance)){result.pc.converged=true;break;}
        if(order>=512)break;
        previous=current;order=std::min(512u,order*2);
    }
    result.expected_collisions=current;result.pc.probability=std::clamp(current,0.0,1.0);
    mark_count_applicability(result,e);
    Kernel start;
    if(!kernel(e,result.time_start,o.two_body,start,result.covariance_repaired,hall)||
       initial_occupancy_upper(start,e.combined_radius)>std::max(1e-12,o.relative_tolerance*current)) {
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
