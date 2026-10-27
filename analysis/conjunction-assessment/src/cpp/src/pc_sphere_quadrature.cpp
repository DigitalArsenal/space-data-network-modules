#include "pc_sphere_quadrature.h"

namespace conjunction::pc_detail {
namespace {
#include "../third_party/lebedev/coefficients.inc"
struct SphereBasis {V3 pole,axis,third;};
SphereBasis sphere_basis(const V3& velocity) {
    V3 pole=velocity;double speed=norm(pole);if(speed==0)pole={0,0,1};else for(double& x:pole)x/=speed;
    V3 axis=std::abs(pole[0])<0.8?V3{1,0,0}:V3{0,1,0};
    double projection=dot(axis,pole);for(int i=0;i<3;++i)axis[i]-=projection*pole[i];
    double length=norm(axis);for(double& x:axis)x/=length;
    V3 third={pole[1]*axis[2]-pole[2]*axis[1],pole[2]*axis[0]-pole[0]*axis[2],pole[0]*axis[1]-pole[1]*axis[0]};
    return {pole,axis,third};
}
V3 rotate_normal(const V3& n,const SphereBasis& basis) {
    V3 out{};for(int i=0;i<3;++i)out[i]=n[0]*basis.axis[i]+n[1]*basis.third[i]+n[2]*basis.pole[i];return out;
}
template<size_t N> std::vector<SurfacePoint> expand_lebedev(const LebedevOrbit (&orbits)[N]) {
    std::vector<SurfacePoint> points;
    for(const auto& orbit:orbits){
        const double a=orbit.a,b=orbit.b;V3 seed{};
        switch(orbit.code){
            case 1:seed={0,0,1};break;
            case 2:seed={0,std::sqrt(.5),std::sqrt(.5)};break;
            case 3:seed={std::sqrt(1.0/3),std::sqrt(1.0/3),std::sqrt(1.0/3)};break;
            case 4:seed={a,a,std::sqrt(1-2*a*a)};break;
            case 5:seed={a,std::sqrt(1-a*a),0};break;
            case 6:seed={a,b,std::sqrt(1-a*a-b*b)};break;
            default:return {}; // invalid table: callers fail closed
        }
        std::sort(seed.begin(),seed.end());
        do{
            for(unsigned signs=0;signs<8;++signs){
                V3 normal=seed;bool duplicate=false;
                for(unsigned i=0;i<3;++i)if(signs&(1u<<i)){
                    if(normal[i]==0){duplicate=true;break;}normal[i]=-normal[i];
                }
                if(!duplicate)points.push_back({normal,4*pi*orbit.weight});
            }
        }while(std::next_permutation(seed.begin(),seed.end()));
    }
    return points;
}
}
std::vector<SurfacePoint> lebedev_sphere(unsigned point_count,const V3& velocity) {
    // Immutable rules are shared by all candidate pairs and threads. Only the
    // rotation into each encounter's basis is performed per call.
    static const std::array<std::vector<SurfacePoint>,5> rules={
        expand_lebedev(lebedev_590),expand_lebedev(lebedev_974),
        expand_lebedev(lebedev_2030),expand_lebedev(lebedev_3890),expand_lebedev(lebedev_5810)};
    size_t index;
    switch(point_count){case 590:index=0;break;case 974:index=1;break;case 2030:index=2;break;
        case 3890:index=3;break;case 5810:index=4;break;default:return {};}
    auto out=rules[index];const auto basis=sphere_basis(velocity);
    for(auto& point:out)point.normal=rotate_normal(point.normal,basis);
    return out;
}
std::vector<SurfacePoint> product_sphere(unsigned order,const V3& velocity) {
    order=std::max(2u,order+order%2); // equal Gauss rules on the two hemispheres
    std::vector<SurfacePoint> out;out.reserve(2*order*order);
    const auto basis=sphere_basis(velocity);
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
            const V3 n=rotate_normal({radial*std::cos(az),radial*std::sin(az),x},basis);
            out.push_back({n,weight});
        }
    }
    return out;
}
}
