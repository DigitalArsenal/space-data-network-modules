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
//
// derive_omm: the same derivation for $OMM element sets (what element-set
// sources publish), with the object identity of the $OMM carried into the
// $OEM. Both methods take an optional `options` frame, {"ages": [days...]}:
// one row per age, SGP4 propagated forward from the element set's epoch
// (default [0], the epoch state alone).
//
// answer_propagation_requests: SGP4 answers the propagator query port of
// analysis/maneuver-detection (its `propagation_requests`): per query, the
// trajectory of one element set in TEME from the query's start to its stop,
// one $OEM per query in query order, so a flow can plug SGP4 into the
// detector's second pass. The element sets and options are forwarded
// unchanged, so the second pass sees exactly what the first pass saw.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

using Json = nlohmann::json;
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

// The instant at `micro_of_day` microseconds into Unix day `unix_day`; either
// may be out of range and is carried into the other.
bool utc_instant_from_parts(int64_t unix_day, int64_t micro_of_day, UtcInstant* out) {
    constexpr int64_t kMicrosPerDay = 86400000000LL;
    if (micro_of_day >= kMicrosPerDay || micro_of_day < 0) {
        int64_t carry = micro_of_day / kMicrosPerDay;
        if (micro_of_day % kMicrosPerDay < 0) carry -= 1;
        unix_day += carry;
        micro_of_day -= carry * kMicrosPerDay;
    }
    if (unix_day > 10000000LL || unix_day < -10000000LL) return false;
    out->unix_day = unix_day;
    out->micro_of_day = micro_of_day;
    civil_from_days(unix_day, &out->year, &out->month, &out->day);
    const int64_t whole_seconds = micro_of_day / 1000000LL;
    const int64_t fraction = micro_of_day % 1000000LL;
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

bool utc_instant_from_unix(double unix_seconds, UtcInstant* out) {
    if (!std::isfinite(unix_seconds)) return false;
    const double day_float = std::floor(unix_seconds / 86400.0);
    if (std::fabs(day_float) > 1.0e7) return false;
    const int64_t unix_day = static_cast<int64_t>(day_float);
    const int64_t micro = std::llround((unix_seconds - day_float * 86400.0) * 1.0e6);
    return utc_instant_from_parts(unix_day, micro, out);
}

int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

// "YYYY-MM-DDTHH:MM:SS[.ffffff][Z]" as UTC, to the microsecond.
bool utc_instant_from_iso(const std::string& text, UtcInstant* out) {
    int y = 0, mo = 0, d = 0, h = 0, mi = 0;
    double sec = 0.0;
    if (std::sscanf(text.c_str(), "%4d-%2d-%2d%*c%2d:%2d:%lf", &y, &mo, &d, &h, &mi, &sec) != 6) return false;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59 ||
        !(sec >= 0.0 && sec < 61.0)) {
        return false;
    }
    const int64_t micro = static_cast<int64_t>(h) * 3600000000LL + static_cast<int64_t>(mi) * 60000000LL +
                          std::llround(sec * 1.0e6);
    return utc_instant_from_parts(days_from_civil(y, static_cast<unsigned>(mo), static_cast<unsigned>(d)), micro, out);
}

// Microseconds since 1970-01-01T00:00:00 UTC (the calendar-day count; leap seconds are not counted).
int64_t unix_micros(const UtcInstant& instant) { return instant.unix_day * 86400000000LL + instant.micro_of_day; }

bool utc_instant_from_unix_micros(int64_t micros, UtcInstant* out) {
    constexpr int64_t kMicrosPerDay = 86400000000LL;
    int64_t day = micros / kMicrosPerDay;
    int64_t rest = micros - day * kMicrosPerDay;
    if (rest < 0) {
        day -= 1;
        rest += kMicrosPerDay;
    }
    return utc_instant_from_parts(day, rest, out);
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

// One element set, whichever message carried it. Elements as the messages
// state them: mean motion in rev/day, angles in degrees, B* in 1/earth radii.
struct ElementInput {
    std::string entity_id;     // the $OEM OBJECT_ID: "NORAD:<n>", else the set's own identity
    std::string parent;        // lineage: the message and identity the set came from
    std::string object_name;   // $OMM only
    uint32_t norad = 0;
    UtcInstant instant;        // the set's epoch
    meanElementSource theory = meanElementSource::SGP4;
    double mean_motion = 0, eccentricity = 0, inclination = 0, raan = 0, argp = 0, mean_anomaly = 0, bstar = 0;
};

// Returns an empty string on success, or the refusal reason. `at` is the
// row's instant and `tsince_minutes` its elapsed time from the set's epoch.
std::string derive_state(const ElementInput& in, const UtcInstant& at, double tsince_minutes,
                         DerivedState* out, int* sgp4_error) {
    *sgp4_error = 0;
    if (in.theory != meanElementSource::SGP4) {
        return std::string("mean-element-theory-not-sgp4:") + EnumNamemeanElementSource(in.theory);
    }
    const double elements[] = {in.mean_motion, in.eccentricity, in.inclination, in.raan,
                               in.argp,        in.mean_anomaly, in.bstar};
    for (double value : elements) {
        if (!std::isfinite(value)) return "non-finite-element";
    }
    if (!(in.mean_motion > 0.0)) return "non-positive-mean-motion";

    elsetrec satrec;
    std::memset(&satrec, 0, sizeof(satrec));
    const double sgp4_epoch = static_cast<double>(in.instant.unix_day) + kSgp4EpochToUnixDays +
                              static_cast<double>(in.instant.micro_of_day) / 86400.0e6;
    const char satn[9] = "00000";
    const bool initialized = SGP4Funcs::sgp4init(
        wgs72, 'i', satn, sgp4_epoch, in.bstar, 0.0, 0.0, in.eccentricity,
        in.argp * kDegToRad, in.inclination * kDegToRad,
        in.mean_anomaly * kDegToRad, in.mean_motion * kTwoPi / 1440.0,
        in.raan * kDegToRad, satrec);
    if (!initialized || satrec.error != 0) {
        *sgp4_error = satrec.error;
        return "sgp4-init";
    }
    double r[3], v[3];
    if (!SGP4Funcs::sgp4(satrec, tsince_minutes, r, v) || satrec.error != 0) {
        *sgp4_error = satrec.error;
        return tsince_minutes == 0.0 ? "sgp4-epoch" : "sgp4-propagate";
    }
    out->r_teme = {r[0], r[1], r[2]};
    out->v_teme = {v[0], v[1], v[2]};
    if (!std::isfinite(norm(out->r_teme)) || !std::isfinite(norm(out->v_teme))) {
        return "sgp4-non-finite";
    }

    Epoch epoch;
    if (!tt_from_utc(at, &epoch, &out->dubious_time)) return "utc-to-tt";
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

// One derived row of an element set: its instant, its age from the set's
// epoch in days, and the state.
struct Row {
    UtcInstant at;
    double age_days = 0.0;
    DerivedState state;
};

std::string lineage_comment(const ElementInput& in, const std::vector<Row>& rows) {
    bool dubious = false;
    double round_trip_position = 0.0, round_trip_velocity = 0.0;
    for (const Row& row : rows) {
        dubious = dubious || row.state.dubious_time;
        round_trip_position = std::max(round_trip_position, row.state.round_trip_position_km);
        round_trip_velocity = std::max(round_trip_velocity, row.state.round_trip_velocity_km_s);
    }
    const bool epoch_only = rows.size() == 1 && rows[0].age_days == 0.0;
    char round_trip[160];
    std::snprintf(round_trip, sizeof(round_trip),
                  "|dr|=%.3e km, |dv|=%.3e km/s (declared tolerance %.0e relative)",
                  round_trip_position, round_trip_velocity, kRoundTripRelativeTolerance);
    std::string comment;
    comment += "TLE-seeded epoch state (derived). Parent: ";
    comment += in.parent;
    comment += " EPOCH=";
    comment += in.instant.iso;
    comment += " (UTC), MEAN_ELEMENT_THEORY=SGP4. ";
    comment += "SGP4: Vallado " SGP4Version ", WGS-72 constants, opsmode i, ";
    if (epoch_only) {
        comment += "zero elapsed time; ";
    } else {
        comment += "evaluated at the epoch plus the ages {";
        for (size_t i = 0; i < rows.size(); ++i) {
            if (i > 0) comment += ", ";
            comment += format_double(rows[i].age_days);
        }
        comment += "} days; ";
    }
    comment += "TEME output in km and km/s. ";
    comment += "Frame: TEME to GCRF at the same instant, IAU 2006/2000A precession-nutation and ";
    comment += "equation of the equinoxes (ERFA eraPnm06a, eraEe06a); TT from UTC via the ERFA ";
    comment += "leap-second table; velocity includes the frame rotation rate. ";
    if (dubious) {
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

void append_oem_frame(std::vector<uint8_t>* stream, const ElementInput& in, const std::vector<Row>& rows) {
    ::flatbuffers::FlatBufferBuilder builder(1024);

    const auto object_id = builder.CreateString(in.entity_id);
    const auto object_name = in.object_name.empty() ? ::flatbuffers::Offset<::flatbuffers::String>()
                                                    : builder.CreateString(in.object_name);
    CATBuilder cat(builder);
    cat.add_OBJECT_ID(object_id);
    if (!in.object_name.empty()) cat.add_OBJECT_NAME(object_name);
    if (in.norad != 0) cat.add_NORAD_CAT_ID(in.norad);
    const auto object = cat.Finish();

    const auto frame_name = builder.CreateString("GCRF");
    const auto celestial = CreateCelestialFrameWrapper(builder, CelestialFrame::GCRF);
    const auto reference_frame =
        CreateRFM(builder, RFMUnion::CelestialFrameWrapper, celestial.Union(), 0, frame_name);

    std::vector<::flatbuffers::Offset<ephemerisDataLine>> lines;
    for (const Row& row : rows) {
        const auto line_epoch = builder.CreateString(row.at.iso);
        lines.push_back(CreateephemerisDataLine(builder, line_epoch, row.state.r_gcrf.x, row.state.r_gcrf.y,
                                                row.state.r_gcrf.z, row.state.v_gcrf.x, row.state.v_gcrf.y,
                                                row.state.v_gcrf.z));
    }

    const std::string comment = lineage_comment(in, rows);
    const auto block = CreateephemerisDataBlockDirect(
        builder, comment.c_str(), object, "EARTH", reference_frame, nullptr, 0,
        timingStandard::UTC, rows.front().at.iso.c_str(), rows.front().at.iso.c_str(),
        rows.back().at.iso.c_str(), rows.back().at.iso.c_str(), nullptr, 0, 0.0, 6, nullptr, &lines, nullptr,
        nullptr, 0, 399);
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

// The `options` frame of derive and derive_omm: {"ages": [days, ...]}, the
// rows to evaluate at the epoch plus each age. Absent: the epoch alone.
constexpr size_t kMaxAges = 64;
constexpr double kMaxAgeDays = 400.0;

std::string read_ages(std::vector<double>* ages) {
    ages->assign(1, 0.0);
    const int32_t index = plugin_find_input_index("options", 0);
    const plugin_input_frame_t* frame =
        index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) return "";
    const Json options = Json::parse(frame->payload, frame->payload + frame->payload_length, nullptr, false);
    if (options.is_discarded() || !options.is_object()) return "The options frame is not a JSON object.";
    if (!options.contains("ages")) return "";
    const Json& list = options["ages"];
    if (!list.is_array() || list.empty() || list.size() > kMaxAges) {
        return "options.ages is an array of one to 64 ages in days.";
    }
    std::vector<double> parsed;
    for (const Json& value : list) {
        if (!value.is_number()) return "options.ages holds numbers.";
        const double age = value.get<double>();
        if (!(age >= 0.0 && age <= kMaxAgeDays)) return "Each age is between 0 and 400 days.";
        parsed.push_back(age);
    }
    std::sort(parsed.begin(), parsed.end());
    parsed.erase(std::unique(parsed.begin(), parsed.end()), parsed.end());
    *ages = parsed;
    return "";
}

// Calls `consume` with each size-prefixed record of a stream: [u32le size][buffer], zero-length
// prefixes being padding. The record includes its prefix.
template <class Verify, class Consume>
bool for_each_record(const plugin_input_frame_t* frame, Verify verify, Consume consume, std::string* error) {
    const uint8_t* data = frame->payload;
    const size_t length = data ? static_cast<size_t>(frame->payload_length) : 0u;
    size_t offset = 0;
    while (offset < length) {
        if (length - offset < 4) {
            *error = "Trailing bytes after the last size-prefixed frame.";
            return false;
        }
        const uint32_t size = read_u32le(data + offset);
        if (size == 0) {
            offset += 4;
            continue;
        }
        if (size > length - offset - 4) {
            *error = "A size-prefixed frame overruns the stream payload.";
            return false;
        }
        std::vector<uint8_t> record(data + offset, data + offset + 4 + size);
        offset += 4 + static_cast<size_t>(size);
        if (!verify(record)) {
            *error = "A stream frame is not a valid FlatBuffer of the port's type.";
            return false;
        }
        consume(record);
    }
    return true;
}

// The shared derivation. `next` yields the next element set, or false at the end.
struct DeriveTotals {
    uint32_t index = 0, derived = 0, dubious_time = 0, rows = 0;
    uint64_t failed = 0;
    double max_position = 0.0, max_velocity = 0.0;
    std::vector<Failure> failures;
    std::vector<uint8_t> states;
};

void derive_element(const ElementInput& in, const std::string& refusal, const std::vector<double>& ages,
                    DeriveTotals* totals) {
    std::string reason = refusal;
    int sgp4_error = 0;
    std::vector<Row> rows;
    if (reason.empty()) {
        for (double age : ages) {
            Row row;
            row.age_days = age;
            const int64_t offset_micros = std::llround(age * 86400.0e6);
            if (!utc_instant_from_unix_micros(unix_micros(in.instant) + offset_micros, &row.at)) {
                reason = "invalid-epoch";
                break;
            }
            reason = derive_state(in, row.at, static_cast<double>(offset_micros) / 60.0e6, &row.state, &sgp4_error);
            if (!reason.empty()) break;
            rows.push_back(row);
        }
    }
    if (reason.empty()) {
        append_oem_frame(&totals->states, in, rows);
        totals->derived++;
        totals->rows += static_cast<uint32_t>(rows.size());
        for (const Row& row : rows) {
            if (row.state.dubious_time) totals->dubious_time++;
            totals->max_position = std::max(totals->max_position, row.state.round_trip_position_km);
            totals->max_velocity = std::max(totals->max_velocity, row.state.round_trip_velocity_km_s);
        }
    } else {
        totals->failed++;
        if (totals->failures.size() < kMaxListedFailures) {
            totals->failures.push_back({totals->index, in.entity_id, reason, sgp4_error});
        }
    }
    totals->index++;
}

int finish_derive(const DeriveTotals& totals, const std::vector<double>& ages) {
    std::string report = "{\"records\":";
    report += std::to_string(totals.index);
    report += ",\"derived\":";
    report += std::to_string(totals.derived);
    report += ",\"failed\":";
    report += std::to_string(totals.failed);
    report += ",\"rows\":";
    report += std::to_string(totals.rows);
    report += ",\"agesDays\":[";
    for (size_t i = 0; i < ages.size(); ++i) {
        if (i > 0) report += ",";
        report += format_double(ages[i]);
    }
    report += "],\"epochsOutsideLeapSecondTable\":";
    report += std::to_string(totals.dubious_time);
    report += ",\"maxRoundTripPositionKm\":";
    report += format_double(totals.max_position);
    report += ",\"maxRoundTripVelocityKmPerS\":";
    report += format_double(totals.max_velocity);
    report += ",\"failures\":[";
    for (size_t i = 0; i < totals.failures.size(); ++i) {
        if (i > 0) report += ",";
        report += "{\"index\":";
        report += std::to_string(totals.failures[i].index);
        report += ",\"entityId\":";
        append_json_string(&report, totals.failures[i].entity_id);
        report += ",\"reason\":";
        append_json_string(&report, totals.failures[i].reason);
        report += ",\"sgp4Error\":";
        report += std::to_string(totals.failures[i].sgp4_error);
        report += "}";
    }
    report += "]}";

    if (!totals.states.empty() &&
        plugin_push_output_ex("states", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                              "OEM", 0, 8, totals.states.data(), static_cast<uint32_t>(totals.states.size())) < 0) {
        return 500;
    }
    if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                              nullptr, 0, 1, reinterpret_cast<const uint8_t*>(report.data()),
                              static_cast<uint32_t>(report.size())) < 0) {
        return 500;
    }
    return 0;
}

// The identity an $OMM states: NORAD number, else its international designator, else its name.
bool omm_identity(const OMM& omm, ElementInput* in) {
    in->norad = omm.NORAD_CAT_ID();
    const std::string object_id = omm.OBJECT_ID() ? omm.OBJECT_ID()->str() : "";
    in->object_name = omm.OBJECT_NAME() ? omm.OBJECT_NAME()->str() : "";
    if (in->norad != 0) {
        in->entity_id = "NORAD:" + std::to_string(in->norad);
    } else if (!object_id.empty()) {
        in->entity_id = object_id;
    } else if (!in->object_name.empty()) {
        in->entity_id = in->object_name;
    } else {
        return false;
    }
    in->parent = "$OMM " + in->entity_id;
    if (!object_id.empty() && object_id != in->entity_id) in->parent += " OBJECT_ID=" + object_id;
    return true;
}

// ── answer_propagation_requests ────────────────────────────────────────────

constexpr size_t kMaxQueries = 65535;
constexpr size_t kMaxSamplesPerQuery = 200000;

// An empty block whose COMMENT begins REFUSED: the query port's answer for a set the provider will not propagate.
void append_refusal(std::vector<uint8_t>* stream, const std::string& reason) {
    ::flatbuffers::FlatBufferBuilder builder(256);
    const std::string comment = "REFUSED " + reason;
    const auto block = CreateephemerisDataBlockDirect(builder, comment.c_str(), 0, "EARTH");
    std::vector<::flatbuffers::Offset<ephemerisDataBlock>> blocks{block};
    FinishSizePrefixedOEMBuffer(builder, CreateOEMDirect(builder, nullptr, 3.0, nullptr, "SDN epoch-state", &blocks));
    stream->insert(stream->end(), builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize());
}

// One query's answer: the set's TEME trajectory from start to stop in uniform steps no longer than step_s.
// Returns the refusal reason, or empty.
std::string answer_query(const OMM& omm, int64_t start_us, int64_t stop_us, double step_s,
                         std::vector<uint8_t>* stream) {
    if (omm.MEAN_ELEMENT_THEORY() != meanElementSource::SGP4) {
        return std::string("mean-element-theory-not-sgp4:") + EnumNamemeanElementSource(omm.MEAN_ELEMENT_THEORY());
    }
    ElementInput in;
    if (!omm_identity(omm, &in)) return "missing-object-identity";
    if (!omm.EPOCH() || !utc_instant_from_iso(omm.EPOCH()->str(), &in.instant)) return "invalid-epoch";
    const double elements[] = {omm.MEAN_MOTION(), omm.ECCENTRICITY(), omm.INCLINATION(), omm.RA_OF_ASC_NODE(),
                               omm.ARG_OF_PERICENTER(), omm.MEAN_ANOMALY(), omm.BSTAR()};
    for (double value : elements) {
        if (!std::isfinite(value)) return "non-finite-element";
    }
    if (!(omm.MEAN_MOTION() > 0.0)) return "non-positive-mean-motion";
    if (!(stop_us > start_us) || !(step_s > 0.0)) return "invalid-span";
    const double span_s = static_cast<double>(stop_us - start_us) / 1.0e6;
    const double steps_exact = std::ceil(span_s / step_s - 1.0e-9);
    if (!(steps_exact >= 1.0) || steps_exact + 1.0 > static_cast<double>(kMaxSamplesPerQuery)) return "span-too-long";
    const size_t steps = static_cast<size_t>(steps_exact);

    elsetrec satrec;
    std::memset(&satrec, 0, sizeof(satrec));
    const double sgp4_epoch = static_cast<double>(in.instant.unix_day) + kSgp4EpochToUnixDays +
                              static_cast<double>(in.instant.micro_of_day) / 86400.0e6;
    const char satn[9] = "00000";
    if (!SGP4Funcs::sgp4init(wgs72, 'i', satn, sgp4_epoch, omm.BSTAR(), 0.0, 0.0, omm.ECCENTRICITY(),
                             omm.ARG_OF_PERICENTER() * kDegToRad, omm.INCLINATION() * kDegToRad,
                             omm.MEAN_ANOMALY() * kDegToRad, omm.MEAN_MOTION() * kTwoPi / 1440.0,
                             omm.RA_OF_ASC_NODE() * kDegToRad, satrec) ||
        satrec.error != 0) {
        return "sgp4-init";
    }
    const int64_t epoch_us = unix_micros(in.instant);
    std::vector<double> data;
    data.reserve((steps + 1) * 6);
    UtcInstant first, last;
    for (size_t i = 0; i <= steps; ++i) {
        const int64_t at_us = i == steps ? stop_us
                                         : start_us + std::llround(static_cast<double>(i) * static_cast<double>(stop_us - start_us) /
                                                                   static_cast<double>(steps));
        double r[3], v[3];
        if (!SGP4Funcs::sgp4(satrec, static_cast<double>(at_us - epoch_us) / 60.0e6, r, v) || satrec.error != 0) {
            return "sgp4-propagate";
        }
        if (!std::isfinite(r[0] + r[1] + r[2] + v[0] + v[1] + v[2])) return "sgp4-non-finite";
        for (int k = 0; k < 3; ++k) data.push_back(r[k]);
        for (int k = 0; k < 3; ++k) data.push_back(v[k]);
        if (i == 0 && !utc_instant_from_unix_micros(at_us, &first)) return "invalid-epoch";
        if (i == steps && !utc_instant_from_unix_micros(at_us, &last)) return "invalid-epoch";
    }

    ::flatbuffers::FlatBufferBuilder builder(1024 + data.size() * 8);
    const auto object_id = builder.CreateString(in.entity_id);
    const auto object_name = in.object_name.empty() ? ::flatbuffers::Offset<::flatbuffers::String>()
                                                    : builder.CreateString(in.object_name);
    CATBuilder cat(builder);
    cat.add_OBJECT_ID(object_id);
    if (!in.object_name.empty()) cat.add_OBJECT_NAME(object_name);
    if (in.norad != 0) cat.add_NORAD_CAT_ID(in.norad);
    const auto object = cat.Finish();
    const auto frame_name = builder.CreateString("TEME");
    const auto celestial = CreateCelestialFrameWrapper(builder, CelestialFrame::TEMEOFDATE);
    const auto reference_frame =
        CreateRFM(builder, RFMUnion::CelestialFrameWrapper, celestial.Union(), 0, frame_name);
    const std::string comment = "SGP4 trajectory of " + in.parent + " EPOCH=" + in.instant.iso +
                                " in TEME, UTC, km and km/s: Vallado " SGP4Version
                                ", WGS-72 constants, opsmode i, every " + format_double(span_s / static_cast<double>(steps)) +
                                " s from " + first.iso + " to " + last.iso + ".";
    const auto block = CreateephemerisDataBlockDirect(
        builder, comment.c_str(), object, "EARTH", reference_frame, nullptr, 0, timingStandard::UTC, first.iso.c_str(),
        first.iso.c_str(), last.iso.c_str(), last.iso.c_str(), nullptr, 0, span_s / static_cast<double>(steps), 6,
        &data, nullptr, nullptr, nullptr, 0, 399);
    std::vector<::flatbuffers::Offset<ephemerisDataBlock>> blocks{block};
    FinishSizePrefixedOEMBuffer(builder, CreateOEMDirect(builder, nullptr, 3.0, nullptr, "SDN epoch-state", &blocks));
    stream->insert(stream->end(), builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize());
    return "";
}

}  // namespace

extern "C" {

int derive(void) {
    char batch_message[256];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    std::vector<double> ages;
    const std::string options_error = read_ages(&ages);
    if (!options_error.empty()) {
        plugin_set_error("invalid-options", options_error.c_str());
        return 400;
    }
    const int32_t input_index = plugin_find_input_index("elements", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame) {
        plugin_set_error("missing-elements-frame",
                         "derive requires an $MPE stream frame on port \"elements\".");
        return 400;
    }
    DeriveTotals totals;
    const uint8_t* data = frame->payload;
    const size_t length = data ? static_cast<size_t>(frame->payload_length) : 0u;
    std::vector<uint8_t> scratch;

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

        ElementInput in;
        in.entity_id = mpe->ENTITY_ID() ? mpe->ENTITY_ID()->str() : "";
        if (in.entity_id.rfind("NORAD:", 0) == 0) {
            char* end = nullptr;
            const unsigned long parsed = std::strtoul(in.entity_id.c_str() + 6, &end, 10);
            if (end != nullptr && *end == '\0' && parsed <= 0xFFFFFFFFul) {
                in.norad = static_cast<uint32_t>(parsed);
            }
        }
        in.parent = "$MPE ENTITY_ID=" + in.entity_id;
        in.theory = mpe->MEAN_ELEMENT_THEORY();
        in.mean_motion = mpe->MEAN_MOTION();
        in.eccentricity = mpe->ECCENTRICITY();
        in.inclination = mpe->INCLINATION();
        in.raan = mpe->RA_OF_ASC_NODE();
        in.argp = mpe->ARG_OF_PERICENTER();
        in.mean_anomaly = mpe->MEAN_ANOMALY();
        in.bstar = mpe->BSTAR();
        std::string refusal;
        if (in.entity_id.empty()) {
            refusal = "missing-entity-id";
        } else if (!utc_instant_from_unix(mpe->EPOCH(), &in.instant)) {
            refusal = "invalid-epoch";
        }
        derive_element(in, refusal, ages, &totals);
    }
    return finish_derive(totals, ages);
}

int derive_omm(void) {
    char batch_message[256];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    std::vector<double> ages;
    const std::string options_error = read_ages(&ages);
    if (!options_error.empty()) {
        plugin_set_error("invalid-options", options_error.c_str());
        return 400;
    }
    const int32_t input_index = plugin_find_input_index("omm", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame) {
        plugin_set_error("missing-omm-frame", "derive_omm requires an $OMM stream frame on port \"omm\".");
        return 400;
    }
    DeriveTotals totals;
    std::string error;
    const bool ok = for_each_record(
        frame,
        [](const std::vector<uint8_t>& record) {
            ::flatbuffers::Verifier verifier(record.data(), record.size());
            return VerifySizePrefixedOMMBuffer(verifier);
        },
        [&](const std::vector<uint8_t>& record) {
            const OMM* omm = GetSizePrefixedOMM(record.data());
            ElementInput in;
            std::string refusal;
            if (!omm_identity(*omm, &in)) refusal = "missing-object-identity";
            in.theory = omm->MEAN_ELEMENT_THEORY();
            in.mean_motion = omm->MEAN_MOTION();
            in.eccentricity = omm->ECCENTRICITY();
            in.inclination = omm->INCLINATION();
            in.raan = omm->RA_OF_ASC_NODE();
            in.argp = omm->ARG_OF_PERICENTER();
            in.mean_anomaly = omm->MEAN_ANOMALY();
            in.bstar = omm->BSTAR();
            if (refusal.empty() && (!omm->EPOCH() || !utc_instant_from_iso(omm->EPOCH()->str(), &in.instant))) {
                refusal = "invalid-epoch";
            }
            derive_element(in, refusal, ages, &totals);
        },
        &error);
    if (!ok) {
        plugin_set_error("malformed-stream", error.c_str());
        return 400;
    }
    return finish_derive(totals, ages);
}


int answer_propagation_requests(void) {
    const int32_t request_index = plugin_find_input_index("requests", 0);
    const plugin_input_frame_t* request_frame =
        request_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(request_index)) : nullptr;
    if (!request_frame || !request_frame->payload || request_frame->payload_length == 0) {
        plugin_set_error("missing-requests-frame",
                         "answer_propagation_requests requires the detector's propagation_requests on port \"requests\".");
        return 400;
    }
    const Json requests =
        Json::parse(request_frame->payload, request_frame->payload + request_frame->payload_length, nullptr, false);
    if (requests.is_discarded() || !requests.is_object() || !requests.contains("queries") || !requests["queries"].is_array()) {
        plugin_set_error("invalid-requests", "The requests frame is not the detector's {queries: [...]} document.");
        return 400;
    }
    const Json& queries = requests["queries"];
    if (queries.size() > kMaxQueries) {
        plugin_set_error("invalid-requests", "Too many queries in one request.");
        return 400;
    }

    // Every element-set record over every frame of the port, in input order: the index the queries' `set` names.
    std::vector<std::vector<uint8_t>> records;
    std::vector<const plugin_input_frame_t*> element_frames;
    for (uint32_t ordinal = 0;; ++ordinal) {
        const int32_t index = plugin_find_input_index("element_sets", ordinal);
        if (index < 0) break;
        element_frames.push_back(plugin_get_input_frame(static_cast<uint32_t>(index)));
    }
    if (element_frames.empty()) {
        plugin_set_error("missing-element-sets", "answer_propagation_requests requires $OMM element sets on port \"element_sets\".");
        return 400;
    }
    for (const plugin_input_frame_t* frame : element_frames) {
        std::string error;
        const bool ok = for_each_record(
            frame,
            [](const std::vector<uint8_t>& record) {
                ::flatbuffers::Verifier verifier(record.data(), record.size());
                return VerifySizePrefixedOMMBuffer(verifier);
            },
            [&](const std::vector<uint8_t>& record) { records.push_back(record); }, &error);
        if (!ok) {
            plugin_set_error("malformed-stream", error.c_str());
            return 400;
        }
    }

    std::vector<uint8_t> answers;
    uint64_t refused = 0;
    Json refusals = Json::array();
    for (size_t q = 0; q < queries.size(); ++q) {
        const Json& query = queries[q];
        std::string reason;
        UtcInstant start, stop;
        if (!query.is_object() || !query.contains("set") || !query["set"].is_number_unsigned() || !query.contains("start") ||
            !query["start"].is_string() || !query.contains("stop") || !query["stop"].is_string() || !query.contains("step_s") ||
            !query["step_s"].is_number()) {
            plugin_set_error("invalid-requests", "Each query needs set, start, stop and step_s.");
            return 400;
        }
        const size_t set = query["set"].get<size_t>();
        if (!utc_instant_from_iso(query["start"].get<std::string>(), &start) ||
            !utc_instant_from_iso(query["stop"].get<std::string>(), &stop)) {
            plugin_set_error("invalid-requests", "A query's start or stop is not an ISO 8601 UTC time.");
            return 400;
        }
        if (set >= records.size()) {
            reason = "set-out-of-range";
        } else {
            const OMM* omm = GetSizePrefixedOMM(records[set].data());
            reason = answer_query(*omm, unix_micros(start), unix_micros(stop), query["step_s"].get<double>(), &answers);
        }
        if (!reason.empty()) {
            append_refusal(&answers, reason);
            ++refused;
            refusals.push_back({{"sequence", q}, {"set", set}, {"reason", reason}});
        }
    }

    const Json report = {{"queries", queries.size()}, {"answered", queries.size() - refused}, {"refused", refused},
                         {"elementSets", records.size()}, {"refusals", refusals},
                         {"provider", "SGP4, Vallado " SGP4Version ", WGS-72, opsmode i; TEME, UTC, km and km/s"}};
    const std::string report_text = report.dump();
    if (!answers.empty() &&
        plugin_push_output_ex("propagation", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OEM", 0, 0,
                              answers.data(), static_cast<uint32_t>(answers.size())) < 0) {
        return 500;
    }
    // The second pass sees exactly what the first saw.
    for (const plugin_input_frame_t* frame : element_frames) {
        if (plugin_push_output_ex("element_sets", "OMM.fbs", "$OMM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OMM", 0, 0,
                                  frame->payload, frame->payload_length) < 0) {
            return 500;
        }
    }
    const int32_t options_index = plugin_find_input_index("options", 0);
    const plugin_input_frame_t* options_frame =
        options_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(options_index)) : nullptr;
    if (options_frame && options_frame->payload && options_frame->payload_length > 0 &&
        plugin_push_output_ex("options", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                              options_frame->payload, options_frame->payload_length) < 0) {
        return 500;
    }
    if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                              reinterpret_cast<const uint8_t*>(report_text.data()),
                              static_cast<uint32_t>(report_text.size())) < 0) {
        return 500;
    }
    return 0;
}

}  // extern "C"
