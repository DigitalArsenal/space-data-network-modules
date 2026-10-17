// C3/C5 evidence reduction. All angle and length arithmetic is C++.
// Sources: Orekit 13.1 frame providers, ERFA 2.0.1, FFM native frames.
// Epochs: 50 UTC case samples, exact UTC->TAI->TT/UT1 ERFA two-part dates.
// Matrices are row-major GCRF/EME2000 -> named axes. Distance is the
// worst-direction rotation displacement at LEO/GEO radius, in millimeters.
// 1 mm is the requested comparison target; misses retain their measured value.
#include <array>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <map>
#include <string>
extern "C" {
#include "erfa.h"
#include "erfam.h"
}
using Mat = std::array<double,9>;
struct Sample {double angle=-1; std::string utc;};
struct Score {Sample before, after; int samples=0;};
static std::map<std::string,Score> scores;
static Mat read() {Mat x; for(double& v:x)std::cin>>v; return x;}
static Mat multiply(const Mat& a,const Mat& b) {Mat c{};for(int i=0;i<3;++i)for(int j=0;j<3;++j)for(int k=0;k<3;++k)c[3*i+j]+=a[3*i+k]*b[3*k+j];return c;}
static Mat transpose(const Mat& a) {Mat b;for(int i=0;i<3;++i)for(int j=0;j<3;++j)b[3*i+j]=a[3*j+i];return b;}
static Mat flatten(const double a[3][3]) {Mat b;for(int i=0;i<3;++i)for(int j=0;j<3;++j)b[3*i+j]=a[i][j];return b;}
static double angle(const Mat&a,const Mat&b) {
    double m[3][3]{};for(int i=0;i<3;++i)for(int j=0;j<3;++j)for(int k=0;k<3;++k)m[i][j]+=a[3*i+k]*b[3*j+k];
    const double s=0.5*std::hypot(std::hypot(m[2][1]-m[1][2],m[0][2]-m[2][0]),m[1][0]-m[0][1]);
    return std::atan2(s,0.5*(m[0][0]+m[1][1]+m[2][2]-1));
}
static void score(const std::string& id,const std::string& utc,const Mat&before,const Mat&after,const Mat&ref) {
    Score&s=scores[id];++s.samples;
    const double b=angle(before,ref),a=angle(after,ref);
    if(b>s.before.angle)s.before={b,utc};if(a>s.after.angle)s.after={a,utc};
}
static void put(const Sample&s) {
    const double displacement=2*std::sin(s.angle/2);
    std::printf("{\"mas\":%.17g,\"leoMm\":%.17g,\"geoMm\":%.17g,\"leoTargetMet\":%s,\"geoTargetMet\":%s,\"at\":\"%s\"}",s.angle/ERFA_DMAS2R,displacement*6778137e3,displacement*42164170e3,displacement*6778137e3<=1?"true":"false",displacement*42164170e3<=1?"true":"false",s.utc.c_str());
}
int main(int argc,char**argv) {
    if(argc==2&&std::string(argv[1])=="--trajectories") {
        std::string setting,orbit,forces;double before,after;int count=0,missed=0;
        std::printf("{\"toleranceRationale\":\"User-required no regression beyond 1e-4 m in the maximum hourly 3D GCRF position difference against pinned Orekit 13.1 trajectories. All LEO400/SSO700 rows and all three integration settings.\",\"allowedIncreaseM\":0.0001,\"rows\":[\n");
        while(std::cin>>setting>>orbit>>forces>>before>>after) {
            const bool met=after<=before+1e-4;if(!met)++missed;
            if(count++)std::printf(",\n");
            std::printf("{\"setting\":\"%s\",\"orbit\":\"%s\",\"forces\":\"%s\",\"beforeWorstM\":%.17g,\"afterWorstM\":%.17g,\"increaseM\":%.17g,\"met\":%s}",setting.c_str(),orbit.c_str(),forces.c_str(),before,after,after-before,met?"true":"false");
        }
        std::printf("\n],\"total\":%d,\"missed\":%d}\n",count,missed);return missed?1:0;
    }
    std::string utc,id;
    while(std::cin>>utc>>id) {
        const Mat bp=read(),bn=read(),bt=read(),bc=read(),ap=read(),an=read(),at=read(),ac=read();
        const Mat op=read(),on=read(),ot=read(),oc=read(),ec=read();
        double dut1,xp,yp,dx,dy;std::cin>>dut1>>xp>>yp>>dx>>dy;if(!std::cin)return 2;
        score("coordsMod",utc,bp,ap,op);
        score("coordsTod",utc,multiply(bn,bp),multiply(an,ap),on);
        score("coordsTeme",utc,bt,at,ot);
        score("forceC2tOrekit",utc,bc,ac,oc);
        score("forceC2tErfa",utc,bc,ac,ec);
        if(id=="eop-2026-08")score("forceC2tOrekitLeo400F3",utc,bc,ac,oc);
        if(utc.find("T00:00:00")!=std::string::npos)score("forceC2tOrekitMidnight",utc,bc,ac,oc);
        int y,m,d,h,mi;double sec;
        if(std::sscanf(utc.c_str(),"%d-%d-%dT%d:%d:%lf",&y,&m,&d,&h,&mi,&sec)!=6)return 3;
        double u1,u2,tai1,tai2,tt1,tt2,ut11,ut12;
        if(eraDtf2d("UTC",y,m,d,h,mi,sec,&u1,&u2)<0||eraUtctai(u1,u2,&tai1,&tai2)<0||eraTaitt(tai1,tai2,&tt1,&tt2)||eraUtcut1(u1,u2,dut1,&ut11,&ut12)<0)return 4;
        double x,yc,rci[3][3],rpom[3][3],rct[3][3],rp[3][3],rpn[3][3],rt[3][3];
        eraXy06(tt1,tt2,&x,&yc);const double s=eraS06(tt1,tt2,x,yc);
        eraC2ixys(x+dx,yc+dy,s,rci);eraPom00(xp,yp,eraSp00(tt1,tt2),rpom);eraC2tcio(rci,eraEra00(ut11,ut12),rpom,rct);
        score("orekitErfaSameEop",utc,flatten(rct),flatten(rct),oc);
        score("orekitEopInterpolationSpread",utc,ec,ec,flatten(rct));
        // Diagnostic only: change Orekit's EOP input effect to the case's
        // linear EOP, preserving the independent Orekit celestial series.
        // The unadjusted Orekit rows above remain the primary comparison.
        const Mat aligned=multiply(multiply(ec,transpose(flatten(rct))),oc);
        score("forceC2tOrekitAlignedEop",utc,bc,ac,aligned);
        if(id=="eop-2026-08")score("forceC2tOrekitLeo400F3AlignedEop",utc,bc,ac,aligned);
        eraPmat76(tt1,tt2,rp);eraPnm80(tt1,tt2,rpn);eraCr(rpn,rt);eraRz(eraEqeq94(tt1,tt2),rt);
        score("orekitErfaMod",utc,flatten(rp),flatten(rp),op);
        score("orekitErfaTod",utc,flatten(rpn),flatten(rpn),on);
        score("orekitErfaTeme",utc,flatten(rt),flatten(rt),ot);
    }
    std::printf("{\"rows\":[\n");bool first=true;
    for(const auto&[id,s]:scores){if(!first)std::printf(",\n");first=false;
        std::printf("{\"id\":\"%s\",\"samples\":%d,\"before\":",id.c_str(),s.samples);put(s.before);std::printf(",\"after\":");put(s.after);std::printf("}");}
    std::printf("\n]}\n");return 0;
}
