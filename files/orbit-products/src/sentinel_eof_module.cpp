// Compiled after the shared reader surface; reuses its checked NCD framing,
// the OEM epoch calendar arithmetic and the vocabulary mapping.
//
// normalize_sentinel_eof: an ESA Earth Explorer orbit file (Sentinel-1/2/3
// AUX_POEORB, AUX_RESORB, AUX_PREORB; provider format "sentinel-eof") as one
// Earth-fixed $OEM block, kilometers and kilometers per second, with an $NCD
// descriptor that records the source: the internal file name, the producing
// system, the creation date, the frame and time reference the file named, the
// coverage read and the SHA-256 of the bytes.
//
// THE REQUEST IS A FLATBUFFER, NEVER AN OPTIONS FILE. The $NCD that frames the
// file is also the request: when START_TIME and STOP_TIME are set they select
// the inclusive window of states read, stated on the file's own Time_Reference
// (no time-scale conversion is done, so a window on another scale is not
// expressible and is not guessed). The descriptor this method returns states
// the coverage that was actually read.
namespace {

constexpr const char* kSentinelEofFormat = "sentinel-eof";

// The seconds a stamp "YYYY-MM-DDThh:mm:ss[.ffffff]" is past J2000 on its own
// scale; calendar arithmetic only, no leap-second table.
bool eof_seconds(const std::string& text, double* out) {
    return ephem::oem_kvn::iso_to_seconds(text, out);
}

std::string eof_strip_reference(const std::string& stamp) {
    const size_t eq = stamp.find('=');
    return eq == std::string::npos ? stamp : stamp.substr(eq + 1);
}

}  // namespace

extern "C" int normalize_sentinel_eof(void) {
    ContainerFrame frame;
    const int rc = decode_container_frame("normalize_sentinel_eof", &frame);
    if (rc) return rc;
    auto refuse = [](const std::string& code, const std::string& message) {
        plugin_set_error(code.c_str(), message.c_str());
        return 400;
    };

    const NCD* request = frame.descriptor;
    if (request->FORMAT() != ncdContainerFormat::PROVIDER_DEFINED ||
        !request->PROVIDER_DEFINED_FORMAT_NAME() ||
        request->PROVIDER_DEFINED_FORMAT_NAME()->str() != kSentinelEofFormat) {
        return refuse("format-mismatch",
                      "normalize_sentinel_eof reads FORMAT PROVIDER_DEFINED with "
                      "PROVIDER_DEFINED_FORMAT_NAME \"sentinel-eof\".");
    }

    // The request's selection window, if it states one.
    bool has_window_start = false, has_window_stop = false;
    double window_start = 0.0, window_stop = 0.0;
    if (request->START_TIME() && request->START_TIME()->size() > 0) {
        if (!eof_seconds(request->START_TIME()->str(), &window_start)) {
            return refuse("bad-selection", "The request START_TIME \"" + request->START_TIME()->str() +
                                               "\" is not an ISO 8601 time.");
        }
        has_window_start = true;
    }
    if (request->STOP_TIME() && request->STOP_TIME()->size() > 0) {
        if (!eof_seconds(request->STOP_TIME()->str(), &window_stop)) {
            return refuse("bad-selection", "The request STOP_TIME \"" + request->STOP_TIME()->str() +
                                               "\" is not an ISO 8601 time.");
        }
        has_window_stop = true;
    }
    if (has_window_start && has_window_stop && window_stop < window_start) {
        return refuse("bad-selection", "The request STOP_TIME precedes its START_TIME.");
    }

    eof::File file;
    eof::Refusal refusal;
    if (!eof::parse(reinterpret_cast<const char*>(frame.body), frame.body_length, &file, &refusal)) {
        return refuse(refusal.code, refusal.message);
    }

    // Epochs strictly increase: the series is an ephemeris, and a file whose
    // OSVs run backwards or repeat is not one.
    std::vector<double> seconds;
    seconds.reserve(file.osvs.size());
    for (size_t i = 0; i < file.osvs.size(); ++i) {
        double t = 0.0;
        if (!eof_seconds(file.osvs[i].epoch, &t)) {
            return refuse("bad-value", "OSV " + std::to_string(i + 1) + ": the epoch \"" +
                                           file.osvs[i].epoch + "\" is not an ISO 8601 time.");
        }
        if (i > 0 && !(t > seconds.back())) {
            return refuse("inconsistent-message", "OSV " + std::to_string(i + 1) +
                                                      ": the epoch does not follow the one before it.");
        }
        seconds.push_back(t);
    }

    timingStandard time_system = timingStandard::UTC;
    if (!time_system_for(file.time_reference, &time_system)) {
        return refuse("unmappable-time-system", "Time_Reference \"" + file.time_reference +
                                                    "\" has no timingStandard member.");
    }

    std::vector<size_t> chosen;
    for (size_t i = 0; i < file.osvs.size(); ++i) {
        if (has_window_start && seconds[i] < window_start) continue;
        if (has_window_stop && seconds[i] > window_stop) continue;
        chosen.push_back(i);
    }
    if (chosen.empty()) {
        return refuse("empty-selection", "No OSV falls inside the requested window.");
    }

    // What $OEM has no column for, counted and declared in the block COMMENT.
    std::map<std::string, size_t> quality;
    bool have_orbit = false;
    long long first_orbit = 0, last_orbit = 0;
    for (size_t i : chosen) {
        const eof::Osv& o = file.osvs[i];
        ++quality[o.quality.empty() ? std::string("(unstated)") : o.quality];
        if (o.has_orbit) {
            if (!have_orbit || o.absolute_orbit < first_orbit) first_orbit = o.absolute_orbit;
            if (!have_orbit || o.absolute_orbit > last_orbit) last_orbit = o.absolute_orbit;
            have_orbit = true;
        }
    }
    std::string quality_text;
    for (const auto& kv : quality) {
        if (!quality_text.empty()) quality_text += ", ";
        quality_text += kv.first + "=" + std::to_string(kv.second);
    }

    std::unique_ptr<ephemerisDataBlockT> block(new ephemerisDataBlockT());
    block->CENTER_NAME = "EARTH";  // the frame is geocentric by its definition
    block->TIME_SYSTEM = time_system;
    block->OBJECT.reset(new CATT());
    block->OBJECT->OBJECT_NAME = file.mission;  // never a catalog number the file does not state
    block->REFERENCE_FRAME.reset(new RFMT());
    block->REFERENCE_FRAME->NAME = file.ref_frame;
    if (file.ref_frame == "EARTH_FIXED") {
        // The file names the frame and no realization; FIXED_EARTH is the
        // roster's Earth-fixed member, the one the SES reader states too.
        CelestialFrameWrapperT wrapper;
        wrapper.frame = CelestialFrame::FIXED_EARTH;
        block->REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(wrapper));
    }
    {
        std::string comment = "ESA Earth Explorer File " + file.file_type + " of " + file.mission;
        if (!file.file_description.empty()) comment += " (" + file.file_description + ")";
        comment += ", produced by " + file.system;
        if (!file.creator_version.empty()) comment += " " + file.creator_version;
        comment += "; validity " + file.validity_start + " to " + file.validity_stop + "; frame " +
                   file.ref_frame + " (no realization named); epochs on " + file.time_reference +
                   "; meters and meters per second read as kilometers and kilometers per second. "
                   "Carried by the file and not by $OEM: the per-OSV TAI and UT1 stamps, the absolute "
                   "orbit number";
        if (have_orbit) {
            comment += " (" + std::to_string(first_orbit) + " to " + std::to_string(last_orbit) + ")";
        }
        comment += " and the Quality flag (" + quality_text + ").";
        block->COMMENT = comment;
    }
    block->STEP_SIZE = 0.0;  // explicit epochs: the stamps are the file's text, not a grid
    block->START_TIME = file.osvs[chosen.front()].epoch;
    block->STOP_TIME = file.osvs[chosen.back()].epoch;
    block->EPHEMERIS_DATA_LINES.reserve(chosen.size());
    for (size_t i : chosen) {
        const eof::Osv& o = file.osvs[i];
        std::unique_ptr<ephemerisDataLineT> line(new ephemerisDataLineT());
        line->EPOCH = o.epoch;
        line->X = o.pos_km[0]; line->Y = o.pos_km[1]; line->Z = o.pos_km[2];
        line->X_DOT = o.vel_kms[0]; line->Y_DOT = o.vel_kms[1]; line->Z_DOT = o.vel_kms[2];
        block->EPHEMERIS_DATA_LINES.push_back(std::move(line));
    }

    OEMT oem;
    oem.CCSDS_OEM_VERS = 3.0;
    oem.CREATION_DATE = eof_strip_reference(file.creation_date);
    oem.ORIGINATOR = file.creator.empty() ? file.system : file.creator;
    oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(block));

    ::flatbuffers::FlatBufferBuilder oem_fbb(65536);
    oem_fbb.FinishSizePrefixed(CreateOEM(oem_fbb, &oem), OEMIdentifier());
    if (plugin_push_output_ex("ephemeris", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                              "OEM", 0, 8, oem_fbb.GetBufferPointer(),
                              static_cast<uint32_t>(oem_fbb.GetSize())) < 0) {
        return 500;
    }

    NCDT descriptor;
    descriptor.FORMAT = ncdContainerFormat::PROVIDER_DEFINED;
    descriptor.PROVIDER_DEFINED_FORMAT_NAME = kSentinelEofFormat;
    descriptor.FORMAT_VERSION = file.file_version;
    descriptor.PRODUCER = file.system;
    descriptor.CREATION_DATE = eof_strip_reference(file.creation_date);
    descriptor.ORIGINATOR = file.creator;
    descriptor.INTERNAL_FILE_NAME = file.file_name;
    if (!file.notes.empty()) descriptor.COMMENT_AREA.push_back(file.notes);
    descriptor.NATIVE_FRAME_NAME = file.ref_frame;
    descriptor.NATIVE_TIME_SYSTEM = file.time_reference;
    descriptor.START_TIME = file.osvs[chosen.front()].epoch;
    descriptor.STOP_TIME = file.osvs[chosen.back()].epoch;
    {
        std::unique_ptr<NCDSegmentDescriptorT> segment(new NCDSegmentDescriptorT());
        segment->NAME = file.file_type;
        segment->FRAME_NAME = file.ref_frame;
        segment->START_EPOCH = eof_strip_reference(file.validity_start);
        segment->STOP_EPOCH = eof_strip_reference(file.validity_stop);
        descriptor.SEGMENTS.push_back(std::move(segment));
    }
    descriptor.SOURCE_BYTE_LENGTH = static_cast<uint64_t>(frame.body_length);
    descriptor.SOURCE_SHA256 = ephem::sha256_hex(frame.body, frame.body_length);
    if (request->SOURCE_CID()) descriptor.SOURCE_CID = request->SOURCE_CID()->str();

    ::flatbuffers::FlatBufferBuilder ncd_fbb(4096);
    ncd_fbb.FinishSizePrefixed(CreateNCD(ncd_fbb, &descriptor), NCDIdentifier());
    return plugin_push_output_ex("descriptor", "NCD.fbs", "$NCD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                                 "NCD", 0, 8, ncd_fbb.GetBufferPointer(),
                                 static_cast<uint32_t>(ncd_fbb.GetSize())) < 0
               ? 500
               : 0;
}
