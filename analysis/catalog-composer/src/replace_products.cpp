// Explicit whole-list replacement for a catalog controller's selected product.
// The caller stores the product before publishing this index record.
extern "C" int replace_products() {
  using namespace integrate;
  const plugin_input_frame_t *catalog = nullptr, *product = nullptr, *decision = nullptr, *recipe_frame = nullptr;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || !f->payload) return refuse("invalid-replacement", "Missing input bytes or port.");
    const plugin_input_frame_t** slot = nullptr;
    const std::string port = f->port_id;
    if (port == "catalog") slot = &catalog;
    else if (port == "ocm_products") slot = &product;
    else if (port == "decision") slot = &decision;
    else if (port == "recipe") slot = &recipe_frame;
    if (!slot || *slot || f->payload_length > 8 * 1024 * 1024)
      return refuse("invalid-replacement", "Unknown, repeated, or oversized input.");
    *slot = f;
  }
  const auto* message = read_xmt(recipe_frame, 1024 * 1024);
  const auto* recipe = message ? message->INTEGRATE_RECIPE() : nullptr;
  if (!catalog || !recipe || recipe->AS_OF_MS() <= 0 || recipe->AS_OF_MS() > INT64_MAX / 1000)
    return refuse("invalid-replacement", "One CAT and a positive bounded AS_OF_MS are required.");
  flatbuffers::Verifier check(catalog->payload, catalog->payload_length);
  if (catalog->payload_length < 12 || flatbuffers::ReadScalar<uint32_t>(catalog->payload) != catalog->payload_length - 4 ||
      !VerifySizePrefixedCATBuffer(check)) return refuse("invalid-replacement", "Expected one size-prefixed CAT.");
  auto record = std::unique_ptr<CATT>(GetSizePrefixedCAT(catalog->payload)->UnPack());
  if (!record->NORAD_CAT_ID) return refuse("invalid-replacement", "The catalog object requires its typed identifier.");
  const int64_t as_of = recipe->AS_OF_MS() * 1000;
  std::string reason;
  if (decision) {
    flatbuffers::Verifier d(decision->payload, decision->payload_length);
    if (!VerifyQRPBuffer(d)) return refuse("invalid-replacement", "The selection explanation must be a QRP.");
    const auto* q = GetQRP(decision->payload);
    if (q->MESSAGE()) reason = q->MESSAGE()->str();
  }
  record->PRODUCTS.clear();
  if (product) {
    flatbuffers::Verifier p(product->payload, product->payload_length);
    if (product->payload_length < 12 || flatbuffers::ReadScalar<uint32_t>(product->payload) != product->payload_length - 4 ||
        !VerifySizePrefixedOCMBuffer(p)) return refuse("invalid-replacement", "Expected one size-prefixed OCM.");
    const auto* o = GetSizePrefixedOCM(product->payload);
    const auto* m = o->METADATA(); const auto* elements = o->MEAN_ELEMENTS();
    if (!m || m->NORAD_CAT_ID() != record->NORAD_CAT_ID || !elements || !elements->EPOCH())
      return refuse("invalid-replacement", "Selected orbit does not identify this catalog object and epoch.");
    const auto kind = product_kind(elements->MEAN_ELEMENT_THEORY());
    if (kind == catalogProductKind::Unspecified)
      return refuse("invalid-replacement", "Selected orbit has no supported element theory.");
    const auto* provenance = o->PROVENANCE();
    const auto source = provenance && provenance->SOURCE_ID() ? provenance->SOURCE_ID()->str() : "";
    auto selected = cat_product(kind, product->payload, product->payload_length, source, elements->EPOCH()->str(), xmtSelectionReason::UnmeasuredFallbackOrder);
    if (!reason.empty()) selected->SELECTION_REASON = reason;
    selected->STALE = false;
    record->PRODUCTS.push_back(std::move(selected));
  }
  record->PRODUCTS_AS_OF = iso_of(as_of);
  flatbuffers::FlatBufferBuilder b;
  // The object API omits empty vectors. Reserve a product slot for a removal,
  // then set the serialized vector length to zero before emitting it.
  const bool removal = record->PRODUCTS.empty();
  if (removal) record->PRODUCTS.push_back(std::make_unique<CATProductT>());
  const auto packed = CAT::Pack(b, record.get());
  FinishSizePrefixedCATBuffer(b, packed);
  if (removal) flatbuffers::WriteScalar<uint32_t>(
      const_cast<void*>(static_cast<const void*>(GetSizePrefixedCAT(b.GetBufferPointer())->PRODUCTS())), 0);
  return plugin_push_output_ex("catalog", "CAT.fbs", "$CAT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
      "CAT", 0, 0, b.GetBufferPointer(), b.GetSize()) < 0 ? refuse("output", "Cannot emit catalog replacement.") : 0;
}
