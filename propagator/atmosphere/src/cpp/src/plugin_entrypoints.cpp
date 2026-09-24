#include "atmosphere/plugin_runtime.h"

#include "atmosphere/models.h"
#include "atmosphere/space_weather.h"
#include "plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#include "flatbuffers/flatbuffers.h"

// Generated from the published spacedatastandards.org package by
// generate-sds-headers.mjs; never edited by hand.
#include "HFC_generated.h"
#include "OEM_generated.h"
#include "SPW_generated.h"
#include "OCM_generated.h"

#include <cstdint>
#include <cstring>
#include <cmath>
#include <vector>
#include <string>
#include <string_view>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

constexpr double kDegreesToRadians = 3.141592653589793238462643383279502884 / 180.0;
constexpr double kKilometersToMeters = 1000.0;
constexpr double kMetersPerSecondToKilometersPerSecond = 0.001;
// Upper bound on daily SPW records accepted by one batch query.
constexpr uint32_t kMaximumSpaceWeatherDays = 64;

struct HfcModelSelection {
    atmosphere::Model model = atmosphere::Model::US76;
    AtmosphericModelFamily family = AtmosphericModelFamily::USSA_XX;
    int32_t year = 1976;
    const char* revision = "US76";
};

bool parse_digits(std::string_view value, size_t offset, size_t count, int32_t& output) {
    if (value.size() < offset + count) {
        return false;
    }

    int32_t parsed = 0;
    for (size_t index = 0; index < count; ++index) {
        const char ch = value[offset + index];
        if (ch < '0' || ch > '9') {
            return false;
        }
        parsed = parsed * 10 + static_cast<int32_t>(ch - '0');
    }
    output = parsed;
    return true;
}

bool is_leap_year(int32_t year) {
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}

int32_t days_in_month(int32_t year, int32_t month) {
    switch (month) {
        case 1:
        case 3:
        case 5:
        case 7:
        case 8:
        case 10:
        case 12:
            return 31;
        case 4:
        case 6:
        case 9:
        case 11:
            return 30;
        case 2:
            return is_leap_year(year) ? 29 : 28;
        default:
            return 0;
    }
}

int32_t day_of_year(int32_t year, int32_t month, int32_t day) {
    int32_t doy = day;
    for (int32_t current_month = 1; current_month < month; ++current_month) {
        doy += days_in_month(year, current_month);
    }
    return doy;
}

bool parse_hfc_sample_epoch(const ::flatbuffers::String* value, atmosphere::Epoch& epoch) {
    if (!value) {
        return false;
    }

    const std::string_view text(value->c_str(), value->size());
    if (text.size() < 20 ||
        text[4] != '-' ||
        text[7] != '-' ||
        text[10] != 'T' ||
        text[13] != ':' ||
        text[16] != ':') {
        return false;
    }

    int32_t year = 0;
    int32_t month = 0;
    int32_t day = 0;
    int32_t hour = 0;
    int32_t minute = 0;
    int32_t second = 0;
    if (!parse_digits(text, 0, 4, year) ||
        !parse_digits(text, 5, 2, month) ||
        !parse_digits(text, 8, 2, day) ||
        !parse_digits(text, 11, 2, hour) ||
        !parse_digits(text, 14, 2, minute) ||
        !parse_digits(text, 17, 2, second)) {
        return false;
    }

    double fractional_seconds = 0.0;
    size_t cursor = 19;
    if (cursor < text.size() && text[cursor] == '.') {
        ++cursor;
        double place = 0.1;
        if (cursor >= text.size() || text[cursor] < '0' || text[cursor] > '9') {
            return false;
        }
        while (cursor < text.size() && text[cursor] >= '0' && text[cursor] <= '9') {
            fractional_seconds += static_cast<double>(text[cursor] - '0') * place;
            place *= 0.1;
            ++cursor;
        }
    }

    if (cursor >= text.size() || text[cursor] != 'Z' || cursor + 1 != text.size()) {
        return false;
    }

    const int32_t month_days = days_in_month(year, month);
    if (month_days == 0 ||
        day < 1 ||
        day > month_days ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59 ||
        second < 0 ||
        second > 60) {
        return false;
    }

    epoch.year = year;
    epoch.dayOfYear = day_of_year(year, month, day);
    epoch.secondOfDay = static_cast<double>(hour * 3600 + minute * 60 + second) + fractional_seconds;
    return true;
}


// SPW DATE is ISO 8601; only the calendar date (the first ten characters)
// identifies the UTC day.
bool parse_spw_date(const ::flatbuffers::String* value, atmosphere::DailySpaceWeather& day) {
    if (!value || value->size() < 10) {
        return false;
    }
    const std::string_view text(value->c_str(), value->size());
    if (text[4] != '-' || text[7] != '-' || (text.size() > 10 && text[10] != 'T')) {
        return false;
    }
    return parse_digits(text, 0, 4, day.year) &&
           parse_digits(text, 5, 2, day.month) &&
           parse_digits(text, 8, 2, day.day);
}

// NRLMSISE-00 takes F10.7 at the Earth's actual distance from the Sun, not
// the 1 AU adjusted flux (nrlmsise-00.h, notes on input variables), so only
// the observed SPW fields are read. AP1..AP8 are the day's fixed 3-hour UT
// bins; SpaceWeatherWindow turns them into the epoch-relative ap_array.
bool daily_space_weather_from_spw(const SPW* record, atmosphere::DailySpaceWeather& day) {
    if (!record || !parse_spw_date(record->DATE(), day)) {
        return false;
    }
    day.f107Observed = record->F107_OBS();
    day.f107ObservedCenter81 = record->F107_OBS_CENTER81();
    day.f107Forecast = record->F107_DATA_TYPE() == F107DataType::PRD ||
                       record->F107_DATA_TYPE() == F107DataType::PRM;
    day.ap3Hour[0] = record->AP1();
    day.ap3Hour[1] = record->AP2();
    day.ap3Hour[2] = record->AP3();
    day.ap3Hour[3] = record->AP4();
    day.ap3Hour[4] = record->AP5();
    day.ap3Hour[5] = record->AP6();
    day.ap3Hour[6] = record->AP7();
    day.ap3Hour[7] = record->AP8();
    day.apDaily = record->AP_AVG();
    return true;
}

const plugin_input_frame_t* find_frame(const char* port_id) {
    const auto count = plugin_get_input_count();
    for (uint32_t index = 0; index < count; ++index) {
        const auto* frame = plugin_get_input_frame(index);
        if (frame && frame->port_id && std::string(frame->port_id) == port_id) {
            return frame;
        }
    }
    return nullptr;
}

const plugin_input_frame_t* find_request_frame() {
    return find_frame("request");
}

::flatbuffers::Offset<::flatbuffers::String> copy_optional_string(
        ::flatbuffers::FlatBufferBuilder& builder,
        const ::flatbuffers::String* value) {
    return value ? builder.CreateString(value->c_str(), value->size()) : 0;
}

const char* flatbuffer_string_or_null(const ::flatbuffers::String* value) {
    return value ? value->c_str() : nullptr;
}

bool finite3(double x, double y, double z) {
    return std::isfinite(x) && std::isfinite(y) && std::isfinite(z);
}

timingStandard timing_standard_from_string(const char* value) {
    if (value == nullptr || std::strcmp(value, "UTC") == 0) {
        return timingStandard::UTC;
    }
    if (std::strcmp(value, "GPS") == 0) {
        return timingStandard::GPS;
    }
    if (std::strcmp(value, "TAI") == 0) {
        return timingStandard::TAI;
    }
    if (std::strcmp(value, "TT") == 0) {
        return timingStandard::TT;
    }
    if (std::strcmp(value, "UT1") == 0) {
        return timingStandard::UT1;
    }
    if (std::strcmp(value, "TDB") == 0) {
        return timingStandard::TDB;
    }
    if (std::strcmp(value, "TCB") == 0) {
        return timingStandard::TCB;
    }
    if (std::strcmp(value, "TCG") == 0) {
        return timingStandard::TCG;
    }
    if (std::strcmp(value, "MET") == 0) {
        return timingStandard::MET;
    }
    if (std::strcmp(value, "MRT") == 0) {
        return timingStandard::MRT;
    }
    if (std::strcmp(value, "SCLK") == 0) {
        return timingStandard::SCLK;
    }
    return timingStandard::UTC;
}

::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>>
copy_optional_string_vector(
        ::flatbuffers::FlatBufferBuilder& builder,
        const ::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>* values) {
    if (!values || values->size() == 0) {
        return 0;
    }

    std::vector<::flatbuffers::Offset<::flatbuffers::String>> offsets;
    offsets.reserve(values->size());
    for (uint32_t index = 0; index < values->size(); ++index) {
        const auto* value = values->Get(index);
        offsets.push_back(value ? builder.CreateString(value->c_str(), value->size()) : 0);
    }
    return builder.CreateVector(offsets);
}

// An absent ATMOSPHERE request means US76. A named family this module does
// not implement is refused rather than answered with a different model.
bool select_hfc_model(const ATM* atmosphere, HfcModelSelection& selection) {
    if (!atmosphere) {
        return true;
    }

    selection.year = atmosphere->YEAR();
    if (atmosphere->MODEL() == AtmosphericModelFamily::NRLMSIS00E) {
        selection.model = atmosphere::Model::NRLMSISE00;
        selection.family = AtmosphericModelFamily::NRLMSIS00E;
        selection.year = selection.year > 0 ? selection.year : 2000;
        selection.revision = "NRLMSISE-00 gtd7d (release 20041227)";
        return true;
    }
    if (atmosphere->MODEL() == AtmosphericModelFamily::USSA_XX &&
        (selection.year == 0 || selection.year == 1976)) {
        selection.year = 1976;
        return true;
    }
    return false;
}

int emit_json_response(const char* port_id, const atmosphere::PluginInvokeResult& result) {
    if (!result.ok) {
        plugin_set_error(result.error_code.c_str(), result.error_message.c_str());
        return 1;
    }

    const auto* payload = reinterpret_cast<const uint8_t*>(result.json.data());
    if (plugin_push_output(port_id, nullptr, nullptr, payload,
                           static_cast<uint32_t>(result.json.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit response frame.");
        return 1;
    }

    return 0;
}

// $OEM carrying the input state and its drag acceleration, at the OCM epoch,
// in the OCM TRAJ_REF_FRAME about its CENTER_NAME.
int emit_drag_oem(
        const OCM* ocm,
        const char* epoch,
        const double state[6],
        const double acceleration_km_per_s2[3]) {
    OEMT oem;
    oem.CCSDS_OEM_VERS = 2.0;
    oem.CLASSIFICATION = "U";
    if (ocm->HEADER() != nullptr && ocm->HEADER()->CREATION_DATE() != nullptr) {
        oem.CREATION_DATE = ocm->HEADER()->CREATION_DATE()->str();
    }
    oem.ORIGINATOR = "DigitalArsenal propagator/atmosphere";
    auto block = std::make_unique<ephemerisDataBlockT>();
    block->COMMENT = "Basilisk orbitalMotion.c atmosphericDrag acceleration from an SDS OCM spacecraft state.";
    block->CENTER_NAME = ocm->CENTER_NAME()->str();
    block->REFERENCE_FRAME = std::make_unique<RFMT>();
    ocm->TRAJ_REF_FRAME()->UnPackTo(block->REFERENCE_FRAME.get());
    block->TIME_SYSTEM = timing_standard_from_string(flatbuffer_string_or_null(ocm->METADATA()->TIME_SYSTEM()));
    block->START_TIME = epoch;
    block->STOP_TIME = epoch;
    block->STATE_VECTOR_SIZE = 9;
    auto line = std::make_unique<ephemerisDataLineT>();
    line->EPOCH = epoch;
    line->X = state[0];
    line->Y = state[1];
    line->Z = state[2];
    line->X_DOT = state[3];
    line->Y_DOT = state[4];
    line->Z_DOT = state[5];
    line->X_DDOT = acceleration_km_per_s2[0];
    line->Y_DDOT = acceleration_km_per_s2[1];
    line->Z_DDOT = acceleration_km_per_s2[2];
    block->EPHEMERIS_DATA_LINES.push_back(std::move(line));
    oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(block));

    ::flatbuffers::FlatBufferBuilder builder(1024);
    builder.Finish(CreateOEM(builder, &oem), "$OEM");
    if (plugin_push_output_typed(
            "drag_acceleration",
            "OEM.fbs",
            "$OEM",
            PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
            "OEM",
            0,
            static_cast<uint32_t>(builder.GetSize()),
            8,
            builder.GetBufferPointer(),
            static_cast<uint32_t>(builder.GetSize())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit OEM drag acceleration.");
        return 1;
    }

    return 0;
}

int ocm_state_to_drag_acceleration_oem_impl(const plugin_input_frame_t* frame) {
    // Aligned copy: 8-byte scalars are read in place.
    std::vector<uint8_t> bytes(frame->payload, frame->payload + frame->payload_length);
    const OCM* ocm = nullptr;
    if (bytes.size() >= 12 && OCMBufferHasIdentifier(bytes.data())) {
        ::flatbuffers::Verifier verifier(bytes.data(), bytes.size());
        if (VerifyOCMBuffer(verifier)) ocm = GetOCM(bytes.data());
    } else if (bytes.size() >= 12 && SizePrefixedOCMBufferHasIdentifier(bytes.data())) {
        ::flatbuffers::Verifier verifier(bytes.data(), bytes.size());
        if (VerifySizePrefixedOCMBuffer(verifier)) ocm = GetSizePrefixedOCM(bytes.data());
    }
    if (ocm == nullptr) {
        plugin_set_error("invalid-ocm-buffer", "Input vector_state frame is not a verifiable SDS $OCM FlatBuffer.");
        return 1;
    }

    const auto* metadata = ocm->METADATA();
    const char* epoch = metadata != nullptr ? flatbuffer_string_or_null(metadata->START_TIME()) : nullptr;
    if (epoch == nullptr && metadata != nullptr) epoch = flatbuffer_string_or_null(metadata->EPOCH_TZERO());
    if (epoch == nullptr || flatbuffer_string_or_null(metadata->TIME_SYSTEM()) == nullptr) {
        plugin_set_error("missing-epoch", "OCM METADATA.START_TIME (or EPOCH_TZERO) and TIME_SYSTEM are required.");
        return 1;
    }
    if (flatbuffer_string_or_null(ocm->CENTER_NAME()) == nullptr || ocm->TRAJ_REF_FRAME() == nullptr) {
        plugin_set_error("missing-frame", "OCM CENTER_NAME and TRAJ_REF_FRAME are required.");
        return 1;
    }

    const auto type = ocm->TRAJ_TYPE();
    const uint32_t width = ocm->STATE_VECTOR_SIZE();
    const auto* data = ocm->STATE_DATA();
    if ((type != trajectoryType::CARTESIAN_PV || width != 6) &&
        (type != trajectoryType::CARTESIAN_PVA || width != 9)) {
        plugin_set_error("unsupported-trajectory-type", "Expected OCM TRAJ_TYPE CARTESIAN_PV (6) or CARTESIAN_PVA (9).");
        return 1;
    }
    if (data == nullptr || data->size() < width) {
        plugin_set_error("missing-state-data", "OCM STATE_DATA must hold at least one row.");
        return 1;
    }
    const double state[6] = {data->Get(0), data->Get(1), data->Get(2), data->Get(3), data->Get(4), data->Get(5)};
    if (!finite3(state[0], state[1], state[2]) || !finite3(state[3], state[4], state[5])) {
        plugin_set_error("invalid-state-data", "OCM STATE_DATA position and velocity must be finite.");
        return 1;
    }

    const auto* physical = ocm->PHYSICAL_PROPERTIES();
    const double mass_kg = physical != nullptr ? physical->WET_MASS() : 0.0;
    const double drag_area_m2 = physical != nullptr ? physical->DRAG_CONST_AREA() : 0.0;
    const double drag_coefficient = physical != nullptr ? physical->DRAG_COEFF_NOM() : 0.0;
    if (!std::isfinite(mass_kg) || !std::isfinite(drag_area_m2) ||
        !std::isfinite(drag_coefficient) || mass_kg <= 0.0 ||
        drag_area_m2 < 0.0 || drag_coefficient < 0.0) {
        plugin_set_error(
            "invalid-drag-parameters",
            "OCM PHYSICAL_PROPERTIES WET_MASS, DRAG_CONST_AREA and DRAG_COEFF_NOM must be finite non-negative values with positive WET_MASS.");
        return 1;
    }

    const double position_m[3] = {
        state[0] * kKilometersToMeters,
        state[1] * kKilometersToMeters,
        state[2] * kKilometersToMeters};
    const double velocity_m_per_s[3] = {
        state[3] * kKilometersToMeters,
        state[4] * kKilometersToMeters,
        state[5] * kKilometersToMeters};
    double acceleration_m_per_s2[3] = {0.0, 0.0, 0.0};
    atmosphere::basiliskAtmosphericDragAcceleration(
        drag_coefficient,
        drag_area_m2,
        mass_kg,
        position_m,
        velocity_m_per_s,
        acceleration_m_per_s2);
    if (!finite3(acceleration_m_per_s2[0], acceleration_m_per_s2[1], acceleration_m_per_s2[2])) {
        plugin_set_error("invalid-drag-state", "Atmospheric drag computation produced a non-finite acceleration.");
        return 1;
    }

    const double acceleration_km_per_s2[3] = {
        acceleration_m_per_s2[0] * kMetersPerSecondToKilometersPerSecond,
        acceleration_m_per_s2[1] * kMetersPerSecondToKilometersPerSecond,
        acceleration_m_per_s2[2] * kMetersPerSecondToKilometersPerSecond};
    return emit_drag_oem(ocm, epoch, state, acceleration_km_per_s2);
}

int fail_sample(const char* code, const char* message, uint32_t index) {
    const std::string text = "Sample " + std::to_string(index) + ": " + message;
    plugin_set_error(code, text.c_str());
    return 1;
}

// Collects every space_weather frame into one window of daily records.
int load_space_weather(atmosphere::SpaceWeatherWindow& window) {
    const auto count = plugin_get_input_count();
    for (uint32_t index = 0; index < count; ++index) {
        const auto* frame = plugin_get_input_frame(index);
        if (!frame || !frame->port_id || std::string(frame->port_id) != "space_weather") {
            continue;
        }
        if (!frame->payload || frame->payload_length < 8 ||
            !SPWBufferHasIdentifier(frame->payload)) {
            plugin_set_error("invalid-spw-buffer", "Input space_weather frame is not an SDS SPW FlatBuffer.");
            return 1;
        }
        ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
        if (!VerifySPWBuffer(verifier)) {
            plugin_set_error("invalid-spw-buffer", "Input space_weather frame is not a valid SDS SPW FlatBuffer.");
            return 1;
        }
        if (window.size() >= kMaximumSpaceWeatherDays) {
            plugin_set_error("too-many-spw-records", "At most 64 daily SPW records are accepted per query.");
            return 1;
        }
        atmosphere::DailySpaceWeather day;
        if (!daily_space_weather_from_spw(GetSPW(frame->payload), day)) {
            plugin_set_error(
                atmosphere::spaceWeatherErrorCode(atmosphere::SpaceWeatherError::InvalidDate),
                atmosphere::spaceWeatherErrorMessage(atmosphere::SpaceWeatherError::InvalidDate));
            return 1;
        }
        const auto error = window.add(day);
        if (error != atmosphere::SpaceWeatherError::None) {
            plugin_set_error(atmosphere::spaceWeatherErrorCode(error),
                             atmosphere::spaceWeatherErrorMessage(error));
            return 1;
        }
    }
    return 0;
}

::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>>
create_string_vector(::flatbuffers::FlatBufferBuilder& builder, const std::vector<std::string>& values) {
    std::vector<::flatbuffers::Offset<::flatbuffers::String>> offsets;
    offsets.reserve(values.size());
    for (const auto& value : values) {
        offsets.push_back(builder.CreateString(value));
    }
    return builder.CreateVector(offsets);
}

int query_atmosphere_state_batch_hfc(const plugin_input_frame_t* frame) {
    if (frame->payload_length < 8 || !HFCBufferHasIdentifier(frame->payload)) {
        return -1;
    }

    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyHFCBuffer(verifier)) {
        plugin_set_error("invalid-hfc-buffer", "Input atmosphere frame is not a valid SDS HFC FlatBuffer.");
        return 1;
    }

    const auto* request = GetHFC(frame->payload);
    const auto* altitudes = request ? request->ALTITUDE_M() : nullptr;
    const auto* sample_epochs = request ? request->SAMPLE_EPOCHS() : nullptr;
    const auto* latitudes = request ? request->LATITUDE_DEG() : nullptr;
    const auto* longitudes = request ? request->LONGITUDE_DEG() : nullptr;
    const auto* speeds = request ? request->SPEED_M_PER_S() : nullptr;
    if (!altitudes || altitudes->size() == 0) {
        plugin_set_error("missing-altitude-samples", "HFC atmosphere query requires ALTITUDE_M samples.");
        return 1;
    }
    if (sample_epochs && sample_epochs->size() > 0 && sample_epochs->size() != altitudes->size()) {
        plugin_set_error(
            "mismatched-sample-epochs",
            "HFC SAMPLE_EPOCHS must be empty or match ALTITUDE_M sample count.");
        return 1;
    }
    if (latitudes && latitudes->size() > 0 && latitudes->size() != altitudes->size()) {
        plugin_set_error(
            "mismatched-latitude-samples",
            "HFC LATITUDE_DEG must be empty or match ALTITUDE_M sample count.");
        return 1;
    }
    if (longitudes && longitudes->size() > 0 && longitudes->size() != altitudes->size()) {
        plugin_set_error(
            "mismatched-longitude-samples",
            "HFC LONGITUDE_DEG must be empty or match ALTITUDE_M sample count.");
        return 1;
    }
    if (speeds && speeds->size() > 0 && speeds->size() != altitudes->size()) {
        plugin_set_error(
            "mismatched-speed-samples",
            "HFC SPEED_M_PER_S must be empty or match ALTITUDE_M sample count.");
        return 1;
    }

    HfcModelSelection selection{};
    if (!select_hfc_model(request->ATMOSPHERE(), selection)) {
        plugin_set_error(
            "unsupported-atmosphere-model",
            "HFC ATMOSPHERE names a model family this module does not implement; supported: USSA_XX 1976, NRLMSIS00E.");
        return 1;
    }

    const bool nrlmsise = selection.model == atmosphere::Model::NRLMSISE00;
    atmosphere::SpaceWeatherWindow space_weather;
    if (nrlmsise) {
        // NRLMSISE-00 depends on time, place and space weather; none of them
        // has a neutral default.
        const auto* request_time_system = request->TIME_SYSTEM();
        if (request_time_system && std::string_view(request_time_system->c_str(), request_time_system->size()) != "UTC") {
            plugin_set_error("unsupported-time-system", "NRLMSISE00 SAMPLE_EPOCHS are UTC; HFC TIME_SYSTEM must be UTC or absent.");
            return 1;
        }
        if (!sample_epochs || sample_epochs->size() == 0) {
            plugin_set_error("missing-sample-epochs", "NRLMSISE00 requires a UTC SAMPLE_EPOCHS entry for every sample.");
            return 1;
        }
        if (!latitudes || latitudes->size() == 0 || !longitudes || longitudes->size() == 0) {
            plugin_set_error("missing-sample-positions", "NRLMSISE00 requires LATITUDE_DEG and LONGITUDE_DEG for every sample.");
            return 1;
        }
        if (load_space_weather(space_weather) != 0) {
            return 1;
        }
        if (space_weather.size() == 0) {
            plugin_set_error(
                "missing-space-weather",
                "NRLMSISE00 requires daily SPW records on space_weather: each sample's UTC day and the day before, plus up to three earlier days for the 3-hour ap history.");
            return 1;
        }
    }

    std::vector<double> altitude_values;
    std::vector<double> latitude_values;
    std::vector<double> longitude_values;
    std::vector<double> speed_values;
    std::vector<double> mach_values;
    std::vector<double> dynamic_pressure_values;
    std::vector<double> density_values;
    std::vector<double> temperature_values;
    std::vector<double> pressure_values;
    std::vector<double> sound_speed_values;
    altitude_values.reserve(altitudes->size());
    density_values.reserve(altitudes->size());
    temperature_values.reserve(altitudes->size());
    pressure_values.reserve(altitudes->size());
    sound_speed_values.reserve(altitudes->size());
    if (latitudes && latitudes->size() > 0) {
        latitude_values.reserve(latitudes->size());
    }
    if (longitudes && longitudes->size() > 0) {
        longitude_values.reserve(longitudes->size());
    }
    if (speeds && speeds->size() > 0) {
        speed_values.reserve(speeds->size());
        mach_values.reserve(speeds->size());
        dynamic_pressure_values.reserve(speeds->size());
    }

    uint32_t history_samples = 0;
    uint32_t forecast_samples = 0;
    for (uint32_t index = 0; index < altitudes->size(); ++index) {
        const double altitude_m = altitudes->Get(index);
        if (!std::isfinite(altitude_m)) {
            return fail_sample("invalid-altitude", "ALTITUDE_M must be finite.", index);
        }
        if (speeds && speeds->size() > 0 && !std::isfinite(speeds->Get(index))) {
            return fail_sample("invalid-speed", "SPEED_M_PER_S must be finite.", index);
        }
        atmosphere::State state{};
        if (nrlmsise) {
            if (altitude_m < 0.0 || altitude_m > atmosphere::NRLMSISE_MAX_ALT) {
                return fail_sample(
                    "altitude-out-of-range",
                    "NRLMSISE00 ALTITUDE_M (geodetic height) must be within 0 to 1000000 m.",
                    index);
            }
            const double latitude_deg = latitudes->Get(index);
            const double longitude_deg = longitudes->Get(index);
            if (!std::isfinite(latitude_deg) || latitude_deg < -90.0 || latitude_deg > 90.0 ||
                !std::isfinite(longitude_deg)) {
                return fail_sample(
                    "invalid-sample-position",
                    "LATITUDE_DEG must be within -90 to 90 and LONGITUDE_DEG finite.",
                    index);
            }
            atmosphere::GeoPos position{};
            position.alt_m = altitude_m;
            position.lat_rad = latitude_deg * kDegreesToRadians;
            position.lon_rad = longitude_deg * kDegreesToRadians;

            atmosphere::Epoch epoch{};
            if (!parse_hfc_sample_epoch(sample_epochs->Get(index), epoch)) {
                return fail_sample(
                    "invalid-sample-epoch",
                    "SAMPLE_EPOCHS entries must be ISO-8601 UTC timestamps like YYYY-MM-DDTHH:MM:SSZ.",
                    index);
            }

            atmosphere::SpaceWeatherSelection weather;
            const auto error = space_weather.select(epoch, weather);
            if (error != atmosphere::SpaceWeatherError::None) {
                return fail_sample(atmosphere::spaceWeatherErrorCode(error),
                                   atmosphere::spaceWeatherErrorMessage(error), index);
            }
            if (weather.solar.geomagnetic == atmosphere::GeomagneticInput::ApHistory) {
                ++history_samples;
            }
            if (weather.forecastInputs) {
                ++forecast_samples;
            }

            state = atmosphere::nrlmsise00(position, epoch, weather.solar);
        } else {
            state = atmosphere::getAtmosphere(altitude_m, selection.model);
            if (altitude_m >= 100000.0) {
                state.density = atmosphere::standardAtmosphere1976OrbitalDensity(altitude_m);
            }
        }
        altitude_values.push_back(altitude_m);
        density_values.push_back(state.density);
        temperature_values.push_back(state.temperature);
        pressure_values.push_back(state.pressure);
        sound_speed_values.push_back(state.soundSpeed);
        if (latitudes && latitudes->size() > 0) {
            latitude_values.push_back(latitudes->Get(index));
        }
        if (longitudes && longitudes->size() > 0) {
            longitude_values.push_back(longitudes->Get(index));
        }
        if (speeds && speeds->size() > 0) {
            const double speed_m_per_s = speeds->Get(index);
            speed_values.push_back(speed_m_per_s);
            dynamic_pressure_values.push_back(
                atmosphere::dynamicPressure(state.density, speed_m_per_s));
            mach_values.push_back(
                atmosphere::machNumber(speed_m_per_s, state.soundSpeed));
        }
    }

    const uint32_t sample_count = altitudes->size();
    std::vector<std::string> assumptions;
    if (nrlmsise) {
        assumptions.push_back(
            "Density is the NRLMSISE-00 gtd7d total mass density, including anomalous oxygen.");
        assumptions.push_back(
            "F10.7 is the observed flux of the UTC day before each sample (SPW F107_OBS); F10.7A is the observed 81-day centered mean of the sample's day (SPW F107_OBS_CENTER81).");
        assumptions.push_back(
            "Geomagnetic input: epoch-relative 3-hour ap history for " + std::to_string(history_samples) +
            " of " + std::to_string(sample_count) + " samples; daily Ap for the rest, whose 57-hour ap history was incomplete.");
        if (forecast_samples > 0) {
            assumptions.push_back(
                "Forecast F10.7 (SPW F107_DATA_TYPE PRD or PRM) was used for " +
                std::to_string(forecast_samples) + " samples.");
        }
        assumptions.push_back(
            "ALTITUDE_M is geodetic height; local solar time follows from UT and longitude.");
    } else {
        assumptions.push_back(
            "US Standard Atmosphere 1976 below 100 km; above 100 km density is the Basilisk orbitalMotion curve fit to the 1976 standard.");
    }

    ::flatbuffers::FlatBufferBuilder builder(1024 + altitude_values.size() * 64);
    const auto message_id = copy_optional_string(builder, request->MESSAGE_ID());
    const auto creation_date = copy_optional_string(builder, request->CREATION_DATE());
    const auto originator = copy_optional_string(builder, request->ORIGINATOR());
    const auto object_name = copy_optional_string(builder, request->OBJECT_NAME());
    const auto time_system = copy_optional_string(builder, request->TIME_SYSTEM());
    const auto ref_frame = copy_optional_string(builder, request->REF_FRAME());
    const auto start_time = copy_optional_string(builder, request->START_TIME());
    const auto stop_time = copy_optional_string(builder, request->STOP_TIME());
    const auto provider = builder.CreateString("atmosphere-model");
    const auto model_revision = builder.CreateString(selection.revision);
    const auto comment = builder.CreateString("Atmosphere state batch computed from an SDS HFC ALTITUDE_M query.");
    const auto atmosphere = CreateATM(builder, selection.family, selection.year);
    const auto sample_epochs_vector = copy_optional_string_vector(builder, sample_epochs);
    ::flatbuffers::Offset<::flatbuffers::Vector<double>> latitude_vector = 0;
    if (!latitude_values.empty()) {
        latitude_vector = builder.CreateVector(latitude_values);
    }
    ::flatbuffers::Offset<::flatbuffers::Vector<double>> longitude_vector = 0;
    if (!longitude_values.empty()) {
        longitude_vector = builder.CreateVector(longitude_values);
    }
    const auto altitude_vector = builder.CreateVector(altitude_values);
    const auto speed_vector = speed_values.empty() ? 0 : builder.CreateVector(speed_values);
    const auto mach_vector = mach_values.empty() ? 0 : builder.CreateVector(mach_values);
    const auto dynamic_pressure_vector = dynamic_pressure_values.empty()
        ? 0
        : builder.CreateVector(dynamic_pressure_values);
    const auto density_vector = builder.CreateVector(density_values);
    const auto temperature_vector = builder.CreateVector(temperature_values);
    const auto pressure_vector = builder.CreateVector(pressure_values);
    const auto sound_speed_vector = builder.CreateVector(sound_speed_values);
    const auto assumptions_vector = create_string_vector(builder, assumptions);

    HFCBuilder hfc_builder(builder);
    hfc_builder.add_MESSAGE_ID(message_id);
    hfc_builder.add_CREATION_DATE(creation_date);
    hfc_builder.add_ORIGINATOR(originator);
    hfc_builder.add_OBJECT_NAME(object_name);
    hfc_builder.add_TIME_SYSTEM(time_system);
    hfc_builder.add_REF_FRAME(ref_frame);
    hfc_builder.add_START_TIME(start_time);
    hfc_builder.add_STOP_TIME(stop_time);
    hfc_builder.add_STEP_SIZE(request->STEP_SIZE());
    hfc_builder.add_ATMOSPHERE(atmosphere);
    hfc_builder.add_ATMOSPHERE_PROVIDER(provider);
    hfc_builder.add_ATMOSPHERE_MODEL_REVISION(model_revision);
    hfc_builder.add_ATMOSPHERE_COUPLING(hfcAtmosphereCouplingMode::BATCH_QUERY);
    hfc_builder.add_STATE_VECTOR_SIZE(0);
    hfc_builder.add_SAMPLE_EPOCHS(sample_epochs_vector);
    hfc_builder.add_LATITUDE_DEG(latitude_vector);
    hfc_builder.add_LONGITUDE_DEG(longitude_vector);
    hfc_builder.add_ALTITUDE_M(altitude_vector);
    hfc_builder.add_SPEED_M_PER_S(speed_vector);
    hfc_builder.add_MACH(mach_vector);
    hfc_builder.add_DYNAMIC_PRESSURE_PA(dynamic_pressure_vector);
    hfc_builder.add_DENSITY_KG_PER_M3(density_vector);
    hfc_builder.add_TEMPERATURE_K(temperature_vector);
    hfc_builder.add_PRESSURE_PA(pressure_vector);
    hfc_builder.add_SPEED_OF_SOUND_M_PER_S(sound_speed_vector);
    hfc_builder.add_ASSUMPTIONS(assumptions_vector);
    hfc_builder.add_COMMENT(comment);
    builder.Finish(hfc_builder.Finish(), "$HFC");

    if (plugin_push_output_typed(
            "states",
            "HFC.fbs",
            "$HFC",
            PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
            "HFC",
            0,
            static_cast<uint32_t>(builder.GetSize()),
            8,
            builder.GetBufferPointer(),
            static_cast<uint32_t>(builder.GetSize())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit HFC atmosphere states.");
        return 1;
    }

    return 0;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const uint8_t* plugin_get_manifest_flatbuffer(void) {
    return atmosphere_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return atmosphere_plugin_manifest_bytes_len;
}

EMSCRIPTEN_KEEPALIVE
int invoke(void) {
    plugin_reset_output_state();

    const auto* frame = find_request_frame();
    if (!frame || !frame->payload) {
        plugin_set_error("missing-request-input", "Input port \"request\" is required.");
        return 1;
    }

    const auto result = atmosphere::invoke_json_request(
        std::string_view(
            reinterpret_cast<const char*>(frame->payload),
            frame->payload_length));

    return emit_json_response("response", result);
}

EMSCRIPTEN_KEEPALIVE
int query_atmosphere_state_batch(void) {
    plugin_reset_output_state();

    const auto* frame = find_frame("atmosphere");
    if (!frame || !frame->payload) {
        plugin_set_error("missing-atmosphere-input", "Input port \"atmosphere\" is required.");
        return 1;
    }

    const int hfc_result = query_atmosphere_state_batch_hfc(frame);
    if (hfc_result >= 0) {
        return hfc_result;
    }

    const std::string request =
        std::string("{\"operation\":\"queryAtmosphereStateBatch\",\"params\":") +
        std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length) +
        "}";
    const auto result = atmosphere::invoke_json_request(request);

    return emit_json_response("states", result);
}

EMSCRIPTEN_KEEPALIVE
int ocm_state_to_drag_acceleration_oem(void) {
    plugin_reset_output_state();

    const auto* frame = find_frame("vector_state");
    if (!frame || !frame->payload) {
        plugin_set_error("missing-vector-state-input", "Input port \"vector_state\" is required.");
        return 1;
    }

    return ocm_state_to_drag_acceleration_oem_impl(frame);
}

}  // extern "C"
