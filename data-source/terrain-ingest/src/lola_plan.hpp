// ── THE MOON'S WALK: PDS LOLA PRODUCTS, READ BY WHOLE-LINE RANGES ──────────
//
// Inlined into terrain_ingest_module.cpp by build.mjs, after the region and
// tile helpers, with ../terrain-source/src/polar_stereo.hpp ahead of it (the
// projection terrain-source decodes with, so the planner and the decoder can
// never disagree about which lines a tile needs).
//
// THE SOURCES. NASA LRO LOLA gridded data records in the PDS Geosciences Node
// (lrolol_1xxx, public domain): float32 images, one line per record, heights in
// km above the 1737.4 km reference sphere, each with a detached PDS3 label. The
// table below is the products' identity and geometry as the PDS4 inventory
// (data/collection_data_gridded_inventory.csv) and their labels state them;
// the encoder re-reads every label the run fetches and refuses one that
// disagrees, and the range requests carry If-Match on the product's ETag, so a
// reprocessed product stops the run instead of mixing editions.
//
// WHICH PRODUCT BUILDS WHICH LEVEL ("caps", config `lola_caps`, defaults below):
// each cap is a product, a level range and a latitude band; a tile is built
// from a cap when its WHOLE extent lies inside the band (a polar product ends
// near 75 degrees, so a tile straddling that has no posts on one side).
//   ldem_4         L0-3   global     (7.6 km posts)
//   ldem_16        L4-5   global     (1.9 km)
//   ldem_64        L6-7   global     (474 m)
// Each level reads the product whose posts its densest mesh about resolves:
// a level-3 tile (22.5 degrees, at most 81 posts under the 32 KiB ceiling) is
// built from and judged against LDEM_4, not against posts four times finer
// than any mesh it can carry.
//   ldem_75{s,n}_240m  L8   |lat| >= 75
//   ldem_75{s,n}_120m  L9   |lat| >= 80
//   ldem_75s_60m   L10  lat <= -85 (the south pole, where Artemis lands)
//
// THE UNIT OF WORK IS ONE PLAN. Unit 0 builds every tile of levels 0..2 (the
// root file) from the whole level-0 product. After it, per cap and level:
//   * a global (simple cylindrical) product: one BLOCK ROW (four tile rows, so
//     every 4x4 block file is complete in one plan) from the lines it spans;
//   * a polar product: whole 4x4 blocks sorted by the first image line their
//     footprint touches, taken greedily while the plan stays within 64 blocks
//     and `lola_max_range_bytes` of lines - a ring arc of the cap per plan, so
//     consecutive plans read overlapping, not repeated, lines.
// Every plan reads its lines as THREE whole-line ranges (the flow's dem_1..3)
// after the label (dem_0). The enumeration is a pure function of the config,
// so the $IRM mark is one integer: the next unit.

struct LolaProduct {
    const char* key;
    const char* lidvid;
    const char* path;     // under lola_base_url, without .img / .lbl
    const char* created;  // PRODUCT_CREATION_TIME
    const char* etag;     // the IIS ETag of the .img, as served
    uint64_t lines, samples;
    bool polar, south;
    double ppd;      // simple cylindrical: pixels per degree
    double scale_m;  // polar: metres per pixel
};

const LolaProduct kLolaProducts[] = {
    {"ldem_4", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_4_float::1.0", "cylindrical/float_img/ldem_4_float",
     "2017-09-15", "\"a0b8fcf32a27d31:0\"", 720, 1440, false, false, 4, 0},
    {"ldem_16", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_16_float::1.0", "cylindrical/float_img/ldem_16_float",
     "2019-03-15", "\"b6b84982ccd2d41:0\"", 2880, 5760, false, false, 16, 0},
    {"ldem_64", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_64_float::1.0", "cylindrical/float_img/ldem_64_float",
     "2019-03-15", "\"14db238accd2d41:0\"", 11520, 23040, false, false, 64, 0},
    {"ldem_75s_240m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75s_240m_float::1.0",
     "polar/float_img/ldem_75s_240m_float", "2017-06-15", "\"89f3b64badbd21:0\"", 3812, 3812, true, true, 0, 240},
    {"ldem_75n_240m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75n_240m_float::1.0",
     "polar/float_img/ldem_75n_240m_float", "2016-09-15", "\"19b73bf414d21:0\"", 3812, 3812, true, false, 0, 240},
    {"ldem_75s_120m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75s_120m_float::1.0",
     "polar/float_img/ldem_75s_120m_float", "2017-06-15", "\"b84c3028badbd21:0\"", 7624, 7624, true, true, 0, 120},
    {"ldem_75n_120m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75n_120m_float::1.0",
     "polar/float_img/ldem_75n_120m_float", "2016-09-15", "\"4328e0f314d21:0\"", 7624, 7624, true, false, 0, 120},
    {"ldem_75s_60m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75s_60m_float::1.0",
     "polar/float_img/ldem_75s_60m_float", "2017-06-15", "\"26477c26badbd21:0\"", 15248, 15248, true, true, 0, 60},
};

constexpr const char* kLolaBaseUrl = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/";
constexpr double kMoonRadiusM = 1737400.0;
constexpr long kLolaRootMaxLevel = 2;
constexpr long kLolaMaxBlocks = 64;
constexpr double kLolaDefaultRangeBytes = 72.0 * 1024 * 1024;

const LolaProduct* lola_product(const std::string& key) {
    for (const LolaProduct& p : kLolaProducts)
        if (key == p.key) return &p;
    return nullptr;
}

struct LolaCap {
    const LolaProduct* product = nullptr;
    long min_level = 0, max_level = 0;
    double lat_min = -90, lat_max = 90;
};

// The caps from config `lola_caps` ([{product, min_level, max_level, lat_min, lat_max}]) or the defaults. An
// unknown product, a polar product reaching the other hemisphere or the equator side of 75 degrees, or a cap list
// whose first cap is not a global product starting at level 0 is refused (error set, empty result).
std::vector<LolaCap> lola_caps(const std::string& config, std::string* error) {
    std::vector<LolaCap> caps;
    const std::vector<std::string> objects = json_object_array(config, "lola_caps");
    if (objects.empty()) {
        const struct { const char* key; long lo, hi; double a, b; } defaults[] = {
            {"ldem_4", 0, 3, -90, 90},         {"ldem_16", 4, 5, -90, 90},
            {"ldem_64", 6, 7, -90, 90},
            {"ldem_75s_240m", 8, 8, -90, -75}, {"ldem_75n_240m", 8, 8, 75, 90},
            {"ldem_75s_120m", 9, 9, -90, -80}, {"ldem_75n_120m", 9, 9, 80, 90},
            {"ldem_75s_60m", 10, 10, -90, -85},
        };
        for (const auto& d : defaults) caps.push_back(LolaCap{lola_product(d.key), d.lo, d.hi, d.a, d.b});
    } else {
        for (const std::string& obj : objects) {
            std::string key;
            LolaCap c;
            json_string_field(obj, "product", &key);
            c.product = lola_product(key);
            c.min_level = static_cast<long>(json_number_or(obj, "min_level", -1));
            c.max_level = static_cast<long>(json_number_or(obj, "max_level", -1));
            c.lat_min = json_number_or(obj, "lat_min", -90);
            c.lat_max = json_number_or(obj, "lat_max", 90);
            if (!c.product) { *error = "lola_caps names a product this lane does not know: " + key; return {}; }
            caps.push_back(c);
        }
    }
    for (const LolaCap& c : caps) {
        if (c.min_level < 0 || c.max_level < c.min_level || c.max_level > 16 || !(c.lat_max > c.lat_min) ||
            c.lat_min < -90 || c.lat_max > 90) {
            *error = "a lola cap needs 0 <= min_level <= max_level <= 16 and -90 <= lat_min < lat_max <= 90";
            return {};
        }
        if (c.product->polar && (c.product->south ? c.lat_max > -75.0 : c.lat_min < 75.0)) {
            *error = std::string("cap ") + c.product->key + " reaches past the 75-degree edge of its polar product";
            return {};
        }
    }
    if (caps.empty() || caps[0].product->polar || caps[0].min_level != 0 || caps[0].lat_min != -90 ||
        caps[0].lat_max != 90 || caps[0].max_level < kLolaRootMaxLevel) {
        *error = "the first lola cap must be a global product from level 0 through the root levels (0-2)";
        return {};
    }
    return caps;
}

// One plan's tiles and the product lines they need.
struct LolaUnit {
    const LolaCap* cap = nullptr;
    long level = 0;  // the root unit: levels 0..2
    bool root = false;
    std::vector<std::array<long, 3>> tiles;  // level, x, y
    uint64_t first_line = 0, last_line = 0;
    uint32_t blocks = 0;
};

// The densest lattice step at `level` (the normals' halo, see terrain-source).
double lola_halo_deg(long level, double max_grid) { return tile_size_deg(level) / (max_grid - 1.0); }

PolarStereo lola_polar(const LolaProduct& p) {
    PolarStereo s;
    s.south = p.south;
    s.radius_m = kMoonRadiusM;
    s.scale_m = p.scale_m;
    s.center = static_cast<double>(p.samples) / 2.0 - 0.5;
    return s;
}

// The product lines a tile needs, with the halo and three lines of margin (a superset of what terrain-source's
// decoder asks for, which uses two).
bool lola_tile_lines(const LolaProduct& p, long level, long x, long y, double max_grid, double* lo, double* hi) {
    const double size = tile_size_deg(level), halo = lola_halo_deg(level, max_grid);
    const double west = -180.0 + x * size - halo, east = -180.0 + (x + 1) * size + halo;
    const double south = std::max(-90.0, -90.0 + y * size - halo), north = std::min(90.0, -90.0 + (y + 1) * size + halo);
    if (!p.polar) {
        *lo = (90.0 - north) * p.ppd - 0.5 - 3.0;
        *hi = (90.0 - south) * p.ppd - 0.5 + 3.0;
        return true;
    }
    double s_lo = 0, s_hi = 0;
    // 16 intervals a side: the footprint's edges are smooth arcs, and the three
    // lines of margin cover what a coarser sampling of them can miss.
    if (!polar_stereo_footprint(lola_polar(p), west, east, south, north, &s_lo, &s_hi, lo, hi, 16)) return false;
    *lo -= 3.0;
    *hi += 3.0;
    return true;
}

bool lola_tile_inside(const LolaCap& c, long level, long y) {
    const double size = tile_size_deg(level);
    const double south = -90.0 + y * size, north = south + size;
    return south >= c.lat_min && north <= c.lat_max;
}

struct LolaBlock {
    long bx, by;
    double lo, hi;
};

// A polar cap's blocks at one level, in walk order: by first line, then row, then column.
std::vector<LolaBlock> lola_polar_blocks(const LolaCap& c, long level, double max_grid) {
    std::vector<LolaBlock> blocks;
    const long rows = 1L << level, cols = 2L << level;
    for (long by = 0; by * 4 < rows; by++) {
        bool any_row = false;
        for (long y = by * 4; y < std::min(rows, by * 4 + 4); y++) any_row = any_row || lola_tile_inside(c, level, y);
        if (!any_row) continue;
        for (long bx = 0; bx * 4 < cols; bx++) {
            LolaBlock b{bx, by, 1e300, -1e300};
            for (long y = by * 4; y < std::min(rows, by * 4 + 4); y++) {
                if (!lola_tile_inside(c, level, y)) continue;
                for (long x = bx * 4; x < std::min(cols, bx * 4 + 4); x++) {
                    double lo = 0, hi = 0;
                    if (!lola_tile_lines(*c.product, level, x, y, max_grid, &lo, &hi)) continue;
                    b.lo = std::min(b.lo, lo);
                    b.hi = std::max(b.hi, hi);
                }
            }
            if (b.lo <= b.hi) blocks.push_back(b);
        }
    }
    std::stable_sort(blocks.begin(), blocks.end(), [](const LolaBlock& a, const LolaBlock& b) {
        if (a.lo != b.lo) return a.lo < b.lo;
        if (a.by != b.by) return a.by < b.by;
        return a.bx < b.bx;
    });
    return blocks;
}

// The polar plans of one cap level: [first block, end block) per plan.
std::vector<std::pair<size_t, size_t>> lola_polar_batches(const LolaProduct& p, const std::vector<LolaBlock>& blocks,
                                                          double max_range_bytes) {
    std::vector<std::pair<size_t, size_t>> out;
    const double max_lines = std::floor(max_range_bytes / static_cast<double>(p.samples * 4));
    for (size_t i = 0; i < blocks.size();) {
        double lo = blocks[i].lo, hi = blocks[i].hi;
        size_t j = i + 1;
        for (; j < blocks.size() && static_cast<long>(j - i) < kLolaMaxBlocks; j++) {
            const double nlo = std::min(lo, blocks[j].lo), nhi = std::max(hi, blocks[j].hi);
            if (std::ceil(nhi) - std::floor(nlo) + 1.0 > max_lines) break;
            lo = nlo;
            hi = nhi;
        }
        out.push_back({i, j});
        i = j;
    }
    return out;
}

// The whole walk: unit `index` (or, with index < 0, only the count). False when `index` is past the end.
bool lola_unit_at(const std::vector<LolaCap>& caps, double max_grid, double max_range_bytes, long long index,
                  LolaUnit* out, long long* total) {
    long long count = 1;  // the root unit
    bool found = false;
    const auto set_lines = [&](const LolaProduct& p, double lo, double hi) {
        out->first_line = lo < 0 ? 0 : static_cast<uint64_t>(std::floor(lo));
        out->last_line = std::min<uint64_t>(p.lines - 1, static_cast<uint64_t>(std::max(0.0, std::ceil(hi))));
    };
    if (index == 0) {
        const LolaCap& c = caps[0];
        out->cap = &c;
        out->root = true;
        out->level = 0;
        for (long level = 0; level <= kLolaRootMaxLevel; level++)
            for (long y = 0; y < (1L << level); y++)
                for (long x = 0; x < (2L << level); x++) out->tiles.push_back({level, x, y});
        out->first_line = 0;
        out->last_line = c.product->lines - 1;
        out->blocks = 1;
        found = true;
    }
    for (const LolaCap& c : caps) {
        for (long level = std::max(c.min_level, kLolaRootMaxLevel + 1); level <= c.max_level; level++) {
            const long rows = 1L << level, cols = 2L << level;
            if (!c.product->polar) {
                for (long by = 0; by * 4 < rows; by++) {
                    std::vector<long> ys;
                    for (long y = by * 4; y < std::min(rows, by * 4 + 4); y++)
                        if (lola_tile_inside(c, level, y)) ys.push_back(y);
                    if (ys.empty()) continue;
                    if (count++ != index) continue;
                    out->cap = &c;
                    out->level = level;
                    double lo = 1e300, hi = -1e300;
                    for (const long y : ys) {
                        for (long x = 0; x < cols; x++) out->tiles.push_back({level, x, y});
                        double a = 0, b = 0;
                        lola_tile_lines(*c.product, level, 0, y, max_grid, &a, &b);
                        lo = std::min(lo, a);
                        hi = std::max(hi, b);
                    }
                    set_lines(*c.product, lo, hi);
                    out->blocks = static_cast<uint32_t>((cols + 3) / 4);
                    found = true;
                }
                continue;
            }
            const std::vector<LolaBlock> blocks = lola_polar_blocks(c, level, max_grid);
            const auto batches = lola_polar_batches(*c.product, blocks, max_range_bytes);
            for (const auto& [i, j] : batches) {
                if (count++ != index) continue;
                out->cap = &c;
                out->level = level;
                double lo = 1e300, hi = -1e300;
                for (size_t k = i; k < j; k++) {
                    const LolaBlock& b = blocks[k];
                    lo = std::min(lo, b.lo);
                    hi = std::max(hi, b.hi);
                    for (long y = b.by * 4; y < std::min(rows, b.by * 4 + 4); y++) {
                        if (!lola_tile_inside(c, level, y)) continue;
                        for (long x = b.bx * 4; x < std::min(cols, b.bx * 4 + 4); x++) out->tiles.push_back({level, x, y});
                    }
                }
                set_lines(*c.product, lo, hi);
                out->blocks = static_cast<uint32_t>(j - i);
                found = true;
            }
        }
    }
    if (total) *total = count;
    return found;
}
