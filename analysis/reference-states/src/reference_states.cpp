#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "typedHostcall.hpp"

// Reference states: a precise-orbit product (SP3, read by files/orbit-products)
// as GCRF states in UTC per catalogued object, each with the product's stated
// accuracy as covariance, for calibrating orbit uncertainty against evidence
// independent of the catalog.
//
// Inputs (one SP3 file per call):
//   ephemeris          $OEM, one block per satellite, Earth-fixed, positions
//   descriptor         $NCD with the SP3 header and the file's SHA-256
//   earth_orientation  $EOP rows bracketing the file
// Config (plugin.getConfig, one ModuleConfig read in place by
// sdm_piv::get_config): product, source, satellites.<SP3 id>.{norad,
// objectId, name} (each SP3 satellite id -> catalogued object over the
// file's span), optional statedSigmaM with statedSigmaBasis.
// Output: reference, one $OEM per identified satellite.
//
// Time: GPS, Galileo and QZSS time are TAI - 19 s, BeiDou TAI - 33 s,
// GLONASS UTC + 3 h. Frame: ITRS -> GCRS by IAU 2006/2000A, CIO based, with
// the supplied polar motion, UT1-UTC, LOD and celestial-pole offsets.
// Velocity: the product's own when it carries one, else the derivative of the
// degree-9 Lagrange interpolant through the ten nearest gap-free epochs.
// Uncertainty, in order: the record's standard deviations (base^n mm per
// axis), the satellite's header accuracy (2^n mm), the accuracy the caller
// states with its basis. With none the call is refused: no default sigma.
// Velocity variance: the position variance through the derivative weights
// plus the squared degree-9 minus degree-7 difference (interpolation error,
// and the trace of an unflagged manoeuvre); the position-velocity term is the
// epoch's own derivative weight. All of it is rotated to GCRS with the
// Earth-rotation term.

namespace {

constexpr double kOmega = 7.292115146706979e-5;  // rad/s, IERS nominal Earth rotation
constexpr size_t kPoints = 10;                     // degree-9 interpolant

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

const plugin_input_frame_t* input(const char* port) {
  const int32_t index = plugin_find_input_index(port, 0);
  return index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
}

// A size-prefixed or plain root, verified.
template <typename T>
const T* root(const plugin_input_frame_t* f, const char* ident) {
  if (!f || !f->payload || f->payload_length < 8) return nullptr;
  const uint8_t* p = f->payload;
  const size_t n = f->payload_length;
  flatbuffers::Verifier::Options options;
  options.max_tables = 50000000;
  if (flatbuffers::BufferHasIdentifier(p, ident, true)) {
    flatbuffers::Verifier v(p, n, options);
    return v.VerifySizePrefixedBuffer<T>(ident) ? flatbuffers::GetSizePrefixedRoot<T>(p) : nullptr;
  }
  flatbuffers::Verifier v(p, n, options);
  return flatbuffers::BufferHasIdentifier(p, ident, false) && v.VerifyBuffer<T>(ident) ? flatbuffers::GetRoot<T>(p)
                                                                                      : nullptr;
}

std::string text(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

// Config lookups with the legacy defaults: "" for a missing string, -1 for a
// missing number.
std::string config_string(const sdm_piv::ConfigTable& c, std::string_view key) {
  return c.kind(key) == sdn::runtime::configValueKind_String ? std::string(c.string(key)) : std::string();
}
double config_number(const sdm_piv::ConfigTable& c, std::string_view key) {
  return c.kind(key, sdn::runtime::configValueKind_String) == sdn::runtime::configValueKind_Number ? c.number(key, -1.0)
                                                                                                  : -1.0;
}

struct Instant {
  double tai1, tai2, utc1, utc2;
};

// An epoch on the container's scale as TAI and UTC two-part Julian dates.
bool instant_of(const std::string& iso, timingStandard scale, Instant* out) {
  int y, mo, d, h, mi;
  double sec;
  if (!parse_iso_utc(iso.c_str(), &y, &mo, &d, &h, &mi, &sec)) return false;
  double a1, a2;
  auto from_tai = [&](double offset_s) {  // TAI = epoch + offset
    if (eraDtf2d("TAI", y, mo, d, h, mi, sec, &a1, &a2) != 0) return false;
    out->tai1 = a1;
    out->tai2 = a2 + offset_s / 86400.0;
    return eraTaiutc(out->tai1, out->tai2, &out->utc1, &out->utc2) == 0;
  };
  auto from_utc = [&](double offset_s) {  // UTC = epoch - offset
    double u1, u2;
    if (eraDtf2d("UTC", y, mo, d, h, mi, sec, &u1, &u2) != 0) return false;
    if (offset_s != 0.0) {  // GLONASS: move the calendar epoch by the whole offset in TAI
      if (eraUtctai(u1, u2, &a1, &a2) != 0) return false;
      a2 -= offset_s / 86400.0;
      if (eraTaiutc(a1, a2, &u1, &u2) != 0) return false;
    }
    out->utc1 = u1;
    out->utc2 = u2;
    return eraUtctai(u1, u2, &out->tai1, &out->tai2) == 0;
  };
  switch (scale) {
    case timingStandard::GPS:
    case timingStandard::GST:
    case timingStandard::QZSS: return from_tai(19.0);
    case timingStandard::BDT: return from_tai(33.0);
    case timingStandard::TAI: return from_tai(0.0);
    case timingStandard::TT: return from_tai(-32.184);
    case timingStandard::UTC: return from_utc(0.0);
    case timingStandard::GLONASS: return from_utc(3.0 * 3600.0);
    default: return false;
  }
}

std::string utc_iso(const Instant& t) {
  int ihmsf[4], y, mo, d;
  if (eraD2dtf("UTC", 6, t.utc1, t.utc2, &y, &mo, &d, ihmsf) != 0) return {};
  char out[40];
  std::snprintf(out, sizeof(out), "%04d-%02d-%02dT%02d:%02d:%02d.%06dZ", y, mo, d, ihmsf[0], ihmsf[1], ihmsf[2],
                ihmsf[3]);
  return out;
}

double seconds_between(const Instant& a, const Instant& b) {  // b - a, TAI
  return ((b.tai1 - a.tai1) + (b.tai2 - a.tai2)) * 86400.0;
}

// SP3 coordinate systems are ITRF realizations (IGS20, IGc20, IGb14,
// ITRF2014, SLRF2020 ...), millimetres apart, below these products' accuracy.
bool itrf_realization(const std::string& name) {
  for (const char* p : {"IG", "ITR", "SLR"})
    if (name.rfind(p, 0) == 0) return true;
  return false;
}

// GCRS <- ITRS at one epoch: r_g = M r, v_g = M v + N r with
// M = Q^T R3(ERA)^T W^T and N = Q^T R3(ERA)^T [w]x W^T.
struct EarthRotation {
  double m[3][3], n[3][3];
};

std::string earth_rotation(const Instant& t, EarthRotation* out) {
  ax::EarthOrientation eop;
  const EOP* provenance = nullptr;
  bool supplied = false;
  const std::string error = read_eop_table(t.utc1, t.utc2, &eop, &provenance, &supplied);
  if (!error.empty()) return error;
  if (!supplied) return "Earth orientation rows are required.";
  double t1, t2, b1, b2;
  if (eraTaitt(t.tai1, t.tai2, &t1, &t2) || eraUtcut1(t.utc1, t.utc2, eop.dut1, &b1, &b2))
    return "Epoch outside the leap-second table.";
  double x, y;
  eraXy06(t1, t2, &x, &y);
  const double s = eraS06(t1, t2, x, y);
  double rc2i[3][3], rpom[3][3], c2t[3][3];
  eraC2ixys(x + eop.dX, y + eop.dY, s, rc2i);
  eraPom00(eop.xPole, eop.yPole, eraSp00(t1, t2), rpom);
  const double era = eraEra00(b1, b2);
  eraC2tcio(rc2i, era, rpom, c2t);  // ITRS <- GCRS
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) out->m[i][j] = c2t[j][i];
  // N = Q^T R3^T [w]x W^T; Q^T R3^T = M W, and W^T = W^-1.
  const double w = kOmega * (1.0 - eop.lengthOfDay / 86400.0);
  const double omega[3][3] = {{0, -w, 0}, {w, 0, 0}, {0, 0, 0}};
  double mw[3][3], mwo[3][3];
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) {
      mw[i][j] = 0;
      for (int k = 0; k < 3; ++k) mw[i][j] += out->m[i][k] * rpom[k][j];
    }
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) {
      mwo[i][j] = 0;
      for (int k = 0; k < 3; ++k) mwo[i][j] += mw[i][k] * omega[k][j];
    }
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) {
      out->n[i][j] = 0;
      for (int k = 0; k < 3; ++k) out->n[i][j] += mwo[i][k] * rpom[j][k];
    }
  return {};
}

// Derivative weights at t of the Lagrange interpolant through ts.
void derivative_weights(const double* ts, size_t n, double t, double* w) {
  for (size_t j = 0; j < n; ++j) {
    double denom = 1.0;
    for (size_t m = 0; m < n; ++m)
      if (m != j) denom *= ts[j] - ts[m];
    double num = 0.0;
    for (size_t k = 0; k < n; ++k) {
      if (k == j) continue;
      double prod = 1.0;
      for (size_t m = 0; m < n; ++m)
        if (m != j && m != k) prod *= t - ts[m];
      num += prod;
    }
    w[j] = num / denom;
  }
}

struct Sample {
  Instant at;
  double t;  // seconds from the block's first epoch, TAI
  double r[3], v[3];
  double sigma_mm[3];  // record standard deviation per axis, 0 when absent
};

// The window of n consecutive samples nearest i, clamped to the ends.
size_t window_start(size_t i, size_t count, size_t n) {
  size_t lo = i >= n / 2 ? i - n / 2 : 0;
  return lo + n > count ? count - n : lo;
}

}  // namespace

extern "C" int reference_states() {
  const OEM* oem = root<OEM>(input("ephemeris"), "$OEM");
  if (!oem || !oem->EPHEMERIS_DATA_BLOCK())
    return fail("invalid-ephemeris", "ephemeris must be a verifiable $OEM with blocks.");
  const NCD* ncd = root<NCD>(input("descriptor"), "$NCD");
  if (!ncd || !ncd->SP3_HEADER())
    return fail("invalid-descriptor", "descriptor must be a verifiable $NCD with an SP3 header.");
  const NCDSP3Header* header = ncd->SP3_HEADER();
  const std::string coordinates = text(header->COORDINATE_SYSTEM());
  if (!itrf_realization(coordinates))
    return fail("unsupported-frame", "SP3 coordinate system '" + coordinates + "' is not an ITRF realization.");

  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) return fail("missing-identities", "plugin.getConfig failed: " + config.error_message());
  const sdm_piv::ConfigTable satellites = config.table("satellites");
  if (!satellites)
    return fail("invalid-identities", "config must hold a satellites object (SP3 satellite id -> catalogued object).");
  const std::string product = config_string(config, "product");
  const std::string source = config_string(config, "source");
  const double stated_sigma_m = config_number(config, "statedSigmaM");
  const std::string stated_basis = config_string(config, "statedSigmaBasis");
  if (stated_sigma_m > 0 && stated_basis.empty())
    return fail("invalid-identities", "statedSigmaM needs statedSigmaBasis: where the accuracy is stated.");

  // Header accuracy per satellite, 2^n mm; 0 is the SP3 "unknown".
  std::map<std::string, int> header_accuracy;
  if (header->SATELLITE_IDS() && header->SATELLITE_ACCURACY_EXPONENTS())
    for (flatbuffers::uoffset_t i = 0;
         i < header->SATELLITE_IDS()->size() && i < header->SATELLITE_ACCURACY_EXPONENTS()->size(); ++i)
      header_accuracy[header->SATELLITE_IDS()->Get(i)->str()] = header->SATELLITE_ACCURACY_EXPONENTS()->Get(i);
  const double base = header->POSITION_VELOCITY_BASE();
  const double interval = header->EPOCH_INTERVAL_SECONDS();
  std::map<std::string, EarthRotation> rotations;  // per epoch, shared by the satellites

  int emitted = 0;
  for (const ephemerisDataBlock* block : *oem->EPHEMERIS_DATA_BLOCK()) {
    if (!block || !block->OBJECT()) continue;
    const std::string sat = text(block->OBJECT()->OBJECT_ID());
    if (!satellites.has(sat)) continue;  // not a catalogued object over this span
    const sdm_piv::ConfigTable who = satellites.table(sat);
    if (!who || config_number(who, "norad") <= 0)
      return fail("invalid-identities", sat + " has no norad number.");
    const uint32_t norad = static_cast<uint32_t>(config_number(who, "norad"));
    const auto* lines = block->EPHEMERIS_DATA_LINES();
    if (!lines)
      return fail("invalid-ephemeris", sat + ": expected per-epoch lines (the SP3 projection of read_container).");
    if (lines->size() < kPoints)
      return fail("invalid-ephemeris", sat + ": needs at least 10 epochs for the degree-9 interpolant.");

    std::vector<Sample> samples;
    bool has_velocity = false;
    for (const ephemerisDataLine* l : *lines) {
      Sample s{};
      if (!instant_of(text(l->EPOCH()), block->TIME_SYSTEM(), &s.at))
        return fail("unsupported-time-system", sat + ": epoch '" + text(l->EPOCH()) + "' on an unsupported scale.");
      s.t = samples.empty() ? 0.0 : seconds_between(samples.front().at, s.at);
      if (!samples.empty() && s.t <= samples.back().t)
        return fail("invalid-ephemeris", sat + ": epochs must increase.");
      s.r[0] = l->X(); s.r[1] = l->Y(); s.r[2] = l->Z();
      s.v[0] = l->X_DOT(); s.v[1] = l->Y_DOT(); s.v[2] = l->Z_DOT();
      has_velocity = has_velocity || s.v[0] != 0 || s.v[1] != 0 || s.v[2] != 0;
      // The reader omits a blank column (SP3 "unknown"); a present one is base^n mm.
      const auto* table = reinterpret_cast<const flatbuffers::Table*>(l);
      const int8_t e[3] = {l->X_SIGMA_EXPONENT(), l->Y_SIGMA_EXPONENT(), l->Z_SIGMA_EXPONENT()};
      const flatbuffers::voffset_t vt[3] = {ephemerisDataLine::VT_X_SIGMA_EXPONENT,
                                            ephemerisDataLine::VT_Y_SIGMA_EXPONENT,
                                            ephemerisDataLine::VT_Z_SIGMA_EXPONENT};
      for (int k = 0; k < 3; ++k)
        if (base > 0 && table->CheckField(vt[k])) s.sigma_mm[k] = std::pow(base, e[k]);
      samples.push_back(s);
    }
    double step = interval;
    if (step <= 0) {
      step = samples[1].t - samples[0].t;
      for (size_t i = 2; i < samples.size(); ++i) step = std::fmin(step, samples[i].t - samples[i - 1].t);
    }
    const double header_mm =
        header_accuracy.count(sat) && header_accuracy[sat] > 0 ? std::pow(2.0, header_accuracy[sat]) : 0.0;

    flatbuffers::FlatBufferBuilder fbb(1 << 16);
    std::vector<flatbuffers::Offset<ephemerisDataLine>> out_lines;
    std::vector<flatbuffers::Offset<covarianceMatrixLine>> out_cov;
    std::string sigma_basis;
    size_t skipped = 0;
    const Instant* first = nullptr;
    const Instant* last = nullptr;
    for (size_t i = 0; i < samples.size(); ++i) {
      // Derivative weights over the ten nearest epochs (relative times for
      // conditioning) and over the eight nearest inside them.
      const size_t lo = window_start(i, samples.size(), kPoints);
      bool gap = false;
      for (size_t k = lo + 1; k < lo + kPoints; ++k) gap = gap || samples[k].t - samples[k - 1].t > 1.5 * step;
      if (gap) {  // missing epochs nearby: no velocity this file can support
        ++skipped;
        continue;
      }
      double ts[kPoints], w9[kPoints], w7[kPoints - 2];
      for (size_t k = 0; k < kPoints; ++k) ts[k] = samples[lo + k].t - samples[i].t;
      const size_t lo7 = window_start(i - lo, kPoints, kPoints - 2);
      derivative_weights(ts, kPoints, 0.0, w9);
      derivative_weights(ts + lo7, kPoints - 2, 0.0, w7);
      double v9[3] = {0, 0, 0}, v7[3] = {0, 0, 0}, w2 = 0;
      for (size_t k = 0; k < kPoints; ++k) {
        for (int c = 0; c < 3; ++c) v9[c] += w9[k] * samples[lo + k].r[c];
        w2 += w9[k] * w9[k];
      }
      for (size_t k = 0; k < kPoints - 2; ++k)
        for (int c = 0; c < 3; ++c) v7[c] += w7[k] * samples[lo + lo7 + k].r[c];
      const double w_self = w9[i - lo];

      double sig[3];
      const Sample& s = samples[i];
      if (s.sigma_mm[0] > 0 && s.sigma_mm[1] > 0 && s.sigma_mm[2] > 0) {
        for (int c = 0; c < 3; ++c) sig[c] = s.sigma_mm[c] * 1e-6;
        char b[48];
        std::snprintf(b, sizeof(b), "%.4g", base);
        sigma_basis = std::string("the SP3 records' standard deviations (") + b + "^n mm per axis)";
      } else if (header_mm > 0) {
        for (double& x : sig) x = header_mm * 1e-6;
        sigma_basis = "the SP3 header accuracy for the satellite (2^n mm)";
      } else if (stated_sigma_m > 0) {
        for (double& x : sig) x = stated_sigma_m * 1e-3;
        sigma_basis = "the product accuracy stated by " + stated_basis;
      } else {
        return fail("unstated-uncertainty",
                    sat + ": the SP3 states no accuracy and none was stated for the product; no default is assumed.");
      }

      const std::string epoch = utc_iso(s.at);
      if (epoch.empty()) return fail("time-conversion-failed", sat + ": epoch outside the leap-second table.");
      auto found = rotations.find(epoch);
      if (found == rotations.end()) {
        EarthRotation rot;
        const std::string error = earth_rotation(s.at, &rot);
        if (!error.empty()) return fail("invalid-earth-orientation", epoch + ": " + error);
        found = rotations.emplace(epoch, rot).first;
      }
      const EarthRotation& rot = found->second;
      const double* v = has_velocity ? s.v : v9;
      double rg[3], vg[3];
      for (int a = 0; a < 3; ++a) {
        rg[a] = vg[a] = 0;
        for (int k = 0; k < 3; ++k) {
          rg[a] += rot.m[a][k] * s.r[k];
          vg[a] += rot.m[a][k] * v[k] + rot.n[a][k] * s.r[k];
        }
      }
      out_lines.push_back(CreateephemerisDataLineDirect(fbb, epoch.c_str(), rg[0], rg[1], rg[2], vg[0], vg[1], vg[2]));

      // Earth-fixed covariance C = [[D, w_self D], [w_self D, w2 D + T]],
      // D = diag(sig^2), T = diag((v9 - v7)^2); GCRS covariance J C J^T with
      // J = [[M, 0], [N, M]].
      double c[6][6] = {}, j[6][6] = {}, jc[6][6] = {}, g[6][6] = {};
      for (int k = 0; k < 3; ++k) {
        const double d = sig[k] * sig[k];
        c[k][k] = d;
        c[k][3 + k] = c[3 + k][k] = w_self * d;
        c[3 + k][3 + k] = w2 * d + (v9[k] - v7[k]) * (v9[k] - v7[k]);
      }
      for (int a = 0; a < 3; ++a)
        for (int b = 0; b < 3; ++b) {
          j[a][b] = j[3 + a][3 + b] = rot.m[a][b];
          j[3 + a][b] = rot.n[a][b];
        }
      for (int a = 0; a < 6; ++a)
        for (int b = 0; b < 6; ++b)
          for (int k = 0; k < 6; ++k) jc[a][b] += j[a][k] * c[k][b];
      for (int a = 0; a < 6; ++a)
        for (int b = 0; b < 6; ++b)
          for (int k = 0; k < 6; ++k) g[a][b] += jc[a][k] * j[b][k];
      out_cov.push_back(CreatecovarianceMatrixLineDirect(
          fbb, epoch.c_str(), g[0][0], g[1][0], g[1][1], g[2][0], g[2][1], g[2][2], g[3][0], g[3][1], g[3][2], g[3][3],
          g[4][0], g[4][1], g[4][2], g[4][3], g[4][4], g[5][0], g[5][1], g[5][2], g[5][3], g[5][4], g[5][5]));
      if (!first) first = &s.at;
      last = &s.at;
    }
    if (out_lines.empty()) continue;

    const std::string name = config_string(who, "name");
    const std::string object_id = config_string(who, "objectId");
    const auto name_offset = fbb.CreateString(name);
    const auto id_offset = fbb.CreateString(object_id);
    CATBuilder cat(fbb);
    if (!name.empty()) cat.add_OBJECT_NAME(name_offset);
    if (!object_id.empty()) cat.add_OBJECT_ID(id_offset);
    cat.add_NORAD_CAT_ID(norad);
    const auto cat_offset = cat.Finish();
    const auto frame = CreateRFMDirect(fbb, RFMUnion::CelestialFrameWrapper,
                                       CreateCelestialFrameWrapper(fbb, CelestialFrame::GCRF).Union(), 0, "GCRF");
    const auto cov_frame = CreateRFMDirect(fbb, RFMUnion::CelestialFrameWrapper,
                                           CreateCelestialFrameWrapper(fbb, CelestialFrame::GCRF).Union(), 0, "GCRF");
    char tail[160];
    std::snprintf(tail, sizeof(tail), "; %zu of %zu epochs without gap-free neighbours omitted.", skipped,
                  samples.size());
    const std::string comment =
        "Reference states from " + (product.empty() ? std::string("an SP3 product") : product) +
        (source.empty() ? std::string() : " (" + source + ")") + ", SP3 satellite " + sat + ", agency " +
        text(header->AGENCY()) + ", orbit type " + text(header->ORBIT_TYPE()) + ", file SHA-256 " +
        text(ncd->SOURCE_SHA256()) + ". " + coordinates + " to GCRF by IAU 2006/2000A (CIO) with the supplied EOP. " +
        "Velocity: " +
        (has_velocity ? std::string("the product's own") : std::string("derivative of the degree-9 Lagrange interpolant")) +
        ". Covariance: " + sigma_basis + "; velocity variance from the position variance and the degree-9 minus " +
        "degree-7 difference" + tail;
    const std::string start = utc_iso(*first), stop = utc_iso(*last);
    const auto out_block = CreateephemerisDataBlockDirect(
        fbb, comment.c_str(), cat_offset, "EARTH", frame, nullptr, cov_frame, timingStandard::UTC, start.c_str(),
        nullptr, nullptr, stop.c_str(), has_velocity ? nullptr : "LAGRANGE", has_velocity ? 0 : 9, 0.0, 6, nullptr,
        &out_lines, &out_cov, nullptr, 0, 399);
    const std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks{out_block};
    fbb.FinishSizePrefixed(CreateOEMDirect(fbb, nullptr, 3.0, nullptr, "reference-states", &blocks), "$OEM");
    if (plugin_push_output_ex("reference", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OEM", 0, 0,
                              fbb.GetBufferPointer(), fbb.GetSize()) < 0)
      return 1;
    ++emitted;
  }
  if (!emitted) return fail("no-reference-states", "No SP3 satellite matched a catalogued identity.");
  return 0;
}

// compare_to_reference: an ephemeris with its covariance (COMSPOC's SynCoPate
// files through files/orbit-products, for example) against reference states,
// at the reference's epochs.
//
// Inputs:
//   ephemeris  $OEM, block 0: TEME (TEMEOFDATE) or GCRF, UTC; states as
//              EPHEMERIS_DATA (uniform) or EPHEMERIS_DATA_LINES; covariance
//              lines optional, in the block's own frame.
//   reference  $OEM, block 0: GCRF, or EME2000 (rotated by the IAU 2006 frame
//              bias), UTC, EPHEMERIS_DATA_LINES.
// Outputs:
//   residuals  $OEM, one GCRF/UTC block: per reference epoch inside the
//              ephemeris span, the position error (reference minus
//              ephemeris, km) as the line's X/Y/Z and, with covariance, the
//              ephemeris's GCRF position covariance at that epoch (km^2)
//              as a covariance line (its Mahalanobis distance squared and
//              sigmas follow from the two).
//   report     $CVR: MEAN_D2_OVER_3 and COVERAGE_95 (d2 <= 7.8147, the 0.95
//              point of chi-square with 3 degrees of freedom) over SAMPLES
//              epochs with covariance (NaN without), TEST_WINDOW the compared
//              span, EVIDENCE the frames, degree and compared/outside counts.
//
// Interpolation: the block's degree (INTERPOLATION_DEGREE, 5 when absent)
// Lagrange interpolant through the nearest degree + 1 states, and the same
// interpolant through the nearest covariance rows for each of the six
// position-block elements. TEME -> GCRF at each epoch is the foundation/frames
// IAU 2006/2000A chain with the equation of the equinoxes; UT1 does not enter.
namespace {

struct Row {
  double t;  // seconds from the first state, TAI
  double v[6];
};

// Lagrange weights at t through ts.
void value_weights(const double* ts, size_t n, double t, double* w) {
  for (size_t j = 0; j < n; ++j) {
    double p = 1.0;
    for (size_t m = 0; m < n; ++m)
      if (m != j) p *= (t - ts[m]) / (ts[j] - ts[m]);
    w[j] = p;
  }
}

// The window of n rows nearest t, clamped to the ends.
size_t nearest_window(const std::vector<Row>& rows, double t, size_t n) {
  size_t i = 0;
  while (i + 1 < rows.size() && rows[i + 1].t <= t) ++i;
  size_t lo = i + 1 >= n / 2 ? i + 1 - n / 2 : 0;
  return lo + n > rows.size() ? rows.size() - n : lo;
}

bool interpolate(const std::vector<Row>& rows, double t, size_t n, int count, double* out) {
  if (rows.size() < n || t < rows.front().t || t > rows.back().t) return false;
  const size_t lo = nearest_window(rows, t, n);
  double ts[16], w[16];
  for (size_t k = 0; k < n; ++k) ts[k] = rows[lo + k].t;
  value_weights(ts, n, t, w);
  for (int c = 0; c < count; ++c) {
    out[c] = 0.0;
    for (size_t k = 0; k < n; ++k) out[c] += w[k] * rows[lo + k].v[c];
  }
  return true;
}

std::string upper(std::string s) {
  for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  return s;
}

std::string frame_name(const RFM* f) { return f ? upper(text(f->NAME())) : std::string(); }

bool tt_of(const Instant& t, ax::Epoch* e) {
  e->ut11 = 0.0;
  e->ut12 = 0.0;
  return eraTaitt(t.tai1, t.tai2, &e->tt1, &e->tt2) == 0;
}

}  // namespace

extern "C" int compare_to_reference() {
  const OEM* eph = root<OEM>(input("ephemeris"), "$OEM");
  const OEM* ref = root<OEM>(input("reference"), "$OEM");
  if (!eph || !eph->EPHEMERIS_DATA_BLOCK() || eph->EPHEMERIS_DATA_BLOCK()->size() == 0)
    return fail("invalid-ephemeris", "ephemeris must be a verifiable $OEM with a block.");
  if (!ref || !ref->EPHEMERIS_DATA_BLOCK() || ref->EPHEMERIS_DATA_BLOCK()->size() == 0)
    return fail("invalid-reference", "reference must be a verifiable $OEM with a block.");
  const ephemerisDataBlock* eb = eph->EPHEMERIS_DATA_BLOCK()->Get(0);
  const ephemerisDataBlock* rb = ref->EPHEMERIS_DATA_BLOCK()->Get(0);
  if (eb->TIME_SYSTEM() != timingStandard::UTC || rb->TIME_SYSTEM() != timingStandard::UTC)
    return fail("unsupported-time-system", "both ephemerides must be in UTC.");
  const std::string ef = frame_name(eb->REFERENCE_FRAME());
  const bool teme = ef == "TEME" || ef == "TEMEOFDATE";
  if (!teme && ef != "GCRF") return fail("unsupported-frame", "ephemeris frame '" + ef + "' is not TEME or GCRF.");
  const std::string rf = frame_name(rb->REFERENCE_FRAME());
  const bool eme = rf == "EME2000" || rf == "J2000";
  if (!eme && rf != "GCRF") return fail("unsupported-frame", "reference frame '" + rf + "' is not GCRF or EME2000.");
  const std::string cf = frame_name(eb->COV_REFERENCE_FRAME());
  if (eb->COVARIANCE_MATRIX_LINES() && !cf.empty() && cf != ef)
    return fail("unsupported-frame", "covariance frame '" + cf + "' differs from the states' '" + ef + "'.");

  // States on the TAI axis from the first.
  std::vector<Row> states;
  Instant t0{};
  bool have_t0 = false;
  auto add_state = [&](const std::string& iso, const double* r) {
    Instant at;
    if (!instant_of(iso, timingStandard::UTC, &at)) return false;
    if (!have_t0) { t0 = at; have_t0 = true; }
    Row row{seconds_between(t0, at), {r[0], r[1], r[2], 0, 0, 0}};
    states.push_back(row);
    return true;
  };
  if (eb->EPHEMERIS_DATA_LINES() && eb->EPHEMERIS_DATA_LINES()->size() > 0) {
    for (const ephemerisDataLine* l : *eb->EPHEMERIS_DATA_LINES()) {
      const double r[3] = {l->X(), l->Y(), l->Z()};
      if (!add_state(text(l->EPOCH()), r)) return fail("invalid-epoch", "unreadable ephemeris epoch.");
    }
  } else if (eb->EPHEMERIS_DATA() && eb->STEP_SIZE() > 0 && eb->STATE_VECTOR_SIZE() >= 3) {
    Instant start;
    if (!instant_of(text(eb->START_TIME()), timingStandard::UTC, &start)) return fail("invalid-epoch", "unreadable START_TIME.");
    t0 = start;
    have_t0 = true;
    const size_t width = eb->STATE_VECTOR_SIZE();
    const auto* data = eb->EPHEMERIS_DATA();
    for (size_t k = 0; k + width <= data->size(); k += width) {
      Row row{static_cast<double>(k / width) * eb->STEP_SIZE(), {data->Get(k), data->Get(k + 1), data->Get(k + 2), 0, 0, 0}};
      states.push_back(row);
    }
  }
  const size_t degree = eb->INTERPOLATION_DEGREE() > 0 ? eb->INTERPOLATION_DEGREE() : 5;
  const size_t n = degree + 1;
  if (n > 16) return fail("unsupported-interpolation", "interpolation degree above 15.");
  if (states.size() < n) return fail("not-enough-states", "fewer states than the interpolant needs.");

  std::vector<Row> covariance;  // the six position-block elements
  if (eb->COVARIANCE_MATRIX_LINES()) {
    for (const covarianceMatrixLine* c : *eb->COVARIANCE_MATRIX_LINES()) {
      Instant at;
      if (!instant_of(text(c->EPOCH()), timingStandard::UTC, &at)) return fail("invalid-epoch", "unreadable covariance epoch.");
      covariance.push_back({seconds_between(t0, at), {c->CX_X(), c->CY_X(), c->CY_Y(), c->CZ_X(), c->CZ_Y(), c->CZ_Z()}});
    }
  }
  const bool with_cov = covariance.size() >= n;

  // EME2000 -> GCRF: the transpose of the IAU 2006 frame bias.
  double bias[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
  if (eme) {
    double rbm[3][3], rp[3][3], rbp[3][3];
    eraBp06(2451545.0, 0.0, rbm, rp, rbp);
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j) bias[i][j] = rbm[j][i];
  }

  flatbuffers::FlatBufferBuilder fbb(1 << 16);
  std::vector<flatbuffers::Offset<ephemerisDataLine>> res_lines;
  std::vector<flatbuffers::Offset<covarianceMatrixLine>> res_cov;
  std::string first_epoch, last_epoch;
  size_t outside = 0, n_d2 = 0, inside95 = 0;
  double sum_d2 = 0.0;
  if (rb->EPHEMERIS_DATA_LINES()) {
    for (const ephemerisDataLine* l : *rb->EPHEMERIS_DATA_LINES()) {
      const std::string iso = text(l->EPOCH());
      Instant at;
      if (!instant_of(iso, timingStandard::UTC, &at)) return fail("invalid-epoch", "unreadable reference epoch.");
      const double t = seconds_between(t0, at);
      double r[3];
      if (!interpolate(states, t, n, 3, r)) { ++outside; continue; }
      ax::Mat3 m;  // ephemeris frame -> GCRF
      if (teme) {
        ax::Epoch e;
        if (!tt_of(at, &e)) { ++outside; continue; }
        m = ax::transpose(ax::gcrfToTeme(e));
      }
      const ax::Vec3 pg = ax::apply(m, {r[0], r[1], r[2]});
      double q[3] = {l->X(), l->Y(), l->Z()}, qg[3];
      for (int i = 0; i < 3; ++i) qg[i] = bias[i][0] * q[0] + bias[i][1] * q[1] + bias[i][2] * q[2];
      const double err[3] = {qg[0] - pg.x, qg[1] - pg.y, qg[2] - pg.z};
      res_lines.push_back(CreateephemerisDataLineDirect(fbb, iso.c_str(), err[0], err[1], err[2]));
      if (first_epoch.empty()) first_epoch = iso;
      last_epoch = iso;
      double c[6];
      if (with_cov && interpolate(covariance, t, n, 6, c)) {
        // P in the ephemeris frame, then M P M^T.
        const double p[3][3] = {{c[0], c[1], c[3]}, {c[1], c[2], c[4]}, {c[3], c[4], c[5]}};
        double mp[3][3], g[3][3];
        for (int i = 0; i < 3; ++i)
          for (int j = 0; j < 3; ++j) {
            mp[i][j] = 0;
            for (int k = 0; k < 3; ++k) mp[i][j] += m.m[i][k] * p[k][j];
          }
        for (int i = 0; i < 3; ++i)
          for (int j = 0; j < 3; ++j) {
            g[i][j] = 0;
            for (int k = 0; k < 3; ++k) g[i][j] += mp[i][k] * m.m[j][k];
          }
        const double det = g[0][0] * (g[1][1] * g[2][2] - g[1][2] * g[2][1]) -
                           g[0][1] * (g[1][0] * g[2][2] - g[1][2] * g[2][0]) +
                           g[0][2] * (g[1][0] * g[2][1] - g[1][1] * g[2][0]);
        if (det > 0.0 && std::isfinite(det)) {
          const double inv[3][3] = {
              {(g[1][1] * g[2][2] - g[1][2] * g[2][1]) / det, (g[0][2] * g[2][1] - g[0][1] * g[2][2]) / det,
               (g[0][1] * g[1][2] - g[0][2] * g[1][1]) / det},
              {(g[1][2] * g[2][0] - g[1][0] * g[2][2]) / det, (g[0][0] * g[2][2] - g[0][2] * g[2][0]) / det,
               (g[0][2] * g[1][0] - g[0][0] * g[1][2]) / det},
              {(g[1][0] * g[2][1] - g[1][1] * g[2][0]) / det, (g[0][1] * g[2][0] - g[0][0] * g[2][1]) / det,
               (g[0][0] * g[1][1] - g[0][1] * g[1][0]) / det}};
          double d2 = 0.0;
          for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) d2 += err[i] * inv[i][j] * err[j];
          res_cov.push_back(
              CreatecovarianceMatrixLineDirect(fbb, iso.c_str(), g[0][0], g[1][0], g[1][1], g[2][0], g[2][1], g[2][2]));
          sum_d2 += d2;
          ++n_d2;
          if (d2 <= 7.814727903251178) ++inside95;  // chi-square, 3 degrees of freedom, 0.95
        }
      }
    }
  }
  const size_t compared = res_lines.size();
  char evidence[256];
  std::snprintf(evidence, sizeof(evidence),
                "compare_to_reference: ephemeris %s vs reference %s; interpolation degree %zu; covariance %s; "
                "compared %zu, outside span %zu",
                ef.c_str(), rf.c_str(), degree, with_cov ? "yes" : "no", compared, outside);

  // residuals: one GCRF/UTC $OEM block.
  {
    const auto frame = CreateRFMDirect(fbb, RFMUnion::CelestialFrameWrapper,
                                       CreateCelestialFrameWrapper(fbb, CelestialFrame::GCRF).Union(), 0, "GCRF");
    const auto cov_frame = CreateRFMDirect(fbb, RFMUnion::CelestialFrameWrapper,
                                           CreateCelestialFrameWrapper(fbb, CelestialFrame::GCRF).Union(), 0, "GCRF");
    const std::string comment = std::string("Position residuals, reference minus ephemeris, km, GCRF; covariance lines: "
                                            "the ephemeris's GCRF position covariance, km^2. ") + evidence;
    const auto block = CreateephemerisDataBlockDirect(
        fbb, comment.c_str(), 0, "EARTH", frame, nullptr, res_cov.empty() ? 0 : cov_frame, timingStandard::UTC,
        first_epoch.empty() ? nullptr : first_epoch.c_str(), nullptr, nullptr,
        last_epoch.empty() ? nullptr : last_epoch.c_str(), nullptr, 0, 0.0, 3, nullptr, &res_lines,
        res_cov.empty() ? nullptr : &res_cov, nullptr, 0, 399);
    const std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks{block};
    fbb.FinishSizePrefixed(CreateOEMDirect(fbb, nullptr, 3.0, nullptr, "reference-states", &blocks), "$OEM");
    if (plugin_push_output_ex("residuals", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OEM", 0, 0,
                              fbb.GetBufferPointer(), fbb.GetSize()) < 0)
      return 500;
  }

  // report: the realism summary as $CVR.
  flatbuffers::FlatBufferBuilder cvr(1024);
  const std::string window = first_epoch.empty() ? std::string() : first_epoch + "/" + last_epoch;
  const auto lineage = cvr.CreateString(std::string("ephemeris ") + ef + " vs reference " + rf);
  const auto window_offset = cvr.CreateString(window);
  const auto evidence_offset = cvr.CreateString(evidence);
  CVRBuilder b(cvr);
  b.add_MEASURED_LINEAGE(lineage);
  if (!window.empty()) b.add_TEST_WINDOW(window_offset);
  if (n_d2) {
    b.add_MEAN_D2_OVER_3(sum_d2 / (3.0 * static_cast<double>(n_d2)));
    b.add_COVERAGE_95(static_cast<double>(inside95) / static_cast<double>(n_d2));
    b.add_OBJECTS(1);
  }
  b.add_SAMPLES(static_cast<uint32_t>(n_d2));
  b.add_EVIDENCE(evidence_offset);
  cvr.FinishSizePrefixed(b.Finish(), "$CVR");
  if (plugin_push_output_ex("report", "CVR.fbs", "$CVR", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "CVR", 0, 0,
                            cvr.GetBufferPointer(), cvr.GetSize()) < 0)
    return 500;
  return 0;
}
