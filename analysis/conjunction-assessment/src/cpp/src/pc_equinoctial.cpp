#include "pc_hall.h"

namespace conjunction::pc_detail {
namespace {
bool from_elements(const V6& e,double t,double mu,V6& x) {
    double n=e[0],af=e[1],ag=e[2],chi=e[3],psi=e[4];
    if(!(n>0)||af*af+ag*ag>=1)return false;
    double a=std::cbrt(mu/(n*n)),b=1/(1+std::sqrt(1-af*af-ag*ag));
    double den=1+chi*chi+psi*psi;
    V3 f={(1-chi*chi+psi*psi)/den,2*chi*psi/den,-2*chi/den};
    V3 g={2*chi*psi/den,(1+chi*chi-psi*psi)/den,2*psi/den};
    double lambda=std::remainder(e[5]+n*t,2*pi),F=lambda;
    bool solved=false;
    for(int iter=0;iter<40;++iter) {
        double step=(F+ag*std::cos(F)-af*std::sin(F)-lambda)/(1-ag*std::sin(F)-af*std::cos(F));
        F-=step;if(std::abs(step)<1e-14){solved=true;break;}
    }
    if(!solved)return false;
    double co=std::cos(F),si=std::sin(F),cross=af*ag*b;
    double xx=a*((1-ag*ag*b)*co+cross*si-af),yy=a*((1-af*af*b)*si+cross*co-ag);
    double fac=n*a/(1-af*co-ag*si);
    double vx=fac*(cross*co-(1-ag*ag*b)*si),vy=fac*((1-af*af*b)*co-cross*si);
    for(int i=0;i<3;++i){x[i]=xx*f[i]+yy*g[i];x[i+3]=vx*f[i]+vy*g[i];}
    return true;
}
}
bool cartesian_to_equinoctial(const V6& x,double mu,V6& e) {
    V3 r=position(x),v=velocity(x);double rr=norm(r),vv=dot(v,v),rv=dot(r,v);
    if(!(rr>0)||!(mu>0))return false;
    double alpha=2/rr-vv/mu;if(!(alpha>0))return false;
    double a=1/alpha,n=std::sqrt(mu/(a*a*a));
    V3 h={r[1]*v[2]-r[2]*v[1],r[2]*v[0]-r[0]*v[2],r[0]*v[1]-r[1]*v[0]};
    double hh=norm(h);if(!(hh>0)||1+h[2]/hh<1e-10)return false;
    double chi=h[0]/(hh+h[2]),psi=-h[1]/(hh+h[2]),den=1+chi*chi+psi*psi;
    V3 f={(1-chi*chi+psi*psi)/den,2*chi*psi/den,-2*chi/den};
    V3 g={2*chi*psi/den,(1+chi*chi-psi*psi)/den,2*psi/den},ev{};
    for(int i=0;i<3;++i)ev[i]=((vv-mu/rr)*r[i]-rv*v[i])/mu;
    double af=dot(f,ev),ag=dot(g,ev),esq=af*af+ag*ag;if(esq>=1)return false;
    double root=std::sqrt(1-esq),b=1/(1+root),xx=dot(f,r),yy=dot(g,r);
    double si=ag+((1-ag*ag*b)*yy-af*ag*b*xx)/(a*root);
    double co=af+((1-af*af*b)*xx-af*ag*b*yy)/(a*root);
    e={n,af,ag,chi,psi,std::atan2(si,co)+ag*co-af*si};return true;
}
bool equinoctial_state(const V6& e,double t,double mu,V6& x,M6* jacobian) {
    if(!from_elements(e,t,mu,x))return false;
    if(!jacobian)return true;
    for(int j=0;j<6;++j) {
        double h=j==0?e[0]*1e-5:1e-5;
        V6 ep=e,em=e,epp=e,emm=e,yp{},ym{},ypp{},ymm{};
        ep[j]+=h;em[j]-=h;epp[j]+=2*h;emm[j]-=2*h;
        if(!from_elements(ep,t,mu,yp)||!from_elements(em,t,mu,ym)||!from_elements(epp,t,mu,ypp)||!from_elements(emm,t,mu,ymm))return false;
        for(int i=0;i<6;++i)(*jacobian)[i*6+j]=(8*(yp[i]-ym[i])-(ypp[i]-ymm[i]))/(12*h);
    }
    return true;
}
bool inverse6(const M6& input,M6& inverse) {
    std::array<double,72> a{};
    for(int i=0;i<6;++i){for(int j=0;j<6;++j)a[i*12+j]=input[i*6+j];a[i*12+i+6]=1;}
    for(int j=0;j<6;++j) {
        int pivot=j;for(int i=j+1;i<6;++i)if(std::abs(a[i*12+j])>std::abs(a[pivot*12+j]))pivot=i;
        if(!(std::abs(a[pivot*12+j])>0))return false;
        for(int k=0;k<12;++k)std::swap(a[j*12+k],a[pivot*12+k]);
        double p=a[j*12+j];for(int k=0;k<12;++k)a[j*12+k]/=p;
        for(int i=0;i<6;++i)if(i!=j){double f=a[i*12+j];for(int k=0;k<12;++k)a[i*12+k]-=f*a[j*12+k];}
    }
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)inverse[i*6+j]=a[i*12+j+6];return true;
}
M6 covariance_transform(const M6& a,const M6& c,const M6& b) {
    M6 ac{},out{};
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)for(int k=0;k<6;++k)ac[i*6+j]+=a[i*6+k]*c[k*6+j];
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)for(int k=0;k<6;++k)out[i*6+j]+=ac[i*6+k]*b[j*6+k];return out;
}
} // namespace conjunction::pc_detail
