// Add population time histories without reserializing the supplied orbit tables.
// The primary covariance remains the fit posterior, in its original parameter layout.
namespace population_annotation {
using namespace objectcov;

const plugin_input_frame_t* single(const char* port) {
  const plugin_input_frame_t* found = nullptr;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && !std::strcmp(f->port_id, port)) {
      if (found) return nullptr;
      found = f;
    }
  }
  return found;
}

// Each block retains its own metadata. Equal strings share one wire allocation.
flatbuffers::Offset<CVR> pack_realism(flatbuffers::FlatBufferBuilder& b, const CVRT& c) {
  const auto model_id = c.MODEL_ID.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateSharedString(c.MODEL_ID);
  const auto regime = c.REGIME.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateSharedString(c.REGIME);
  const auto measured_lineage = c.MEASURED_LINEAGE.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateSharedString(c.MEASURED_LINEAGE);
  const auto test_window = c.TEST_WINDOW.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateSharedString(c.TEST_WINDOW);
  const auto evidence = c.EVIDENCE.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateSharedString(c.EVIDENCE);
  const auto history_window = c.HISTORY_WINDOW.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateSharedString(c.HISTORY_WINDOW);
  CVRBuilder out(b);
  out.add_RULE(c.RULE);
  if (!std::isnan(c.AGE_DAYS)) out.add_AGE_DAYS(c.AGE_DAYS);
  if (!std::isnan(c.HORIZON_DAYS)) out.add_HORIZON_DAYS(c.HORIZON_DAYS);
  if (!std::isnan(c.MEAN_D2_OVER_3)) out.add_MEAN_D2_OVER_3(c.MEAN_D2_OVER_3);
  if (!std::isnan(c.COVERAGE_95)) out.add_COVERAGE_95(c.COVERAGE_95);
  out.add_SAMPLES(c.SAMPLES);
  out.add_OBJECTS(c.OBJECTS);
  if (!std::isnan(c.SCALE_FACTOR)) out.add_SCALE_FACTOR(c.SCALE_FACTOR);
  out.add_CALIBRATION(c.CALIBRATION);
  out.add_HISTORY_SAMPLES(c.HISTORY_SAMPLES);
  out.add_HISTORY_SETS(c.HISTORY_SETS);
  if (!std::isnan(c.SHRINKAGE_WEIGHT)) out.add_SHRINKAGE_WEIGHT(c.SHRINKAGE_WEIGHT);
  out.add_TRUTH_EPOCHS(c.TRUTH_EPOCHS);
  if (!std::isnan(c.COVERAGE_1_SIGMA_AXIS1)) out.add_COVERAGE_1_SIGMA_AXIS1(c.COVERAGE_1_SIGMA_AXIS1);
  if (!std::isnan(c.COVERAGE_1_SIGMA_AXIS2)) out.add_COVERAGE_1_SIGMA_AXIS2(c.COVERAGE_1_SIGMA_AXIS2);
  if (!std::isnan(c.COVERAGE_1_SIGMA_AXIS3)) out.add_COVERAGE_1_SIGMA_AXIS3(c.COVERAGE_1_SIGMA_AXIS3);
  if (!std::isnan(c.COVERAGE_3_SIGMA_AXIS1)) out.add_COVERAGE_3_SIGMA_AXIS1(c.COVERAGE_3_SIGMA_AXIS1);
  if (!std::isnan(c.COVERAGE_3_SIGMA_AXIS2)) out.add_COVERAGE_3_SIGMA_AXIS2(c.COVERAGE_3_SIGMA_AXIS2);
  if (!std::isnan(c.COVERAGE_3_SIGMA_AXIS3)) out.add_COVERAGE_3_SIGMA_AXIS3(c.COVERAGE_3_SIGMA_AXIS3);
  out.add_MODEL_ID(model_id);
  out.add_REGIME(regime);
  out.add_MEASURED_LINEAGE(measured_lineage);
  out.add_TEST_WINDOW(test_window);
  out.add_EVIDENCE(evidence);
  out.add_HISTORY_WINDOW(history_window);
  return out.Finish();
}

flatbuffers::Offset<OCMCovarianceBlock> pack_block(flatbuffers::FlatBufferBuilder& b,
    const OCMCovarianceBlockT& c) {
  std::vector<flatbuffers::Offset<CVR>> labels;
  for (const auto& label : c.COV_REALISM) labels.push_back(pack_realism(b, *label));
  const auto realism = b.CreateVector(labels);
  std::vector<flatbuffers::Offset<flatbuffers::String>> rows;
  for (const auto& line : c.LINES) rows.push_back(b.CreateString(line));
  const auto lines = b.CreateVector(rows);
  const auto id = b.CreateSharedString(c.COV_ID);
  const auto basis = b.CreateSharedString(c.COV_BASIS);
  const auto model = b.CreateSharedString(c.COV_BASIS_ID);
  const auto frame = b.CreateSharedString(c.COV_REF_FRAME);
  const auto type = b.CreateSharedString(c.COV_TYPE);
  const auto units = b.CreateSharedString(c.COV_UNITS);
  OCMCovarianceBlockBuilder out(b);
  out.add_COV_ID(id); out.add_COV_BASIS(basis); out.add_COV_BASIS_ID(model);
  out.add_COV_REF_FRAME(frame); out.add_COV_TYPE(type); out.add_COV_UNITS(units);
  out.add_COV_ORDERING(c.COV_ORDERING); out.add_LINES(lines); out.add_COV_REALISM(realism);
  return out.Finish();
}

// Choose the shortest significant-digit spelling that round-trips exactly.
// The standard stores covariance-block rows as text, not binary doubles.
std::string decimal(double value) {
  char text[40];
  for (int digits = 1; digits <= 17; ++digits) {
    std::snprintf(text, sizeof text, "%.*g", digits, value);
    const double parsed = std::strtod(text, nullptr);
    if (std::memcmp(&parsed, &value, sizeof value) == 0) break;
  }
  return text;
}

// FlatBuffer offsets are forward references. Retain the entire original buffer
// verbatim, then build a new root whose original fields reference that copy.
// Only the root offsets and the added annotation fields have a new encoding.
std::vector<uint8_t> append(const uint8_t* data, size_t size, const OCM* orbit,
    const std::vector<std::unique_ptr<OCMCovarianceBlockT>>& blocks,
    const std::vector<std::unique_ptr<CVRT>>& labels) {
  flatbuffers::FlatBufferBuilder b;
  std::vector<flatbuffers::Offset<OCMCovarianceBlock>> block_offsets;
  for (const auto& block : blocks) block_offsets.push_back(pack_block(b, *block));
  std::vector<flatbuffers::Offset<CVR>> label_offsets;
  for (const auto& label : labels) label_offsets.push_back(pack_realism(b, *label));
  // Keep the original buffer's eight-byte alignment, including its prefix.
  b.Pad((8 - (b.GetSize() + size) % 8) % 8);
  b.PushBytes(data, size);
  const auto copied = b.GetSize();
  auto offset = [&](const void* p) { return copied - (static_cast<const uint8_t*>(p) - data); };
  if (orbit->COVARIANCE_BLOCKS()) {
    std::vector<flatbuffers::Offset<OCMCovarianceBlock>> previous;
    for (const auto* block : *orbit->COVARIANCE_BLOCKS()) previous.emplace_back(offset(block));
    block_offsets.insert(block_offsets.begin(), previous.begin(), previous.end());
  }
  if (orbit->COV_REALISM()) {
    std::vector<flatbuffers::Offset<CVR>> previous;
    for (const auto* label : *orbit->COV_REALISM()) previous.emplace_back(offset(label));
    label_offsets.insert(label_offsets.begin(), previous.begin(), previous.end());
  }
  const auto block_vector = block_offsets.empty() ? flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<OCMCovarianceBlock>>>() : b.CreateVector(block_offsets);
  const auto label_vector = label_offsets.empty() ? flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<CVR>>>() : b.CreateVector(label_offsets);
  const auto* root = reinterpret_cast<const uint8_t*>(orbit);
  const auto* vtable = root - flatbuffers::ReadScalar<flatbuffers::soffset_t>(root);
  const auto vsize = flatbuffers::ReadScalar<flatbuffers::voffset_t>(vtable);
  const auto start = b.StartTable();
  b.ForceDefaults(true);
  for (flatbuffers::voffset_t field = 4; field < vsize; field += 2) {
    const auto at = flatbuffers::ReadScalar<flatbuffers::voffset_t>(vtable + field);
    if (!at || field == OCM::VT_COVARIANCE_BLOCKS || field == OCM::VT_COV_REALISM) continue;
    const auto* value = root + at;
    const auto* type=OCMTypeTable();const size_t slot=(field-4)/2;
    if(slot>=type->num_elems)return {};
    const auto code=type->type_codes[slot];
    if(code.is_repeating||code.base_type==flatbuffers::ET_STRING||code.base_type==flatbuffers::ET_SEQUENCE){
      b.AddOffset(field,flatbuffers::Offset<void>(offset(value+flatbuffers::ReadScalar<flatbuffers::uoffset_t>(value))));continue;
    }
    // Copy scalar bit patterns with the width from the generated schema metadata.
    switch(code.base_type){
      case flatbuffers::ET_UTYPE:case flatbuffers::ET_BOOL:case flatbuffers::ET_CHAR:case flatbuffers::ET_UCHAR:b.AddElement<uint8_t>(field,*value,0);break;
      case flatbuffers::ET_SHORT:case flatbuffers::ET_USHORT:b.AddElement<uint16_t>(field,flatbuffers::ReadScalar<uint16_t>(value),0);break;
      case flatbuffers::ET_INT:case flatbuffers::ET_UINT:case flatbuffers::ET_FLOAT:b.AddElement<uint32_t>(field,flatbuffers::ReadScalar<uint32_t>(value),0);break;
      case flatbuffers::ET_LONG:case flatbuffers::ET_ULONG:case flatbuffers::ET_DOUBLE:b.AddElement<uint64_t>(field,flatbuffers::ReadScalar<uint64_t>(value),0);break;
      default:return {};
    }
  }
  b.AddOffset(OCM::VT_COVARIANCE_BLOCKS, block_vector);
  b.AddOffset(OCM::VT_COV_REALISM, label_vector);
  const auto result = flatbuffers::Offset<OCM>(b.EndTable(start));
  FinishSizePrefixedOCMBuffer(b, result);
  return {b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize()};
}
}  // namespace population_annotation

extern "C" int annotate_population() {
  using namespace population_annotation;
  const auto* input = single("ocm");
  const auto* seed = single("elements");
  if (!input || !seed || input->payload_length > 8 * 1024 * 1024 || seed->payload_length > 1024 * 1024)
    return fail("invalid-input", "One bounded OCM and one seed OMM are required.");
  flatbuffers::Verifier verifier(input->payload, input->payload_length);
  if (input->payload_length < 12 || flatbuffers::ReadScalar<uint32_t>(input->payload) != input->payload_length - 4 ||
      !VerifySizePrefixedOCMBuffer(verifier)) return fail("invalid-ocm", "Expected one size-prefixed OCM.");
  flatbuffers::Verifier seed_verifier(seed->payload, seed->payload_length);
  if (seed->payload_length < 12 || flatbuffers::ReadScalar<uint32_t>(seed->payload) != seed->payload_length - 4 ||
      !VerifySizePrefixedOMMBuffer(seed_verifier)) return fail("invalid-elements", "Expected one size-prefixed seed OMM.");
  const auto* orbit = GetSizePrefixedOCM(input->payload);
  const auto* omm = GetSizePrefixedOMM(seed->payload);
  const auto* root = reinterpret_cast<const uint8_t*>(orbit);
  const auto* vt = root - flatbuffers::ReadScalar<flatbuffers::soffset_t>(root);
  if (flatbuffers::ReadScalar<flatbuffers::voffset_t>(vt) > OCM::VT_RPO_INSPECTION + 2)
    return fail("unsupported-ocm", "The OCM root contains fields outside the pinned contract.");
  if (!orbit->MEAN_ELEMENTS() || !orbit->METADATA() || !orbit->METADATA()->NORAD_CAT_ID() ||
      orbit->METADATA()->NORAD_CAT_ID() != omm->NORAD_CAT_ID())
    return fail("seed-mismatch", "The seed and orbit must identify the same object.");
  Instant seed_epoch,record_epoch;bool epoch_matches=false;
  if(parse_instant(omm->EPOCH(),&seed_epoch)){
    if(orbit->MEAN_ELEMENTS()->MEAN_ELEMENT_THEORY()==meanElementSource::AP){
      const auto* stats=orbit->ORBIT_DETERMINATION()?orbit->ORBIT_DETERMINATION()->FIT_STATISTICS():nullptr;Instant start,stop;
      epoch_matches=stats&&parse_instant(stats->FIT_START(),&start)&&parse_instant(stats->FIT_STOP(),&stop)&&
        std::abs(seconds_between(seed_epoch,start)+216000)<.001&&std::abs(seconds_between(seed_epoch,stop)-432000)<.001;
    }else epoch_matches=parse_instant(orbit->MEAN_ELEMENTS()->EPOCH(),&record_epoch)&&std::abs(seconds_between(seed_epoch,record_epoch))<.001;
  }
  if(!epoch_matches)return fail("seed-epoch-mismatch","The seed epoch must match the ingested epoch or the exact-W fit interval.");
  if (orbit->COVARIANCE_BLOCKS()) for (const auto* block : *orbit->COVARIANCE_BLOCKS())
    if (block->COV_ID() && block->COV_ID()->str().rfind("population/", 0) == 0)
      return fail("already-annotated", "Annotate the original fitted or fallback record once.");
  sp::Model model; Options options; bool has_model = false;
  auto error = read_population_model(&model, &options, &has_model);
  if (!error.empty()) return fail("invalid-models", error);
  if (!has_model || options.ages.size() != 7)
    return fail("invalid-models", "The seven-block contract requires a model with seven age bins.");
  std::vector<double> ages;
  for (const auto& bin : options.ages) {
    const auto age = (bin.first + bin.second) / 2;
    if (!(std::isfinite(age) && bin.first >= 0 && bin.second > bin.first))
      return fail("invalid-models", "Population age bins must be finite, forward intervals.");
    ages.push_back(age);
  }
  std::vector<ElementSet> sets; Counts counts;
  if (!load_elements(options, sets, counts, true) || sets.size() != 1)
    return fail("invalid-elements", "Expected one usable seed element set.");
  const auto& anchor = sets.front();
  std::vector<std::unique_ptr<OCMCovarianceBlockT>> blocks;
  std::vector<std::unique_ptr<CVRT>> labels;
  std::string uncovered;
  for (size_t i = 0; i < ages.size(); ++i) {
    const double age = ages[i];
    const int bin = age_of(options, age);
    std::vector<double> covariance; double factor = 1;
    if (anchor.regime < 0 || bin < 0) { uncovered = "OUTSIDE: regime or age outside population support"; break; }
    if (!evaluate_population(model.sm, anchor.regime, age, &covariance, &factor)) {
      uncovered = "NO_MODEL: no population cells for this regime"; break;
    }
    double r[3], v[3]; StateFailure why;
    if (!state_at(anchor, age, r, v, &why)) { uncovered = "NO_STATE: " + why.message; break; }
    double rtn[36]{}, inertial[36], axes[3][3];
    for (int a = 0, k = 0; a < 6; ++a)
      for (int c = 0; c <= a; ++c, ++k) rtn[6*a+c] = rtn[6*c+a] = covariance[k] * factor;
    axes_of(r, v, axes); rotate6(axes, rtn, inertial, false);
    if (!std::all_of(inertial, inertial + 36, [](double x) { return std::isfinite(x); }))
      { uncovered="NON_FINITE: population matrix is not finite";break; }
    sp::Label label;
    label.rule = model.pooled ? 4 : 3; label.method = model.pooled ? "e14-s3-kc-pooled" : "e14-s3-kc";
    label.model_id = model.id; label.regime = options.regimes[anchor.regime].id;
    label.age_days = age; label.age_index = bin; label.calibration = "UNCALIBRATED";
    sp::population_verdict(model, anchor.regime, bin, &label);
    label.calibration = "UNCALIBRATED";
    label.evidence = model.evidence + " | SGP4 seed population prior; RTN rotated with the seed SGP4 state; not AP-fit error; not calibrated for this object";
    auto block = std::make_unique<OCMCovarianceBlockT>();
    block->COV_ID = "population/" + std::to_string(i);
    block->COV_BASIS = "EMPIRICAL"; block->COV_BASIS_ID = model.id;
    block->COV_REF_FRAME = "GCRF"; block->COV_TYPE = "CARTPV";
    block->COV_ORDERING = covarianceOrdering::LTM;
    block->COV_UNITS = "km km km km/s km/s km/s";
    std::string line = sp::iso_micro(ffmcal::plus_seconds(anchor.epoch, age * 86400));
    for (int row = 0; row < 6; ++row)
      for (int col = 0; col <= row; ++col) line += " " + decimal(inertial[6 * row + col]);
    block->LINES.push_back(line); block->COV_REALISM.push_back(sp::realism_of(label));
    blocks.push_back(std::move(block));
  }
  if (!uncovered.empty()) {
    blocks.clear();
    auto label = std::make_unique<CVRT>();
    label->MODEL_ID = model.id; label->CALIBRATION = covarianceCalibration::Uncalibrated;
    label->EVIDENCE = "no population covariance (" + uncovered + ")";
    labels.push_back(std::move(label));
  }
  if (orbit->COVARIANCE_DATA() && orbit->COVARIANCE_DATA()->size()) {
    auto formal = std::make_unique<CVRT>();
    formal->CALIBRATION = covarianceCalibration::Uncalibrated;
    formal->EVIDENCE = "Formal fit posterior at the record epoch in the fit parameter layout; no realism scaling or calibration applied.";
    labels.push_back(std::move(formal));
  }
  const auto output = append(input->payload, input->payload_length, orbit, blocks, labels);
  flatbuffers::Verifier output_verifier(output.data(),output.size());
  if(output.empty()||!VerifySizePrefixedOCMBuffer(output_verifier))return fail("invalid-output","Annotated orbit failed verification.");
  return plugin_push_output_ex("ocm", "OCM.fbs", "$OCM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
      "OCM", 0, 0, output.data(), output.size()) < 0 ? fail("output", "Cannot emit annotated orbit.") : 0;
}
