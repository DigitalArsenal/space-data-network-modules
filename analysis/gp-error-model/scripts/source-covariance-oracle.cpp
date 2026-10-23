// Test-only independent congruence oracle. ERFA's SOFA-derived routines supply
// IAU 2006/2000A orientation; this file does NOT use foundation/frames or any
// production covariance reader/algebra. All numerical reference work runs WASM.
// UTC 2020-01-01, GCRF, SI; deliberately eccentric state distinguishes TNW/RTN.
namespace reference_covariance {
void rotation(int kind, double offset, double r[3][3]) {
  eraIr(r);
  if(kind==0) return;
  if(kind==1 || kind==2) {
    const double n=std::sqrt(10.0), w=std::sqrt(10.25);
    const double rtn[3][3]={{1,0,0},{0,3/n,1/n},{0,-1/n,3/n}};
    const double tnw[3][3]={{.5/w,3/w,1/w},{-n/w,1.5/(n*w),.5/(n*w)},{0,-1/n,3/n}};
    for(int a=0;a<3;++a)for(int b=0;b<3;++b)r[a][b]=(kind==1?rtn:tnw)[b][a];
    return;
  }
  double utc1,utc2,tai1,tai2,tt1,tt2,u1,u2,base[3][3];
  eraDtf2d("UTC",2020,1,1,0,0,0,&utc1,&utc2);
  eraUtctai(utc1,utc2,&tai1,&tai2);eraTaitt(tai1,tai2,&tt1,&tt2);
  // Binary32 EOP inputs, as SDS EOP represents them.
  eraUtcut1(utc1,utc2,double(float(-.1771554)),&u1,&u2);
  tt2+=offset/86400.;u2+=offset/86400.;
  if(kind==3) { double rp[3][3],rbp[3][3];eraBp06(2451545.,0,base,rp,rbp); }
  if(kind==4) { double tod[3][3],z[3][3];eraPnm06a(tt1,tt2,tod);eraIr(z);eraRz(eraEe06a(tt1,tt2),z);eraRxr(z,tod,base); }
  if(kind==5) {
    double x,y;eraXy06(tt1,tt2,&x,&y);double s=eraS06(tt1,tt2,x,y);
    double ci[3][3],pm[3][3];eraC2ixys(x,y,s,ci);
    eraPom00(double(float(3.7e-7)),double(float(1.4e-6)),eraSp00(tt1,tt2),pm);
    eraC2tcio(ci,eraEra00(u1,u2),pm,base);
  }
  eraTr(base,r);
}
}
extern "C" int reference_covariances() {
  ERMT out; out.CALIBRATED_COVARIANCES=std::make_unique<ERMCalibratedCovariancesT>();
  const char* names[]={"GCRF","RTN","TNW","EME2000","TEME","ITRF"};
  double lower[6][6]={},p[6][6]={};
  for(int a=0;a<6;++a)for(int b=0;b<=a;++b)lower[a][b]=(a==b?double(a+1):.07*double(a+b+1));
  for(int a=0;a<6;++a)for(int b=0;b<6;++b)for(int k=0;k<6;++k)p[a][b]+=lower[a][k]*lower[b][k];
  for(int kind=0;kind<6;++kind) {
    double r[3][3],before[3][3],after[3][3],j[6][6]={};
    reference_covariance::rotation(kind,0,r);
    reference_covariance::rotation(kind,-1,before);reference_covariance::rotation(kind,1,after);
    for(int a=0;a<3;++a)for(int b=0;b<3;++b) {
      j[a][b]=j[a+3][b+3]=r[a][b];j[a+3][b]=(after[a][b]-before[a][b])/2;
    }
    auto row=std::make_unique<ERMCalibratedCovarianceT>();row->ID=names[kind];
    row->COVARIANCE_INERTIAL.resize(36);
    for(int a=0;a<6;++a)for(int b=0;b<6;++b) {
      double sum=0;for(int k=0;k<6;++k)for(int l=0;l<6;++l)sum+=j[a][k]*p[k][l]*j[b][l];
      row->COVARIANCE_INERTIAL[6*a+b]=sum;
    }
    // Also transport the source matrix; no JS covariance math in the E2E.
    for(int a=0;a<6;++a)for(int b=0;b<=a;++b)row->COVARIANCE_RTN.push_back(p[a][b]/1e6);
    out.CALIBRATED_COVARIANCES->RESULTS.push_back(std::move(row));
  }
  flatbuffers::FlatBufferBuilder builder;FinishSizePrefixedERMBuffer(builder,ERM::Pack(builder,&out));
  return plugin_push_output_ex("reference","ERM.fbs","$ERM",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"ERM",0,0,builder.GetBufferPointer(),builder.GetSize())<0?1:0;
}
