// Plate model: the gnomonic (TAN) projection about a tangent point with a
// linear or quadratic polynomial from pixel offsets to standard coordinates
// (xi, eta) in radians (Calabretta & Greisen 2002, FITS WCS Paper II, TAN;
// polynomial plate constants as in classical photographic astrometry,
// e.g. Green 1985, Spherical Astronomy, ch. 13). Fitted by weighted least
// squares with each centroid's covariance, iteratively clipped; the
// constant terms move the tangent point until they vanish.
namespace oa {

struct Wcs {
  V3 tangent{1, 0, 0};
  V3 east{0, 1, 0};
  V3 north{0, 0, 1};
  double crpix_x = 0, crpix_y = 0;
  int order = 1;                       // 1: linear, 2: quadratic
  double c[2][6] = {{0}};              // xi, eta = sum c[k][j] * term_j(u, v); terms 1, u, v, u^2, uv, v^2 (u, v in kpx)
  std::vector<double> covariance;      // of the 2 x terms coefficients, scaled by the reduced chi^2
  bool valid = false;

  void set_tangent(V3 t) {
    tangent = unit(t);
    V3 pole{0, 0, 1};
    east = cross(pole, tangent);
    if (norm(east) < 1e-12) east = V3{0, 1, 0};
    east = unit(east);
    north = cross(tangent, east);
  }
  static int terms(int order) { return order >= 2 ? 6 : 3; }
  static void basis(double u, double v, double* t) {
    t[0] = 1; t[1] = u; t[2] = v; t[3] = u * u; t[4] = u * v; t[5] = v * v;
  }
  void standard(double x, double y, double* xi, double* eta) const {
    double t[6];
    basis((x - crpix_x) / 1000.0, (y - crpix_y) / 1000.0, t);
    const int m = terms(order);
    *xi = 0; *eta = 0;
    for (int j = 0; j < m; ++j) { *xi += c[0][j] * t[j]; *eta += c[1][j] * t[j]; }
  }
  V3 pixel_to_sky(double x, double y) const {
    double xi, eta;
    standard(x, y, &xi, &eta);
    return unit(tangent + east * xi + north * eta);
  }
  bool project(V3 d, double* xi, double* eta) const {
    const double w = dot(d, tangent);
    if (w <= 1e-6) return false;
    *xi = dot(d, east) / w;
    *eta = dot(d, north) / w;
    return true;
  }
  // Linear Jacobian d(xi, eta)/d(x, y) at a pixel, rad/px.
  void jacobian(double x, double y, double j[2][2]) const {
    const double u = (x - crpix_x) / 1000.0, v = (y - crpix_y) / 1000.0;
    for (int k = 0; k < 2; ++k) {
      double du = c[k][1], dv = c[k][2];
      if (order >= 2) { du += 2 * c[k][3] * u + c[k][4] * v; dv += c[k][4] * u + 2 * c[k][5] * v; }
      j[k][0] = du / 1000.0;
      j[k][1] = dv / 1000.0;
    }
  }
  bool sky_to_pixel(V3 d, double* x, double* y) const {
    double xi, eta;
    if (!project(d, &xi, &eta)) return false;
    double px = crpix_x, py = crpix_y;
    for (int it = 0; it < 8; ++it) {
      double cx, cy, j[2][2];
      standard(px, py, &cx, &cy);
      jacobian(px, py, j);
      const double det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
      if (std::fabs(det) < 1e-30) return false;
      const double rx = xi - cx, ry = eta - cy;
      const double dx = (j[1][1] * rx - j[0][1] * ry) / det, dy = (-j[1][0] * rx + j[0][0] * ry) / det;
      px += dx; py += dy;
      if (std::fabs(dx) + std::fabs(dy) < 1e-7) break;
    }
    *x = px; *y = py;
    return true;
  }
  double pixel_scale() const {  // rad/px, geometric mean
    double j[2][2];
    jacobian(crpix_x, crpix_y, j);
    return std::sqrt(std::fabs(j[0][0] * j[1][1] - j[0][1] * j[1][0]));
  }
  // 1-sigma position uncertainty of the plate model itself at a pixel, as a
  // 2x2 covariance in (xi, eta), rad^2.
  void model_covariance(double x, double y, double out[2][2]) const {
    out[0][0] = out[0][1] = out[1][0] = out[1][1] = 0;
    const int m = terms(order);
    if (covariance.size() != static_cast<size_t>(4 * m * m)) return;
    double t[6];
    basis((x - crpix_x) / 1000.0, (y - crpix_y) / 1000.0, t);
    for (int a = 0; a < 2; ++a)
      for (int b = 0; b < 2; ++b) {
        double s = 0;
        for (int i = 0; i < m; ++i)
          for (int k = 0; k < m; ++k) s += t[i] * covariance[(a * m + i) * 2 * m + (b * m + k)] * t[k];
        out[a][b] = s;
      }
  }
};

struct PlateMatch {
  int source = -1;   // index into the detection
  int star = -1;     // index into the catalogue
  double x = 0, y = 0, cxx = 0, cxy = 0, cyy = 0;
  V3 dir;
  double res_xi = 0, res_eta = 0;  // arcsec, star minus model
  double chi2 = 0;
  bool outlier = false;
};

struct PlateFit {
  int used = 0, outliers = 0;
  double median_arcsec = kNaN, rms_arcsec = kNaN, p90_arcsec = kNaN;
  double reduced_chi2 = kNaN;
};

// One weighted solve for the coefficients with the tangent point fixed.
inline bool solve_coefficients(Wcs* w, std::vector<PlateMatch>& m, double catalog_sigma_rad, double* chi2_out, int* dof_out) {
  const int nt = Wcs::terms(w->order), np = 2 * nt;
  std::vector<double> N(np * np, 0.0), b(np, 0.0);
  int used = 0;
  double scale2 = w->pixel_scale();
  if (!(scale2 > 0)) scale2 = 1e-5;
  scale2 *= scale2;
  for (PlateMatch& p : m) {
    if (p.outlier) continue;
    double xi, eta;
    if (!w->project(p.dir, &xi, &eta)) { p.outlier = true; continue; }
    double t[6];
    Wcs::basis((p.x - w->crpix_x) / 1000.0, (p.y - w->crpix_y) / 1000.0, t);
    // Measurement covariance in (xi, eta): J C J^T + catalogue term.
    double j[2][2];
    w->jacobian(p.x, p.y, j);
    double C[2][2] = {{p.cxx, p.cxy}, {p.cxy, p.cyy}};
    double S[2][2];
    for (int a = 0; a < 2; ++a)
      for (int bb = 0; bb < 2; ++bb) {
        double s = 0;
        for (int k = 0; k < 2; ++k)
          for (int l = 0; l < 2; ++l) s += j[a][k] * C[k][l] * j[bb][l];
        S[a][bb] = s;
      }
    if (!(S[0][0] > 0)) { S[0][0] = S[1][1] = scale2; S[0][1] = S[1][0] = 0; }
    S[0][0] += catalog_sigma_rad * catalog_sigma_rad;
    S[1][1] += catalog_sigma_rad * catalog_sigma_rad;
    const double det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    const double W[2][2] = {{S[1][1] / det, -S[0][1] / det}, {-S[1][0] / det, S[0][0] / det}};
    const double z[2] = {xi, eta};
    for (int a = 0; a < 2; ++a)
      for (int i = 0; i < nt; ++i) {
        const int row = a * nt + i;
        for (int bb = 0; bb < 2; ++bb) {
          b[row] += t[i] * W[a][bb] * z[bb];
          for (int k = 0; k < nt; ++k) N[row * np + bb * nt + k] += t[i] * W[a][bb] * t[k];
        }
      }
    ++used;
  }
  if (used * 2 < np + 2) return false;
  std::vector<double> inv;
  if (!cholesky_solve(N, np, &b, &inv)) return false;
  for (int a = 0; a < 2; ++a)
    for (int i = 0; i < nt; ++i) w->c[a][i] = b[a * nt + i];
  for (int a = 0; a < 2; ++a)
    for (int i = nt; i < 6; ++i) w->c[a][i] = 0;
  // Chi-square and residuals.
  double chi2 = 0;
  for (PlateMatch& p : m) {
    double xi, eta, mx, my;
    if (!w->project(p.dir, &xi, &eta)) continue;
    w->standard(p.x, p.y, &mx, &my);
    double j[2][2];
    w->jacobian(p.x, p.y, j);
    double C[2][2] = {{p.cxx, p.cxy}, {p.cxy, p.cyy}};
    double S[2][2];
    for (int a = 0; a < 2; ++a)
      for (int bb = 0; bb < 2; ++bb) {
        double s = 0;
        for (int k = 0; k < 2; ++k)
          for (int l = 0; l < 2; ++l) s += j[a][k] * C[k][l] * j[bb][l];
        S[a][bb] = s;
      }
    S[0][0] += catalog_sigma_rad * catalog_sigma_rad;
    S[1][1] += catalog_sigma_rad * catalog_sigma_rad;
    const double det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    const double rx = xi - mx, ry = eta - my;
    p.res_xi = rx / kArcsec;
    p.res_eta = ry / kArcsec;
    p.chi2 = (S[1][1] * rx * rx - 2 * S[0][1] * rx * ry + S[0][0] * ry * ry) / det;
    if (!p.outlier) chi2 += p.chi2;
  }
  *chi2_out = chi2;
  *dof_out = used * 2 - np;
  w->covariance = inv;
  return true;
}

// Fit with tangent-point recentring and clipping; matches flagged outlier
// keep their residuals for the report.
inline bool fit_plate(Wcs* w, std::vector<PlateMatch>& m, int order, double catalog_sigma_rad, double clip_sigma, PlateFit* fit) {
  w->order = order;
  for (PlateMatch& p : m) p.outlier = false;
  double chi2 = 0;
  int dof = 0;
  for (int pass = 0; pass < 6; ++pass) {
    for (int recentre = 0; recentre < 4; ++recentre) {
      if (!solve_coefficients(w, m, catalog_sigma_rad, &chi2, &dof)) return false;
      // Move the tangent point to the sky position of the reference pixel and
      // solve again, until the constant terms vanish.
      const V3 t = w->pixel_to_sky(w->crpix_x, w->crpix_y);
      if (separation(t, w->tangent) < 1e-11 || recentre == 3) break;
      w->set_tangent(t);
    }
    if (dof <= 0) break;
    const double rchi2 = chi2 / dof;
    const double cut = clip_sigma * clip_sigma * std::max(1.0, rchi2);
    bool changed = false;
    for (PlateMatch& p : m) {
      const bool out = p.chi2 > 2.0 * cut;  // 2 dof: chi2 threshold doubles
      if (out != p.outlier) { p.outlier = out; changed = true; }
    }
    if (!changed) break;
  }
  std::vector<double> mags;
  fit->used = 0;
  fit->outliers = 0;
  for (const PlateMatch& p : m) {
    if (p.outlier) { ++fit->outliers; continue; }
    ++fit->used;
    mags.push_back(std::hypot(p.res_xi, p.res_eta));
  }
  if (mags.empty()) return false;
  fit->median_arcsec = median(mags);
  fit->p90_arcsec = quantile(mags, 0.9);
  double ss = 0;
  for (double v : mags) ss += v * v;
  fit->rms_arcsec = std::sqrt(ss / mags.size());
  fit->reduced_chi2 = dof > 0 ? chi2 / dof : kNaN;
  // Formal coefficient covariance scaled by the reduced chi-square (never down).
  const double s = std::max(1.0, std::isfinite(fit->reduced_chi2) ? fit->reduced_chi2 : 1.0);
  for (double& v : w->covariance) v *= s;
  w->valid = true;
  return true;
}

}  // namespace oa
