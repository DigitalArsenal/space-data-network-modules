#ifndef CONJUNCTION_PC_MATH_INTERNAL_H
#define CONJUNCTION_PC_MATH_INTERNAL_H
#include "conjunction/pc_usage.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace conjunction::pc_detail {
using V3 = std::array<double, 3>;
using V6 = std::array<double, 6>;
using M3 = std::array<double, 9>;
using M6 = std::array<double, 36>;
constexpr double pi = 3.141592653589793238462643383279502884;
inline double dot(const V3& a, const V3& b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
inline double norm(const V3& a) { return std::sqrt(dot(a,a)); }
inline V3 position(const V6& a) { return {a[0],a[1],a[2]}; }
inline V3 velocity(const V6& a) { return {a[3],a[4],a[5]}; }
inline V3 sub(const V3& a,const V3& b) { return {a[0]-b[0],a[1]-b[1],a[2]-b[2]}; }
inline V3 mul(const M3& a,const V3& x) {
    return {a[0]*x[0]+a[1]*x[1]+a[2]*x[2],a[3]*x[0]+a[4]*x[1]+a[5]*x[2],a[6]*x[0]+a[7]*x[1]+a[8]*x[2]};
}
inline M3 block(const M6& a,int row=0,int col=0) {
    M3 b{}; for(int i=0;i<3;++i) for(int j=0;j<3;++j)b[i*3+j]=a[(i+row)*6+j+col]; return b;
}
// Symmetric Jacobi eigensystem, dimensionless convergence relative to matrix
// norm. No absolute variance cutoff: km versus m must not affect validity.
template<size_t N> bool eigen(std::array<double,N*N> a,std::array<double,N>& d,std::array<double,N*N>& v) {
    v.fill(0); double scale=0;
    for(size_t i=0;i<N;++i) {v[i*N+i]=1;for(size_t j=0;j<N;++j) {
        if(!std::isfinite(a[i*N+j]))return false;
        scale=std::max(scale,std::abs(a[i*N+j]));
    }}
    for(size_t i=0;i<N;++i)for(size_t j=i+1;j<N;++j)a[i*N+j]=a[j*N+i]=0.5*(a[i*N+j]+a[j*N+i]);
    for(size_t sweep=0;sweep<100*N*N;++sweep) {
        size_t p=0,q=1; double mx=0;
        for(size_t i=0;i<N;++i)for(size_t j=i+1;j<N;++j)if(std::abs(a[i*N+j])>mx){mx=std::abs(a[i*N+j]);p=i;q=j;}
        if(mx<=std::numeric_limits<double>::epsilon()*scale*4)break;
        double theta=0.5*std::atan2(2*a[p*N+q],a[q*N+q]-a[p*N+p]);
        double c=std::cos(theta),s=std::sin(theta),app=a[p*N+p],aqq=a[q*N+q],apq=a[p*N+q];
        a[p*N+p]=c*c*app-2*c*s*apq+s*s*aqq;
        a[q*N+q]=s*s*app+2*c*s*apq+c*c*aqq;a[p*N+q]=a[q*N+p]=0;
        for(size_t k=0;k<N;++k)if(k!=p&&k!=q){double x=a[k*N+p],y=a[k*N+q];a[k*N+p]=a[p*N+k]=c*x-s*y;a[k*N+q]=a[q*N+k]=s*x+c*y;}
        for(size_t k=0;k<N;++k){double x=v[k*N+p],y=v[k*N+q];v[k*N+p]=c*x-s*y;v[k*N+q]=s*x+c*y;}
    }
    for(size_t i=0;i<N;++i)d[i]=a[i*N+i];return true;
}
inline bool inverse_position(M3 a,double radius,M3& inv,double& determinant,bool& repaired) {
    std::array<double,3>d{};M3 v{};if(!eigen<3>(a,d,v))return false;
    const double floor=std::max(1e-300,std::pow(1e-4*radius,2));
    determinant=1; inv.fill(0);
    for(int k=0;k<3;++k){if(d[k]<floor){d[k]=floor;repaired=true;}determinant*=d[k];
        for(int i=0;i<3;++i)for(int j=0;j<3;++j)inv[3*i+j]+=v[3*i+k]*v[3*j+k]/d[k];}
    return std::isfinite(determinant)&&determinant>0;
}
inline double period(const V6& x,double mu) {
    if(mu<=0)return std::numeric_limits<double>::infinity();
    double r=norm(position(x)), vv=dot(velocity(x),velocity(x));
    double alpha=2/r-vv/mu;
    return alpha>0?2*pi/std::sqrt(mu*alpha*alpha*alpha):std::numeric_limits<double>::infinity();
}
// Two-body universal variables; state and STM propagation are implemented in
// pc_dynamics.cpp, shared by usage diagnostics and fallback integrals.
bool propagate(const V6&,double seconds,double mu,V6&);
bool propagate_covariance(const V6&,const M6&,double,double,V6&,M6&,M6* transition=nullptr);
bool relative_at(const PcEncounter&,double,bool,V6&,M6&);
} // namespace conjunction::pc_detail
#endif
