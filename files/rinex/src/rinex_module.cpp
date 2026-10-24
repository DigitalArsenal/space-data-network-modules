/*
 * files/rinex — the RINEX reader surface.
 *
 * read_observations: a RINEX 3.02..3.05 observation file as one SDS $GNO per
 * epoch, with an $NCD that records the file.
 *
 * THE REQUEST IS A FLATBUFFER, NEVER AN OPTIONS FILE (owner, 2026-10-24: "We
 * need to be able to pass configurations using a flatbuffer message"). The
 * file travels as [u32le n][$NCD][the file's bytes] and that $NCD is also the
 * request:
 *
 *   selection window   START_TIME and STOP_TIME, inclusive, ISO 8601 on the
 *                      file's own time system (TIME OF FIRST OBS); no scale is
 *                      converted, so a window on another scale is not
 *                      expressible and is not guessed.
 *   constellations     SEGMENTS: an entry whose NAME is a RINEX system letter
 *                      (G R E C J I S) selects that satellite system; no entries
 *                      selects every system the file holds. The descriptor this
 *                      method returns lists one segment per system it read, so
 *                      the reply can be edited and sent back as the request.
 *
 * WHAT $GNO CARRIES. One record per epoch: EPOCH as the file spelled it,
 * NUM_SATS and CLOCK_OFFSET from the epoch line, the receiver and antenna
 * identity and APPROX_X/Y/Z from the header, INTERVAL, and per satellite its id,
 * its constellation and every observation as the file wrote it: SIGNAL is the
 * three-character RINEX observation code (C1C, L1C, D1C, S1C), OBS_TYPE its type,
 * VALUE the number, LLI and SSI the two indicators. OBS_CODE_SET holds one entry
 * per system, the header's own list ("G C1C L1C ..."), so the column order is
 * not lost. ELEVATION, AZIMUTH, TRACKING_STATUS, AGC_STATE, the DOPs and the
 * geodetic position are NOT in the file and are left at the schema default; they
 * are never computed here.
 *
 * WHAT NEITHER $GNO NOR $NCD HAS A PLACE FOR is listed by header label in the
 * descriptor's COMMENT_AREA: the file's own header records that were present
 * and not carried (marker number, observer, antenna offsets, phase shifts,
 * GLONASS slots, leap seconds ...). The time system is NATIVE_TIME_SYSTEM.
 */

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

#include "sha256.hpp"
#include "ncd_frame.hpp"
#include "rinex_obs.hpp"

namespace {

constexpr const char* kRinexObsFormat = "rinex-obs";
constexpr size_t kMaxEpochs = 65535;  // the SDK's ceiling on frames in one output port

int rinex_refuse(const std::string& code, const std::string& message) {
    plugin_set_error(code.c_str(), message.c_str());
    return 400;
}

bool constellation_of(char system, gnssConstellation* out) {
    switch (system) {
        case 'G': *out = gnssConstellation::GPS; return true;
        case 'R': *out = gnssConstellation::GLONASS; return true;
        case 'E': *out = gnssConstellation::GALILEO; return true;
        case 'C': *out = gnssConstellation::BEIDOU; return true;
        case 'J': *out = gnssConstellation::QZSS; return true;
        case 'I': *out = gnssConstellation::IRNSS; return true;
        case 'S': *out = gnssConstellation::SBAS; return true;
        default: return false;
    }
}

gnssObsType observation_type_of(char type) {
    switch (type) {
        case 'C': return gnssObsType::PSEUDORANGE;
        case 'L': return gnssObsType::CARRIER_PHASE;
        case 'D': return gnssObsType::DOPPLER;
        default: return gnssObsType::SNR;  // 'S', the only other type the parser lets through
    }
}

/* The window comparison: days from 1970 and seconds into the day, on the file's own scale. */
bool stamp_to_key(const std::string& iso, double* out) {
    int y = 0, mo = 0, d = 0, hh = 0, mi = 0;
    double ss = 0.0;
    int consumed = 0;
    if (std::sscanf(iso.c_str(), "%d-%d-%dT%d:%d:%lf%n", &y, &mo, &d, &hh, &mi, &ss, &consumed) != 6) return false;
    if (iso[static_cast<size_t>(consumed)] != '\0' || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    *out = static_cast<double>(rinex::detail::days_from_civil(y, static_cast<unsigned>(mo), static_cast<unsigned>(d))) * 86400.0 +
           hh * 3600.0 + mi * 60.0 + ss;
    return true;
}

}  // namespace

extern "C" int read_observations(void) {
    ContainerFrame frame;
    const int rc = decode_container_frame("read_observations", &frame);
    if (rc) return rc;

    const NCD* request = frame.descriptor;
    if (request->FORMAT() != ncdContainerFormat::PROVIDER_DEFINED || !request->PROVIDER_DEFINED_FORMAT_NAME() ||
        request->PROVIDER_DEFINED_FORMAT_NAME()->str() != kRinexObsFormat) {
        return rinex_refuse("format-mismatch",
                            "read_observations reads FORMAT PROVIDER_DEFINED with PROVIDER_DEFINED_FORMAT_NAME \"rinex-obs\".");
    }

    // The request: window and systems, all from the $NCD.
    bool has_start = false, has_stop = false;
    double window_start = 0.0, window_stop = 0.0;
    if (request->START_TIME() && request->START_TIME()->size() > 0) {
        if (!stamp_to_key(request->START_TIME()->str(), &window_start)) {
            return rinex_refuse("bad-selection", "The request START_TIME \"" + request->START_TIME()->str() +
                                                     "\" is not an ISO 8601 time.");
        }
        has_start = true;
    }
    if (request->STOP_TIME() && request->STOP_TIME()->size() > 0) {
        if (!stamp_to_key(request->STOP_TIME()->str(), &window_stop)) {
            return rinex_refuse("bad-selection", "The request STOP_TIME \"" + request->STOP_TIME()->str() +
                                                     "\" is not an ISO 8601 time.");
        }
        has_stop = true;
    }
    if (has_start && has_stop && window_stop < window_start) {
        return rinex_refuse("bad-selection", "The request STOP_TIME precedes its START_TIME.");
    }
    std::string wanted;  // system letters selected; empty selects all
    if (request->SEGMENTS()) {
        for (size_t k = 0; k < request->SEGMENTS()->size(); ++k) {
            const NCDSegmentDescriptor* d = request->SEGMENTS()->Get(static_cast<::flatbuffers::uoffset_t>(k));
            const std::string name = d->NAME() ? d->NAME()->str() : std::string();
            gnssConstellation ignored;
            if (name.size() != 1 || !constellation_of(name[0], &ignored)) {
                return rinex_refuse("bad-selection", "A request SEGMENTS entry names \"" + name +
                                                         "\", which is not a RINEX system letter (G R E C J I S).");
            }
            if (wanted.find(name[0]) == std::string::npos) wanted += name[0];
        }
    }

    rinex::File file;
    rinex::Refusal refusal;
    if (!rinex::parse_observations(reinterpret_cast<const char*>(frame.body), frame.body_length, &file, &refusal)) {
        return rinex_refuse(refusal.code, refusal.message);
    }
    for (char s : wanted) {
        if (!file.types.count(s)) {
            return rinex_refuse("empty-selection", std::string("The request selects system ") + s +
                                                       ", which the file's header does not declare.");
        }
    }

    // Select epochs by the window and satellites by system.
    std::vector<size_t> chosen;
    for (size_t e = 0; e < file.epochs.size(); ++e) {
        double key = static_cast<double>(file.epochs[e].day_number) * 86400.0 + file.epochs[e].seconds_of_day;
        if (has_start && key < window_start) continue;
        if (has_stop && key > window_stop) continue;
        bool any = wanted.empty();
        for (const rinex::SatelliteRecord& sat : file.epochs[e].satellites) {
            if (!wanted.empty() && wanted.find(sat.system) != std::string::npos) any = true;
        }
        if (any) chosen.push_back(e);
    }
    if (chosen.empty()) return rinex_refuse("empty-selection", "No epoch of the file is selected by the request.");
    if (chosen.size() > kMaxEpochs) {
        return rinex_refuse("too-many-epochs",
                            "The request selects " + std::to_string(chosen.size()) + " epochs and one reply holds at most " +
                                std::to_string(kMaxEpochs) + "; narrow it with START_TIME and STOP_TIME.");
    }

    // The per-system span read, for the descriptor.
    struct Span { std::string first, last; };
    std::map<char, Span> spans;

    for (size_t index : chosen) {
        const rinex::Epoch& epoch = file.epochs[index];
        GNOT gno;
        gno.ID = (file.marker_name.empty() ? std::string() : file.marker_name + ":") + epoch.stamp;
        gno.RECEIVER_ID = file.receiver_serial;
        gno.RECEIVER_TYPE = file.receiver_type;
        gno.FIRMWARE_VERSION = file.receiver_version;
        gno.ANTENNA_ID = file.antenna_serial;
        gno.ANTENNA_TYPE = file.antenna_type;
        gno.EPOCH = epoch.stamp;
        if (epoch.has_clock_offset) gno.CLOCK_OFFSET = epoch.clock_offset;
        if (file.has_position) {
            gno.APPROX_X = file.position[0];
            gno.APPROX_Y = file.position[1];
            gno.APPROX_Z = file.position[2];
        }
        if (file.has_interval) gno.INTERVAL = file.interval;
        for (const auto& kv : file.types) {
            std::string entry(1, kv.first);
            for (const std::string& code : kv.second) entry += " " + code;
            gno.OBS_CODE_SET.push_back(entry);
        }
        size_t kept = 0;
        for (const rinex::SatelliteRecord& sat : epoch.satellites) {
            if (!wanted.empty() && wanted.find(sat.system) == std::string::npos) continue;
            gnssConstellation constellation;
            if (!constellation_of(sat.system, &constellation)) {
                return rinex_refuse("bad-satellite-record", std::string("System \"") + sat.system + "\" is not a satellite system.");
            }
            std::unique_ptr<gnssSatObsT> out(new gnssSatObsT());
            out->GNSS_SAT_ID = sat.id;
            out->CONSTELLATION = constellation;
            for (const rinex::Observation& o : sat.observations) {
                std::unique_ptr<gnssObsDataT> d(new gnssObsDataT());
                d->SIGNAL = o.code;
                d->OBS_TYPE = observation_type_of(o.code[0]);
                d->VALUE = o.value;
                d->LLI = o.lli;
                d->SSI = o.ssi;
                out->OBSERVATIONS.push_back(std::move(d));
            }
            gno.SAT_OBS.push_back(std::move(out));
            ++kept;
            Span& span = spans[sat.system];
            if (span.first.empty()) span.first = epoch.stamp;
            span.last = epoch.stamp;
        }
        gno.NUM_SATS = static_cast<uint32_t>(kept);

        ::flatbuffers::FlatBufferBuilder fbb(8192);
        fbb.FinishSizePrefixed(CreateGNO(fbb, &gno), GNOIdentifier());
        if (plugin_push_output_ex("observations", "GNO.fbs", "$GNO", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "GNO", 0, 8,
                                  fbb.GetBufferPointer(), static_cast<uint32_t>(fbb.GetSize())) < 0) {
            return 500;
        }
    }

    NCDT descriptor;
    descriptor.FORMAT = ncdContainerFormat::PROVIDER_DEFINED;
    descriptor.PROVIDER_DEFINED_FORMAT_NAME = kRinexObsFormat;
    {
        char version[16];
        std::snprintf(version, sizeof(version), "%.2f", file.version);
        descriptor.FORMAT_VERSION = version;
    }
    descriptor.PRODUCER = file.program;
    descriptor.ORIGINATOR = file.run_by;
    {
        // "20250118 235945 UTC" is the RINEX 3 form; any other spelling is left to the comment area.
        int y = 0, mo = 0, d = 0, hh = 0, mi = 0, ss = 0;
        char zone[8] = {0};
        if (std::sscanf(file.date.c_str(), "%4d%2d%2d %2d%2d%2d %7s", &y, &mo, &d, &hh, &mi, &ss, zone) == 7 && file.date.size() >= 15) {
            char iso[48];
            std::snprintf(iso, sizeof(iso), "%04d-%02d-%02dT%02d:%02d:%02d", y, mo, d, hh, mi, ss);
            descriptor.CREATION_DATE = iso;
        } else if (!file.date.empty()) {
            descriptor.COMMENT_AREA.push_back("PGM / RUN BY / DATE: " + file.date);
        }
    }
    descriptor.INTERNAL_FILE_NAME = file.marker_name;
    for (const std::string& c : file.comments) descriptor.COMMENT_AREA.push_back(c);
    if (!file.uncarried_labels.empty()) {
        std::string line = "RINEX header records not carried by $GNO or $NCD:";
        for (size_t k = 0; k < file.uncarried_labels.size(); ++k) line += (k ? ", " : " ") + file.uncarried_labels[k];
        descriptor.COMMENT_AREA.push_back(line);
    }
    descriptor.NATIVE_TIME_SYSTEM = file.time_system;
    descriptor.START_TIME = file.epochs[chosen.front()].stamp;
    descriptor.STOP_TIME = file.epochs[chosen.back()].stamp;
    for (const auto& kv : spans) {
        std::unique_ptr<NCDSegmentDescriptorT> d(new NCDSegmentDescriptorT());
        d->NAME = std::string(1, kv.first);
        d->START_EPOCH = kv.second.first;
        d->STOP_EPOCH = kv.second.last;
        descriptor.SEGMENTS.push_back(std::move(d));
    }
    descriptor.SOURCE_BYTE_LENGTH = static_cast<uint64_t>(frame.body_length);
    descriptor.SOURCE_SHA256 = ephem::sha256_hex(frame.body, frame.body_length);
    if (request->SOURCE_CID()) descriptor.SOURCE_CID = request->SOURCE_CID()->str();

    ::flatbuffers::FlatBufferBuilder ncd_fbb(4096);
    ncd_fbb.FinishSizePrefixed(CreateNCD(ncd_fbb, &descriptor), NCDIdentifier());
    return plugin_push_output_ex("descriptor", "NCD.fbs", "$NCD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "NCD", 0, 8,
                                 ncd_fbb.GetBufferPointer(), static_cast<uint32_t>(ncd_fbb.GetSize())) < 0
               ? 500
               : 0;
}
