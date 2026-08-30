/*
 * data-source/spk-source — the ephemeris-source propagator.
 *
 * ONE MODULE, FOUR CONTAINERS, ONE PORT
 *
 * This is the provider that makes "propagate from a file" a propagator rather
 * than a special case. It reads SPK (DAF types 8, 9, 13), Code-500, STK
 * ephemeris and CCSDS-OEM behind a format discriminator and answers the SAME
 * `plugin_propagate` / `plugin_propagate_batch` the SGP4 and numerical
 * providers answer, so a consumer that can drive one can drive this with no
 * branch of its own. That is the owner law of 2026-07-29 applied to the one
 * family that most invites a bypass: a file already contains the answer, so it
 * is tempting to read it in the consumer and skip the port entirely — which is
 * how you end up with a JavaScript propagator.
 *
 * It is one module and not four because format is DATA, not identity. The
 * interpolation, the epoch handling and the state assembly are shared across
 * every container; four artifacts would be four parity envelopes for one
 * behaviour and four places for SPK and STK to disagree about the same Hermite
 * window. The directory is named `spk-source` because that is the scope path
 * the task declares; the module is `ephemeris-propagator` and reads all four.
 *
 * ENTRY IS `plugin_init_ephemeris`, NOT `plugin_init`
 *
 * `plugin_init` is bound by the ABI to a packed array of OrbProOMMRecord and
 * must refuse any length that is not a whole multiple of that struct. A DAF is
 * not a sequence of OMM records, so this module does not export `plugin_init`
 * at all rather than exporting a lie. `plugin_init_ephemeris(bytes, len,
 * format)` is the verb added for exactly this, and `isCompatible` on the
 * consumer side accepts it as a peer.
 *
 * TIME
 *
 * `julian_date` is interpreted on the CONTAINER'S OWN declared time scale.
 * This module carries no leap-second table and performs no scale conversion:
 * `foundation/time` owns that table and measures it, and a second copy here is
 * the drift this stack keeps paying for. The convention is safe for what this
 * module is asked to prove because every acceptance number is DIFFERENTIAL —
 * propagation against direct interpolation of the same file, and four
 * containers of one trajectory against each other. A consumer mixing scales
 * normalises upstream through the time module, which is where a leap second is
 * a measured fact rather than an assumption.
 *
 * FRAMES
 *
 * The state exits in the container's own declared frame with
 * `reference_frame` SET to say which, through
 * `orbpro_state_set_reference_frame()` so the struct's padding cannot go
 * stale. Rotating a J2000 kernel to ECEF so the consumer can rotate it
 * straight back would add two interpolated rotations to an answer that was
 * already exact, and would need a second copy of the IAU series inside this
 * module. A container whose declared frame has no member on the ABI roster is
 * a refusal, never a guess.
 *
 * UNITS
 *
 * The readers speak kilometres because $OEM's IDL fixes that; the propagator
 * ABI is NORMATIVE METRES. The conversion happens once, here, at the boundary.
 */

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

/* ------------------------------------------------------------------------ */
/* Loaded state                                                              */
/* ------------------------------------------------------------------------ */

namespace {

/* One loaded container. `entity` indices are positions in this vector, which
 * is what `plugin_entity_count` reports and what `plugin_propagate` indexes —
 * an SPK with many bodies yields one entry per body, an OEM one per data
 * block, so a multi-object file is many entities rather than a hidden choice
 * of which object the caller meant. */
struct Entity {
    ephem::Series series;
    uint8_t abi_frame = ORBPRO_FRAME_J2000;
};

std::vector<Entity>* g_entities = nullptr;

/*
 * Map a container's declared frame NAME onto the ABI roster. By named token,
 * never by ordinal: `ECI == 0`, `TEME == 0` and `FIXED == 0` collide across the
 * five ReferenceFrame vocabularies that meet at this seam, so a numeric
 * passthrough is wrong in a way that looks right for Earth-centred inertial
 * cases and silently wrong for everything else.
 *
 * Returns false for a frame with no roster member. That is a refusal: guessing
 * a frame is the one error whose magnitude is a full Earth rotation.
 */
bool abi_frame_for(const std::string& name, uint8_t* out) {
    struct Row { const char* name; uint8_t frame; };
    static const Row kRows[] = {
        {"EME2000", ORBPRO_FRAME_J2000},
        {"J2000", ORBPRO_FRAME_J2000},
        {"ICRF", ORBPRO_FRAME_ICRF},
        {"GCRF", ORBPRO_FRAME_ICRF},
        {"TEME", ORBPRO_FRAME_TEME},
        {"TEME_OF_DATE", ORBPRO_FRAME_TEME},
        {"ITRF", ORBPRO_FRAME_ECEF},
        {"ITRF93", ORBPRO_FRAME_ECEF},
        {"ITRF2000", ORBPRO_FRAME_ECEF},
        {"ITRF2008", ORBPRO_FRAME_ECEF},
        {"ITRF2014", ORBPRO_FRAME_ECEF},
        {"ITRF2020", ORBPRO_FRAME_ECEF},
        {"IGS20", ORBPRO_FRAME_ECEF},
        {"IGB14", ORBPRO_FRAME_ECEF},
        {"EARTH_FIXED", ORBPRO_FRAME_ECEF},
        {"ECEF", ORBPRO_FRAME_ECEF},
        {"ECF", ORBPRO_FRAME_ECEF},
        {"FIXED", ORBPRO_FRAME_ECEF},
        {"GRC", ORBPRO_FRAME_ECEF},
        {"TOD", ORBPRO_FRAME_TOD},
        {"MOD", ORBPRO_FRAME_MOD},
        {"TDR", ORBPRO_FRAME_ECEF},
        /* Code-500 declares its frame in a FOUR-CHARACTER field, so the
         * container's J2000 tag is literally "2000" and its earth-fixed tag is
         * "EFI " — the format cannot spell "J2000" at all. Without these two
         * rows every Code-500 file this module can otherwise read is refused as
         * an unknown frame, which is a wrong refusal rather than a safe one.
         * "MEAN" (mean of B1950) and "INER" (true of reference) are deliberately
         * absent: neither has a member on the ABI roster, and this table names
         * frames rather than approximating them. */
        {"2000", ORBPRO_FRAME_J2000},
        {"EFI", ORBPRO_FRAME_ECEF},
    };
    /* Case-insensitive: containers are inconsistent about it and a case
     * mismatch is not a different frame. */
    std::string upper;
    upper.reserve(name.size());
    for (char c : name) {
        upper.push_back(c >= 'a' && c <= 'z' ? static_cast<char>(c - 32) : c);
    }
    for (const Row& r : kRows) {
        if (upper == r.name) {
            *out = r.frame;
            return true;
        }
    }
    /* A DAF frame code the file resolved through a loaded frame kernel we do
     * not have is honestly SPICE_DEFINED: the kernel declared it, we carry the
     * declaration, and we do not pretend to know its orientation. */
    if (upper.rfind("SPICE:", 0) == 0) {
        *out = ORBPRO_FRAME_SPICE_DEFINED;
        return true;
    }
    return false;
}

/* Julian date -> the container's own epoch axis. SPK stores ET seconds past
 * the J2000 epoch, so its rows are already absolute on that axis; a container
 * with an ISO zero point stores seconds from that point, and the zero point's
 * own Julian date is computed once at load. */
double container_epoch(const ephem::Series& s, double julian_date) {
    return (julian_date - 2451545.0) * 86400.0 - s.epoch_zero_offset_sec;
}

}  // namespace

/* ------------------------------------------------------------------------ */
/* Record surface                                                            */
/* ------------------------------------------------------------------------ */

namespace {

/*
 * `describe_ephemeris` is the record-shaped view of what this module resolved:
 * an $OEM in, an $OEM out with the frame, centre, time system, interpolation
 * rule and degree filled in AS THIS MODULE READS THEM.
 *
 * It exists because the propagation entry point is an ABI export carrying raw
 * container bytes, which has no SDS port identity to declare — so without this
 * there would be no way to ask the module what it thinks a trajectory says
 * without propagating it. It is also the honest place to see a disagreement:
 * if the module resolved a different interpolation rule than the producer
 * intended, it says so here rather than only in the numbers.
 *
 * Native containers reach this surface once the native-container descriptor
 * record lands (upstream-spacedatastandards-10); until then the input is $OEM,
 * which is the one container that already HAS a record.
 */
int32_t describe_impl() {
    const int32_t input_index = plugin_find_input_index("ephemeris", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-ephemeris-frame",
                         "describe_ephemeris requires an $OEM frame on port \"ephemeris\".");
        return 400;
    }

    /* Copy before decoding: FlatBuffers built size-prefixed align their
     * 8-byte scalars counting the prefix, so the buffer must sit at an
     * allocator-aligned address for the accessors to read it correctly. */
    std::vector<uint8_t> scratch(frame->payload, frame->payload + frame->payload_length);

    const OEM* record = nullptr;
    ::flatbuffers::Verifier prefixed(scratch.data(), scratch.size());
    if (::flatbuffers::BufferHasIdentifier(scratch.data(), OEMIdentifier(), true) &&
        VerifySizePrefixedOEMBuffer(prefixed)) {
        record = GetSizePrefixedOEM(scratch.data());
    } else {
        ::flatbuffers::Verifier plain(scratch.data(), scratch.size());
        if (::flatbuffers::BufferHasIdentifier(scratch.data(), OEMIdentifier()) &&
            VerifyOEMBuffer(plain)) {
            record = GetOEM(scratch.data());
        }
    }
    if (!record) {
        plugin_set_error("bad-oem", "The ephemeris frame is not a verifiable $OEM buffer.");
        return 400;
    }

    OEMT out;
    out.CCSDS_OEM_VERS = record->CCSDS_OEM_VERS();
    if (record->CREATION_DATE()) out.CREATION_DATE = record->CREATION_DATE()->str();
    if (record->ORIGINATOR()) out.ORIGINATOR = record->ORIGINATOR()->str();

    const auto* blocks = record->EPHEMERIS_DATA_BLOCK();
    const ::flatbuffers::uoffset_t block_count = blocks ? blocks->size() : 0u;
    for (::flatbuffers::uoffset_t b = 0; b < block_count; ++b) {
        const ephemerisDataBlock* in = blocks->Get(b);
        if (!in) continue;

        ephem::Series s;
        if (in->CENTER_NAME()) s.center_name = in->CENTER_NAME()->str();
        if (in->INTERPOLATION()) {
            s.interp = ephem::oem_kvn::interp_from_name(in->INTERPOLATION()->str());
        }
        s.interp_degree = static_cast<int>(in->INTERPOLATION_DEGREE());

        const auto* lines = in->EPHEMERIS_DATA_LINES();
        if (lines) {
            for (::flatbuffers::uoffset_t i = 0; i < lines->size(); ++i) {
                const ephemerisDataLine* l = lines->Get(i);
                if (!l) continue;
                ephem::StateRow r;
                if (l->EPOCH() && !ephem::oem_kvn::iso_to_seconds(l->EPOCH()->str(), &r.epoch)) {
                    plugin_set_error("bad-epoch",
                                     "An EPHEMERIS_DATA_LINES row carries an unreadable EPOCH.");
                    return 400;
                }
                r.pos[0] = l->X(); r.pos[1] = l->Y(); r.pos[2] = l->Z();
                r.vel[0] = l->X_DOT(); r.vel[1] = l->Y_DOT(); r.vel[2] = l->Z_DOT();
                r.has_vel = true;
                if (!ephem::row_is_finite(r)) {
                    plugin_set_error("non-finite-state",
                                     "An EPHEMERIS_DATA_LINES row is not finite.");
                    return 400;
                }
                s.rows.push_back(r);
            }
        }

        std::unique_ptr<ephemerisDataBlockT> ob(new ephemerisDataBlockT());
        ob->CENTER_NAME = s.center_name;
        /* Report the rule this module WILL use, which is the container's when
         * it declared one and the fallback when it did not — saying "Unknown"
         * back to a caller that asked what we resolved would answer nothing. */
        ephem::Interp effective = s.interp;
        if (effective == ephem::Interp::Unknown) {
            effective = s.all_have_velocity() ? ephem::Interp::Hermite : ephem::Interp::Lagrange;
        }
        ob->INTERPOLATION = ephem::interp_name(effective);
        ob->INTERPOLATION_DEGREE =
            static_cast<uint32_t>(s.interp_degree > 0 ? s.interp_degree : 7);
        ob->STATE_VECTOR_SIZE = 6;

        double step = 0.0;
        const bool uniform = s.uniform_step(&step);
        ob->STEP_SIZE = uniform ? step : 0.0;
        if (!s.rows.empty()) {
            ob->START_TIME = ephem::oem::iso_from_seconds(s.rows.front().epoch);
            ob->STOP_TIME = ephem::oem::iso_from_seconds(s.rows.back().epoch);
        }
        for (const ephem::StateRow& r : s.rows) {
            std::unique_ptr<ephemerisDataLineT> ol(new ephemerisDataLineT());
            ol->EPOCH = ephem::oem::iso_from_seconds(r.epoch);
            ol->X = r.pos[0]; ol->Y = r.pos[1]; ol->Z = r.pos[2];
            ol->X_DOT = r.vel[0]; ol->Y_DOT = r.vel[1]; ol->Z_DOT = r.vel[2];
            ob->EPHEMERIS_DATA_LINES.push_back(std::move(ol));
        }
        out.EPHEMERIS_DATA_BLOCK.push_back(std::move(ob));
    }

    ::flatbuffers::FlatBufferBuilder fbb(4096);
    fbb.FinishSizePrefixed(CreateOEM(fbb, &out), OEMIdentifier());

    const int32_t pushed = plugin_push_output_ex(
        "summary", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 8, 1,
        fbb.GetBufferPointer(), static_cast<uint32_t>(fbb.GetSize()));
    return pushed < 0 ? 500 : 0;
}

}  // namespace

extern "C" {

int describe_ephemeris(void) { return describe_impl(); }

}  // extern "C"

/* ------------------------------------------------------------------------ */
/* Propagator ABI                                                            */
/* ------------------------------------------------------------------------ */

extern "C" {

__attribute__((export_name("plugin_init_ephemeris")))
int32_t plugin_init_ephemeris(const uint8_t* bytes, size_t len, uint32_t format) {
    if (!bytes || len == 0) return ORBPRO_PROP_BAD_INPUT;

    if (!g_entities) g_entities = new std::vector<Entity>();
    g_entities->clear();

    std::vector<ephem::Series> series;
    const ephem::Status st = ephem::load_container(
        bytes, len, static_cast<ephem::Format>(format), &series);
    if (st != ephem::Status::Ok) {
        return st == ephem::Status::BadMagic || st == ephem::Status::UnsupportedVariant
                   ? ORBPRO_PROP_UNSUPPORTED_FORMAT
                   : ORBPRO_PROP_BAD_INPUT;
    }
    if (series.empty()) return ORBPRO_PROP_BAD_INPUT;

    for (ephem::Series& s : series) {
        Entity e;
        if (!abi_frame_for(s.frame_name, &e.abi_frame)) {
            /* Refuse the whole load rather than admitting one entity in an
             * unknown frame: a partially-loaded propagator answers some
             * indices correctly and others wrongly, which is worse than
             * answering none. */
            g_entities->clear();
            return ORBPRO_PROP_UNSUPPORTED_FORMAT;
        }
        e.series = s;
        g_entities->push_back(e);
    }
    return static_cast<int32_t>(g_entities->size());
}

__attribute__((export_name("plugin_entity_count")))
int32_t plugin_entity_count(void) {
    return g_entities ? static_cast<int32_t>(g_entities->size()) : 0;
}

__attribute__((export_name("plugin_propagate")))
int32_t plugin_propagate(double julian_date, uint32_t entity_index, OrbProStateVector* out) {
    if (!g_entities || g_entities->empty()) return ORBPRO_PROP_NOT_INITIALIZED;
    if (!out) return ORBPRO_PROP_NULL_OUTPUT;
    if (entity_index >= g_entities->size()) return ORBPRO_PROP_BAD_ENTITY_INDEX;

    const Entity& e = (*g_entities)[entity_index];
    ephem::StateRow row;
    const ephem::Status st =
        ephem::evaluate(e.series, container_epoch(e.series, julian_date), &row);
    if (st == ephem::Status::OutOfRange) return ORBPRO_PROP_EPOCH_OUT_OF_RANGE;
    if (st != ephem::Status::Ok) return ORBPRO_PROP_BAD_INPUT;

    /* A non-finite result is a refusal, not an output. Wasm does not
     * canonicalize NaN payloads across producing operations, so a NaN that
     * escaped here would compare unequal to itself in one runtime and equal in
     * another — a parity failure on a value that means nothing. */
    if (!ephem::row_is_finite(row)) return ORBPRO_PROP_UNPHYSICAL;

    orbpro_state_init(out);
    out->epoch = julian_date;
    for (int c = 0; c < 3; ++c) {
        out->position[c] = row.pos[c] * 1000.0; /* km -> METRES, ABI normative */
        out->velocity[c] = row.vel[c] * 1000.0;
    }
    orbpro_state_set_reference_frame(out, static_cast<OrbProReferenceFrame>(e.abi_frame));
    out->flags = ORBPRO_STATE_VALID;
    return 0;
}

__attribute__((export_name("plugin_propagate_batch")))
int32_t plugin_propagate_batch(double julian_date, OrbProStateVector* out, uint32_t count) {
    if (!g_entities || g_entities->empty()) return ORBPRO_PROP_NOT_INITIALIZED;
    if (!out) return ORBPRO_PROP_NULL_OUTPUT;
    if (count > g_entities->size()) return ORBPRO_PROP_BAD_ENTITY_INDEX;

    /* SHARD WRITE DISCIPLINE: write only the rows we own, and on a per-entity
     * failure zero THAT row rather than abandoning the buffer half-written.
     * A caller reading a partially-written batch cannot tell a stale row from
     * a fresh one, so an untouched row is indistinguishable from a wrong
     * answer. The batch and the single-entity call must agree exactly, so this
     * calls straight through rather than reimplementing the evaluation. */
    for (uint32_t i = 0; i < count; ++i) {
        const int32_t rc = plugin_propagate(julian_date, i, &out[i]);
        if (rc != 0) {
            orbpro_state_init(&out[i]);
            out[i].epoch = julian_date;
            out[i].flags = ORBPRO_STATE_NONE;
        }
    }
    return 0;
}

__attribute__((export_name("plugin_destroy")))
void plugin_destroy(void) {
    /* Really releases, and is idempotent: entity_count reads 0 afterwards and
     * a following init works on a clean slate. A destroy that only marks a
     * flag leaves the next load measuring the previous one's memory. */
    delete g_entities;
    g_entities = nullptr;
}

}  // extern "C"
