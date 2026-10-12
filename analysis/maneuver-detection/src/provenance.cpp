// analysis/maneuver-detection: product provenance (SDS $PVN).
//
// A maneuver names the source its data comes from and the terms that source
// travels under, and this module as the software that made it. The source is
// the input's PROVENANCE ($OMM element sets, $MNV planned maneuvers); an input
// that has none (an $OEM) gives a record that names only its producer, with
// the licence class Unspecified, which is never a grant.
namespace {

// The module and its version; build.mjs defines MODULE_PRODUCER from
// plugin-manifest.json. A constant, not a std::string: static initializers do
// not run before a method is invoked, and a std::string global is then empty.
constexpr const char* kProducer = MODULE_PRODUCER;

struct Source {
  std::string sourceId, originator, providerId, licenseId, lineage;
  pvnSourceKind kind = pvnSourceKind::Unspecified;
  pvnLicenseClass licence = pvnLicenseClass::Unspecified;
};

std::string textOf(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

Source sourceOf(const PVN* pvn) {
  Source s;
  if (!pvn) return s;
  s.sourceId = textOf(pvn->SOURCE_ID());
  s.kind = pvn->SOURCE_KIND();
  s.originator = textOf(pvn->ORIGINATOR());
  s.providerId = textOf(pvn->PROVIDER_ID());
  s.licence = pvn->LICENSE_CLASS();
  s.licenseId = textOf(pvn->LICENSE_ID());
  s.lineage = textOf(pvn->LINEAGE());
  return s;
}

// What the sources of one object's element sets have in common. A field they
// differ in is empty (the record has no single source, provider or lineage),
// and licence classes that differ give CiteOnly: terms that differ are never
// a grant.
Source agreement(const Source& a, const Source& b) {
  const auto same = [](const std::string& x, const std::string& y) { return x == y ? x : std::string(); };
  Source c;
  c.sourceId = same(a.sourceId, b.sourceId);
  c.originator = same(a.originator, b.originator);
  c.providerId = same(a.providerId, b.providerId);
  c.licenseId = same(a.licenseId, b.licenseId);
  c.lineage = same(a.lineage, b.lineage);
  c.kind = a.kind == b.kind ? a.kind : pvnSourceKind::Unspecified;
  c.licence = a.licence == b.licence ? a.licence : pvnLicenseClass::CiteOnly;
  return c;
}

// The record's PROVENANCE: the source's fields, and this module as PRODUCER.
flatbuffers::Offset<PVN> encodeProvenance(flatbuffers::FlatBufferBuilder& fb, const Source& s) {
  const auto text = [&fb](const std::string& v) { return v.empty() ? flatbuffers::Offset<flatbuffers::String>() : fb.CreateString(v); };
  const auto sourceId = text(s.sourceId);
  const auto originator = text(s.originator);
  const auto providerId = text(s.providerId);
  const auto producer = fb.CreateString(kProducer);
  const auto licenseId = text(s.licenseId);
  const auto lineage = text(s.lineage);
  return CreatePVN(fb, sourceId, s.kind, originator, providerId, producer, s.licence, licenseId, lineage);
}
}  // namespace
