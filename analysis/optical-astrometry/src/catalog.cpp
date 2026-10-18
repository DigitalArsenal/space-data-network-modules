// Reference stars: SDS star records (`$STR`, full rows) and packed sky tiles
// (`$SKT` POINT_SOURCES, the SDN star-catalog layers), turned into apparent
// directions in GCRS axes for an observer: space motion and parallax from the
// row's own epoch (eraPmpx), light deflection by the Sun (eraLdsun) and
// stellar aberration by the observer's barycentric velocity (eraAb), the
// sequence of ERFA's eraAtciq with the bias-precession-nutation left out
// (eraApcs sets it to identity for GCRS). Refraction is not applied to the
// stars: a satellite in the same field is refracted alike, so the plate
// model absorbs it and the reduced directions are unrefracted.
namespace oa {

struct Star {
  double ra = 0, dec = 0;        // radians, catalog place at epoch
  double pmra = 0, pmdec = 0;    // mas/yr (pmra includes cos dec)
  double parallax = 0;           // mas
  double epoch = 2000.0;         // Julian year (TT)
  double mag = kNaN;             // V
  V3 dir;                        // apparent GCRS direction for the current observer
};

struct Catalog {
  std::vector<Star> stars;
  double grid = 0.5 * kDeg;      // dec band height
  std::vector<int> band_start;   // first cell of each dec band
  std::vector<int> band_cells;
  std::vector<std::vector<int>> cells;
  std::string sources;           // layer ids / catalog versions read

  int band_of(double dec) const {
    return std::clamp(static_cast<int>((dec + kPi / 2) / grid), 0, static_cast<int>(band_start.size()) - 1);
  }
  int cell_of(double ra, double dec) const {
    const int b = band_of(dec);
    double r = std::fmod(ra, kTwoPi);
    if (r < 0) r += kTwoPi;
    return band_start[b] + std::min(band_cells[b] - 1, static_cast<int>(r / kTwoPi * band_cells[b]));
  }
  void index() {
    const int bands = static_cast<int>(std::ceil(kPi / grid));
    band_start.assign(bands, 0);
    band_cells.assign(bands, 1);
    int total = 0;
    for (int b = 0; b < bands; ++b) {
      const double dmid = -kPi / 2 + (b + 0.5) * grid;
      band_cells[b] = std::max(1, static_cast<int>(std::ceil(kTwoPi * std::cos(dmid) / grid)));
      band_start[b] = total;
      total += band_cells[b];
    }
    cells.assign(total, {});
    for (size_t i = 0; i < stars.size(); ++i) {
      double ra, dec;
      unit_to_radec(stars[i].dir, &ra, &dec);
      cells[cell_of(ra, dec)].push_back(static_cast<int>(i));
    }
    // Brightest first inside each cell.
    for (auto& c : cells)
      std::sort(c.begin(), c.end(), [&](int a, int b) {
        const double ma = std::isfinite(stars[a].mag) ? stars[a].mag : 99, mb = std::isfinite(stars[b].mag) ? stars[b].mag : 99;
        return ma < mb;
      });
  }
  // Stars within `radius` of `center`, optionally brighter than `mag_limit`.
  void cone(V3 center, double radius, double mag_limit, std::vector<int>* out) const {
    out->clear();
    double ra, dec;
    unit_to_radec(center, &ra, &dec);
    const double cosr = std::cos(radius);
    const int b0 = band_of(dec - radius), b1 = band_of(dec + radius);
    const double dmax = std::min(kPi / 2, std::fabs(dec) + radius + grid);
    const bool polar = dmax >= kPi / 2 - 1e-9;
    const double cd = std::cos(dmax);
    for (int b = b0; b <= b1; ++b) {
      const double half = polar ? kPi : std::min(kPi, radius / cd + kTwoPi / band_cells[b]);
      const int n = band_cells[b];
      const int c0 = static_cast<int>(std::floor((ra - half) / kTwoPi * n));
      const int c1 = static_cast<int>(std::floor((ra + half) / kTwoPi * n));
      const int span = std::min(n, c1 - c0 + 1);
      for (int k = 0; k < span; ++k) {
        const int c = ((c0 + k) % n + n) % n;
        for (int i : cells[band_start[b] + c]) {
          const Star& s = stars[i];
          if (std::isfinite(mag_limit) && !(s.mag <= mag_limit)) continue;
          if (dot(s.dir, center) >= cosr) out->push_back(i);
        }
      }
    }
  }
};

// Read every `$SKT` POINT_SOURCES tile of a size-prefixed stream.
inline bool read_sky_tiles(const uint8_t* p, size_t n, Catalog* cat, std::string* error) {
  size_t at = 0;
  int tiles = 0;
  while (at + 8 <= n) {
    uint32_t len;
    std::memcpy(&len, p + at, 4);
    if (len < 8 || at + 4 + len > n) { *error = "$SKT stream truncated"; return false; }
    const uint8_t* rec = p + at + 4;
    at += 4 + len;
    // Packed SKTPoint vectors are read field by field, so alignment is not
    // required of the producer (published tiles do not align them).
    flatbuffers::Verifier::Options vo;
    vo.check_alignment = false;
    flatbuffers::Verifier v(rec, len, vo);
    if (!SKTBufferHasIdentifier(rec) || !VerifySKTBuffer(v)) { *error = "$SKT record does not verify"; return false; }
    const SKT* t = GetSKT(rec);
    if (t->PAYLOAD_KIND() != sktPayloadKind::POINT_SOURCES) continue;
    if (t->FRAME() != sktCelestialFrame::ICRS) { *error = "$SKT tile not in ICRS"; return false; }
    if (t->PLACE() != sktPlaceKind::CATALOG) { *error = "$SKT tile is not a catalog place"; return false; }
    if (!t->POINTS()) {
      if (t->POINT_COUNT() > 0) { *error = "$SKT tile payload by PAYLOAD_CID: resolve it before the call"; return false; }
      continue;
    }
    const double epoch = std::isfinite(t->EPOCH()) ? t->EPOCH() : 2000.0;
    for (const SKTPoint* pt : *t->POINTS()) {
      Star s;
      s.ra = pt->RA_FIXED() * (kTwoPi / 4294967296.0);
      s.dec = pt->DEC_FIXED() * (kPi / 2 / 2147483648.0);
      const bool pm_ok = !(pt->FLAGS() & 4) && pt->PMRA() != -32768 && pt->PMDEC() != -32768;
      s.pmra = pm_ok ? pt->PMRA() : 0;
      s.pmdec = pm_ok ? pt->PMDEC() : 0;
      s.parallax = (pt->FLAGS() & 8) ? 0 : pt->PARALLAX() * 0.02;
      s.mag = pt->MAG() == -32768 ? kNaN : pt->MAG() / 1000.0;
      s.epoch = epoch;
      cat->stars.push_back(s);
    }
    if (t->LAYER_ID() && cat->sources.find(t->LAYER_ID()->str()) == std::string::npos)
      cat->sources += (cat->sources.empty() ? "" : "; ") + t->LAYER_ID()->str();
    ++tiles;
  }
  return true;
}

// Read every `$STR` row of a size-prefixed stream; the magnitude is the V
// measurement of PHOTOMETRY when present.
inline bool read_star_rows(const uint8_t* p, size_t n, Catalog* cat, std::string* error) {
  size_t at = 0;
  bool named = false;
  while (at + 8 <= n) {
    uint32_t len;
    std::memcpy(&len, p + at, 4);
    if (len < 8 || at + 4 + len > n) { *error = "$STR stream truncated"; return false; }
    const uint8_t* rec = p + at + 4;
    at += 4 + len;
    flatbuffers::Verifier::Options vo;
    vo.check_alignment = false;
    flatbuffers::Verifier v(rec, len, vo);
    if (!STRBufferHasIdentifier(rec) || !VerifySTRBuffer(v)) { *error = "$STR record does not verify"; return false; }
    const STR* r = GetSTR(rec);
    Star s;
    s.ra = r->RA() * kDeg;
    s.dec = r->DEC() * kDeg;
    s.pmra = std::isfinite(r->PMRA()) ? r->PMRA() : 0;
    s.pmdec = std::isfinite(r->PMDEC()) ? r->PMDEC() : 0;
    s.parallax = std::isfinite(r->PARALLAX()) && r->PARALLAX() > 0 ? r->PARALLAX() : 0;
    s.epoch = r->STAR_EPOCH() > 1000 ? r->STAR_EPOCH() : 2000.0;
    if (r->PHOTOMETRY())
      for (const PHBMeasurement* m : *r->PHOTOMETRY())
        if (m->BAND_ID() && m->BAND_ID()->str() == "V" && std::isfinite(m->VALUE())) s.mag = m->VALUE();
    if (!std::isfinite(s.mag) && std::isfinite(r->GMAG()) && r->GMAG() != 0) s.mag = r->GMAG();
    cat->stars.push_back(s);
    if (!named && r->CAT_VERSION()) {
      cat->sources += (cat->sources.empty() ? "" : "; ") + r->CAT_VERSION()->str();
      named = true;
    }
  }
  return true;
}

// Apparent GCRS directions of every star for an observer whose GCRS position
// and velocity are pv (m, m/s), at TDB (two-part JD). Returns the Julian
// epoch used for space motion.
inline void apparent_places(Catalog* cat, double tdb1, double tdb2, const double pv[2][3]) {
  eraASTROM astrom;
  double pvc[2][3];
  std::memcpy(pvc, pv, sizeof pvc);
  eraApcs13(tdb1, tdb2, pvc, &astrom);
  const double jyr = 2000.0 + ((tdb1 - 2451545.0) + tdb2) / 365.25;
  const double mas = kArcsec / 1000.0;
  for (Star& s : cat->stars) {
    const double cd = std::cos(s.dec);
    const double pr = cd > 1e-9 ? s.pmra * mas / cd : 0.0;
    double pco[3], pnat[3], ppr[3];
    eraPmpx(s.ra, s.dec, pr, s.pmdec * mas, s.parallax / 1000.0, 0.0, jyr - s.epoch, astrom.eb, pco);
    eraLdsun(pco, astrom.eh, astrom.em, pnat);
    eraAb(pnat, astrom.v, astrom.em, astrom.bm1, ppr);
    s.dir = unit(V3{ppr[0], ppr[1], ppr[2]});
  }
}

}  // namespace oa
