// ── SPHERICAL POLAR STEREOGRAPHIC (LOLA DSMAP_POLAR), PURE ─────────────────
//
// Shared by terrain-source (pds_img.hpp: decoding) and terrain-ingest
// (body_plan.hpp: which image lines a tile needs), so the two can never
// disagree about where a tile lies in a polar product. Inlined by each build.
//
// The product is square, N x N posts, centred on the pole: with c = N/2 - 0.5,
// s the MAP_SCALE (m/pixel) and r = 2 R tan((90 - |lat|)/2) on the reference
// sphere of radius R, sample = c + r sin(lon)/s and line = c + r cos(lon)/s in
// the north, c - r cos(lon)/s in the south (DSMAP_POLAR: "In the north,
// longitude 0 extends straight down from the center ... in the south, straight
// up; longitude 90 E extends to the right"; checked against LDEM_64 in the
// overlap at 76-88 degrees: RMS 12.5 m south, against ~2.4 km for any mirrored
// convention). All angles in degrees, sample/line 0-based in the full product.

struct PolarStereo {
    bool south = false;
    double radius_m = 0.0;  // reference sphere
    double scale_m = 0.0;   // metres per pixel at the pole
    double center = 0.0;    // N/2 - 0.5
};

constexpr double kPolarPi = 3.14159265358979323846;

// lat/lon -> (sample, line); false in the other hemisphere.
bool polar_stereo_pixel(const PolarStereo& p, double lat, double lon, double* sample, double* line) {
    if (p.south ? lat > 0.0 : lat < 0.0) return false;
    const double colat = (90.0 - std::fabs(lat)) * kPolarPi / 180.0;
    const double r = 2.0 * p.radius_m * std::tan(colat / 2.0) / p.scale_m;
    const double l = lon * kPolarPi / 180.0;
    *sample = p.center + r * std::sin(l);
    *line = p.south ? p.center - r * std::cos(l) : p.center + r * std::cos(l);
    return true;
}

// (sample, line) -> lat/lon, lon in (-180, 180].
void polar_stereo_lat_lon(const PolarStereo& p, double sample, double line, double* lat, double* lon) {
    const double x = (sample - p.center) * p.scale_m;
    const double y = (line - p.center) * p.scale_m;
    const double r = std::sqrt(x * x + y * y);
    const double colat = 2.0 * std::atan(0.5 * r / p.radius_m) * 180.0 / kPolarPi;
    *lat = p.south ? -90.0 + colat : 90.0 - colat;
    *lon = r == 0.0 ? 0.0 : std::atan2(x, p.south ? -y : y) * 180.0 / kPolarPi;
}

// The (sample, line) bounding box of a lat/lon box's footprint: its boundary
// sampled at `n` intervals a side, plus the pole when the box reaches it. False
// when no part of the box is in this hemisphere.
bool polar_stereo_footprint(const PolarStereo& p, double west, double east, double south, double north,
                            double* s_lo, double* s_hi, double* l_lo, double* l_hi, int n = 256) {
    *s_lo = *l_lo = 1e300;
    *s_hi = *l_hi = -1e300;
    for (int k = 0; k <= n; k++) {
        const double t = static_cast<double>(k) / n;
        const double pts[4][2] = {{south, west + t * (east - west)}, {north, west + t * (east - west)},
                                  {south + t * (north - south), west}, {south + t * (north - south), east}};
        for (const auto& q : pts) {
            double s = 0, l = 0;
            if (!polar_stereo_pixel(p, q[0], q[1], &s, &l)) continue;
            *s_lo = std::min(*s_lo, s); *s_hi = std::max(*s_hi, s);
            *l_lo = std::min(*l_lo, l); *l_hi = std::max(*l_hi, l);
        }
    }
    if ((p.south && south <= -90.0) || (!p.south && north >= 90.0)) {
        *s_lo = std::min(*s_lo, p.center); *s_hi = std::max(*s_hi, p.center);
        *l_lo = std::min(*l_lo, p.center); *l_hi = std::max(*l_hi, p.center);
    }
    return *s_lo <= *s_hi;
}
