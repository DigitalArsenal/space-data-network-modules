#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

namespace rp {
constexpr double pi = 3.1415926535897932384626433832795;
constexpr double au = 149597870700.0;
struct Vec {
    double x, y, z;
    Vec operator+(Vec b) const { return {x+b.x,y+b.y,z+b.z}; }
    Vec operator-(Vec b) const { return {x-b.x,y-b.y,z-b.z}; }
    Vec operator*(double s) const { return {x*s,y*s,z*s}; }
};
inline bool is_finite(double x) { return std::isfinite(x); }
inline bool valid(const double* p, unsigned n) {
    if (!p) return false;
    for (unsigned i=0;i<n;++i) if (!is_finite(p[i])) return false;
    return true;
}
inline Vec vec(const double* p) { return {p[0],p[1],p[2]}; }
inline double norm(Vec a) { return std::hypot(a.x,a.y,a.z); }
inline Vec cross(Vec a, Vec b) { return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x}; }
inline bool unit(Vec a, Vec& b) {
    double n=norm(a);
    if (!(n>0) || !is_finite(n)) return false;
    b={a.x/n,a.y/n,a.z/n}; return true;
}
inline Vec rotate(const double* R, Vec a, bool transpose=false) {
    if (!R) return a;
    if (transpose) return {R[0]*a.x+R[3]*a.y+R[6]*a.z,R[1]*a.x+R[4]*a.y+R[7]*a.z,R[2]*a.x+R[5]*a.y+R[8]*a.z};
    return {R[0]*a.x+R[1]*a.y+R[2]*a.z,R[3]*a.x+R[4]*a.y+R[5]*a.z,R[6]*a.x+R[7]*a.y+R[8]*a.z};
}
inline bool matrix(const double* R) { return !R || valid(R,9); }
inline void put(double* out, Vec a) { out[0]=a.x;out[1]=a.y;out[2]=a.z; }
inline bool basis(Vec pole, Vec& u, Vec& v, Vec& w) {
    if (!unit(pole,w)) return false;
    const double x=std::abs(w.x), y=std::abs(w.y), z=std::abs(w.z);
    Vec ref = x<=y && x<=z ? Vec{1,0,0} : y<=z ? Vec{0,1,0} : Vec{0,0,1};
    if (!unit(cross(ref,w),u)) return false;
    v=cross(w,u);return true;
}
inline bool positive(double x) { return is_finite(x) && x>0; }
inline bool ratio(double a,double b,double& mu) {
    if (!positive(a)||!positive(b)||b>a) return false;
    const double q=b/a;mu=q/(1+q);return mu>0;
}
inline double force(double x,double mu) {
    double a=x+mu,b=x-(1-mu);
    return x-(1-mu)*std::copysign(1/(a*a),a)-mu*std::copysign(1/(b*b),b);
}
// F is strictly increasing on each interval between singularities. Safeguarded
// Newton solves the equivalent force-balance quintics without polynomial cancellation.
inline double root(double mu,double lo,double hi) {
    double x=(lo+hi)/2,best=x,error=std::numeric_limits<double>::infinity();
    for (int i=0;i<256;++i) {
        double f=force(x,mu);
        if (std::abs(f)<error) {best=x;error=std::abs(f);}
        if (f==0) return x;
        if (f<0) lo=x;else hi=x;
        if (std::nextafter(lo,hi)>=hi) break;
        double a=std::abs(x+mu),b=std::abs(x-(1-mu));
        double derivative=1+2*(1-mu)/(a*a*a)+2*mu/(b*b*b);
        double next=x-f/derivative;
        if (!is_finite(next)||next<=lo||next>=hi||next==x) next=lo+(hi-lo)/2;
        x=next;
    }
    for (double candidate : {lo,hi}) if (std::abs(force(candidate,mu))<error) {
        best=candidate;error=std::abs(force(candidate,mu));
    }
    return best;
}
inline bool collinear(double mu,double* out) {
    if (!is_finite(mu)||mu<=0||mu>0.5||!out) return false;
    const double p=-mu,s=1-mu;
    out[0]=root(mu,std::nextafter(p,s),std::nextafter(s,p));
    out[1]=root(mu,std::nextafter(s,2.0),2.0);
    out[2]=root(mu,-2.0,std::nextafter(p,-2.0));return true;
}
struct Wire {
    Vec center,u,v,w;const double* R;double* out;uint32_t count=0;
    bool init(const double* c,const double* pole,const double* rotation,double* output) {
        if (!valid(c,3)||!valid(pole,3)||!matrix(rotation)||!output) return false;
        center=vec(c);R=rotation;out=output;return basis(vec(pole),u,v,w);
    }
    void point(Vec local) {put(out+3*count++,rotate(R,center+local));}
    void ring(double radius,double s,uint32_t samples,bool extra) {
        const uint32_t n=extra?samples+1:samples;
        for (uint32_t j=0;j<n;++j) {
            double angle=2*pi*(j==n-1?0.0:double(j)/(n-1));
            point(w*s+(u*std::cos(angle)+v*std::sin(angle))*radius);
        }
    }
    void separator() { if (!count) return;const double n=std::numeric_limits<double>::quiet_NaN();put(out+3*count++,{n,n,n}); }
};
inline int capacity(uint64_t n,uint32_t cap) {return n>cap||n>INT32_MAX?-2:0;}
inline uint64_t strips(uint64_t n,uint32_t samples) {
    if (!n) return 0;
    const uint64_t width=uint64_t(samples)+1;
    if (n>(uint64_t(INT32_MAX)+1)/width) return uint64_t(INT32_MAX)+1;
    return n*width-1;
}
inline bool ellipsoid(const double* direction,const double* rot,const double* radii,const double* center,const double* R,Vec& s) {
    return valid(direction,3)&&matrix(rot)&&valid(radii,3)&&positive(radii[0])&&positive(radii[1])&&positive(radii[2])&&valid(center,3)&&matrix(R)&&unit(rotate(rot,vec(direction)),s);
}
} // namespace rp
