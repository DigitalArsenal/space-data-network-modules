// data-source/sp3-precise-source: precise orbit products in SP3-c and SP3-d (IGS and its analysis centres, BKG, ESA/ESOC) as SDS records.
//
//   read_sp3   the HttpResponse (HRSP) holding a decompressed SP3 file -> one $OEM per satellite, and a FlowNotice (FNTC)
//              report of what the header and the body state
//
// Typed contracts 1.0 (FlatBuffers only): the input is the HttpResponse hostcap/http-request answers, BODY the SP3 text
// verbatim; the report is one FlowNotice (KIND Info: COUNT the $OEM emitted, ITEMS the header facts and per-satellite counts
// as "name=value", a satellite's as "satellite.<id>.<name>=value"). HTTP 304 gives one FlowNotice (Unchanged) and no $OEM;
// another status or a transport ERROR is refused. The download (BKG and ESA serve the files gzip-compressed, which the host
// expands), the schedule and the archive belong to the SDN host flow. No hostcalls. Errors are flags (an invoke error code and
// message), never exceptions.
//
// The reader is files/orbit-products/src/sp3.hpp, the one SP3 reader of this repository (it is also what that module's
// read_container runs). What this module adds is the shape of the product:
//   - one $OEM per satellite, named for the SP3 vehicle id (G01, R05, E11, C07, L51 ...). No NORAD number is made of a PRN
//     slot: slots are reassigned over time, so the id names a satellite only within the file.
//   - the frame as the header states it. SP3 positions are Earth-fixed (the header names the realization, IGS20, IGb14,
//     ITRF2014 ...): the block's REFERENCE_FRAME carries that name and the Earth-fixed frame (ECEF); a header that names an
//     inertial frame (GCRF, J2000 ...) gives that frame. The time system is the %c line's (GPS, GLONASS, Galileo, UTC ...).
//     Nothing is converted: no frame rotation and no leap second is applied here.
//   - states as the file has them. A position-only file ('P', no velocity records) stays position-only: STATE_VECTOR_SIZE 3,
//     the shape analysis/od reads as "fit the initial velocity from the positions", and no velocity is made of the positions.
//     A file with velocity records ('V') gives full states (6). A run of evenly spaced epochs is one block; a gap (an epoch
//     whose position the file marks absent) starts the next.
//   - the clock columns and accuracy exponents are not carried (an orbit product's $OEM is the orbit); the report states each
//     satellite's accuracy exponent, whether clocks were present, and the flags (predicted orbit, maneuver) per epoch count.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <HttpResponse_generated.h>
#include <FlowNotice_generated.h>

using Json = nlohmann::json;
namespace R = sdn::runtime;

namespace {

constexpr size_t kMaxBytes = 128u * 1024 * 1024;
constexpr size_t kMaxSatellites = 1024;

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

std::string upper(std::string s) {
  for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  return s;
}

std::string squeeze(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c != ' ' && c != '_' && c != '-') out.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(c))));
  }
  return out;
}

// The %c line's time-system token on the standard's timingStandard. The file's own scale is what the epochs are on.
bool time_system_of(const std::string& token, timingStandard* out) {
  const std::string t = upper(token);
  if (t == "GPS") *out = timingStandard::GPS;
  else if (t == "GLO") *out = timingStandard::GLONASS;
  else if (t == "GAL") *out = timingStandard::GST;
  else if (t == "TAI") *out = timingStandard::TAI;
  else if (t == "UTC") *out = timingStandard::UTC;
  else if (t == "QZS") *out = timingStandard::QZSS;
  else if (t == "BDT") *out = timingStandard::BDT;
  else if (t == "IRN") *out = timingStandard::NAVIC;
  else return false;
  return true;
}

// The header's coordinate system: Earth-fixed (a realization name, or ECEF/ECF/ITRF) unless it names an inertial frame.
std::unique_ptr<RFMT> frame_of(const std::string& coordinate_system, bool* earth_fixed) {
  auto frame = std::make_unique<RFMT>();
  frame->NAME = coordinate_system;
  const std::string key = squeeze(coordinate_system);
  struct Inertial { const char* token; CelestialFrame value; };
  static const Inertial kInertial[] = {{"GCRF", CelestialFrame::GCRF}, {"ICRF", CelestialFrame::ICRF}, {"J2000", CelestialFrame::J2000}, {"EME2000", CelestialFrame::EME2000}};
  for (const Inertial& i : kInertial) {
    if (key == i.token) {
      CelestialFrameWrapperT wrapper;
      wrapper.frame = i.value;
      frame->REFERENCE_FRAME.Set(std::move(wrapper));
      *earth_fixed = false;
      return frame;
    }
  }
  CustomFrameWrapperT wrapper;
  wrapper.frame = CustomFrame::ECEF;
  frame->REFERENCE_FRAME.Set(std::move(wrapper));
  *earth_fixed = true;
  return frame;
}

// A report item: "name=value", the value as JSON writes a number or a boolean, a string verbatim.
std::string item(const std::string& name, const Json& value) { return name + "=" + (value.is_string() ? value.get<std::string>() : value.dump()); }

int push_notice(R::flowNoticeKind kind, const char* reason, uint64_t count, std::vector<std::string> items) {
  R::FlowNoticeT notice;
  notice.KIND = kind;
  notice.SCHEMA = "OEM";
  notice.SOURCE_NAME = "sp3";
  notice.REASON = reason;
  notice.COUNT = count;
  notice.ITEMS = std::move(items);
  flatbuffers::FlatBufferBuilder b(1024);
  R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
  return plugin_push_output_ex("report", "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0,
                               b.GetBufferPointer(), b.GetSize());
}

std::string iso_of(double zero_unix_seconds, double offset_seconds) {
  return sdn_time::format_iso_micro(static_cast<int64_t>(std::llround((zero_unix_seconds + offset_seconds) * 1.0e6)));
}

}  // namespace

extern "C" int read_sp3(void) {
  if (plugin_get_input_count() != 1) return fail("invalid-sp3", "Exactly one HttpResponse holding a decompressed SP3 file is required.");
  const auto* input = plugin_get_input_frame(0);
  if (!input || !input->port_id || std::strcmp(input->port_id, "source") || !input->payload || !input->payload_length) {
    return fail("missing-response-frame", "The parser requires the HttpResponse frame on 'source'.");
  }
  flatbuffers::Verifier verifier(input->payload, input->payload_length, 64, 1000000, false);
  if (!R::VerifyHttpResponseBuffer(verifier)) return fail("invalid-response-frame", "The source frame is not an HttpResponse (HRSP).");
  const R::HttpResponse* response = R::GetHttpResponse(input->payload);
  if (response->ERROR() && response->ERROR()->size()) return fail("fetch-failed", "The SP3 request failed: " + response->ERROR()->str());
  if (response->STATUS() == 304) {
    return push_notice(R::flowNoticeKind_Unchanged, "not-modified", 1, {response->URL() ? response->URL()->str() : std::string()}) < 0 ? 1 : 0;
  }
  if (response->STATUS() != 200) return fail("fetch-failed", "The SP3 source returned HTTP status " + std::to_string(response->STATUS()) + ".");
  const auto* body = response->BODY();
  if (!body || body->size() == 0 || body->size() > kMaxBytes) return fail("invalid-sp3", "The source must be one bounded, decompressed SP3 file.");
  const uint8_t* bytes = body->data();
  const uint32_t length = body->size();
  sp3::File file;
  const ephem::Status status = sp3::read(reinterpret_cast<const char*>(bytes), length, &file);
  if (status != ephem::Status::Ok) return fail("invalid-sp3", std::string("The file is not a readable SP3-c or SP3-d product: ") + ephem::status_name(status) + ".");
  if (file.satellites.empty() || file.satellites.size() > kMaxSatellites) return fail("invalid-sp3", "The file names no satellite, or more than 1,024.");
  const std::string system_token = upper(file.time_system);
  timingStandard scale = timingStandard::GPS;
  if (!time_system_of(system_token, &scale)) return fail("invalid-sp3", "The time system " + file.time_system + " has no timingStandard; no epoch is read on a guessed scale.");
  bool earth_fixed = true;
  (void)frame_of(file.coordinate_sys, &earth_fixed);
  std::string agency = file.agency;
  agency.erase(0, agency.find_first_not_of(' '));
  agency.erase(agency.find_last_not_of(' ') + 1);

  std::vector<std::string> satellites;
  std::vector<OEMT> products;
  size_t without_states = 0;
  for (const sp3::SatelliteBlock& sat : file.satellites) {
    const ephem::Series& series = sat.series;
    if (series.rows.empty()) {
      ++without_states;
      satellites.push_back(item("satellite." + sat.sat_id + ".states", 0));
      continue;
    }
    double zero = 0;
    if (!sdn_time::parse_iso(series.epoch_zero_iso, &zero)) return fail("invalid-sp3", "The file's first epoch is not a time.");
    OEMT oem;
    oem.ORIGINATOR = agency;
    oem.COMMENT = "SP3-" + std::string(1, file.version) + " precise orbit " + sat.sat_id + ": " + agency + ", " + file.orbit_type + ", " + file.coordinate_sys + ", " + file.time_system +
                  ". The vehicle id is the file's own; slots are reassigned over time, so it names a satellite only within this file.";
    size_t runs = 0, predicted = 0, maneuvers = 0;
    bool clock = false, velocity = true;
    for (size_t i = 0; i < series.rows.size();) {
      // A run: the epochs from i that keep the step the first two set (a single epoch is a run of one).
      size_t j = i + 1;
      const double step = j < series.rows.size() ? series.rows[j].epoch - series.rows[i].epoch : 0.0;
      while (j < series.rows.size() && step > 0 && std::fabs((series.rows[j].epoch - series.rows[j - 1].epoch) - step) <= 1.0e-6) ++j;
      bool run_velocity = true;
      for (size_t k = i; k < j; ++k) run_velocity = run_velocity && series.rows[k].has_vel;
      velocity = velocity && run_velocity;
      auto block = std::make_unique<ephemerisDataBlockT>();
      block->OBJECT = std::make_unique<CATT>();
      block->OBJECT->OBJECT_NAME = sat.sat_id;
      block->CENTER_NAME = "EARTH";
      bool fixed = true;
      block->REFERENCE_FRAME = frame_of(file.coordinate_sys, &fixed);
      block->TIME_SYSTEM = scale;
      block->START_TIME = iso_of(zero, series.rows[i].epoch);
      block->STOP_TIME = iso_of(zero, series.rows[j - 1].epoch);
      block->STEP_SIZE = step > 0 ? step : (file.epoch_interval > 0 ? file.epoch_interval : 1.0);
      block->STATE_VECTOR_SIZE = run_velocity ? 6 : 3;
      for (size_t k = i; k < j; ++k) {
        const ephem::StateRow& row = series.rows[k];
        block->EPHEMERIS_DATA.insert(block->EPHEMERIS_DATA.end(), row.pos, row.pos + 3);
        if (run_velocity) block->EPHEMERIS_DATA.insert(block->EPHEMERIS_DATA.end(), row.vel, row.vel + 3);
        clock = clock || row.has_clock;
      }
      oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(block));
      ++runs;
      i = j;
    }
    for (const sp3::RecordFlags& f : sat.flags) {
      if (f.orbit_predicted) ++predicted;
      if (f.maneuver) ++maneuvers;
    }
    const std::string at = "satellite." + sat.sat_id + ".";
    for (std::string entry : {item(at + "states", series.rows.size()), item(at + "blocks", runs), item(at + "velocity", velocity), item(at + "accuracyExponent", sat.accuracy_exponent),
                              item(at + "clock", clock), item(at + "predictedStates", predicted), item(at + "maneuverFlags", maneuvers)}) {
      satellites.push_back(std::move(entry));
    }
    products.push_back(std::move(oem));
  }
  if (products.empty()) return fail("invalid-sp3", "No satellite has a position in the file.");
  std::vector<std::string> items = {item("fileVersion", std::string(1, file.version)), item("positionVelocity", std::string(1, file.pos_vel_flag)), item("agency", agency),
                                    item("coordinateSystem", file.coordinate_sys), item("orbitType", file.orbit_type), item("dataUsed", file.data_used),
                                    item("timeSystem", file.time_system), item("frame", earth_fixed ? "Earth-fixed" : "inertial"), item("gpsWeek", file.gps_week),
                                    item("epochIntervalSeconds", file.epoch_interval), item("firstEpoch", file.satellites.front().series.epoch_zero_iso),
                                    item("declaredEpochs", file.declared_num_epochs), item("satelliteCount", file.satellites.size()),
                                    item("satellitesWithoutStates", without_states), item("sha256", ephem::sha256_hex(bytes, length)), item("bytes", length)};
  items.insert(items.end(), satellites.begin(), satellites.end());
  if (push_notice(R::flowNoticeKind_Info, "sp3", products.size(), std::move(items)) < 0) return 1;
  for (const OEMT& oem : products) {
    flatbuffers::FlatBufferBuilder fbb(4096);
    FinishOEMBuffer(fbb, CreateOEM(fbb, &oem));
    if (plugin_push_output_ex("oem", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OEM", 0, 0, fbb.GetBufferPointer(), fbb.GetSize()) < 0) return 1;
  }
  return 0;
}
