// ── A BODY'S WALK: PDS ALTIMETRY PRODUCTS, READ BY WHOLE-LINE RANGES ────────
//
// Inlined into terrain_ingest_module.cpp by build.mjs, after the region and
// tile helpers, with ../terrain-source/src/polar_stereo.hpp ahead of it (the
// projection terrain-source decodes with, so the planner and the decoder can
// never disagree about which lines a tile needs).
//
// ONE TABLE PER BODY (config `body`, default moon). Each body names its
// reference sphere, its PDS products and the default caps; everything below the
// table is the same walk for every body. The tables are the products' identity
// and geometry as their PDS3 labels state them; terrain-source re-reads every
// label the run fetches and refuses one that disagrees, and the range requests
// carry If-Match on each file's ETag, so a reprocessed product stops the run
// instead of mixing editions.
//
//   moon  NASA LRO LOLA gridded data records (lrolol_1xxx, public domain):
//         float32 images, heights in km above the 1737.4 km sphere.
//   mars  NASA MGS MOLA MEGDR (mgsl_300x, public domain): int16 simple
//         cylindrical radius - 3,396,000 m (one file at 4, 16 and 32 ppd; 4
//         files of 90 x 180 degrees at 64 ppd; 16 of 44 x 90 at 128 ppd, which
//         stop at 88 degrees) and float32 polar stereographic radius - 3,396,000 m
//         at 512 ppd (the 128 and 256 ppd polar labels misstate RECORD_BYTES
//         and are not used).
//
// WHICH PRODUCT BUILDS WHICH LEVEL ("caps", config `caps`, defaults in the
// table): each cap is a product, a level range and a latitude band; a tile is
// built from a cap when its WHOLE extent lies inside the band. Each level reads
// the product whose posts its densest mesh about resolves. Bands of one level
// must not overlap and must meet on 4x4 block boundaries, so every packed block
// file is written by one unit.
//
// THE UNIT OF WORK IS ONE PLAN. Unit 0 builds every tile of levels 0..2 (the
// root file) from the whole level-0 product. After it, per cap and level:
//   * a simple cylindrical product: one BLOCK ROW (four tile rows, so every
//     4x4 block file is complete in one plan), cut by longitude into runs of
//     at most 32 blocks (the adapter's file budget, see kBodyMaxBlocks; one run through level 6),
//     reading the lines it spans from EVERY file of the product those lines
//     cross (all longitudes);
//   * a polar product: whole 4x4 blocks sorted by the first image line their
//     footprint touches, taken greedily while the plan stays within 32 blocks
//     and `max_range_bytes` of lines - a ring arc of the cap per plan, so
//     consecutive plans read overlapping, not repeated, lines.
// Each file a plan reads is asked for as its label and then `range_parts`
// whole-line ranges (the flow's dem_0..dem_15, at most 16 frames). The
// enumeration is a pure function of the config, so the $IRM mark is one
// integer: the next unit.

struct BodyFile {
    const char* path;  // under base_url, without .img / .lbl
    const char* etag;  // the IIS ETag of the .img, as served
    double max_lat;    // simple cylindrical: the file's north edge
    double west;       // simple cylindrical: the file's west edge, 0..360 E
};

struct BodyProduct {
    const char* key;
    const char* native_id;
    const char* created;  // PRODUCT_CREATION_TIME
    uint64_t lines, samples;  // per file
    uint64_t sample_bytes;
    bool polar, south;
    double ppd;      // pixels per degree
    double scale_m;  // polar: metres per pixel
    double edge_lat; // polar: the latitude the product covers all round to
    uint32_t range_parts;  // whole-line ranges per file per plan
    std::vector<BodyFile> files;
};

struct BodyCapDefault {
    const char* key;
    long lo, hi;
    double a, b;
};

struct Body {
    const char* name;
    const char* walk;  // the $IRM tag walk:<walk>
    double radius_m;
    const char* base_url;
    std::vector<BodyProduct> products;
    std::vector<BodyCapDefault> caps;
    // Defaults for the config keys of the same names.
    const char* dataset_id;
    const char* dataset_name;
    const char* attribution;
    const char* vertical_datum_name;
    const char* center_name;
    const char* horizontal_datum_name;
    const char* provider_id;
    const char* source_name;
    const char* path_prefix;
};

constexpr double kBodyPi = 3.14159265358979323846;
constexpr long kBodyRootMaxLevel = 2;
// Files a plan packs: the flow hands a node at most 64 input frames an invocation (port-blind), and the IPFS
// adapter takes every file AND the names frame; 64 files made 65 frames, one was dropped and every level-7 unit
// was refused (host-01 2026-10-20). 32 keeps the walk's levels 0-6 units as they were.
constexpr long kBodyMaxBlocks = 32;
constexpr double kBodyDefaultRangeBytes = 72.0 * 1024 * 1024;
constexpr size_t kBodyMaxDemFrames = 16;
constexpr double kMarsRadiusM = 3396000.0;

const std::vector<Body>& bodies() {
    static const std::vector<Body> table = {
        {"moon", "lola", 1737400.0,
         "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/",
         {
             {"ldem_4", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_4_float::1.0", "2017-09-15", 720, 1440, 4, false,
              false, 4, 0, 0, 3, {{"cylindrical/float_img/ldem_4_float", "\"a0b8fcf32a27d31:0\"", 90, 0}}},
             {"ldem_16", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_16_float::1.0", "2019-03-15", 2880, 5760, 4, false,
              false, 16, 0, 0, 3, {{"cylindrical/float_img/ldem_16_float", "\"b6b84982ccd2d41:0\"", 90, 0}}},
             {"ldem_64", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_64_float::1.0", "2019-03-15", 11520, 23040, 4,
              false, false, 64, 0, 0, 3, {{"cylindrical/float_img/ldem_64_float", "\"14db238accd2d41:0\"", 90, 0}}},
             {"ldem_75s_240m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75s_240m_float::1.0", "2017-06-15", 3812,
              3812, 4, true, true, 0, 240, 75, 3, {{"polar/float_img/ldem_75s_240m_float", "\"89f3b64badbd21:0\"", 0, 0}}},
             {"ldem_75n_240m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75n_240m_float::1.0", "2016-09-15", 3812,
              3812, 4, true, false, 0, 240, 75, 3, {{"polar/float_img/ldem_75n_240m_float", "\"19b73bf414d21:0\"", 0, 0}}},
             {"ldem_75s_120m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75s_120m_float::1.0", "2017-06-15", 7624,
              7624, 4, true, true, 0, 120, 75, 3, {{"polar/float_img/ldem_75s_120m_float", "\"b84c3028badbd21:0\"", 0, 0}}},
             {"ldem_75n_120m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75n_120m_float::1.0", "2016-09-15", 7624,
              7624, 4, true, false, 0, 120, 75, 3, {{"polar/float_img/ldem_75n_120m_float", "\"4328e0f314d21:0\"", 0, 0}}},
             {"ldem_75s_60m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75s_60m_float::1.0", "2017-06-15", 15248,
              15248, 4, true, true, 0, 60, 75, 3, {{"polar/float_img/ldem_75s_60m_float", "\"26477c26badbd21:0\"", 0, 0}}},
             // The high-resolution ladder (owner 2026-10-19: "We can get the high resolution terrain for the moon,
             // right?"): LDEM_128 one file, LDEM_256 four of 90 x 180 degrees, LDEM_512 sixteen of 45 x 90, and the
             // south-polar 20 m and 5 m stereographic products, all public domain (no SLDEM2015 or Kaguya).
             {"ldem_128", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_128_float::1.0", "2017-09-15", 23040, 46080, 4,
              false, false, 128, 0, 0, 3, {{"cylindrical/float_img/ldem_128_float", "\"8c7512ec2927d31:0\"", 90, 0}}},
             {"ldem_256", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_256_float::1.0", "2019-08-23", 23040, 46080, 4,
              false, false, 256, 0, 0, 3,
              {{"cylindrical/float_img/ldem_256_00n_90n_000_180_float", "\"9a133e2f2a27d31:0\"", 90, 0},
               {"cylindrical/float_img/ldem_256_00n_90n_180_360_float", "\"615d38b7c5fd51:0\"", 90, 180},
               {"cylindrical/float_img/ldem_256_90s_00s_000_180_float", "\"ba80c502a27d31:0\"", 0, 0},
               {"cylindrical/float_img/ldem_256_90s_00s_180_360_float", "\"8e71d1bc2b27d31:0\"", 0, 180}}},
             {"ldem_512", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_512_float::1.0", "2017-09-15", 23040, 46080, 4,
              false, false, 512, 0, 0, 3,
              {
               {"cylindrical/float_img/ldem_512_00n_45n_000_090_float", "\"2093ab882927d31:0\"", 45, 0},
               {"cylindrical/float_img/ldem_512_00n_45n_090_180_float", "\"6042cf732b27d31:0\"", 45, 90},
               {"cylindrical/float_img/ldem_512_00n_45n_180_270_float", "\"c64c5c142b27d31:0\"", 45, 180},
               {"cylindrical/float_img/ldem_512_00n_45n_270_360_float", "\"ef20e0c92927d31:0\"", 45, 270},
               {"cylindrical/float_img/ldem_512_45n_90n_000_090_float", "\"eaf1dd9b2b27d31:0\"", 90, 0},
               {"cylindrical/float_img/ldem_512_45n_90n_090_180_float", "\"c5a0e0dc2b27d31:0\"", 90, 90},
               {"cylindrical/float_img/ldem_512_45n_90n_180_270_float", "\"6eeabafd2b27d31:0\"", 90, 180},
               {"cylindrical/float_img/ldem_512_45n_90n_270_360_float", "\"362deea82927d31:0\"", 90, 270},
               {"cylindrical/float_img/ldem_512_45s_00s_000_090_float", "\"47a2e2f32a27d31:0\"", 0, 0},
               {"cylindrical/float_img/ldem_512_45s_00s_090_180_float", "\"11c93332b27d31:0\"", 0, 90},
               {"cylindrical/float_img/ldem_512_45s_00s_180_270_float", "\"b953e8702a27d31:0\"", 0, 180},
               {"cylindrical/float_img/ldem_512_45s_00s_270_360_float", "\"22dd95b22a27d31:0\"", 0, 270},
               {"cylindrical/float_img/ldem_512_90s_45s_000_090_float", "\"9f6c8c902a27d31:0\"", -45, 0},
               {"cylindrical/float_img/ldem_512_90s_45s_090_180_float", "\"d5222dd42a27d31:0\"", -45, 90},
               {"cylindrical/float_img/ldem_512_90s_45s_180_270_float", "\"cae70d2a27d31:0\"", -45, 180},
               {"cylindrical/float_img/ldem_512_90s_45s_270_360_float", "\"17cecf532b27d31:0\"", -45, 270}}},
             {"ldem_75n_60m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75n_60m_float::1.0", "2016-09-15", 15248,
              15248, 4, true, false, 0, 60, 75, 3, {{"polar/float_img/ldem_75n_60m_float", "\"fa2b445154d21:0\"", 0, 0}}},
             {"ldem_80s_20m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_80s_20m_float::1.0", "2017-06-15", 30400,
              30400, 4, true, true, 0, 20, 80, 3, {{"polar/float_img/ldem_80s_20m_float", "\"2dd2663badbd21:0\"", 0, 0}}},
             {"ldem_875s_5m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_875s_5m_float::1.0", "2017-06-15", 30336,
              30336, 4, true, true, 0, 5, 87.5, 3, {{"polar/float_img/ldem_875s_5m_float", "\"1af66117badbd21:0\"", 0, 0}}},
             {"ldem_80n_20m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_80n_20m_float::1.0", "2016-09-15", 30400,
              30400, 4, true, false, 0, 20, 80, 3, {{"polar/float_img/ldem_80n_20m_float", "\"a5a6f46154d21:0\"", 0, 0}}},
             {"ldem_875n_5m", "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_875n_5m_float::1.0", "2016-09-15", 30336,
              30336, 4, true, false, 0, 5, 87.5, 3, {{"polar/float_img/ldem_875n_5m_float", "\"70325a4f154d21:0\"", 0, 0}}},
         },
         {
             {"ldem_4", 0, 3, -90, 90}, {"ldem_16", 4, 5, -90, 90}, {"ldem_64", 6, 7, -90, 90},
             {"ldem_75s_240m", 8, 8, -90, -75}, {"ldem_75n_240m", 8, 8, 75, 90},
             {"ldem_75s_120m", 9, 9, -90, -80}, {"ldem_75n_120m", 9, 9, 80, 90},
             {"ldem_75s_60m", 10, 10, -90, -85},
         },
         "nasa-lola-gdr", "LRO LOLA gridded data records (LOLA GDR)", "LOLA: NASA/GSFC (Smith et al.)",
         "LOLA reference sphere 1737.4 km", "MOON", "MOON_ME (DE421 mean Earth/polar axis)", "nasa-lola",
         "moon-terrain", "terrain/301"},
        {"mars", "mola", kMarsRadiusM,
         "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/",
         {
             {"megr_4", "MGS-M-MOLA-5-MEGDR-L3-V1.0:MEGR90N000CB", "2003-04-03", 720, 1440, 2, false, false, 4, 0, 0, 1,
              {{"meg004/megr90n000cb", "\"014b341730c31:0\"", 90, 0}}},
             {"megr_16", "MGS-M-MOLA-5-MEGDR-L3-V1.0:MEGR90N000EB", "2003-04-03", 2880, 5760, 2, false, false, 16, 0, 0,
              1, {{"meg016/megr90n000eb", "\"80f3ca51730c31:0\"", 90, 0}}},
             {"megr_32", "MGS-M-MOLA-5-MEGDR-L3-V1.0:MEGR90N000FB", "2003-04-11", 5760, 11520, 2, false, false, 32, 0, 0,
              1, {{"meg032/megr90n000fb", "\"03cf1fe720c31:0\"", 90, 0}}},
             {"megr_64", "MGS-M-MOLA-5-MEGDR-L3-V1.0:MEG064", "2003-03-21", 5760, 11520, 2, false, false, 64, 0, 0, 1,
              {{"meg064/megr90n000gb", "\"80906b01befc21:0\"", 90, 0},
               {"meg064/megr90n180gb", "\"80e1993f1befc21:0\"", 90, 180},
               {"meg064/megr00n000gb", "\"0433ab650f3c21:0\"", 0, 0},
               {"meg064/megr00n180gb", "\"0eecaf750f3c21:0\"", 0, 180}}},
             {"megr_128", "MGS-M-MOLA-5-MEGDR-L3-V1.0:MEG128", "2003-03-21", 5632, 11520, 2, false, false, 128, 0, 0, 1,
              {{"meg128/megr88n000hb", "\"807bfa8e5f7c21:0\"", 88, 0},
               {"meg128/megr88n090hb", "\"80459544e5f7c21:0\"", 88, 90},
               {"meg128/megr88n180hb", "\"80b5cd7de5f7c21:0\"", 88, 180},
               {"meg128/megr88n270hb", "\"0623cb5e5f7c21:0\"", 88, 270},
               {"meg128/megr44n000hb", "\"0c2bc2ce3f7c21:0\"", 44, 0},
               {"meg128/megr44n090hb", "\"05f2667e3f7c21:0\"", 44, 90},
               {"meg128/megr44n180hb", "\"0fc8fa1e3f7c21:0\"", 44, 180},
               {"meg128/megr44n270hb", "\"03f97d9e3f7c21:0\"", 44, 270},
               {"meg128/megr00n000hb", "\"02fc49e2f7c21:0\"", 0, 0},
               {"meg128/megr00n090hb", "\"0721381e2f7c21:0\"", 0, 90},
               {"meg128/megr00n180hb", "\"03caebce2f7c21:0\"", 0, 180},
               {"meg128/megr00n270hb", "\"80154ef5e2f7c21:0\"", 0, 270},
               {"meg128/megr44s000hb", "\"0829e11e4f7c21:0\"", -44, 0},
               {"meg128/megr44s090hb", "\"805b3e4ae4f7c21:0\"", -44, 90},
               {"meg128/megr44s180hb", "\"09d678ce4f7c21:0\"", -44, 180},
               {"meg128/megr44s270hb", "\"03ad1c6e4f7c21:0\"", -44, 270}}},
             {"megr_n_512", "MGS-M-MOLA-5-MEGDR-L3-V1.0:MEGR_N_512", "2006-03-01", 12288, 12288, 4, true, false, 512,
              kMarsRadiusM * kBodyPi / 180.0 / 512.0, 78, 3, {{"polar/megr_n_512", "\"67faba2c4c5cc71:0\"", 0, 0}}},
             {"megr_s_512", "MGS-M-MOLA-5-MEGDR-L3-V1.0:MEGR_S_512", "2006-03-01", 12288, 12288, 4, true, true, 512,
              kMarsRadiusM * kBodyPi / 180.0 / 512.0, 78, 3, {{"polar/megr_s_512", "\"625cdab6e15cc71:0\"", 0, 0}}},
         },
         {
             // L8 meets the polar caps at 87.1875 degrees, a block-row edge of level 8 inside the 88-degree reach of
             // the 128 ppd tiles; levels 9-10 are the polar caps only.
             {"megr_4", 0, 3, -90, 90}, {"megr_16", 4, 5, -90, 90}, {"megr_32", 6, 6, -90, 90},
             {"megr_64", 7, 7, -90, 90}, {"megr_128", 8, 8, -87.1875, 87.1875},
             {"megr_s_512", 8, 8, -90, -87.1875}, {"megr_n_512", 8, 8, 87.1875, 90},
             {"megr_s_512", 9, 9, -90, -78.75}, {"megr_n_512", 9, 9, 78.75, 90},
             {"megr_s_512", 10, 10, -90, -84.375}, {"megr_n_512", 10, 10, 84.375, 90},
         },
         "nasa-mola-megdr", "MGS MOLA Mission Experiment Gridded Data Records (MEGDR)",
         "MOLA: NASA/GSFC (Smith et al.)", "MOLA reference sphere 3396.0 km", "MARS",
         "IAU_MARS planetocentric, east-positive (IAU 2000)", "nasa-mola", "mars-terrain", "terrain/499"},
    };
    return table;
}

const Body* body_named(const std::string& name) {
    for (const Body& b : bodies())
        if (name == b.name) return &b;
    return nullptr;
}

const Body* body_of_walk(const std::string& walk) {
    for (const Body& b : bodies())
        if (walk == b.walk) return &b;
    return nullptr;
}

const BodyProduct* body_product(const Body& body, const std::string& key) {
    for (const BodyProduct& p : body.products)
        if (key == p.key) return &p;
    return nullptr;
}

// A simple cylindrical product's global grid: 180 x ppd lines; a polar product's own lines.
uint64_t product_lines(const BodyProduct& p) {
    return p.polar ? p.lines : static_cast<uint64_t>(180.0 * p.ppd);
}

// A file's first line in the product's global grid (polar: 0).
uint64_t file_first_line(const BodyProduct& p, const BodyFile& f) {
    return p.polar ? 0 : static_cast<uint64_t>((90.0 - f.max_lat) * p.ppd);
}

struct BodyCap {
    const BodyProduct* product = nullptr;
    long min_level = 0, max_level = 0;
    double lat_min = -90, lat_max = 90;
};

// The caps from config `caps` ([{product, min_level, max_level, lat_min, lat_max}]) or the body's defaults. An
// unknown product, a polar product reaching past the latitude it covers all round, a cylindrical product's band past
// its files, or a cap list whose first cap is not a global product starting at level 0 is refused (error set, empty
// result).
std::vector<BodyCap> body_caps(const Body& body, const std::string& config, std::string* error) {
    std::vector<BodyCap> caps;
    const std::vector<std::string> objects = json_object_array(config, "caps");
    if (objects.empty()) {
        for (const auto& d : body.caps) caps.push_back(BodyCap{body_product(body, d.key), d.lo, d.hi, d.a, d.b});
    } else {
        for (const std::string& obj : objects) {
            std::string key;
            BodyCap c;
            json_string_field(obj, "product", &key);
            c.product = body_product(body, key);
            c.min_level = static_cast<long>(json_number_or(obj, "min_level", -1));
            c.max_level = static_cast<long>(json_number_or(obj, "max_level", -1));
            c.lat_min = json_number_or(obj, "lat_min", -90);
            c.lat_max = json_number_or(obj, "lat_max", 90);
            if (!c.product) { *error = "caps names a product this body does not know: " + key; return {}; }
            caps.push_back(c);
        }
    }
    for (const BodyCap& c : caps) {
        if (c.min_level < 0 || c.max_level < c.min_level || c.max_level > 16 || !(c.lat_max > c.lat_min) ||
            c.lat_min < -90 || c.lat_max > 90) {
            *error = "a cap needs 0 <= min_level <= max_level <= 16 and -90 <= lat_min < lat_max <= 90";
            return {};
        }
        const BodyProduct& p = *c.product;
        if (p.polar && (p.south ? c.lat_max > -p.edge_lat : c.lat_min < p.edge_lat)) {
            *error = std::string("cap ") + p.key + " reaches past the latitude its polar product covers all round";
            return {};
        }
        if (!p.polar) {
            double north = -90, south = 90;
            for (const BodyFile& f : p.files) {
                north = std::max(north, f.max_lat);
                south = std::min(south, f.max_lat - static_cast<double>(p.lines) / p.ppd);
            }
            if (c.lat_max > north || c.lat_min < south) {
                *error = std::string("cap ") + p.key + " reaches past the latitudes its files hold";
                return {};
            }
        }
    }
    if (caps.empty() || caps[0].product->polar || caps[0].product->files.size() != 1 || caps[0].min_level != 0 ||
        caps[0].lat_min != -90 || caps[0].lat_max != 90 || caps[0].max_level < kBodyRootMaxLevel) {
        *error = "the first cap must be a single-file global product from level 0 through the root levels (0-2)";
        return {};
    }
    return caps;
}

// One plan's tiles and the product lines they need (global lines of a cylindrical product).
struct BodyUnit {
    const BodyCap* cap = nullptr;
    long level = 0;  // the root unit: levels 0..2
    bool root = false;
    std::vector<std::array<long, 3>> tiles;  // level, x, y
    uint64_t first_line = 0, last_line = 0;
    uint32_t blocks = 0;
    // A run of a cut block row: its longitudes (degrees east from -180, the halo included); a file of a
    // simple cylindrical product outside them is not read. lon_east - lon_west >= 360 reads every file.
    double lon_west = -180.0, lon_east = 180.0;
};

// The densest lattice step at `level` (the normals' halo, see terrain-source).
double body_halo_deg(long level, double max_grid) { return tile_size_deg(level) / (max_grid - 1.0); }

PolarStereo body_polar(const Body& body, const BodyProduct& p) {
    PolarStereo s;
    s.south = p.south;
    s.radius_m = body.radius_m;
    s.scale_m = p.scale_m;
    s.center = static_cast<double>(p.samples) / 2.0 - 0.5;
    return s;
}

// The product lines a tile needs, with the halo and three lines of margin (a superset of what terrain-source's
// decoder asks for, which uses two).
bool body_tile_lines(const Body& body, const BodyProduct& p, long level, long x, long y, double max_grid, double* lo,
                     double* hi) {
    const double size = tile_size_deg(level), halo = body_halo_deg(level, max_grid);
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
    if (!polar_stereo_footprint(body_polar(body, p), west, east, south, north, &s_lo, &s_hi, lo, hi, 16)) return false;
    *lo -= 3.0;
    *hi += 3.0;
    return true;
}

bool body_tile_inside(const BodyCap& c, long level, long y) {
    const double size = tile_size_deg(level);
    const double south = -90.0 + y * size, north = south + size;
    return south >= c.lat_min && north <= c.lat_max;
}

struct BodyBlock {
    long bx, by;
    double lo, hi;
};

// A polar cap's blocks at one level, in walk order: by first line, then row, then column.
std::vector<BodyBlock> body_polar_blocks(const Body& body, const BodyCap& c, long level, double max_grid) {
    std::vector<BodyBlock> blocks;
    const long rows = 1L << level, cols = 2L << level;
    for (long by = 0; by * 4 < rows; by++) {
        bool any_row = false;
        for (long y = by * 4; y < std::min(rows, by * 4 + 4); y++) any_row = any_row || body_tile_inside(c, level, y);
        if (!any_row) continue;
        for (long bx = 0; bx * 4 < cols; bx++) {
            BodyBlock b{bx, by, 1e300, -1e300};
            for (long y = by * 4; y < std::min(rows, by * 4 + 4); y++) {
                if (!body_tile_inside(c, level, y)) continue;
                for (long x = bx * 4; x < std::min(cols, bx * 4 + 4); x++) {
                    double lo = 0, hi = 0;
                    if (!body_tile_lines(body, *c.product, level, x, y, max_grid, &lo, &hi)) continue;
                    b.lo = std::min(b.lo, lo);
                    b.hi = std::max(b.hi, hi);
                }
            }
            if (b.lo <= b.hi) blocks.push_back(b);
        }
    }
    std::stable_sort(blocks.begin(), blocks.end(), [](const BodyBlock& a, const BodyBlock& b) {
        if (a.lo != b.lo) return a.lo < b.lo;
        if (a.by != b.by) return a.by < b.by;
        return a.bx < b.bx;
    });
    return blocks;
}

// The polar plans of one cap level: [first block, end block) per plan.
std::vector<std::pair<size_t, size_t>> body_polar_batches(const BodyProduct& p, const std::vector<BodyBlock>& blocks,
                                                          double max_range_bytes) {
    std::vector<std::pair<size_t, size_t>> out;
    const double max_lines = std::floor(max_range_bytes / static_cast<double>(p.samples * p.sample_bytes));
    for (size_t i = 0; i < blocks.size();) {
        double lo = blocks[i].lo, hi = blocks[i].hi;
        size_t j = i + 1;
        for (; j < blocks.size() && static_cast<long>(j - i) < kBodyMaxBlocks; j++) {
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
// The walk's units [first, end) in one pass over the ladder (the import plans up to 32 consecutive units a tick;
// enumerating from the start for each would redo every earlier polar cap's blocks per unit), appended to `units`.
// `total` is the walk's length. body_unit_at is the one-unit case: the walk's indices are this enumeration's.
void body_units_in(const Body& body, const std::vector<BodyCap>& caps, double max_grid, double max_range_bytes,
                   long long first, long long end, std::vector<BodyUnit>* units, long long* total) {
    long long count = 1;  // the root unit
    const auto set_lines = [](BodyUnit* out, const BodyProduct& p, double lo, double hi) {
        out->first_line = lo < 0 ? 0 : static_cast<uint64_t>(std::floor(lo));
        out->last_line = std::min<uint64_t>(product_lines(p) - 1, static_cast<uint64_t>(std::max(0.0, std::ceil(hi))));
    };
    const auto wanted = [&](long long k) { return k >= first && k < end; };
    if (wanted(0)) {
        BodyUnit unit;
        BodyUnit* out = &unit;
        const BodyCap& c = caps[0];
        out->cap = &c;
        out->root = true;
        out->level = 0;
        for (long level = 0; level <= kBodyRootMaxLevel; level++)
            for (long y = 0; y < (1L << level); y++)
                for (long x = 0; x < (2L << level); x++) out->tiles.push_back({level, x, y});
        out->first_line = 0;
        out->last_line = product_lines(*c.product) - 1;
        out->blocks = 1;
        units->push_back(std::move(unit));
    }
    for (const BodyCap& c : caps) {
        for (long level = std::max(c.min_level, kBodyRootMaxLevel + 1); level <= c.max_level; level++) {
            const long rows = 1L << level, cols = 2L << level;
            if (!c.product->polar) {
                // A block row of more than 32 blocks (level 7 and deeper) is cut into runs of 32 by longitude;
                // each run still reads the whole row's lines from every file (the halo crosses the files' edges).
                const long row_blocks = (cols + 3) / 4;
                for (long by = 0; by * 4 < rows; by++) {
                    std::vector<long> ys;
                    for (long y = by * 4; y < std::min(rows, by * 4 + 4); y++)
                        if (body_tile_inside(c, level, y)) ys.push_back(y);
                    if (ys.empty()) continue;
                    for (long b0 = 0; b0 < row_blocks; b0 += kBodyMaxBlocks) {
                        if (!wanted(count++)) continue;
                        BodyUnit unit;
                        BodyUnit* out = &unit;
                        const long b1 = std::min(row_blocks, b0 + kBodyMaxBlocks);
                        out->cap = &c;
                        out->level = level;
                        double lo = 1e300, hi = -1e300;
                        for (const long y : ys) {
                            for (long x = b0 * 4; x < std::min(cols, b1 * 4); x++) out->tiles.push_back({level, x, y});
                            double a = 0, b = 0;
                            body_tile_lines(body, *c.product, level, 0, y, max_grid, &a, &b);
                            lo = std::min(lo, a);
                            hi = std::max(hi, b);
                        }
                        set_lines(out, *c.product, lo, hi);
                        out->blocks = static_cast<uint32_t>(b1 - b0);
                        if (row_blocks > kBodyMaxBlocks) {
                            // Only the files this run's columns (and the normals' halo, plus one source post) fall
                            // in: a 64-block run of level 10 is 45 degrees of a product cut into 90-degree files.
                            const double span = tile_size_deg(level);
                            const double margin = body_halo_deg(level, max_grid) + 1.0 / c.product->ppd;
                            out->lon_west = -180.0 + static_cast<double>(b0 * 4) * span - margin;
                            out->lon_east = -180.0 + static_cast<double>(std::min(cols, b1 * 4)) * span + margin;
                        }
                        units->push_back(std::move(unit));
                    }
                }
                continue;
            }
            const std::vector<BodyBlock> blocks = body_polar_blocks(body, c, level, max_grid);
            const auto batches = body_polar_batches(*c.product, blocks, max_range_bytes);
            for (const auto& [i, j] : batches) {
                if (!wanted(count++)) continue;
                BodyUnit unit;
                BodyUnit* out = &unit;
                out->cap = &c;
                out->level = level;
                double lo = 1e300, hi = -1e300;
                for (size_t k = i; k < j; k++) {
                    const BodyBlock& b = blocks[k];
                    lo = std::min(lo, b.lo);
                    hi = std::max(hi, b.hi);
                    for (long y = b.by * 4; y < std::min(rows, b.by * 4 + 4); y++) {
                        if (!body_tile_inside(c, level, y)) continue;
                        for (long x = b.bx * 4; x < std::min(cols, b.bx * 4 + 4); x++) out->tiles.push_back({level, x, y});
                    }
                }
                set_lines(out, *c.product, lo, hi);
                out->blocks = static_cast<uint32_t>(j - i);
                units->push_back(std::move(unit));
            }
        }
    }
    if (total) *total = count;
}

bool body_unit_at(const Body& body, const std::vector<BodyCap>& caps, double max_grid, double max_range_bytes,
                  long long index, BodyUnit* out, long long* total) {
    std::vector<BodyUnit> units;
    body_units_in(body, caps, max_grid, max_range_bytes, index, index + 1, &units, total);
    if (units.empty()) return false;
    *out = std::move(units.front());
    return true;
}

// One file's share of a unit: its local lines [first, last]; false when the unit's lines miss the file.
// Whether a simple cylindrical file's longitudes [west, west + samples/ppd) east meet the unit's run, on the circle.
bool body_file_meets_run(const BodyProduct& p, const BodyFile& f, const BodyUnit& u) {
    if (p.polar || u.lon_east - u.lon_west >= 360.0) return true;
    const double width = static_cast<double>(p.samples) / p.ppd;
    const double run_west = std::fmod(u.lon_west + 720.0, 360.0), run_width = u.lon_east - u.lon_west;
    for (const double shift : {-360.0, 0.0, 360.0}) {
        const double a = run_west + shift;
        if (a < f.west + width && f.west < a + run_width) return true;
    }
    return false;
}

bool body_file_lines(const BodyProduct& p, const BodyFile& f, const BodyUnit& u, uint64_t* first, uint64_t* last) {
    if (!body_file_meets_run(p, f, u)) return false;
    const uint64_t f0 = file_first_line(p, f), f1 = f0 + p.lines - 1;
    const uint64_t a = std::max(u.first_line, f0), b = std::min(u.last_line, f1);
    if (a > b) return false;
    *first = a - f0;
    *last = b - f0;
    return true;
}
