// SDK adapter only; included in ca_cqr after Source and transport helpers.
bool eopRows(std::vector<EarthOrientation>& rows) {
  const EOP* first = nullptr;
  for (uint32_t i=0; auto f=input("earth_orientation",i); ++i) {
    auto p=decodeEither<EOP>(f,"$EOP"); if(!p) return false;
    auto hp=[&](flatbuffers::voffset_t field,double precise,double legacy) {
      return reinterpret_cast<const flatbuffers::Table*>(p)->CheckField(field)?precise:legacy;
    };
    if(p->IAU_CONVENTION()!=iauPrecessionNutationModel::UNSPECIFIED && p->IAU_CONVENTION()!=iauPrecessionNutationModel::IAU_2000A && p->IAU_CONVENTION()!=iauPrecessionNutationModel::IAU_2006)
      return error("invalid-eop","EOP must use IAU 2000A or IAU 2006 CIP offsets.");
    if(first && (first->SERIES()!=p->SERIES() || first->IAU_CONVENTION()!=p->IAU_CONVENTION() || text(first->DATA_SET_CID())!=text(p->DATA_SET_CID()) || text(first->DATA_SET_EPOCH())!=text(p->DATA_SET_EPOCH())))
      return error("invalid-eop","EOP records must share series, IAU convention and dataset provenance.");
    first=p;
    EarthOrientation e;
    e.jd=p->MJD()+2400000.5;
    if(!text(p->DATE()).empty()) {
      std::string iso; double jd;
      if(!conjunction::upload::timestamp(text(p->DATE()),false,iso,jd) || std::abs(jd-e.jd)>1e-9)
        return error("invalid-eop","EOP DATE must match MJD at midnight UTC.");
    }
    e.dut1=hp(EOP::VT_UT1_MINUS_UTC_SECONDS_HP,p->UT1_MINUS_UTC_SECONDS_HP(),p->UT1_MINUS_UTC_SECONDS());
    e.xp=hp(EOP::VT_X_POLE_WANDER_RADIANS_HP,p->X_POLE_WANDER_RADIANS_HP(),p->X_POLE_WANDER_RADIANS());
    e.yp=hp(EOP::VT_Y_POLE_WANDER_RADIANS_HP,p->Y_POLE_WANDER_RADIANS_HP(),p->Y_POLE_WANDER_RADIANS());
    e.dx=hp(EOP::VT_X_CELESTIAL_POLE_OFFSET_RADIANS_HP,p->X_CELESTIAL_POLE_OFFSET_RADIANS_HP(),p->X_CELESTIAL_POLE_OFFSET_RADIANS());
    e.dy=hp(EOP::VT_Y_CELESTIAL_POLE_OFFSET_RADIANS_HP,p->Y_CELESTIAL_POLE_OFFSET_RADIANS_HP(),p->Y_CELESTIAL_POLE_OFFSET_RADIANS());
    e.lod=hp(EOP::VT_LENGTH_OF_DAY_CORRECTION_SECONDS_HP,p->LENGTH_OF_DAY_CORRECTION_SECONDS_HP(),p->LENGTH_OF_DAY_CORRECTION_SECONDS());
    for(double x:{e.jd,e.dut1,e.xp,e.yp,e.dx,e.dy,e.lod}) if(!isFinite(x)) return error("invalid-eop","EOP values must be finite at MJD "+std::to_string(p->MJD()));
    if(p->MJD()==0 || (!rows.empty() && e.jd<=rows.back().jd)) return error("invalid-eop","EOP records require positive, strictly increasing MJD epochs.");
    rows.push_back(e);
  }
  if(rows.empty()) return error("eop-required","ITRF states/covariance require explicit $EOP UT1-UTC and polar motion; no UT1=UTC fallback.");
  return true;
}
bool normalizeOem(Source& s,int target) {
  bool needsEop=s.axes==4 || std::find(s.covariance_frames.begin(),s.covariance_frames.end(),4)!=s.covariance_frames.end();
  if(!needsEop) {
    // Uniform RTN or evaluation-frame covariance remains unchanged.
    if(!s.covariance_frames.empty() && std::any_of(s.covariance_frames.begin(),s.covariance_frames.end(),[&](int f){return f!=s.covariance_frames.front();})) {
      // Mixed RTN + source-frame covariance is normalized below.
    } else return true;
  }
  if(target!=2 && target!=3) return error("unsupported-frame","ITRF conversion supports GCRF/ICRF or EME2000 evaluation axes.");
  if(s.axes!=4 && s.axes!=target) return error("frame-mismatch","Inertial OEM source must use the evaluation frame.");
  std::vector<EarthOrientation> eops;
  if(needsEop && !eopRows(eops)) return false;
  auto jacobian=[&](double jd,int from,double j[6][6]) {
    if(from==4) {
      EarthOrientation e;
      if(!earth_orientation_at(eops,jd,e)) return error("eop-coverage","EOP table does not bracket UTC JD "+std::to_string(jd));
      if(!itrf_to_inertial(jd,e,target==3,j)) return error("invalid-eop","ERFA time conversion failed at UTC JD "+std::to_string(jd));
      return true;
    }
    for(int a=0;a<6;++a) for(int b=0;b<6;++b) j[a][b]=a==b?1:0;
    if(from!=target) {
      double bias[3][3],prec[3][3],bp[3][3];eraBp06(2451545.,0,bias,prec,bp);
      for(int a=0;a<3;++a) for(int b=0;b<3;++b) j[a][b]=j[a+3][b+3]=target==3?bias[a][b]:bias[b][a];
    }
    return true;
  };
  if(s.axes==4) {
    for(auto& p:s.samples) {double j[6][6];if(!jacobian(p.jd,4,j)) return false;transform_ephemeris_point(p,j);}
    s.provider=std::make_shared<OEMEphemerisSource>(s.samples,s.provider->object_name(),s.provider->object_id(),s.provider->norad_id());
    s.axes=target;
  }
  bool allRtn=std::all_of(s.covariance_frames.begin(),s.covariance_frames.end(),[](int f){return f==0;});
  if(!allRtn) {
    for(size_t i=0;i<s.covariance_frames.size();++i) {
      int from=s.covariance_frames[i];double j[6][6]={};
      if(from==0) {
        const auto state=s.provider->state_at(s.covariance.jd[i]);
        double r[3]={state.x,state.y,state.z},v[3]={state.vx,state.vy,state.vz};
        double n[3]={r[1]*v[2]-r[2]*v[1],r[2]*v[0]-r[0]*v[2],r[0]*v[1]-r[1]*v[0]};
        double rn=std::hypot(r[0],r[1],r[2]),nn=std::hypot(n[0],n[1],n[2]);
        if(!(rn>0 && nn>0)) return error("invalid-covariance","RTN covariance requires nondegenerate position/velocity at UTC JD "+std::to_string(state.epoch_jd));
        for(int a=0;a<3;++a) {r[a]/=rn;n[a]/=nn;}
        double t[3]={n[1]*r[2]-n[2]*r[1],n[2]*r[0]-n[0]*r[2],n[0]*r[1]-n[1]*r[0]};
        for(int a=0;a<3;++a) {j[a][0]=j[a+3][3]=r[a];j[a][1]=j[a+3][4]=t[a];j[a][2]=j[a+3][5]=n[a];}
      } else if(!jacobian(s.covariance.jd[i],from,j)) return false;
      transform_ephemeris_covariance(s.covariance.lower[i],j);
      s.covariance_frames[i]=target;
    }
    s.covariance.axes=CovarianceSeries::Axes::Evaluation;
  } else s.covariance.axes=CovarianceSeries::Axes::Rtn;
  return true;
}
bool uploadEphemeris() {
  auto q=request("ephemeris");
  if(!q || !q->NATIVE_DOCUMENT()) return error("invalid-request-arm","parse_ephemeris requires CQR.NATIVE_DOCUMENT on ephemeris.");
  auto d=q->NATIVE_DOCUMENT();
  if(d->SERIALIZATION()!=cqrDocumentSyntax::UNSPECIFIED || !d->CONTENT()) return error("invalid-native-document","Ephemeris text uses NATIVE_DOCUMENT with UNSPECIFIED serialization.");
  auto t=decode<TIM>(input("reference_epoch"),"$TIM");
  UploadOptions options;
  if(!t || !t->INSTANT()) return error("reference-epoch-required","reference_epoch must provide TIM.INSTANT in UTC.");
  if(!epoch(t->INSTANT(),options.reference_jd)) return false;
  if(input("object")) {auto c=decode<CAT>(input("object"),"$CAT");if(!c)return false;options.object_id=text(c->OBJECT_ID());options.object_name=text(c->OBJECT_NAME());}
  if(input("format")) {
    auto f=request("format");if(!f || !f->NATIVE_DOCUMENT() || !f->NATIVE_DOCUMENT()->CONTENT()) return error("invalid-request-arm","format requires CQR.NATIVE_DOCUMENT ASCII format name.");
    auto b=f->NATIVE_DOCUMENT()->CONTENT();options.format.assign(reinterpret_cast<const char*>(b->Data()),b->size());
  }
  UploadResult result;
  auto b=d->CONTENT();
  if(!parse_ephemeris_upload(std::string(reinterpret_cast<const char*>(b->Data()),b->size()),options,result)) return error(result.code.c_str(),result.message);
  flatbuffers::FlatBufferBuilder builder;FinishOEMBuffer(builder,OEM::Pack(builder,&result.oem));
  if(!pushBytes("oem","OEM.fbs","$OEM","OEM",builder.GetBufferPointer(),builder.GetSize())) return false;
  CQRT validation;validation.NATIVE_DOCUMENT=std::make_unique<CQRNativeDocumentT>();
  validation.NATIVE_DOCUMENT->CONTENT.assign(result.message.begin(),result.message.end());
  return push(validation,"validation");
}
