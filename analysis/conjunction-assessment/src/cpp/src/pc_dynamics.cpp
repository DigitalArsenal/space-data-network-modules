#include "pc_math.h"

namespace conjunction::pc_detail {
namespace {
void stumpff(double z,double& c,double& s) {
    if(std::abs(z)<1e-3) {
        c=0.5;s=1.0/6;double tc=c,ts=s;
        for(int k=1;k<12;++k){tc*=-z/((2*k+1.0)*(2*k+2));ts*=-z/((2*k+2.0)*(2*k+3));c+=tc;s+=ts;}
    } else if(z>0) {double q=std::sqrt(z);c=(1-std::cos(q))/z;s=(q-std::sin(q))/(q*q*q);}
    else {double q=std::sqrt(-z);c=(std::cosh(q)-1)/(-z);s=(std::sinh(q)-q)/(q*q*q);}
}
M6 transform(const M6& a,const M6& c,const M6& b) {
    M6 ac{},out{};
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)for(int k=0;k<6;++k)ac[i*6+j]+=a[i*6+k]*c[k*6+j];
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)for(int k=0;k<6;++k)out[i*6+j]+=ac[i*6+k]*b[j*6+k];
    return out;
}
}

bool propagate(const V6& x,double t,double mu,V6& y) {
    if(!std::isfinite(t)||!std::isfinite(mu)||mu<0)return false;
    for(double value:x)if(!std::isfinite(value))return false;
    if(t==0){y=x;return true;}
    if(mu<=0){y=x;for(int i=0;i<3;++i)y[i]+=t*x[i+3];return true;}
    V3 r=position(x),v=velocity(x);double r0=norm(r);
    if(!(r0>0))return false;
    double rootmu=std::sqrt(mu),alpha=2/r0-dot(v,v)/mu,rv=dot(r,v)/rootmu;
    double chi=rootmu*t*(std::abs(alpha)>1e-8?std::abs(alpha):1/r0);
    double c=0,s=0;bool converged=false;
    for(int k=0;k<100;++k) {
        double z=alpha*chi*chi;stumpff(z,c,s);
        double f=rv*chi*chi*c+(1-alpha*r0)*chi*chi*chi*s+r0*chi-rootmu*t;
        double df=rv*chi*(1-z*s)+(1-alpha*r0)*chi*chi*c+r0;
        double step=f/df;
        if(!std::isfinite(step))return false;
        chi-=step;
        if(std::abs(step)<1e-12*std::max(1.0,std::abs(chi))){converged=true;break;}
    }
    if(!converged)return false;
    stumpff(alpha*chi*chi,c,s);
    double f=1-chi*chi/r0*c,g=t-chi*chi*chi/rootmu*s;
    for(int i=0;i<3;++i)y[i]=f*r[i]+g*v[i];
    double rt=norm(position(y));if(!(rt>0))return false;
    double fd=rootmu/(r0*rt)*chi*(alpha*chi*chi*s-1),gd=1-chi*chi/rt*c;
    for(int i=0;i<3;++i)y[i+3]=fd*r[i]+gd*v[i];
    for(double z:y)if(!std::isfinite(z))return false;
    return true;
}

bool propagate_covariance(const V6& x,const M6& c,double t,double mu,V6& y,M6& out,M6* transition) {
    if(!propagate(x,t,mu,y))return false;
    M6 stm{};
    if(mu<=0||t==0) {
        for(int i=0;i<6;++i)stm[i*6+i]=1;
        for(int i=0;i<3;++i)stm[i*6+i+3]=t;
    } else {
        // Symmetric finite differences of the analytic Kepler flow. The
        // steps are 1 m / 1 mm/s in these km units; a five-point stencil
        // cancels the leading nonlinear derivative error.
        for(int j=0;j<6;++j) {
            double h=j<3?1e-3:1e-6;
            V6 xp=x,xm=x,xpp=x,xmm=x,yp{},ym{},ypp{},ymm{};
            xp[j]+=h;xm[j]-=h;xpp[j]+=2*h;xmm[j]-=2*h;
            if(!propagate(xp,t,mu,yp)||!propagate(xm,t,mu,ym)||!propagate(xpp,t,mu,ypp)||!propagate(xmm,t,mu,ymm))return false;
            for(int i=0;i<6;++i)stm[i*6+j]=(8*(yp[i]-ym[i])-(ypp[i]-ymm[i]))/(12*h);
        }
    }
    out=transform(stm,c,stm);if(transition)*transition=stm;return true;
}

bool relative_at(const PcEncounter& e,double t,bool two_body,V6& mean,M6& covariance) {
    V6 x1{},x2{};M6 c1{},c2{},f1{},f2{};
    double mu=two_body?e.gravitational_parameter:0;
    if(!propagate_covariance(e.primary,e.covariance_primary,t,mu,x1,c1,&f1)||
       !propagate_covariance(e.secondary,e.covariance_secondary,t,mu,x2,c2,&f2))return false;
    for(int i=0;i<6;++i)mean[i]=x2[i]-x1[i];
    for(int i=0;i<36;++i)covariance[i]=c1[i]+c2[i];
    if(e.apply_cross_correlation) {
        auto cross=transform(f1,e.cross_covariance,f2);
        for(int i=0;i<6;++i)for(int j=0;j<6;++j)covariance[i*6+j]-=cross[i*6+j]+cross[j*6+i];
    }
    return true;
}
} // namespace conjunction::pc_detail
