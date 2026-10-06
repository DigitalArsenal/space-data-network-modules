#include "conjunction/ephemeris_upload.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/earth_orientation.h"
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <sstream>
extern "C" {
int eraCal2jd(int, int, int, double *, double *);
int eraDtf2d(const char *, int, int, int, int, int, double, double *, double *);
int eraJd2cal(double, double, int *, int *, int *, double *);
}
namespace conjunction {
namespace upload {
std::string upload_trim(const std::string &s) {
  auto a = s.find_first_not_of(" \t\r\n"), b = s.find_last_not_of(" \t\r\n");
  return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}
std::string upload_upper(std::string s) {
  for (auto &c : s)
    c = std::toupper(static_cast<unsigned char>(c));
  return s;
}
std::vector<std::string> words(std::string s) {
  std::replace(s.begin(), s.end(), ',', ' ');
  std::istringstream in(s);
  std::vector<std::string> out;
  std::string w;
  while (in >> w)
    out.push_back(w);
  return out;
}
bool number(std::string s, double &x) {
  std::replace(s.begin(), s.end(), 'D', 'E');
  std::replace(s.begin(), s.end(), 'd', 'e');
  char *end = nullptr;
  x = std::strtod(s.c_str(), &end);
  return end != s.c_str() && !*end && std::isfinite(x);
}
bool timestamp(const std::string &input, bool short_year, std::string &iso,
               double &jd, double *rounding_seconds) {
  std::string s = upload_trim(input);
  int y = 0, m = 0, d = 0, h = 0, min = 0, n = 0;
  double sec = 0;
  if (s.size() > 10 && (s[4] == '-' || s[4] == '/')) {
    char sep = s[4];
    if (sep == '/')
      std::replace(s.begin(), s.end(), '/', '-');
    if (s.size() > 10 && s[10] == ' ')
      s[10] = 'T';
    if (s.size() < 19 || s[7] != '-' || s[10] != 'T' || s[13] != ':' ||
        s[16] != ':')
      return false;
    for (size_t i : {0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18})
      if (!std::isdigit(static_cast<unsigned char>(s[i])))
        return false;
    size_t end = 19;
    if (end < s.size() && s[end] == '.') {
      size_t begin = ++end;
      while (end < s.size() && std::isdigit(static_cast<unsigned char>(s[end])))
        ++end;
      if (end == begin)
        return false;
    }
    const auto suffix = upload_trim(s.substr(end));
    if (!suffix.empty() && suffix != "Z" && suffix != "UTC")
      return false;
    if (std::sscanf(s.c_str(), "%4d-%2d-%2dT%2d:%2d:%lf%n", &y, &m, &d, &h,
                    &min, &sec, &n) != 6)
      return false;
    auto tail = upload_trim(s.substr(n));
    if (!tail.empty() && tail != "Z" && tail != "UTC")
      return false;
  } else {
    size_t width = short_year ? 2 : 4, whole = width + 9;
    if (s.size() < whole || (s.size() > whole && s[whole] != '.'))
      return false;
    for (size_t i = 0; i < whole; ++i)
      if (!std::isdigit(static_cast<unsigned char>(s[i])))
        return false;
    auto integer = [&](size_t p, size_t count) {
      return std::atoi(s.substr(p, count).c_str());
    };
    y = integer(0, width);
    if (short_year)
      y += y >= 57 ? 1900 : 2000;
    int doy = integer(width, 3);
    h = integer(width + 3, 2);
    min = integer(width + 5, 2);
    if (!number(s.substr(width + 7), sec))
      return false;
    bool leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    if (doy < 1 || doy > 365 + leap)
      return false;
    int days[] = {31, 28 + int(leap), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    m = 1;
    d = doy;
    while (d > days[m - 1])
      d -= days[m++ - 1];
  }
  double a, b;
  if (y < 1 || y > 9999 || h < 0 || h > 23 || min < 0 || min > 59 || sec < 0 ||
      sec >= 60 || eraDtf2d("UTC", y, m, d, h, min, sec, &a, &b) < 0 ||
      eraCal2jd(y, m, d, &a, &b) != 0)
    return false;
  // Strict UTC calendar dates; subsecond text retained independently of JD.
  // The existing screening clock is nominal UTC JD (86400 s/calendar day).
  // Preserve its rounding remainder for ERFA's two-part UTC conversion.
  eraCal2jd(y, m, d, &a, &b);
  const double midnight = a + b, seconds = h * 3600. + min * 60. + sec;
  jd = midnight + seconds / 86400.;
  if (rounding_seconds)
    *rounding_seconds = (midnight - jd) * 86400. + seconds;
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%012.9fZ", y, m, d,
                h, min, sec);
  iso = buf;
  return true;
}
bool itrf(const std::string &f) {
  return f == "ITRF" ||
         (f.rfind("ITRF", 0) == 0 && (f.size() == 6 || f.size() == 8) &&
          std::all_of(f.begin() + 4, f.end(), [](char c) {
            return std::isdigit(static_cast<unsigned char>(c));
          }));
}
bool state_frame(const std::string &f) { return f == "EME2000" || itrf(f); }
bool rtn(const std::string &f) {
  return f == "RTN" || f == "RSW" || f == "UVW";
}
std::unique_ptr<RFMT> rfm(const std::string &f) {
  auto r = std::make_unique<RFMT>();
  r->NAME = f;
  if (rtn(f)) {
    OrbitFrameWrapperT w;
    w.frame = OrbitFrame::RSW_INERTIAL;
    r->REFERENCE_FRAME.Set(std::move(w));
  } else if (f == "EME2000") {
    CelestialFrameWrapperT w;
    w.frame = CelestialFrame::EME2000;
    r->REFERENCE_FRAME.Set(std::move(w));
  } else {
    RFMCoordinateSystemWrapperT w;
    w.COORDINATE_SYSTEM = std::make_unique<RFMCoordinateSystemT>();
    auto &c = *w.COORDINATE_SYSTEM;
    c.NAME = f;
    c.AXIS_TYPE = rfmAxisType::BODY_FIXED;
    c.ORIGIN = std::make_unique<RFMOriginT>();
    c.ORIGIN->KIND = rfmOriginKind::CELESTIAL_BODY;
    c.ORIGIN->CELESTIAL_BODY_ID = 399;
    r->REFERENCE_FRAME.Set(std::move(w));
  }
  return r;
}
struct Row {
  std::string iso, frame;
  double jd, rounding_seconds = 0;
  std::array<double, 6> pv;
  size_t line;
};
struct Cov {
  std::string iso, frame;
  double jd;
  std::array<double, 21> lower;
  size_t line;
  bool explicit_frame = false;
};
std::unique_ptr<covarianceMatrixLineT> covariance(const Cov &c) {
  auto p = std::make_unique<covarianceMatrixLineT>();
  p->EPOCH = c.iso;
  double *fields[] = {&p->CX_X,         &p->CY_X,         &p->CY_Y,
                      &p->CZ_X,         &p->CZ_Y,         &p->CZ_Z,
                      &p->CX_DOT_X,     &p->CX_DOT_Y,     &p->CX_DOT_Z,
                      &p->CX_DOT_X_DOT, &p->CY_DOT_X,     &p->CY_DOT_Y,
                      &p->CY_DOT_Z,     &p->CY_DOT_X_DOT, &p->CY_DOT_Y_DOT,
                      &p->CZ_DOT_X,     &p->CZ_DOT_Y,     &p->CZ_DOT_Z,
                      &p->CZ_DOT_X_DOT, &p->CZ_DOT_Y_DOT, &p->CZ_DOT_Z_DOT};
  for (size_t i = 0; i < 21; ++i)
    *fields[i] = c.lower[i];
  return p;
}
} // namespace upload
bool parse_ephemeris_upload(const std::string &content,
                            const UploadOptions &opt, UploadResult &out) {
  using namespace upload;
  auto fail = [&](const char *code, const std::string &rule, size_t line) {
    out.code = code;
    out.message = rule + " (line " + std::to_string(line) + ")";
    return false;
  };
  if (content.empty() || content.size() > 16 * 1024 * 1024 ||
      content.find('\0') != std::string::npos)
    return fail("invalid-native-document",
                "Ephemeris must be nonempty text, at most 16 MiB, without NUL",
                1);
  if (!std::isfinite(opt.reference_jd) || opt.reference_jd <= 0)
    return fail("reference-epoch-required",
                "An explicit reference UTC epoch is required", 1);
  std::vector<std::string> lines;
  std::istringstream in(content);
  std::string line;
  while (std::getline(in, line))
    lines.push_back(upload_trim(line));
  auto first = std::find_if(lines.begin(), lines.end(),
                            [](auto &x) { return !x.empty(); });
  if (first == lines.end())
    return fail("invalid-native-document", "No ephemeris data", 1);
  std::string format = upload_upper(upload_trim(opt.format));
  if (format.empty() || format == "AUTO") {
    if (first->rfind("CCSDS_OEM_VERS", 0) == 0)
      format = "OEM";
    else if (first->rfind("CCSDS_OCM_VERS", 0) == 0)
      format = "OCM";
    else if (std::any_of(lines.begin(), lines.end(), [](auto &x) {
               auto w = words(x);
               return std::find(w.begin(), w.end(), "time") != w.end() &&
                      std::find(w.begin(), w.end(), "pos.x") != w.end() &&
                      std::find(w.begin(), w.end(), "vel.x") != w.end();
             }))
      format = "UTC";
    else if (content.find("JSpOC Format Ephemeris Report") != std::string::npos)
      format = "JSPOC";
    else {
      std::string iso;
      double jd;
      auto w = words(*first);
      format = w.size() == 7 && timestamp(w[0], true, iso, jd) ? "NASA"
                                                               : "MODIFIED_ITC";
    }
  }
  if (format == "MODIFIED ITC" || format == "ITC" || format == "MEME")
    format = "MODIFIED_ITC";
  out.format = format;
  if (format == "OCM")
    return fail("unsupported-format", "OCM is handled by S2", 1);
  if (first->front() == '<' ||
      (format != "OEM" && format != "MODIFIED_ITC" && format != "JSPOC" &&
       format != "NASA" && format != "UTC"))
    return fail("unsupported-format",
                "Supported formats: OEM KVN, Modified ITC, JSpOC, UTC, NASA; "
                "XML is unsupported",
                1);
  std::vector<Row> rows;
  std::vector<Cov> covs;
  std::string stateFrame = "EME2000", timeSystem = "UTC",
              objectId = opt.object_id, objectName = opt.object_name, covFrame;
  bool meta = false, inCov = false, sawMeta = false;
  size_t at = 0;
  out.oem.CCSDS_OEM_VERS = 2;
  if (format == "OEM") {
    stateFrame = "";
    timeSystem = "";
  }
  if (format == "MODIFIED_ITC") {
    if (lines.size() < 4)
      return fail(
          "invalid-state",
          "Modified ITC needs three header lines and a covariance frame",
          lines.size());
    covFrame = upload_upper(lines[3]);
    if (covFrame != "UVW" && covFrame != "EME2000")
      return fail("unsupported-covariance-frame",
                  "Modified ITC covariance frame must be UVW or EME2000", 4);
    at = 4;
  }
  for (; at < lines.size(); ++at) {
    const auto &l = lines[at];
    if (l.empty() || l.rfind("COMMENT", 0) == 0 || l[0] == '#')
      continue;
    if (format == "OEM") {
      if (l == "META_START") {
        meta = true;
        sawMeta = true;
        stateFrame = "";
        timeSystem = "";
        continue;
      }
      if (l == "META_STOP") {
        meta = false;
        continue;
      }
      if (l == "COVARIANCE_START") {
        inCov = true;
        continue;
      }
      if (l == "COVARIANCE_STOP") {
        inCov = false;
        continue;
      }
      auto eq = l.find('=');
      if (eq != std::string::npos) {
        auto key = upload_trim(l.substr(0, eq)),
             value = upload_trim(l.substr(eq + 1));
        if (key == "REF_FRAME")
          stateFrame = upload_upper(value);
        else if (key == "TIME_SYSTEM")
          timeSystem = upload_upper(value);
        else if (key == "CENTER_NAME" && upload_upper(value) != "EARTH")
          return fail("unsupported-frame", "OEM center must be EARTH", at + 1);
        else if (key == "OBJECT_ID" && opt.object_id.empty())
          objectId = value;
        else if (key == "OBJECT_NAME" && opt.object_name.empty())
          objectName = value;
        else if (key == "CREATION_DATE")
          out.oem.CREATION_DATE = value;
        else if (key == "ORIGINATOR")
          out.oem.ORIGINATOR = value;
        else if (key == "EPOCH" && inCov) {
          Cov c{};
          c.line = at + 1;
          c.frame = stateFrame;
          if (!timestamp(value, false, c.iso, c.jd))
            return fail("invalid-epoch", "Invalid covariance UTC epoch",
                        at + 1);
          size_t next = at + 1;
          while (next < lines.size() &&
                 (lines[next].empty() || lines[next].rfind("COMMENT", 0) == 0))
            ++next;
          if (next < lines.size() &&
              lines[next].rfind("COV_REF_FRAME", 0) == 0) {
            auto e = lines[next].find('=');
            if (e == std::string::npos)
              return fail("invalid-covariance", "COV_REF_FRAME needs '='",
                          next + 1);
            c.frame = upload_upper(upload_trim(lines[next].substr(e + 1)));
            c.explicit_frame = true;
            ++next;
          }
          if (!rtn(c.frame) && !state_frame(c.frame))
            return fail("unsupported-covariance-frame",
                        "OEM covariance frame must be RTN/RSW, ITRF or EME2000",
                        c.line);
          size_t k = 0;
          for (size_t n = 1; n <= 6; ++n, ++next) {
            while (
                next < lines.size() &&
                (lines[next].empty() || lines[next].rfind("COMMENT", 0) == 0))
              ++next;
            if (next >= lines.size())
              return fail("invalid-covariance",
                          "Covariance requires six lower-triangle rows",
                          c.line);
            auto w = words(lines[next]);
            if (w.size() != n)
              return fail("invalid-covariance",
                          "Covariance lower-triangle row has wrong length",
                          next + 1);
            for (auto &x : w)
              if (!number(x, c.lower[k++]))
                return fail("invalid-covariance",
                            "Covariance values must be finite", next + 1);
          }
          covs.push_back(c);
          at = next - 1;
        } else if (key == "COV_REF_FRAME")
          return fail(
              "covariance-frame-required",
              "COV_REF_FRAME must follow EPOCH in every covariance block",
              at + 1);
        continue;
      }
      if (meta || inCov)
        return fail("invalid-state",
                    "Unexpected OEM metadata or covariance line", at + 1);
      if (!sawMeta)
        return fail("invalid-state", "OEM requires META_START/META_STOP",
                    at + 1);
    }
    auto w = words(l);
    bool dateLooking =
        !w.empty() && std::isdigit(static_cast<unsigned char>(w[0][0]));
    if ((format == "UTC" || format == "JSPOC") && !dateLooking &&
        rows.empty()) {
      if (format == "UTC" && at >= 21)
        return fail("invalid-state", "UTC permits at most 21 header lines",
                    at + 1);
      if (format == "JSPOC") {
        auto sep = l.find_first_of(":=");
        if (sep != std::string::npos) {
          auto key = upload_upper(upload_trim(l.substr(0, sep))),
               value = upload_trim(l.substr(sep + 1));
          if (key.find("SPACECRAFT") != std::string::npos &&
              opt.object_name.empty())
            objectName = value;
          if (key.find("DATE") != std::string::npos) {
            std::string iso;
            double jd;
            if (timestamp(value, false, iso, jd))
              out.oem.CREATION_DATE = iso;
            else
              out.oem.CREATION_DATE = value;
          }
        }
      }
      continue;
    }
    Row r{};
    r.line = at + 1;
    r.frame = stateFrame;
    size_t offset = format == "UTC" ? 2 : 1;
    if (w.size() != offset + 6)
      return fail("invalid-state",
                  "State requires an epoch and six finite Cartesian components",
                  at + 1);
    std::string stamp = w[0] + (offset == 2 ? " " + w[1] : "");
    if (!timestamp(stamp, format == "NASA" || format == "JSPOC", r.iso, r.jd,
                   &r.rounding_seconds))
      return fail("invalid-epoch", "Invalid UTC state epoch", at + 1);
    if (timeSystem != "UTC")
      return fail("unsupported-time-system",
                  "State time system must be UTC at " + r.iso, at + 1);
    if (!state_frame(stateFrame))
      return fail("unsupported-frame",
                  "State frame must be EME2000 or an ITRF realization at " +
                      r.iso,
                  at + 1);
    for (size_t i = 0; i < 6; ++i)
      if (!number(w[offset + i], r.pv[i]))
        return fail("invalid-state",
                    "State components must be finite at " + r.iso, at + 1);
    rows.push_back(r);
    // Ported block layout from analysis/od/src/cpp/src/meme_parser.cpp:
    // three arbitrary headers, frame, then 7 state fields + 3x7 covariance.
    if (format == "MODIFIED_ITC") {
      Cov c{};
      c.iso = r.iso;
      c.jd = r.jd;
      c.frame = covFrame;
      c.line = at + 2;
      c.explicit_frame = true;
      for (size_t n = 0; n < 3; ++n) {
        if (++at >= lines.size())
          return fail("invalid-covariance",
                      "Modified ITC requires three covariance rows", c.line);
        auto values = words(lines[at]);
        if (values.size() != 7)
          return fail("invalid-covariance",
                      "Modified ITC covariance row requires seven values",
                      at + 1);
        for (size_t j = 0; j < 7; ++j)
          if (!number(values[j], c.lower[n * 7 + j]))
            return fail("invalid-covariance",
                        "Covariance values must be finite", at + 1);
      }
      covs.push_back(c);
    }
  }
  if (rows.empty())
    return fail("invalid-state", "Ephemeris contains no states", 1);
  if (meta || inCov)
    return fail("invalid-state", "Unclosed OEM metadata/covariance section",
                lines.size());
  size_t future = 0;
  double previous = 0;
  for (const auto &r : rows) {
    if (r.jd <= previous)
      return fail("non-increasing-epochs",
                  "State epochs must strictly increase at " + r.iso, r.line);
    previous = r.jd;
    future += r.jd > opt.reference_jd;
    double x = r.pv[0], y = r.pv[1], z = r.pv[2];
    if (r.frame == "EME2000") {
      // WGS84 is axial: UT1 spin cancels. Use the IAU pole to express the
      // ellipsoid in EME2000; no assumed UT1 enters screening.
      double j[6][6];
      EarthOrientation e;
      if (!itrf_to_inertial(r.jd, e, true, j))
        return fail("invalid-epoch", "UTC conversion failed", r.line);
      double p[3] = {x, y, z}, fixed[3] = {};
      for (int a = 0; a < 3; ++a)
        for (int b = 0; b < 3; ++b)
          fixed[a] += j[b][a] * p[b];
      x = fixed[0];
      y = fixed[1];
      z = fixed[2];
    }
    constexpr double a = 6378.137, b = a * (1 - 1 / 298.257223563);
    if ((x * x + y * y) / (a * a) + z * z / (b * b) < 1)
      return fail("below-earth-surface",
                  "Position is below the WGS-84 ellipsoid at " + r.iso, r.line);
    if (std::hypot(r.pv[3], r.pv[4], r.pv[5]) > 70)
      return fail("speed-limit", "Speed exceeds 70 km/s at " + r.iso, r.line);
  }
  if (future < 6)
    return fail("insufficient-future-states",
                "At least six states must be strictly after the reference UTC "
                "epoch; found " +
                    std::to_string(future),
                rows.back().line);
  double span = (rows.back().jd - rows.front().jd) * 86400. +
                rows.back().rounding_seconds - rows.front().rounding_seconds;
  if (span >= 21 * 86400.)
    return fail("span-too-long",
                "Ephemeris span must be under 21 days at " + rows.back().iso,
                rows.back().line);
  if (span < 42)
    return fail("span-too-short",
                "Ephemeris span must be at least 42 seconds at " +
                    rows.back().iso,
                rows.back().line);
  bool explicitCov = std::any_of(covs.begin(), covs.end(),
                                 [](auto &c) { return c.explicit_frame; });
  std::map<double, const Cov *> byEpoch;
  for (auto &c : covs) {
    if (explicitCov && !c.explicit_frame)
      return fail("covariance-frame-required",
                  "COV_REF_FRAME must appear in every covariance block at " +
                      c.iso,
                  c.line);
    // Extra covariance epochs are ignored; duplicates at a state are not 1:1.
    auto r = std::lower_bound(rows.begin(), rows.end(), c.jd,
                              [](auto &a, double b) { return a.jd < b; });
    if (r == rows.end() || r->jd != c.jd)
      continue;
    if (byEpoch.count(c.jd))
      return fail("duplicate-covariance",
                  "Covariance epochs must map 1:1 to states at " + c.iso,
                  c.line);
    if (!covariance_is_positive_semidefinite(c.lower.data(), 21))
      return fail("covariance-not-psd",
                  "Covariance must be positive semidefinite at " + c.iso,
                  c.line);
    byEpoch[c.jd] = &c;
  }
  ephemerisDataBlockT *block = nullptr;
  std::string priorFrame, priorCov;
  for (auto &r : rows) {
    auto found = byEpoch.find(r.jd);
    const Cov *c = found == byEpoch.end() ? nullptr : found->second;
    if (!covs.empty() && !c)
      return fail("missing-covariance",
                  "Every state must have covariance when any is present at " +
                      r.iso,
                  r.line);
    std::string cf = c ? c->frame : "";
    if (!block || r.frame != priorFrame || cf != priorCov) {
      auto b = std::make_unique<ephemerisDataBlockT>();
      b->CENTER_NAME = "EARTH";
      b->CENTER_NAIF_ID = 399;
      b->TIME_SYSTEM = timingStandard::UTC;
      b->REFERENCE_FRAME = rfm(r.frame);
      if (c)
        b->COV_REFERENCE_FRAME = rfm(cf);
      b->OBJECT = std::make_unique<CATT>();
      b->OBJECT->OBJECT_ID = objectId;
      b->OBJECT->OBJECT_NAME = objectName;
      b->INTERPOLATION = "HERMITE";
      b->INTERPOLATION_DEGREE = 3;
      b->START_TIME = r.iso;
      block = b.get();
      out.oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(b));
      priorFrame = r.frame;
      priorCov = cf;
    }
    auto p = std::make_unique<ephemerisDataLineT>();
    p->EPOCH = r.iso;
    p->X = r.pv[0];
    p->Y = r.pv[1];
    p->Z = r.pv[2];
    p->X_DOT = r.pv[3];
    p->Y_DOT = r.pv[4];
    p->Z_DOT = r.pv[5];
    block->EPHEMERIS_DATA_LINES.push_back(std::move(p));
    block->STOP_TIME = r.iso;
    if (c)
      block->COVARIANCE_MATRIX_LINES.push_back(covariance(*c));
  }
  out.states = rows.size();
  out.message = "valid; format=" + format +
                "; states=" + std::to_string(rows.size()) +
                "; future_states=" + std::to_string(future);
  return true;
}
} // namespace conjunction
