// Source/units/frame/time/tolerance metadata: docs/reference-frames.md and
// body_orientation_reference.json. Independent SOFA cookbook printed matrices,
// Vallado printed state, CSPICE pxform matrices, and rational closed forms.
#include "axis_engine.hpp"
#include <cstdio>
namespace lane08 {
using namespace sdn::frames;
struct BodyReference { int body; double days; Mat3 expected; double tolerance; };
#include "body_reference_cases.inc"
int frameReferenceChecks(bool verbose) {
  int failures=0,checks=0;
  auto check=[&](const char* name,double error,double tolerance) {
    ++checks; bool ok=std::isfinite(error)&&std::fabs(error)<=tolerance;
    failures+=!ok;
    if(verbose) std::printf("%s %s error=%.17g tolerance=%.1e\n",ok?"PASS":"FAIL",name,error,tolerance);
  };
  auto diff=[](const Mat3&a,const Mat3&b) {
    double e=0; for(int i=0;i<3;++i)for(int j=0;j<3;++j) {
      if(!std::isfinite(a.m[i][j])) return HUGE_VAL;
      e=std::fmax(e,std::fabs(a.m[i][j]-b.m[i][j]));
    } return e;
  };
  auto vdiff=[](const Vec3&a,const Vec3&b) {
    return std::fmax(std::fabs(a.x-b.x),std::fmax(std::fabs(a.y-b.y),std::fabs(a.z-b.z)));
  };
  auto proper=[&](const Mat3&r) {check("proper rotation",diff(multiply(r,transpose(r)),identity()),1e-14);};
  EarthOrientation eop; eop.dut1=-.072073685;
  eop.xPole=.0349282*ERFA_DAS2R; eop.yPole=.4833163*ERFA_DAS2R;
  Epoch epoch; check("cookbook epoch accepted",!epochFromUtc(2007,4,5,12,0,0,eop,&epoch),0);
  eop.dPsi=-.0550655*ERFA_DAS2R; eop.dEpsilon=-.0063580*ERFA_DAS2R;
  const Mat3 ref96{{{.973104317712772,.230363826174782,-.000703163477127},
    {-.230363800391868,.973104570648022,.000118545116892},
    {.000711560100206,.000046626645796,.999999745754058}}};
  Mat3 r;
  check("1996 selected",!celestialToItrf(AxisType::GCRF_1996,epoch,eop,&r),0);
  check("SOFA5.2 IERS1996",diff(r,ref96),1e-12);proper(r);
  eop.dX=.0001725*ERFA_DAS2R;eop.dY=-.0002650*ERFA_DAS2R;
  const Mat3 ref03{{{.973104317697618,.230363826238780,-.000703163482352},
    {-.230363800455689,.973104570632883,.000118545366826},
    {.000711560162864,.000046626403835,.999999745754024}}};
  check("2003 selected",!celestialToItrf(AxisType::GCRF_2003,epoch,eop,&r),0);
  check("SOFA5.4 IERS2003",diff(r,ref03),1e-12);proper(r);
  eop.dX=.0001750*ERFA_DAS2R;eop.dY=-.0002259*ERFA_DAS2R;
  const Mat3 ref06{{{.973104317697536,.230363826239128,-.000703163481769},
    {-.230363800456036,.973104570632801,.000118545368117},
    {.000711560162594,.000046626402444,.999999745754024}}};
  check("2006 selected",!celestialToItrf(AxisType::ICRF,epoch,eop,&r),0);
  check("SOFA5.6 IERS2010",diff(r,ref06),1e-12);
  check("invalid Earth convention refused",celestialToItrf(AxisType::VNC,epoch,eop,&r),0);
  check("null Earth output refused",celestialToItrf(AxisType::ICRF,epoch,eop,nullptr),0);
  // TN21 fixed-ecliptic precession rate coefficients, 1 Julian century TT.
  Epoch century{ERFA_DJ00,ERFA_DJC,ERFA_DJ00,ERFA_DJC}; double dp,dw;
  iers1996PrecessionRateCorrections(century,&dp,&dw);
  check("TN21 delta psi_A rad",dp-(-.2957*ERFA_DAS2R),1e-21);
  check("TN21 delta omega_A rad",dw-(-.0227*ERFA_DAS2R),1e-21);
  // Vallado historical UT1 collapse is deliberate; see documented rationale.
  EarthOrientation ve;ve.dut1=-.4399619;ve.xPole=-.140682*ERFA_DAS2R;ve.yPole=.333309*ERFA_DAS2R;
  ve.dPsi=-.052195*ERFA_DAS2R;ve.dEpsilon=-.003875*ERFA_DAS2R;
  Epoch vallado;check("Vallado epoch accepted",!epochFromUtc(2004,4,6,7,51,28.386009,ve,&vallado),0);
  vallado.ut11=2453101.827406783;vallado.ut12=0;
  const Vec3 itrf{-1033.4793830,7901.2952754,6380.3565958},gcrf{5102.508958,6123.011401,6378.136928};
  const Mat3 vr=gcrfToItrf1996(vallado,ve);
  check("Vallado3-15 ITRF->GCRF km",vdiff(apply(transpose(vr),itrf),gcrf),1e-6);
  check("Vallado3-15 GCRF->ITRF km",vdiff(apply(vr,gcrf),itrf),1e-6);
  // r=(2,0,0)m,v=(3,4,0)m/s; V=(.6,.8,0),N=(0,0,1),C=(.8,-.6,0).
  // Non-perpendicular r,v distinguishes VNC from relabeled circular RTN.
  const Mat3 vnc{{{.6,.8,0},{0,0,1},{.8,-.6,0}}};
  check("VNC selected",!orbitalFrame(AxisType::VNC,{2,0,0},{3,4,0},&r),0);
  check("VNC closed form",diff(r,vnc),1e-15);proper(r);
  check("VNC collinear refused",velocityNormalConormal({2,0,0},{3,0,0},&r),0);
  check("VNC zero velocity refused",velocityNormalConormal({2,0,0},{0,0,0},&r),0);
  check("VNC NaN refused",velocityNormalConormal({2,0,0},{NAN,4,0},&r),0);
  // Latitude30deg,longitude0: E=(0,1,0),N=(-.5,0,sqrt3/2),U=(sqrt3/2,0,.5).
  const double q=std::sqrt(3.0)/2;
  const Mat3 refs[]={{{{0,1,0},{-.5,0,q},{q,0,.5}}},{{{.5,0,-q},{0,1,0},{q,0,.5}}},{{{-.5,0,q},{0,1,0},{-q,0,-.5}}}};
  const AxisType types[]={AxisType::ENU,AxisType::SEZ,AxisType::NED};
  const char* names[]={"ENU closed form","SEZ closed form","NED closed form"};
  for(int i=0;i<3;++i) {
    check("local selected",!topocentricFromBodyFixed(types[i],ERFA_DPI/6,0,&r),0);
    check(names[i],diff(r,refs[i]),1e-15);proper(r);
    check("local pole valid",!topocentricFromBodyFixed(types[i],ERFA_DPI/2,1,&r),0);
  }
  check("bad local type refused",topocentricFromBodyFixed(AxisType::ICRF,0,0,&r),0);
  check("bad latitude refused",topocentricFromBodyFixed(AxisType::ENU,2,0,&r),0);
  for(const auto& f:bodyReferences) {
    check("body available",!icrfToIauBodyFixed(ERFA_DJ00,f.days,f.body,&r),0);
    char label[80];std::snprintf(label,sizeof(label),"CSPICE body%d TDBdays%.4f",f.body,f.days);
    check(label,diff(r,f.expected),f.tolerance);proper(r);
  }
  const AxisType bodies[]={AxisType::IAU_SUN,AxisType::IAU_MERCURY,AxisType::IAU_VENUS,AxisType::IAU_MOON,AxisType::IAU_MARS,AxisType::IAU_JUPITER,AxisType::IAU_SATURN};
  for(auto type:bodies)check("named body selected",!icrfToBodyFixed(type,epoch,&r),0);
  check("unknown body refused",icrfToIauBodyFixed(ERFA_DJ00,0,123456,&r),0);
  check("NaN body epoch refused",icrfToIauBodyFixed(ERFA_DJ00,NAN,301,&r),0);
  if(verbose)std::printf("%d checks, %d failures\n",checks,failures);
  return failures;
}
}
