// Compiled after the shared reader surface; reuses its checked NCD framing,
// the OEM epoch text and the calendar arithmetic of the OEM reader.
//
// normalize_ses_i11: an Intelsat eleven-parameter ephemeris file (provider
// format "ses-i11"), hash-checked against its $NCD, evaluated by the IESS-412
// model (sdn::i11, Orekit 13.1's formulation) from its epoch to its stated
// validity end every kI11StepSeconds, as one Earth-fixed $OEM block on UTC.
// The file's own printed prediction (longitude and latitude at a stated hour)
// is evaluated first; a file the model does not reproduce to the printed
// precision is refused rather than read.
namespace {
constexpr double kI11StepSeconds = 300.0;
constexpr double kI11DefaultSpanHours = 170.0;    // the span the format's own check value covers
constexpr double kI11CheckToleranceDeg = 0.00006; // half the printed 1e-4 deg, plus rounding of the inputs
}  // namespace

extern "C" int normalize_ses_i11(void) {
    ContainerFrame frame;
    const int rc = decode_container_frame("normalize_ses_i11", &frame);
    if (rc) return rc;
    auto bad = [](const char* code, const std::string& message) {
        plugin_set_error(code, message.c_str());
        return 400;
    };
    const auto* d = frame.descriptor;
    if (d->FORMAT() != ncdContainerFormat::PROVIDER_DEFINED || !d->PROVIDER_DEFINED_FORMAT_NAME() ||
        d->PROVIDER_DEFINED_FORMAT_NAME()->str() != "ses-i11" || !d->SOURCE_SHA256() || d->SOURCE_SHA256()->size() != 64 ||
        d->SOURCE_BYTE_LENGTH() != frame.body_length)
        return bad("invalid-ses-i11", "Require a hash-verified NCD with provider format \"ses-i11\" and the exact raw bytes.");

    sdn::i11::Elements e;
    const std::string why = sdn::i11::read(reinterpret_cast<const char*>(frame.body), frame.body_length, &e);
    if (!why.empty()) return bad("invalid-ses-i11", "Unreadable eleven-parameter file: " + why);

    // The epoch and the end of validity on the file's own (UTC) scale, in
    // seconds past J2000 (2000-01-01T12:00:00).
    using ephem::oem_kvn::days_from_civil;
    const double j2000 = static_cast<double>(days_from_civil(2000, 1, 1)) * 86400.0 + 43200.0;
    const double epoch = static_cast<double>(days_from_civil(e.year, e.month, e.day)) * 86400.0 + e.hour * 3600.0 + e.minute * 60.0 + e.second - j2000;
    double stop = epoch + kI11DefaultSpanHours * 3600.0;
    if (e.has_valid_until) {
        const double until = static_cast<double>(days_from_civil(e.vu_year, e.vu_month, e.vu_day)) * 86400.0 + e.vu_hour * 3600.0 + e.vu_minute * 60.0 - j2000;
        if (!(until > epoch)) return bad("invalid-ses-i11", "The validity end does not follow the element epoch.");
        stop = until;
    }

    char check[160] = "the file prints no prediction to check against";
    if (e.has_check) {
        const sdn::i11::Sample s = sdn::i11::evaluate(e, e.check_hours * 3600.0);
        const double dlon = sdn::i11::longitude_difference(s.lon_deg, e.check_lon), dlat = s.lat_deg - e.check_lat;
        if (std::fabs(dlon) > kI11CheckToleranceDeg || std::fabs(dlat) > kI11CheckToleranceDeg) {
            char message[256];
            std::snprintf(message, sizeof(message),
                          "The file's printed position at %.1f h (%.4f E, %.4f N) is not reproduced by its elements "
                          "(%.5f E, %.5f N); the elements and the check disagree, so the file is not read.",
                          e.check_hours, e.check_lon, e.check_lat, s.lon_deg, s.lat_deg);
            return bad("ses-i11-check-mismatch", message);
        }
        std::snprintf(check, sizeof(check), "the file's printed position at %.1f h is reproduced within %.6f deg longitude and %.6f deg latitude",
                      e.check_hours, std::fabs(dlon), std::fabs(dlat));
    }

    std::unique_ptr<ephemerisDataBlockT> block(new ephemerisDataBlockT());
    block->CENTER_NAME = "EARTH";
    block->TIME_SYSTEM = timingStandard::UTC;
    block->OBJECT.reset(new CATT());
    block->OBJECT->OBJECT_NAME = e.satellite;  // never a NORAD number the file does not state
    block->REFERENCE_FRAME.reset(new RFMT());
    block->REFERENCE_FRAME->NAME = "FIXED_EARTH";
    {
        CelestialFrameWrapperT wrapper;
        wrapper.frame = CelestialFrame::FIXED_EARTH;
        block->REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(wrapper));
    }
    char comment[640];
    std::snprintf(comment, sizeof(comment),
                  "IESS-412 eleven-parameter ephemeris (Orekit 13.1 IntelsatElevenElementsPropagator formulation): "
                  "LM0 %.6g LM1 %.6g LM2 %.6g LONC %.6g LONC1 %.6g LONS %.6g LONS1 %.6g LATC %.6g LATC1 %.6g LATS %.6g LATS1 %.6g; "
                  "Earth-fixed, km and km/s, UTC; radius from the longitude drift (synchronous radius 42164.57 km); %s.",
                  e.lm0, e.lm1, e.lm2, e.lonc, e.lonc1, e.lons, e.lons1, e.latc, e.latc1, e.lats, e.lats1, check);
    block->COMMENT = comment;
    block->STATE_VECTOR_SIZE = 6;
    block->STEP_SIZE = kI11StepSeconds;
    const int count = static_cast<int>(std::floor((stop - epoch) / kI11StepSeconds + 1e-9)) + 1;
    block->START_TIME = ephem::oem::iso_from_seconds(epoch);
    block->STOP_TIME = ephem::oem::iso_from_seconds(epoch + (count - 1) * kI11StepSeconds);
    block->EPHEMERIS_DATA.reserve(static_cast<size_t>(count) * 6);
    for (int k = 0; k < count; ++k) {
        const sdn::i11::Sample s = sdn::i11::evaluate(e, k * kI11StepSeconds);
        for (int c = 0; c < 3; ++c) block->EPHEMERIS_DATA.push_back(s.position[c] / 1000.0);
        for (int c = 0; c < 3; ++c) block->EPHEMERIS_DATA.push_back(s.velocity[c] / 1000.0);
    }

    OEMT oem;
    oem.CCSDS_OEM_VERS = 3.0;
    oem.ORIGINATOR = "SDN files/orbit-products normalize_ses_i11";
    oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(block));
    ::flatbuffers::FlatBufferBuilder fbb(65536);
    fbb.FinishSizePrefixed(CreateOEM(fbb, &oem), OEMIdentifier());
    if (plugin_push_output_ex("ephemeris", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OEM", 0, 8,
                              fbb.GetBufferPointer(), static_cast<uint32_t>(fbb.GetSize())) < 0)
        return 500;
    // The exact descriptor goes out with the states: its CID and hash lead back to the file.
    return plugin_push_output_ex("descriptor", "NCD.fbs", "$NCD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "NCD", 0, 8,
                                 frame.descriptor_bytes.data(), static_cast<uint32_t>(frame.descriptor_bytes.size())) < 0
               ? 500
               : 0;
}
