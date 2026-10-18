// Source extraction: a tile-median background, a 3x3 matched (box) filter for
// detection, 8-connected segmentation, and flux-weighted moments on the
// unfiltered residual. A streak's centroid is its mid-exposure position for a
// uniform drift; its second moments give length (sqrt(12 lambda_1) for a
// uniform segment), width and position angle. Each source carries its
// centroid covariance from photon-limited moments (King 1983 form: sigma^2 =
// second moment / SNR^2 along each principal axis), floored for the codec.
namespace oa {

struct Source {
  double x = 0, y = 0;           // centroid, pixels (x right, y down, pixel centres integral)
  double flux = 0;               // background-subtracted counts
  double peak = 0;               // highest raw pixel value
  int npix = 0;
  double length = 0;             // sqrt(12 lambda_1), pixels
  double width = 0;              // sqrt(lambda_2), pixels
  double angle = 0;              // major axis from +x toward +y, radians, (-pi/2, pi/2]
  double snr = 0;
  double cxx = 0, cxy = 0, cyy = 0;  // centroid covariance, px^2
  bool saturated = false;
  bool edge = false;             // touches the image border or a masked region
  int kind = 0;                  // 0 unclassified, 1 dominant morphology (stars), 2 compact, 3 other motion
  double trail = 0;              // half-maximum length of a trail, px (0: not measured)
  double trail_sigma = 0;        // its standard error, px
};

struct DetectOptions {
  int tile = 32;
  double threshold_sigma = 3.0;  // on the 3x3-filtered residual
  int min_pixels = 5;
  double centroid_floor_px = 0.1;  // codec and pixel-phase floor, added in quadrature
};

struct Detection {
  std::vector<Source> sources;
  double noise = 0;              // per-pixel residual sigma (MAD)
  double background = 0;         // median background
  double streak_length = 0;      // dominant morphology: median length, px
  double streak_angle = 0;       // dominant morphology: position angle, rad
  bool streaked = false;         // the dominant morphology is elongated
  double psf_sigma = 1.0;        // median cross-streak sigma of bright stars, px
  double trail_length = 0;       // median half-maximum trail length, px
};

// Persistent-overlay mask: pixels above threshold in at least `fraction` of
// the sampled frames (burnt-in text, logos). Regions smaller than
// `min_region` pixels after a 3-pixel dilation are released, so a tracked
// satellite that wanders a few pixels is never masked.
inline std::vector<uint8_t> persistence_mask(const std::vector<std::vector<uint8_t>>& lit, int width, int height,
                                             double fraction, int min_region) {
  std::vector<uint8_t> mask(static_cast<size_t>(width) * height, 0);
  if (lit.empty()) return mask;
  std::vector<int> count(mask.size(), 0);
  for (const auto& l : lit)
    for (size_t i = 0; i < l.size(); ++i) count[i] += l[i];
  const int need = static_cast<int>(std::ceil(fraction * lit.size()));
  std::vector<uint8_t> core(mask.size(), 0);
  for (size_t i = 0; i < mask.size(); ++i) core[i] = count[i] >= need;
  // Dilate by 3 px.
  std::vector<uint8_t> grown(mask.size(), 0);
  for (int y = 0; y < height; ++y)
    for (int x = 0; x < width; ++x) {
      if (!core[static_cast<size_t>(y) * width + x]) continue;
      for (int dy = -3; dy <= 3; ++dy)
        for (int dx = -3; dx <= 3; ++dx) {
          const int xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height) grown[static_cast<size_t>(yy) * width + xx] = 1;
        }
    }
  // Keep only large regions.
  std::vector<int> label(mask.size(), 0);
  int next = 0;
  std::vector<int> stack;
  for (size_t s = 0; s < grown.size(); ++s) {
    if (!grown[s] || label[s]) continue;
    ++next;
    std::vector<size_t> members;
    stack.assign(1, static_cast<int>(s));
    label[s] = next;
    while (!stack.empty()) {
      const int i = stack.back();
      stack.pop_back();
      members.push_back(static_cast<size_t>(i));
      const int x = i % width, y = i / width;
      for (int dy = -1; dy <= 1; ++dy)
        for (int dx = -1; dx <= 1; ++dx) {
          const int xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const size_t j = static_cast<size_t>(yy) * width + xx;
          if (grown[j] && !label[j]) { label[j] = next; stack.push_back(static_cast<int>(j)); }
        }
    }
    if (static_cast<int>(members.size()) >= min_region)
      for (size_t i : members) mask[i] = 1;
  }
  return mask;
}

inline void background_map(const Image& im, int tile, std::vector<float>* bg, double* median_bg) {
  const int nx = std::max(1, (im.width + tile - 1) / tile), ny = std::max(1, (im.height + tile - 1) / tile);
  std::vector<double> grid(static_cast<size_t>(nx) * ny);
  std::vector<double> vals;
  for (int ty = 0; ty < ny; ++ty)
    for (int tx = 0; tx < nx; ++tx) {
      vals.clear();
      for (int y = ty * tile; y < std::min(im.height, (ty + 1) * tile); ++y)
        for (int x = tx * tile; x < std::min(im.width, (tx + 1) * tile); ++x) vals.push_back(im.at(x, y));
      double m = median(vals);
      // One 2.5-sigma clip pass against stars in the tile.
      const double s = robust_sigma(vals);
      if (std::isfinite(s) && s > 0) {
        std::vector<double> kept;
        for (double v : vals)
          if (std::fabs(v - m) < 2.5 * s) kept.push_back(v);
        if (kept.size() > vals.size() / 4) m = median(kept);
      }
      grid[static_cast<size_t>(ty) * nx + tx] = m;
    }
  std::vector<double> all(grid);
  *median_bg = median(all);
  bg->assign(static_cast<size_t>(im.width) * im.height, 0.f);
  for (int y = 0; y < im.height; ++y) {
    const double gy = std::clamp((y + 0.5) / tile - 0.5, 0.0, static_cast<double>(ny - 1));
    const int y0 = std::min(static_cast<int>(gy), ny - 1), y1 = std::min(y0 + 1, ny - 1);
    const double fy = gy - y0;
    for (int x = 0; x < im.width; ++x) {
      const double gx = std::clamp((x + 0.5) / tile - 0.5, 0.0, static_cast<double>(nx - 1));
      const int x0 = std::min(static_cast<int>(gx), nx - 1), x1 = std::min(x0 + 1, nx - 1);
      const double fx = gx - x0;
      const double v = (1 - fy) * ((1 - fx) * grid[y0 * nx + x0] + fx * grid[y0 * nx + x1]) +
                       fy * ((1 - fx) * grid[y1 * nx + x0] + fx * grid[y1 * nx + x1]);
      (*bg)[static_cast<size_t>(y) * im.width + x] = static_cast<float>(v);
    }
  }
}

// Above-threshold map of one frame (for the persistence mask).
inline std::vector<uint8_t> lit_map(const Image& im, const DetectOptions& opt) {
  std::vector<float> bg;
  double mbg = 0;
  background_map(im, opt.tile, &bg, &mbg);
  std::vector<double> sample;
  for (size_t i = 0; i < im.pixels.size(); i += 7) sample.push_back(im.pixels[i] - bg[i]);
  const double noise = std::max(robust_sigma(sample), 1e-6);
  std::vector<uint8_t> lit(im.pixels.size(), 0);
  for (size_t i = 0; i < lit.size(); ++i) lit[i] = (im.pixels[i] - bg[i]) > 4.0 * noise;
  return lit;
}

inline Detection detect_sources(const Image& im, const std::vector<uint8_t>& mask, const DetectOptions& opt) {
  Detection out;
  const int w = im.width, h = im.height;
  std::vector<float> bg;
  background_map(im, opt.tile, &bg, &out.background);
  std::vector<float> res(im.pixels.size());
  for (size_t i = 0; i < res.size(); ++i) res[i] = im.pixels[i] - bg[i];
  std::vector<double> sample;
  for (size_t i = 0; i < res.size(); i += 7)
    if (mask.empty() || !mask[i]) sample.push_back(res[i]);
  out.noise = std::max(robust_sigma(sample), 1e-6);
  // 3x3 box filter: sigma of the mean of 9 pixels is noise/3 for white noise.
  std::vector<float> sm(res.size(), 0.f);
  for (int y = 1; y < h - 1; ++y)
    for (int x = 1; x < w - 1; ++x) {
      float s = 0;
      for (int dy = -1; dy <= 1; ++dy)
        for (int dx = -1; dx <= 1; ++dx) s += res[static_cast<size_t>(y + dy) * w + x + dx];
      sm[static_cast<size_t>(y) * w + x] = s / 9.f;
    }
  std::vector<double> smsample;
  for (size_t i = 0; i < sm.size(); i += 7)
    if (mask.empty() || !mask[i]) smsample.push_back(sm[i]);
  const double smnoise = std::max(robust_sigma(smsample), 1e-6);
  const float thr = static_cast<float>(opt.threshold_sigma * smnoise);
  std::vector<int> label(res.size(), 0);
  std::vector<int> stack;
  int next = 0;
  for (int y0 = 1; y0 < h - 1; ++y0)
    for (int x0 = 1; x0 < w - 1; ++x0) {
      const size_t s0 = static_cast<size_t>(y0) * w + x0;
      if (label[s0] || sm[s0] <= thr) continue;
      ++next;
      std::vector<int> members;
      stack.assign(1, static_cast<int>(s0));
      label[s0] = next;
      bool edge = false;
      while (!stack.empty()) {
        const int i = stack.back();
        stack.pop_back();
        members.push_back(i);
        const int x = i % w, y = i / w;
        if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) edge = true;
        if (!mask.empty() && mask[i]) edge = true;
        for (int dy = -1; dy <= 1; ++dy)
          for (int dx = -1; dx <= 1; ++dx) {
            const int xx = x + dx, yy = y + dy;
            if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
            const size_t j = static_cast<size_t>(yy) * w + xx;
            if (!label[j] && sm[j] > thr) { label[j] = next; stack.push_back(static_cast<int>(j)); }
          }
      }
      if (static_cast<int>(members.size()) < opt.min_pixels) continue;
      // Moments on the unfiltered residual over the component, plus a 1-px
      // rim so the faint wings enter the centroid symmetrically.
      double sw = 0, sx = 0, sy = 0, peak = 0;
      bool sat = false;
      std::vector<int> pix = members;
      for (int i : members) {
        const int x = i % w, y = i / w;
        for (int dy = -1; dy <= 1; ++dy)
          for (int dx = -1; dx <= 1; ++dx) {
            const int j = (y + dy) * w + x + dx;
            if (label[j] == 0) { label[j] = -next; pix.push_back(j); }
          }
      }
      for (int i : pix) {
        const double v = std::max(0.f, res[i]);
        const int x = i % w, y = i / w;
        sw += v; sx += v * x; sy += v * y;
        peak = std::max(peak, static_cast<double>(im.pixels[i]));
        if (im.pixels[i] >= im.saturation - 0.5) sat = true;
      }
      for (int i : pix) if (label[i] < 0) label[i] = 0;
      if (sw <= 0) continue;
      const double cx = sx / sw, cy = sy / sw;
      double mxx = 0, myy = 0, mxy = 0;
      for (int i : pix) {
        const double v = std::max(0.f, res[i]);
        const double dx = i % w - cx, dy = i / w - cy;
        mxx += v * dx * dx; myy += v * dy * dy; mxy += v * dx * dy;
      }
      mxx /= sw; myy /= sw; mxy /= sw;
      const double tr = mxx + myy, det = mxx * myy - mxy * mxy;
      const double disc = std::sqrt(std::max(0.0, tr * tr / 4 - det));
      const double l1 = tr / 2 + disc, l2 = std::max(tr / 2 - disc, 0.0);
      Source src;
      src.x = cx; src.y = cy; src.flux = sw; src.peak = peak; src.npix = static_cast<int>(members.size());
      src.length = std::sqrt(12.0 * l1);
      src.width = std::sqrt(l2);
      src.angle = 0.5 * std::atan2(2 * mxy, mxx - myy);
      src.snr = sw / (out.noise * std::sqrt(static_cast<double>(pix.size())));
      src.saturated = sat;
      src.edge = edge;
      // Centroid covariance: principal-axis variances l/SNR^2 plus the floor.
      const double f2 = opt.centroid_floor_px * opt.centroid_floor_px;
      const double va = l1 / (src.snr * src.snr) + f2, vb = std::max(l2, 0.25) / (src.snr * src.snr) + f2;
      const double c = std::cos(src.angle), s = std::sin(src.angle);
      src.cxx = va * c * c + vb * s * s;
      src.cyy = va * s * s + vb * c * c;
      src.cxy = (va - vb) * c * s;
      out.sources.push_back(src);
    }
  std::sort(out.sources.begin(), out.sources.end(), [](const Source& a, const Source& b) { return a.flux > b.flux; });

  // Dominant morphology from the brightest well-measured, unsaturated,
  // interior sources (faint streaks fragment and read short).
  std::vector<double> lengths;
  double c2 = 0, s2 = 0;
  for (const Source& s : out.sources) {
    if (s.edge || s.saturated || s.snr < 25) continue;
    lengths.push_back(s.length);
    c2 += s.length * std::cos(2 * s.angle);
    s2 += s.length * std::sin(2 * s.angle);
    if (lengths.size() >= 40) break;
  }
  if (lengths.size() >= 5) {
    out.streak_length = median(lengths);
    out.streak_angle = 0.5 * std::atan2(s2, c2);
    out.streaked = out.streak_length > 4.0 * 2.0;  // elongated beyond a few PSF widths
  }
  // Point-spread scale: the median cross-streak width of the bright stars.
  std::vector<double> widths;
  for (const Source& s : out.sources)
    if (!s.edge && !s.saturated && s.snr >= 25) widths.push_back(s.width);
  const double psf = widths.empty() ? 1.0 : std::max(0.5, median(widths));
  out.psf_sigma = psf;
  const double compact = std::max(7.0, 4.5 * psf);
  if (out.streaked) {
    // A trail's along-track centroid moves with scintillation and seeing
    // during the exposure; its two ends do not. The along-track position is
    // the midpoint of the half-maximum crossings of the trail's profile, the
    // cross-track position the flux-weighted centroid across a band.
    const double ca = std::cos(out.streak_angle), sa = std::sin(out.streak_angle);
    const double halfband = 2.5 * psf + 1.0;
    auto sample = [&](double x, double y) {
      const int xi = static_cast<int>(std::floor(x)), yi = static_cast<int>(std::floor(y));
      if (xi < 0 || yi < 0 || xi + 1 >= w || yi + 1 >= h) return 0.0;
      const double fx = x - xi, fy = y - yi;
      const size_t i = static_cast<size_t>(yi) * w + xi;
      return (1 - fy) * ((1 - fx) * res[i] + fx * res[i + 1]) + fy * ((1 - fx) * res[i + w] + fx * res[i + w + 1]);
    };
    for (Source& s : out.sources) {
      if (s.edge || s.length < 0.5 * out.streak_length || s.width > 3 * psf + 1) continue;
      const double half = 0.5 * std::max(s.length, out.streak_length) + 4 * psf + 2;
      const int n = static_cast<int>(std::ceil(2 * half)) + 1;
      std::vector<double> prof(n, 0.0), crossw(n, 0.0);
      double sum_c = 0, sum_f = 0;
      for (int k = 0; k < n; ++k) {
        const double t = -half + k;
        for (double c = -halfband; c <= halfband + 1e-9; c += 0.5) {
          const double v = sample(s.x + t * ca - c * sa, s.y + t * sa + c * ca) * 0.5;
          prof[k] += v;
          if (v > 0) { sum_c += v * c; sum_f += v; }
        }
      }
      std::vector<double> core;
      for (int k = 0; k < n; ++k) {
        const double t = -half + k;
        if (std::fabs(t) < 0.3 * out.streak_length) core.push_back(prof[k]);
      }
      const double level = median(core);
      if (!(level > 0)) continue;
      const double halfmax = 0.5 * level;
      // The outermost half-maximum crossings, found walking inward from each
      // end of the window on a 3-sample smoothed profile, so a scintillation
      // dip inside the trail never cuts it short.
      std::vector<double> sm3(prof);
      for (int k = 1; k + 1 < n; ++k) sm3[k] = (prof[k - 1] + prof[k] + prof[k + 1]) / 3.0;
      int lo = 1, hi = n - 2;
      while (lo < n - 1 && sm3[lo] <= halfmax) ++lo;
      while (hi > 0 && sm3[hi] <= halfmax) --hi;
      if (lo <= 1 || hi >= n - 2 || hi - lo < 4) continue;
      prof = sm3;
      const double t_lo = -half + (lo - 1) + (halfmax - prof[lo - 1]) / (prof[lo] - prof[lo - 1]);
      const double t_hi = -half + hi + (prof[hi] - halfmax) / (prof[hi] - prof[hi + 1]);
      const double t_mid = 0.5 * (t_lo + t_hi);
      s.trail = t_hi - t_lo;
      const double c_mid = sum_f > 0 ? sum_c / sum_f : 0.0;
      s.x += t_mid * ca - c_mid * sa;
      s.y += t_mid * sa + c_mid * ca;
      // Each end's position error: the profile noise over its slope.
      const double profile_noise = out.noise * std::sqrt(2 * halfband + 1);
      const double slope = level / (2.355 * psf);
      const double s_end = profile_noise / slope;
      s.trail_sigma = std::sqrt(2.0) * s_end;
      const double va = 0.5 * s_end * s_end + opt.centroid_floor_px * opt.centroid_floor_px;
      const double vb = std::max(psf * psf, 0.25) / (s.snr * s.snr) + opt.centroid_floor_px * opt.centroid_floor_px;
      s.cxx = va * ca * ca + vb * sa * sa;
      s.cyy = va * sa * sa + vb * ca * ca;
      s.cxy = (va - vb) * ca * sa;
    }
  }
  std::vector<double> trails;
  for (const Source& s : out.sources)
    if (s.trail > 0 && !s.saturated && s.snr >= 25) trails.push_back(s.trail);
  const double trail_median = trails.empty() ? 0.0 : median(trails);
  out.trail_length = trail_median;
  for (Source& s : out.sources) {
    if (!out.streaked) { s.kind = s.length < compact ? 1 : 3; continue; }
    double da = std::remainder(s.angle - out.streak_angle, kPi);
    const bool aligned = std::fabs(da) < 6 * kDeg;
    // A star streak: aligned, the dominant length (a merged pair reads long
    // or wide and is left out), its width that of a single trail.
    const double wmax = (s.saturated ? 3.5 : 1.8) * psf + 0.4;
    if (s.length < std::min(compact, 0.3 * out.streak_length) && s.width < 2.5 * psf + 0.5) s.kind = 2;
    else if (aligned && s.length > 0.75 * out.streak_length && s.length < 1.25 * out.streak_length && s.width <= wmax &&
             (s.trail == 0 || std::fabs(s.trail - trail_median) < std::max(0.06 * trail_median, 4.0 * s.trail_sigma))) s.kind = 1;
    else s.kind = 3;
  }
  return out;
}

}  // namespace oa
