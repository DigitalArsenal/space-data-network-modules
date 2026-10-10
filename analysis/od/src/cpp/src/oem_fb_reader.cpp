/**
 * SDS $OEM FlatBuffer reader.
 *
 * Produces the common StateSeries in TEME from a published $OEM FlatBuffer, with
 * every per-sample numerical step identical to the KVN text parser
 * (oem_parser.cpp) so the SGP4 fit is byte-for-byte identical for the same state
 * vectors. See od/oem_fb_reader.h for the parity contract.
 *
 * This TU is isolated: it is the ONLY OD source that includes the generated SDS
 * $OEM header, so its flatc-emitted symbols/guards never collide with the
 * PIV/TAB headers included elsewhere (plugin_invoke_bridge.cpp). It exposes only
 * a plain-C++ surface (od::read_oem_flatbuffer); no FlatBuffers types leak.
 */

#include "od/oem_fb_reader.h"

#include "od/frame_transform.h"   // classify_frame, FrameKind, eci_j2000_to_teme, ecef_to_teme(_pos)
#include "od/meme_parser.h"       // iso_to_jd, EphemerisPoint
#include "od/state_series.h"      // StateSeries
#include "od/time_systems.h"      // time_system_to_utc, TimeConv

#include <algorithm>
#include <cstring>
#include <string>

// macOS <math.h> defines the legacy SVID matherr macros (DOMAIN/SING/OVERFLOW/
// …) which collide with generated enum identifiers (e.g. legacyCountryCode::SING
// via CAT). They are irrelevant here; undef before the generated headers. (This
// is a native-build hazard only; the emscripten/WASI sysroot has no such macros.)
#ifdef SING
#undef SING
#endif
#ifdef DOMAIN
#undef DOMAIN
#endif
#ifdef OVERFLOW
#undef OVERFLOW
#endif
#ifdef UNDERFLOW
#undef UNDERFLOW
#endif
#ifdef TLOSS
#undef TLOSS
#endif
#ifdef PLOSS
#undef PLOSS
#endif

// The generated SDS $OEM header (flat licensing/core layout). Pulls RFM, TIM,
// CAT, PPE. All types are in the global namespace.
#include "OEM_generated.h"

namespace od {

namespace {

std::string to_upper(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return s;
}

OEMSourceResult fail(const char* code, std::string message) {
    OEMSourceResult r;
    r.ok = false;
    r.error_code = code;
    r.error_message = std::move(message);
    return r;
}

// The frame token carried by an RFM union arm, e.g. "EME2000" / "TEME" / "ECEF".
// Returns "" when the union is unset/NONE. classify_frame normalises case/
// separators, so returning the raw EnumName token is sufficient.
std::string rfm_frame_token(const RFM* rfm) {
    if (rfm == nullptr) return std::string();
    switch (rfm->REFERENCE_FRAME_type()) {
        case RFMUnion::CelestialFrameWrapper:
            if (const auto* w = rfm->REFERENCE_FRAME_as_CelestialFrameWrapper())
                return EnumNameCelestialFrame(w->frame());
            break;
        case RFMUnion::SpacecraftFrameWrapper:
            if (const auto* w = rfm->REFERENCE_FRAME_as_SpacecraftFrameWrapper())
                return EnumNameSpacecraftFrame(w->frame());
            break;
        case RFMUnion::OrbitFrameWrapper:
            if (const auto* w = rfm->REFERENCE_FRAME_as_OrbitFrameWrapper())
                return EnumNameOrbitFrame(w->frame());
            break;
        case RFMUnion::CustomFrameWrapper:
            if (const auto* w = rfm->REFERENCE_FRAME_as_CustomFrameWrapper())
                return EnumNameCustomFrame(w->frame());
            break;
        default:
            break;
    }
    return std::string();
}

// Map the TIM timingStandard enum to the upper-case token time_system_to_utc
// expects. Mirrors the KVN path's supported set (UTC / GPS / TAI); everything
// else returns "" and fails closed just like an unsupported OEM TIME_SYSTEM.
std::string time_system_token(timingStandard ts) {
    switch (ts) {
        case timingStandard::UTC: return "UTC";
        case timingStandard::GPS: return "GPS";
        case timingStandard::TAI: return "TAI";
        default: return std::string();
    }
}

// Convert one source-frame state (r,v) at UTC jd into TEME, identically to the
// switch in parse_oem's data-line loop. has_vel=false rotates position only.
void to_teme(FrameKind fk, double jd, bool has_vel,
             double x, double y, double z, double vx, double vy, double vz,
             EphemerisPoint* pt) {
    const double r_in[3] = {x, y, z};
    const double v_in[3] = {vx, vy, vz};
    double r_out[3], v_out[3];
    switch (fk) {
        case FrameKind::Teme:
            pt->x = x; pt->y = y; pt->z = z;
            pt->vx = vx; pt->vy = vy; pt->vz = vz;
            break;
        case FrameKind::EciJ2000:
            eci_j2000_to_teme(jd, r_in, v_in, r_out, v_out);
            pt->x = r_out[0]; pt->y = r_out[1]; pt->z = r_out[2];
            pt->vx = v_out[0]; pt->vy = v_out[1]; pt->vz = v_out[2];
            break;
        case FrameKind::Ecef:
            if (has_vel) {
                ecef_to_teme(jd, r_in, v_in, r_out, v_out);
                pt->x = r_out[0]; pt->y = r_out[1]; pt->z = r_out[2];
                pt->vx = v_out[0]; pt->vy = v_out[1]; pt->vz = v_out[2];
            } else {
                ecef_to_teme_pos(jd, r_in, r_out);
                pt->x = r_out[0]; pt->y = r_out[1]; pt->z = r_out[2];
                pt->vx = 0.0; pt->vy = 0.0; pt->vz = 0.0;
            }
            break;
        case FrameKind::Unsupported:
            break;  // unreachable (validated by caller)
    }
}

}  // namespace

bool is_oem_flatbuffer(const uint8_t* buf, std::size_t len) {
    if (buf == nullptr || len < 8) return false;
    return OEMBufferHasIdentifier(buf);
}

OEMSourceResult read_oem_flatbuffer_source(const uint8_t* buf, std::size_t len) {
    OEMSourceResult result;
    SourceSeries& series = result.series;

    if (buf == nullptr || len < 8) {
        return fail("parse-failed", "$OEM FlatBuffer payload is empty.");
    }
    if (!OEMBufferHasIdentifier(buf)) {
        return fail("parse-failed",
                    "Input frame does not carry the \"$OEM\" file identifier.");
    }
    flatbuffers::Verifier verifier(buf, len);
    if (!VerifyOEMBuffer(verifier)) {
        return fail("parse-failed", "$OEM FlatBuffer failed verification.");
    }
    const OEM* oem = GetOEM(buf);
    const auto* blocks = oem ? oem->EPHEMERIS_DATA_BLOCK() : nullptr;
    if (blocks == nullptr || blocks->size() == 0) {
        return fail("parse-failed", "$OEM contained no EPHEMERIS_DATA_BLOCK.");
    }

    bool have_identity = false;
    FrameKind frame_kind = FrameKind::Unsupported;
    std::string time_upper;
    int segment_count = 0;
    long full_state_lines = 0;
    long pos_only_lines = 0;

    for (flatbuffers::uoffset_t bi = 0; bi < blocks->size(); ++bi) {
        const ephemerisDataBlock* blk = blocks->Get(bi);
        if (blk == nullptr) continue;
        segment_count += 1;

        // ── Segment metadata validation (mirrors parse_oem's META_STOP block) ──
        const std::string frame = to_upper(rfm_frame_token(blk->REFERENCE_FRAME()));
        const std::string time_sys = time_system_token(blk->TIME_SYSTEM());
        const std::string center =
            to_upper(blk->CENTER_NAME() ? blk->CENTER_NAME()->str() : std::string());

        if (time_sys.empty()) {
            return fail("unsupported-time-system",
                        "$OEM segment TIME_SYSTEM is missing or unsupported "
                        "(UTC, GPS, TAI only).");
        }
        if (center.empty()) {
            return fail("parse-failed", "$OEM segment is missing CENTER_NAME.");
        }
        if (center != "EARTH") {
            return fail("unsupported-center",
                        "$OEM CENTER_NAME=" + center + " is not supported (EARTH only).");
        }
        if (frame.empty()) {
            return fail("parse-failed", "$OEM segment is missing REFERENCE_FRAME.");
        }
        const FrameKind fk = classify_frame(frame);
        if (fk == FrameKind::Unsupported) {
            return fail("unsupported-frame",
                        "$OEM REFERENCE_FRAME=" + frame +
                            " is not supported (TEME, EME2000/J2000/GCRF, or "
                            "ITRF/IGS20/ECEF only).");
        }

        // Identity from the first segment's OBJECT (CAT); later segments must
        // agree on OBJECT_ID and on frame/time-system (mirrors parse_oem).
        std::string seg_object_name, seg_object_id;
        int seg_norad = 0;
        if (const CAT* obj = blk->OBJECT()) {
            if (obj->OBJECT_NAME()) seg_object_name = obj->OBJECT_NAME()->str();
            if (obj->OBJECT_ID()) seg_object_id = obj->OBJECT_ID()->str();
            seg_norad = static_cast<int>(obj->NORAD_CAT_ID());
        }
        if (!have_identity) {
            series.meta.object_name = seg_object_name;
            series.meta.object_id = seg_object_id;
            series.meta.norad_cat_id = seg_norad;
            series.meta.center_name = center;
            series.meta.ref_frame = frame;
            series.meta.source_frame = frame;  // honest source frame (e.g. EME2000)
            series.meta.time_system = time_sys;
            frame_kind = fk;
            series.frame = fk;
            time_upper = time_sys;
            have_identity = true;
        } else if (!seg_object_id.empty() && !series.meta.object_id.empty() &&
                   seg_object_id != series.meta.object_id) {
            return fail("inconsistent-segments",
                        "$OEM segments mix OBJECT_ID " + series.meta.object_id +
                            " and " + seg_object_id + " in one buffer.");
        } else if (fk != frame_kind || time_sys != time_upper) {
            return fail("inconsistent-segments",
                        "$OEM segments mix reference frames or time systems.");
        }

        // ── State vectors ──────────────────────────────────────────────────────
        // Verbose form (EPHEMERIS_DATA_LINES, explicit EPOCH per state) is the
        // parity path (ISS EME2000). Compact form (EPHEMERIS_DATA + STEP_SIZE +
        // START_TIME) is reconstructed epoch[i] = START_TIME + i*STEP_SIZE.
        const auto* lines = blk->EPHEMERIS_DATA_LINES();
        const auto* compact = blk->EPHEMERIS_DATA();

        auto push_sample = [&](const std::string& epoch_tok, double x, double y,
                               double z, bool has_vel, double vx, double vy,
                               double vz) -> OEMSourceResult* {
            const double jd_decl = iso_to_jd(epoch_tok);
            if (jd_decl == 0.0) return nullptr;  // unparseable epoch: skip
            TimeConv tc = time_system_to_utc(time_upper, jd_decl);
            if (!tc.ok) {
                static OEMSourceResult err;
                err = fail(tc.error_code.c_str(), tc.error_message);
                return &err;
            }
            if (has_vel) full_state_lines++; else pos_only_lines++;
            SourceSample pt{};
            pt.epoch = epoch_tok;
            pt.jd_utc = tc.jd_utc;
            pt.r[0] = x; pt.r[1] = y; pt.r[2] = z;
            pt.v[0] = vx; pt.v[1] = vy; pt.v[2] = vz;
            pt.has_velocity = has_vel;
            pt.segment = segment_count - 1;
            series.samples.push_back(pt);
            return nullptr;
        };

        if (lines != nullptr && lines->size() > 0) {
            for (flatbuffers::uoffset_t li = 0; li < lines->size(); ++li) {
                const ephemerisDataLine* ln = lines->Get(li);
                if (ln == nullptr || ln->EPOCH() == nullptr) continue;
                // A full state carries velocity; the ISS/EME2000 fixture always
                // does. (Position-only verbose sources are handled via the
                // compact STATE_VECTOR_SIZE==3 path.)
                if (OEMSourceResult* e = push_sample(
                        ln->EPOCH()->str(), ln->X(), ln->Y(), ln->Z(),
                        /*has_vel=*/true, ln->X_DOT(), ln->Y_DOT(), ln->Z_DOT()))
                    return *e;
            }
        } else if (compact != nullptr && compact->size() > 0 && blk->STEP_SIZE() > 0.0) {
            const unsigned stride = blk->STATE_VECTOR_SIZE() ? blk->STATE_VECTOR_SIZE() : 6;
            if (stride != 3 && stride != 6 && stride != 9) {
                return fail("parse-failed",
                            "$OEM STATE_VECTOR_SIZE must be 3, 6, or 9.");
            }
            if (compact->size() % stride != 0) {
                return fail("parse-failed",
                            "$OEM EPHEMERIS_DATA length is not divisible by "
                            "STATE_VECTOR_SIZE.");
            }
            const double start_jd =
                blk->START_TIME() ? iso_to_jd(blk->START_TIME()->str()) : 0.0;
            if (start_jd == 0.0) {
                return fail("parse-failed",
                            "$OEM compact block is missing a parseable START_TIME.");
            }
            const double step_days = blk->STEP_SIZE() / 86400.0;
            const bool has_vel = (stride >= 6);
            const std::size_t nstates = compact->size() / stride;
            for (std::size_t i = 0; i < nstates; ++i) {
                const std::size_t o = i * stride;
                const double jd_decl = start_jd + static_cast<double>(i) * step_days;
                TimeConv tc = time_system_to_utc(time_upper, jd_decl);
                if (!tc.ok) return fail(tc.error_code.c_str(), tc.error_message);
                if (has_vel) full_state_lines++; else pos_only_lines++;
                SourceSample pt{};
                pt.epoch = blk->START_TIME()->str();
                pt.compact = true;
                pt.offset_s = static_cast<double>(i) * blk->STEP_SIZE();
                pt.jd_utc = tc.jd_utc;
                pt.r[0] = compact->Get(o + 0);
                pt.r[1] = compact->Get(o + 1);
                pt.r[2] = compact->Get(o + 2);
                pt.v[0] = has_vel ? compact->Get(o + 3) : 0.0;
                pt.v[1] = has_vel ? compact->Get(o + 4) : 0.0;
                pt.v[2] = has_vel ? compact->Get(o + 5) : 0.0;
                pt.has_velocity = has_vel;
                pt.segment = segment_count - 1;
                series.samples.push_back(pt);
            }
        } else {
            return fail("empty-ephemeris",
                        "$OEM block has neither EPHEMERIS_DATA_LINES nor a compact "
                        "EPHEMERIS_DATA+STEP_SIZE.");
        }
    }

    if (!have_identity || segment_count == 0) {
        return fail("parse-failed", "$OEM contained no valid ephemeris segment.");
    }
    if (series.samples.empty()) {
        return fail("empty-ephemeris", "$OEM contained no parseable state vectors.");
    }

    series.meta.position_only = (full_state_lines == 0 && pos_only_lines > 0);
    series.meta.segment_count = segment_count;
    result.ok = true;
    return result;
}

OEMParseResult read_oem_flatbuffer(const uint8_t* buf, std::size_t len) {
    OEMSourceResult source = read_oem_flatbuffer_source(buf, len);
    OEMParseResult result;
    if (!source.ok) {
        result.error_code = std::move(source.error_code);
        result.error_message = std::move(source.error_message);
        return result;
    }
    StateSeries& series = result.series;
    series.meta = source.series.meta;
    series.meta.ref_frame = "TEME";
    series.samples.reserve(source.series.samples.size());
    for (const SourceSample& s : source.series.samples) {
        EphemerisPoint pt{};
        pt.epoch_jd = s.jd_utc;
        pt.timestamp_str = s.compact ? jd_to_iso_supgp(s.jd_utc) : s.epoch;
        pt.has_covariance = false;
        to_teme(source.series.frame, s.jd_utc, s.has_velocity, s.r[0], s.r[1], s.r[2],
                s.v[0], s.v[1], s.v[2], &pt);
        series.samples.push_back(pt);
    }
    result.ok = true;
    return result;
}

}  // namespace od
