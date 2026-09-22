// Compiled after the shared reader surface; reuses its checked NCD framing.
extern "C" int normalize_vimpel(void) {
 ContainerFrame frame;const int rc=decode_container_frame("normalize_vimpel",&frame);if(rc)return rc;
 auto bad=[](const char* message){plugin_set_error("invalid-vimpel-elements",message);return 400;};
 const auto* d=frame.descriptor;
 if(plugin_get_input_count()!=1 || d->FORMAT()!=ncdContainerFormat::PROVIDER_DEFINED || !d->PROVIDER_DEFINED_FORMAT_NAME() || d->PROVIDER_DEFINED_FORMAT_NAME()->str()!="vimpel-orbits-text" || !d->SOURCE_SHA256() || d->SOURCE_SHA256()->size()!=64 || d->SOURCE_BYTE_LENGTH()!=frame.body_length)return bad("Require a hash-verified Vimpel orbit-table NCD and exact raw bytes.");
 std::vector<sdn::vimpel::Elements> records;
 if(!sdn::vimpel::elements(frame.body,frame.body_length,records))return bad("Malformed, duplicate or unsupported Vimpel orbit row; no output was published.");
 std::vector<OPMT> states;states.reserve(records.size());
 for(const auto& r:records) {
  const auto& v=r.values;const double rad=sdn::orbits::kPi/180,mu=398600.4418;
  double anomaly=std::fmod(v[4]-v[5]+360,360);
  sdn::orbits::Keplerian k{v[0]*1000,v[3],v[1]*rad,v[2]*rad,v[5]*rad,anomaly*rad};
  sdn::orbits::Cartesian c;
  if(!sdn::orbits::cartesianFromKeplerian(k,mu*1e9,&c) || sdn::orbits::norm(c.position)<=6356752.3)return bad("The osculating elements do not produce a finite exterior-Earth state.");
  OPMT o;o.CCSDS_OPM_VERS="2.0";o.ORIGINATOR="SDN Vimpel osculating converter";
  o.OBJECT_NAME="vimpel:"+r.canonicalId; // Never invent a COSPAR/NORAD identity.
  o.CENTER_NAME="EARTH";o.REF_FRAME="J2000";o.TIME_SYSTEM="UTC";o.EPOCH=r.epoch;
  o.X=c.position.x/1000;o.Y=c.position.y/1000;o.Z=c.position.z/1000;
  o.X_DOT=c.velocity.x/1000;o.Y_DOT=c.velocity.y/1000;o.Z_DOT=c.velocity.z/1000;
  o.SEMI_MAJOR_AXIS=v[0];o.ECCENTRICITY=v[3];o.INCLINATION=v[1];o.RA_OF_ASC_NODE=v[2];o.ARG_OF_PERICENTER=v[5];o.TRUE_ANOMALY=anomaly;o.GM=mu;
  states.push_back(o);
 }
 for(const auto& o:states) {
  flatbuffers::FlatBufferBuilder b(512);b.FinishSizePrefixed(CreateOPM(b,&o),OPMIdentifier());
  if(plugin_push_output_ex("states","OPM.fbs","$OPM",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"OPM",0,0,b.GetBufferPointer(),b.GetSize())<0)return 500;
 }
 // Exact descriptor preserves raw CID/hash, so all source fields remain recoverable.
 return plugin_push_output_ex("descriptor","NCD.fbs","$NCD",PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,"NCD",0,8,frame.descriptor_bytes.data(),frame.descriptor_bytes.size())<0?500:0;
}
