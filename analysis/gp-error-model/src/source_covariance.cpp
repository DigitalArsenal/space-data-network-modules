// Rule 1 at the consumer boundary: SDS records -> GCRF covariance, never dynamics.
// Record readers, covariance algebra and interpolation belong to this module;
// foundation/frames owns the orientation chain. PRW is the propagator handoff.
namespace sourcecov {
using namespace sp;
namespace ax = sdn::frames;

std::string text(const flatbuffers::String* s) { return s ? s->str() : ""; }
std::string frame(const std::string& name) {
  const auto f = upper(name);
  if (f == "RSW" || f == "RIC" || f == "UVW" || f == "RSW_INERTIAL") return "RTN";
  if (f == "TNW_INERTIAL") return "TNW";
  if (f == "ECEF" || f == "ITRF2000" || f == "ITRF93" || f == "ITRF97" || f == "ITRF2014" || f == "ITRF2020") return "ITRF";
  if (f == "J2000") return "EME2000";
  if (f == "ICRF" || f == "ICRF2000") return "GCRF";
  if (f == "TEMEOFDATE") return "TEME";
  return f;
}
bool same_epoch(const Instant& a, const Instant& b) { return std::fabs(seconds_between(a, b)) < 1e-6; }

// EOP table coverage is mandatory for terrestrial axes. No network or implicit
// zero-EOP fallback. Reuse the PRW table consumed by the object's propagator.
std::string orientation(const PRWEarthOrientationT* table, const Instant& t, ax::EarthOrientation* out) {
  if (!table || table->ROWS.empty()) return "ITRF/ECEF covariance requires EARTH_ORIENTATION rows";
  const double mjd = t.day + 40587.0 + t.sec / 86400.0;
  const auto& rows = table->ROWS;
  for (size_t i = 0; i < rows.size(); ++i) {
    if (!rows[i] || (i && rows[i]->MJD <= rows[i-1]->MJD)) return "EOP rows must have strictly increasing MJD";
  }
  size_t hi = 0;
  while (hi < rows.size() && rows[hi]->MJD < mjd) ++hi;
  size_t lo = hi ? hi - 1 : 0;
  if (hi == rows.size() || mjd < rows.front()->MJD) return "covariance epoch outside EOP span";
  if (std::fabs(mjd - rows[hi]->MJD) < 1e-10) lo = hi;
  const auto& a = *rows[lo]; const auto& b = *rows[hi];
  const double f = hi == lo ? 0 : (mjd - a.MJD) / (b.MJD - a.MJD);
  if (a.SERIES != b.SERIES || a.IAU_CONVENTION != b.IAU_CONVENTION) return "EOP rows must belong to one series and convention";
  out->xPole = (1-f)*a.X_POLE_WANDER_RADIANS + f*b.X_POLE_WANDER_RADIANS;
  out->yPole = (1-f)*a.Y_POLE_WANDER_RADIANS + f*b.Y_POLE_WANDER_RADIANS;
  out->dX = (1-f)*a.X_CELESTIAL_POLE_OFFSET_RADIANS + f*b.X_CELESTIAL_POLE_OFFSET_RADIANS;
  out->dY = (1-f)*a.Y_CELESTIAL_POLE_OFFSET_RADIANS + f*b.Y_CELESTIAL_POLE_OFFSET_RADIANS;
  // Interpolate UT1-TAI across a leap, then restore TAI-UTC at the epoch.
  out->dut1 = (1-f)*(a.UT1_MINUS_UTC_SECONDS-a.TAI_MINUS_UTC_SECONDS) +
      f*(b.UT1_MINUS_UTC_SECONDS-b.TAI_MINUS_UTC_SECONDS) + a.TAI_MINUS_UTC_SECONDS;
  out->lengthOfDay = (1-f)*a.LENGTH_OF_DAY_CORRECTION_SECONDS + f*b.LENGTH_OF_DAY_CORRECTION_SECONDS;
  return {};
}
std::string jacobian(const std::string& name, const std::string& epoch, const FRMStateVectorT& state,
                     const PRWEarthOrientationT* eop, stm::Mat6* j) {
  const auto f = frame(name);
  ax::Mat3 r;
  ax::Mat3 rate{{{0,0,0},{0,0,0},{0,0,0}}};
  if (f == "RTN" || f == "TNW" || f == "RSW_ROTATING" || f == "TNW_ROTATING") {
    const ax::Vec3 p{state.POSITION->X,state.POSITION->Y,state.POSITION->Z};
    const ax::Vec3 v{state.VELOCITY->X,state.VELOCITY->Y,state.VELOCITY->Z};
    ax::Mat3 axes;
    // RTN: R, N x R, N. TNW: velocity, N x velocity, N.
    if (!ax::triadFromPrimarySecondary(f == "TNW" || f == "TNW_ROTATING" ? v : p,
        f == "TNW" || f == "TNW_ROTATING" ? ax::scale(p,-1) : v, &axes))
      return "degenerate state cannot define orbital covariance axes";
    r = ax::transpose(axes);
    if (f == "RSW_ROTATING" || f == "TNW_ROTATING")
      return "rotating orbital velocity coordinates require an angular-rate contract; use the record's inertial RTN/TNW covariance axes";
  } else if (f != "GCRF") {
    if (f != "ITRF" && f != "EME2000" && f != "TEME") return "unsupported covariance frame: " + name;
    Instant t; int d[5]; double second;
    if (!parse_instant(epoch,&t,d,&second)) return "invalid covariance epoch";
    ax::EarthOrientation earth;
    if (f == "ITRF") { const auto error = orientation(eop,t,&earth); if (!error.empty()) return error; }
    ax::Epoch at;
    if (!ax::epochFromUtc(d[0],d[1],d[2],d[3],d[4],second,earth,&at)) return "epoch outside ERFA leap-second table";
    const auto transform = ax::rotationWithRate([&](const ax::Epoch& when) {
      return ax::transpose(f == "ITRF" ? ax::gcrfToItrf(when,earth) :
          f == "TEME" ? ax::gcrfToTeme(when) : ax::gcrfToMj2000Eq(when));
    }, at);
    r = transform.rotation; rate = transform.rate;
  }
  j->fill(0);
  for (int a=0;a<3;++a) for (int b=0;b<3;++b) {
    (*j)[6*a+b] = (*j)[6*(a+3)+b+3] = r.m[a][b];
    (*j)[6*(a+3)+b] = rate.m[a][b];
  }
  return {};
}

bool identity_matches(const Block& b, const PRWResidentStateT& state) {
  if (state.CATALOG_NUMBER) return b.norad == state.CATALOG_NUMBER;
  if (!state.OBJECT_ID.empty()) return b.object_id == state.OBJECT_ID || b.key == state.OBJECT_ID;
  return true;
}
std::string read_cdm(const RawRecord& raw, std::vector<Block>* blocks) {
  if (!verified(raw,[](flatbuffers::Verifier& v){return VerifyCDMBuffer(v);},[](flatbuffers::Verifier& v){return VerifySizePrefixedCDMBuffer(v);})) return "invalid $CDM";
  const auto* cdm = raw.prefixed ? GetSizePrefixedCDM(raw.bytes.data()) : GetCDM(raw.bytes.data());
  for (const auto* obj : {cdm->OBJECT1(),cdm->OBJECT2()}) {
    if (!obj) continue;
    Block b;
    b.norad = obj->OBJECT() ? obj->OBJECT()->NORAD_CAT_ID() : 0;
    b.object_id = obj->OBJECT() ? text(obj->OBJECT()->OBJECT_ID()) : text(obj->OBJECT_DESIGNATOR());
    b.key = key_of(b.norad,b.object_id,""); b.cov_frame_name = "RTN";
    if (obj->COVARIANCE() && obj->COVARIANCE()->size() >= 21) {
      CovLine c; c.text = text(cdm->TCA());
      if (!parse_instant(c.text,&c.t)) return "CDM TCA must be ISO 8601 UTC";
      for (int k=0;k<21;++k) c.c[k] = obj->COVARIANCE()->Get(k);
      b.cov.push_back(c);
    }
    blocks->push_back(std::move(b));
  }
  return {};
}
} // namespace sourcecov

extern "C" int source_covariance() {
  using namespace sourcecov;
  std::string error;
  std::vector<RawRecord> requests;
  if (!port_records("request","$PRW",&requests,&error) || requests.size()!=1)
    return fail("invalid-request",error.empty()?"exactly one PRW request is required":error);
  const auto& req = requests.front();
  if (!verified(req,[](flatbuffers::Verifier& v){return VerifyPRWBuffer(v);},[](flatbuffers::Verifier& v){return VerifySizePrefixedPRWBuffer(v);})) return fail("invalid-request","invalid $PRW request");
  const auto* wire = req.prefixed ? GetSizePrefixedPRW(req.bytes.data()) : GetPRW(req.bytes.data());
  const std::unique_ptr<PRWT> request(wire->UnPack());
  if (!request->RESIDENT_STATE || !request->RESIDENT_STATE->STATE || !request->RESIDENT_REQUEST || !request->RESIDENT_REQUEST->TARGET_EPOCH)
    return fail("invalid-request","RESIDENT_STATE and RESIDENT_REQUEST with TARGET_EPOCH are required");
  auto& state = *request->RESIDENT_STATE;
  const auto& clock = *request->RESIDENT_REQUEST->TARGET_EPOCH;
  const auto& pv = *state.STATE;
  if (clock.TIME_SYSTEM != timingStandard::UTC || clock.EPOCH_FORMAT != timEpochRepresentation::ISO8601 || clock.SUBSECOND_NANOS ||
      pv.EPOCH_TIME_SYSTEM != "UTC" || !pv.POSITION || !pv.VELOCITY || !state.COORDINATE_SYSTEM ||
      state.COORDINATE_SYSTEM->AXIS_TYPE != rfmAxisType::ICRF || !state.COORDINATE_SYSTEM->ORIGIN ||
      state.COORDINATE_SYSTEM->ORIGIN->CELESTIAL_BODY_ID != 399)
    return fail("invalid-request","clock and state must be ISO 8601 UTC; state must be Earth-centered ICRF/GCRF with Cartesian position and velocity in SI");
  const double values[]={pv.POSITION->X,pv.POSITION->Y,pv.POSITION->Z,pv.VELOCITY->X,pv.VELOCITY->Y,pv.VELOCITY->Z};
  for (double x:values) if (!std::isfinite(x)) return fail("invalid-request","state must be finite");
  Instant target,state_epoch;
  if (!parse_instant(clock.ISO8601,&target) || !parse_instant(pv.EPOCH,&state_epoch)) return fail("invalid-request","invalid clock or state epoch");
  std::vector<Block> blocks;
  size_t count=0;
  std::string kind;
  for (const auto& port : {std::pair<const char*,const char*>{"ocm","$OCM"},{"oem","$OEM"},{"cdm","$CDM"}}) {
    std::vector<RawRecord> records;
    if (!port_records(port.first,port.second,&records,&error)) return fail("invalid-record",error);
    count += records.size();
    for (const auto& raw : records) {
      kind=port.first;
      if (raw.ident!=port.second) return fail("invalid-record","record identifier does not match its port");
      if (kind=="oem") {
        if (!read_oem_blocks(raw,&blocks,&error)) return fail("invalid-record",error);
        const auto* oem=raw.prefixed?GetSizePrefixedOEM(raw.bytes.data()):GetOEM(raw.bytes.data());
        if (oem->EPHEMERIS_DATA_BLOCK()) for (const auto* b:*oem->EPHEMERIS_DATA_BLOCK())
          if (b->TIME_SYSTEM()!=timingStandard::UTC) return fail("unsupported-time-system","OEM must use UTC");
      } else if (kind=="ocm") {
        if (!read_ocm_block(raw,&blocks,&error)) return fail("invalid-record",error);
        const auto* ocm=raw.prefixed?GetSizePrefixedOCM(raw.bytes.data()):GetOCM(raw.bytes.data());
        if (!ocm->METADATA() || text(ocm->METADATA()->TIME_SYSTEM())!="UTC") return fail("unsupported-time-system","OCM must explicitly use UTC");
        if (ocm->TRAJ_TYPE()!=trajectoryType::CARTESIAN_PV && ocm->TRAJ_TYPE()!=trajectoryType::CARTESIAN_PVA)
          return fail("unsupported-covariance","OCM requires Cartesian PV/PVA state and CARTPV covariance");
      } else { error=read_cdm(raw,&blocks); if (!error.empty()) return fail("invalid-record",error); }
    }
  }
  if (count!=1) return fail("invalid-record","supply exactly one source record on ocm, oem or cdm");
  std::vector<const Block*> selected;
  for (const auto& b:blocks) if (identity_matches(b,state) && !b.cov.empty()) {
    if (b.cov.size()==1 || (seconds_between(b.cov.front().t,target)>=0 && seconds_between(target,b.cov.back().t)>=0)) selected.push_back(&b);
  }
  if (selected.empty()) return fail("outside-or-missing","no covariance for this object at the requested clock; outside covariance span or absent covariance");
  if (selected.size()!=1) return fail("ambiguous-record","multiple covariance blocks match; select an unambiguous source record and object");
  const auto& b=*selected.front();
  const Instant epoch=b.cov.size()==1?b.cov.front().t:target;
  const std::string epoch_text=b.cov.size()==1?b.cov.front().text:clock.ISO8601;
  if (!same_epoch(epoch,state_epoch)) return fail("state-epoch-mismatch","supply the object's GCRF state at the returned covariance epoch (source epoch for a singleton, clock for a time series)");
  size_t hi=0;
  while (hi+1<b.cov.size() && seconds_between(b.cov[hi].t,epoch)>1e-6) ++hi;
  const size_t lo=same_epoch(b.cov[hi].t,epoch)?hi:(hi?hi-1:0);
  for(size_t k=1;k<b.cov.size();++k) if (seconds_between(b.cov[k-1].t,b.cov[k].t)<=0) return fail("invalid-record","covariance epochs must be strictly increasing");
  const auto name_of=[&](const CovLine& c){return frame(!c.frame_name.empty()?c.frame_name:!b.cov_frame_name.empty()?b.cov_frame_name:b.frame_name);};
  const std::string axes=name_of(b.cov[lo]);
  if (axes.empty() || name_of(b.cov[hi])!=axes) return fail("incompatible-frames","bracketing covariances must identify the same axes");
  stm::Mat6 a{},z{},c{},j{};
  full_from_lower(b.cov[lo].c,a.data()); full_from_lower(b.cov[hi].c,z.data());
  const double fraction=lo==hi?0:seconds_between(b.cov[lo].t,epoch)/seconds_between(b.cov[lo].t,b.cov[hi].t);
  covreal::interpolate_covariance(a.data(),z.data(),fraction,c.data());
  for(double& x:c) { x*=1e6; if(!std::isfinite(x)) return fail("invalid-covariance","covariance must be finite"); }
  error=jacobian(axes,epoch_text,pv,request->EARTH_ORIENTATION.get(),&j);
  if(!error.empty()) return fail("covariance-frame",error);
  c=stm::multiply(stm::multiply(j,c),stm::transpose(j));
  state.COVARIANCE=std::make_unique<PRWStateMatrixT>(); state.COVARIANCE->DIMENSION=6;
  state.COVARIANCE->VALUES.assign(c.begin(),c.end()); state.PROCESS_NOISE.reset();
  PRWT output; output.RESIDENT_STATE=std::move(request->RESIDENT_STATE);
  flatbuffers::FlatBufferBuilder builder;
  FinishSizePrefixedPRWBuffer(builder,PRW::Pack(builder,&output));
  if(plugin_push_output_ex("state","PRW.fbs","$PRW",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"PRW",0,0,builder.GetBufferPointer(),builder.GetSize())<0) return fail("output","cannot emit covariance state");
  ERMT report; report.ATTACH_REPORT=std::make_unique<ERMAttachReportT>();
  auto label=std::make_unique<ERMAttachedObjectT>(); label->OBJECT_KEY=b.key; label->EPOCH=epoch_text;
  label->RULE=covarianceRule::Operator; label->METHOD="operator-supplied"; label->PRODUCT=kind;
  auto row=std::make_unique<ERMRowLabelT>(); row->EPOCH=epoch_text; row->METHOD="operator-supplied";
  row->BASIS="OPERATOR"; row->VERDICT="as supplied; no realism calibration asserted";
  row->REALISM=std::make_unique<CVRT>(); row->REALISM->RULE=covarianceRule::Operator;
  label->ROWS.push_back(std::move(row)); report.ATTACH_REPORT->OBJECTS.push_back(std::move(label));
  flatbuffers::FlatBufferBuilder rb; FinishSizePrefixedERMBuffer(rb,ERM::Pack(rb,&report));
  return plugin_push_output_ex("report","ERM.fbs","$ERM",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"ERM",0,0,rb.GetBufferPointer(),rb.GetSize())<0?fail("output","cannot emit covariance label"):0;
}
