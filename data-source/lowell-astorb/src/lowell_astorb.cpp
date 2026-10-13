
// Every numbered asteroid from Lowell Observatory's astorb.dat, as SDS $SBD
// small-body records (an asteroid does not orbit the Earth; owner 2026-10-13).
//
// plan_astorb builds three ranged GETs for the generic HTTP host (the file is
// about 112 MB and the host refuses a response body over 100 MB);
// parse_astorb joins the ranges, validates the whole gzip member (CRC-32 and
// length, so a short, stale-mixed or truncated join is refused), checks every
// line's fixed columns, and only then emits one size-prefixed $SBD per numbered
// asteroid, brightest H band first. No host calls: fetching, storage and
// publication belong to the host, and the node's auto-publisher announces the
// stored batch (SBD.fbs, provider lowell-astorb, source astorb-numbered).
//
// Each record carries the catalog's osculating heliocentric elements as
// published, with the CCSDS OPM keywords: CENTER_NAME SUN, REF_FRAME
// ECLIPJ2000 (the mean ecliptic and equinox of J2000), TIME_SYSTEM TDB, angles
// in degrees, SEMI_MAJOR_AXIS in km (the only arithmetic: AU to km), GM the
// DE440 Sun; H, G and the IRAS diameter; the JPL SBDB orbit class and the NEO
// flag from a and e; the orbit arc, observation count and CEU; and a PVN.
//
// Licence: "astorb.dat may be freely used, copied, and transmitted provided
// attribution to Dr. Edward Bowell and the aforementioned funding sources is
// made" (NASA grant NAG5-4741 and the Lowell Observatory endowment). The
// attribution rides in the ingest meta and so in every publication.

// The fixed-column rules, the $SBD layout and the streamed gzip reader are in
// astorb_core.hpp, shared with the host adapter's ingest_astorb.
using namespace astorb;

// config (from the host adapter) -> request0..2 + job. The only accepted source
// is the canonical Lowell URL; a configured mirror would be a different
// provenance. Three fixed byte ranges, one per HTTP node: a range past the end
// answers 416 and contributes nothing.
extern "C" int plan_astorb() { return planAstorb(); }

// job + response + receipt -> records, meta, report. Nothing is emitted until
// the whole file validated, so a truncated or corrupt download never replaces
// the published catalog. A first pass validates (gzip CRC-32 and length,
// fixed columns) and counts; the records are then built band by band,
// brightest H first. On a node the host adapter's ingest_astorb does the same
// in parts straight into the store; this method is the portable form (the
// browser harness and the tests).
extern "C" int parse_astorb() {
  GzipInput gz;
  std::string peer;
  int64_t retrieved = 0;
  if (const char* refused = readRetrieval(gz, peer, retrieved)) return fail(refused);
  Survey s;
  CHECK(survey(gz, s), error);
  // A real astorb.dat holds hundreds of thousands of numbered asteroids; a
  // short file is a broken download, never a smaller sky.
  CHECK(s.rows >= 100000, "astorb.dat holds fewer than 100,000 numbered asteroids; refusing a partial catalog.");
  std::vector<uint8_t> stream;
  stream.reserve(s.rows * 420);
  flatbuffers::FlatBufferBuilder b(512);
  for (int wanted = 0; wanted < 4; ++wanted) {
    CHECK(forEachRecordInBand(gz, wanted, b, [&](const uint8_t* p, size_t n) { stream.insert(stream.end(), p, p + n); }), error);
  }
  const std::string sourceSha = sourceSha256(gz);
  const Json meta = ingestMeta(sourceSha, peer);
  const Json report = surveyReport(s, sourceSha, gz.size, stream.size(), retrieved);
  if (output("meta", meta) < 0 || output("report", report) < 0) return 1;
  return plugin_push_output_ex("records", "SBD.fbs", "$SBD", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "SBD", 0, 0,
                               stream.data(), stream.size()) < 0 ? 1 : 0;
}
