// Compiled after the shared reader surface; reuses its checked NCD framing and
// the SHA-256.
//
// normalize_naif_ck: a NAIF CK (C-kernel, DAF/CK) of type 3 as SDS $AEM, with an
// $NCD descriptor that records the file. The spacecraft clock comes from an
// SCLK kernel supplied on its own port, framed as an $NCD (provider format
// "naif-sclk") followed by the kernel's bytes.
//
// write_naif_ck: $AEM, an SCLK kernel and an optional $NCD to a CK, returned
// as the same frame the reader takes: [u32le n][$NCD][the CK's exact bytes].
//
// THE OPTIONS ARE FLATBUFFERS, NEVER AN OPTIONS FILE. Everything a caller can
// choose travels in an $NCD or in the $AEM itself:
//
//   selection window   container $NCD START_TIME / STOP_TIME, on the clock's
//                      time system (TDB or TT as the SCLK kernel declares).
//   object / segment   container $NCD SEGMENTS: an entry selects the CK
//                      segments whose NAME and/or TARGET_NAIF_ID (the
//                      instrument) match it; no entries selects every segment.
//   the clock          sclk $NCD SEGMENTS[0].TARGET_NAIF_ID is the spacecraft
//                      clock id (-76); without it the clock is NAIF's rule,
//                      the instrument id divided by 1000.
//   frames, object     (write) $AEM REF_FRAME_A is the reference frame (a
//                      NAIF built-in name or a decimal frame code), REF_FRAME_B
//                      the instrument (a decimal code), OBJECT_NAME the segment
//                      identifier.
//   file facts         (write) the optional $NCD INTERNAL_FILE_NAME and
//                      COMMENT_AREA.
//
// A kernel TYPE other than 3, a time system that is not the clock's, a
// B2A direction, an attitude type that is not a quaternion, a non-unit
// quaternion and an angular velocity expressed in the instrument frame are each
// REFUSED by name; nothing is converted on a guess.
namespace {

constexpr const char* kNaifCkFormat = "naif-ck";
constexpr const char* kNaifSclkFormat = "naif-sclk";

bool provider_format_is(const NCD* d, const char* name) {
    return d->FORMAT() == ncdContainerFormat::PROVIDER_DEFINED && d->PROVIDER_DEFINED_FORMAT_NAME() &&
           d->PROVIDER_DEFINED_FORMAT_NAME()->str() == name;
}

// One request entry of an $NCD: which segments it selects.
struct SegmentSelector {
    std::string name;
    int32_t instrument = 0;
};

const double kRadiansToDegrees = 180.0 / 3.14159265358979323846264338327950288;

int ck_refuse(const std::string& code, const std::string& message) {
    plugin_set_error(code.c_str(), message.c_str());
    return 400;
}

// The size-prefixed $NCD followed by the file: the frame the reader takes.
bool push_ck_frame(const NCDT& descriptor, const std::vector<uint8_t>& body, std::vector<uint8_t>* frame) {
    ::flatbuffers::FlatBufferBuilder fbb(4096);
    fbb.FinishSizePrefixed(CreateNCD(fbb, &descriptor), NCDIdentifier());
    frame->assign(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    frame->insert(frame->end(), body.begin(), body.end());
    return true;
}

}  // namespace

extern "C" int normalize_naif_ck(void) {
    ContainerFrame ck_frame, sclk_frame;
    int rc = decode_container_frame("normalize_naif_ck", &ck_frame);
    if (rc) return rc;
    rc = decode_container_frame("normalize_naif_ck", &sclk_frame, "sclk");
    if (rc) return rc;

    const NCD* request = ck_frame.descriptor;
    if (!provider_format_is(request, kNaifCkFormat)) {
        return ck_refuse("format-mismatch",
                         "normalize_naif_ck reads a container whose FORMAT is PROVIDER_DEFINED with "
                         "PROVIDER_DEFINED_FORMAT_NAME \"naif-ck\".");
    }
    if (!provider_format_is(sclk_frame.descriptor, kNaifSclkFormat)) {
        return ck_refuse("format-mismatch",
                         "The sclk port carries a FORMAT PROVIDER_DEFINED frame with "
                         "PROVIDER_DEFINED_FORMAT_NAME \"naif-sclk\".");
    }

    // The request: window and segment selectors, all from the $NCD.
    bool has_start = false, has_stop = false;
    double window_start = 0.0, window_stop = 0.0;
    if (request->START_TIME() && request->START_TIME()->size() > 0) {
        if (!ck::seconds_from_iso(request->START_TIME()->str(), &window_start)) {
            return ck_refuse("bad-selection", "The request START_TIME \"" + request->START_TIME()->str() +
                                                  "\" is not an ISO 8601 time.");
        }
        has_start = true;
    }
    if (request->STOP_TIME() && request->STOP_TIME()->size() > 0) {
        if (!ck::seconds_from_iso(request->STOP_TIME()->str(), &window_stop)) {
            return ck_refuse("bad-selection", "The request STOP_TIME \"" + request->STOP_TIME()->str() +
                                                  "\" is not an ISO 8601 time.");
        }
        has_stop = true;
    }
    if (has_start && has_stop && window_stop < window_start) {
        return ck_refuse("bad-selection", "The request STOP_TIME precedes its START_TIME.");
    }
    std::vector<SegmentSelector> selectors;
    if (request->SEGMENTS()) {
        for (size_t i = 0; i < request->SEGMENTS()->size(); ++i) {
            const NCDSegmentDescriptor* d = request->SEGMENTS()->Get(static_cast<::flatbuffers::uoffset_t>(i));
            SegmentSelector sel;
            if (d->NAME()) sel.name = d->NAME()->str();
            sel.instrument = d->TARGET_NAIF_ID();
            if (sel.name.empty() && sel.instrument == 0) {
                return ck_refuse("bad-selection", "A request SEGMENTS entry names neither a segment (NAME) nor an "
                                                  "instrument (TARGET_NAIF_ID).");
            }
            selectors.push_back(sel);
        }
    }
    int32_t clock_override = 0;
    if (sclk_frame.descriptor->SEGMENTS() && sclk_frame.descriptor->SEGMENTS()->size() > 0) {
        clock_override = sclk_frame.descriptor->SEGMENTS()->Get(0)->TARGET_NAIF_ID();
    }

    daf::File file;
    const ephem::Status st = daf::read(ck_frame.body, ck_frame.body_length, &file, true, 4096);
    if (st != ephem::Status::Ok) return fail_with_status(st, "The CK could not be read as a DAF");
    if (file.id_word != "DAF/CK") {
        return ck_refuse("not-a-ck", "The DAF identification word is \"" + file.id_word +
                                         "\", not \"DAF/CK\"; this is not a C-kernel.");
    }
    if (file.nd != 2 || file.ni != 6) {
        return ck_refuse("unsupported-ck-variant", "A CK summary is ND=2 and NI=6; this file declares a different shape.");
    }
    if (file.summaries.empty()) return ck_refuse("empty-kernel", "The CK holds no segment.");

    ssb::KernelPool pool;
    {
        std::string why;
        if (!ssb::parse_text_kernel(sclk_frame.body, sclk_frame.body_length, &pool, &why)) {
            return ck_refuse("bad-sclk-kernel", "The SCLK kernel is not a readable text kernel: " + why + ".");
        }
    }

    auto selected = [&](const daf::Summary& s) {
        if (selectors.empty()) return true;
        for (const SegmentSelector& sel : selectors) {
            if ((sel.name.empty() || sel.name == s.name) && (sel.instrument == 0 || sel.instrument == s.ic[0])) return true;
        }
        return false;
    };

    std::vector<sclk::Clock> clocks;
    auto clock_for = [&](int32_t instrument, const sclk::Clock** out, std::string* code, std::string* message) {
        const int32_t spacecraft = clock_override != 0 ? clock_override : sclk::spacecraft_of_instrument(instrument);
        const int32_t suffix = spacecraft < 0 ? -spacecraft : spacecraft;
        for (const sclk::Clock& c : clocks) {
            if (c.suffix == suffix) {
                *out = &c;
                return true;
            }
        }
        sclk::Clock loaded;
        if (!sclk::load(pool, spacecraft, &loaded, code, message)) return false;
        clocks.push_back(loaded);
        *out = &clocks.back();
        return true;
    };

    AEMT aem;
    aem.CCSDS_AEM_VERS = "2.0";
    {
        std::string line = "Read from a NAIF CK (" + file.id_word + ") by files/orbit-products normalize_naif_ck";
        if (const auto it = pool.strings.find("SCLK_KERNEL_ID"); it != pool.strings.end() && !it->second.empty()) {
            line += "; spacecraft clock kernel " + it->second[0];
        }
        aem.COMMENT.push_back(line);
        aem.COMMENT.push_back("The quaternion is CCSDS (Q1 Q2 Q3 QC) from frame A to frame B: the NAIF quaternion "
                              "(q0 q1 q2 q3) of the C-matrix with the vector part negated. REF_FRAME_A is the segment's "
                              "reference frame and REF_FRAME_B the instrument, each a NAIF built-in frame name or a "
                              "decimal frame code a frame kernel defines. Angular velocity is in deg/s, expressed in "
                              "REF_FRAME_A.");
    }

    NCDT descriptor;
    std::string window_first, window_last;
    std::string time_system_label;
    bool have_coverage = false;
    double coverage_first = 0.0, coverage_last = 0.0;
    std::vector<std::unique_ptr<NCDSegmentDescriptorT> > descriptors;

    for (const daf::Summary& s : file.summaries) {
        std::unique_ptr<NCDSegmentDescriptorT> d(new NCDSegmentDescriptorT());
        d->NAME = s.name;
        d->TARGET_NAIF_ID = s.ic[0];
        d->FRAME_NAIF_ID = s.ic[1];
        d->FRAME_NAME = spk::builtin_frame_name(s.ic[1]);
        d->SEGMENT_TYPE = s.ic[2];
        d->INITIAL_ADDRESS = static_cast<uint64_t>(s.ic[4]);
        d->FINAL_ADDRESS = static_cast<uint64_t>(s.ic[5]);

        const bool take = selected(s);
        const sclk::Clock* clock = nullptr;
        std::string code, message;
        const bool have_clock = clock_for(s.ic[0], &clock, &code, &message);
        if (have_clock && s.ic[2] == 3) {
            d->START_EPOCH = ck::iso_from_seconds_ns(clock->ticks_to_time(s.dc[0]));
            d->STOP_EPOCH = ck::iso_from_seconds_ns(clock->ticks_to_time(s.dc[1]));
            if (clock->time_system == 1) {
                d->START_SECONDS_PAST_J2000_TDB = clock->ticks_to_time(s.dc[0]);
                d->STOP_SECONDS_PAST_J2000_TDB = clock->ticks_to_time(s.dc[1]);
            }
        }
        descriptors.push_back(std::move(d));
        if (!take) continue;

        if (s.ic[2] != 3) {
            char text[240];
            std::snprintf(text, sizeof(text),
                          "Segment \"%s\" is CK type %d; only type 3 is read. Select the type 3 segments with the "
                          "request's SEGMENTS entries.", s.name.c_str(), s.ic[2]);
            return ck_refuse("unsupported-ck-type", text);
        }
        if (!have_clock) return ck_refuse(code, "Segment \"" + s.name + "\": " + message);

        ck::Segment segment;
        ck::Refusal refusal;
        if (!ck::read_type3(file, s, &segment, &refusal)) return ck_refuse(refusal.code, refusal.message);

        const double to_degrees = kRadiansToDegrees;
        for (size_t k = 0; k < segment.intervals.size(); ++k) {
            const ck::Interval& iv = segment.intervals[k];
            std::unique_ptr<AEMSegmentT> out(new AEMSegmentT());
            std::string first_epoch, last_epoch;
            for (size_t i = 0; i < iv.ticks.size(); ++i) {
                const double t = clock->ticks_to_time(iv.ticks[i]);
                if (has_start && t < window_start) continue;
                if (has_stop && t > window_stop) continue;
                std::unique_ptr<attitudeDataLineT> line(new attitudeDataLineT());
                line->EPOCH = ck::iso_from_seconds_ns(t);
                // NAIF (q0 q1 q2 q3) to CCSDS (Q1 Q2 Q3 QC): the vector part changes sign.
                line->Q1 = -iv.q[i * 4 + 1];
                line->Q2 = -iv.q[i * 4 + 2];
                line->Q3 = -iv.q[i * 4 + 3];
                line->QC = iv.q[i * 4 + 0];
                if (segment.has_av) {
                    line->ANGVEL_X = iv.av[i * 3 + 0] * to_degrees;
                    line->ANGVEL_Y = iv.av[i * 3 + 1] * to_degrees;
                    line->ANGVEL_Z = iv.av[i * 3 + 2] * to_degrees;
                }
                if (first_epoch.empty()) first_epoch = line->EPOCH;
                last_epoch = line->EPOCH;
                if (!have_coverage || t < coverage_first) coverage_first = t;
                if (!have_coverage || t > coverage_last) coverage_last = t;
                have_coverage = true;
                out->ATTITUDE_DATA_LINES.push_back(std::move(line));
            }
            if (out->ATTITUDE_DATA_LINES.empty()) continue;
            out->OBJECT_NAME = segment.name;
            out->OBJECT_ID = std::to_string(segment.instrument);
            out->REF_FRAME_A = ck::frame_text(segment.ref_frame);
            out->REF_FRAME_B = std::to_string(segment.instrument);
            out->ATTITUDE_DIR = "A2B";
            out->TIME_SYSTEM = clock->time_system_name();
            out->ATTITUDE_TYPE = segment.has_av ? "QUATERNION/ANGVEL" : "QUATERNION";
            out->START_TIME = first_epoch;
            out->STOP_TIME = last_epoch;
            out->STEP_SIZE = 0.0;  // explicit epochs: the record ticks are not a grid
            out->INTERPOLATION_METHOD = "LINEAR";
            if (segment.has_av) out->ANGVEL_FRAME = "REF_FRAME_A";
            char note[200];
            std::snprintf(note, sizeof(note), "CK segment \"%s\" interval %zu of %zu (type 3).",
                          segment.name.c_str(), k + 1, segment.intervals.size());
            out->COMMENT.push_back(note);
            aem.SEGMENTS.push_back(std::move(out));
            time_system_label = clock->time_system_name();
        }
    }
    if (aem.SEGMENTS.empty()) {
        return ck_refuse("empty-selection", "No CK record is selected by the request.");
    }

    ::flatbuffers::FlatBufferBuilder aem_fbb(65536);
    aem_fbb.FinishSizePrefixed(CreateAEM(aem_fbb, &aem), AEMIdentifier());
    if (plugin_push_output_ex("attitude", "AEM.fbs", "$AEM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "AEM", 0,
                              8, aem_fbb.GetBufferPointer(), static_cast<uint32_t>(aem_fbb.GetSize())) < 0) {
        return 500;
    }

    descriptor.FORMAT = ncdContainerFormat::PROVIDER_DEFINED;
    descriptor.PROVIDER_DEFINED_FORMAT_NAME = kNaifCkFormat;
    descriptor.FORMAT_VERSION = file.id_word;
    descriptor.INTERNAL_FILE_NAME = file.internal_name;
    split_lines(file.comments, &descriptor.COMMENT_AREA);
    descriptor.NATIVE_TIME_SYSTEM = time_system_label;
    if (!file.summaries.empty()) {
        descriptor.NATIVE_FRAME_ID = file.summaries.front().ic[1];
        descriptor.NATIVE_FRAME_NAME = ck::frame_text(file.summaries.front().ic[1]);
    }
    if (have_coverage) {
        descriptor.START_TIME = ck::iso_from_seconds_ns(coverage_first);
        descriptor.STOP_TIME = ck::iso_from_seconds_ns(coverage_last);
    }
    for (auto& d : descriptors) descriptor.SEGMENTS.push_back(std::move(d));
    descriptor.SOURCE_BYTE_LENGTH = static_cast<uint64_t>(ck_frame.body_length);
    descriptor.SOURCE_SHA256 = ephem::sha256_hex(ck_frame.body, ck_frame.body_length);
    if (request->SOURCE_CID()) descriptor.SOURCE_CID = request->SOURCE_CID()->str();

    ::flatbuffers::FlatBufferBuilder ncd_fbb(4096);
    ncd_fbb.FinishSizePrefixed(CreateNCD(ncd_fbb, &descriptor), NCDIdentifier());
    return plugin_push_output_ex("descriptor", "NCD.fbs", "$NCD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "NCD", 0,
                                 8, ncd_fbb.GetBufferPointer(), static_cast<uint32_t>(ncd_fbb.GetSize())) < 0
               ? 500
               : 0;
}

extern "C" int write_naif_ck(void) {
    // The $AEM record.
    const int32_t index = plugin_find_input_index("attitude", 0);
    const plugin_input_frame_t* frame =
        index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        return ck_refuse("missing-record-frame", "write_naif_ck requires a frame on port \"attitude\".");
    }
    std::vector<uint8_t> aem_bytes(frame->payload, frame->payload + frame->payload_length);
    ::flatbuffers::Verifier verifier(aem_bytes.data(), aem_bytes.size());
    const bool prefixed = ::flatbuffers::BufferHasIdentifier(aem_bytes.data(), AEMIdentifier(), true);
    if (!(prefixed ? VerifySizePrefixedAEMBuffer(verifier) : VerifyAEMBuffer(verifier))) {
        return ck_refuse("bad-aem", "The frame is not a verifiable $AEM buffer.");
    }
    AEMT aem;
    (prefixed ? GetSizePrefixedAEM(aem_bytes.data()) : GetAEM(aem_bytes.data()))->UnPackTo(&aem);

    // The SCLK kernel.
    ContainerFrame sclk_frame;
    int rc = decode_container_frame("write_naif_ck", &sclk_frame, "sclk");
    if (rc) return rc;
    if (!provider_format_is(sclk_frame.descriptor, kNaifSclkFormat)) {
        return ck_refuse("format-mismatch",
                         "The sclk port carries a FORMAT PROVIDER_DEFINED frame with "
                         "PROVIDER_DEFINED_FORMAT_NAME \"naif-sclk\".");
    }
    int32_t clock_override = 0;
    if (sclk_frame.descriptor->SEGMENTS() && sclk_frame.descriptor->SEGMENTS()->size() > 0) {
        clock_override = sclk_frame.descriptor->SEGMENTS()->Get(0)->TARGET_NAIF_ID();
    }
    ssb::KernelPool pool;
    {
        std::string why;
        if (!ssb::parse_text_kernel(sclk_frame.body, sclk_frame.body_length, &pool, &why)) {
            return ck_refuse("bad-sclk-kernel", "The SCLK kernel is not a readable text kernel: " + why + ".");
        }
    }

    // The optional file facts.
    std::string internal_name = "files/orbit-products write_naif_ck";
    std::vector<std::string> comment_lines;
    {
        const int32_t di = plugin_find_input_index("descriptor", 0);
        const plugin_input_frame_t* df = di >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(di)) : nullptr;
        if (df && df->payload && df->payload_length > 0) {
            std::vector<uint8_t> bytes(df->payload, df->payload + df->payload_length);
            ::flatbuffers::Verifier v(bytes.data(), bytes.size());
            if (!::flatbuffers::BufferHasIdentifier(bytes.data(), NCDIdentifier(), true) ||
                !VerifySizePrefixedNCDBuffer(v)) {
                return ck_refuse("bad-ncd", "The descriptor is not a verifiable size-prefixed $NCD.");
            }
            const NCD* d = GetSizePrefixedNCD(bytes.data());
            if (d->FORMAT() != ncdContainerFormat::UNSPECIFIED && !provider_format_is(d, kNaifCkFormat)) {
                return ck_refuse("format-mismatch",
                                 "write_naif_ck writes \"naif-ck\"; the descriptor asks for another format.");
            }
            if (d->INTERNAL_FILE_NAME() && d->INTERNAL_FILE_NAME()->size() > 0) internal_name = d->INTERNAL_FILE_NAME()->str();
            if (d->COMMENT_AREA()) {
                for (size_t i = 0; i < d->COMMENT_AREA()->size(); ++i) {
                    comment_lines.push_back(d->COMMENT_AREA()->Get(static_cast<::flatbuffers::uoffset_t>(i))->str());
                }
            }
        }
    }

    if (aem.SEGMENTS.empty()) return ck_refuse("bad-record", "The $AEM holds no segment.");
    std::vector<ck::WriteSegment> segments;
    std::vector<std::unique_ptr<NCDSegmentDescriptorT> > descriptors;
    std::vector<sclk::Clock> clocks;
    const double to_radians = 3.14159265358979323846264338327950288 / 180.0;
    for (size_t si = 0; si < aem.SEGMENTS.size(); ++si) {
        const AEMSegmentT& s = *aem.SEGMENTS[si];
        const std::string who = "Segment " + std::to_string(si + 1) + ": ";
        if (s.STEP_SIZE > 0.0 || !s.ATTITUDE_DATA.empty()) {
            return ck_refuse("compact-form-needs-time-math",
                             who + "the segment states its attitude in the compact form; its epochs would have to be "
                                   "computed from a step, and no epoch is invented.");
        }
        if (s.ATTITUDE_DATA_LINES.empty()) return ck_refuse("bad-record", who + "the segment has no attitude data lines.");
        if (s.ATTITUDE_DIR != "A2B") {
            return ck_refuse("unsupported-attitude-direction", who + "ATTITUDE_DIR \"" + s.ATTITUDE_DIR +
                                                                   "\" is not \"A2B\"; a CK states the reference-to-instrument rotation.");
        }
        bool with_av = false;
        if (s.ATTITUDE_TYPE == "QUATERNION/ANGVEL") with_av = true;
        else if (s.ATTITUDE_TYPE != "QUATERNION") {
            return ck_refuse("unsupported-attitude-type", who + "ATTITUDE_TYPE \"" + s.ATTITUDE_TYPE +
                                                              "\" is not QUATERNION or QUATERNION/ANGVEL.");
        }
        if (with_av && s.ANGVEL_FRAME != "REF_FRAME_A") {
            return ck_refuse("unsupported-angvel-frame", who + "ANGVEL_FRAME \"" + s.ANGVEL_FRAME +
                                                             "\" is not REF_FRAME_A; a CK states its angular velocity in the reference frame.");
        }
        ck::WriteSegment w;
        w.name = s.OBJECT_NAME;
        w.has_av = with_av;
        if (!ck::frame_code_for(s.REF_FRAME_A, &w.ref_frame)) {
            return ck_refuse("unknown-reference-frame", who + "REF_FRAME_A \"" + s.REF_FRAME_A +
                                                            "\" is neither a NAIF built-in inertial frame nor a decimal frame code.");
        }
        {
            char* end = nullptr;
            const long v = std::strtol(s.REF_FRAME_B.c_str(), &end, 10);
            if (s.REF_FRAME_B.empty() || *end != '\0' || v == 0 || v < -2147483647L || v > 2147483647L) {
                return ck_refuse("bad-instrument-code", who + "REF_FRAME_B \"" + s.REF_FRAME_B +
                                                            "\" is not a nonzero decimal NAIF instrument code.");
            }
            w.instrument = static_cast<int32_t>(v);
        }
        // The clock: by the instrument, as NAIF does, unless the sclk frame names it.
        const int32_t spacecraft = clock_override != 0 ? clock_override : sclk::spacecraft_of_instrument(w.instrument);
        const int32_t suffix = spacecraft < 0 ? -spacecraft : spacecraft;
        const sclk::Clock* clock = nullptr;
        for (const sclk::Clock& c : clocks) {
            if (c.suffix == suffix) clock = &c;
        }
        if (!clock) {
            sclk::Clock loaded;
            std::string code, message;
            if (!sclk::load(pool, spacecraft, &loaded, &code, &message)) return ck_refuse(code, who + message);
            clocks.push_back(loaded);
            clock = &clocks.back();
        }
        if (s.TIME_SYSTEM != clock->time_system_name()) {
            return ck_refuse("time-system-mismatch",
                             who + "TIME_SYSTEM \"" + s.TIME_SYSTEM + "\" is not the clock's \"" +
                                 clock->time_system_name() + "\"; no time-scale conversion is done here.");
        }
        double previous = 0.0;
        for (size_t li = 0; li < s.ATTITUDE_DATA_LINES.size(); ++li) {
            const attitudeDataLineT& line = *s.ATTITUDE_DATA_LINES[li];
            double t = 0.0;
            if (!ck::seconds_from_iso(line.EPOCH, &t)) {
                return ck_refuse("bad-value", who + "line " + std::to_string(li + 1) + ": the epoch \"" + line.EPOCH +
                                                  "\" is not an ISO 8601 time.");
            }
            if (li > 0 && !(t > previous)) {
                return ck_refuse("inconsistent-message", who + "line " + std::to_string(li + 1) +
                                                             ": the epoch does not follow the one before it.");
            }
            previous = t;
            const double norm2 = line.Q1 * line.Q1 + line.Q2 * line.Q2 + line.Q3 * line.Q3 + line.QC * line.QC;
            if (!(std::fabs(norm2 - 1.0) < 2e-6)) {
                return ck_refuse("non-unit-quaternion", who + "line " + std::to_string(li + 1) +
                                                            ": the quaternion is not of unit norm; it is not normalized on a guess.");
            }
            w.ticks.push_back(clock->time_to_ticks(t));
            // CCSDS (Q1 Q2 Q3 QC) to NAIF (q0 q1 q2 q3): the vector part changes sign.
            w.q.push_back(line.QC);
            w.q.push_back(-line.Q1);
            w.q.push_back(-line.Q2);
            w.q.push_back(-line.Q3);
            if (with_av) {
                w.av.push_back(line.ANGVEL_X * to_radians);
                w.av.push_back(line.ANGVEL_Y * to_radians);
                w.av.push_back(line.ANGVEL_Z * to_radians);
            }
        }
        for (size_t i = 1; i < w.ticks.size(); ++i) {
            if (!(w.ticks[i] > w.ticks[i - 1])) {
                return ck_refuse("inconsistent-message", who + "two epochs fall on one clock tick.");
            }
        }
        std::unique_ptr<NCDSegmentDescriptorT> d(new NCDSegmentDescriptorT());
        d->NAME = w.name;
        d->TARGET_NAIF_ID = w.instrument;
        d->FRAME_NAIF_ID = w.ref_frame;
        d->FRAME_NAME = spk::builtin_frame_name(w.ref_frame);
        d->SEGMENT_TYPE = 3;
        d->START_EPOCH = s.ATTITUDE_DATA_LINES.front()->EPOCH;
        d->STOP_EPOCH = s.ATTITUDE_DATA_LINES.back()->EPOCH;
        if (clock->time_system == 1) {
            double a = 0.0, b = 0.0;
            ck::seconds_from_iso(d->START_EPOCH, &a);
            ck::seconds_from_iso(d->STOP_EPOCH, &b);
            d->START_SECONDS_PAST_J2000_TDB = a;
            d->STOP_SECONDS_PAST_J2000_TDB = b;
        }
        descriptors.push_back(std::move(d));
        segments.push_back(std::move(w));
    }

    std::string comments;
    for (const std::string& line : comment_lines) {
        if (!comments.empty()) comments += '\n';
        comments += line;
    }
    std::vector<uint8_t> body;
    std::vector<std::pair<int32_t, int32_t> > addresses;
    ck::Refusal refusal;
    if (!ck::write(segments, internal_name, comments, &body, &addresses, &refusal)) {
        return ck_refuse(refusal.code, refusal.message);
    }

    NCDT out;
    out.FORMAT = ncdContainerFormat::PROVIDER_DEFINED;
    out.PROVIDER_DEFINED_FORMAT_NAME = kNaifCkFormat;
    out.FORMAT_VERSION = "DAF/CK";
    out.INTERNAL_FILE_NAME = internal_name;
    out.COMMENT_AREA = comment_lines;
    out.NATIVE_TIME_SYSTEM = aem.SEGMENTS.front()->TIME_SYSTEM;
    out.NATIVE_FRAME_ID = segments.front().ref_frame;
    out.NATIVE_FRAME_NAME = ck::frame_text(segments.front().ref_frame);
    out.START_TIME = aem.SEGMENTS.front()->ATTITUDE_DATA_LINES.front()->EPOCH;
    out.STOP_TIME = aem.SEGMENTS.back()->ATTITUDE_DATA_LINES.back()->EPOCH;
    for (size_t i = 0; i < descriptors.size(); ++i) {
        descriptors[i]->INITIAL_ADDRESS = static_cast<uint64_t>(addresses[i].first);
        descriptors[i]->FINAL_ADDRESS = static_cast<uint64_t>(addresses[i].second);
        out.SEGMENTS.push_back(std::move(descriptors[i]));
    }
    out.SOURCE_BYTE_LENGTH = static_cast<uint64_t>(body.size());
    out.SOURCE_SHA256 = ephem::sha256_hex(body.data(), body.size());

    std::vector<uint8_t> out_frame;
    push_ck_frame(out, body, &out_frame);
    return plugin_push_output_ex("container", "NCD.fbs", "$NCD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "NCD", 0, 8,
                                 out_frame.data(), static_cast<uint32_t>(out_frame.size())) < 0
               ? 500
               : 0;
}
