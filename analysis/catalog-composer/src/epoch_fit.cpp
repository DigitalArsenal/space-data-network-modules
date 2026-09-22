// Pluggable-propagator validation and one nonlinear relinearization step.
namespace epoch_fit {
struct Input {Json recipe;std::unique_ptr<OPMT> seed;sdn::vimpel::Positions reference;std::string sourceHash,seedHash;std::vector<catalog_match::Arc> arcs;};
bool load(Input& out,size_t trajectories) {
 const plugin_input_frame_t *control=nullptr,*seed=nullptr,*reference=nullptr;std::vector<const plugin_input_frame_t*> arcs;size_t bytes=0;
 for(uint32_t i=0;i<plugin_get_input_count();++i) {
  auto f=plugin_get_input_frame(i);if(!f || !f->payload || !f->port_id || (bytes+=f->payload_length)>128*1024*1024)return false;
  const std::string p=f->port_id;
  if(p=="recipe" && !control)control=f;else if(p=="seed" && !seed)seed=f;else if(p=="reference" && !reference)reference=f;else if(p=="ephemerides")arcs.push_back(f);else return false;
 }
 if(!control || !seed || !reference || arcs.size()!=trajectories || control->payload_length>65536 || seed->payload_length<12 || seed->payload_length>65536 || reference->payload_length<12 || reference->payload_length>4*1024*1024)return false;
 out.recipe=Json::parse(control->payload,control->payload+control->payload_length,nullptr,false);const auto& r=out.recipe;
 if(number(field(r,"version"))!=1 || text(field(r,"propagatorId")).empty() || (text(field(r,"propagatorArtifactSha256")).size()!=64 || text(field(r,"propagatorArtifactSha256")).find_first_not_of("0123456789abcdef")!=std::string::npos) || !field(r,"forceModel").is_object() || field(r,"forceModel").empty() || text(field(r,"frameTransformationRef")).empty())return false;
 if(flatbuffers::ReadScalar<uint32_t>(seed->payload)!=seed->payload_length-4)return false;
 flatbuffers::Verifier sv(seed->payload,seed->payload_length);if(!VerifySizePrefixedOPMBuffer(sv))return false;
 out.seedHash=ephem::sha256_hex(seed->payload,seed->payload_length);
 out.seed.reset(GetSizePrefixedOPM(seed->payload)->UnPack());const auto& s=*out.seed;
 if(s.REF_FRAME!="J2000" || s.TIME_SYSTEM!="UTC" || s.CENTER_NAME!="EARTH" || !catalog_match::utcEpoch(s.EPOCH))return false;
 const size_t size=flatbuffers::ReadScalar<uint32_t>(reference->payload)+size_t(4);if(size<12 || size>=reference->payload_length)return false;
 flatbuffers::Verifier nv(reference->payload,size);if(!VerifySizePrefixedNCDBuffer(nv))return false;
 const auto* n=GetSizePrefixedNCD(reference->payload);const auto* body=reference->payload+size;const auto length=reference->payload_length-size;
 if(n->FORMAT()!=ncdContainerFormat::PROVIDER_DEFINED || catalog_match::str(n->PROVIDER_DEFINED_FORMAT_NAME())!="vimpel-ephemeris-text" || n->SOURCE_BYTE_LENGTH()!=length || !n->SOURCE_SHA256() || n->SOURCE_SHA256()->size()!=64)return false;
 out.sourceHash=ephem::sha256_hex(body,length);if(out.sourceHash!=n->SOURCE_SHA256()->str())return false;
 if(!sdn::vimpel::positions(body,length,catalog_match::str(n->INTERNAL_FILE_NAME()),out.reference) || s.OBJECT_NAME!="vimpel:"+out.reference.nativeId || s.EPOCH!=out.reference.epoch)return false;
 for(auto f:arcs){catalog_match::Arc a{};if(!catalog_match::read(f,a) || a.frame!=static_cast<int>(CelestialFrame::J2000) || catalog_match::str(a.block->START_TIME())!=s.EPOCH || a.block->STEP_SIZE()!=600 || a.count>out.reference.rows.size() || a.count<9 || (!out.arcs.empty() && a.count!=out.arcs.front().count))return false;out.arcs.push_back(a);}
 const double values[]={s.X,s.Y,s.Z,s.X_DOT,s.Y_DOT,s.Z_DOT};
 for(size_t j=0;j<6;++j)if(!std::isfinite(values[j]) || std::abs(values[j]-out.arcs[0].states->Get(j))>1e-8)return false;
 const double stride=number(field(r,"holdoutStride")),tol=number(field(r,"positionToleranceKm"));
 if(r.contains("maximumHoldoutRmsKm") && (!std::isfinite(number(r["maximumHoldoutRmsKm"])) || number(r["maximumHoldoutRmsKm"])<0))return false;
 return std::isfinite(stride) && stride>=2 && stride<=8 && std::floor(stride)==stride && out.arcs[0].count/stride>=2 && std::isfinite(tol) && tol>0 && tol<=1000;
}
Json quality(const Input& in) {
 const auto& a=in.arcs[0];const size_t stride=number(field(in.recipe,"holdoutStride"));double train2=0,held2=0,maxTrain=0,maxHeld=0;size_t train=0,held=0;
 for(size_t i=0;i<a.count;++i) {double d2=0;for(size_t j=0;j<3;++j){const double d=a.states->Get(6*i+j)-in.reference.rows[i][j];d2+=d*d;}
  if(i%stride==stride-1){held2+=d2;maxHeld=std::max(maxHeld,std::sqrt(d2));++held;}else{train2+=d2;maxTrain=std::max(maxTrain,std::sqrt(d2));++train;}
 }
 const double tol=number(field(in.recipe,"positionToleranceKm"));
 const double heldRms=std::sqrt(held2/held);
 const bool regressed=in.recipe.contains("maximumHoldoutRmsKm") && heldRms>number(in.recipe["maximumHoldoutRmsKm"])+1e-9;
 return {{"version",1},{"status",regressed?"rejected-holdout-regression":(maxHeld<=tol && maxTrain<=tol?"validated":"requires-refinement")},{"trainingSamples",train},{"holdoutSamples",held},{"trainingRmsKm",std::sqrt(train2/train)},{"holdoutRmsKm",std::sqrt(held2/held)},{"maximumTrainingResidualKm",maxTrain},{"maximumHoldoutResidualKm",maxHeld},{"referenceSha256",in.sourceHash},{"seedSha256",in.seedHash},{"nativeId",in.reference.nativeId},{"epoch",in.seed->EPOCH},{"sampleCount",a.count},{"spanSeconds",(a.count-1)*600},{"policy",in.recipe},{"covarianceAvailable",false},{"note","Position-product consistency only; no independent orbit accuracy, covariance or identity certification."}};
}
int report(const Json& r) {const auto s=r.dump();return plugin_push_output_ex("report",nullptr,nullptr,PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,nullptr,0,1,reinterpret_cast<const uint8_t*>(s.data()),s.size())<0?1:0;}
// Two-pass modified Gram-Schmidt: require six observable independent columns.
bool fullRank(std::array<std::vector<double>,6> columns) {
 for(size_t j=0;j<6;++j){double norm=0;for(double x:columns[j])norm+=x*x;if(!std::isfinite(norm)||norm<=0)return false;norm=std::sqrt(norm);for(auto& x:columns[j])x/=norm;
  for(int pass=0;pass<2;++pass)for(size_t k=0;k<j;++k){double dot=0;for(size_t i=0;i<columns[j].size();++i)dot+=columns[j][i]*columns[k][i];for(size_t i=0;i<columns[j].size();++i)columns[j][i]-=dot*columns[k][i];}
  norm=0;for(double x:columns[j])norm+=x*x;if(!std::isfinite(norm)||norm<1e-16)return false;for(auto& x:columns[j])x/=std::sqrt(norm);
 }return true;
}
}
extern "C" int validate_epoch(void) {
 epoch_fit::Input in;if(!epoch_fit::load(in,1))return fail("Epoch validation requires a checked native position ephemeris, matching J2000/UTC seed and same-grid propagated OEM, and explicit model policy.");
 return epoch_fit::report(epoch_fit::quality(in));
}
extern "C" int fit_epoch_step(void) {
 using namespace epoch_fit;Input in;if(!load(in,7))return fail("Epoch fitting requires a seed, native ephemeris, nominal plus six perturbed trajectories and explicit model policy.");
 const auto& r=in.recipe;
 const double dp=number(field(r,"positionPerturbationKm")),dv=number(field(r,"velocityPerturbationKmS")),weight=number(field(r,"positionWeightKm")),rp=number(field(r,"positionRegularizationKm")),rv=number(field(r,"velocityRegularizationKmS"));
 if(!(std::isfinite(dp)&&dp>=1e-8&&dp<=10&&std::isfinite(dv)&&dv>=1e-10&&dv<=.1&&std::isfinite(weight)&&weight>0&&weight<=100&&std::isfinite(rp)&&rp>0&&rp<=1000&&std::isfinite(rv)&&rv>0&&rv<=10))return fail("Specify bounded positive perturbations, position weight and explicit regularization scales; these are tuning parameters, not provider covariance.");
 const auto& a=in.arcs[0];
 for(size_t col=0;col<6;++col)for(size_t j=0;j<6;++j) {
  const double expected=a.states->Get(j)+(j==col?(col<3?dp:dv):0);
  if(std::abs(in.arcs[col+1].states->Get(j)-expected)>1e-8)return fail("Perturbed trajectory seed mismatch; repropagate the current seed and exact perturbations.");
 }
 namespace core=sdn::estimation;core::BatchConfig config;config.maximum_iterations=1;config.sigma_edit_threshold=1e100;
 for(size_t j=0;j<6;++j){config.a_priori.value[j]=a.states->Get(j)*1000;const double scale=(j<3?rp:rv)*1000;config.a_priori_covariance[j*6+j]=scale*scale;}
 std::vector<core::Observation> observations;std::vector<core::PropagatorSample> samples;std::array<std::vector<double>,6> columns;
 const size_t stride=number(field(r,"holdoutStride"));
 for(size_t i=0;i<a.count;++i) {
  if(i%stride==stride-1)continue;
  core::Observation o;o.kind=core::MeasurementKind::POSITION_VECTOR;o.value_count=3;o.epoch_seconds=i*600;o.apply_light_time=false;o.apply_sagnac=false;
  core::PropagatorSample p;p.state.epoch_seconds=i*600;
  for(size_t j=0;j<6;++j)p.state.value[j]=a.states->Get(i*6+j)*1000;
  for(size_t j=0;j<3;++j){o.value[j]=in.reference.rows[i][j]*1000;o.sigma[j]=weight*1000;}
  for(size_t col=0;col<6;++col)for(size_t j=0;j<6;++j){const double d=(in.arcs[col+1].states->Get(i*6+j)-a.states->Get(i*6+j))/(col<3?dp:dv);if(!std::isfinite(d))return fail("Nonfinite sensitivity.");p.stm[j*6+col]=d;if(j<3)columns[col].push_back(d);}
  observations.push_back(o);samples.push_back(p);
 }
 if(!fullRank(columns))return fail("The supplied propagation sensitivities cannot constrain all six epoch-state components.");
 const auto fit=core::batch_weighted_least_squares(config,observations,samples);
 if(fit.iterations.size()!=1)return fail("The regularized epoch fit could not solve a bounded update.");
 double correctionPosition=0,correctionVelocity=0;for(size_t j=0;j<6;++j){const double d=(fit.estimate.value[j]-config.a_priori.value[j])/1000;if(!std::isfinite(d))return fail("Nonfinite fitted state.");(j<3?correctionPosition:correctionVelocity)+=d*d;}
 correctionPosition=std::sqrt(correctionPosition);correctionVelocity=std::sqrt(correctionVelocity);
 if(correctionPosition>rp || correctionVelocity>rv)return fail("Fit correction exceeds the configured trust region; refine model or sampling.");
 OPMT candidate=*in.seed;candidate.X=fit.estimate.value[0]/1000;candidate.Y=fit.estimate.value[1]/1000;candidate.Z=fit.estimate.value[2]/1000;candidate.X_DOT=fit.estimate.value[3]/1000;candidate.Y_DOT=fit.estimate.value[4]/1000;candidate.Z_DOT=fit.estimate.value[5]/1000;
 const double radius=std::sqrt(candidate.X*candidate.X+candidate.Y*candidate.Y+candidate.Z*candidate.Z),speed2=candidate.X_DOT*candidate.X_DOT+candidate.Y_DOT*candidate.Y_DOT+candidate.Z_DOT*candidate.Z_DOT;
 if(!std::isfinite(radius)||radius<=6356.7523||!std::isfinite(speed2)||speed2>=2*398600.4418/radius)return fail("Fit produced an invalid bound Earth-satellite state.");
 candidate.ORIGINATOR="SDN position-arc epoch fit";
 candidate.SEMI_MAJOR_AXIS=0;candidate.ECCENTRICITY=0;candidate.INCLINATION=0;candidate.RA_OF_ASC_NODE=0;candidate.ARG_OF_PERICENTER=0;candidate.TRUE_ANOMALY=0;candidate.MEAN_ANOMALY=0;
 auto result=quality(in);result["status"]="candidate-needs-propagation";result["positionCorrectionKm"]=correctionPosition;result["velocityCorrectionKmS"]=correctionVelocity;result["note"]="Unvalidated candidate. Repropagate and validate against training AND held-out positions; retain original state. No covariance is emitted.";
 flatbuffers::FlatBufferBuilder b(512);b.FinishSizePrefixed(CreateOPM(b,&candidate),OPMIdentifier());
 if(plugin_push_output_ex("candidate","OPM.fbs","$OPM",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"OPM",0,0,b.GetBufferPointer(),b.GetSize())<0)return 1;
 return report(result);
}
