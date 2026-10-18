// The consumer methods: $SKQ cones answered from the angular layer.
#include <map>
namespace {
namespace hp = gaia_octree::healpix;
namespace as = gaia_octree::astrometry;
namespace go = gaia_octree;

struct Cone { double u[3]; double cosR, radiusRad, years, magLimit; };

std::vector<Cone> cones(std::string& why) {
  std::vector<Cone> out;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "query") != 0) continue;
    if (!go::eachRecord(f->payload, f->payload_length, "$SKQ", [&](const uint8_t* p, size_t) {
          const SKQ& q = *GetSKQ(p);
          if (!(std::isfinite(q.RA_DEG()) && std::isfinite(q.DEC_DEG()) && q.RADIUS_DEG() > 0 && q.RADIUS_DEG() <= 90)) return;
          Cone c;
          as::unit(q.RA_DEG(), q.DEC_DEG(), c.u);
          c.radiusRad = q.RADIUS_DEG() * as::kDeg;
          c.cosR = std::cos(c.radiusRad);
          c.years = std::isfinite(q.EPOCH_JD_TT()) ? as::julianYear(q.EPOCH_JD_TT(), q.EPOCH_JD_TT_FRACTION()) : go::kGaiaEpoch;
          c.magLimit = q.MAG_LIMIT();
          out.push_back(c);
        }))
      why = "query frames must be size-prefixed $SKQ records";
  }
  if (out.empty() && why.empty()) why = "no $SKQ cone (RA_DEG, DEC_DEG, RADIUS_DEG) on query";
  return out;
}
}  // namespace

// The angular layer's tiles that a cone may touch: the pixel's center within
// the cone's radius plus the pixel's own radius plus 12"/yr of motion between
// J2016.0 and the query's epoch (Barnard's star moves 10.4"/yr).
extern "C" int cone_tiles() {
  std::string why;
  const auto cs = cones(why);
  if (!why.empty()) return fail(why);
  static std::map<int, std::vector<double>> radii;
  std::vector<uint8_t> out;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "tiles") != 0) continue;
    const bool ok = go::eachRecord(f->payload, f->payload_length, "$SKT", [&](const uint8_t* p, size_t n) {
      const SKT& t = *GetSKT(p);
      if (t.PARTITION() != sktPartitionScheme::HEALPIX || t.ORDER() > 8) return;
      auto& r = radii[t.ORDER()];
      if (r.empty()) r = hp::pixelRadii(t.ORDER());
      if (t.PIXEL() >= r.size()) return;
      double c[3];
      hp::pix2vec(t.ORDER(), t.PIXEL(), c);
      for (const Cone& k : cs) {
        const double motion = 12.0 / 3600 * as::kDeg * std::fabs(k.years - go::kGaiaEpoch);
        if (hp::angle(c, k.u) <= k.radiusRad + r[t.PIXEL()] + motion) { out.insert(out.end(), p - 4, p + n); return; }
      }
    });
    if (!ok) return fail("tiles frames must be size-prefixed $SKT records");
  }
  return typed("tiles", "SKT.fbs", "$SKT", "SKT", out);
}

// The rows inside any cone at its epoch (space motion from each row's own
// STAR_EPOCH), no fainter than its MAG_LIMIT in G.
extern "C" int cone_rows() {
  std::string why;
  const auto cs = cones(why);
  if (!why.empty()) return fail(why);
  std::vector<uint8_t> out;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "rows") != 0) continue;
    const bool ok = go::eachRecord(f->payload, f->payload_length, "$STR", [&](const uint8_t* p, size_t n) {
      const STR& r = *GetSTR(p);
      for (const Cone& k : cs) {
        if (std::isfinite(k.magLimit) && !(r.GMAG() <= k.magLimit)) continue;
        const auto at = as::propagate(r.RA(), r.DEC(), r.PMRA(), r.PMDEC(), r.PARALLAX(), r.RADIAL_VELOCITY(), r.STAR_EPOCH(), k.years);
        double u[3];
        as::unit(at.raDeg, at.decDeg, u);
        if (hp::angle(u, k.u) <= k.radiusRad) { out.insert(out.end(), p - 4, p + n); return; }
      }
    });
    if (!ok) return fail("rows frames must be size-prefixed $STR records");
  }
  return typed("rows", "STR.fbs", "$STR", "STR", out);
}
