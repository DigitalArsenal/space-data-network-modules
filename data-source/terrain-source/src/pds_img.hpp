// ── PDS3 IMG ELEVATION PRODUCTS (LOLA GDR, MOLA MEGDR), READ BY ROW BAND ────
//
// Inlined into terrain_source_module.cpp by source.mjs, after DemGrid,
// DecodeBudget and the DEM samplers.
//
// A body's terrain comes from gridded altimetry products in the PDS
// Geosciences Node (public domain), each a raw image with one record per image
// line, described by a detached PDS3 label:
//
//   LOLA GDR (the Moon): little-endian IEEE754 float32 (PC_REAL), heights in
//   KILOMETRES above the 1737.4 km sphere (OFFSET = A_AXIS_RADIUS).
//   MOLA MEGDR (Mars): big-endian int16 (MSB_INTEGER) metres for the simple
//   cylindrical tiles, radius = DN + OFFSET (3,396,000 m = A_AXIS_RADIUS);
//   big-endian float32 (IEEE_REAL) metres for the polar products, whose label
//   states OFFSET 0 while its IMAGE DESCRIPTION puts the values "relative to a
//   3396000 meter radius spherical datum" (the datum is read from that text).
//
// Every sample decodes to DN x SCALING_FACTOR in the label's UNIT, which is the
// height above the reference sphere in every case above. The ingest fetches
// each file's label ("dem" frame k, so the geometry is the source's own) and
// then whole-line byte ranges of its image (the frames after it, up to the
// next label); each range response says where it starts in its Content-Range,
// and that offset divided by RECORD_BYTES is its first line.
//
// Two map projections are modelled, both exactly as the products' labels and
// the DSMAP / DSMAP_POLAR catalogs state them, and nothing else is guessed at:
//
//   SIMPLE CYLINDRICAL, pixel-registered, 0..360 E, CENTER 0/180: the whole
//   body in one file (LOLA, MEGDR 4-32 ppd) or a tile of that global grid
//   (MEGDR 64 ppd 90x180 degrees, 128 ppd 44x90 degrees). The file's place in
//   the global grid is its MAXIMUM_LATITUDE and WESTERNMOST_LONGITUDE edges;
//   its projection offsets must agree with them (LOLA states them 0-based,
//   N/2 - 0.5 for the whole body; MEGDR 1-based, MAXLAT x ppd + 0.5). Global
//   line l (0-based) is centred on latitude 90 - (l + 0.5)/ppd and global
//   sample s on east longitude (s + 0.5)/ppd. Every file of one plan is
//   decoded into ONE LINEAR DemGrid of the global width, rotated to -180..180
//   E with one wrap column on each side, so the existing samplers read it
//   unchanged and a tile on either side of the antimeridian, or of a file
//   boundary, sees the same posts.
//
//   POLAR STEREOGRAPHIC on the reference sphere, true at the pole
//   (polar_stereo.hpp, shared with terrain-ingest's planner): a projected
//   grid, sampled bilinearly in its own (sample, line) coordinates. LOLA
//   states MAP_SCALE and the N/2 - 0.5 centre; MEGDR states neither offset
//   ('N/A'; its description gives the centre as 0.5 (N + 1), 1-based) and
//   calls MAP_SCALE approximate, so its scale is the sphere's arc per pixel at
//   MAP_RESOLUTION (A_AXIS_RADIUS x pi / 180 / ppd), checked against MAP_SCALE
//   to 1%.
//
// A product whose label departs from these conventions is REFUSED: decoding it
// anyway would put real relief in the wrong place.

#include "polar_stereo.hpp"

constexpr int kProjLinear = 0;
constexpr int kProjPolarStereo = 1;

constexpr int kSamplePcReal32 = 0;     // little-endian float32
constexpr int kSampleIeeeReal32 = 1;   // big-endian float32
constexpr int kSampleLsbInteger16 = 3; // little-endian int16
constexpr int kSampleMsbInteger16 = 2; // big-endian int16

struct PdsLabel {
    uint64_t file_records = 0, record_bytes = 0, lines = 0, line_samples = 0, sample_bits = 0;
    std::string sample_type, unit, projection, lon_direction, image_name;
    uint64_t image_offset = 0;
    bool areoid = false, west_origin = false;
    double nodata = -1e300;
    double offset_km = 0, scaling = 1;  // OFFSET as stated, in the label's UNIT
    double ppd = 0;          // MAP_RESOLUTION (pixels per degree)
    double map_scale_m = 0;  // MAP_SCALE in metres per pixel
    double line_offset = 0, sample_offset = 0;
    double center_lat = 0, center_lon = 0;
    double a_axis_m = 0, b_axis_m = 0, c_axis_m = 0;
    // Derived: the sample encoding, metres per UNIT, the sphere the heights are
    // above, and (simple cylindrical) the file's place in the global grid.
    int encoding = kSamplePcReal32;
    double unit_m = 1000.0, datum_m = 0;
    uint64_t global_lines = 0, global_samples = 0, first_line = 0, first_sample = 0;
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

// "<km>" (LOLA) or "<KM>" (MEGDR).
bool is_km(const std::string& unit) { return unit == "km" || unit == "KM" || unit == "KILOMETERS"; }

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
    pds_label_value(text, "^IMAGE", &l->image_name);
    // Detached byte pointers are 1-based, not records. Never count the TIFF
    // header as raster samples. Plain detached IMG names keep offset zero.
    const size_t comma = l->image_name.find(',');
    if (comma != std::string::npos) {
        char* end = nullptr;
        const double at = std::strtod(l->image_name.c_str() + comma + 1, &end);
        if (!(at >= 1) || at != std::floor(at) || l->image_name.find("<BYTES>", comma) == std::string::npos) {
            *error = "unsupported detached IMAGE pointer (expected 1-based bytes)"; return false;
        }
        l->image_offset = static_cast<uint64_t>(at - 1);
        const size_t q = l->image_name.find('"'), e = l->image_name.find('"', q + 1);
        if (q == std::string::npos || e == std::string::npos) { *error = "IMAGE pointer has no filename"; return false; }
        l->image_name = l->image_name.substr(q + 1, e - q - 1);
    }
    if (pds_label_number(text, "FILE_RECORDS", &v)) l->file_records = static_cast<uint64_t>(v);
    else if (!l->image_offset) return need("FILE_RECORDS", &v);
    if (!need("RECORD_BYTES", &v)) return false; l->record_bytes = static_cast<uint64_t>(v);
    if (!need("LINES", &v)) return false; l->lines = static_cast<uint64_t>(v);
    if (!l->file_records) l->file_records = l->lines;
    if (!need("LINE_SAMPLES", &v)) return false; l->line_samples = static_cast<uint64_t>(v);
    if (!need("SAMPLE_BITS", &v)) return false; l->sample_bits = static_cast<uint64_t>(v);
    if (!need("OFFSET", &l->offset_km)) return false;
    if (!pds_label_number(text, "SCALING_FACTOR", &l->scaling)) l->scaling = 1.0;
    pds_label_value(text, "SAMPLE_TYPE", &l->sample_type);
    pds_label_value(text, "UNIT", &l->unit);
    pds_label_value(text, "MAP_PROJECTION_TYPE", &l->projection);
    pds_label_value(text, "POSITIVE_LONGITUDE_DIRECTION", &l->lon_direction);
    // 'N/A' offsets and centre longitude are read as absent here; the
    // projection checks below decide whether that product may omit them.
    if (l->projection == "SIMPLE_CYLINDRICAL") l->projection = "SIMPLE CYLINDRICAL";
    const bool polar = l->projection == "POLAR STEREOGRAPHIC";
    if (!pds_label_number(text, "LINE_PROJECTION_OFFSET", &l->line_offset) && !polar) return need("LINE_PROJECTION_OFFSET", &v);
    if (!pds_label_number(text, "SAMPLE_PROJECTION_OFFSET", &l->sample_offset) && !polar) return need("SAMPLE_PROJECTION_OFFSET", &v);
    if (!need("CENTER_LATITUDE", &l->center_lat)) return false;
    if (!pds_label_number(text, "CENTER_LONGITUDE", &l->center_lon) && !polar) return need("CENTER_LONGITUDE", &v);
    if (!pds_label_number(text, "A_AXIS_RADIUS", &v, &unit) || !is_km(unit)) {
        *error = "the PDS3 label states no A_AXIS_RADIUS in km";
        return false;
    }
    l->a_axis_m = v * 1000.0;
    if (!pds_label_number(text, "B_AXIS_RADIUS", &v, &unit) || !is_km(unit)) { *error = "no B_AXIS_RADIUS in km"; return false; }
    l->b_axis_m = v * 1000.0;
    if (!pds_label_number(text, "C_AXIS_RADIUS", &v, &unit) || !is_km(unit)) { *error = "no C_AXIS_RADIUS in km"; return false; }
    l->c_axis_m = v * 1000.0;
    pds_label_number(text, "MAP_RESOLUTION", &l->ppd);
    if (pds_label_number(text, "MAP_SCALE", &v, &unit)) {
        if (unit == "km/pix" || unit == "KM/PIXEL") l->map_scale_m = v * 1000.0;
        else if (unit == "m/pix" || unit == "M/PIXEL" || unit == "METERS/PIXEL") l->map_scale_m = v;
    }

    if (l->sample_type == "PC_REAL" && l->sample_bits == 32) l->encoding = kSamplePcReal32;
    else if (l->sample_type == "IEEE_REAL" && l->sample_bits == 32) l->encoding = kSampleIeeeReal32;
    else if (l->sample_type == "LSB_INTEGER" && l->sample_bits == 16) l->encoding = kSampleLsbInteger16;
    else if (l->sample_type == "MSB_INTEGER" && l->sample_bits == 16) l->encoding = kSampleMsbInteger16;
    else {
        *error = "only PC_REAL or IEEE_REAL 32-bit and MSB_INTEGER 16-bit samples are modelled (LOLA *_float.img, "
                 "MOLA MEGDR megr*.img)";
        return false;
    }
    // This detached USGS label omits UNIT and nodata; those are stated by
    // the accompanying GeoTIFF. Require the exact published product geometry.
    if (l->image_name == "Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif" && l->image_offset == 854272 &&
        l->encoding == kSampleLsbInteger16 && l->lines == 53347 && l->line_samples == 106694 &&
        l->offset_km == 0 && l->a_axis_m == 3396190) {
        l->unit = "METER"; l->areoid = true; l->west_origin = true; l->nodata = -32768;
    }
    if (l->unit == "KILOMETER") l->unit_m = 1000.0;
    else if (l->unit == "METER") l->unit_m = 1.0;
    else {
        *error = "only samples in KILOMETER or METER are modelled";
        return false;
    }
    if (l->record_bytes != l->line_samples * (l->sample_bits / 8) || l->file_records != l->lines || l->lines < 2) {
        *error = "the label's record geometry is not one line of LINE_SAMPLES samples per record";
        return false;
    }
    if (l->a_axis_m != l->b_axis_m || l->a_axis_m != l->c_axis_m) {
        *error = "the product is not posted on a sphere (A, B and C axis radii differ)";
        return false;
    }
    // Heights are stored relative to OFFSET and the body is A_AXIS_RADIUS: a
    // product whose two disagree states its heights above some other surface.
    // The one stated exception: OFFSET 0 with the image description naming the
    // A_AXIS_RADIUS sphere as the datum (MEGDR polar).
    if (l->areoid) {
        l->datum_m = 3396000; // only usable with the independently decoded MEGA additive datum grid
    } else if (std::fabs(l->offset_km * l->unit_m - l->a_axis_m) <= 1e-6) {
        l->datum_m = l->a_axis_m;
    } else if (l->offset_km == 0 &&
               text.find("relative to a " + std::to_string(static_cast<long long>(l->a_axis_m)) +
                         " meter radius spherical") != std::string::npos) {
        l->datum_m = l->a_axis_m;
    } else {
        *error = "the label's OFFSET is not its A_AXIS_RADIUS: heights would be read above another surface";
        return false;
    }
    if (l->lon_direction != "EAST") {
        *error = "only POSITIVE_LONGITUDE_DIRECTION EAST is modelled";
        return false;
    }
    if (l->projection == "SIMPLE CYLINDRICAL" && l->west_origin) {
        // The fractional offsets are zero-based pixel centres, not integer
        // grid dimensions. Retain ppd from the label, without rounding it.
        if (!(l->ppd > 0) || l->center_lat != 0 || l->center_lon != 0 ||
            std::fabs(l->sample_offset - (180*l->ppd-.5)) > 1e-8 ||
            std::fabs(l->line_offset - (90*l->ppd-.5)) > 1e-8) {
            *error = "detached cylindrical projection offsets disagree with (-180,90) pixel-area origin"; return false;
        }
        l->global_lines = l->lines; l->global_samples = l->line_samples;
        return true;
    }
    if (l->projection == "SIMPLE CYLINDRICAL") {
        double max_lat = 0, min_lat = 0, west = 0, east = 0;
        if (!(l->ppd > 0) || l->center_lat != 0 || l->center_lon != 180 ||
            !pds_label_number(text, "MAXIMUM_LATITUDE", &max_lat) || !pds_label_number(text, "MINIMUM_LATITUDE", &min_lat) ||
            !pds_label_number(text, "WESTERNMOST_LONGITUDE", &west) ||
            !pds_label_number(text, "EASTERNMOST_LONGITUDE", &east) ||
            static_cast<double>(l->line_samples) != (east - west) * l->ppd ||
            static_cast<double>(l->lines) != (max_lat - min_lat) * l->ppd || max_lat > 90 || min_lat < -90 ||
            west < 0 || east > 360) {
            *error = "the SIMPLE CYLINDRICAL product is not a pixel-registered 0..360 E grid (CENTER 0/180, its "
                     "LINES x LINE_SAMPLES the MAXIMUM/MINIMUM_LATITUDE and WESTERNMOST/EASTERNMOST_LONGITUDE box at "
                     "MAP_RESOLUTION)";
            return false;
        }
        const double edge_line = max_lat * l->ppd, edge_sample = (l->center_lon - west) * l->ppd;
        const bool zero_based = l->line_offset == edge_line - 0.5 && l->sample_offset == edge_sample - 0.5;
        const bool one_based = l->line_offset == edge_line + 0.5 && l->sample_offset == edge_sample + 0.5;
        const double gl = 180.0 * l->ppd, gs = 360.0 * l->ppd;
        const double fl = (90.0 - max_lat) * l->ppd, fs = west * l->ppd;
        if ((!zero_based && !one_based) || gl != std::floor(gl) || gs != std::floor(gs) || fl != std::floor(fl) ||
            fs != std::floor(fs)) {
            *error = "the SIMPLE CYLINDRICAL product's projection offsets do not put its posts on the global "
                     "pixel-registered grid its latitude/longitude box states";
            return false;
        }
        l->global_lines = static_cast<uint64_t>(gl);
        l->global_samples = static_cast<uint64_t>(gs);
        l->first_line = static_cast<uint64_t>(fl);
        l->first_sample = static_cast<uint64_t>(fs);
        return true;
    }
    if (l->projection == "POLAR STEREOGRAPHIC") {
        const double centre = static_cast<double>(l->lines) / 2.0 - 0.5;
        std::string lpo, spo;
        pds_label_value(text, "LINE_PROJECTION_OFFSET", &lpo);
        pds_label_value(text, "SAMPLE_PROJECTION_OFFSET", &spo);
        const bool stated = lpo != "'N/A'" && spo != "'N/A'";
        if (!stated) {
            // MEGDR: the centre is the description's 0.5 (N + 1), 1-based; the
            // scale the sphere's arc per pixel at MAP_RESOLUTION.
            const double arc_m = l->a_axis_m * kPolarPi / 180.0 / l->ppd;
            if (!(l->ppd > 0) || !(l->map_scale_m > 0) || std::fabs(l->map_scale_m - arc_m) > 0.01 * arc_m ||
                std::fabs(l->center_lat) != 90.0 || l->lines != l->line_samples) {
                *error = "the POLAR STEREOGRAPHIC product states no projection offsets and is not a square "
                         "pole-centred grid at MAP_RESOLUTION (MAP_SCALE within 1% of the sphere's arc per pixel)";
                return false;
            }
            l->map_scale_m = arc_m;
            l->line_offset = l->sample_offset = centre;
            l->center_lon = 0;
            return true;
        }
        if (!(l->map_scale_m > 0) || std::fabs(l->center_lat) != 90.0 || l->center_lon != 0 ||
            l->lines != l->line_samples || l->line_offset != centre || l->sample_offset != centre) {
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
    // Subtract GLOBAL integer indices, never window-relative floating offsets.
    const double fx = s - static_cast<double>(x0 + g.off_x), fy = l - static_cast<double>(y0 + g.off_y);
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
    const uint64_t total = l.image_offset + l.file_records * l.record_bytes;
    uint64_t first = 0, last = 0, stated_total = 0;
    if (content_range.empty()) {
        if (body.size() != total) {
            *error = "a range response carries no Content-Range and is not the whole product";
            return false;
        }
        if (l.image_offset) { *error = "detached raster requires an explicit whole-line range"; return false; }
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
    if (first < l.image_offset || last >= total || (first-l.image_offset) % l.record_bytes != 0 || (last + 1-l.image_offset) % l.record_bytes != 0 || body.size() != last - first + 1) {
        *error = "a range response is not a whole number of image lines";
        return false;
    }
    band->first_line = (first-l.image_offset) / l.record_bytes;
    band->line_count = body.size() / l.record_bytes;
    band->body = &body;
    return true;
}

// The lines a lat/lon box needs (2 lines of margin for the bilinear stencil
// and the normals' halo): GLOBAL lines of a simple cylindrical grid, the
// product's own lines of a polar one.
bool pds_lines_for(const PdsLabel& l, const DemGrid& shape, double west, double east, double south,
                   double north, uint64_t* first, uint64_t* last) {
    double lo = 1e300, hi = -1e300;
    uint64_t lines = l.lines;
    if (shape.proj == kProjLinear) {
        lo = (90.0 - north) * l.ppd - 0.5;
        hi = (90.0 - south) * l.ppd - 0.5;
        lines = l.global_lines;
    } else {
        double s_lo = 0, s_hi = 0;
        if (!polar_stereo_footprint(polar_of(shape), west, east, south, north, &s_lo, &s_hi, &lo, &hi)) return false;
    }
    const double first_d = std::floor(lo) - 2, last_d = std::ceil(hi) + 2;
    *first = first_d < 0 ? 0 : static_cast<uint64_t>(first_d);
    *last = last_d > static_cast<double>(lines - 1) ? lines - 1 : static_cast<uint64_t>(last_d);
    return *first <= *last;
}

// One sample of a product's image, in the label's encoding, as the height in
// metres above the reference sphere (DN x SCALING_FACTOR x UNIT); a
// non-finite float is no data.
float pds_height(const PdsLabel& l, const uint8_t* at, double to_m) {
    if (l.encoding == kSampleMsbInteger16 || l.encoding == kSampleLsbInteger16) {
        const int16_t dn = l.encoding == kSampleMsbInteger16 ?
            static_cast<int16_t>((static_cast<uint16_t>(at[0]) << 8) | at[1]) :
            static_cast<int16_t>((static_cast<uint16_t>(at[1]) << 8) | at[0]);
        return dn == l.nodata ? kNoData : static_cast<float>(static_cast<double>(dn) * to_m);
    }
    float dn;
    if (l.encoding == kSampleIeeeReal32) {
        const uint8_t swapped[4] = {at[3], at[2], at[1], at[0]};
        std::memcpy(&dn, swapped, 4);
    } else {
        std::memcpy(&dn, at, 4);
    }
    return std::isfinite(dn) ? static_cast<float>(static_cast<double>(dn) * to_m) : kNoData;
}

// One file of a product: its label and the whole-line ranges of its image.
struct PdsFile {
    PdsLabel label;
    std::vector<PdsBand> bands;
};

const PdsBand* pds_band_holding(const PdsFile& f, uint64_t local_line) {
    for (const PdsBand& b : f.bands)
        if (b.first_line <= local_line && b.first_line + b.line_count > local_line) return &b;
    return nullptr;
}

// Decode the lines `boxes` need (each a tile's extent plus the normals' halo)
// from every file into ONE DemGrid. A polar plan reads one file; a simple
// cylindrical plan reads every file of the global grid its lines cross (the
// files must share MAP_RESOLUTION). Heights are metres above the reference
// sphere. A needed line no file holds, or that a file holding it carries in no
// range, is refused: a gap would be filled with invented terrain.
DemGrid decode_pds_files(const std::vector<PdsFile>& files, const std::vector<TileExtent>& boxes,
                         DecodeBudget* budget, double halo_m = 0) {
    DemGrid g;
    const PdsLabel& l = files[0].label;
    g.proj = l.projection == "POLAR STEREOGRAPHIC" ? kProjPolarStereo : kProjLinear;
    for (const PdsFile& f : files) {
        if (f.label.projection != l.projection || f.label.ppd != l.ppd || (g.proj == kProjPolarStereo && files.size() != 1)) {
            g.error = "a body plan's files must be ONE polar product or simple cylindrical files of one global grid "
                      "(one MAP_RESOLUTION)";
            return g;
        }
    }
    g.full_rows = static_cast<long>(g.proj == kProjLinear ? l.global_lines : l.lines);
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
    if (halo_m > 0) {
        const double spacing = g.proj == kProjPolarStereo ? l.map_scale_m : l.a_axis_m * kPolarPi / 180 / l.ppd;
        const uint64_t pad = static_cast<uint64_t>(std::ceil(halo_m / spacing)) + 2;
        first = first > pad ? first - pad : 0;
        last = std::min<uint64_t>(g.full_rows - 1, last + pad);
    }
    // Global line -> the file's own line (polar: the same line).
    const auto local = [&](const PdsFile& f, uint64_t line, uint64_t* out) {
        const uint64_t f0 = g.proj == kProjLinear ? f.label.first_line : 0;
        if (line < f0 || line >= f0 + f.label.lines) return false;
        *out = line - f0;
        return true;
    };
    for (uint64_t line = first; line <= last; line++) {
        bool held = false;
        for (const PdsFile& f : files) {
            uint64_t k = 0;
            if (!local(f, line, &k)) continue;
            held = true;
            if (pds_band_holding(f, k)) continue;
            held = false;
            break;
        }
        if (!held) {
            char message[200];
            std::snprintf(message, sizeof(message),
                          "image line %llu is needed by the plan's extent and no range response carries it",
                          static_cast<unsigned long long>(line));
            g.error = message;
            return g;
        }
    }
    const uint64_t rows = last - first + 1;
    long col_first = -1, col_last = static_cast<long>(l.global_samples);
    if (l.west_origin) {
        double west = 180, east = -180;
        for (const auto& b : boxes) { west = std::min(west, b.west); east = std::max(east, b.east); }
        const double pad = halo_m / (l.a_axis_m * kPolarPi / 180 / l.ppd) + 3;
        col_first = std::max<long>(-1, static_cast<long>(std::floor((west+180)*l.ppd-.5-pad)));
        col_last = std::min<long>(l.global_samples, static_cast<long>(std::ceil((east+180)*l.ppd-.5+pad)));
    }
    const uint64_t width = g.proj == kProjLinear ? col_last - col_first + 1 : l.line_samples;
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
        // global sample (k - 1 + W/2) mod W.
        g.origin_lon = -180.0 + 0.5 / l.ppd;
        g.origin_lat = 90.0 - 0.5 / l.ppd;
        g.scale_lon = 1.0 / l.ppd;
        g.scale_lat = 1.0 / l.ppd;
        g.off_x = col_first;
    }
    const long W = static_cast<long>(g.proj == kProjLinear ? l.global_samples : l.line_samples);
    for (uint64_t line = first; line <= last; line++) {
        float* dst = &g.samples[static_cast<size_t>(line - first) * width];
        double sum = 0;
        long measured = 0;  // the pole mean is over the line's measured posts only
        for (const PdsFile& f : files) {
            uint64_t k = 0;
            if (!local(f, line, &k)) continue;
            const PdsBand* home = pds_band_holding(f, k);
            const uint8_t* src = reinterpret_cast<const uint8_t*>(home->body->data()) +
                                 (k - home->first_line) * f.label.record_bytes;
            const double to_m = f.label.scaling * f.label.unit_m;
            const size_t bytes = f.label.sample_bits / 8;
            const long first_sample = g.proj == kProjLinear ? static_cast<long>(f.label.first_sample) : 0;
            const long samples = static_cast<long>(f.label.line_samples);
            for (long s = 0; s < samples; s++) {
                const float h = pds_height(f.label, src + static_cast<size_t>(s) * bytes, to_m);
                if (h != kNoData) { sum += h; measured++; }
                if (l.west_origin) {
                    if (s >= col_first && s <= col_last) dst[s-col_first] = h;
                    if (s == static_cast<long>(l.global_samples)-1 && col_first == -1) dst[0] = h;
                    if (s == 0 && col_last == static_cast<long>(l.global_samples)) dst[width-1] = h;
                } else if (g.proj == kProjLinear) {
                    long c = first_sample + s - W / 2 + 1;  // stored column of virtual column (s - W/2) mod W
                    if (c < 1) c += W;
                    dst[c] = h;
                } else {
                    dst[s] = h;
                }
            }
        }
        if (g.proj == kProjLinear) {
            if (!l.west_origin) { dst[0] = dst[W]; dst[W + 1] = dst[1]; }
            // A pole is closed only from a line the files hold whole (every
            // longitude measured or not, all W posts decoded).
            if (line == 0 && measured) { g.has_north_pole = true; g.north_pole_m = sum / static_cast<double>(measured); }
            if (line == static_cast<uint64_t>(g.full_rows) - 1 && measured) {
                g.has_south_pole = true;
                g.south_pole_m = sum / static_cast<double>(measured);
            }
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
    if(grids[0].inset) {
        *clamped=false;
        if(std::strncmp(grids[0].inset->name,"HMC_",4)==0) {
            // HMC files share one lattice. Fetch a stencil corner from its
            // neighbor instead of manufacturing nodata at an internal border.
            const bool covered=sample_dem(grids,lon,lat,out,nodata,clamped);
            if(*clamped){*nodata=true;*clamped=false;}
            return covered;
        }
        for(const auto& g:grids) {
            double x,y;g.inset->tiff.pixel(lon,lat,&x,&y);x-=g.off_x;y-=g.off_y;
            const long i=static_cast<long>(std::floor(x)),j=static_cast<long>(std::floor(y));
            if(i<0||j<0||i+1>=g.width||j+1>=g.height)continue;
            const size_t a=static_cast<size_t>(j)*g.width+i;const double fx=x-i,fy=y-j;
            const double v00=g.samples[a],v10=g.samples[a+1],v01=g.samples[a+g.width],v11=g.samples[a+g.width+1];
            if(v00==kNoData||v10==kNoData||v01==kNoData||v11==kNoData)continue;
            *out=(1-fy)*((1-fx)*v00+fx*v10)+fy*((1-fx)*v01+fx*v11);return true;
        }
        *nodata=true;return true;
    }
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
