// Compiled after the shared reader surface; reuses its checked NCD framing,
// the CelestialFrame roster and the VCM parser and projection headers.
namespace {

int emit_ocm(const OCMT& ocm) {
 flatbuffers::FlatBufferBuilder b(4096);
 b.FinishSizePrefixed(CreateOCM(b,&ocm),OCMIdentifier());
 return plugin_push_output_ex("orbit","OCM.fbs","$OCM",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"OCM",0,0,
                              b.GetBufferPointer(),b.GetSize())<0?500:0;
}

bool roster_frame(const std::string& name,CelestialFrame* out) {return celestial_frame_for(name,out);}

}  // namespace

// Legacy SP Vector/Covariance Message V2.0 text, delivered as a
// hash-verified $NCD container, to one $OCM.
extern "C" int normalize_vcm(void) {
 ContainerFrame frame;
 const int rc=decode_container_frame("normalize_vcm",&frame);
 if(rc)return rc;
 const auto* d=frame.descriptor;
 if(plugin_get_input_count()!=1 || d->FORMAT()!=ncdContainerFormat::PROVIDER_DEFINED ||
    !d->PROVIDER_DEFINED_FORMAT_NAME() || d->PROVIDER_DEFINED_FORMAT_NAME()->str()!="vcm-v2-text" ||
    !d->SOURCE_SHA256() || d->SOURCE_SHA256()->size()!=64 || d->SOURCE_BYTE_LENGTH()!=frame.body_length) {
  plugin_set_error("invalid-vcm","Require a hash-verified vcm-v2-text NCD and the exact message bytes.");
  return 400;
 }
 sdn::vcm::Message message;
 std::string error;
 if(!sdn::vcm::parse(frame.body,frame.body_length,message,error)) {
  plugin_set_error("invalid-vcm",("Malformed SP Vector/Covariance Message: "+error+"; no output was published.").c_str());
  return 400;
 }
 OCMT ocm;
 sdn::vcm::projectLegacy(message,ocm);
 if(const int e=emit_ocm(ocm))return e;
 // The exact descriptor keeps the source hash, so every source field stays recoverable.
 return plugin_push_output_ex("descriptor","NCD.fbs","$NCD",PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,"NCD",0,8,
                              frame.descriptor_bytes.data(),frame.descriptor_bytes.size())<0?500:0;
}

// Superseded SDS $VCM record to $OCM.
extern "C" int vcm_to_ocm(void) {
 const int32_t index=plugin_find_input_index("vcm",0);
 const plugin_input_frame_t* frame=index>=0?plugin_get_input_frame(static_cast<uint32_t>(index)):nullptr;
 if(!frame || !frame->payload || frame->payload_length<12) {
  plugin_set_error("missing-vcm-frame","vcm_to_ocm requires a $VCM frame on port \"vcm\".");
  return 400;
 }
 // Aligned copy: 8-byte scalars are read in place.
 std::vector<uint8_t> bytes(frame->payload,frame->payload+frame->payload_length);
 const VCM* record=nullptr;
 if(VCMBufferHasIdentifier(bytes.data())) {
  flatbuffers::Verifier verifier(bytes.data(),bytes.size());
  if(VerifyVCMBuffer(verifier))record=GetVCM(bytes.data());
 } else if(SizePrefixedVCMBufferHasIdentifier(bytes.data())) {
  flatbuffers::Verifier verifier(bytes.data(),bytes.size());
  if(VerifySizePrefixedVCMBuffer(verifier))record=GetSizePrefixedVCM(bytes.data());
 }
 if(!record) {
  plugin_set_error("bad-vcm","The frame is not a verifiable $VCM buffer.");
  return 400;
 }
 OCMT ocm;
 std::string error;
 if(!sdn::vcm::projectRecord(*record,ocm,roster_frame,error)) {
  plugin_set_error("invalid-vcm",error.c_str());
  return 400;
 }
 return emit_ocm(ocm);
}
