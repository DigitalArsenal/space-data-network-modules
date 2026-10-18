// analysis/rpo-history: product provenance (SDS $PVN).
//
// The relative-motion records name the source their element sets come from
// and the terms that source travels under, and this module as the software
// that made them. Sets whose sources differ give a record with no single
// source, and license classes that differ give CiteOnly: terms that differ
// are never a grant.
namespace {

// The module and its version; build.mjs defines MODULE_PRODUCER from
// plugin-manifest.json. A constant, not a std::string: static initializers do
// not run before a method is invoked.
constexpr const char* kProducer = MODULE_PRODUCER;

struct Source {
  std::string sourceId, originator, providerId, licenseId, lineage;
  pvnSourceKind kind = pvnSourceKind::Unspecified;
  pvnLicenseClass license = pvnLicenseClass::Unspecified;
  bool set = false;
};

Source sourceOf(const PVN* pvn) {
  Source s;
  s.set = true;
  if (!pvn) return s;
  s.sourceId = textOf(pvn->SOURCE_ID());
  s.kind = pvn->SOURCE_KIND();
  s.originator = textOf(pvn->ORIGINATOR());
  s.providerId = textOf(pvn->PROVIDER_ID());
  s.license = pvn->LICENSE_CLASS();
  s.licenseId = textOf(pvn->LICENSE_ID());
  s.lineage = textOf(pvn->LINEAGE());
  return s;
}

Source agreement(const Source& a, const Source& b) {
  if (!a.set) return b;
  if (!b.set) return a;
  const auto same = [](const std::string& x, const std::string& y) { return x == y ? x : std::string(); };
  Source c;
  c.set = true;
  c.sourceId = same(a.sourceId, b.sourceId);
  c.originator = same(a.originator, b.originator);
  c.providerId = same(a.providerId, b.providerId);
  c.licenseId = same(a.licenseId, b.licenseId);
  c.lineage = same(a.lineage, b.lineage);
  c.kind = a.kind == b.kind ? a.kind : pvnSourceKind::Unspecified;
  c.license = a.license == b.license ? a.license : pvnLicenseClass::CiteOnly;
  return c;
}

flatbuffers::Offset<PVN> encodeProvenance(flatbuffers::FlatBufferBuilder& fb, const Source& s) {
  const auto text = [&fb](const std::string& v) { return v.empty() ? flatbuffers::Offset<flatbuffers::String>() : fb.CreateString(v); };
  const auto sourceId = text(s.sourceId);
  const auto originator = text(s.originator);
  const auto providerId = text(s.providerId);
  const auto producer = fb.CreateString(kProducer);
  const auto licenseId = text(s.licenseId);
  const auto lineage = text(s.lineage);
  return CreatePVN(fb, sourceId, s.kind, originator, providerId, producer, s.license, licenseId, lineage);
}
}  // namespace
