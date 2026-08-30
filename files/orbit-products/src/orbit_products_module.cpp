/*
 * files/orbit-products — the container reader surface.
 *
 * TWO RECORDS, BECAUSE A CONTAINER IS TWO THINGS
 *
 * `$OEM` holds the states. `$NCD` holds everything about the FILE that is not
 * a property of any state in it: the internal file name, the comment area, the
 * segment address ranges, the SP3 accuracy block, the scenario-epoch
 * parameters, the Code-500 header. A reader that emits only the first half
 * makes the second half unrecoverable, and a writer downstream then invents a
 * header rather than reproducing one. Both methods here emit the descriptor;
 * `read_container` additionally materialises the states.
 *
 * HOW THE BYTES ARRIVE, AND WHY THIS SHAPE
 *
 * `$NCD` describes a container; it does not carry one. It has SOURCE_SHA256,
 * SOURCE_BYTE_LENGTH and SOURCE_CID and no payload field, which is correct —
 * a descriptor that embedded its subject would have to be rebuilt whenever the
 * subject moved. But the SDK refuses a port whose type is acceptsAnyFlatbuffer,
 * so "raw bytes plus a typed descriptor" cannot be two ports: the byte port
 * would have no concrete SDS identity to declare.
 *
 * So the frame is ONE port carrying BOTH, in this order:
 *
 *     [u32le n][ $NCD flatbuffer, n bytes ][ the container's exact bytes ]
 *
 * which is exactly a size-prefixed `$NCD` buffer with the described file
 * appended. The size prefix is self-describing, so the boundary is read out of
 * the frame rather than agreed out of band, and SOURCE_SHA256 / SOURCE_BYTE_LENGTH
 * make the pairing PROVABLE: when the caller declared either, it is checked
 * against the trailing bytes and a mismatch is refused. That check is the whole
 * reason the schema carries the hash — "a consumer can prove the descriptor
 * belongs to the file it holds" — and without the bytes in the frame this
 * module would need a fetch capability to do its job, which a pure parser must
 * not have.
 *
 * WHY THIS DISPATCHES PER FORMAT INSTEAD OF CALLING load_container
 *
 * `ephem::load_container` answers "what states are in here" and deliberately
 * drops the container's own header. `$NCD` IS that dropped half. Calling
 * load_container and then re-parsing the buffer for the header would be two
 * passes over one file that can disagree with each other — the exact failure
 * one dispatcher exists to prevent. So this dispatches once, using the same
 * per-format reader calls containers.hpp makes and the same detection
 * predicates, and keeps both halves of the single parse.
 *
 * TIME
 *
 * No scale conversion, per the spine's rule: epochs stay on the scale the
 * container declared and that name travels with them (NCD.NATIVE_TIME_SYSTEM
 * verbatim, and the block's TIME_SYSTEM as the ratified enum member). What DOES
 * happen here is rebasing: a Series' rows may be seconds from the container's
 * own zero point (Code-500, STK, SP3) or already absolute past J2000 (SPK,
 * OEM), and `$OEM` wants absolute ISO-8601. The zero point is selected by
 * format rather than by sniffing `epoch_zero_iso`, because an OEM sets that
 * field to its START_TIME as METADATA while its rows stay absolute — reading it
 * as an origin there would double-count the epoch.
 *
 * NO JSON IS EMITTED HERE. Both surfaces are FlatBuffers, so every key is a
 * generated accessor name and cannot be hand-typed. A caller that projects
 * further to JSON uses the IDL field identifiers verbatim
 * (CLOCK_BIAS_MICROSECONDS, OBJECT_NAIF_ID, X_DOT), never lowercased.
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

namespace {

/* ------------------------------------------------------------------------ */
/* Text helpers                                                              */
/* ------------------------------------------------------------------------ */

std::string upper_ascii(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) out.push_back(c >= 'a' && c <= 'z' ? static_cast<char>(c - 32) : c);
    return out;
}

uint32_t read_u32le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

/* ------------------------------------------------------------------------ */
/* The input frame                                                           */
/* ------------------------------------------------------------------------ */

struct ContainerFrame {
    /* An aligned copy of `[u32le n][$NCD]`. FlatBuffers built size-prefixed
     * align their 8-byte scalars counting the prefix, so the descriptor must
     * sit at an allocator-aligned address for the accessors to read it. The
     * container BODY is left where it arrived: every reader here goes through
     * memcpy, so it has no alignment requirement of its own and copying a
     * half-gigabyte kernel to satisfy one that does not exist would be the
     * module's whole runtime cost. */
    std::vector<uint8_t> descriptor_bytes;
    const NCD* descriptor = nullptr;
    const uint8_t* body = nullptr;
    size_t body_length = 0;
};

/* Returns 0 on success, or an invoke status; sets the plugin error itself. */
int32_t decode_container_frame(const char* method, ContainerFrame* out) {
    const int32_t index = plugin_find_input_index("container", 0);
    const plugin_input_frame_t* frame =
        index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "%s requires a frame on port \"container\".", method);
        plugin_set_error("missing-container-frame", message);
        return 400;
    }

    const uint8_t* payload = frame->payload;
    const size_t payload_length = static_cast<size_t>(frame->payload_length);
    if (payload_length < 8) {
        plugin_set_error("malformed-container-frame",
                         "The frame is too short to hold a size-prefixed $NCD descriptor.");
        return 400;
    }

    const uint32_t descriptor_length = read_u32le(payload);
    /* The prefix is the descriptor's length, so 4 + it is where the container
     * starts. A prefix that overruns the frame is a frame that is not what it
     * declares, and is refused before anything reads past it. */
    if (static_cast<uint64_t>(descriptor_length) + 4u > payload_length) {
        plugin_set_error("malformed-container-frame",
                         "The $NCD size prefix overruns the frame; the descriptor and the "
                         "container bytes must arrive in one frame as "
                         "[u32le n][$NCD][container].");
        return 400;
    }

    const size_t prefixed_length = 4u + static_cast<size_t>(descriptor_length);
    out->descriptor_bytes.assign(payload, payload + prefixed_length);
    ::flatbuffers::Verifier verifier(out->descriptor_bytes.data(), out->descriptor_bytes.size());
    if (!::flatbuffers::BufferHasIdentifier(out->descriptor_bytes.data(), NCDIdentifier(), true) ||
        !VerifySizePrefixedNCDBuffer(verifier)) {
        plugin_set_error("bad-ncd",
                         "The frame does not open with a verifiable size-prefixed $NCD buffer.");
        return 400;
    }
    out->descriptor = GetSizePrefixedNCD(out->descriptor_bytes.data());

    out->body = payload + prefixed_length;
    out->body_length = payload_length - prefixed_length;
    if (out->body_length == 0) {
        plugin_set_error("missing-container-bytes",
                         "The frame carries an $NCD descriptor and no container. $NCD describes "
                         "a file rather than carrying one, so the described bytes must follow "
                         "the descriptor in the same frame; this module has no fetch capability "
                         "and will not resolve SOURCE_CID on its own.");
        return 400;
    }

    /* The declared identity is checked against the bytes that arrived, not
     * assumed to match them. This is what SOURCE_SHA256 is for. */
    if (out->descriptor->SOURCE_BYTE_LENGTH() != 0 &&
        out->descriptor->SOURCE_BYTE_LENGTH() != static_cast<uint64_t>(out->body_length)) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "SOURCE_BYTE_LENGTH is %llu but the frame carries %llu container bytes.",
                      static_cast<unsigned long long>(out->descriptor->SOURCE_BYTE_LENGTH()),
                      static_cast<unsigned long long>(out->body_length));
        plugin_set_error("descriptor-length-mismatch", message);
        return 400;
    }
    if (out->descriptor->SOURCE_SHA256() && out->descriptor->SOURCE_SHA256()->size() > 0) {
        const std::string declared = out->descriptor->SOURCE_SHA256()->str();
        std::string lowered;
        lowered.reserve(declared.size());
        for (char c : declared) {
            lowered.push_back(c >= 'A' && c <= 'F' ? static_cast<char>(c + 32) : c);
        }
        const std::string actual = ephem::sha256_hex(out->body, out->body_length);
        if (lowered != actual) {
            char message[256];
            std::snprintf(message, sizeof(message),
                          "SOURCE_SHA256 declares %.16s... but the container bytes hash to "
                          "%.16s...; the descriptor does not describe this file.",
                          lowered.c_str(), actual.c_str());
            plugin_set_error("descriptor-hash-mismatch", message);
            return 400;
        }
    }
    return 0;
}

/* ------------------------------------------------------------------------ */
/* Format discrimination                                                     */
/* ------------------------------------------------------------------------ */

/*
 * `$NCD`'s roster is wider than this reader: it names OEM/AEM/TDM in XML and
 * attitude containers this module does not project onto `$OEM`. A member we do
 * not read is refused BY NAME rather than folded into a neighbour, because a
 * silently substituted reader produces numbers from the wrong parser.
 */
bool ephem_format_for(ncdContainerFormat declared, ephem::Format* out, const char** why) {
    switch (declared) {
        case ncdContainerFormat::UNSPECIFIED:
            *out = ephem::Format::Auto;
            return true;
        case ncdContainerFormat::SPK_DAF:
            *out = ephem::Format::SpkDaf;
            return true;
        case ncdContainerFormat::SP3_C:
        case ncdContainerFormat::SP3_D:
            /* One reader: SP3-c and SP3-d differ in satellite ceiling and
             * header line count, both of which sp3::read reads out of the
             * file's own version character. */
            *out = ephem::Format::Sp3d;
            return true;
        case ncdContainerFormat::CODE_500:
            *out = ephem::Format::Code500;
            return true;
        case ncdContainerFormat::SCENARIO_EPOCH_EPHEMERIS_TEXT:
            *out = ephem::Format::StkEphemeris;
            return true;
        case ncdContainerFormat::CCSDS_OEM_KVN:
            *out = ephem::Format::CcsdsOemKvn;
            return true;
        case ncdContainerFormat::SCENARIO_EPOCH_ATTITUDE_TEXT:
        case ncdContainerFormat::CCSDS_AEM_KVN:
        case ncdContainerFormat::CCSDS_AEM_XML:
            *why = "an attitude container; its states are quaternions, which $OEM cannot carry";
            return false;
        case ncdContainerFormat::CCSDS_TDM_KVN:
        case ncdContainerFormat::CCSDS_TDM_XML:
            *why = "a tracking-data container; its records are observations, not states";
            return false;
        case ncdContainerFormat::CCSDS_OEM_XML:
            *why = "CCSDS-OEM in XML; this module reads the keyword-value notation";
            return false;
        case ncdContainerFormat::PROVIDER_DEFINED:
            *why = "PROVIDER_DEFINED, which names a layout outside the roster";
            return false;
        default:
            break;
    }
    *why = "not a member of the ncdContainerFormat roster this build knows";
    return false;
}

/* ------------------------------------------------------------------------ */
/* One parse, both halves                                                    */
/* ------------------------------------------------------------------------ */

struct Loaded {
    ephem::Format format = ephem::Format::Auto;
    std::vector<ephem::Series> series;

    /* Parallel to `series`, and empty for every container but SP3 — whose
     * per-record standard-deviation exponents and event flags live BESIDE the
     * states rather than on them, and are the columns $OEM 1.1.4 added room
     * for. */
    std::vector<std::vector<sp3::RecordFlags> > flags;

    daf::File daf;
    sp3::File sp3;
    code500::Header code500_header;
    kvn::Document oem;
};

ephem::Status load_native(const uint8_t* bytes, size_t len, ephem::Format requested,
                          Loaded* out) {
    if (!bytes || !out || len == 0) return ephem::Status::Malformed;

    /* Detection uses containers.hpp's own predicates, in containers.hpp's own
     * order, so "what is this file" has exactly one answer in this package.
     * Code-500 is the residual and is admitted only after its own header
     * validation below — a residual accepted by elimination will happily
     * "read" a corrupted file of any other kind. */
    ephem::Format resolved = requested;
    if (resolved == ephem::Format::Auto) {
        if (ephem::looks_like_daf(bytes, len)) resolved = ephem::Format::SpkDaf;
        else if (ephem::looks_like_sp3(bytes, len)) resolved = ephem::Format::Sp3d;
        else if (ephem::looks_like_stk(bytes, len)) resolved = ephem::Format::StkEphemeris;
        else if (ephem::looks_like_oem_kvn(bytes, len)) resolved = ephem::Format::CcsdsOemKvn;
        else resolved = ephem::Format::Code500;
    }
    out->format = resolved;

    switch (resolved) {
        case ephem::Format::SpkDaf: {
            const ephem::Status st = daf::read(bytes, len, &out->daf);
            if (st != ephem::Status::Ok) return st;
            for (const daf::Summary& seg : out->daf.summaries) {
                ephem::Series s;
                const ephem::Status ss = spk::to_series(out->daf, seg, &s);
                /* A kernel may mix segment types. Skipping the ones we do not
                 * evaluate is right — one Chebyshev planetary segment must not
                 * hide forty readable spacecraft segments — but the DESCRIPTOR
                 * still lists every segment, because the file has them. */
                if (ss == ephem::Status::UnsupportedVariant) continue;
                if (ss != ephem::Status::Ok) return ss;
                out->series.push_back(s);
                out->flags.push_back(std::vector<sp3::RecordFlags>());
            }
            return out->series.empty() ? ephem::Status::UnsupportedVariant : ephem::Status::Ok;
        }
        case ephem::Format::Sp3d: {
            const ephem::Status st =
                sp3::read(reinterpret_cast<const char*>(bytes), len, &out->sp3);
            if (st != ephem::Status::Ok) return st;
            for (const sp3::SatelliteBlock& sat : out->sp3.satellites) {
                out->series.push_back(sat.series);
                out->flags.push_back(sat.flags);
            }
            return out->series.empty() ? ephem::Status::NotEnoughStates : ephem::Status::Ok;
        }
        case ephem::Format::StkEphemeris: {
            ephem::Series s;
            const ephem::Status st =
                stk_ephem::read(reinterpret_cast<const char*>(bytes), len, &s);
            if (st != ephem::Status::Ok) return st;
            out->series.push_back(s);
            out->flags.push_back(std::vector<sp3::RecordFlags>());
            return ephem::Status::Ok;
        }
        case ephem::Format::CcsdsOemKvn: {
            const ephem::Status st =
                ephem::oem_kvn::read(reinterpret_cast<const char*>(bytes), len, &out->series);
            if (st != ephem::Status::Ok) return st;
            /* The KVN document is re-read for the header keywords the Series
             * does not carry (CCSDS_OEM_VERS, CREATION_DATE, ORIGINATOR). This
             * is the one format where the second read is a keyword scan of the
             * same text rather than a second parse of a binary layout, and
             * oem_kvn::read has no out-parameter for the document. */
            if (kvn::parse(reinterpret_cast<const char*>(bytes), len, &out->oem) !=
                kvn::Status::Ok) {
                return ephem::Status::Malformed;
            }
            out->flags.assign(out->series.size(), std::vector<sp3::RecordFlags>());
            return ephem::Status::Ok;
        }
        case ephem::Format::Code500: {
            ephem::Series s;
            const ephem::Status st = code500::read(bytes, len, &s, &out->code500_header);
            if (st != ephem::Status::Ok) {
                /* Arriving here by elimination and failing means the buffer was
                 * never any of these containers. Reporting a Code-500 parse
                 * error would send the caller after the wrong bug. */
                return requested == ephem::Format::Auto ? ephem::Status::UnsupportedVariant : st;
            }
            out->series.push_back(s);
            out->flags.push_back(std::vector<sp3::RecordFlags>());
            return ephem::Status::Ok;
        }
        case ephem::Format::Auto:
            break;
    }
    return ephem::Status::UnsupportedVariant;
}

/*
 * The zero point `Series::rows[i].epoch` counts from, in seconds past J2000 on
 * the container's own scale.
 *
 * Selected by FORMAT, not by testing whether `epoch_zero_iso` is set: an OEM
 * fills that field with its START_TIME as METADATA while its rows stay
 * absolute, so reading it as an origin there would add the epoch to itself.
 * SP3 is the case that forces the switch to be explicit — its rows ARE relative
 * to the file's first epoch, but its reader records that epoch only as ISO
 * text, leaving `epoch_zero_offset_sec` at zero.
 */
bool epoch_zero_for(ephem::Format format, const ephem::Series& s, double* out) {
    switch (format) {
        case ephem::Format::SpkDaf:
        case ephem::Format::CcsdsOemKvn:
            *out = 0.0;
            return true;
        case ephem::Format::Code500:
        case ephem::Format::StkEphemeris:
            *out = s.epoch_zero_offset_sec;
            return true;
        case ephem::Format::Sp3d:
            if (s.epoch_zero_iso.empty()) {
                *out = 0.0;
                return true;
            }
            return ephem::oem_kvn::iso_to_seconds(s.epoch_zero_iso, out);
        case ephem::Format::Auto:
            break;
    }
    return false;
}

/* ------------------------------------------------------------------------ */
/* Vocabulary mapping                                                        */
/* ------------------------------------------------------------------------ */

/*
 * A container's time-system token onto the ratified `timingStandard`.
 *
 * There is no UNSPECIFIED member and GMST is ordinal zero, so an UNSET field
 * decodes as Greenwich Mean Sidereal Time — a wrong answer that looks like a
 * default. A token with no member is therefore REFUSED rather than left unset;
 * the descriptor still carries the container's own spelling in
 * NATIVE_TIME_SYSTEM, so nothing is lost by refusing to guess here.
 */
bool time_system_for(const std::string& name, timingStandard* out) {
    struct Row { const char* token; timingStandard value; };
    static const Row kRows[] = {
        {"GMST", timingStandard::GMST},
        {"GPS", timingStandard::GPS},
        {"MET", timingStandard::MET},
        {"MRT", timingStandard::MRT},
        {"SCLK", timingStandard::SCLK},
        {"TAI", timingStandard::TAI},
        {"TCB", timingStandard::TCB},
        {"TDB", timingStandard::TDB},
        {"ET", timingStandard::TDB},   /* SPK's own name for the same scale */
        {"TCG", timingStandard::TCG},
        {"TT", timingStandard::TT},
        {"TDT", timingStandard::TT},
        {"UT1", timingStandard::UT1},
        {"UTC", timingStandard::UTC},
        {"UTCG", timingStandard::UTC}, /* the STK TimeFormat spelling */
        {"GLONASS", timingStandard::GLONASS},
        {"GLO", timingStandard::GLONASS}, /* the SP3 %c column spelling */
        {"GST", timingStandard::GST},
        {"GAL", timingStandard::GST},
        {"QZSS", timingStandard::QZSS},
        {"QZS", timingStandard::QZSS},
        {"BDT", timingStandard::BDT},
        {"NAVIC", timingStandard::NAVIC},
        {"IRN", timingStandard::NAVIC},
        {"SBAS", timingStandard::SBAS},
        {"A1", timingStandard::A1},
        {"A.1", timingStandard::A1},
    };
    const std::string upper = upper_ascii(name);
    for (const Row& r : kRows) {
        if (upper == r.token) {
            *out = r.value;
            return true;
        }
    }
    return false;
}

/*
 * A container's frame NAME onto a ratified `CelestialFrame`, by exact token
 * only. `$RFM.NAME` always carries the container's own spelling; the union is
 * set only where the spelling IS a roster member, because a near-match here
 * ("ITRF2014" is not "ITRF2000") is wrong by the difference between two
 * realisations and reads as authoritative.
 */
bool celestial_frame_for(const std::string& name, CelestialFrame* out) {
    struct Row { const char* token; CelestialFrame value; };
    static const Row kRows[] = {
        {"GCRF", CelestialFrame::GCRF},
        {"ICRF", CelestialFrame::ICRF},
        {"J2000", CelestialFrame::J2000},
        {"EME2000", CelestialFrame::EME2000},
        {"TEME", CelestialFrame::TEMEOFDATE},
        {"TEMEOFDATE", CelestialFrame::TEMEOFDATE},
        {"ITRF93", CelestialFrame::ITRF93},
        {"ITRF97", CelestialFrame::ITRF97},
        {"ITRF2000", CelestialFrame::ITRF2000},
        {"B1950", CelestialFrame::B1950},
        {"WGS84", CelestialFrame::WGS84},
    };
    const std::string upper = upper_ascii(name);
    for (const Row& r : kRows) {
        if (upper == r.token) {
            *out = r.value;
            return true;
        }
    }
    return false;
}

/* ------------------------------------------------------------------------ */
/* $OEM projection                                                           */
/* ------------------------------------------------------------------------ */

/*
 * Which of $OEM's two mutually exclusive state forms this series takes.
 *
 * The IDL selects on STEP_SIZE: > 0 means the compact row-major
 * EPHEMERIS_DATA on an implicit uniform grid, 0 means EPHEMERIS_DATA_LINES
 * with an explicit epoch per state. Uniformity is necessary but not
 * sufficient: the compact array is bare doubles with no room for the clock
 * columns or the sigma exponents, so a series carrying either takes the
 * verbose form even on a perfect grid. Dropping SP3's clock column to save
 * bytes would undo exactly what the 1.1.4 schema bump was for.
 */
bool needs_lines_form(const ephem::Series& s, const std::vector<sp3::RecordFlags>& flags,
                      double* step_out) {
    for (const ephem::StateRow& r : s.rows) {
        if (r.has_clock) return true;
    }
    if (!flags.empty()) return true;
    return !s.uniform_step(step_out);
}

int32_t build_oem(const Loaded& loaded, OEMT* out) {
    for (size_t i = 0; i < loaded.series.size(); ++i) {
        const ephem::Series& s = loaded.series[i];
        const std::vector<sp3::RecordFlags>& flags = loaded.flags[i];

        double zero = 0.0;
        if (!epoch_zero_for(loaded.format, s, &zero)) {
            plugin_set_error("unreadable-epoch-origin",
                             "The container declares an epoch zero point that cannot be read; "
                             "its rows cannot be placed on an absolute axis.");
            return 400;
        }

        timingStandard time_system = timingStandard::UTC;
        if (!time_system_for(s.time_system, &time_system)) {
            char message[256];
            std::snprintf(message, sizeof(message),
                          "The container declares time system \"%s\", which has no timingStandard "
                          "member. Leaving TIME_SYSTEM unset would publish it as GMST, so the "
                          "read is refused; NATIVE_TIME_SYSTEM in the descriptor carries the "
                          "container's own spelling.",
                          s.time_system.c_str());
            plugin_set_error("unmappable-time-system", message);
            return 400;
        }

        std::unique_ptr<ephemerisDataBlockT> block(new ephemerisDataBlockT());
        block->CENTER_NAME = s.center_name;
        block->TIME_SYSTEM = time_system;

        if (!s.object_name.empty() || !s.object_id.empty()) {
            block->OBJECT.reset(new CATT());
            block->OBJECT->OBJECT_NAME = s.object_name;
            block->OBJECT->OBJECT_ID = s.object_id;
        }
        if (!s.frame_name.empty()) {
            block->REFERENCE_FRAME.reset(new RFMT());
            block->REFERENCE_FRAME->NAME = s.frame_name;
            CelestialFrame celestial = CelestialFrame::GCRF;
            if (celestial_frame_for(s.frame_name, &celestial)) {
                CelestialFrameWrapperT wrapper;
                wrapper.frame = celestial;
                block->REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(wrapper));
            }
        }

        /* The rule the container DECLARED. A container that declared none
         * leaves INTERPOLATION empty rather than publishing this module's
         * fallback as the producer's intent. */
        if (s.interp != ephem::Interp::Unknown) {
            block->INTERPOLATION = ephem::interp_name(s.interp);
        }
        block->INTERPOLATION_DEGREE = static_cast<uint32_t>(s.interp_degree > 0 ? s.interp_degree : 0);

        if (s.has_naif_ids) {
            block->OBJECT_NAIF_ID = s.naif_target;
            block->CENTER_NAIF_ID = s.naif_center;
        }

        if (!s.rows.empty()) {
            block->START_TIME = ephem::oem::iso_from_seconds(s.rows.front().epoch + zero);
            block->STOP_TIME = ephem::oem::iso_from_seconds(s.rows.back().epoch + zero);
        }

        bool all_acc = !s.rows.empty();
        for (const ephem::StateRow& r : s.rows) {
            if (!r.has_acc) { all_acc = false; break; }
        }

        double step = 0.0;
        if (!needs_lines_form(s, flags, &step)) {
            block->STEP_SIZE = step;
            block->STATE_VECTOR_SIZE = all_acc ? 9 : 6;
            block->EPHEMERIS_DATA.reserve(s.rows.size() * block->STATE_VECTOR_SIZE);
            for (const ephem::StateRow& r : s.rows) {
                for (int c = 0; c < 3; ++c) block->EPHEMERIS_DATA.push_back(r.pos[c]);
                for (int c = 0; c < 3; ++c) block->EPHEMERIS_DATA.push_back(r.vel[c]);
                if (all_acc) {
                    for (int c = 0; c < 3; ++c) block->EPHEMERIS_DATA.push_back(r.acc[c]);
                }
            }
        } else {
            block->STEP_SIZE = 0.0;
            for (size_t j = 0; j < s.rows.size(); ++j) {
                const ephem::StateRow& r = s.rows[j];
                std::unique_ptr<ephemerisDataLineT> line(new ephemerisDataLineT());
                line->EPOCH = ephem::oem::iso_from_seconds(r.epoch + zero);
                line->X = r.pos[0]; line->Y = r.pos[1]; line->Z = r.pos[2];
                line->X_DOT = r.vel[0]; line->Y_DOT = r.vel[1]; line->Z_DOT = r.vel[2];
                if (r.has_acc) {
                    line->X_DDOT = r.acc[0]; line->Y_DDOT = r.acc[1]; line->Z_DDOT = r.acc[2];
                }
                /* THE POINT OF THE 1.1.4 BUMP. Before it these columns had
                 * nowhere to go and an SP3 read through $OEM silently lost the
                 * clock the format makes mandatory in every position record. */
                if (r.has_clock) {
                    line->CLOCK_BIAS_MICROSECONDS = r.clock_bias;
                }
                if (j < flags.size()) {
                    const sp3::RecordFlags& f = flags[j];
                    if (f.has_clock_rate) {
                        line->CLOCK_RATE_MICROSECONDS_PER_SECOND = r.clock_rate;
                    }
                    /* A negative exponent is the reader's "the column was
                     * blank", which the spec defines as unknown and which is
                     * NOT an exponent of zero — so it is omitted, not stored. */
                    if (f.x_sdev >= 0) line->X_SIGMA_EXPONENT = static_cast<int8_t>(f.x_sdev);
                    if (f.y_sdev >= 0) line->Y_SIGMA_EXPONENT = static_cast<int8_t>(f.y_sdev);
                    if (f.z_sdev >= 0) line->Z_SIGMA_EXPONENT = static_cast<int8_t>(f.z_sdev);
                    if (f.xv_sdev >= 0) line->X_DOT_SIGMA_EXPONENT = static_cast<int8_t>(f.xv_sdev);
                    if (f.yv_sdev >= 0) line->Y_DOT_SIGMA_EXPONENT = static_cast<int8_t>(f.yv_sdev);
                    if (f.zv_sdev >= 0) line->Z_DOT_SIGMA_EXPONENT = static_cast<int8_t>(f.zv_sdev);
                }
                block->EPHEMERIS_DATA_LINES.push_back(std::move(line));
            }
        }

        out->EPHEMERIS_DATA_BLOCK.push_back(std::move(block));
    }

    if (loaded.format == ephem::Format::CcsdsOemKvn) {
        /* An OEM that came in as an OEM keeps its own header rather than being
         * restamped with ours: this module transcoded it, it did not originate
         * it. */
        if (const kvn::Entry* e = kvn::find(loaded.oem.header, "CCSDS_OEM_VERS")) {
            bool ok = false;
            const double v = kvn::to_double(e->value, &ok);
            if (ok) out->CCSDS_OEM_VERS = v;
        }
        if (const kvn::Entry* e = kvn::find(loaded.oem.header, "CREATION_DATE")) {
            out->CREATION_DATE = e->value;
        }
        if (const kvn::Entry* e = kvn::find(loaded.oem.header, "ORIGINATOR")) {
            out->ORIGINATOR = e->value;
        }
    }
    return 0;
}

/* ------------------------------------------------------------------------ */
/* $NCD projection                                                           */
/* ------------------------------------------------------------------------ */

ncdContainerFormat ncd_format_for(const Loaded& loaded) {
    switch (loaded.format) {
        case ephem::Format::SpkDaf: return ncdContainerFormat::SPK_DAF;
        case ephem::Format::Sp3d:
            /* The version character the FILE declared, not the reader's name
             * for its own lane: an SP3-c read by this reader is still an
             * SP3-c, and a rewrite that promoted it to -d would change the
             * satellite ceiling and the header line count. */
            return loaded.sp3.version == 'c' ? ncdContainerFormat::SP3_C
                                             : ncdContainerFormat::SP3_D;
        case ephem::Format::Code500: return ncdContainerFormat::CODE_500;
        case ephem::Format::StkEphemeris:
            return ncdContainerFormat::SCENARIO_EPOCH_EPHEMERIS_TEXT;
        case ephem::Format::CcsdsOemKvn: return ncdContainerFormat::CCSDS_OEM_KVN;
        case ephem::Format::Auto: break;
    }
    return ncdContainerFormat::UNSPECIFIED;
}

/*
 * The `stk.v.<n>` banner, which is line 1 of a scenario-epoch text container
 * and the only place its format version is stated. The Series does not carry
 * it — the spine holds states, not banners — so it is read off the front of
 * the buffer at the fixed position the format puts it. Leaving FORMAT_VERSION
 * unset instead would make a rewrite silently downgrade the banner to whatever
 * the writer defaults to, which is exactly the invented header value the
 * descriptor exists to prevent.
 */
std::string stk_banner(const uint8_t* bytes, size_t len) {
    const size_t limit = len < 256 ? len : 256;
    for (size_t i = 0; i + 6 <= limit; ++i) {
        if (std::memcmp(bytes + i, "stk.v.", 6) != 0) continue;
        size_t end = i;
        while (end < len && bytes[end] != '\n' && bytes[end] != '\r' && bytes[end] != ' ') ++end;
        return std::string(reinterpret_cast<const char*>(bytes + i), end - i);
    }
    return std::string();
}

/*
 * A Code-500 SPAN date, which is not the same field shape as its reference
 * date. The span is `YYY MMDD` — a THREE-digit year offset from 1900 when the
 * header's year format is 1, and a full `YYYYMMDD` when it is 2. `code500`'s
 * own `decode_yymmdd` decodes the REFERENCE time, which is a two-digit YYMMDD
 * and correctly refuses anything past 1999; running a span date through it
 * silently drops START_EPOCH and STOP_EPOCH for every file after that year,
 * which is every file. Same packing rule as `derive_header` writes, read back.
 */
bool decode_span_date(double packed, int year_format, int* y, int* m, int* d) {
    if (!ephem::is_finite(packed)) return false;
    const int64_t v = static_cast<int64_t>(packed);
    if (static_cast<double>(v) != packed || v < 10101) return false;
    const int mm = static_cast<int>((v / 100) % 100);
    const int dd = static_cast<int>(v % 100);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
    const int yy = static_cast<int>(v / 10000);
    *y = year_format == 2 ? yy : 1900 + yy;
    *m = mm;
    *d = dd;
    return true;
}

void split_lines(const std::string& text, std::vector<std::string>* out) {
    size_t start = 0;
    while (start <= text.size()) {
        size_t end = text.find('\n', start);
        if (end == std::string::npos) end = text.size();
        std::string line = text.substr(start, end - start);
        while (!line.empty() && (line[line.size() - 1] == '\r' || line[line.size() - 1] == ' ')) {
            line.erase(line.size() - 1);
        }
        if (!(line.empty() && end == text.size())) out->push_back(line);
        if (end == text.size()) break;
        start = end + 1;
    }
}

void build_descriptor(const Loaded& loaded, const uint8_t* body, size_t body_length,
                      const NCD* incoming, NCDT* out) {
    out->FORMAT = ncd_format_for(loaded);
    out->SOURCE_BYTE_LENGTH = static_cast<uint64_t>(body_length);
    out->SOURCE_SHA256 = ephem::sha256_hex(body, body_length);
    /* A content identifier is an ADDRESS, not a fact this module can derive:
     * it depends on a chunking and a codec the caller chose. It is carried
     * through from the incoming descriptor rather than recomputed or dropped. */
    if (incoming && incoming->SOURCE_CID()) out->SOURCE_CID = incoming->SOURCE_CID()->str();

    if (!loaded.series.empty()) {
        double first = 0.0;
        double last = 0.0;
        bool have = false;
        for (const ephem::Series& s : loaded.series) {
            if (s.rows.empty()) continue;
            double zero = 0.0;
            if (!epoch_zero_for(loaded.format, s, &zero)) continue;
            const double a = s.rows.front().epoch + zero;
            const double b = s.rows.back().epoch + zero;
            if (!have || a < first) first = a;
            if (!have || b > last) last = b;
            have = true;
        }
        if (have) {
            out->START_TIME = ephem::oem::iso_from_seconds(first);
            out->STOP_TIME = ephem::oem::iso_from_seconds(last);
        }
    }
    if (!loaded.series.empty()) {
        out->NATIVE_TIME_SYSTEM = loaded.series.front().time_system;
        out->NATIVE_FRAME_NAME = loaded.series.front().frame_name;
    }

    switch (loaded.format) {
        case ephem::Format::SpkDaf: {
            out->FORMAT_VERSION = loaded.daf.id_word;
            out->INTERNAL_FILE_NAME = loaded.daf.internal_name;
            split_lines(loaded.daf.comments, &out->COMMENT_AREA);
            if (!loaded.daf.summaries.empty()) {
                out->NATIVE_FRAME_ID = spk::segment_frame(loaded.daf.summaries.front());
            }
            /* EVERY segment, in file order, including the types this reader
             * does not evaluate: the descriptor describes the FILE, and a
             * segment list that silently omitted the segments we skipped would
             * make a rewrite drop them. */
            size_t series_index = 0;
            for (const daf::Summary& seg : loaded.daf.summaries) {
                std::unique_ptr<NCDSegmentDescriptorT> d(new NCDSegmentDescriptorT());
                d->NAME = seg.name;
                d->TARGET_NAIF_ID = spk::segment_target(seg);
                d->CENTER_NAIF_ID = spk::segment_center(seg);
                d->FRAME_NAIF_ID = spk::segment_frame(seg);
                d->FRAME_NAME = spk::builtin_frame_name(spk::segment_frame(seg));
                d->SEGMENT_TYPE = spk::segment_type(seg);
                d->START_SECONDS_PAST_J2000_TDB = seg.dc[0];
                d->STOP_SECONDS_PAST_J2000_TDB = seg.dc[1];
                d->START_EPOCH = ephem::oem::iso_from_seconds(seg.dc[0]);
                d->STOP_EPOCH = ephem::oem::iso_from_seconds(seg.dc[1]);
                d->INITIAL_ADDRESS = static_cast<uint64_t>(seg.ic[4]);
                d->FINAL_ADDRESS = static_cast<uint64_t>(seg.ic[5]);
                /* The polynomial degree the segment REALISES — Lagrange degree
                 * for types 8 and 9, 2w-1 for a type-13 Hermite window of w
                 * states. It comes from the series this segment produced rather
                 * than from the trailer word, because the trailer stores a
                 * different quantity in the two families and reproducing that
                 * asymmetry here would be a second place to get it backwards.
                 * A segment we did not evaluate claims no degree. */
                if (spk::is_supported_type(spk::segment_type(seg)) &&
                    series_index < loaded.series.size()) {
                    const int degree = loaded.series[series_index].interp_degree;
                    if (degree > 0) d->POLYNOMIAL_DEGREE = static_cast<uint32_t>(degree);
                    ++series_index;
                }
                out->SEGMENTS.push_back(std::move(d));
            }
            break;
        }
        case ephem::Format::Sp3d: {
            out->FORMAT_VERSION = std::string(1, loaded.sp3.version);
            out->PRODUCER = loaded.sp3.agency;
            /* SP3's header comment lines ARE its comment area, so they appear
             * both in the generic field a format-blind consumer reads and in
             * the SP3 block a rewriter reads. Populating only one would make
             * one of those two readers see an empty comment area. */
            out->COMMENT_AREA = loaded.sp3.comments;
            std::unique_ptr<NCDSP3HeaderT> h(new NCDSP3HeaderT());
            h->FILE_TYPE = std::string(1, loaded.sp3.pos_vel_flag);
            h->SATELLITE_SYSTEM = loaded.sp3.file_type;
            h->ORBIT_TYPE = loaded.sp3.orbit_type;
            h->DATA_USED = loaded.sp3.data_used;
            h->COORDINATE_SYSTEM = loaded.sp3.coordinate_sys;
            h->AGENCY = loaded.sp3.agency;
            h->TIME_SYSTEM = loaded.sp3.time_system;
            h->GPS_WEEK = static_cast<uint32_t>(loaded.sp3.gps_week);
            h->SECONDS_OF_WEEK = loaded.sp3.seconds_of_week;
            h->MODIFIED_JULIAN_DAY_START = loaded.sp3.mjd;
            h->FRACTIONAL_DAY = loaded.sp3.fractional_day;
            h->EPOCH_INTERVAL_SECONDS = loaded.sp3.epoch_interval;
            h->NUMBER_OF_EPOCHS = static_cast<uint32_t>(loaded.sp3.declared_num_epochs);
            h->POSITION_VELOCITY_BASE = loaded.sp3.base_pos_vel_sigma;
            h->CLOCK_RATE_BASE = loaded.sp3.base_clk_rate_sigma;
            for (const sp3::SatelliteBlock& sat : loaded.sp3.satellites) {
                h->SATELLITE_IDS.push_back(sat.sat_id);
                h->SATELLITE_ACCURACY_EXPONENTS.push_back(
                    static_cast<int8_t>(sat.accuracy_exponent));
            }
            h->COMMENT = loaded.sp3.comments;
            out->SP3_HEADER = std::move(h);
            break;
        }
        case ephem::Format::StkEphemeris: {
            const ephem::Series& s = loaded.series.front();
            out->FORMAT_VERSION = stk_banner(body, body_length);
            std::unique_ptr<NCDScenarioEpochContainerT> c(new NCDScenarioEpochContainerT());
            c->SCENARIO_EPOCH = s.epoch_zero_iso;
            c->TIME_SYSTEM = s.time_system;
            c->COORDINATE_SYSTEM = s.frame_name;
            c->CENTRAL_BODY = s.center_name;
            if (s.interp != ephem::Interp::Unknown) {
                c->INTERPOLATION_METHOD = ephem::interp_name(s.interp);
            }
            c->INTERPOLATION_SAMPLES_M1 =
                static_cast<uint32_t>(s.interp_degree > 0 ? s.interp_degree : 0);
            c->NUMBER_OF_EPHEMERIS_POINTS = static_cast<uint32_t>(s.rows.size());
            /* DISTANCE_UNIT and SEGMENT_BOUNDARY_TIMES stay unset: the reader
             * normalises the file's declared unit to kilometres on the way in
             * and carries no segmentation, so this module cannot state either
             * without re-parsing the text with a second parser. Writing
             * "Kilometers" here because that is what the SERIES holds would be
             * a claim about the FILE that the file may contradict. */
            out->SCENARIO_CONTAINER = std::move(c);
            break;
        }
        case ephem::Format::Code500: {
            const code500::Header& hdr = loaded.code500_header;
            std::unique_ptr<NCDCode500HeaderT> c(new NCDCode500HeaderT());
            c->SATELLITE_NAME = code500::trim(hdr.product_id);
            c->TAPE_ID = code500::trim(hdr.tape_id);
            c->TIME_SYSTEM_INDICATOR = code500::time_system_name(hdr.time_system_indicator);
            c->COORDINATE_SYSTEM_INDICATOR = hdr.coord_system_indicator_2;
            c->EPOCH_STEP_SECONDS = hdr.step_size_sec;
            int y = 0, m = 0, d = 0;
            if (decode_span_date(hdr.start_date_of_ephem_yyymmdd, hdr.year_format, &y, &m, &d)) {
                c->START_EPOCH = ephem::oem::iso_from_seconds(
                    code500::seconds_past_j2000(y, m, d, hdr.start_seconds_of_day));
            }
            if (decode_span_date(hdr.end_date_of_ephem_yyymmdd, hdr.year_format, &y, &m, &d)) {
                c->STOP_EPOCH = ephem::oem::iso_from_seconds(
                    code500::seconds_past_j2000(y, m, d, hdr.end_seconds_of_day));
            }
            /* HEADER_WORDS stays empty. The Code-500 header record is a grid of
             * 8-byte words of which many hold PACKED TEXT, and reinterpreting
             * those as doubles would put NaNs and denormals into the record —
             * values that mean nothing and that two WASM runtimes need not
             * agree on bit-for-bit. The named fields above carry what the
             * reader resolved, and `code500::Header` keeps the spares and the
             * harmonic blocks verbatim, so the byte-exact rewrite the schema
             * wants HEADER_WORDS for is already available to the writer. */
            out->CODE_500_HEADER = std::move(c);
            out->FORMAT_VERSION = code500::trim(hdr.orbit_theory);
            out->PRODUCER = code500::trim(hdr.source_id);
            break;
        }
        case ephem::Format::CcsdsOemKvn: {
            if (const kvn::Entry* e = kvn::find(loaded.oem.header, "CCSDS_OEM_VERS")) {
                out->FORMAT_VERSION = e->value;
            }
            if (const kvn::Entry* e = kvn::find(loaded.oem.header, "CREATION_DATE")) {
                out->CREATION_DATE = e->value;
            }
            if (const kvn::Entry* e = kvn::find(loaded.oem.header, "ORIGINATOR")) {
                out->ORIGINATOR = e->value;
            }
            /* Header COMMENT lines, in file order. The parser attaches a
             * comment to the entry it preceded and keeps a trailing one as an
             * entry of its own, so both shapes have to be walked or the
             * comment area comes out half-empty. */
            for (const kvn::Entry& e : loaded.oem.header) {
                for (const std::string& c : e.comments_before) out->COMMENT_AREA.push_back(c);
                if (e.is_standalone_comment) out->COMMENT_AREA.push_back(e.value);
            }
            break;
        }
        case ephem::Format::Auto:
            break;
    }
}

/* ------------------------------------------------------------------------ */
/* Errors                                                                    */
/* ------------------------------------------------------------------------ */

/*
 * A container that will not read is a NAMED status, never a trap and never a
 * NaN: `ephem::Status` distinguishes a truncated file from an unsupported
 * segment type from a buffer that was never this format, and a caller can only
 * decide whether to retry, skip or refuse if it is told which.
 */
int32_t fail_with_status(ephem::Status status, const char* what) {
    char message[320];
    std::snprintf(message, sizeof(message), "%s: %s.", what, ephem::status_name(status));
    plugin_set_error(ephem::status_name(status), message);
    return status == ephem::Status::Truncated || status == ephem::Status::Malformed ||
                   status == ephem::Status::BadMagic ||
                   status == ephem::Status::UnsupportedVariant ||
                   status == ephem::Status::NotEnoughStates
               ? 400
               : 500;
}

int32_t load_from_frame(const char* method, ContainerFrame* frame, Loaded* loaded) {
    const int32_t rc = decode_container_frame(method, frame);
    if (rc != 0) return rc;

    ephem::Format requested = ephem::Format::Auto;
    const char* why = nullptr;
    if (!ephem_format_for(frame->descriptor->FORMAT(), &requested, &why)) {
        char message[320];
        std::snprintf(message, sizeof(message),
                      "The descriptor declares FORMAT %s, which this module does not read: %s.",
                      EnumNamencdContainerFormat(frame->descriptor->FORMAT()), why);
        plugin_set_error("unsupported-container-format", message);
        return 400;
    }

    const ephem::Status st =
        load_native(frame->body, frame->body_length, requested, loaded);
    if (st != ephem::Status::Ok) return fail_with_status(st, "The container could not be read");
    return 0;
}

int32_t push_descriptor(const Loaded& loaded, const ContainerFrame& frame) {
    NCDT descriptor;
    build_descriptor(loaded, frame.body, frame.body_length, frame.descriptor, &descriptor);

    ::flatbuffers::FlatBufferBuilder fbb(4096);
    fbb.FinishSizePrefixed(CreateNCD(fbb, &descriptor), NCDIdentifier());
    const int32_t pushed = plugin_push_output_ex(
        "descriptor", "NCD.fbs", "$NCD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "NCD", 0, 8,
        fbb.GetBufferPointer(), static_cast<uint32_t>(fbb.GetSize()));
    return pushed < 0 ? 500 : 0;
}

}  // namespace

extern "C" {

int read_container(void) {
    ContainerFrame frame;
    Loaded loaded;
    const int32_t rc = load_from_frame("read_container", &frame, &loaded);
    if (rc != 0) return rc;

    OEMT oem;
    const int32_t built = build_oem(loaded, &oem);
    if (built != 0) return built;

    ::flatbuffers::FlatBufferBuilder fbb(65536);
    fbb.FinishSizePrefixed(CreateOEM(fbb, &oem), OEMIdentifier());
    if (plugin_push_output_ex("ephemeris", "OEM.fbs", "$OEM",
                              PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OEM", 0, 8,
                              fbb.GetBufferPointer(),
                              static_cast<uint32_t>(fbb.GetSize())) < 0) {
        return 500;
    }

    /* The descriptor goes out with the states, always. A consumer that gets
     * only the $OEM has no way back to the container it came from, and the
     * writer downstream is then guessing at a header. */
    return push_descriptor(loaded, frame);
}

int describe_container(void) {
    ContainerFrame frame;
    Loaded loaded;
    const int32_t rc = load_from_frame("describe_container", &frame, &loaded);
    if (rc != 0) return rc;
    return push_descriptor(loaded, frame);
}

}  // extern "C"
