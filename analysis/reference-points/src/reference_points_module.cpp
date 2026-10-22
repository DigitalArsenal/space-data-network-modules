#include "space_data_module_invoke.h"
#include "reference_points.hpp"
#define SSB_EXPORT(name) __attribute__((export_name(name))) extern "C"
using namespace rp;

SSB_EXPORT("rp_abi_version") int32_t rp_abi_version() {return 1;}
SSB_EXPORT("rp_collinear") int32_t rp_collinear(double mu,double* out) {return collinear(mu,out)?0:-1;}
SSB_EXPORT("rp_lagrange") int32_t rp_lagrange(const double* p,const double* s,double gp,double gs,const double* R,double* out) {
    double mu,x[3];Vec ex,ey,ez;
    if (!valid(p,6)||!valid(s,6)||!matrix(R)||!out||!ratio(gp,gs,mu)) return -1;
    Vec delta=vec(s)-vec(p),velocity=vec(s+3)-vec(p+3);
    const double d=norm(delta);
    if (!unit(delta,ex)||!unit(velocity,ey)||!unit(cross(ex,ey),ez)) return -1;
    ey=cross(ez,ex);collinear(mu,x);
    Vec offsets[5]={delta*(x[0]+mu),delta*(x[1]+mu),delta*(x[2]+mu),
        (ex*0.5+ey*(std::sqrt(3.0)/2))*d,(ex*0.5-ey*(std::sqrt(3.0)/2))*d};
    double result[27];
    for (int i=0;i<5;++i) {
        put(result+3*i,rotate(R,vec(p)+offsets[i]));
        result[17+2*i]=norm(offsets[i]);result[18+2*i]=norm(offsets[i]-delta);
    }
    result[15]=mu;result[16]=d;
    if (!valid(result,27)) return -1;
    std::copy(result,result+27,out);return 0;
}
SSB_EXPORT("rp_influence") int32_t rp_influence(const double* p,const double* b,double gp,double gb,double* out) {
    if (!valid(p,6)||!valid(b,6)||!positive(gp)||!positive(gb)||!out) return -1;
    double d=norm(vec(b)-vec(p)),q=gb/gp;
    double result[3]={d,d*std::cbrt(q/3),d*std::pow(q,0.4)};
    if (!positive(d)||!positive(q)||!valid(result,3)) return -1;
    std::copy(result,result+3,out);return 0;
}
SSB_EXPORT("rp_shadow") int32_t rp_shadow(const double* sun,const double* body,double rs,double rb,double* out) {
    Vec axis;
    if (!valid(sun,3)||!valid(body,3)||!positive(rs)||!positive(rb)||rs<=rb||!out||!unit(vec(body)-vec(sun),axis)) return -1;
    double d=norm(vec(body)-vec(sun));if (!(d>rs+rb)) return -1;
    double u=(rs-rb)/d,p=(rs+rb)/d;
    double result[8]={axis.x,axis.y,axis.z,d,rb/u,rb/p,u/std::sqrt((1-u)*(1+u)),p/std::sqrt((1-p)*(1+p))};
    if (!valid(result,8)) return -1;
    std::copy(result,result+8,out);return 0;
}
SSB_EXPORT("rp_wire_circle") int32_t rp_wire_circle(const double* c,const double* pole,const double* R,double radius,uint32_t samples,double* out,uint32_t cap) {
    Wire w;if (!w.init(c,pole,R,out)||!positive(radius)||samples<3) return -1;
    if (capacity(uint64_t(samples)+1,cap)) return -2;
    w.ring(radius,0,samples,true);return w.count;
}
SSB_EXPORT("rp_wire_sphere") int32_t rp_wire_sphere(const double* c,const double* pole,const double* R,double radius,uint32_t parallels,uint32_t meridians,uint32_t samples,double* out,uint32_t cap) {
    Wire w;if (!w.init(c,pole,R,out)||!positive(radius)||samples<4||(!parallels&&!meridians)) return -1;
    if (capacity(strips(uint64_t(parallels)+meridians,samples),cap)) return -2;
    for (uint32_t i=0;i<parallels;++i) {
        w.separator();double lat=-pi/2+pi*(double(i)+1)/(double(parallels)+1);
        w.ring(radius*std::cos(lat),radius*std::sin(lat),samples,false);
    }
    for (uint32_t i=0;i<meridians;++i) {
        w.separator();double lon=2*pi*i/meridians;Vec radial=w.u*std::cos(lon)+w.v*std::sin(lon);
        for (uint32_t j=0;j<samples;++j) {double lat=-pi/2+pi*j/(samples-1);w.point((radial*std::cos(lat)+w.w*std::sin(lat))*radius);}
    }
    return w.count;
}
SSB_EXPORT("rp_wire_cone") int32_t rp_wire_cone(const double* c,const double* axis,const double* R,double r0,double slope,double s0,double s1,uint32_t rings,uint32_t generators,uint32_t samples,double* out,uint32_t cap) {
    Wire w;if (!w.init(c,axis,R,out)||!is_finite(r0)||!is_finite(slope)||!is_finite(s0)||!is_finite(s1)||s1<=s0||rings==1||(!rings&&!generators)||samples<4||!is_finite(r0+slope*s0)||!is_finite(r0+slope*s1)) return -1;
    if (capacity(strips(rings,samples)+uint64_t(generators)*3-(rings?0:generators?1:0),cap)) return -2;
    for (uint32_t i=0;i<rings;++i) {w.separator();double s=s0+(s1-s0)*i/(rings-1);w.ring(std::max(0.0,r0+slope*s),s,samples,false);}
    for (uint32_t i=0;i<generators;++i) {
        w.separator();double lon=2*pi*i/generators;Vec radial=w.u*std::cos(lon)+w.v*std::sin(lon);
        for (double s : {s0,s1}) w.point(w.w*s+radial*std::max(0.0,r0+slope*s));
    }
    return w.count;
}
SSB_EXPORT("rp_wire_dipole") int32_t rp_wire_dipole(const double* c,const double* pole,const double* R,double radius,double L,uint32_t meridians,uint32_t samples,double* out,uint32_t cap) {
    Wire w;if (!w.init(c,pole,R,out)||!positive(radius)||!is_finite(L)||L<1||!is_finite(radius*L)||!meridians||samples<2) return -1;
    if (capacity(strips(meridians,samples),cap)) return -2;
    double limit=std::acos(1/std::sqrt(L));
    for (uint32_t i=0;i<meridians;++i) {
        w.separator();double lon=2*pi*i/meridians;Vec radial=w.u*std::cos(lon)+w.v*std::sin(lon);
        for (uint32_t j=0;j<samples;++j) {double lat=-limit+2*limit*j/(samples-1),co=std::cos(lat);w.point((radial*co+w.w*std::sin(lat))*(L*radius*co*co));}
    }
    return w.count;
}
SSB_EXPORT("rp_terminator") int32_t rp_terminator(const double* sun,const double* rot,const double* radii,const double* c,const double* R,uint32_t samples,double* out,uint32_t cap) {
    Vec s,u,v,w;if (!out||samples<3||!ellipsoid(sun,rot,radii,c,R,s)) return -1;
    // Scale to the unit sphere: n_body.p = 0 becomes (s_i/a_i).q = 0.
    if (!basis({s.x/radii[0],s.y/radii[1],s.z/radii[2]},u,v,w)) return -1;
    if (capacity(uint64_t(samples)+1,cap)) return -2;
    for (uint32_t j=0;j<=samples;++j) {
        double angle=2*pi*(j==samples?0.0:double(j)/samples);Vec q=u*std::cos(angle)+v*std::sin(angle);
        Vec p={radii[0]*q.x,radii[1]*q.y,radii[2]*q.z};put(out+3*j,rotate(R,vec(c)+rotate(rot,p,true)));
    }
    return samples+1;
}
SSB_EXPORT("rp_sub_point") int32_t rp_sub_point(const double* target,const double* rot,const double* radii,const double* c,const double* R,double* out) {
    Vec s;if (!out||!ellipsoid(target,rot,radii,c,R,s)) return -1;
    double scale=std::hypot(s.x/radii[0],s.y/radii[1],s.z/radii[2]);
    if (!positive(scale)) return -1;
    Vec p=s*(1/scale),n={p.x/radii[0]/radii[0],p.y/radii[1]/radii[1],p.z/radii[2]/radii[2]};
    double lon=std::atan2(p.y,p.x)*180/pi;if (lon<=-180) lon=180;
    Vec position=rotate(R,vec(c)+rotate(rot,p,true));
    double result[6]={position.x,position.y,position.z,lon,std::atan2(n.z,std::hypot(n.x,n.y))*180/pi,norm(vec(target))};
    if (!valid(result,6)) return -1;
    std::copy(result,result+6,out);return 0;
}
SSB_EXPORT("rp_region") int32_t rp_region(int32_t kind,double* out) {
    if (!out) return -1;
    switch (kind) {
        case 0: out[0]=5.20288700*au*std::pow(0.25,2.0/3);out[1]=5.20288700*au*std::pow(0.5,2.0/3);break;
        case 1: out[0]=30*au;out[1]=50*au;break;
        case 2: out[0]=out[1]=0.5*(94.0+83.7)*au;break;
        case 3: out[0]=out[1]=120.3*au;break;
        case 4: out[0]=1+1000/6378.137;out[1]=1+6000/6378.137;break;
        case 5: out[0]=1+13000/6378.137;out[1]=1+60000/6378.137;break;
        default: return -1;
    }return 0;
}
SSB_EXPORT("rp_geomagnetic_axis") int32_t rp_geomagnetic_axis(double* out) {
    if (!out) return -1;Vec axis;unit({1450.9,-4652.5,29404.8},axis);put(out,axis);return 0;
}

// SDK discovery only: the geometry ABI above never serializes or allocates.
extern "C" int describe() {
    flatbuffers::FlatBufferBuilder b;
    const auto version=b.CreateString("0.1.0");
    const auto value=CreatePCEParameterValue(b,pceParameter::PROVIDER_DEFINED,b.CreateString("version"),pceResultStatus::OK,0,0,0,0,version,pceUnit::PROVIDER_DEFINED);
    const auto values=b.CreateVector(&value,1);
    const auto sample=CreatePCEParameterSample(b,0,0,values);
    const auto samples=b.CreateVector(&sample,1);
    const auto result=CreatePCEEvaluationResult(b,pceResultStatus::OK,0,samples);
    FinishPCEBuffer(b,CreatePCE(b,0,0,result));
    return plugin_push_output("result","PCE.fbs","$PCE",b.GetBufferPointer(),b.GetSize())<0?1:0;
}
