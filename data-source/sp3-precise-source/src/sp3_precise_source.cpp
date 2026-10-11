// data-source/sp3-precise-source: precise orbit products in SP3-c and SP3-d (IGS and its analysis centres, BKG, ESA/ESOC) as SDS records.
//
//   read_sp3   a decompressed SP3 file -> one $OEM per satellite, and a report of what the header and the body state
//
// Pure bytes in, pure bytes out: the download (BKG and ESA serve the files gzip-compressed, which the host expands), the
// schedule and the archive belong to the SDN host flow. Errors are flags (an invoke error code and message), never exceptions.
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

using Json = nlohmann::json;

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

int push_json(const char* port, const Json& value) {
  const std::string text = value.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(text.data()),
                               static_cast<uint32_t>(text.size()));
}

std::string iso_of(double zero_unix_seconds, double offset_seconds) {
  return sdn_time::format_iso_micro(static_cast<int64_t>(std::llround((zero_unix_seconds + offset_seconds) * 1.0e6)));
}

}  // namespace

extern "C" int read_sp3(void) {
  if (plugin_get_input_count() != 1) return fail("invalid-sp3", "Exactly one decompressed SP3 file is required.");
  const auto* input = plugin_get_input_frame(0);
  if (!input || !input->port_id || std::strcmp(input->port_id, "source") || !input->payload || !input->payload_length || input->payload_length > kMaxBytes) {
    return fail("invalid-sp3", "The source must be one bounded, decompressed SP3 file.");
  }
  sp3::File file;
  const ephem::Status status = sp3::read(reinterpret_cast<const char*>(input->payload), input->payload_length, &file);
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

  Json satellites = Json::array();
  std::vector<OEMT> products;
  size_t without_states = 0;
  for (const sp3::SatelliteBlock& sat : file.satellites) {
    const ephem::Series& series = sat.series;
    if (series.rows.empty()) {
      ++without_states;
      satellites.push_back({{"id", sat.sat_id}, {"states", 0}});
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
    satellites.push_back({{"id", sat.sat_id}, {"states", series.rows.size()}, {"blocks", runs}, {"velocity", velocity}, {"accuracyExponent", sat.accuracy_exponent}, {"clock", clock},
                          {"predictedStates", predicted}, {"maneuverFlags", maneuvers}});
    products.push_back(std::move(oem));
  }
  if (products.empty()) return fail("invalid-sp3", "No satellite has a position in the file.");
  const Json report = {{"version", 1}, {"source", "sp3"}, {"fileVersion", std::string(1, file.version)}, {"positionVelocity", std::string(1, file.pos_vel_flag)}, {"agency", agency},
                       {"coordinateSystem", file.coordinate_sys}, {"orbitType", file.orbit_type}, {"dataUsed", file.data_used}, {"timeSystem", file.time_system},
                       {"frame", earth_fixed ? "Earth-fixed" : "inertial"}, {"gpsWeek", file.gps_week}, {"epochIntervalSeconds", file.epoch_interval},
                       {"firstEpoch", file.satellites.front().series.epoch_zero_iso}, {"declaredEpochs", file.declared_num_epochs}, {"satellites", satellites},
                       {"satellitesWithoutStates", without_states}, {"sha256", ephem::sha256_hex(input->payload, input->payload_length)}, {"bytes", input->payload_length}};
  if (push_json("report", report) < 0) return 1;
  for (const OEMT& oem : products) {
    flatbuffers::FlatBufferBuilder fbb(4096);
    FinishOEMBuffer(fbb, CreateOEM(fbb, &oem));
    if (plugin_push_output_ex("oem", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OEM", 0, 0, fbb.GetBufferPointer(), fbb.GetSize()) < 0) return 1;
  }
  return 0;
}
