// finals2000a_precision.cpp — computable-outcome measurements for the IERS
// Earth-orientation reader (gmat-08-frames-and-state-representations).
//
// The authority is the PUBLISHED FILE ITSELF, vendored at
// fixtures/finals2000A.daily with its source URL and SHA-256 recorded in
// fixtures/PROVENANCE.md. Nothing here carries a hand-typed expectation: the
// expected values are re-read out of the file's own columns and compared with
// what the reader produced, so a refresh of the fixture needs no edit.
//
// The acceptance being measured:
//   "interpolated dUT1 and polar motion agree with the IERS finals2000A
//    published values to <= 1e-9 s / <= 1e-9 arcsec at the table nodes."
//
// It also measures the thing that made SDS grow double-precision `_HP` fields
// for this task: the SAME values pushed through float32 MISS that bar by two
// orders of magnitude. That is a number, not an argument.

#include "finals2000a.hpp"

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

using namespace sdn::loaders;

namespace {

int failures = 0;
int checks = 0;

void report(const char* name, double measured, double tolerance, const char* authority) {
  ++checks;
  const bool ok = std::isfinite(measured) && std::fabs(measured) <= tolerance;
  if (!ok) {
    ++failures;
  }
  std::printf("  %-56s %12.4e  (tol %8.1e)  %-6s  %s\n", name, measured, tolerance,
              ok ? "PASS" : "FAIL", authority);
}

void reportBool(const char* name, bool ok, const char* authority) {
  ++checks;
  if (!ok) {
    ++failures;
  }
  std::printf("  %-56s %12s  %*s  %-6s  %s\n", name, ok ? "true" : "false", 20, "",
              ok ? "PASS" : "FAIL", authority);
}

std::string readFile(const char* path) {
  std::FILE* file = std::fopen(path, "rb");
  if (file == nullptr) {
    return std::string();
  }
  std::string contents;
  char buffer[65536];
  size_t read = 0;
  while ((read = std::fread(buffer, 1, sizeof(buffer), file)) > 0) {
    contents.append(buffer, read);
  }
  std::fclose(file);
  return contents;
}

/// Re-read one fixed-column field straight out of the published line, so the
/// expected value is the file's digits and not a copy of them.
double publishedField(const std::string& line, int firstColumn, int lastColumn) {
  const std::string text = line.substr(static_cast<size_t>(firstColumn - 1),
                                       static_cast<size_t>(lastColumn - firstColumn + 1));
  return std::strtod(text.c_str(), nullptr);
}

}  // namespace

int main(int argc, char** argv) {
  const char* path = argc > 1 ? argv[1] : "fixtures/finals2000A.daily";
  const std::string document = readFile(path);
  if (document.empty()) {
    std::printf("FATAL: could not read the vendored finals2000A fixture at %s\n", path);
    return 1;
  }

  std::printf("finals2000A reader — vendored IERS fixture (%zu bytes)\n\n", document.size());

  const int parsed = parseDocument(document.c_str(), document.size());
  std::printf("parsed rows: %d\n\n", parsed);
  reportBool("the published file parses to at least 100 rows", parsed >= 100, "fixture");

  // Split the published file back into lines so each node's expectation is the
  // file's own text.
  std::vector<std::string> lines;
  size_t start = 0;
  while (start < document.size()) {
    size_t end = document.find('\n', start);
    if (end == std::string::npos) {
      end = document.size();
    }
    std::string line = document.substr(start, end - start);
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    if (line.size() > 60) {
      lines.push_back(line);
    }
    start = end + 1;
  }

  // ---- 1. At a table node, the value IS the published value ---------------
  std::printf("\nnode agreement — every node in the file, against its own columns:\n");
  {
    double worstUt1 = 0.0;
    double worstXPole = 0.0;
    double worstYPole = 0.0;
    double worstUt1AsFloat32 = 0.0;
    int compared = 0;

    for (const std::string& line : lines) {
      const double mjd = publishedField(line, 8, 15);
      Interpolated value;
      if (!interpolateAt(mjd, &value) || !value.atNode) {
        continue;
      }
      ++compared;

      const double publishedXPole = publishedField(line, 19, 27);
      const double publishedYPole = publishedField(line, 38, 46);
      const double publishedUt1 = publishedField(line, 59, 68);

      worstXPole = std::fmax(worstXPole, std::fabs(value.xPoleArcsec - publishedXPole));
      worstYPole = std::fmax(worstYPole, std::fabs(value.yPoleArcsec - publishedYPole));
      worstUt1 = std::fmax(worstUt1, std::fabs(value.ut1MinusUtcSeconds - publishedUt1));

      // The float32 round trip, measured on the SAME value. This is the whole
      // reason $EOP grew the `_HP` doubles.
      const float asFloat32 = static_cast<float>(publishedUt1);
      worstUt1AsFloat32 =
          std::fmax(worstUt1AsFloat32, std::fabs(static_cast<double>(asFloat32) - publishedUt1));
    }

    std::printf("  nodes compared: %d\n", compared);
    reportBool("every row in the file is reachable as a node", compared == parsed, "fixture");
    report("UT1-UTC at nodes vs published (s)", worstUt1, 1e-9, "IERS finals2000A");
    report("polar motion x at nodes vs published (arcsec)", worstXPole, 1e-9,
           "IERS finals2000A");
    report("polar motion y at nodes vs published (arcsec)", worstYPole, 1e-9,
           "IERS finals2000A");

    // Deliberately inverted: this check PASSES when float32 FAILS the bar.
    std::printf("\n  why the _HP doubles exist — the same values through float32:\n");
    std::printf("  %-56s %12.4e  (bar %8.1e)  %-6s  %s\n",
                "UT1-UTC error if carried as float32 (s)", worstUt1AsFloat32, 1e-9,
                worstUt1AsFloat32 > 1e-9 ? "AS EXPECTED" : "UNEXPECTED", "IEEE-754 binary32");
    ++checks;
    if (!(worstUt1AsFloat32 > 1e-9)) {
      ++failures;
      std::printf("  FAIL: float32 met the 1e-9 bar, which would mean the fixture is degenerate\n");
    }
  }

  // ---- 2. Between nodes: interpolation is linear and bracketed ------------
  std::printf("\ninterpolation between nodes:\n");
  if (rowCount() >= 2) {
    const EopRow& a = rows()[0];
    const EopRow& b = rows()[1];
    Interpolated middle;
    reportBool("a mid-node epoch resolves", interpolateAt((a.mjd + b.mjd) / 2.0, &middle),
               "exact");
    reportBool("a mid-node epoch is NOT reported as a node", !middle.atNode, "exact");
    report("midpoint UT1-UTC is the mean of its brackets (s)",
           middle.ut1MinusUtcSeconds - 0.5 * (a.ut1MinusUtcSeconds + b.ut1MinusUtcSeconds),
           1e-15, "exact");
  }

  // ---- 3. Outside the table: refuse, never extrapolate --------------------
  std::printf("\nrefusal outside the table:\n");
  {
    Interpolated ignored;
    reportBool("an epoch before the first row is refused",
               !interpolateAt(rows()[0].mjd - 0.5, &ignored), "no extrapolation");
    reportBool("an epoch after the last row is refused",
               !interpolateAt(rows()[rowCount() - 1].mjd + 0.5, &ignored), "no extrapolation");
  }

  // ---- 4. Leap seconds ----------------------------------------------------
  //
  // The step function is checked at published Bulletin C dates, which are the
  // authority for TAI-UTC. The values are the ones the IERS announced; a wrong
  // step here is a 1 s error in every UT1 that depends on it.
  std::printf("\nleap seconds (IERS Bulletin C):\n");
  {
    struct Case {
      const char* label;
      double mjd;
      double expected;
    };
    const Case cases[] = {
        {"1972-01-01 (TAI-UTC = 10)", 41317.0, 10.0},
        {"1999-01-01 (TAI-UTC = 32)", 51179.0, 32.0},
        {"2012-07-01 (TAI-UTC = 35)", 56109.0, 35.0},
        {"2017-01-01 (TAI-UTC = 37)", 57754.0, 37.0},
        {"2026-06-01 (still 37, none announced)", 61192.0, 37.0},
    };
    for (const Case& item : cases) {
      bool covered = false;
      const double measured = taiMinusUtcForMjd(item.mjd, &covered);
      char label[96];
      std::snprintf(label, sizeof(label), "TAI-UTC %s", item.label);
      report(label, covered ? measured - item.expected : 1.0, 0.0, "IERS Bulletin C");
    }
    bool covered = true;
    taiMinusUtcForMjd(41000.0, &covered);
    reportBool("a pre-1972 epoch is reported as uncovered, not zero", !covered,
               "IERS Bulletin C");
  }

  // ---- 5. The content identifier -----------------------------------------
  //
  // Themis ruled DATA_SET_CID is a CIDv1 raw/sha2-256 in base32, not a bare
  // digest. The value is printed so the suite can compare it against an
  // independently computed CID rather than against this program's own opinion.
  std::printf("\ncontent identifier:\n");
  {
    char cid[64];
    contentIdentifierV1(reinterpret_cast<const uint8_t*>(document.data()), document.size(), cid);
    std::printf("  CIDv1 raw/sha2-256 base32: %s\n", cid);
    reportBool("the CID is base32 CIDv1 (b-prefixed, 59 characters)",
               cid[0] == 'b' && std::strlen(cid) == 59, "multiformats");
    std::printf("REFERENCE_JSON_BEGIN\n{\"dataSetCid\": \"%s\", \"rows\": %d}\nREFERENCE_JSON_END\n",
                cid, parsed);
  }

  std::printf("\n%d checks, %d failures\n", checks, failures);
  std::printf("%s\n", failures == 0 ? "PASS" : "FAIL");
  return failures == 0 ? 0 : 1;
}
