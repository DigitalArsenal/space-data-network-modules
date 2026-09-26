// analysis/epoch-state — the TLE-to-numerical handoff of the Evidence-Supported
// ASO Catalog whitepaper, section 5, as one pure-compute node.
//
// derive: aligned size-prefixed $MPE stream -> aligned size-prefixed $OEM
// stream, one single-row OEM per element set, plus a JSON report.
//
// Per element set:
//   1. SGP4 (Vallado 2020-07-13, WGS-72, opsmode 'i' — the same
//      implementation and constants as propagator/sgp4) evaluated at zero
//      elapsed time, near-Earth or deep-space as the elements require. Its
//      TEME position and velocity are used; the mean elements are never read
//      as osculating elements.
//   2. TEME -> GCRF at the same instant through the foundation/frames axis
//      engine (IAU 2006/2000A precession-nutation and the equation of the
//      equinoxes, all series from the vendored ERFA). TT comes from UTC via the
//      ERFA leap-second table; UT1 does not enter TEME -> GCRF. The velocity
//      includes the frame's rotation rate.
//   3. GCRF -> TEME round trip, refused outside the declared tolerance.
//   4. One $OEM: GCRF, UTC, one EPHEMERIS_DATA_LINE, lineage in COMMENT,
//      initial-condition uncertainty marked unknown.
//
// Output bytes depend only on the input bytes: no clock, no CREATION_DATE.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

using sdn::frames::Epoch;
using sdn::frames::Mat3;
using sdn::frames::Vec3;
using sdn::frames::norm;

constexpr double kTwoPi = 6.283185307179586476925286766559;
constexpr double kDegToRad = kTwoPi / 360.0;
// Days from the SGP4 epoch origin (1949 December 31 0h, JD 2433281.5) to the
// Unix epoch (JD 2440587.5).
constexpr double kSgp4EpochToUnixDays = 7306.0;
// Half-width of the central difference for the frame rotation rate. The
// shortest IAU 2000A nutation periods are days, so the truncation error is
// far below double rounding at this step.
constexpr double kRateHalfStepSeconds = 600.0;
// Declared round-trip tolerance, relative to the state magnitude.
constexpr double kRoundTripRelativeTolerance = 1e-12;
constexpr size_t kMaxListedFailures = 10000;

uint32_t read_u32le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

std::string format_double(double value) {
    if (!std::isfinite(value)) return "null";
    char buffer[40];
    std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    return buffer;
}

void append_json_string(std::string* out, const std::string& value) {
    out->push_back('"');
    for (unsigned char c : value) {
        switch (c) {
            case '"': *out += "\\\""; break;
            case '\\': *out += "\\\\"; break;
            case '\n': *out += "\\n"; break;
            case '\r': *out += "\\r"; break;
            case '\t': *out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char escaped[8];
                    std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
                    *out += escaped;
                } else {
                    out->push_back(static_cast<char>(c));
                }
        }
    }
    out->push_back('"');
}

// Proleptic Gregorian civil date from days since 1970-01-01.
void civil_from_days(int64_t z, int* year, int* month, int* day) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t y = yoe + era * 400;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    const int64_t d = doy - (153 * mp + 2) / 5 + 1;
    const int64_t m = mp < 10 ? mp + 3 : mp - 9;
    *year = static_cast<int>(y + (m <= 2 ? 1 : 0));
    *month = static_cast<int>(m);
    *day = static_cast<int>(d);
}

// The instant an $MPE EPOCH names, held as whole Unix days plus microseconds
// of day so the ISO label, the SGP4 epoch and the ERFA epoch are all derived
// from the same rounded value. Unix days are 86400 s, and a GP epoch is a UTC
// calendar instant, so the calendar fields are exact.
struct UtcInstant {
    int64_t unix_day = 0;
    int64_t micro_of_day = 0;
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0.0;
    std::string iso;
};

bool utc_instant_from_unix(double unix_seconds, UtcInstant* out) {
    if (!std::isfinite(unix_seconds)) return false;
    const double day_float = std::floor(unix_seconds / 86400.0);
    if (std::fabs(day_float) > 1.0e7) return false;
    int64_t unix_day = static_cast<int64_t>(day_float);
    int64_t micro = std::llround((unix_seconds - day_float * 86400.0) * 1.0e6);
    if (micro >= 86400000000LL) {
        unix_day += 1;
        micro -= 86400000000LL;
    }
    if (micro < 0) {
        unix_day -= 1;
        micro += 86400000000LL;
    }
    out->unix_day = unix_day;
    out->micro_of_day = micro;
    civil_from_days(unix_day, &out->year, &out->month, &out->day);
    const int64_t whole_seconds = micro / 1000000LL;
    const int64_t fraction = micro % 1000000LL;
    out->hour = static_cast<int>(whole_seconds / 3600);
    out->minute = static_cast<int>((whole_seconds / 60) % 60);
    out->second = static_cast<double>(whole_seconds % 60) + static_cast<double>(fraction) / 1.0e6;
    char iso[40];
    std::snprintf(iso, sizeof(iso), "%04d-%02d-%02dT%02d:%02d:%02lld.%06lldZ", out->year,
                  out->month, out->day, out->hour, out->minute,
                  static_cast<long long>(whole_seconds % 60), static_cast<long long>(fraction));
    out->iso = iso;
    return true;
}

// TT for a UTC instant. ERFA reports status +1 ("dubious year") before 1960,
// when UTC did not exist and TAI-UTC is taken as zero, and for years past the
// leap-second table; the instant is still usable for TEME -> GCRF (a second of
// time moves the precession-nutation matrix by ~1e-11 rad) and is flagged.
bool tt_from_utc(const UtcInstant& instant, Epoch* epoch, bool* dubious) {
    double utc1 = 0.0, utc2 = 0.0;
    const int dtf = eraDtf2d("UTC", instant.year, instant.month, instant.day, instant.hour,
                             instant.minute, instant.second, &utc1, &utc2);
    if (dtf != 0 && dtf != 1) return false;
    double tai1 = 0.0, tai2 = 0.0;
    const int tai = eraUtctai(utc1, utc2, &tai1, &tai2);
    if (tai != 0 && tai != 1) return false;
    if (eraTaitt(tai1, tai2, &epoch->tt1, &epoch->tt2) != 0) return false;
    epoch->ut11 = 0.0;
    epoch->ut12 = 0.0;
    *dubious = dtf == 1 || tai == 1;
    return true;
}

Mat3 subtract_scaled(const Mat3& a, const Mat3& b, double scale) {
    Mat3 out;
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) out.m[i][j] = (a.m[i][j] - b.m[i][j]) * scale;
    }
    return out;
}

struct DerivedState {
    Vec3 r_teme, v_teme;
    Vec3 r_gcrf, v_gcrf;
    double round_trip_position_km = 0.0;
    double round_trip_velocity_km_s = 0.0;
    bool dubious_time = false;
};

struct Failure {
    uint32_t index = 0;
    std::string entity_id;
    std::string reason;
    int sgp4_error = 0;
};

// Returns an empty string on success, or the refusal reason.
std::string derive_state(const MPE& mpe, const UtcInstant& instant, DerivedState* out,
                         int* sgp4_error) {
    *sgp4_error = 0;
    if (mpe.MEAN_ELEMENT_THEORY() != meanElementSource::SGP4) {
        return std::string("mean-element-theory-not-sgp4:") +
               EnumNamemeanElementSource(mpe.MEAN_ELEMENT_THEORY());
    }
    const double elements[] = {mpe.MEAN_MOTION(),   mpe.ECCENTRICITY(),      mpe.INCLINATION(),
                               mpe.RA_OF_ASC_NODE(), mpe.ARG_OF_PERICENTER(), mpe.MEAN_ANOMALY(),
                               mpe.BSTAR()};
    for (double value : elements) {
        if (!std::isfinite(value)) return "non-finite-element";
    }
    if (!(mpe.MEAN_MOTION() > 0.0)) return "non-positive-mean-motion";

    elsetrec satrec;
    std::memset(&satrec, 0, sizeof(satrec));
    const double sgp4_epoch = static_cast<double>(instant.unix_day) + kSgp4EpochToUnixDays +
                              static_cast<double>(instant.micro_of_day) / 86400.0e6;
    const char satn[9] = "00000";
    const bool initialized = SGP4Funcs::sgp4init(
        wgs72, 'i', satn, sgp4_epoch, mpe.BSTAR(), 0.0, 0.0, mpe.ECCENTRICITY(),
        mpe.ARG_OF_PERICENTER() * kDegToRad, mpe.INCLINATION() * kDegToRad,
        mpe.MEAN_ANOMALY() * kDegToRad, mpe.MEAN_MOTION() * kTwoPi / 1440.0,
        mpe.RA_OF_ASC_NODE() * kDegToRad, satrec);
    if (!initialized || satrec.error != 0) {
        *sgp4_error = satrec.error;
        return "sgp4-init";
    }
    double r[3], v[3];
    if (!SGP4Funcs::sgp4(satrec, 0.0, r, v) || satrec.error != 0) {
        *sgp4_error = satrec.error;
        return "sgp4-epoch";
    }
    out->r_teme = {r[0], r[1], r[2]};
    out->v_teme = {v[0], v[1], v[2]};
    if (!std::isfinite(norm(out->r_teme)) || !std::isfinite(norm(out->v_teme))) {
        return "sgp4-non-finite";
    }

    Epoch epoch;
    if (!tt_from_utc(instant, &epoch, &out->dubious_time)) return "utc-to-tt";
    Epoch before = epoch, after = epoch;
    before.tt2 -= kRateHalfStepSeconds / 86400.0;
    after.tt2 += kRateHalfStepSeconds / 86400.0;

    // R maps GCRF to TEME; Rdot is its time derivative (per second).
    const Mat3 R = sdn::frames::gcrfToTeme(epoch);
    const Mat3 Rdot = subtract_scaled(sdn::frames::gcrfToTeme(after),
                                      sdn::frames::gcrfToTeme(before),
                                      1.0 / (2.0 * kRateHalfStepSeconds));
    const Mat3 Rt = sdn::frames::transpose(R);

    // r_teme = R r_gcrf, v_teme = R v_gcrf + Rdot r_gcrf.
    out->r_gcrf = sdn::frames::apply(Rt, out->r_teme);
    out->v_gcrf = sdn::frames::apply(
        Rt, sdn::frames::sub(out->v_teme, sdn::frames::apply(Rdot, out->r_gcrf)));

    const Vec3 r_back = sdn::frames::apply(R, out->r_gcrf);
    const Vec3 v_back = sdn::frames::add(sdn::frames::apply(R, out->v_gcrf),
                                         sdn::frames::apply(Rdot, out->r_gcrf));
    out->round_trip_position_km = norm(sdn::frames::sub(r_back, out->r_teme));
    out->round_trip_velocity_km_s = norm(sdn::frames::sub(v_back, out->v_teme));
    if (out->round_trip_position_km > kRoundTripRelativeTolerance * norm(out->r_teme) ||
        out->round_trip_velocity_km_s > kRoundTripRelativeTolerance * norm(out->v_teme)) {
        return "round-trip-tolerance";
    }
    return "";
}

std::string lineage_comment(const std::string& entity_id, const UtcInstant& instant,
                            const DerivedState& state) {
    char round_trip[160];
    std::snprintf(round_trip, sizeof(round_trip),
                  "|dr|=%.3e km, |dv|=%.3e km/s (declared tolerance %.0e relative)",
                  state.round_trip_position_km, state.round_trip_velocity_km_s,
                  kRoundTripRelativeTolerance);
    std::string comment;
    comment += "TLE-seeded epoch state (derived). Parent: $MPE ENTITY_ID=";
    comment += entity_id;
    comment += " EPOCH=";
    comment += instant.iso;
    comment += " (UTC), MEAN_ELEMENT_THEORY=SGP4. ";
    comment += "SGP4: Vallado " SGP4Version ", WGS-72 constants, opsmode i, zero elapsed time; ";
    comment += "TEME output in km and km/s. ";
    comment += "Frame: TEME to GCRF at the same instant, IAU 2006/2000A precession-nutation and ";
    comment += "equation of the equinoxes (ERFA eraPnm06a, eraEe06a); TT from UTC via the ERFA ";
    comment += "leap-second table; velocity includes the frame rotation rate. ";
    if (state.dubious_time) {
        comment += "Time scale: epoch outside the ERFA leap-second table (TAI-UTC taken as ERFA ";
        comment += "reports it). ";
    }
    comment += "Round trip GCRF to TEME: ";
    comment += round_trip;
    comment += ". Force model: none applied; a numerical product propagating this state ";
    comment += "declares its own. BSTAR is an SGP4 drag-model parameter and is not mapped. ";
    comment += "Initial-condition uncertainty: unknown (Evidence-Supported ASO Catalog, section 5).";
    return comment;
}

void append_oem_frame(std::vector<uint8_t>* stream, const std::string& entity_id,
                      const UtcInstant& instant, const DerivedState& state) {
    ::flatbuffers::FlatBufferBuilder builder(1024);

    const auto object_id = builder.CreateString(entity_id);
    uint32_t norad = 0;
    if (entity_id.rfind("NORAD:", 0) == 0) {
        char* end = nullptr;
        const unsigned long parsed = std::strtoul(entity_id.c_str() + 6, &end, 10);
        if (end != nullptr && *end == '\0' && parsed <= 0xFFFFFFFFul) {
            norad = static_cast<uint32_t>(parsed);
        }
    }
    CATBuilder cat(builder);
    cat.add_OBJECT_ID(object_id);
    if (norad != 0) cat.add_NORAD_CAT_ID(norad);
    const auto object = cat.Finish();

    const auto frame_name = builder.CreateString("GCRF");
    const auto celestial = CreateCelestialFrameWrapper(builder, CelestialFrame::GCRF);
    const auto reference_frame =
        CreateRFM(builder, RFMUnion::CelestialFrameWrapper, celestial.Union(), 0, frame_name);

    const auto line_epoch = builder.CreateString(instant.iso);
    std::vector<::flatbuffers::Offset<ephemerisDataLine>> lines;
    lines.push_back(CreateephemerisDataLine(builder, line_epoch, state.r_gcrf.x, state.r_gcrf.y,
                                            state.r_gcrf.z, state.v_gcrf.x, state.v_gcrf.y,
                                            state.v_gcrf.z));

    const std::string comment = lineage_comment(entity_id, instant, state);
    const auto block = CreateephemerisDataBlockDirect(
        builder, comment.c_str(), object, "EARTH", reference_frame, nullptr, 0,
        timingStandard::UTC, instant.iso.c_str(), instant.iso.c_str(), instant.iso.c_str(),
        instant.iso.c_str(), nullptr, 0, 0.0, 6, nullptr, &lines, nullptr, nullptr, 0, 399);
    std::vector<::flatbuffers::Offset<ephemerisDataBlock>> blocks{block};
    const auto oem = CreateOEMDirect(builder, nullptr, 3.0, nullptr, "SDN epoch-state", &blocks);
    FinishSizePrefixedOEMBuffer(builder, oem);

    const uint8_t* bytes = builder.GetBufferPointer();
    stream->insert(stream->end(), bytes, bytes + builder.GetSize());
    // Keep every frame 8-byte aligned in the stream: a zero-length prefix is
    // the stream's padding convention.
    while (stream->size() % 8 != 0) stream->push_back(0);
}

// Refuse a surplus frame on a single-stream port instead of dropping it: the
// compiled flow runtime drains a node's queue port-blind (see
// foundation/omm-json and graph task modules-guest-nodes-drop-batched-frames).
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id) continue;
            if (std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
            std::snprintf(message, message_len,
                          "Single-stream input port \"%s\" carries more than one frame; the "
                          "surplus is refused rather than silently discarded.",
                          frame->port_id);
            return true;
        }
    }
    return false;
}

}  // namespace

extern "C" {

int derive(void) {
    char batch_message[256];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const int32_t input_index = plugin_find_input_index("elements", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame) {
        plugin_set_error("missing-elements-frame",
                         "derive requires an $MPE stream frame on port \"elements\".");
        return 400;
    }
    const uint8_t* data = frame->payload;
    const size_t length = data ? static_cast<size_t>(frame->payload_length) : 0u;

    std::vector<uint8_t> states;
    std::vector<Failure> failures;
    std::vector<uint8_t> scratch;
    uint32_t index = 0;
    uint32_t derived = 0;
    uint32_t dubious_time = 0;
    uint64_t failed = 0;
    double max_position = 0.0;
    double max_velocity = 0.0;

    size_t offset = 0;
    while (offset < length) {
        if (length - offset < 4) {
            plugin_set_error("malformed-stream",
                             "Trailing bytes after the last size-prefixed $MPE frame.");
            return 400;
        }
        const uint32_t frame_size = read_u32le(data + offset);
        offset += 4;
        if (frame_size == 0) continue;
        if (frame_size > length - offset) {
            plugin_set_error("malformed-stream",
                             "Size-prefixed $MPE frame overruns the stream payload.");
            return 400;
        }
        scratch.assign(data + offset - 4, data + offset + frame_size);
        offset += frame_size;

        const MPE* mpe = nullptr;
        if (frame_size >= 8) {
            ::flatbuffers::Verifier prefixed(scratch.data(), scratch.size());
            if (VerifySizePrefixedMPEBuffer(prefixed)) {
                mpe = GetSizePrefixedMPE(scratch.data());
            } else {
                scratch.erase(scratch.begin(), scratch.begin() + 4);
                ::flatbuffers::Verifier plain(scratch.data(), scratch.size());
                if (MPEBufferHasIdentifier(scratch.data()) && VerifyMPEBuffer(plain)) {
                    mpe = GetMPE(scratch.data());
                }
            }
        }
        if (!mpe) {
            plugin_set_error("invalid-mpe-frame", "Stream frame is not a valid $MPE FlatBuffer.");
            return 400;
        }

        const std::string entity_id = mpe->ENTITY_ID() ? mpe->ENTITY_ID()->str() : "";
        std::string reason;
        int sgp4_error = 0;
        UtcInstant instant;
        DerivedState state;
        if (entity_id.empty()) {
            reason = "missing-entity-id";
        } else if (!utc_instant_from_unix(mpe->EPOCH(), &instant)) {
            reason = "invalid-epoch";
        } else {
            reason = derive_state(*mpe, instant, &state, &sgp4_error);
        }

        if (reason.empty()) {
            append_oem_frame(&states, entity_id, instant, state);
            derived++;
            if (state.dubious_time) dubious_time++;
            if (state.round_trip_position_km > max_position) max_position = state.round_trip_position_km;
            if (state.round_trip_velocity_km_s > max_velocity) max_velocity = state.round_trip_velocity_km_s;
        } else {
            failed++;
            if (failures.size() < kMaxListedFailures) {
                failures.push_back({index, entity_id, reason, sgp4_error});
            }
        }
        index++;
    }

    std::string report = "{\"records\":";
    report += std::to_string(index);
    report += ",\"derived\":";
    report += std::to_string(derived);
    report += ",\"failed\":";
    report += std::to_string(failed);
    report += ",\"epochsOutsideLeapSecondTable\":";
    report += std::to_string(dubious_time);
    report += ",\"maxRoundTripPositionKm\":";
    report += format_double(max_position);
    report += ",\"maxRoundTripVelocityKmPerS\":";
    report += format_double(max_velocity);
    report += ",\"failures\":[";
    for (size_t i = 0; i < failures.size(); ++i) {
        if (i > 0) report += ",";
        report += "{\"index\":";
        report += std::to_string(failures[i].index);
        report += ",\"entityId\":";
        append_json_string(&report, failures[i].entity_id);
        report += ",\"reason\":";
        append_json_string(&report, failures[i].reason);
        report += ",\"sgp4Error\":";
        report += std::to_string(failures[i].sgp4_error);
        report += "}";
    }
    report += "]}";

    if (!states.empty() &&
        plugin_push_output_ex("states", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                              "OEM", 0, 8, states.data(), static_cast<uint32_t>(states.size())) < 0) {
        return 500;
    }
    if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                              nullptr, 0, 1, reinterpret_cast<const uint8_t*>(report.data()),
                              static_cast<uint32_t>(report.size())) < 0) {
        return 500;
    }
    return 0;
}

}  // extern "C"
