// GAIA DR3 OVER SDN (com.digitalarsenal.data-source.gaia-octree).
//
// retrieve_gaia, one cycle on a provider node, everything through host calls:
//  1. ESA's Gaia archive (TAP): the stars to the tier limit counted per
//     HEALPix order-3 pixel, then fetched by source_id range (a source_id
//     encodes its order-12 pixel), consecutive pixels grouped to at most
//     gaia_octree_range_rows rows per answer, each joined with Bailer-Jones et
//     al. 2021 (external.gaiaedr3_distance); up front the Hipparcos best
//     neighbours (gaiadr3.hipparcos2_best_neighbour), Hipparcos 2007
//     (public.hipparcos_newreduction) and Hipparcos 1997's V and flags
//     (public.hipparcos).
//  2. THE ANGULAR LAYER, $SKT provider gaia-dr3 source angular-g13.5: one
//     HEALPix order-4 tile per pixel of the sky asked for, holding every star
//     whose J2016.0 catalog place lies in it, brightest first: its $STR rows
//     (ROW_COLLECTION_CID) and SKTPoints (PAYLOAD_CID) added to the node's
//     IPFS. A star found in another range than its tile's is added when that
//     tile is made, or patched into a tile already made.
//  3. THE OCTREE, $SKT provider gaia-dr3 source octree-g13.5 (octree.hpp):
//     the stars with (r_hi - r_lo) / r_med <= 0.5, de-reddened with
//     milky-way-model's analytic dust (extinction.hpp).
//  Both layers' $SKT index records are filed by storage.ingest_with_source;
//  the node's auto-publisher announces them.
//
// Distances: Bailer-Jones 2021 photogeometric, else geometric. A Gaia star
// brighter than G = 4 with a Hipparcos match takes the EDSD posterior on its
// Hipparcos 2007 parallax instead (Gaia's bright-star parallaxes are its
// weakest). A Hipparcos star with no best neighbour, and no Gaia star within
// 5" whose G is within 1 mag of its predicted G, is a Hipparcos-only row
// (J1991.25 astrometry, EDSD distance, G from V and V - I, else B - V, by
// Riello et al. 2021 Table C.2, flagged as modeled).
//
// cone_tiles / cone_rows answer $SKQ cones from the angular layer: the tiles a
// cone touches, then the rows inside it at the query's epoch.
#include <algorithm>
#include <chrono>
#include <ctime>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace {
namespace R = sdn::runtime;
namespace go = gaia_octree;
namespace hp = gaia_octree::healpix;
namespace as = gaia_octree::astrometry;
using go::Star;

constexpr const char* kVersion = "0.1.0";
constexpr const char* kProvider = "gaia-dr3";
constexpr const char* kTap = "https://gea.esac.esa.int/tap-server/tap";
constexpr int kTileOrder = 4;
constexpr const char* kLicense = "Gaia DR3: CC BY-NC 3.0 IGO (ESA/Gaia/DPAC); Bailer-Jones et al. 2021 distances; Hipparcos: Credit ESA";
constexpr const char* kLicenseUrl = "https://creativecommons.org/licenses/by-nc/3.0/igo/";
constexpr const char* kCitation =
    "ESA/Gaia/DPAC, Gaia Collaboration, Vallenari et al. 2023, A&A 674, A1 (Gaia DR3); Bailer-Jones et al. 2021, AJ 161, 147; "
    "ESA 1997, The Hipparcos and Tycho Catalogues, SP-1200; van Leeuwen 2007, A&A 474, 653";

std::string isoNow() {
  const std::time_t t = std::time(nullptr);
  char buf[32];
  std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&t));
  return buf;
}

struct Settings {
  std::string peer, tap;
  double gLimit = 13.5;
  uint32_t rangeRows = 30000;
  std::vector<uint32_t> sky;  // order-3 pixels, ascending
  std::string why;
};

Settings settings() {
  Settings s;
  const auto config = sdm_piv::get_config();
  if (!config.ok()) { s.why = "Host configuration unavailable: " + config.error_message(); return s; }
  if (!config.boolean("gaia_octree_enabled")) return s;
  s.peer = std::string(config.string("gaia_octree_producer_peer_id"));
  if (!go::publish::cidToken(s.peer)) { s.why = "gaia_octree_producer_peer_id must name this node's peer ID."; s.peer.clear(); return s; }
  s.tap = std::string(config.string("gaia_octree_tap_url", kTap));
  s.gLimit = config.number("gaia_octree_g_limit", 13.5);
  s.rangeRows = uint32_t(config.number("gaia_octree_range_rows", 30000));
  for (const double p : config.numbers("gaia_octree_sky"))
    if (p >= 0 && p < 768) s.sky.push_back(uint32_t(p));
  if (s.sky.empty()) for (uint32_t p = 0; p < 768; ++p) s.sky.push_back(p);
  std::sort(s.sky.begin(), s.sky.end());
  s.sky.erase(std::unique(s.sky.begin(), s.sky.end()), s.sky.end());
  if (!(s.gLimit > 0 && s.gLimit <= 21) || s.rangeRows < 1000 || s.rangeRows > 250000) s.why = "gaia_octree_g_limit or gaia_octree_range_rows is out of range.";
  return s;
}

std::string fixed(double v, int digits = 3) { char b[48]; std::snprintf(b, sizeof b, "%.*f", digits, v); return b; }

// ── Hipparcos ──────────────────────────────────────────────────────────────────
struct Hip { uint32_t hip; double ra, dec, plx, pmra, pmdec, eRa, eDec, ePlx, ePmra, ePmdec, bv, vi, v; bool var, mult; };

double poly(const double* c, int n, double x) { double y = 0; for (int i = n - 1; i >= 0; --i) y = y * x + c[i]; return y; }

// Riello et al. 2021 Table C.2: G - V from V - I_C (-0.4..5.0), else from B - V (-0.4..3.3).
bool predictedG(const Hip& h, double& g, double& sigma) {
  static const double fromVi[5] = {-0.01597, -0.02809, -0.2483, 0.03656, -0.002939};
  static const double fromBv[4] = {-0.04749, -0.0124, -0.2901, 0.02008};
  if (!std::isfinite(h.v)) return false;
  if (std::isfinite(h.vi) && h.vi >= -0.4 && h.vi <= 5.0) { g = h.v + poly(fromVi, 5, h.vi); sigma = 0.0272; return true; }
  if (std::isfinite(h.bv) && h.bv >= -0.4 && h.bv <= 3.3) { g = h.v + poly(fromBv, 4, h.bv); sigma = 0.04772; return true; }
  return false;
}

// ── tiles ──────────────────────────────────────────────────────────────────────
struct Run {
  Settings s;
  go::publish::Layer angular, octreeLayer;
  std::map<uint64_t, go::publish::Tile> tiles;  // order-4 pixel -> its tile, once made
  std::map<uint64_t, std::vector<Star>> pending, late;
  go::octree::Store stars3d;
  uint64_t rows = 0, splits = 0, hipOnly = 0, brightEdsd = 0, strays = 0, patched = 0, outsideSky = 0, queries = 0;
  uint64_t bytesIn = 0;
};

bool inSky(const Run& run, uint64_t pix4) { return std::binary_search(run.s.sky.begin(), run.s.sky.end(), uint32_t(pix4 >> 2)); }

void place2016(Star& s) {
  const auto p = as::propagate(s.ra, s.dec, s.pmra, s.pmdec, s.plx, s.rv, s.epoch, go::kGaiaEpoch);
  s.ra16 = p.raDeg; s.dec16 = p.decDeg;
}

// One tile from its stars: rows and points to IPFS, brightest first.
std::string makeTile(Run& run, uint64_t pix, std::vector<Star>& stars) {
  std::stable_sort(stars.begin(), stars.end(), [](const Star& a, const Star& b) {
    return std::isfinite(a.g) && (!std::isfinite(b.g) || a.g < b.g);
  });
  go::publish::Tile t;
  t.order = kTileOrder; t.pixel = pix; t.maxOrder = kTileOrder;
  t.points = uint32_t(stars.size());
  std::string why;
  if (!stars.empty()) {
    std::vector<uint8_t> rows, points;
    rows.reserve(stars.size() * 340);
    points.reserve(stars.size() * 24);
    for (size_t i = 0; i < stars.size(); ++i) { go::appendRow(stars[i], rows); go::appendPoint(stars[i], uint32_t(i), points); }
    t.magBrightest = float(stars.front().g);
    t.magLimit = float(stars.back().g);
    if ((t.rowsCid = go::publish::add(rows, why)).empty()) return why;
    if ((t.payloadCid = go::publish::add(points, why)).empty()) return why;
    t.payloadBytes = points.size();
  }
  run.tiles[pix] = t;
  return {};
}

// Late stars into a tile already made: its rows back from IPFS, the tile made again, the old CIDs unpinned.
std::string patchTile(Run& run, uint64_t pix, std::vector<Star>& extra) {
  const go::publish::Tile old = run.tiles[pix];
  std::vector<Star> stars;
  std::string why;
  if (!old.rowsCid.empty()) {
    const auto bytes = go::publish::cat(old.rowsCid, why);
    if (!why.empty()) return why;
    if (!go::eachRecord(bytes.data(), bytes.size(), "$STR", [&](const uint8_t* p, size_t) { Star s = go::fromRow(*GetSTR(p)); place2016(s); stars.push_back(s); }))
      return "The rows of tile " + std::to_string(pix) + " are not a size-prefixed $STR stream.";
  }
  stars.insert(stars.end(), extra.begin(), extra.end());
  if (!(why = makeTile(run, pix, stars)).empty()) return why;
  if (!old.rowsCid.empty()) { go::publish::unpin(old.rowsCid); go::publish::unpin(old.payloadCid); }
  ++run.patched;
  return {};
}

void toOctree(Run& run, const Star& s) {
  if (!(s.fracUnc() <= 0.5)) return;
  double u[3];
  as::unit(s.ra16, s.dec16, u);
  go::octree::OctStar o{};
  o.x = float(u[0] * s.dist); o.y = float(u[1] * s.dist); o.z = float(u[2] * s.dist);
  o.absMag = NAN;
  o.g = o.mmag(s.g); o.bp = o.mmag(s.bp); o.rp = o.mmag(s.rp);
  o.d = float(s.dist); o.lo = float(s.distLo); o.hi = float(s.distHi);
  o.gaia = s.gaia; o.hip = s.hip;
  o.bits = uint16_t((s.var ? 1 : 0) | (s.mult ? 2 : 0) | (s.gModeled ? 16 : 0) | (s.method << 8));
  run.stars3d.push(o);
}

// ── the sources ────────────────────────────────────────────────────────────────
std::string fetch(Run& run, const std::string& adql, const std::string& header, std::vector<uint8_t>& body, int attempts = 4) {
  std::string why;
  auto answer = go::tap::query(run.s.tap, adql, header, why, attempts);
  ++run.queries;
  if (answer.body.empty()) return why;
  run.bytesIn += answer.body.size();
  body = std::move(answer.body);
  return {};
}

const char* kGaiaColumns =
    "g.source_id,g.ra,g.dec,g.ra_error,g.dec_error,g.parallax,g.parallax_error,g.pmra,g.pmra_error,g.pmdec,g.pmdec_error,"
    "g.radial_velocity,g.radial_velocity_error,g.phot_g_mean_mag,g.phot_g_mean_flux_over_error,g.phot_bp_mean_mag,"
    "g.phot_bp_mean_flux_over_error,g.phot_rp_mean_mag,g.phot_rp_mean_flux_over_error,g.phot_variable_flag,g.non_single_star,"
    "d.r_med_geo,d.r_lo_geo,d.r_hi_geo,d.r_med_photogeo,d.r_lo_photogeo,d.r_hi_photogeo";

double magUnc(double fluxOverError) { return fluxOverError > 0 ? 2.5 / std::log(10.0) / fluxOverError : NAN; }

std::string gaiaRange(Run& run, uint64_t lo, uint64_t hi, uint64_t expected, std::vector<Star>& out, const std::vector<std::pair<uint64_t, uint32_t>>& neighbours,
                      const std::map<uint32_t, Hip>& hips) {
  const std::string adql = std::string("SELECT ") + kGaiaColumns +
                           " FROM gaiadr3.gaia_source AS g LEFT OUTER JOIN external.gaiaedr3_distance AS d ON d.source_id = g.source_id"
                           " WHERE g.source_id >= " + std::to_string(lo) + " AND g.source_id < " + std::to_string(hi) +
                           " AND g.phot_g_mean_mag <= " + fixed(run.s.gLimit, 4);
  std::vector<uint8_t> body;
  std::string why = fetch(run, adql, "source_id,", body, 2);
  if (!why.empty()) return why;
  go::tap::Csv csv(body);
  if (csv.width() != 27) return "The Gaia answer has " + std::to_string(csv.width()) + " columns, not 27.";
  std::vector<std::string_view> f;
  namespace T = go::tap;
  while (csv.next(f)) {
    if (f.size() != 27) return "A Gaia row has " + std::to_string(f.size()) + " fields.";
    Star s;
    s.gaia = T::integer(f[0]);
    s.ra = T::number(f[1]); s.dec = T::number(f[2]);
    s.raUnc = T::number(f[3]) / 1000; s.decUnc = T::number(f[4]) / 1000;
    s.plx = T::number(f[5]); s.plxUnc = T::number(f[6]);
    s.pmra = T::number(f[7]); s.pmraUnc = T::number(f[8]); s.pmdec = T::number(f[9]); s.pmdecUnc = T::number(f[10]);
    s.rv = T::number(f[11]); s.rvUnc = T::number(f[12]);
    s.g = T::number(f[13]); s.gUnc = magUnc(T::number(f[14]));
    s.bp = T::number(f[15]); s.bpUnc = magUnc(T::number(f[16]));
    s.rp = T::number(f[17]); s.rpUnc = magUnc(T::number(f[18]));
    s.var = f[19] == "VARIABLE";
    s.mult = T::number(f[20]) > 0;
    const double pg = T::number(f[24]), geo = T::number(f[21]);
    if (std::isfinite(pg)) { s.dist = pg; s.distLo = T::number(f[25]); s.distHi = T::number(f[26]); s.method = uint8_t(strDistanceEstimator::BAILER_JONES_2021_PHOTOGEO); }
    else if (std::isfinite(geo)) { s.dist = geo; s.distLo = T::number(f[22]); s.distHi = T::number(f[23]); s.method = uint8_t(strDistanceEstimator::BAILER_JONES_2021_GEO); }
    if (s.gaia == 0 || !std::isfinite(s.ra) || !std::isfinite(s.dec) || !std::isfinite(s.g)) return "A Gaia row lacks its source_id, position or G.";
    const auto it = std::lower_bound(neighbours.begin(), neighbours.end(), std::make_pair(s.gaia, uint32_t(0)));
    if (it != neighbours.end() && it->first == s.gaia) s.hip = it->second;
    if (s.hip && s.g < 4) {
      const auto h = hips.find(s.hip);
      if (h != hips.end()) {
        const auto d = as::edsd(h->second.plx, h->second.ePlx);
        if (std::isfinite(d.mode)) { s.dist = d.mode; s.distLo = d.lo; s.distHi = d.hi; s.method = uint8_t(strDistanceEstimator::EDSD_POSTERIOR); ++run.brightEdsd; }
      }
    }
    s.ra16 = s.ra; s.dec16 = s.dec;
    out.push_back(s);
  }
  return {};
}

// The stars of source_id [lo, hi), `expected` of them. ESA's sync service
// ends a long query with 408 (job timeout), or ends a long answer early with
// status 200 and nothing to say so: either way the range is split in two at
// the middle source_id, each half counted and fetched again, down to 1/64.
std::string gaiaRows(Run& run, uint64_t lo, uint64_t hi, uint64_t expected, std::vector<Star>& out,
                     const std::vector<std::pair<uint64_t, uint32_t>>& neighbours, const std::map<uint32_t, Hip>& hips, int depth = 0) {
  std::vector<Star> got;
  std::string why = gaiaRange(run, lo, hi, expected, got, neighbours, hips);
  if (!why.empty() && why.find(" answered 408 ") == std::string::npos) return why;
  if (why.empty() && got.size() == expected) { out.insert(out.end(), got.begin(), got.end()); return {}; }
  ++run.splits;
  if (depth >= 6) return "The Gaia answer for source_id [" + std::to_string(lo) + ", " + std::to_string(hi) + ") has " + std::to_string(got.size()) +
                         " rows; the archive counted " + std::to_string(expected) + ".";
  const uint64_t mid = lo + (hi - lo) / 2;
  for (const auto& [a, b] : {std::make_pair(lo, mid), std::make_pair(mid, hi)}) {
    std::vector<uint8_t> body;
    if (!(why = fetch(run, "SELECT COUNT(*) AS n FROM gaiadr3.gaia_source WHERE source_id >= " + std::to_string(a) + " AND source_id < " +
                               std::to_string(b) + " AND phot_g_mean_mag <= " + fixed(run.s.gLimit, 4), "n", body)).empty()) return why;
    go::tap::Csv csv(body);
    std::vector<std::string_view> f;
    const uint64_t n = csv.next(f) && f.size() == 1 ? go::tap::integer(f[0]) : 0;
    if (n && !(why = gaiaRows(run, a, b, n, out, neighbours, hips, depth + 1)).empty()) return why;
  }
  return {};
}

// COUNT(*) of a table, to check an answer is whole.
std::string countOf(Run& run, const std::string& table, uint64_t& n) {
  std::vector<uint8_t> body;
  std::string why = fetch(run, "SELECT COUNT(*) AS n FROM " + table, "n", body);
  if (!why.empty()) return why;
  go::tap::Csv csv(body);
  std::vector<std::string_view> f;
  n = csv.next(f) && f.size() == 1 ? go::tap::integer(f[0]) : 0;
  return n ? std::string() : "No row count for " + table + ".";
}

std::string hipparcos(Run& run, std::vector<std::pair<uint64_t, uint32_t>>& neighbours, std::map<uint32_t, Hip>& hips) {
  uint64_t nNeighbours = 0, nHip2007 = 0, nHip1997 = 0;
  std::string counted = countOf(run, "gaiadr3.hipparcos2_best_neighbour", nNeighbours);
  if (counted.empty()) counted = countOf(run, "public.hipparcos_newreduction", nHip2007);
  if (counted.empty()) counted = countOf(run, "public.hipparcos", nHip1997);
  if (!counted.empty()) return counted;
  std::vector<uint8_t> body;
  std::string why = fetch(run, "SELECT source_id, original_ext_source_id FROM gaiadr3.hipparcos2_best_neighbour", "source_id,", body);
  if (!why.empty()) return why;
  {
    go::tap::Csv csv(body);
    std::vector<std::string_view> f;
    while (csv.next(f)) if (f.size() == 2) neighbours.emplace_back(go::tap::integer(f[0]), uint32_t(go::tap::integer(f[1])));
    std::sort(neighbours.begin(), neighbours.end());
    if (neighbours.size() != nNeighbours) return "The best-neighbour answer is not whole.";
  }
  why = fetch(run, "SELECT hip, ra, dec, plx, pm_ra, pm_de, e_ra_rad, e_de_rad, e_plx, e_pm_ra, e_pm_de, b_v, v_i FROM public.hipparcos_newreduction",
              "hip,", body);
  if (!why.empty()) return why;
  {
    go::tap::Csv csv(body);
    std::vector<std::string_view> f;
    namespace T = go::tap;
    while (csv.next(f)) {
      if (f.size() != 13) continue;
      Hip h{uint32_t(T::integer(f[0])), T::number(f[1]), T::number(f[2]), T::number(f[3]), T::number(f[4]), T::number(f[5]), T::number(f[6]),
            T::number(f[7]), T::number(f[8]), T::number(f[9]), T::number(f[10]), T::number(f[11]), T::number(f[12]), NAN, false, false};
      if (h.hip) hips[h.hip] = h;
    }
    if (hips.size() != nHip2007) return "The Hipparcos 2007 answer is not whole.";
  }
  why = fetch(run, "SELECT hip, vmag, varflag, multflag FROM public.hipparcos", "hip,", body);
  if (!why.empty()) return why;
  go::tap::Csv csv(body);
  std::vector<std::string_view> f;
  uint64_t rows1997 = 0;
  while (csv.next(f)) {
    ++rows1997;
    if (f.size() != 4) continue;
    const auto h = hips.find(uint32_t(go::tap::integer(f[0])));
    if (h == hips.end()) continue;
    h->second.v = go::tap::number(f[1]);
    h->second.var = !f[2].empty();
    h->second.mult = !f[3].empty();
  }
  return rows1997 == nHip1997 ? std::string() : "The Hipparcos 1997 answer is not whole.";
}

// Hipparcos stars with no best neighbour, to the tier limit by predicted G, by order-3 pixel.
std::map<uint32_t, std::vector<Star>> hipCandidates(Run& run, const std::vector<std::pair<uint64_t, uint32_t>>& neighbours,
                                                    const std::map<uint32_t, Hip>& hips) {
  std::set<uint32_t> matched;
  for (const auto& n : neighbours) matched.insert(n.second);
  std::map<uint32_t, std::vector<Star>> out;
  for (const auto& [id, h] : hips) {
    double g, sigma;
    if (matched.count(id) || !std::isfinite(h.ra) || !predictedG(h, g, sigma) || g > run.s.gLimit) continue;
    Star s;
    s.hip = id; s.epoch = go::kHipparcosEpoch;
    s.ra = h.ra; s.dec = h.dec; s.raUnc = h.eRa / 1000; s.decUnc = h.eDec / 1000;
    s.plx = h.plx; s.plxUnc = h.ePlx; s.pmra = h.pmra; s.pmraUnc = h.ePmra; s.pmdec = h.pmdec; s.pmdecUnc = h.ePmdec;
    s.g = g; s.gUnc = sigma; s.gModeled = true; s.var = h.var; s.mult = h.mult;
    const auto d = as::edsd(h.plx, h.ePlx);
    if (std::isfinite(d.mode)) { s.dist = d.mode; s.distLo = d.lo; s.distHi = d.hi; s.method = uint8_t(strDistanceEstimator::EDSD_POSTERIOR); }
    place2016(s);
    const uint64_t pix4 = hp::radec2pix(kTileOrder, s.ra16, s.dec16);
    if (inSky(run, pix4)) out[uint32_t(pix4 >> 2)].push_back(s);
  }
  return out;
}

// Keeps the candidates with no Gaia star within 5" whose G is within 1 mag of their predicted G.
void confirmHipOnly(std::vector<Star>& candidates, const std::vector<Star>& gaia) {
  const double cos5 = std::cos(5.0 / 3600 * as::kDeg);
  std::vector<double> units(gaia.size() * 3);
  for (size_t i = 0; i < gaia.size(); ++i) as::unit(gaia[i].ra16, gaia[i].dec16, &units[3 * i]);
  std::vector<Star> kept;
  for (const Star& c : candidates) {
    double u[3];
    as::unit(c.ra16, c.dec16, u);
    bool seen = false;
    for (size_t i = 0; i < gaia.size() && !seen; ++i)
      seen = u[0] * units[3 * i] + u[1] * units[3 * i + 1] + u[2] * units[3 * i + 2] >= cos5 && std::fabs(gaia[i].g - c.g) < 1;
    if (!seen) kept.push_back(c);
  }
  candidates.swap(kept);
}
}  // namespace
