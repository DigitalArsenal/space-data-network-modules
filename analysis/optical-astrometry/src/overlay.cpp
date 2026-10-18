// Frame times from a burnt-in UTC overlay ("YYYY-MM-DD hh:mm:ss.fff"), read
// by a fixed-font digit matcher that calibrates itself on the sequence, with
// no external OCR and no font file:
//  1. the text line and its glyphs are found by row and column projections;
//     glyphs map in order onto the format's non-space characters;
//  2. the seconds-units cell steps through the ten digits in order, once a
//     second: its bitmaps cluster into ten classes (normalized cross-
//     correlation), the order of the classes follows from the class changes
//     frame to frame, and the class seen when the seconds-tens cell changes
//     is 0. Those ten mean bitmaps are the font's digits at that cell;
//  3. every digit cell of every frame is matched against the ten templates
//     with a sub-pixel shift search; the margin over the runner-up is the
//     confidence;
//  4. the decoded times are checked against the cadence: a robust line
//     through (frame index, time), each frame's departure from it, and
//     repeated times (duplicated frames) flagged.
namespace oa {

struct OverlayOptions {
  std::string format = "YYYY-MM-DD hh:mm:ss.fff";
  double region_x0 = 0, region_y0 = 0, region_x1 = 0.4, region_y1 = 0.08;  // fractions of the frame
};

struct FrameTime {
  bool decoded = false;
  double unix_seconds = kNaN;
  std::string text;
  double margin = 0;          // smallest best-minus-second NCC over the digit cells
  double cadence_residual = kNaN;  // s, against the robust cadence line
  bool duplicate = false;     // same time as the previous frame
  bool outlier = false;       // off the cadence line by more than the tolerance
};

struct OverlayResult {
  bool ok = false;
  std::string error;
  std::vector<FrameTime> frames;
  double cadence = kNaN, cadence_sigma = kNaN;   // s per frame, its standard error
  double jitter_rms = kNaN;                      // s, departures of good frames
  int template_frames = 0;                       // frames that built the digit templates
  double min_margin = kNaN;                      // over accepted frames
  int text_x0 = 0, text_y0 = 0, text_x1 = 0, text_y1 = 0;  // overlay box, px
};

namespace ocr {

struct Cell {
  char kind = 0;      // format letter: Y M D h m s f, or the literal character
  double cx = 0;      // column centre, px
};

using Bitmap = std::vector<float>;

inline void normalize(Bitmap* b) {
  double m = 0;
  for (float v : *b) m += v;
  m /= b->size();
  double ss = 0;
  for (float& v : *b) { v -= static_cast<float>(m); ss += v * v; }
  const double n = std::sqrt(ss);
  if (n > 0) for (float& v : *b) v /= static_cast<float>(n);
}
inline double ncc(const Bitmap& a, const Bitmap& b) {
  double s = 0;
  for (size_t i = 0; i < a.size(); ++i) s += a[i] * b[i];
  return s;
}
// Crop columns [cx - hw, cx + hw] (fractional centre, linear interpolation)
// and rows [y0, y1].
inline Bitmap crop(const Image& im, double cx, int hw, int y0, int y1) {
  Bitmap out;
  out.reserve(static_cast<size_t>(2 * hw + 1) * (y1 - y0 + 1));
  for (int y = y0; y <= y1; ++y)
    for (int k = -hw; k <= hw; ++k) {
      const double x = cx + k;
      const int xi = static_cast<int>(std::floor(x));
      const double f = x - xi;
      auto px = [&](int xx) { return xx < 0 || xx >= im.width || y < 0 || y >= im.height ? 0.f : im.at(xx, y); };
      out.push_back(static_cast<float>((1 - f) * px(xi) + f * px(xi + 1)));
    }
  return out;
}

}  // namespace ocr

class OverlayReader {
 public:
  explicit OverlayReader(const OverlayOptions& o) : opt_(o) {}

  // Feed frames in order; only the overlay region is kept.
  bool add(const Image& im, std::string* error) {
    if (frames_.empty()) {
      x0_ = static_cast<int>(opt_.region_x0 * im.width);
      y0_ = static_cast<int>(opt_.region_y0 * im.height);
      x1_ = std::max(x0_ + 8, static_cast<int>(opt_.region_x1 * im.width));
      y1_ = std::max(y0_ + 8, static_cast<int>(opt_.region_y1 * im.height));
    }
    Image c;
    c.width = x1_ - x0_;
    c.height = y1_ - y0_;
    c.pixels.resize(static_cast<size_t>(c.width) * c.height);
    for (int y = 0; y < c.height; ++y)
      for (int x = 0; x < c.width; ++x) c.pixels[static_cast<size_t>(y) * c.width + x] = im.at(x0_ + x, y0_ + y);
    frames_.push_back(std::move(c));
    (void)error;
    return true;
  }

  OverlayResult read() {
    OverlayResult r;
    r.frames.resize(frames_.size());
    if (frames_.size() < 3) { r.error = "overlay: fewer than three frames"; return r; }
    // Format characters without spaces.
    std::vector<char> chars;
    for (char ch : opt_.format) if (ch != ' ') chars.push_back(ch);
    // Text rows and glyph runs from the first frame whose run count matches.
    int band0 = -1, band1 = -1;
    std::vector<std::pair<int, int>> runs;
    int ref = -1;
    for (size_t f = 0; f < frames_.size() && ref < 0; ++f) {
      const Image& c = frames_[f];
      std::vector<double> all(c.pixels.begin(), c.pixels.end());
      const double bg = median(all), hi = quantile(all, 0.995);
      if (!(hi > bg + 20)) continue;
      const double thr = bg + 0.35 * (hi - bg);
      std::vector<int> rowhits(c.height, 0);
      for (int y = 0; y < c.height; ++y)
        for (int x = 0; x < c.width; ++x) rowhits[y] += c.at(x, y) > thr;
      // The text line: the longest run of rows with hits.
      int best0 = -1, best1 = -1, cur0 = -1;
      for (int y = 0; y <= c.height; ++y) {
        const bool on = y < c.height && rowhits[y] >= 3;
        if (on && cur0 < 0) cur0 = y;
        if (!on && cur0 >= 0) {
          if (y - cur0 > best1 - best0) { best0 = cur0; best1 = y; }
          cur0 = -1;
        }
      }
      if (best0 < 0) continue;
      std::vector<std::pair<int, int>> rr;
      int run0 = -1;
      for (int x = 0; x <= c.width; ++x) {
        bool on = false;
        if (x < c.width)
          for (int y = best0; y < best1; ++y) on = on || c.at(x, y) > thr;
        if (on && run0 < 0) run0 = x;
        if (!on && run0 >= 0) { rr.push_back({run0, x - 1}); run0 = -1; }
      }
      if (rr.size() >= chars.size()) {
        rr.resize(chars.size());
        runs = rr;
        band0 = std::max(0, best0 - 1);
        band1 = std::min(c.height - 1, best1);
        ref = static_cast<int>(f);
      }
    }
    if (ref < 0) { r.error = "overlay: no frame shows a text line with the format's glyph count"; return r; }
    std::vector<ocr::Cell> cells(chars.size());
    for (size_t i = 0; i < chars.size(); ++i) {
      cells[i].kind = chars[i];
      cells[i].cx = 0.5 * (runs[i].first + runs[i].second);
    }
    // Digit pitch: the median spacing of consecutive digit cells.
    std::vector<double> gaps;
    auto isdig = [](char k) { return std::strchr("YMDhmsf", k) != nullptr; };
    for (size_t i = 1; i < cells.size(); ++i)
      if (isdig(cells[i].kind) && isdig(cells[i - 1].kind) && cells[i].kind == cells[i - 1].kind) gaps.push_back(cells[i].cx - cells[i - 1].cx);
    const double pitch = gaps.empty() ? 8.0 : median(gaps);
    // Re-centre each digit cell on its group's uniform pitch (tabular digits):
    // a narrow glyph such as "1" sits off its run's centre.
    for (size_t i = 0; i < cells.size();) {
      if (!isdig(cells[i].kind)) { ++i; continue; }
      size_t j = i;
      while (j < cells.size() && cells[j].kind == cells[i].kind) ++j;
      double mean_offset = 0;
      for (size_t k = i; k < j; ++k) mean_offset += cells[k].cx - (k - i) * pitch;
      mean_offset /= (j - i);
      for (size_t k = i; k < j; ++k) cells[k].cx = mean_offset + (k - i) * pitch;
      i = j;
    }
    const int hw = static_cast<int>(std::ceil(pitch / 2.0));
    r.text_x0 = x0_ + runs.front().first;
    r.text_x1 = x0_ + runs.back().second;
    r.text_y0 = y0_ + band0;
    r.text_y1 = y0_ + band1;
    // Seconds cells.
    int s1 = -1, s10 = -1;
    for (size_t i = 0; i < cells.size(); ++i)
      if (cells[i].kind == 's') { if (s10 < 0) s10 = static_cast<int>(i); else s1 = static_cast<int>(i); }
    if (s1 < 0 || s10 < 0) { r.error = "overlay: the format has no two-digit seconds field"; return r; }
    const size_t n = frames_.size();
    std::vector<ocr::Bitmap> b1(n), b10(n);
    for (size_t f = 0; f < n; ++f) {
      b1[f] = ocr::crop(frames_[f], cells[s1].cx, hw, band0, band1);
      b10[f] = ocr::crop(frames_[f], cells[s10].cx, hw, band0, band1);
      ocr::normalize(&b1[f]);
      ocr::normalize(&b10[f]);
    }
    // Cluster the seconds-units bitmaps.
    std::vector<ocr::Bitmap> centres;
    std::vector<int> counts;
    std::vector<int> cls(n, -1);
    for (size_t f = 0; f < n; ++f) {
      int best = -1;
      double bs = 0.92;
      for (size_t c = 0; c < centres.size(); ++c) {
        const double s = ocr::ncc(b1[f], centres[c]);
        if (s > bs) { bs = s; best = static_cast<int>(c); }
      }
      if (best < 0) { centres.push_back(b1[f]); counts.push_back(1); cls[f] = static_cast<int>(centres.size()) - 1; continue; }
      cls[f] = best;
      for (size_t k = 0; k < centres[best].size(); ++k) centres[best][k] = (centres[best][k] * counts[best] + b1[f][k]) / (counts[best] + 1);
      ++counts[best];
      ocr::normalize(&centres[best]);
    }
    // Keep the ten most populated classes; others are corrupted frames.
    std::vector<int> order(centres.size());
    std::iota(order.begin(), order.end(), 0);
    std::sort(order.begin(), order.end(), [&](int a, int b) { return counts[a] > counts[b]; });
    if (order.size() < 10) { r.error = "overlay: the seconds digit shows fewer than ten glyphs (needs at least ten seconds of frames)"; return r; }
    std::map<int, int> keep;  // class -> slot
    for (int i = 0; i < 10; ++i) keep[order[i]] = i;
    // Successor counts between kept classes.
    int succ[10][10] = {{0}};
    int prev = -1;
    for (size_t f = 0; f < n; ++f) {
      auto it = keep.find(cls[f]);
      if (it == keep.end()) continue;
      if (prev >= 0 && prev != it->second) ++succ[prev][it->second];
      prev = it->second;
    }
    int next[10];
    for (int a = 0; a < 10; ++a) {
      int best = -1, bc = 0;
      for (int b = 0; b < 10; ++b) if (succ[a][b] > bc) { bc = succ[a][b]; best = b; }
      next[a] = best;
    }
    // The cycle must visit all ten slots.
    int start = 0, at = start, steps = 0;
    std::vector<int> cycle;
    do {
      cycle.push_back(at);
      at = next[at];
      ++steps;
    } while (at >= 0 && at != start && steps <= 10);
    if (at != start || cycle.size() != 10) { r.error = "overlay: the seconds digit does not cycle through ten glyphs"; return r; }
    // Anchor: the slot shown just after a seconds-tens change is digit 0.
    std::map<int, int> zero_votes;
    for (size_t f = 1; f < n; ++f) {
      if (ocr::ncc(b10[f], b10[f - 1]) > 0.9) continue;
      auto it = keep.find(cls[f]);
      if (it != keep.end()) ++zero_votes[it->second];
    }
    if (zero_votes.empty()) { r.error = "overlay: no seconds-tens rollover in the sequence (needs at least ten seconds of frames)"; return r; }
    int zero = -1, zv = 0;
    for (auto& [slot, v] : zero_votes) if (v > zv) { zv = v; zero = slot; }
    int digit_of_slot[10];
    const int pos0 = static_cast<int>(std::find(cycle.begin(), cycle.end(), zero) - cycle.begin());
    for (int i = 0; i < 10; ++i) digit_of_slot[cycle[(pos0 + i) % 10]] = i;
    std::vector<ocr::Bitmap> templ(10);
    for (int i = 0; i < 10; ++i) templ[digit_of_slot[i]] = centres[order[i]];
    r.template_frames = 0;
    for (int i = 0; i < 10; ++i) r.template_frames += counts[order[i]];
    // Templates at sub-pixel shifts, made from the template bitmaps by
    // re-sampling the s1 crops of each class (shift the crop window).
    std::vector<std::vector<ocr::Bitmap>> shifted(10);
    std::vector<double> shifts;
    for (double s = -1.5; s <= 1.5001; s += 0.25) shifts.push_back(s);
    for (int d = 0; d < 10; ++d) {
      // Average the class's frames cropped at shifted centres.
      const int slot = std::find_if(order.begin(), order.begin() + 10, [&](int c) { return digit_of_slot[keep[c]] == d; }) - order.begin();
      const int cid = order[slot];
      for (double sh : shifts) {
        ocr::Bitmap acc;
        int used = 0;
        for (size_t f = 0; f < n && used < 40; ++f) {
          if (cls[f] != cid) continue;
          ocr::Bitmap b = ocr::crop(frames_[f], cells[s1].cx + sh, hw, band0, band1);
          if (acc.empty()) acc.assign(b.size(), 0.f);
          for (size_t k = 0; k < b.size(); ++k) acc[k] += b[k];
          ++used;
        }
        ocr::normalize(&acc);
        shifted[d].push_back(acc);
      }
    }
    // Decode every frame.
    double min_margin = 1e9;
    for (size_t f = 0; f < n; ++f) {
      FrameTime& ft = r.frames[f];
      std::string digits;
      double margin = 1e9;
      for (const ocr::Cell& c : cells) {
        if (!isdig(c.kind)) continue;
        ocr::Bitmap b = ocr::crop(frames_[f], c.cx, hw, band0, band1);
        ocr::normalize(&b);
        double best = -2, second = -2;
        int bd = -1;
        for (int d = 0; d < 10; ++d) {
          double s = -2;
          for (const ocr::Bitmap& t : shifted[d]) s = std::max(s, ocr::ncc(b, t));
          if (s > best) { second = best; best = s; bd = d; }
          else if (s > second) second = s;
        }
        digits.push_back(static_cast<char>('0' + bd));
        margin = std::min(margin, best - second);
      }
      // Assemble by format letters.
      std::map<char, std::string> field;
      size_t k = 0;
      for (const ocr::Cell& c : cells)
        if (isdig(c.kind)) field[c.kind].push_back(digits[k++]);
      auto num = [&](char key, double fallback) { return field.count(key) ? std::atof(field[key].c_str()) : fallback; };
      const int Y = static_cast<int>(num('Y', 0)), Mo = static_cast<int>(num('M', 0)), D = static_cast<int>(num('D', 0));
      const int h = static_cast<int>(num('h', 0)), mi = static_cast<int>(num('m', 0));
      const double s = num('s', 0) + (field.count('f') ? std::atof(("0." + field['f']).c_str()) : 0.0);
      char text[64];
      std::snprintf(text, sizeof text, "%04d-%02d-%02dT%02d:%02d:%06.3fZ", Y, Mo, D, h, mi, s);
      ft.text = text;
      ft.margin = margin;
      double t = 0;
      ft.decoded = Mo >= 1 && Mo <= 12 && D >= 1 && D <= 31 && h < 24 && mi < 60 && s < 61 && parse_iso_utc_seconds(text, &t);
      ft.unix_seconds = ft.decoded ? t : kNaN;
    }
    // Cadence: robust line through (index, time) by the median of pairwise
    // slopes over a stride (Theil-Sen on frame pairs half a sequence apart).
    std::vector<double> slopes;
    const size_t half = n / 2;
    for (size_t i = 0; i + half < n; ++i)
      if (r.frames[i].decoded && r.frames[i + half].decoded)
        slopes.push_back((r.frames[i + half].unix_seconds - r.frames[i].unix_seconds) / static_cast<double>(half));
    if (slopes.empty()) { r.error = "overlay: too few decoded frames for the cadence"; return r; }
    const double cadence = median(slopes);
    std::vector<double> intercepts;
    for (size_t i = 0; i < n; ++i)
      if (r.frames[i].decoded) intercepts.push_back(r.frames[i].unix_seconds - cadence * i);
    const double t0 = median(intercepts);
    const double tol = std::max(0.05, 0.2 * cadence);
    std::vector<double> dep;
    for (size_t i = 0; i < n; ++i) {
      FrameTime& ft = r.frames[i];
      if (!ft.decoded) continue;
      ft.cadence_residual = ft.unix_seconds - (t0 + cadence * i);
      ft.duplicate = i > 0 && r.frames[i - 1].decoded && std::fabs(ft.unix_seconds - r.frames[i - 1].unix_seconds) < 1e-6;
      ft.outlier = std::fabs(ft.cadence_residual) > tol || ft.margin < 0.05;
      if (!ft.outlier && !ft.duplicate) {
        dep.push_back(ft.cadence_residual);
        min_margin = std::min(min_margin, ft.margin);
      }
    }
    // Refit on the good frames for the cadence and its standard error.
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    int m = 0;
    for (size_t i = 0; i < n; ++i) {
      const FrameTime& ft = r.frames[i];
      if (!ft.decoded || ft.outlier || ft.duplicate) continue;
      sx += i; sy += ft.unix_seconds; sxx += double(i) * i; sxy += i * ft.unix_seconds; ++m;
    }
    if (m < 3) { r.error = "overlay: fewer than three frames agree with the cadence"; return r; }
    const double den = m * sxx - sx * sx;
    const double b = (m * sxy - sx * sy) / den, a = (sy - b * sx) / m;
    double ss = 0;
    for (size_t i = 0; i < n; ++i) {
      const FrameTime& ft = r.frames[i];
      if (!ft.decoded || ft.outlier || ft.duplicate) continue;
      const double e = ft.unix_seconds - (a + b * i);
      ss += e * e;
    }
    r.cadence = b;
    r.jitter_rms = std::sqrt(ss / std::max(1, m - 2));
    r.cadence_sigma = r.jitter_rms * std::sqrt(m / den);
    r.min_margin = min_margin;
    r.ok = true;
    return r;
  }

 private:
  OverlayOptions opt_;
  std::vector<Image> frames_;
  int x0_ = 0, y0_ = 0, x1_ = 0, y1_ = 0;
};

}  // namespace oa
