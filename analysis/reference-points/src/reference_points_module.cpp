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
// Area where two disks of angular radii a and b, centres c apart, overlap.
static double disk_overlap(double a,double b,double c) {
    if (c>=a+b) return 0.0;
    if (c<=std::fabs(a-b)) return pi*std::min(a,b)*std::min(a,b);
    double ca=std::clamp((c*c+a*a-b*b)/(2*c*a),-1.0,1.0),cb=std::clamp((c*c+b*b-a*a)/(2*c*b),-1.0,1.0);
    double kite=0.5*std::sqrt((-c+a+b)*(c+a-b)*(c-a+b)*(c+a+b));
    return a*a*std::acos(ca)+b*b*std::acos(cb)-kite;
}
// Grid of points around an origin, axes from the Sun-Earth line and the ecliptic pole. Each value is the
// fraction of the Sun's disc a point sees unblocked by the Moon: 1 lit, 0 in the Moon's umbra, between in its penumbra.
// Output: out[0..8] row-major 3x3 whose columns are the grid axes in the output frame, out[9..11] the origin in
// the output frame, then nx*ny*nz values with index (k*ny+j)*nx+i. Inputs are ICRF metres relative to one origin.
SSB_EXPORT("rp_occultation_grid") int32_t rp_occultation_grid(const double* sun,const double* earth,const double* moon,const double* origin,const double* R,double sunRadius,double moonRadius,double spacing,uint32_t nx,uint32_t ny,uint32_t nz,double* out,uint32_t cap) {
    if (!valid(sun,3)||!valid(earth,3)||!valid(moon,3)||!valid(origin,3)||!matrix(R)||!out) return -1;
    if (!positive(sunRadius)||!positive(moonRadius)||!positive(spacing)||!nx||!ny||!nz) return -1;
    uint64_t count=uint64_t(nx)*ny*nz;
    if (count+12>cap) return -2;
    Vec x,z,y;
    if (!unit(vec(earth)-vec(sun),x)) return -1;
    const double obliquity=0.40909280422232897;
    Vec pole={0,-std::sin(obliquity),std::cos(obliquity)};
    double along=pole.x*x.x+pole.y*x.y+pole.z*x.z;
    if (!unit(pole-x*along,z)) return -1;
    y=cross(z,x);
    Vec xo=rotate(R,x),yo=rotate(R,y),zo=rotate(R,z),oo=rotate(R,vec(origin));
    out[0]=xo.x;out[1]=yo.x;out[2]=zo.x;out[3]=xo.y;out[4]=yo.y;out[5]=zo.y;out[6]=xo.z;out[7]=yo.z;out[8]=zo.z;
    out[9]=oo.x;out[10]=oo.y;out[11]=oo.z;
    const double hx=(nx-1)/2.0,hy=(ny-1)/2.0,hz=(nz-1)/2.0;
    for (uint32_t k=0;k<nz;++k) for (uint32_t j=0;j<ny;++j) for (uint32_t i=0;i<nx;++i) {
        Vec p=vec(origin)+x*((i-hx)*spacing)+y*((j-hy)*spacing)+z*((k-hz)*spacing);
        Vec toSun=vec(sun)-p,toMoon=vec(moon)-p;
        double ds=norm(toSun),dm=norm(toMoon);
        if (!(ds>sunRadius)||!(dm>moonRadius)) return -3;
        double a=std::asin(sunRadius/ds),b=std::asin(moonRadius/dm);
        double c=std::atan2(norm(cross(toSun,toMoon)),toSun.x*toMoon.x+toSun.y*toMoon.y+toSun.z*toMoon.z);
        double visible=1.0-disk_overlap(a,b,c)/(pi*a*a);
        out[12+(uint64_t(k)*ny+j)*nx+i]=std::clamp(visible,0.0,1.0);
    }
    if (!valid(out,unsigned(12+count))) return -1;
    return 0;
}
// Van Allen radiation belts as a volume about the Earth (owner 2026-10-28: the belts as a volume with NASA's
// colours). Each value is the normalized belt intensity at a grid point (1 at the inner belt's peak), from the
// McIlwain L-shell about the geomagnetic dipole: L = r / cos^2(magnetic latitude). The inner (proton) belt peaks
// near L = 1.5; the outer (electron) belt near L = 4.3 at about half that. Approximate model shapes, not
// calibrated flux. Output: nx*ny*nz values, index (k*ny+j)*nx+i, grid centred on the Earth's centre.
SSB_EXPORT("rp_radiation_grid") int32_t rp_radiation_grid(const double* axis,double spacing,uint32_t nx,uint32_t ny,uint32_t nz,double* out,uint32_t cap) {
    const double earthRadius=6378137.0;
    Vec m;
    if (!valid(axis,3)||!unit(vec(axis),m)||!positive(spacing)||!nx||!ny||!nz||!out) return -1;
    uint64_t count=uint64_t(nx)*ny*nz;
    if (count>cap) return -2;
    const double hx=(nx-1)/2.0,hy=(ny-1)/2.0,hz=(nz-1)/2.0;
    for (uint32_t k=0;k<nz;++k) for (uint32_t j=0;j<ny;++j) for (uint32_t i=0;i<nx;++i) {
        Vec p={(i-hx)*spacing,(j-hy)*spacing,(k-hz)*spacing};
        double distance=norm(p),r=distance/earthRadius,value=0.0;
        if (r>=1.0) {
            double sinLatitude=(p.x*m.x+p.y*m.y+p.z*m.z)/distance;
            double shell=r/(1.0-sinLatitude*sinLatitude);
            double inner=std::exp(-std::pow((shell-1.5)/0.22,2));
            double outer=0.55*std::exp(-std::pow((shell-4.3)/1.1,2));
            value=std::clamp(std::max(inner,outer),0.0,1.0);
        }
        out[(uint64_t(k)*ny+j)*nx+i]=value;
    }
    if (!valid(out,unsigned(count))) return -1;
    return 0;
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

// Schmidt quasi-normal P_n^m(cos theta) and its theta derivative Q_n^m for n <= nmax: the recurrence of the IGRF
// reference routine (igrf14syn). Stack only.
static void schmidt_legendre(uint32_t nmax,double ct,double st,double (&P)[14][14],double (&Q)[14][14]) {
    P[0][0]=1;Q[0][0]=0;
    for (uint32_t n=1;n<=nmax;++n) for (uint32_t m=0;m<=n;++m) {
        if (m==n) {
            if (n==1) {P[1][1]=st;Q[1][1]=ct;}
            else {
                double one=std::sqrt(1.0-0.5/m);
                P[n][n]=one*st*P[n-1][n-1];
                Q[n][n]=one*(st*Q[n-1][n-1]+ct*P[n-1][n-1]);
            }
        } else {
            double fn=n,gn=n-1,gmm=double(m)*m;
            double one=std::sqrt(fn*fn-gmm),two=std::sqrt(gn*gn-gmm)/one,three=(fn+gn)/one;
            double p2=m+2<=n?P[n-2][m]:0.0,q2=m+2<=n?Q[n-2][m]:0.0;
            P[n][m]=three*ct*P[n-1][m]-two*p2;
            Q[n][m]=three*(ct*Q[n-1][m]-st*P[n-1][m])-two*q2;
        }
    }
}
// IGRF main-field total intensity (nT) at a grid of geocentric points (owner 2026-10-28). g and h hold one epoch's
// Schmidt semi-normalised Gauss coefficients: entry n(n+1)/2+m-1 for 1<=n<=nmax, 0<=m<=n (h at m=0 is ignored), so
// the first nmax(nmax+3)/2 entries of each are used; nmax is at most 13. The synthesis is the reference routine's
// geocentric branch: at radius r the coefficients scale by (referenceRadius/r)^(n+2) (referenceRadius 6371200 m for
// the IGRF). Row i is the geocentric colatitude colatitude[i] (radians, strictly between 0 and pi) at radius
// radius[i] (metres); column j is longitude -180+(j+0.5)*360/nLon; out[i*nLon+j] holds the value. Capacity is in cells.
SSB_EXPORT("rp_geomagnetic_intensity_grid") int32_t rp_geomagnetic_intensity_grid(const double* g,const double* h,uint32_t nmax,double referenceRadius,const double* colatitude,const double* radius,uint32_t nLat,uint32_t nLon,double* out,uint32_t cap) {
    if (!g||!h||!colatitude||!radius||!out||!nmax||nmax>13||!nLat||!nLon) return -1;
    if (!positive(referenceRadius)) return -1;
    uint64_t count=uint64_t(nLat)*nLon;
    if (count>cap) return -2;
    const uint32_t terms=nmax*(nmax+3)/2;
    if (!valid(g,terms)||!valid(h,terms)||!valid(colatitude,nLat)||!valid(radius,nLat)) return -1;
    for (uint32_t i=0;i<nLat;++i) if (!(colatitude[i]>0&&colatitude[i]<pi)||!positive(radius[i])) return -1;
    double P[14][14],Q[14][14],cl[14],sl[14];
    for (uint32_t i=0;i<nLat;++i) {
        // Colatitudes lie strictly between the poles, so sin(colatitude) > 0.
        const double ct=std::cos(colatitude[i]),st=std::sin(colatitude[i]),ratio=referenceRadius/radius[i];
        schmidt_legendre(nmax,ct,st,P,Q);
        for (uint32_t j=0;j<nLon;++j) {
            const double longitude=-pi+(j+0.5)*2*pi/nLon;
            cl[1]=std::cos(longitude);sl[1]=std::sin(longitude);
            for (uint32_t m=2;m<=nmax;++m) {cl[m]=cl[m-1]*cl[1]-sl[m-1]*sl[1];sl[m]=sl[m-1]*cl[1]+cl[m-1]*sl[1];}
            double x=0,y=0,z=0,rr=ratio*ratio;
            for (uint32_t n=1;n<=nmax;++n) {
                rr*=ratio;
                const double fn=double(n)+1;
                for (uint32_t m=0;m<=n;++m) {
                    const uint32_t k=n*(n+1)/2+m-1;
                    const double gv=g[k]*rr;
                    if (!m) {x+=gv*Q[n][0];z-=fn*gv*P[n][0];continue;}
                    const double hv=h[k]*rr,three=gv*cl[m]+hv*sl[m];
                    x+=three*Q[n][m];z-=fn*three*P[n][m];
                    y+=(gv*sl[m]-hv*cl[m])*m*P[n][m]/st;
                }
            }
            out[uint64_t(i)*nLon+j]=std::sqrt(x*x+y*y+z*z);
        }
    }
    if (!valid(out,unsigned(count))) return -1;
    return 0;
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
