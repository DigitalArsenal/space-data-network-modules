// ── PDS3 IMG ELEVATION PRODUCTS (LOLA GDR), READ BY ROW BAND ────────────────
//
// Inlined into terrain_source_module.cpp by source.mjs, after DemGrid,
// DecodeBudget and the DEM samplers.
//
// The Moon's terrain comes from the LRO LOLA gridded products in the PDS
// Geosciences Node (public domain): raw little-endian IEEE754 float32 images,
// one record per image line, heights in KILOMETRES above a reference sphere
// (OFFSET 1737.4 km), described by a detached PDS3 label. The ingest fetches
// the label first ("dem" frame 0, so the geometry is the source's own) and then
// whole-line byte ranges ("dem" frames 1..3); each range response says where it
// starts in its Content-Range, and that offset divided by RECORD_BYTES is its
// first line.
//
// Two map projections are modelled, both exactly as the products' labels and
// the LOLA DSMAP / DSMAP_POLAR catalogs state them, and nothing else is guessed
// at:
//
//   SIMPLE CYLINDRICAL, global, pixel-registered, 0..360 E: line l (0-based)
//   is centred on latitude 90 - (l + 0.5)/ppd and sample s on east longitude
//   (s + 0.5)/ppd. It is decoded into a LINEAR DemGrid rotated to -180..180 E
//   with one wrap column on each side, so the existing samplers read it
//   unchanged and a tile on either side of the antimeridian sees the same
//   posts.
//
//   POLAR STEREOGRAPHIC on the reference sphere, true at the pole
//   (polar_stereo.hpp, shared with terrain-ingest's planner): a projected
//   grid, sampled bilinearly in its own (sample, line) coordinates.
//
// A product whose label departs from these conventions is REFUSED: decoding it
// anyway would put real relief in the wrong place.

#include "polar_stereo.hpp"

constexpr int kProjLinear = 0;
constexpr int kProjPolarStereo = 1;

struct PdsLabel {
    uint64_t file_records = 0, record_bytes = 0, lines = 0, line_samples = 0, sample_bits = 0;
    std::string sample_type, unit, projection, lon_direction;
    double offset_km = 0, scaling = 1;
    double ppd = 0;          // MAP_RESOLUTION (pixels per degree)
    double map_scale_m = 0;  // MAP_SCALE in metres per pixel
    double line_offset = 0, sample_offset = 0;
    double center_lat = 0, center_lon = 0;
    double a_axis_m = 0, b_axis_m = 0, c_axis_m = 0;
};

// KEY = VALUE pairs of a PDS3 label, first occurrence of each key, quoted
// values may span lines, /* comments */ skipped. Units in <...> are kept with
// the value so the caller can check them.
bool pds_label_value(const std::string& text, const std::string& key, std::string* out) {
    size_t at = 0;
    bool in_quote = false;
    while (at < text.size()) {
        size_t eol = text.find('\n', at);
        if (eol == std::string::npos) eol = text.size();
        std::string line = text.substr(at, eol - at);
        at = eol + 1;
        if (in_quote) {
            if (line.find('"') != std::string::npos) in_quote = false;
            continue;
        }
        const size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        size_t k0 = line.find_first_not_of(" \t");
        size_t k1 = line.find_last_not_of(" \t", eq - 1);
        if (k0 == std::string::npos || k1 == std::string::npos || k1 < k0) continue;
        const std::string name = line.substr(k0, k1 - k0 + 1);
        std::string value = line.substr(eq + 1);
        const size_t first_quote = value.find('"');
        if (first_quote != std::string::npos && value.find('"', first_quote + 1) == std::string::npos) {
            in_quote = true;
            if (name != key) continue;
            // A multi-line string value: not one this reader needs.
            return false;
        }
        if (name != key) continue;
        const size_t v0 = value.find_first_not_of(" \t\r");
        const size_t v1 = value.find_last_not_of(" \t\r");
        if (v0 == std::string::npos) { out->clear(); return true; }
        value = value.substr(v0, v1 - v0 + 1);
        if (value.size() >= 2 && value.front() == '"' && value.back() == '"') value = value.substr(1, value.size() - 2);
        *out = value;
        return true;
    }
    return false;
}

bool pds_label_number(const std::string& text, const char* key, double* out, std::string* unit = nullptr) {
    std::string v;
    if (!pds_label_value(text, key, &v) || v.empty()) return false;
    char* end = nullptr;
    const double d = std::strtod(v.c_str(), &end);
    if (end == v.c_str()) return false;
    if (unit) {
        const size_t lt = v.find('<'), gt = v.find('>');
        *unit = lt != std::string::npos && gt != std::string::npos && gt > lt ? v.substr(lt + 1, gt - lt - 1) : "";
    }
    *out = d;
    return true;
}

bool parse_pds_label(const std::string& text, PdsLabel* l, std::string* error) {
    if (text.rfind("PDS_VERSION_ID", 0) != 0 || text.find("PDS3") == std::string::npos) {
        *error = "the label frame is not a PDS3 label";
        return false;
    }
    double v = 0;
    std::string unit;
    const auto need = [&](const char* key, double* out) {
        if (pds_label_number(text, key, out)) return true;
        *error = std::string("the PDS3 label carries no numeric ") + key;
        return false;
    };
    if (!need("FILE_RECORDS", &v)) return false; l->file_records = static_cast<uint64_t>(v);
    if (!need("RECORD_BYTES", &v)) return false; l->record_bytes = static_cast<uint64_t>(v);
    if (!need("LINES", &v)) return false; l->lines = static_cast<uint64_t>(v);
    if (!need("LINE_SAMPLES", &v)) return false; l->line_samples = static_cast<uint64_t>(v);
    if (!need("SAMPLE_BITS", &v)) return false; l->sample_bits = static_cast<uint64_t>(v);
    if (!need("OFFSET", &l->offset_km)) return false;
    if (!pds_label_number(text, "SCALING_FACTOR", &l->scaling)) l->scaling = 1.0;
    pds_label_value(text, "SAMPLE_TYPE", &l->sample_type);
    pds_label_value(text, "UNIT", &l->unit);
    pds_label_value(text, "MAP_PROJECTION_TYPE", &l->projection);
    pds_label_value(text, "POSITIVE_LONGITUDE_DIRECTION", &l->lon_direction);
    if (!need("LINE_PROJECTION_OFFSET", &l->line_offset)) return false;
    if (!need("SAMPLE_PROJECTION_OFFSET", &l->sample_offset)) return false;
    if (!need("CENTER_LATITUDE", &l->center_lat)) return false;
    if (!need("CENTER_LONGITUDE", &l->center_lon)) return false;
    if (!pds_label_number(text, "A_AXIS_RADIUS", &v, &unit) || unit != "km") {
        *error = "the PDS3 label states no A_AXIS_RADIUS in km";
        return false;
    }
    l->a_axis_m = v * 1000.0;
    if (!pds_label_number(text, "B_AXIS_RADIUS", &v, &unit) || unit != "km") { *error = "no B_AXIS_RADIUS in km"; return false; }
    l->b_axis_m = v * 1000.0;
    if (!pds_label_number(text, "C_AXIS_RADIUS", &v, &unit) || unit != "km") { *error = "no C_AXIS_RADIUS in km"; return false; }
    l->c_axis_m = v * 1000.0;
    pds_label_number(text, "MAP_RESOLUTION", &l->ppd);
    if (pds_label_number(text, "MAP_SCALE", &v, &unit)) {
        if (unit == "km/pix" || unit == "KM/PIXEL") l->map_scale_m = v * 1000.0;
        else if (unit == "m/pix" || unit == "M/PIXEL") l->map_scale_m = v;
    }

    if (l->sample_type != "PC_REAL" || l->sample_bits != 32 || l->unit != "KILOMETER") {
        *error = "only PC_REAL 32-bit samples in KILOMETER are modelled (LOLA *_float.img)";
        return false;
    }
    if (l->record_bytes != l->line_samples * 4 || l->file_records != l->lines || l->lines < 2) {
        *error = "the label's record geometry is not one 32-bit line per record";
        return false;
    }
    if (l->a_axis_m != l->b_axis_m || l->a_axis_m != l->c_axis_m) {
        *error = "the product is not posted on a sphere (A, B and C axis radii differ)";
        return false;
    }
    if (l->lon_direction != "EAST") {
        *error = "only POSITIVE_LONGITUDE_DIRECTION EAST is modelled";
        return false;
    }
    if (l->projection == "SIMPLE CYLINDRICAL") {
        if (!(l->ppd > 0) || l->center_lat != 0 || l->center_lon != 180 ||
            static_cast<double>(l->line_samples) != 360.0 * l->ppd ||
            static_cast<double>(l->lines) != 180.0 * l->ppd ||
            l->line_offset != static_cast<double>(l->lines) / 2.0 - 0.5 ||
            l->sample_offset != static_cast<double>(l->line_samples) / 2.0 - 0.5) {
            *error = "the SIMPLE CYLINDRICAL product is not the global pixel-registered 0..360 E grid "
                     "(CENTER 0/180, 360 x 180 degrees at MAP_RESOLUTION, offsets N/2 - 0.5)";
            return false;
        }
        return true;
    }
    if (l->projection == "POLAR STEREOGRAPHIC") {
        if (!(l->map_scale_m > 0) || std::fabs(l->center_lat) != 90.0 || l->center_lon != 0 ||
            l->lines != l->line_samples ||
            l->line_offset != static_cast<double>(l->lines) / 2.0 - 0.5 ||
            l->sample_offset != static_cast<double>(l->line_samples) / 2.0 - 0.5) {
            *error = "the POLAR STEREOGRAPHIC product is not a square pole-centred grid "
                     "(CENTER_LATITUDE +/-90, CENTER_LONGITUDE 0, offsets N/2 - 0.5, MAP_SCALE in m/pix)";
            return false;
        }
        return true;
    }
    *error = "the product's MAP_PROJECTION_TYPE is neither SIMPLE CYLINDRICAL nor POLAR STEREOGRAPHIC";
    return false;
}

// ── polar stereographic on the reference sphere (polar_stereo.hpp) ─────────

PolarStereo polar_of(const DemGrid& g) {
    PolarStereo p;
    p.south = g.ps_south;
    p.radius_m = g.ps_radius_m;
    p.scale_m = g.ps_scale_m;
    p.center = g.ps_center;
    return p;
}

bool polar_pixel(const DemGrid& g, double lat, double lon, double* sample, double* line) {
    return polar_stereo_pixel(polar_of(g), lat, lon, sample, line);
}

void polar_lat_lon(const DemGrid& g, double sample, double line, double* lat, double* lon) {
    polar_stereo_lat_lon(polar_of(g), sample, line, lat, lon);
}

// Bilinear in the product's own (projected) grid; false where the window does
// not hold all four posts.
bool polar_sample(const DemGrid& g, double lat, double lon, double* out, bool* nodata) {
    double s = 0, l = 0;
    if (!polar_pixel(g, lat, lon, &s, &l)) return false;
    const double px = s - static_cast<double>(g.off_x);
    const double py = l - static_cast<double>(g.off_y);
    if (px < 0 || py < 0 || px > g.width - 1 || py > g.height - 1) return false;
    const uint32_t x0 = std::min(static_cast<uint32_t>(px), g.width - 2);
    const uint32_t y0 = std::min(static_cast<uint32_t>(py), g.height - 2);
    const double fx = px - x0, fy = py - y0;
    const float* row0 = &g.samples[static_cast<size_t>(y0) * g.width];
    const float* row1 = row0 + g.width;
    const float s00 = row0[x0], s10 = row0[x0 + 1], s01 = row1[x0], s11 = row1[x0 + 1];
    if (s00 == kNoData || s10 == kNoData || s01 == kNoData || s11 == kNoData) {
        *nodata = true;
        *out = 0.0;
        return true;
    }
    *nodata = false;
    *out = (1 - fy) * ((1 - fx) * s00 + fx * s10) + fy * ((1 - fx) * s01 + fx * s11);
    return true;
}

// ── one product, any number of whole-line range responses, ONE grid ────────

struct PdsBand {
    uint64_t first_line = 0, line_count = 0;
    const std::string* body = nullptr;
};

// "bytes <first>-<last>/<total>": the band's first line and line count. A 200
// with the whole file is a band from line 0.
bool pds_band_of(const PdsLabel& l, const std::string& content_range, const std::string& body,
                 PdsBand* band, std::string* error) {
    const uint64_t total = l.file_records * l.record_bytes;
    uint64_t first = 0, last = 0, stated_total = 0;
    if (content_range.empty()) {
        if (body.size() != total) {
            *error = "a range response carries no Content-Range and is not the whole product";
            return false;
        }
        last = total - 1;
        stated_total = total;
    } else {
        unsigned long long a = 0, b = 0, t = 0;
        if (std::sscanf(content_range.c_str(), "bytes %llu-%llu/%llu", &a, &b, &t) != 3 || b < a) {
            *error = "a range response's Content-Range is not \"bytes first-last/total\"";
            return false;
        }
        first = a; last = b; stated_total = t;
    }
    if (stated_total != total) {
        *error = "the product's length differs from FILE_RECORDS x RECORD_BYTES: the label and the image disagree";
        return false;
    }
    if (first % l.record_bytes != 0 || (last + 1) % l.record_bytes != 0 || body.size() != last - first + 1) {
        *error = "a range response is not a whole number of image lines";
        return false;
    }
    band->first_line = first / l.record_bytes;
    band->line_count = body.size() / l.record_bytes;
    band->body = &body;
    return true;
}

// The product lines a lat/lon box needs (2 lines of margin for the bilinear
// stencil and the normals' halo).
bool pds_lines_for(const PdsLabel& l, const DemGrid& shape, double west, double east, double south,
                   double north, uint64_t* first, uint64_t* last) {
    double lo = 1e300, hi = -1e300;
    if (shape.proj == kProjLinear) {
        lo = (90.0 - north) * l.ppd - 0.5;
        hi = (90.0 - south) * l.ppd - 0.5;
    } else {
        double s_lo = 0, s_hi = 0;
        if (!polar_stereo_footprint(polar_of(shape), west, east, south, north, &s_lo, &s_hi, &lo, &hi)) return false;
    }
    const double first_d = std::floor(lo) - 2, last_d = std::ceil(hi) + 2;
    *first = first_d < 0 ? 0 : static_cast<uint64_t>(first_d);
    *last = last_d > static_cast<double>(l.lines - 1) ? l.lines - 1 : static_cast<uint64_t>(last_d);
    return *first <= *last;
}

// Decode the lines `boxes` need (each a tile's extent plus the normals' halo)
// into ONE DemGrid. Heights are metres
// above the reference sphere (DN x SCALING_FACTOR km). A needed line no band
// carries is refused: a gap would be filled with invented terrain.
DemGrid decode_pds_bands(const PdsLabel& l, const std::vector<PdsBand>& bands, const std::vector<TileExtent>& boxes,
                         DecodeBudget* budget) {
    DemGrid g;
    g.proj = l.projection == "POLAR STEREOGRAPHIC" ? kProjPolarStereo : kProjLinear;
    g.full_rows = static_cast<long>(l.lines);
    if (g.proj == kProjPolarStereo) {
        g.ps_south = l.center_lat < 0;
        g.ps_scale_m = l.map_scale_m;
        g.ps_radius_m = l.a_axis_m;
        g.ps_center = static_cast<double>(l.line_samples) / 2.0 - 0.5;
    }
    // The lines EACH box needs, unioned: a polar plan's tiles lie along arcs of
    // the ring, so the box around all of them would ask for the whole annulus.
    uint64_t first = UINT64_MAX, last = 0;
    for (const TileExtent& box : boxes) {
        uint64_t f = 0, t = 0;
        if (!pds_lines_for(l, g, box.west, box.east, box.south, box.north, &f, &t)) continue;
        first = std::min(first, f);
        last = std::max(last, t);
    }
    if (first == UINT64_MAX) {
        g.ok = true;
        g.covers = false;
        return g;
    }
    for (uint64_t line = first; line <= last;) {
        uint64_t reach = line;
        for (const PdsBand& b : bands)
            if (b.first_line <= line && b.first_line + b.line_count > line)
                reach = std::max(reach, b.first_line + b.line_count);
        if (reach == line) {
            char message[200];
            std::snprintf(message, sizeof(message),
                          "image line %llu is needed by the plan's extent and no range response carries it",
                          static_cast<unsigned long long>(line));
            g.error = message;
            return g;
        }
        line = reach;
    }
    const uint64_t rows = last - first + 1;
    const uint64_t width = g.proj == kProjLinear ? l.line_samples + 2 : l.line_samples;
    const uint64_t need64 = rows * width * 4u;
    if (need64 > kDecodeByteBudget || !budget->admit(static_cast<size_t>(need64))) {
        set_decode_budget_error(need64, budget->used);
        g.budget_refused = true;
        return g;
    }
    g.width = static_cast<uint32_t>(width);
    g.height = static_cast<uint32_t>(rows);
    g.samples.assign(static_cast<size_t>(width) * rows, kNoData);
    g.off_y = static_cast<long>(first);
    if (g.proj == kProjLinear) {
        // Rotated to -180..180 E, one wrap column each side: stored column k is
        // virtual column k - 1, centred on -180 + (k - 1 + 0.5)/ppd, which is
        // product sample (k - 1 + W/2) mod W.
        g.origin_lon = -180.0 + 0.5 / l.ppd;
        g.origin_lat = 90.0 - 0.5 / l.ppd;
        g.scale_lon = 1.0 / l.ppd;
        g.scale_lat = 1.0 / l.ppd;
        g.off_x = -1;
    }
    const long W = static_cast<long>(l.line_samples);
    const double to_m = l.scaling * 1000.0;
    for (uint64_t line = first; line <= last; line++) {
        const PdsBand* home = nullptr;
        for (const PdsBand& b : bands)
            if (b.first_line <= line && b.first_line + b.line_count > line) { home = &b; break; }
        const uint8_t* src = reinterpret_cast<const uint8_t*>(home->body->data()) +
                             (line - home->first_line) * l.record_bytes;
        float* dst = &g.samples[static_cast<size_t>(line - first) * width];
        double sum = 0;
        for (long s = 0; s < W; s++) {
            float dn;
            std::memcpy(&dn, src + static_cast<size_t>(s) * 4, 4);
            const float h = std::isfinite(dn) ? static_cast<float>(static_cast<double>(dn) * to_m) : kNoData;
            sum += h;
            if (g.proj == kProjLinear) {
                long k = s - W / 2 + 1;  // stored column of virtual column (s - W/2) mod W
                if (k < 1) k += W;
                dst[k] = h;
            } else {
                dst[s] = h;
            }
        }
        if (g.proj == kProjLinear) {
            dst[0] = dst[W];
            dst[W + 1] = dst[1];
            if (line == 0) { g.has_north_pole = true; g.north_pole_m = sum / static_cast<double>(W); }
            if (line == l.lines - 1) { g.has_south_pole = true; g.south_pole_m = sum / static_cast<double>(W); }
        }
    }
    g.ok = true;
    g.covers = true;
    return g;
}

// ── the body sampler: one grid, either projection, poles closed ────────────
//
// `grids` holds the ONE grid decode_pds_bands made. SIMPLE CYLINDRICAL reads
// through sample_dem, exactly as a GeoTIFF granule does; between the first (or
// last) line centre and the pole the height runs linearly in latitude to the
// MEAN OF THAT EDGE LINE, so every tile that touches a pole puts the same height
// on it (all of a tile's pole posts are one point on the body). POLAR
// STEREOGRAPHIC is regular through its pole.
bool body_sample(const std::vector<DemGrid>& grids, double lon, double lat, double* out, bool* nodata,
                 bool* clamped) {
    *nodata = false;
    if (grids.empty() || !grids[0].covers) return false;
    const DemGrid& g = grids[0];
    if (g.proj == kProjPolarStereo) return polar_sample(g, lat, lon, out, nodata);
    const double lat_first = g.origin_lat;
    const double lat_last = g.origin_lat - static_cast<double>(g.full_rows - 1) * g.scale_lat;
    if (lat > lat_first || lat < lat_last) {
        const bool north = lat > lat_first;
        if (north ? !g.has_north_pole : !g.has_south_pole) return false;
        const double edge_lat = north ? lat_first : lat_last;
        double edge = 0;
        if (!sample_dem(grids, lon, edge_lat, &edge, nodata, clamped)) return false;
        // On the edge line itself the stencil's other line has weight 0, so a
        // "clamp" there changes nothing and is not one.
        *clamped = false;
        if (*nodata) return true;
        const double pole = north ? g.north_pole_m : g.south_pole_m;
        const double t = (lat - edge_lat) / ((north ? 90.0 : -90.0) - edge_lat);
        *out = edge + t * (pole - edge);
        return true;
    }
    return sample_dem(grids, lon, lat, out, nodata, clamped);
}
