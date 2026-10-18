// The retrieval methods (after gaia_octree.cpp in the one translation unit).
namespace {

std::string sum(const std::vector<uint32_t>& counts) { uint64_t n = 0; for (auto c : counts) n += c; return std::to_string(n); }

// Groups of consecutive sky pixels, each at most rangeRows stars by the counts.
std::vector<std::pair<uint32_t, uint32_t>> plan(const Settings& s, const std::vector<uint32_t>& counts) {
  std::vector<std::pair<uint32_t, uint32_t>> ranges;
  uint64_t inRange = 0;
  for (const uint32_t p : s.sky) {
    if (!ranges.empty() && ranges.back().second + 1 == p && inRange + counts[p] <= s.rangeRows) { ranges.back().second = p; inRange += counts[p]; }
    else { ranges.emplace_back(p, p); inRange = counts[p]; }
  }
  return ranges;
}

std::string angularLayer(Run& run, uint64_t& tilesFiled) {
  const auto& s = run.s;
  std::vector<uint8_t> body;
  std::string why = fetch(run, "SELECT GAIA_HEALPIX_INDEX(3, source_id) AS hpx, COUNT(*) AS n FROM gaiadr3.gaia_source WHERE phot_g_mean_mag <= " +
                                    fixed(s.gLimit, 4) + " GROUP BY hpx", "hpx,", body);
  if (!why.empty()) return why;
  std::vector<uint32_t> counts(768, 0);
  {
    go::tap::Csv csv(body);
    std::vector<std::string_view> f;
    while (csv.next(f)) if (f.size() == 2 && go::tap::integer(f[0]) < 768) counts[go::tap::integer(f[0])] = uint32_t(go::tap::integer(f[1]));
  }
  // The octree's stars, reserved before anything else is allocated: every star of the sky, and room for the
  // Hipparcos-only ones (a few hundred to G 13.5).
  uint64_t inSkyCount = 0;
  for (const uint32_t p : s.sky) inSkyCount += counts[p];
  run.stars3d.reserve(inSkyCount + 4096);
  std::vector<std::pair<uint64_t, uint32_t>> neighbours;
  std::map<uint32_t, Hip> hips;
  if (!(why = hipparcos(run, neighbours, hips)).empty()) return why;
  auto candidates = hipCandidates(run, neighbours, hips);

  for (const auto& [p0, p1] : plan(s, counts)) {
    std::vector<Star> gaia;
    uint64_t expected = 0;
    for (uint32_t p = p0; p <= p1; ++p) expected += counts[p];
    if (!(why = gaiaRows(run, uint64_t(p0) << 53, uint64_t(p1 + 1) << 53, expected, gaia, neighbours, hips)).empty()) return why;
    run.rows += gaia.size();
    const uint64_t first = uint64_t(p0) << 2, last = (uint64_t(p1) << 2) + 3;
    std::map<uint64_t, std::vector<Star>> bucket;
    for (uint32_t p = p0; p <= p1; ++p) {
      auto c = candidates.find(p);
      if (c == candidates.end()) continue;
      confirmHipOnly(c->second, gaia);
      for (const Star& h : c->second) { bucket[hp::radec2pix(kTileOrder, h.ra16, h.dec16)].push_back(h); toOctree(run, h); ++run.hipOnly; }
      candidates.erase(c);
    }
    for (Star& g : gaia) {
      toOctree(run, g);
      const uint64_t pix = hp::radec2pix(kTileOrder, g.ra16, g.dec16);
      if (pix >= first && pix <= last) { bucket[pix].push_back(g); continue; }
      ++run.strays;
      if (!inSky(run, pix)) ++run.outsideSky;
      else (pix < first ? run.late : run.pending)[pix].push_back(g);
    }
    gaia.clear();
    gaia.shrink_to_fit();
    for (uint64_t pix = first; pix <= last; ++pix) {
      auto& stars = bucket[pix];
      const auto waiting = run.pending.find(pix);
      if (waiting != run.pending.end()) { stars.insert(stars.end(), waiting->second.begin(), waiting->second.end()); run.pending.erase(waiting); }
      if (!(why = makeTile(run, pix, stars)).empty()) return why;
      std::vector<Star>().swap(stars);
    }
  }
  for (auto& [pix, extra] : run.late) if (!(why = patchTile(run, pix, extra)).empty()) return why;
  if (!run.pending.empty()) return std::to_string(run.pending.size()) + " tiles were owed stars after every range.";

  std::vector<uint8_t> records;
  for (const auto& [pix, t] : run.tiles) go::publish::appendTile(run.angular, t, records);
  go::publish::Lane lane{"angular-g" + fixed(s.gLimit, 1), "gaia-dr3-angular-g" + fixed(s.gLimit, 1) + "-" + run.angular.producedAt + "-" + sum(counts),
                         s.tap, kLicense, kLicenseUrl, kCitation, kVersion};
  return go::publish::ingest("SKT.fbs", kProvider, lane, s.peer, records, tilesFiled);
}

std::string octreeLayer(Run& run, uint64_t& nodesFiled, go::octree::Result& built) {
  double far = 0;
  for (size_t i = 0; i < run.stars3d.size(); ++i) far = std::max(far, double(run.stars3d[i].d));
  const auto table = go::extinction::build(far);
  for (size_t i = 0; i < run.stars3d.size(); ++i) {
    auto& o = run.stars3d[i];
    const double u[3] = {o.x / o.d, o.y / o.d, o.z / o.d};
    o.absMag = float(o.mag(o.g) - 5 * std::log10(o.d / 10) - go::extinction::at(table, u, o.d).aG);
  }
  std::vector<uint8_t> records;
  std::vector<go::publish::Tile> nodes;
  built = go::octree::build(run.stars3d, [&](const go::octree::Node& n, uint32_t kept, uint8_t mask) {
    std::vector<uint8_t> rows, points;
    go::publish::Tile t;
    t.octree = true; t.level = n.level; t.key = n.key; t.cx = n.cx; t.cy = n.cy; t.cz = n.cz; t.half = n.half; t.childMask = mask;
    t.points = kept;
    t.magBrightest = INFINITY; t.magLimit = -INFINITY;
    for (uint32_t i = 0; i < kept; ++i) {
      const auto& o = run.stars3d[n.begin + i];
      const double u[3] = {o.x / o.d, o.y / o.d, o.z / o.d};
      const double color0 = o.mag(o.bp) - o.mag(o.rp) - go::extinction::at(table, u, o.d).eBpRp;
      go::appendOctreeRow(o.gaia, o.hip, float(o.mag(o.g)), float(o.mag(o.bp)), float(o.mag(o.rp)), o.d, o.lo, o.hi, o.method(), rows);
      go::appendPoint3D(float(o.x - n.cx), float(o.y - n.cy), float(o.z - n.cz), o.absMag, color0, (double(o.hi) - o.lo) / o.d, o.flags(), i, points);
      t.magBrightest = std::min(t.magBrightest, float(o.mag(o.g))); t.magLimit = std::max(t.magLimit, float(o.mag(o.g)));
    }
    t.absBrightest = run.stars3d[n.begin].absMag;
    t.absFaintest = run.stars3d[n.begin + kept - 1].absMag;
    std::string why;
    if ((t.rowsCid = go::publish::add(rows, why)).empty()) return why;
    if ((t.payloadCid = go::publish::add(points, why)).empty()) return why;
    t.payloadBytes = points.size();
    nodes.push_back(t);
    return std::string();
  });
  if (!built.error.empty()) return built.error;
  for (auto& t : nodes) { t.maxOrder = uint8_t(built.depth); go::publish::appendTile(run.octreeLayer, t, records); }
  go::publish::Lane lane{"octree-g" + fixed(run.s.gLimit, 1), "gaia-dr3-octree-g" + fixed(run.s.gLimit, 1) + "-" + run.octreeLayer.producedAt + "-" +
                         std::to_string(built.stars), run.s.tap, kLicense, kLicenseUrl, kCitation, kVersion};
  return go::publish::ingest("SKT.fbs", kProvider, lane, run.s.peer, records, nodesFiled);
}

}  // namespace

extern "C" int prepare_scheduled() {
  if (plugin_get_input_count() != 1 || framesOn("tick") != 1) return fail("Exactly one timer tick is required.");
  const Settings s = settings();
  if (!s.why.empty()) return fail(s.why);
  if (s.peer.empty()) return control("status", R"({"skipped":"disabled"})");
  return control("cycle", "{\"producer_peer_id\":\"" + s.peer + "\"}");
}

// One cycle: both layers made and filed.
extern "C" int retrieve_gaia() {
  if (framesOn("cycle") != 1) return fail("Exactly one cycle is required.");
  Run run;
  run.s = settings();
  if (!run.s.why.empty()) return fail(run.s.why);
  if (run.s.peer.empty()) return fail("The Gaia lane was disabled during the cycle; nothing was filed.");
  const auto t0 = std::chrono::steady_clock::now();
  const std::string tier = fixed(run.s.gLimit, 1), at = isoNow();
  const std::vector<std::string> sources{"Gaia DR3 (gaiadr3.gaia_source)", "Bailer-Jones et al. 2021 (external.gaiaedr3_distance)",
                                         "Hipparcos 2007 (public.hipparcos_newreduction)", "Hipparcos 1997 (public.hipparcos)"};
  run.angular = {"gaia-dr3:angular-g" + tier, run.s.peer, at, std::string(kModule) + " " + kVersion, kCitation, kLicenseUrl, sources};
  run.octreeLayer = {"gaia-dr3:octree-g" + tier, run.s.peer, at, std::string(kModule) + " " + kVersion, kCitation, kLicenseUrl, sources};
  uint64_t tilesFiled = 0, nodesFiled = 0;
  std::string why = angularLayer(run, tilesFiled);
  if (!why.empty()) return fail(why);
  const auto t1 = std::chrono::steady_clock::now();
  go::octree::Result built;
  if (!(why = octreeLayer(run, nodesFiled, built)).empty()) return fail(why);
  const auto t2 = std::chrono::steady_clock::now();
  const auto secs = [](auto a, auto b) { return fixed(std::chrono::duration<double>(b - a).count(), 1); };
  char err[32];
  std::snprintf(err, sizeof err, "%.3e", built.maxFloatError);
  return control("report", std::string("{\"provider_id\":\"") + kProvider + "\",\"angular\":{\"source_name\":\"angular-g" + tier +
                               "\",\"tiles\":" + std::to_string(run.tiles.size()) + ",\"filed\":" + std::to_string(tilesFiled) +
                               ",\"stars\":" + std::to_string(run.rows + run.hipOnly) + ",\"gaia\":" + std::to_string(run.rows) +
                               ",\"hipparcos_only\":" + std::to_string(run.hipOnly) + ",\"bright_edsd\":" + std::to_string(run.brightEdsd) +
                               ",\"range_splits\":" + std::to_string(run.splits) + ",\"strays\":" + std::to_string(run.strays) + ",\"patched_tiles\":" + std::to_string(run.patched) +
                               ",\"outside_sky\":" + std::to_string(run.outsideSky) + ",\"seconds\":" + secs(t0, t1) + "},\"octree\":{\"source_name\":\"octree-g" +
                               tier + "\",\"nodes\":" + std::to_string(built.nodes) + ",\"filed\":" + std::to_string(nodesFiled) +
                               ",\"stars\":" + std::to_string(built.stars) + ",\"depth\":" + std::to_string(built.depth) +
                               ",\"max_float32_error_per_edge\":" + err + ",\"seconds\":" + secs(t1, t2) + "},\"tap_queries\":" +
                               std::to_string(run.queries) + ",\"tap_bytes\":" + std::to_string(run.bytesIn) + "}");
}

