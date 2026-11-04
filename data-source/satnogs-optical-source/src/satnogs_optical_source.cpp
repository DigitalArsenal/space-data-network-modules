// data-source/satnogs-optical-source: one station-night of SatNOGS Optical astrometric measurements as SDS tracking data.
//
//   read_station_night   the station-night's measurements, as the caller reads them from the network's measurements.parquet
//                        (the module has no Parquet reader): `angles`, one $TDM whose segments are the night's tracks with the
//                        rows' RA/Dec at their stated epochs, and `measurements`, one $EOO per row in the same order (the row's
//                        name, sigma, site and timing bias); optionally `config`, a ModuleConfig (MCFG)
//                     -> one $TDM per object-track on `observations` (RADEC, TIMETAG_REF RECEIVE, epochs at mid-exposure,
//                        OBSERVER_X/Y/Z the site), one $EOO per observation on `uncertainty` (the row's sigma, its epoch moved
//                        with it), one $GST on `stations` (the station's site and declared timing bias), one $PVN, one
//                        IngestRequest (INGQ) with the licence tags, and one FlowNotice (FNTC) report.
//
// Typed contracts 1.0 (FlatBuffers only). Pure bytes in, pure bytes out: the dump download, its sha256 check, the Parquet decode
// and the archive belong to the SDN host flow. Errors are flags (an invoke error code and message), never exceptions.
//
// Why two input records. No SDS 1.276 table holds a SatNOGS row whole. $EOO is the electro-optical observation and carries the
// row's name (ID), epoch, station, object, track, sigma (RA_UNC, DECLINATION_UNC), site (SENLAT, SENLON, SENALT) and timing bias,
// but its angles are 32-bit floats (about 1e-5 degrees, 0.05 arcsec, of rounding), and it has no field for what an epoch refers
// to or for a withheld row. $TDM carries the angles in double precision and the epoch convention in CCSDS terms
// (INTEGRATION_REF START, MIDDLE or END with INTEGRATION_INTERVAL the exposure) and a segment's DATA_QUALITY. So the caller gives
// both: the k-th ANGLE_1/ANGLE_2 pair of the $TDM (segments in order) is the k-th $EOO, with the same epoch and track.
//
// The epoch (SatNOGS Optical epoch_refers_to). The caller states each segment's convention: exposure-mid is INTEGRATION_REF
// MIDDLE (the epoch is mid-exposure, moved by 0), exposure-start is START with the exposure as INTEGRATION_INTERVAL (moved by
// +interval/2), END is moved by -interval/2. frame-arrival has no CCSDS reference and its offset from mid-exposure is not
// declared by the network (it folds it into the timing sigma), so a row without INTEGRATION_REF, or START or END without an
// interval, is refused by name. The move is arithmetic on the declared offset, in integer nanoseconds.
//
// Withheld rows (SatNOGS Optical quarantined): the caller puts them in a segment with DATA_QUALITY DEGRADED. They are refused
// by name (config quarantine refuse, the default: not emitted, named in the report; fail: the whole night is refused).
//
// The site. OBSERVER_X/Y/Z are the station's WGS-84 geodetic site (SENLAT, SENLON in degrees, SENALT in km, as the network's
// station file declares it) on the ellipsoid in metres, the terrestrial position analysis/estimation takes as the station.
//
// Licence: CC BY-SA 4.0, credit "SatNOGS Optical contributors - https://optical.satnogs.org - CC BY-SA 4.0" (the network's
// data page and every dump manifest). It travels in the IngestRequest tags and the $PVN; every $TDM states it in a COMMENT.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include <FlowNotice_generated.h>
#include <IngestRequest_generated.h>
#include <ModuleConfig_generated.h>

namespace R = sdn::runtime;

namespace {

constexpr const char* kPluginId = "com.digitalarsenal.data-source.satnogs-optical-source";
constexpr const char* kVersion = "0.1.0";
constexpr const char* kSource = "satnogs-optical";
constexpr const char* kLicense = "CC-BY-SA-4.0";
constexpr const char* kLicenseUrl = "https://creativecommons.org/licenses/by-sa/4.0/";
constexpr const char* kCredit = "SatNOGS Optical contributors - https://optical.satnogs.org - CC BY-SA 4.0";
constexpr const char* kClass = "publish-with-credit";
constexpr const char* kDataUrl = "https://optical.satnogs.org/data";
constexpr size_t kMaxRows = 200000;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

std::string text(const flatbuffers::String* s) { return s ? s->str() : std::string(); }
std::string item(const std::string& name, const std::string& value) { return name + "=" + value; }
std::string item(const std::string& name, double value) {
  char buf[48];
  std::snprintf(buf, sizeof(buf), "%.17g", value);
  return name + "=" + buf;
}
std::string item(const std::string& name, size_t value) { return name + "=" + std::to_string(value); }

// An epoch "YYYY-MM-DDTHH:MM:SS[.f...]" (no zone: the segment's TIME_SYSTEM) as whole days and nanoseconds of the day, exactly.
struct Instant {
  int64_t day = 0, ns = 0;
};
bool parse_epoch(const std::string& s, Instant* out) {
  if (s.size() < 19 || s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' || s[16] != ':') return false;
  auto num = [&](size_t at, size_t n, int64_t* v) {
    *v = 0;
    for (size_t i = at; i < at + n; ++i) {
      if (s[i] < '0' || s[i] > '9') return false;
      *v = *v * 10 + (s[i] - '0');
    }
    return true;
  };
  int64_t y, mo, d, h, mi, se;
  if (!num(0, 4, &y) || !num(5, 2, &mo) || !num(8, 2, &d) || !num(11, 2, &h) || !num(14, 2, &mi) || !num(17, 2, &se)) return false;
  if (!sdn_time::valid_date(y, mo, d) || h > 23 || mi > 59 || se > 59) return false;
  int64_t frac = 0;
  if (s.size() > 19) {
    if (s[19] != '.' || s.size() == 20 || s.size() > 29) return false;
    for (size_t i = 20; i < 29; ++i) {
      const char c = i < s.size() ? s[i] : '0';
      if (c < '0' || c > '9') return false;
      frac = frac * 10 + (c - '0');
    }
  }
  out->day = sdn_time::days_from_civil(y, mo, d);
  out->ns = ((h * 60 + mi) * 60 + se) * 1000000000LL + frac;
  return true;
}
std::string format_epoch(Instant t) {
  constexpr int64_t kDay = 86400LL * 1000000000LL;
  t.day += t.ns >= 0 ? t.ns / kDay : -((kDay - 1 - t.ns) / kDay);
  t.ns = ((t.ns % kDay) + kDay) % kDay;
  int64_t y, m, d;
  sdn_time::civil_from_days(t.day, &y, &m, &d);
  const int64_t sec = t.ns / 1000000000LL;
  char out[48];
  std::snprintf(out, sizeof(out), "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%09lld", static_cast<long long>(y), static_cast<long long>(m), static_cast<long long>(d),
                static_cast<long long>(sec / 3600), static_cast<long long>(sec / 60 % 60), static_cast<long long>(sec % 60), static_cast<long long>(t.ns % 1000000000LL));
  return out;
}

// WGS-84 geodetic (degrees, metres above the ellipsoid) to Earth-fixed Cartesian metres.
void wgs84(double lat_deg, double lon_deg, double h_m, double xyz[3]) {
  constexpr double a = 6378137.0, f = 1.0 / 298.257223563, e2 = f * (2.0 - f), rad = 3.14159265358979323846 / 180.0;
  const double sl = std::sin(lat_deg * rad), cl = std::cos(lat_deg * rad);
  const double n = a / std::sqrt(1.0 - e2 * sl * sl);
  xyz[0] = (n + h_m) * cl * std::cos(lon_deg * rad);
  xyz[1] = (n + h_m) * cl * std::sin(lon_deg * rad);
  xyz[2] = (n * (1.0 - e2) + h_m) * sl;
}

struct Config {
  size_t minimum = 1;
  bool fail_on_quarantine = false;
  bool filtered = false;
  std::set<int64_t> objects;
};
bool read_config(Config* config, std::string* error) {
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "config")) continue;
    flatbuffers::Verifier verifier(f->payload, f->payload_length);
    if (!f->payload || !R::VerifyModuleConfigBuffer(verifier)) return *error = "The config frame is not a ModuleConfig (MCFG).", false;
    const auto* entries = R::GetModuleConfig(f->payload)->ENTRIES();
    for (uint32_t k = 0; entries && k < entries->size(); ++k) {
      const auto* e = entries->Get(k);
      const std::string key = text(e->KEY());
      if (key == "minimumMeasurements" && e->KIND() == R::configValueKind_Number && e->NUMBER_VALUE() >= 1 && e->NUMBER_VALUE() <= 1e6 &&
          e->NUMBER_VALUE() == std::floor(e->NUMBER_VALUE())) {
        config->minimum = static_cast<size_t>(e->NUMBER_VALUE());
      } else if (key == "quarantine" && e->KIND() == R::configValueKind_String && (text(e->STRING_VALUE()) == "refuse" || text(e->STRING_VALUE()) == "fail")) {
        config->fail_on_quarantine = text(e->STRING_VALUE()) == "fail";
      } else if (key == "objects" && e->KIND() == R::configValueKind_NumberList && e->NUMBERS()) {
        config->filtered = true;
        for (double v : *e->NUMBERS()) {
          if (!(v >= 1 && v < 1e9 && v == std::floor(v))) return *error = "config objects: every entry is a NORAD catalog number.", false;
          config->objects.insert(static_cast<int64_t>(v));
        }
      } else {
        return *error = "The configuration takes minimumMeasurements (a whole number of at least 1), quarantine (refuse or fail) and objects (NORAD numbers); got '" + key + "'.",
               false;
      }
    }
  }
  return true;
}

int push(const char* port, const char* schema, const char* id, const char* root, const flatbuffers::FlatBufferBuilder& b) {
  return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, b.GetBufferPointer(), b.GetSize());
}

struct Row {
  std::string epoch, name;
  double ra = 0, dec = 0;
  std::unique_ptr<EOOT> eoo;
};
struct Track {
  std::string id, station, object, frame, quality, reference;
  double interval = 0;
  int64_t norad = 0;
  std::vector<Row> rows;
};

}  // namespace

extern "C" int read_station_night(void) {
  Config config;
  std::string error;
  if (!read_config(&config, &error)) return fail("invalid-config", error);
  const plugin_input_frame_t* angles = nullptr;
  std::vector<const plugin_input_frame_t*> measurements;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id) continue;
    if (!std::strcmp(f->port_id, "angles")) {
      if (angles) return fail("invalid-batch", "One $TDM on 'angles' is required, not two.");
      angles = f;
    } else if (!std::strcmp(f->port_id, "measurements")) {
      measurements.push_back(f);
    }
  }
  if (!angles || !angles->payload || !angles->payload_length) return fail("invalid-batch", "The station-night's $TDM on 'angles' is required.");
  if (measurements.empty() || measurements.size() > kMaxRows) return fail("invalid-batch", "One $EOO per measurement (1 to 200,000) is required on 'measurements'.");
  {
    flatbuffers::Verifier v(angles->payload, angles->payload_length, 64, 10000000);
    if (!TDMBufferHasIdentifier(angles->payload) || !VerifyTDMBuffer(v)) return fail("invalid-batch", "The 'angles' frame is not a $TDM.");
  }
  const TDM* night = GetTDM(angles->payload);
  if (!night->SEGMENTS() || !night->SEGMENTS()->size()) return fail("invalid-batch", "The $TDM has no segment (one per track).");

  // Join the angle pairs with the measurement records, in order.
  std::vector<Track> tracks;
  size_t k = 0;
  for (const TDMSegment* seg : *night->SEGMENTS()) {
    Track t;
    t.id = text(seg->TRACK_ID());
    t.station = text(seg->PARTICIPANT_1());
    t.object = text(seg->PARTICIPANT_2());
    t.frame = text(seg->REFERENCE_FRAME());
    t.quality = text(seg->DATA_QUALITY());
    t.reference = text(seg->INTEGRATION_REF());
    t.interval = seg->INTEGRATION_INTERVAL();
    if (t.id.empty() || t.station.empty() || t.object.empty()) return fail("invalid-batch", "Every segment names its TRACK_ID, PARTICIPANT_1 (station) and PARTICIPANT_2 (object).");
    if (text(seg->ANGLE_TYPE()) != "RADEC" || text(seg->TIME_SYSTEM()) != "UTC") return fail("invalid-batch", "Track " + t.id + ": ANGLE_TYPE RADEC and TIME_SYSTEM UTC are required.");
    if (!tracks.empty() && t.station != tracks.front().station) return fail("invalid-batch", "One station-night has one station: " + t.station + " and " + tracks.front().station + ".");
    const auto* obs = seg->OBSERVATIONS();
    const size_t n = obs ? obs->size() : 0;
    if (n == 0 || n % 2) return fail("invalid-batch", "Track " + t.id + ": the observations are ANGLE_1, ANGLE_2 pairs.");
    for (size_t i = 0; i < n; i += 2) {
      const auto* a1 = obs->Get(static_cast<flatbuffers::uoffset_t>(i));
      const auto* a2 = obs->Get(static_cast<flatbuffers::uoffset_t>(i + 1));
      if (text(a1->KEYWORD()) != "ANGLE_1" || text(a2->KEYWORD()) != "ANGLE_2" || text(a1->EPOCH()) != text(a2->EPOCH()) || text(a1->EPOCH()).empty()) {
        return fail("invalid-batch", "Track " + t.id + ": observation " + std::to_string(i / 2) + " is not an ANGLE_1, ANGLE_2 pair at one epoch.");
      }
      if (k >= measurements.size()) return fail("invalid-batch", "The $TDM has more angle pairs than the " + std::to_string(measurements.size()) + " measurement records.");
      const auto* m = measurements[k++];
      flatbuffers::Verifier v(m->payload, m->payload_length);
      if (!m->payload || !EOOBufferHasIdentifier(m->payload) || !VerifyEOOBuffer(v)) return fail("invalid-batch", "Measurement record " + std::to_string(k - 1) + " is not an $EOO.");
      Row r;
      r.eoo.reset(GetEOO(m->payload)->UnPack());
      r.epoch = text(a1->EPOCH());
      r.name = r.eoo->ID;
      r.ra = a1->VALUE();
      r.dec = a2->VALUE();
      if (r.name.empty()) return fail("invalid-batch", "Measurement record " + std::to_string(k - 1) + " has no ID (the row's name).");
      if (r.eoo->OB_TIME != r.epoch || r.eoo->IMAGE_SET_ID != t.id) {
        return fail("invalid-batch", "Measurement " + r.name + " (" + r.eoo->OB_TIME + ", track " + r.eoo->IMAGE_SET_ID + ") is not angle pair " + std::to_string(k - 1) + " (" + r.epoch +
                                         ", track " + t.id + ").");
      }
      if (!std::isfinite(r.ra) || !std::isfinite(r.dec) || r.ra < 0 || r.ra >= 360 || r.dec < -90 || r.dec > 90) return fail("invalid-batch", "Measurement " + r.name + ": RA or Dec out of range.");
      t.norad = r.eoo->UCT ? 0 : r.eoo->NORAD_CAT_ID;
      t.rows.push_back(std::move(r));
    }
    tracks.push_back(std::move(t));
  }
  if (k != measurements.size()) return fail("invalid-batch", std::to_string(measurements.size()) + " measurement records for " + std::to_string(k) + " angle pairs.");

  // The site: one per station-night, as the station declares it.
  const EOOT& first = *tracks.front().rows.front().eoo;
  const double lat = first.SENLAT, lon = first.SENLON, alt_km = first.SENALT, bias = first.TIMING_BIAS;
  if (!std::isfinite(lat) || !std::isfinite(lon) || !std::isfinite(alt_km) || std::fabs(lat) > 90 || std::fabs(lon) > 360) return fail("invalid-batch", "The site (SENLAT, SENLON, SENALT) is required.");
  double site[3];
  wgs84(lat, lon, alt_km * 1000.0, site);

  std::vector<std::string> refused, items;
  std::map<std::string, size_t> refused_by_reason;
  std::vector<flatbuffers::FlatBufferBuilder> tdms, eoos;
  size_t emitted = 0, below_minimum = 0, filtered_out = 0;
  std::string night_start, night_stop;
  Instant first_at, last_at;
  bool have_span = false;
  std::vector<std::string> per_track;
  // Each segment's rows are refused by name, or moved to mid-exposure by the declared offset (nanoseconds) and gathered
  // into their object-track: a track the caller split (a refused row, a change of convention) is one $TDM.
  struct Emitted { Row* row; int64_t shift_ns; };
  struct Output { Track* track; std::vector<Emitted> rows; std::set<std::string> references; std::set<int64_t> shifts; };
  std::vector<Output> outputs;
  std::map<std::string, size_t> output_of;
  for (Track& t : tracks) {
    if (config.filtered && !config.objects.count(t.norad)) {
      filtered_out += t.rows.size();
      continue;
    }
    int64_t shift_ns = 0;
    std::string why;
    if (t.quality == "DEGRADED") why = "quarantined";
    else if (t.reference == "MIDDLE") shift_ns = 0;
    else if ((t.reference == "START" || t.reference == "END") && t.interval > 0 && t.interval < 3600) shift_ns = std::llround((t.reference == "START" ? 0.5 : -0.5) * t.interval * 1e9);
    else if (t.reference == "START" || t.reference == "END") why = "exposure-" + std::string(t.reference == "START" ? "start" : "end") + " epoch with no declared exposure time";
    else why = "epoch reference not declared (frame-arrival or none): no declared offset to mid-exposure";
    if (!why.empty()) {
      if (why == "quarantined" && config.fail_on_quarantine) return fail("quarantined-row", "Quarantined row " + t.rows.front().name + " (track " + t.id + ") refused.");
      for (const Row& r : t.rows) refused.push_back(item("refused." + r.name, why + " (track " + t.id + ")"));
      refused_by_reason[why] += t.rows.size();
      continue;
    }
    const std::string key = t.id + "\n" + t.object;
    if (!output_of.count(key)) {
      output_of[key] = outputs.size();
      outputs.push_back(Output{&t, {}, {}, {}});
    }
    Output& o = outputs[output_of[key]];
    o.references.insert(t.reference);
    o.shifts.insert(shift_ns);
    for (Row& r : t.rows) o.rows.push_back(Emitted{&r, shift_ns});
  }
  for (Output& o : outputs) {
    const Track& t = *o.track;
    if (o.rows.size() < config.minimum) {
      below_minimum += o.rows.size();
      continue;
    }
    std::string references, shifts;
    for (const auto& s : o.references) references += (references.empty() ? "" : ",") + s;
    for (int64_t s : o.shifts) shifts += (shifts.empty() ? "" : ",") + std::to_string(s);
    TDMT tdm;
    tdm.OBSERVER_ID = t.station;
    tdm.OBSERVER_X = site[0];
    tdm.OBSERVER_Y = site[1];
    tdm.OBSERVER_Z = site[2];
    tdm.CCSDS_TDM_VERS = "2.0";
    tdm.CREATION_DATE = text(night->CREATION_DATE());
    tdm.ORIGINATOR = "SatNOGS Optical";
    tdm.COMMENT = {std::string("credit ") + kCredit, std::string("licence ") + kLicense + " " + kLicenseUrl};
    auto seg = std::make_unique<TDMSegmentT>();
    seg->TIME_SYSTEM = "UTC";
    seg->PARTICIPANT_1 = t.station;
    seg->PARTICIPANT_2 = t.object;
    seg->MODE = "SEQUENTIAL";
    seg->PATH = "2,1";
    seg->ANGLE_TYPE = "RADEC";
    seg->REFERENCE_FRAME = t.frame;
    seg->TIMETAG_REF = "RECEIVE";
    seg->TRACK_ID = t.id;
    seg->DATA_TYPES = "ANGLE_1,ANGLE_2";
    seg->DATA_QUALITY = t.quality.empty() ? "RAW" : t.quality;
    seg->COMMENT = {"epochs at mid-exposure: the stated epochs (INTEGRATION_REF " + references + ") moved by " + shifts + " ns",
                    "OBSERVER_X/Y/Z: the station's WGS-84 geodetic site on the ellipsoid, m (Earth-fixed)",
                    "per-observation sigma: the $EOO of each observation (RA_UNC, DECLINATION_UNC)"};
    for (const Emitted& next : o.rows) {
      Row& r = *next.row;
      Instant at;
      if (!parse_epoch(r.epoch, &at)) return fail("invalid-batch", "Measurement " + r.name + ": the epoch " + r.epoch + " does not read.");
      const std::string moved = next.shift_ns ? format_epoch({at.day, at.ns + next.shift_ns}) : r.epoch;
      for (auto [key, value] : {std::pair<const char*, double>{"ANGLE_1", r.ra}, {"ANGLE_2", r.dec}}) {
        auto obs = std::make_unique<TDMObservationT>();
        obs->KEYWORD = key;
        obs->EPOCH = moved;
        obs->VALUE = value;
        seg->OBSERVATIONS.push_back(std::move(obs));
      }
      EOOT& e = *r.eoo;
      e.OB_TIME = moved;
      e.RA = static_cast<float>(r.ra);
      e.DECLINATION = static_cast<float>(r.dec);
      e.RA_MEASURED = true;
      e.DECLINATION_MEASURED = true;
      e.SENX = static_cast<float>(site[0] / 1000.0);
      e.SENY = static_cast<float>(site[1] / 1000.0);
      e.SENZ = static_cast<float>(site[2] / 1000.0);
      e.SOURCE = kSource;
      eoos.emplace_back(512);
      FinishEOOBuffer(eoos.back(), CreateEOO(eoos.back(), &e));
      Instant m;
      parse_epoch(moved, &m);
      if (!have_span || m.day < first_at.day || (m.day == first_at.day && m.ns < first_at.ns)) first_at = m, night_start = moved;
      if (!have_span || m.day > last_at.day || (m.day == last_at.day && m.ns > last_at.ns)) last_at = m, night_stop = moved;
      have_span = true;
    }
    seg->START_TIME = seg->OBSERVATIONS.front()->EPOCH;
    seg->STOP_TIME = seg->OBSERVATIONS.back()->EPOCH;
    const std::string at = "track." + std::to_string(tdms.size()) + ".";
    for (std::string entry : {item(at + "id", t.id), item(at + "object", t.object), item(at + "observations", o.rows.size()), item(at + "epochReference", references),
                              item(at + "epochShiftNanoseconds", shifts)}) {
      per_track.push_back(std::move(entry));
    }
    emitted += o.rows.size();
    tdm.SEGMENTS.push_back(std::move(seg));
    tdms.emplace_back(4096);
    FinishTDMBuffer(tdms.back(), CreateTDM(tdms.back(), &tdm));
  }

  // The station timing record: the site and the declared timing bias, for the estimator's consider parameters.
  GSTT g;
  g.STATION_ID = tracks.front().station;
  g.NAME = first.ORIG_SENSOR_ID;
  g.POSITION_X = site[0];
  g.POSITION_Y = site[1];
  g.POSITION_Z = site[2];
  g.POSITION_SIGMA_X = g.POSITION_SIGMA_Y = g.POSITION_SIGMA_Z = kNaN;
  g.VELOCITY_X = g.VELOCITY_Y = g.VELOCITY_Z = kNaN;
  g.CLOCK_OFFSET_S = bias;
  g.CLOCK_TIME_SCALE = "UTC";
  g.VALID_FROM = night_start;
  g.VALID_TO = night_stop;
  g.SOURCE = kSource;
  flatbuffers::FlatBufferBuilder gb(512);
  FinishGSTBuffer(gb, CreateGST(gb, &g));

  PVNT pvn;
  pvn.SOURCE_ID = kSource;
  pvn.SOURCE_KIND = pvnSourceKind::Observation;
  pvn.ORIGINATOR = tracks.front().station;
  pvn.PROVIDER_ID = "optical.satnogs.org";
  pvn.PRODUCER = std::string(kPluginId) + " " + kVersion;
  pvn.LICENSE_CLASS = pvnLicenseClass::ShareAlike;
  pvn.LICENSE_ID = kLicense;
  pvn.LINEAGE = kSource;
  pvn.SOURCE_URL = kDataUrl;
  pvn.SOURCE_VERSION = text(night->CREATION_DATE());
  flatbuffers::FlatBufferBuilder pb(512);
  FinishPVNBuffer(pb, CreatePVN(pb, &pvn));

  R::IngestRequestT ingest;
  ingest.SCHEMA = "TDM.fbs";
  ingest.TAGS = std::make_unique<R::SourceTagsT>();
  ingest.TAGS->PROVIDER_ID = "optical.satnogs.org";
  ingest.TAGS->SOURCE_NAME = kSource;
  ingest.TAGS->BATCH_ID = tracks.front().station + " " + night_start.substr(0, 10);
  ingest.TAGS->SOURCE_URL = kDataUrl;
  ingest.TAGS->CONTENT_KEY_ID = "public";
  ingest.TAGS->SOURCE_PEER = "source:satnogs-optical";
  ingest.TAGS->LICENSE = kLicense;
  ingest.TAGS->LICENSE_URL = kLicenseUrl;
  ingest.TAGS->CITATION = kCredit;
  ingest.TAGS->SHARE_ALIKE = true;
  ingest.RECONCILE = R::reconcileMode_Duplicates;
  ingest.PROVENANCE = std::make_unique<R::ProvenanceT>();
  ingest.PROVENANCE->SOURCE_URL = kDataUrl;
  ingest.PROVENANCE->PARSER = kPluginId;
  ingest.PROVENANCE->PARSER_VERSION = kVersion;
  ingest.PROVENANCE->NORMALIZED_COUNT = tdms.size();
  ingest.PROVENANCE->SCHEMAS = {"TDM", "EOO", "GST", "PVN"};
  ingest.PROVENANCE->SCHEMA_COUNTS = {tdms.size(), eoos.size(), 1, 1};
  for (auto [name, value] : {std::pair<const char*, std::string>{"class", kClass}, {"credit", kCredit}, {"source", kSource}}) {
    auto h = std::make_unique<R::HeaderT>();
    h->NAME = name;
    h->VALUE = value;
    ingest.PROVENANCE->ATTRIBUTES.push_back(std::move(h));
  }
  flatbuffers::FlatBufferBuilder ib(1024);
  R::FinishIngestRequestBuffer(ib, R::IngestRequest::Pack(ib, &ingest));

  items = {item("format", "satnogs-optical station-night"), item("station", tracks.front().station), item("tracks", tracks.size()), item("measurements", measurements.size()),
           item("tracksEmitted", tdms.size()), item("observationsEmitted", emitted), item("refused", refused.size()), item("belowMinimum", below_minimum),
           item("filteredOut", filtered_out), item("minimumMeasurements", config.minimum), item("siteLatitudeDegrees", lat), item("siteLongitudeDegrees", lon),
           item("siteHeightMetres", alt_km * 1000.0), item("timingBiasSeconds", bias), item("license", kLicense), item("credit", kCredit)};
  for (const auto& [reason, n] : refused_by_reason) items.push_back(item("refusedFor." + reason, n));
  items.insert(items.end(), per_track.begin(), per_track.end());
  items.insert(items.end(), refused.begin(), refused.end());
  R::FlowNoticeT notice;
  notice.KIND = R::flowNoticeKind_Info;
  notice.SCHEMA = "TDM";
  notice.SOURCE_NAME = kSource;
  notice.REASON = kSource;
  notice.COUNT = tdms.size();
  notice.ITEMS = std::move(items);
  flatbuffers::FlatBufferBuilder nb(4096);
  R::FinishFlowNoticeBuffer(nb, R::FlowNotice::Pack(nb, &notice));

  if (push("report", "FlowNotice.fbs", R::FlowNoticeIdentifier(), "FlowNotice", nb) < 0) return 1;
  if (push("ingest", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest", ib) < 0) return 1;
  if (push("provenance", "PVN.fbs", "$PVN", "PVN", pb) < 0) return 1;
  if (push("stations", "GST.fbs", "$GST", "GST", gb) < 0) return 1;
  for (const auto& b : tdms) {
    if (push("observations", "TDM.fbs", "$TDM", "TDM", b) < 0) return 1;
  }
  for (const auto& b : eoos) {
    if (push("uncertainty", "EOO.fbs", "$EOO", "EOO", b) < 0) return 1;
  }
  return 0;
}
