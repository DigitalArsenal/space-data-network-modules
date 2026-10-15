// Compare canonical common-grid OEM trajectories. Upstream propagator and frame
// modules own sampling/normalization; this method never treats TLEs as osculating.
namespace catalog_match {
bool utcEpoch(const std::string& value) {
  if(value.size()<20 || value[4]!='-' || value[7]!='-' || value[10]!='T' || value[13]!=':' || value[16]!=':' || value.back()!='Z') return false;
  for(size_t i=0;i<19;++i) if(i!=4 && i!=7 && i!=10 && i!=13 && i!=16 && (value[i]<'0'||value[i]>'9')) return false;
  if(value.size()>20) { if(value[19]!='.' || value.size()==21 || value.size()>30) return false; for(size_t i=20;i+1<value.size();++i) if(value[i]<'0'||value[i]>'9') return false; }
  auto two=[&](size_t i){return (value[i]-'0')*10+value[i+1]-'0';};
  int y=two(0)*100+two(2),m=two(5),d=two(8); int days[]={31,28,31,30,31,30,31,31,30,31,30,31};
  if(y<1||m<1||m>12||d<1||two(11)>23||two(14)>59||two(17)>59) return false;
  if(y%4==0&&(y%100!=0||y%400==0)) days[1]=29;
  return d<=days[m-1];
}
struct Arc { const ephemerisDataBlock* block; const flatbuffers::Vector<double>* states; int frame; size_t count; };
bool read(const plugin_input_frame_t* input, Arc& out) {
  if (!input->payload || input->payload_length < 12 || input->payload_length > 16*1024*1024) return false;
  if (flatbuffers::ReadScalar<uint32_t>(input->payload) != input->payload_length-4) return false;
  flatbuffers::Verifier verifier(input->payload,input->payload_length);
  if (!VerifySizePrefixedOEMBuffer(verifier)) return false;
  const auto* blocks=GetSizePrefixedOEM(input->payload)->EPHEMERIS_DATA_BLOCK();
  if (!blocks || blocks->size()!=1) return false;
  const auto* b=blocks->Get(0);
  const auto* f=b->REFERENCE_FRAME() ? b->REFERENCE_FRAME()->REFERENCE_FRAME_as_CelestialFrameWrapper() : nullptr;
  const auto* v=b->EPHEMERIS_DATA();
  if (!f || (f->frame()!=CelestialFrame::J2000 && f->frame()!=CelestialFrame::EME2000 && f->frame()!=CelestialFrame::GCRF)) return false;
  if (str(b->CENTER_NAME())!="EARTH" || b->TIME_SYSTEM()!=timingStandard::UTC || !utcEpoch(str(b->START_TIME())) ||
      !std::isfinite(b->STEP_SIZE()) || b->STEP_SIZE()<=0 || b->STATE_VECTOR_SIZE()!=6 || !v || v->size()%6 || v->size()<30 || v->size()>600000) return false;
  if ((b->EPHEMERIS_DATA_LINES() && b->EPHEMERIS_DATA_LINES()->size()) || (b->POLYNOMIAL_POSITION_RECORDS() && b->POLYNOMIAL_POSITION_RECORDS()->size())) return false;
  for (double x:*v) if (!std::isfinite(x)) return false;
  // This matching profile is for bound Earth satellites. Reject missing/zero
  // states, interior-Earth positions, and unbound states before comparison.
  for(size_t i=0;i<v->size();i+=6) {
    double r2=0,v2=0; for(size_t j=0;j<3;++j){r2+=v->Get(i+j)*v->Get(i+j);v2+=v->Get(i+3+j)*v->Get(i+3+j);}
    const double radius=std::sqrt(r2);
    if(!std::isfinite(radius) || radius<=6356.7523 || !std::isfinite(v2) || v2>=2*398600.4418/radius) return false;
  }
  out={b,v,static_cast<int>(f->frame()),v->size()/6}; return true;
}
double distance(const Arc& a,const Arc& b,size_t i,size_t component) {
  double sum=0; for(size_t j=0;j<3;++j) { double d=a.states->Get(i*6+component+j)-b.states->Get(i*6+component+j); sum+=d*d; } return std::sqrt(sum);
}
double velocityCheck(const Arc& a) {
  double worst=0,h=a.block->STEP_SIZE();
  // Differentiate at every epoch, including the first/last two samples.
  // Quartic Lagrange interpolation on five equally spaced points yields
  // these fourth-order stencils (numerators; common denominator 12*h).
  static constexpr double weights[5][5]={
    {-25,48,-36,16,-3}, {-3,-10,18,-6,1},
    {1,-8,0,8,-1}, {-1,6,-18,10,3}, {3,-16,36,-48,25}
  };
  for(size_t i=0;i<a.count;++i) {
    const size_t begin=i<2?0:(i+2>=a.count?a.count-5:i-2);
    const size_t stencil=i-begin;
    double sum=0; for(size_t j=0;j<3;++j) {
      // Subtract the evaluation position to reduce cancellation for large
      // coordinates. Every stencil sums to zero.
      double numerator=0;
      for(size_t k=0;k<5;++k) numerator+=weights[stencil][k]*(a.states->Get((begin+k)*6+j)-a.states->Get(i*6+j));
      double fd=numerator/(12*h);
      double d=fd-a.states->Get(i*6+3+j); sum+=d*d;
    } worst=std::max(worst,std::sqrt(sum));
  } return worst;
}

// One trajectory of a comparison, and one proposed pair (the link as requested, its two trajectory IDs).
struct Trajectory { std::string id, provider, nativeId, recordId; };
struct Pair { std::string left, right; std::unique_ptr<OILLinkT> link; };
struct Policy { double position = NAN, velocity = NAN, finiteDifference = NAN, span = NAN; };
// The comparison of one pair. `compared` is false when the arcs could not be compared (no residuals).
struct Result {
  size_t left = 0, right = 0;
  std::unique_ptr<OILLinkT> link;
  xmtPairVerdict verdict = xmtPairVerdict::Insufficient;
  std::string reason;
  bool compared = false;
  double dp = NAN, dv = NAN, da = NAN, db = NAN, span = 0;
  size_t samples = 0;
};
Policy policy_of(const XMTMatchPolicy* p) {
  Policy out;
  if (p) out = {p->POSITION_TOLERANCE_KM(), p->VELOCITY_TOLERANCE_KM_S(), p->FINITE_DIFFERENCE_TOLERANCE_KM_S(), p->MINIMUM_SPAN_S()};
  return out;
}
// The trajectories and pairs of a match request.
bool request_of(const XMTMatchRequest* r, std::vector<Trajectory>* trajectories, std::vector<Pair>* pairs) {
  if (!r || !r->TRAJECTORIES() || !r->PAIRS()) return false;
  for (const auto* t : *r->TRAJECTORIES()) trajectories->push_back({str(t->ID()), str(t->PROVIDER()), str(t->NATIVE_ID()), str(t->RECORD_ID())});
  for (const auto* link : *r->PAIRS()) {
    Pair pair;
    pair.link.reset(link->UnPack());
    pair.left = pair.link->LEFT ? pair.link->LEFT->TRAJECTORY_ID : "";
    pair.right = pair.link->RIGHT ? pair.link->RIGHT->TRAJECTORY_ID : "";
    pairs->push_back(std::move(pair));
  }
  return true;
}
std::unique_ptr<XMTMatchPolicyT> policy_table(const Policy& p) {
  auto out = std::make_unique<XMTMatchPolicyT>();
  out->POSITION_TOLERANCE_KM = p.position; out->VELOCITY_TOLERANCE_KM_S = p.velocity;
  out->FINITE_DIFFERENCE_TOLERANCE_KM_S = p.finiteDifference; out->MINIMUM_SPAN_S = p.span;
  return out;
}
std::unique_ptr<XMTPairResultT> result_table(Result& r) {
  auto out = std::make_unique<XMTPairResultT>();
  out->LINK = std::move(r.link);
  out->VERDICT = r.verdict;
  out->REASON = r.reason;
  if (r.compared) {
    out->MAX_POSITION_RESIDUAL_KM = r.dp; out->MAX_VELOCITY_RESIDUAL_KM_S = r.dv;
    out->LEFT_FINITE_DIFFERENCE_RESIDUAL_KM_S = r.da; out->RIGHT_FINITE_DIFFERENCE_RESIDUAL_KM_S = r.db;
    out->SAMPLES = static_cast<uint32_t>(r.samples); out->SPAN_S = r.span;
  }
  return out;
}
std::unique_ptr<XMTMatchReportT> report_table(const Policy& policy, const std::vector<Trajectory>& trajectories, std::vector<Result>& results) {
  auto out = std::make_unique<XMTMatchReportT>();
  out->POLICY = policy_table(policy);
  for (const auto& t : trajectories) {
    auto row = std::make_unique<XMTTrajectoryT>();
    row->ID = t.id; row->PROVIDER = t.provider; row->NATIVE_ID = t.nativeId; row->RECORD_ID = t.recordId;
    out->TRAJECTORIES.push_back(std::move(row));
  }
  for (auto& r : results) out->PAIRS.push_back(result_table(r));
  return out;
}

// Compares the proposed pairs over their trajectories, one per trajectory in order. Returns false with `error` set
// when the request or a trajectory is unusable. match_catalog and the integrator's identity step share it.
bool run(const Policy& policy, const std::vector<Trajectory>& candidates, std::vector<Pair>& pairs, const std::vector<const plugin_input_frame_t*>& inputs, std::vector<Result>* out, std::string* error) {
  const double pos=policy.position,vel=policy.velocity,fd=policy.finiteDifference,span=policy.span;
  if(inputs.size()<2 || inputs.size()>64) { *error="Match needs a bounded request and 2–64 OEM trajectories."; return false; }
  if(candidates.size()!=inputs.size() || pairs.empty() || pairs.size()>4096 ||
    !std::isfinite(pos) || pos<=0 || !std::isfinite(vel) || vel<=0 || !std::isfinite(fd) || fd<=0 || !std::isfinite(span) || span<=0) { *error="Specify positive finite matching tolerances, minimum arc span, candidates and pairs."; return false; }
  std::map<std::string,size_t> ids; std::vector<Arc> arcs; size_t bytes=0;
  for(size_t i=0;i<inputs.size();++i) {
    const auto& c=candidates[i]; const auto& id=c.id;
    if(id.empty() || id.size()>1024 || !ids.emplace(id,i).second || c.provider.empty() || c.nativeId.empty() || c.recordId.empty()) { *error="Every trajectory needs a distinct ID, provider, native ID and immutable record reference."; return false; }
    bytes+=inputs[i]->payload_length; if(bytes>128*1024*1024) { *error="Matching exceeds 128 MiB."; return false; }
    Arc arc{}; if(!read(inputs[i],arc)) { *error="Matching requires one canonical uniform Earth-centered inertial UTC OEM block per candidate, with at least five finite position/velocity samples."; return false; } arcs.push_back(arc);
  }
  std::vector<Result> results; std::set<std::pair<size_t,size_t>> seen;
  std::map<std::pair<size_t,std::string>,size_t> passing; size_t comparisons=0;
  for(auto& pair:pairs) {
    auto l=ids.find(pair.left),rr=ids.find(pair.right);
    if(l==ids.end() || rr==ids.end() || l->second==rr->second || !seen.insert(std::minmax(l->second,rr->second)).second) { *error="Pairs must name distinct candidates without duplicates."; return false; }
    const auto& a=arcs[l->second]; const auto& b=arcs[rr->second];
    comparisons+=a.count+b.count; if(comparisons>4000000) { *error="Match batch exceeds four million state comparisons; split the candidate batch."; return false; }
    const auto& lp=candidates[l->second].provider; const auto& rp=candidates[rr->second].provider;
    if(lp==rp) { *error="Cross-catalog matching requires different provider namespaces."; return false; }
    Result result; result.left=l->second; result.right=rr->second; result.link=std::move(pair.link);
    if(a.frame!=b.frame || str(a.block->START_TIME())!=str(b.block->START_TIME()) || a.block->STEP_SIZE()!=b.block->STEP_SIZE() || a.count!=b.count) result.reason="Normalize frames and sample both trajectories on the identical UTC grid.";
    else if((a.count-1)*a.block->STEP_SIZE()<span) result.reason="Arc shorter than configured minimum.";
    else {
      double dp=0,dv=0; for(size_t i=0;i<a.count;++i) { dp=std::max(dp,distance(a,b,i,0)); dv=std::max(dv,distance(a,b,i,3)); }
      double da=velocityCheck(a),db=velocityCheck(b);
      if(!std::isfinite(dp)||!std::isfinite(dv)||!std::isfinite(da)||!std::isfinite(db)) { *error="Non-finite residual from trajectory magnitudes."; return false; }
      result.compared=true; result.dp=dp; result.dv=dv; result.da=da; result.db=db;
      result.samples=a.count; result.span=(a.count-1)*a.block->STEP_SIZE();
      if(da>fd || db>fd) { result.verdict=xmtPairVerdict::Insufficient; result.reason="Position-derived velocity disagrees with supplied velocity; refine sampling or review the state product."; }
      else if(dp>pos || dv>vel) { result.verdict=xmtPairVerdict::Rejected; result.reason="Trajectory separation exceeds configured tolerances."; }
      else { result.verdict=xmtPairVerdict::Compatible; result.reason="Trajectory agreement supports review; it is not identity proof or a match probability."; ++passing[{l->second,rp}]; ++passing[{rr->second,lp}]; }
    }
    results.push_back(std::move(result));
  }
  for(auto& row:results) if(row.verdict==xmtPairVerdict::Compatible && (passing[{row.left,candidates[row.right].provider}]>1 || passing[{row.right,candidates[row.left].provider}]>1)) { row.verdict=xmtPairVerdict::Ambiguous; row.reason="Multiple proposed associations pass; review before establishing identity."; }
  *out=std::move(results);
  return true;
}
}
extern "C" int match_catalog(void) {
  using namespace catalog_match;
  const plugin_input_frame_t* config=nullptr; std::vector<const plugin_input_frame_t*> inputs;
  for(uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* f=plugin_get_input_frame(i); if(!f || !f->port_id) return fail("Missing match input port.");
    if(std::strcmp(f->port_id,"recipe")==0) { if(config) return fail("Duplicate match request."); config=f; }
    else if(std::strcmp(f->port_id,"ephemerides")==0) inputs.push_back(f);
    else return fail("Unknown match input port.");
  }
  const XMT* message=read_xmt(config,1024*1024);
  if(!message || !message->MATCH_REQUEST() || inputs.size()<2 || inputs.size()>64) return fail("Match needs a bounded $XMT MATCH_REQUEST and 2–64 OEM trajectories.");
  const Policy policy=policy_of(message->MATCH_REQUEST()->POLICY());
  std::vector<Trajectory> trajectories; std::vector<Pair> pairs; std::vector<Result> results; std::string error;
  if(!request_of(message->MATCH_REQUEST(),&trajectories,&pairs)) return fail("Specify positive finite matching tolerances, minimum arc span, candidates and pairs.");
  if(!run(policy,trajectories,pairs,inputs,&results,&error)) return fail(error.c_str());
  XMTT report; report.MATCH_REPORT=report_table(policy,trajectories,results);
  return push_report(report);
}
