// Blind plate solving by geometric hashing of four-star asterisms, after
// Lang, Hogg, Mierle, Blanton & Roweis (2010), "Astrometry.net: Blind
// astrometric calibration of arbitrary astronomical images", AJ 139, 1782:
//  - a quad is four stars; A and B are the most widely separated pair, C and
//    D lie inside the circle with diameter AB;
//  - its code is (xC, yC, xD, yD) in the frame that puts A at (0, 0) and B at
//    (1, 1), made unique by xC <= xD and xC + xD <= 1;
//  - the index holds quads of catalog stars, a few per sky cell at each
//    scale band (their "uniformization" of the index over the sky);
//  - image quads look up nearby codes (both parities); each hit is a
//    hypothesis verified by projecting the catalog and counting matches,
//    accepted when the chance-coincidence probability is below 1e-9 (their
//    log-odds threshold), then refined by least squares.
// The index is built in memory from the catalog the call carries.
namespace oa {

struct Quad {
  int star[4];
  float code[4];
};

struct QuadIndex {
  double lo = 0, hi = 0;          // AB separation band, radians
  std::vector<Quad> quads;
  std::vector<std::pair<uint64_t, int>> keys;  // sorted (bin key, quad)
  static constexpr double kBin = 0.01;
  static uint64_t key_of(const int b[4]) {
    uint64_t k = 0;
    for (int i = 0; i < 4; ++i) k = (k << 16) | static_cast<uint64_t>((b[i] + 4096) & 0xffff);
    return k;
  }
};

// Code of four points in a plane; returns false when A, B coincide.
// Points p[0..3] are A, B, C, D; the order may be swapped to canonical form.
inline bool quad_code(double px[4], double py[4], int order[4], float code[4]) {
  const double dx = px[1] - px[0], dy = py[1] - py[0];
  const double d2 = dx * dx + dy * dy;
  if (d2 <= 0) return false;
  auto frame = [&](int a, int b, int i, double* u, double* v) {
    // Similarity putting a -> (0,0), b -> (1,1): z' = (z - za) * (1 + i) / (zb - za).
    const double ex = px[b] - px[a], ey = py[b] - py[a];
    const double rx = px[i] - px[a], ry = py[i] - py[a];
    const double den = ex * ex + ey * ey;
    // (rx + i ry) / (ex + i ey) = ((rx ex + ry ey) + i (ry ex - rx ey)) / den
    const double qr = (rx * ex + ry * ey) / den, qi = (ry * ex - rx * ey) / den;
    // times (1 + i)
    *u = qr - qi;
    *v = qr + qi;
  };
  int a = 0, b = 1, c = 2, d = 3;
  double xc, yc, xd, yd;
  frame(a, b, c, &xc, &yc);
  frame(a, b, d, &xd, &yd);
  if (xc + xd > 1.0) {
    std::swap(a, b);
    frame(a, b, c, &xc, &yc);
    frame(a, b, d, &xd, &yd);
  }
  if (xc > xd) {
    std::swap(c, d);
    std::swap(xc, xd);
    std::swap(yc, yd);
  }
  order[0] = a; order[1] = b; order[2] = c; order[3] = d;
  code[0] = static_cast<float>(xc); code[1] = static_cast<float>(yc);
  code[2] = static_cast<float>(xd); code[3] = static_cast<float>(yd);
  return true;
}

inline void tangent_basis(V3 t, V3* e, V3* n) {
  V3 pole{0, 0, 1};
  *e = cross(pole, t);
  if (norm(*e) < 1e-12) *e = V3{0, 1, 0};
  *e = unit(*e);
  *n = cross(t, *e);
}

inline void build_index_band(const Catalog& cat, double lo, double hi, int per_cell, QuadIndex* idx) {
  idx->lo = lo;
  idx->hi = hi;
  const double g = lo;
  const int bands = static_cast<int>(std::ceil(kPi / g));
  std::vector<int> near, inside;
  for (int b = 0; b < bands; ++b) {
    const double dec0 = -kPi / 2 + b * g, dec1 = dec0 + g;
    const double dmid = 0.5 * (dec0 + dec1);
    const int ncell = std::max(1, static_cast<int>(std::ceil(kTwoPi * std::cos(dmid) / g)));
    for (int c = 0; c < ncell; ++c) {
      const double ra0 = kTwoPi * c / ncell, ra1 = kTwoPi * (c + 1) / ncell;
      const V3 center = radec_to_unit(0.5 * (ra0 + ra1), dmid);
      cat.cone(center, hi * 0.75 + g, kNaN, &near);
      if (near.size() < 4) continue;
      std::sort(near.begin(), near.end(), [&](int x, int y) {
        const double mx = std::isfinite(cat.stars[x].mag) ? cat.stars[x].mag : 99, my = std::isfinite(cat.stars[y].mag) ? cat.stars[y].mag : 99;
        return mx < my;
      });
      if (near.size() > 30) near.resize(30);
      struct Pair { int a, b, rank; };
      std::vector<Pair> pairs;
      for (size_t i = 0; i < near.size(); ++i)
        for (size_t j = i + 1; j < near.size(); ++j) {
          const double s = separation(cat.stars[near[i]].dir, cat.stars[near[j]].dir);
          if (s < lo || s > hi) continue;
          const V3 mid = unit(cat.stars[near[i]].dir + cat.stars[near[j]].dir);
          double mra, mdec;
          unit_to_radec(mid, &mra, &mdec);
          if (mdec < dec0 || mdec >= dec1 || mra < ra0 || mra >= ra1) continue;
          pairs.push_back({near[i], near[j], static_cast<int>(std::max(i, j))});
        }
      std::sort(pairs.begin(), pairs.end(), [](const Pair& x, const Pair& y) { return x.rank < y.rank; });
      int made = 0;
      for (const Pair& pr : pairs) {
        if (made >= per_cell) break;
        const V3 A = cat.stars[pr.a].dir, B = cat.stars[pr.b].dir;
        const V3 mid = unit(A + B);
        const double rad = 0.5 * separation(A, B);
        cat.cone(mid, rad, kNaN, &inside);
        std::vector<int> cd;
        for (int k : inside)
          if (k != pr.a && k != pr.b) cd.push_back(k);
        if (cd.size() < 2) continue;
        std::sort(cd.begin(), cd.end(), [&](int x, int y) {
          const double mx = std::isfinite(cat.stars[x].mag) ? cat.stars[x].mag : 99, my = std::isfinite(cat.stars[y].mag) ? cat.stars[y].mag : 99;
          return mx < my;
        });
        V3 e, n;
        tangent_basis(mid, &e, &n);
        const int combos[6][2] = {{0, 1}, {0, 2}, {1, 2}, {0, 3}, {1, 3}, {2, 3}};
        for (int q = 0; q < 6; ++q) {
          if (combos[q][1] >= static_cast<int>(cd.size())) continue;
          const int ids[4] = {pr.a, pr.b, cd[combos[q][0]], cd[combos[q][1]]};
          double px[4], py[4];
          for (int k = 0; k < 4; ++k) {
            const V3 d = cat.stars[ids[k]].dir;
            const double w = dot(d, mid);
            px[k] = dot(d, e) / w;
            py[k] = dot(d, n) / w;
          }
          Quad quad;
          int order[4];
          if (!quad_code(px, py, order, quad.code)) continue;
          for (int k = 0; k < 4; ++k) quad.star[k] = ids[order[k]];
          idx->quads.push_back(quad);
        }
        ++made;
      }
    }
  }
  idx->keys.reserve(idx->quads.size());
  for (size_t i = 0; i < idx->quads.size(); ++i) {
    int bin[4];
    for (int k = 0; k < 4; ++k) bin[k] = static_cast<int>(std::floor(idx->quads[i].code[k] / QuadIndex::kBin));
    idx->keys.push_back({QuadIndex::key_of(bin), static_cast<int>(i)});
  }
  std::sort(idx->keys.begin(), idx->keys.end());
}

struct SolveOptions {
  int image_sources = 50;        // brightest usable sources forming image quads
  int inside_sources = 8;        // brightest sources inside an AB circle tried as C, D
  double code_tolerance = 0.012;
  double match_radius_px = 6.0;  // first verification radius
  double log10_odds = 9.0;       // accept when P(chance) < 10^-log10_odds
  int min_matches = 8;
  double catalog_sigma_arcsec = 0.1;
};

struct SolveResult {
  bool solved = false;
  Wcs wcs;
  PlateFit fit;
  std::vector<PlateMatch> matches;
  int hypotheses = 0;
  double log10_false = 0;
};

// Match image sources to projected catalog stars one-to-one (nearest
// first) within radius; returns matches.
inline std::vector<PlateMatch> match_catalog(const Wcs& w, const Catalog& cat, const Detection& det, int width, int height,
                                               double radius_px, bool stars_only, int* projected) {
  std::vector<PlateMatch> out;
  const V3 center = w.pixel_to_sky(width / 2.0, height / 2.0);
  const double half = std::hypot(width, height) / 2.0 * w.pixel_scale() * 1.05;
  std::vector<int> cone;
  cat.cone(center, half, kNaN, &cone);
  struct Cand { double d2; int s, k; double x, y; };
  std::vector<Cand> cands;
  int nproj = 0;
  // Bucket sources by pixel cell for speed.
  const int cell = std::max(8, static_cast<int>(radius_px * 2));
  const int gx = width / cell + 1, gy = height / cell + 1;
  std::vector<std::vector<int>> grid(static_cast<size_t>(gx) * gy);
  for (size_t i = 0; i < det.sources.size(); ++i) {
    const Source& s = det.sources[i];
    if (stars_only && s.kind != 1) continue;
    if (s.edge) continue;
    const int cx = std::clamp(static_cast<int>(s.x / cell), 0, gx - 1), cy = std::clamp(static_cast<int>(s.y / cell), 0, gy - 1);
    grid[static_cast<size_t>(cy) * gx + cx].push_back(static_cast<int>(i));
  }
  for (int k : cone) {
    double x, y;
    if (!w.sky_to_pixel(cat.stars[k].dir, &x, &y)) continue;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    ++nproj;
    const int cx = static_cast<int>(x / cell), cy = static_cast<int>(y / cell);
    for (int yy = std::max(0, cy - 1); yy <= std::min(gy - 1, cy + 1); ++yy)
      for (int xx = std::max(0, cx - 1); xx <= std::min(gx - 1, cx + 1); ++xx)
        for (int i : grid[static_cast<size_t>(yy) * gx + xx]) {
          const Source& s = det.sources[i];
          const double d2 = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
          if (d2 <= radius_px * radius_px) cands.push_back({d2, i, k, x, y});
        }
  }
  std::sort(cands.begin(), cands.end(), [](const Cand& a, const Cand& b) { return a.d2 < b.d2; });
  std::vector<char> used_s(det.sources.size(), 0);
  std::map<int, char> used_k;
  for (const Cand& c : cands) {
    if (used_s[c.s] || used_k.count(c.k)) continue;
    used_s[c.s] = 1;
    used_k[c.k] = 1;
    const Source& s = det.sources[c.s];
    PlateMatch m;
    m.source = c.s; m.star = c.k; m.x = s.x; m.y = s.y; m.cxx = s.cxx; m.cxy = s.cxy; m.cyy = s.cyy;
    m.dir = cat.stars[c.k].dir;
    out.push_back(m);
  }
  if (projected) *projected = nproj;
  return out;
}

// log10 of the binomial tail P(X >= k), X ~ Bin(n, p).
inline double log10_binomial_tail(int n, int k, double p) {
  if (k <= 0) return 0;
  if (p <= 0) return -300;
  if (p >= 1) return 0;
  double total = 0;
  double best = -1e300;
  std::vector<double> terms;
  for (int i = k; i <= n; ++i) {
    const double lg = std::lgamma(n + 1.0) - std::lgamma(i + 1.0) - std::lgamma(n - i + 1.0) + i * std::log(p) + (n - i) * std::log1p(-p);
    terms.push_back(lg);
    best = std::max(best, lg);
  }
  for (double t : terms) total += std::exp(t - best);
  return (best + std::log(total)) / std::log(10.0);
}

// Refine a verified WCS: match, fit linear, re-match tighter, fit with the
// order the match count supports.
inline bool refine_solution(Wcs* w, const Catalog& cat, const Detection& det, int width, int height, const SolveOptions& opt,
                            std::vector<PlateMatch>* matches, PlateFit* fit) {
  double radius = opt.match_radius_px;
  for (int pass = 0; pass < 4; ++pass) {
    int nproj = 0;
    *matches = match_catalog(*w, cat, det, width, height, radius, true, &nproj);
    if (static_cast<int>(matches->size()) < opt.min_matches) return false;
    const int order = matches->size() >= 24 && pass >= 1 ? 2 : 1;
    if (!fit_plate(w, *matches, order, opt.catalog_sigma_arcsec * kArcsec, 4.0, fit)) return false;
    radius = std::max(2.5, std::min(radius, 4.0 * fit->p90_arcsec * kArcsec / w->pixel_scale() + 1.0));
  }
  return true;
}

inline SolveResult blind_solve(const std::vector<QuadIndex>& indexes, const Catalog& cat, const Detection& det, int width, int height,
                               const SolveOptions& opt) {
  SolveResult result;
  std::vector<int> use;
  for (size_t i = 0; i < det.sources.size() && static_cast<int>(use.size()) < opt.image_sources; ++i) {
    const Source& s = det.sources[i];
    if (s.edge || s.kind != 1) continue;
    use.push_back(static_cast<int>(i));
  }
  if (use.size() < 6) return result;
  const double diag = std::hypot(width, height);
  const int n = static_cast<int>(use.size());
  int usable = 0;
  for (const Source& s : det.sources) usable += (!s.edge && s.kind == 1);
  for (int ia = 0; ia < n; ++ia)
    for (int ib = ia + 1; ib < n; ++ib) {
      const Source& A = det.sources[use[ia]];
      const Source& B = det.sources[use[ib]];
      const double dab = std::hypot(A.x - B.x, A.y - B.y);
      if (dab < 0.12 * diag || dab > 0.95 * diag) continue;
      const double mx = 0.5 * (A.x + B.x), my = 0.5 * (A.y + B.y);
      std::vector<int> inside;
      for (int ic = 0; ic < n; ++ic) {
        if (ic == ia || ic == ib) continue;
        const Source& C = det.sources[use[ic]];
        if (std::hypot(C.x - mx, C.y - my) < 0.5 * dab) inside.push_back(use[ic]);
      }
      if (inside.size() < 2) continue;
      const int lim = std::min<int>(opt.inside_sources, inside.size());
      for (int c1 = 0; c1 < lim; ++c1)
        for (int c2 = c1 + 1; c2 < lim; ++c2) {
          const int ids[4] = {use[ia], use[ib], inside[c1], inside[c2]};
          for (int parity = 0; parity < 2; ++parity) {
            double px[4], py[4];
            for (int k = 0; k < 4; ++k) {
              // Parity: mirror the image (swap axes) so a flipped sky matches.
              px[k] = parity ? det.sources[ids[k]].y : det.sources[ids[k]].x;
              py[k] = parity ? det.sources[ids[k]].x : det.sources[ids[k]].y;
            }
            float code[4];
            int order[4];
            if (!quad_code(px, py, order, code)) continue;
            int img[4];
            for (int k = 0; k < 4; ++k) img[k] = ids[order[k]];
            for (const QuadIndex& idx : indexes) {
              int base[4];
              for (int k = 0; k < 4; ++k) base[k] = static_cast<int>(std::floor(code[k] / QuadIndex::kBin));
              for (int nb = 0; nb < 81; ++nb) {
                int bin[4];
                int r = nb;
                for (int k = 0; k < 4; ++k) { bin[k] = base[k] + (r % 3) - 1; r /= 3; }
                const uint64_t key = QuadIndex::key_of(bin);
                auto it = std::lower_bound(idx.keys.begin(), idx.keys.end(), std::make_pair(key, -1));
                for (; it != idx.keys.end() && it->first == key; ++it) {
                  const Quad& q = idx.quads[it->second];
                  double d2 = 0;
                  for (int k = 0; k < 4; ++k) d2 += (q.code[k] - code[k]) * (q.code[k] - code[k]);
                  if (d2 > opt.code_tolerance * opt.code_tolerance) continue;
                  ++result.hypotheses;
                  // Affine pixel -> tangent plane at the quad center from the 4 pairs.
                  const V3 mid = unit(cat.stars[q.star[0]].dir + cat.stars[q.star[1]].dir);
                  V3 e, nn;
                  tangent_basis(mid, &e, &nn);
                  double N[3][3] = {{0}}, bx[3] = {0}, by[3] = {0};
                  for (int k = 0; k < 4; ++k) {
                    const V3 d = cat.stars[q.star[k]].dir;
                    const double w0 = dot(d, mid);
                    const double xi = dot(d, e) / w0, eta = dot(d, nn) / w0;
                    const double u = (det.sources[img[k]].x - width / 2.0) / 1000.0, v = (det.sources[img[k]].y - height / 2.0) / 1000.0;
                    const double t[3] = {1, u, v};
                    for (int a = 0; a < 3; ++a) {
                      bx[a] += t[a] * xi;
                      by[a] += t[a] * eta;
                      for (int bb = 0; bb < 3; ++bb) N[a][bb] += t[a] * t[bb];
                    }
                  }
                  std::vector<double> Nm(9), sx(bx, bx + 3), sy(by, by + 3);
                  for (int a = 0; a < 3; ++a)
                    for (int bb = 0; bb < 3; ++bb) Nm[a * 3 + bb] = N[a][bb];
                  if (!cholesky_solve(Nm, 3, &sx, nullptr) || !cholesky_solve(Nm, 3, &sy, nullptr)) continue;
                  Wcs w;
                  w.tangent = mid; w.east = e; w.north = nn;
                  w.crpix_x = width / 2.0; w.crpix_y = height / 2.0;
                  w.order = 1;
                  for (int a = 0; a < 3; ++a) { w.c[0][a] = sx[a]; w.c[1][a] = sy[a]; }
                  // Isotropy check: an image has square-ish pixels.
                  double j[2][2];
                  w.jacobian(w.crpix_x, w.crpix_y, j);
                  const double s1 = std::hypot(j[0][0], j[1][0]), s2 = std::hypot(j[0][1], j[1][1]);
                  if (!(s1 > 0 && s2 > 0) || std::fabs(std::log(s1 / s2)) > 0.15) continue;
                  int nproj = 0;
                  std::vector<PlateMatch> m = match_catalog(w, cat, det, width, height, opt.match_radius_px, true, &nproj);
                  const int k = static_cast<int>(m.size());
#ifdef OA_DEBUG
                  { double ra, dec; unit_to_radec(w.pixel_to_sky(width / 2.0, height / 2.0), &ra, &dec);
                    if (k >= 6) std::printf("    hyp k=%d nproj=%d scale=%.2f ra=%.3f dec=%.3f\n", k, nproj, w.pixel_scale() / kArcsec, ra / kDeg, dec / kDeg); }
#endif
                  if (k < opt.min_matches) continue;
                  const double p = std::min(1.0, usable * kPi * opt.match_radius_px * opt.match_radius_px / (double(width) * height));
                  double lf = log10_binomial_tail(nproj, k, p);
                  if (lf > -opt.log10_odds) continue;
                  std::vector<PlateMatch> refined;
                  PlateFit fit;
                  if (!refine_solution(&w, cat, det, width, height, opt, &refined, &fit)) continue;
                  // Re-verify the refined solution at its own match radius.
                  {
                    const double rad = std::max(2.5, 3.0 * fit.p90_arcsec * kArcsec / w.pixel_scale());
                    int np2 = 0;
                    const std::vector<PlateMatch> again = match_catalog(w, cat, det, width, height, rad, true, &np2);
                    const double p2 = std::min(1.0, usable * kPi * rad * rad / (double(width) * height));
                    const double lf2 = log10_binomial_tail(np2, static_cast<int>(again.size()), p2);
                    if (lf2 > -opt.log10_odds - 3.0 || fit.used < opt.min_matches + 2) continue;
                    lf = std::min(lf, lf2);
                  }
                  result.solved = true;
                  result.wcs = w;
                  result.fit = fit;
                  result.matches = refined;
                  result.log10_false = lf;
                  return result;
                }
              }
            }
          }
        }
    }
  return result;
}

}  // namespace oa
