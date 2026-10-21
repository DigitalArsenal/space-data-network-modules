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
// Insets use coarse covered tile keys (L12 Gale/Jezero, L10 HMC). Ancestors
// and descendants nest exactly. Whole blocks have one owner; the finest inset
// owns a shared block and its fill supplies the other covered tiles. Runtime
// reads use verified first-strip + row * row-bytes arithmetic. Feather masks
// are fetched at 32 m (HMC 50 m), never embedded in compiled artifacts.
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

#include "body_geotiff.hpp"
#include "body_insets.hpp"

// BEGIN GENERATED INSET METADATA (inset-overviews.mjs)
const std::array<BodyInset,32>& body_insets() {
    static constexpr std::array<BodyInset,32> rows = {{
        // bbox W,S,E,N: -22.50031918525748, 15.000072193932178, -11.250370486987961, 30.000566176582794
        {"HMC_11E10_dt5_rows.tif",3396000,13336,17782,16,-1333625,1778175.0000000002,50,-32768,107865ULL,26672,474389369ULL,true},
        // bbox W,S,E,N: -11.250370486987961, 15.000072193932178, 0.00042178871844141875, 30.000566176582794
        {"HMC_11E20_dt5_rows.tif",3396000,13337,17782,16,-666825,1778175.0000000002,50,-32768,107865ULL,26674,474424933ULL,true},
        // bbox W,S,E,N: -22.50031918525748, -0.00042178871844141875, -11.250370486987961, 15.000072193932175
        {"HMC_11E30_dt5_rows.tif",3396000,13336,17782,16,-1333625,889075,50,-32768,107865ULL,26672,474389369ULL,true},
        // bbox W,S,E,N: -11.250370486987961, -0.00042178871844141875, 0.00042178871844141875, 15.000072193932175
        {"HMC_11E40_dt5_rows.tif",3396000,13337,17782,16,-666825,889075,50,-32768,107865ULL,26674,474424933ULL,true},
        // bbox W,S,E,N: -45.00021658179653, 15.000072193932178, -33.75026788352701, 30.000566176582794
        {"HMC_11W10_dt5_rows.tif",3396000,13336,17782,16,-2667225.0000000005,1778175.0000000002,50,-32768,107865ULL,26672,474389369ULL,true},
        // bbox W,S,E,N: -33.75026788352701, 15.000072193932178, -22.499475607820603, 30.000566176582794
        {"HMC_11W20_dt5_rows.tif",3396000,13337,17782,16,-2000425.0000000002,1778175.0000000002,50,-32768,107865ULL,26674,474424933ULL,true},
        // bbox W,S,E,N: -45.00021658179653, -0.00042178871844141875, -33.75026788352701, 15.000072193932175
        {"HMC_11W30_dt5_rows.tif",3396000,13336,17782,16,-2667225.0000000005,889075,50,-32768,107865ULL,26672,474389369ULL,true},
        // bbox W,S,E,N: -33.75026788352701, -0.00042178871844141875, -22.499475607820603, 15.000072193932175
        {"HMC_11W40_dt5_rows.tif",3396000,13337,17782,16,-2000425.0000000002,889075,50,-32768,107865ULL,26674,474424933ULL,true},
        // bbox W,S,E,N: 67.49927040089868, 15.000072193932178, 78.7492190991682, 30.000566176582794
        {"HMC_13E10_dt5.tif",3396000,13336,17782,16,4000775,1778175.0000000002,50,-32768,8ULL,26672,638313017ULL,true},
        // bbox W,S,E,N: 78.7492190991682, 15.000072193932178, 90.0000113748746, 30.000566176582794
        {"HMC_13E20_dt5.tif",3396000,13337,17782,16,4667575,1778175.0000000002,50,-32768,8ULL,26674,638348583ULL,true},
        // bbox W,S,E,N: 67.49927040089868, -0.00042178871844141875, 78.7492190991682, 15.000072193932175
        {"HMC_13E30_dt5.tif",3396000,13336,17782,16,4000775,889075,50,-32768,8ULL,26672,638313019ULL,true},
        // bbox W,S,E,N: 78.7492190991682, -0.00042178871844141875, 90.0000113748746, 15.000072193932175
        {"HMC_13E40_dt5.tif",3396000,13337,17782,16,4667575,889075,50,-32768,8ULL,26674,638348583ULL,true},
        // bbox W,S,E,N: 22.4994756078206, -15.000072193932175, 33.74942430609012, 0.00042178871844141875
        {"HMC_20E10_dt5.tif",3396000,13336,17782,16,1333575,25,50,-32768,8ULL,26672,474389351ULL,true},
        // bbox W,S,E,N: 33.74942430609012, -15.000072193932175, 45.00021658179652, 0.00042178871844141875
        {"HMC_20E20_dt5.tif",3396000,13337,17782,16,2000375,25,50,-32768,8ULL,26674,474424915ULL,true},
        // bbox W,S,E,N: 22.4994756078206, -30.00056617658279, 33.74942430609012, -15.000072193932175
        {"HMC_20E30_dt5.tif",3396000,13336,17782,16,1333575,-889075,50,-32768,8ULL,26672,474389351ULL,true},
        // bbox W,S,E,N: 33.74942430609012, -30.00056617658279, 45.00021658179652, -15.000072193932175
        {"HMC_20E40_dt5.tif",3396000,13337,17782,16,2000375,-889075,50,-32768,8ULL,26674,474424915ULL,true},
        // bbox W,S,E,N: -0.00042178871844141875, -15.000072193932175, 11.24952690955108, 0.00042178871844141875
        {"HMC_20W10_dt5.tif",3396000,13336,17782,16,-25,25,50,-32768,8ULL,26672,474424915ULL,true},
        // bbox W,S,E,N: 11.249526909551081, -15.000072193932175, 22.50031918525748, 0.00042178871844141875
        {"HMC_20W20_dt5.tif",3396000,13337,17782,16,666775.0000000001,25,50,-32768,8ULL,26674,474460479ULL,true},
        // bbox W,S,E,N: -0.00042178871844141875, -30.00056617658279, 11.24952690955108, -15.000072193932175
        {"HMC_20W30_dt5.tif",3396000,13336,17782,16,-25,-889075,50,-32768,8ULL,26672,474424915ULL,true},
        // bbox W,S,E,N: 11.249526909551081, -30.00056617658279, 22.50031918525748, -15.000072193932175
        {"HMC_20W40_dt5.tif",3396000,13337,17782,16,666775.0000000001,-889075,50,-32768,8ULL,26674,474460479ULL,true},
        // bbox W,S,E,N: 137.12416650612477, -5.098652339315738, 137.68055905434542, -4.1296047962656
        {"MSL_Gale_DEM_Mosaic_1m_v3_rows.tif",3396190,32980,57440,32,8127993.492786024,-244781.075189438,1,-32767,690661ULL,131920,7578866127ULL,true},
        // bbox W,S,E,N: 77.05783733782991, 18.135664034005845, 77.38080819723366, 18.588066173881064
        {"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_rows.tif",3396190,19144,26816,32,4567580,1101802,1,-32767,322919ULL,76576,2054107860ULL,true},
        // bbox W,S,E,N: 137.1242762867605, -5.098431752961284, 137.68033142288397, -4.129384209911146
        {"MSL_Gale_DEM_Mosaic_1m_v3_32m.tif",3396190,1030,1795,32,8128000,-244768,32,-32767,11433ULL,4120,7418279ULL,true},
        // bbox W,S,E,N: 137.1242762867605, -5.098701682639014, 137.6806013525617, -4.129654139588876
        {"MSL_Gale_DEM_Mosaic_1m_v3_16m.tif",3396190,2061,3590,32,8128000,-244784,16,-32767,22203ULL,8244,29640379ULL,true},
        // bbox W,S,E,N: 137.12414132192163, -5.098701682639014, 137.6806013525617, -4.129654139588876
        {"MSL_Gale_DEM_Mosaic_1m_v3_8m.tif",3396190,4123,7180,32,8127992,-244784,8,-32767,43743ULL,16492,118500059ULL,true},
        // bbox W,S,E,N: 137.12414132192163, -5.098634200219581, 137.68053387014228, -4.129586657169443
        {"MSL_Gale_DEM_Mosaic_1m_v3_4m.tif",3396190,8245,14360,32,8127992,-244780,4,-32767,86823ULL,32980,473766459ULL,true},
        // bbox W,S,E,N: 137.12417506313136, -5.098667941429298, 137.680567611352, -4.129620398379159
        {"MSL_Gale_DEM_Mosaic_1m_v3_2m.tif",3396190,16490,28720,32,8127994,-244782,2,-32767,230423ULL,65960,1894832059ULL,true},
        // bbox W,S,E,N: 77.05790482024935, 18.135495327957265, 77.38074071481424, 18.587897467832484
        {"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_32m.tif",3396190,598,838,32,4567584,1101792,32,-32767,5655ULL,2392,2015819ULL,true},
        // bbox W,S,E,N: 77.05790482024935, 18.135765257634993, 77.38074071481424, 18.58816739751021
        {"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_16m.tif",3396190,1196,1676,32,4567584,1101808,16,-32767,10683ULL,4784,8039363ULL,true},
        // bbox W,S,E,N: 77.05776985541048, 18.13563029279613, 77.3808756796531, 18.588032432671348
        {"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_8m.tif",3396190,2394,3352,32,4567576,1101800,8,-32767,20739ULL,9576,32140243ULL,true},
        // bbox W,S,E,N: 77.05783733782991, 18.13563029279613, 77.38080819723366, 18.58809991509078
        {"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_4m.tif",3396190,4786,6705,32,4567580,1101804,4,-32767,40857ULL,19144,128442247ULL,true},
        // bbox W,S,E,N: 77.05783733782991, 18.135664034005845, 77.38080819723366, 18.588066173881064
        {"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_2m.tif",3396190,9572,13408,32,4567580,1101802,2,-32767,81075ULL,38288,513527667ULL,true},
    }}; return rows;
}
const BodyInset* body_inset(const std::string& name) {
    for(const auto& row:body_insets())if(name==row.name)return &row;return nullptr;
}
struct BodyInsetCoverage { const char* family; long level; const std::array<uint16_t,4>* rectangles; size_t count; };
const std::array<BodyInsetCoverage,3>& body_inset_coverage() {
    static constexpr std::array<uint16_t,4> HMC[] = { // L10, 106522 covered tile keys; 87 rectangles
        {1024,341,1200,341},{1202,341,1277,341},{1024,342,1277,355},{1153,356,1277,356},{1154,357,1277,359},{1024,356,1151,360},
        {1154,360,1278,360},{1024,361,1278,366},{1180,367,1278,378},{1180,379,1268,379},{1179,380,1268,391},{1179,392,1269,404},
        {1024,367,1168,409},{1024,410,1167,413},{1279,410,1279,414},{1178,405,1269,424},{1024,414,1173,424},{1024,425,1269,435},
        {1024,436,1132,437},{1062,438,1132,438},{1024,438,1060,439},{1024,440,1058,440},{1060,440,1060,440},{1063,439,1132,442},
        {1024,441,1053,445},{1274,415,1279,452},{1134,436,1269,452},{1066,443,1132,455},{1134,453,1279,464},{1227,465,1279,467},
        {1134,465,1223,467},{1134,468,1279,468},{1134,469,1150,474},{1152,469,1279,475},{1137,475,1150,483},{1154,476,1279,483},
        {1068,456,1132,485},{1137,484,1279,485},{1137,486,1161,486},{1170,486,1206,486},{1113,486,1132,487},{1024,446,1052,490},
        {1068,486,1107,490},{1170,487,1179,494},{1184,487,1201,494},{1069,491,1107,496},{1068,497,1107,497},{1180,495,1201,501},
        {1169,500,1175,501},{1069,498,1107,503},{1211,486,1240,504},{1245,486,1279,504},{1112,488,1132,504},{1069,504,1076,504},
        {1078,504,1107,504},{1211,505,1279,507},{1024,491,1051,511},{1136,487,1161,512},{1169,502,1201,512},{1069,505,1107,512},
        {1111,505,1132,512},{1206,508,1279,512},{768,512,1051,512},{1407,512,1457,517},{1407,518,1458,539},{1407,540,1442,548},
        {1461,512,1535,556},{1451,540,1458,564},{1407,549,1439,569},{1443,565,1458,569},{1407,570,1458,570},{1491,557,1535,571},
        {1492,572,1535,572},{1491,573,1535,574},{1492,575,1535,575},{1461,557,1489,576},{1407,571,1459,576},{1491,576,1535,577},
        {1492,578,1535,578},{1491,579,1535,580},{1492,581,1535,581},{1491,582,1535,583},{1492,584,1535,584},{1407,577,1489,586},
        {1491,585,1535,586},{768,513,1024,682},{1407,587,1535,682},
    };
    static constexpr std::array<uint16_t,4> Gale[] = { // L12, 264 covered tile keys; 9 rectangles
        {7218,1931,7218,1931},{7218,1932,7227,1932},{7218,1933,7228,1933},{7217,1934,7228,1945},{7216,1946,7228,1950},{7216,1951,7227,1951},
        {7216,1952,7226,1952},{7218,1953,7226,1953},{7226,1954,7226,1954},
    };
    static constexpr std::array<uint16_t,4> Jezero[] = { // L12, 75 covered tile keys; 5 rectangles
        {5850,2460,5853,2460},{5850,2461,5856,2463},{5849,2464,5856,2468},{5849,2469,5854,2469},{5849,2470,5852,2470},
    };
    static constexpr std::array<BodyInsetCoverage,3> rows = {{
        {"HMC",10,HMC,87},
        {"Gale",12,Gale,9},
        {"Jezero",12,Jezero,5},
    }}; return rows;
}
// END GENERATED INSET METADATA

struct BodyFile {
    const char* path;  // PDS: under base_url without suffix; inset: exact GeoTIFF filename
    const char* etag;  // the IIS ETag of the .img, as served
    double max_lat;    // simple cylindrical: the file's north edge
    double west;       // simple cylindrical: the file's west edge, 0..360 E
    const char* image_url = nullptr; // detached absolute URL, or inset path relative to inset_base_url
    const char* label_url = nullptr;
    uint64_t image_offset = 0; // zero-based raster byte offset
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
    const char* datum = nullptr; // additive height grid: DN metres above the output sphere
    bool may_have_nodata = false;
    const char* fallback = nullptr;
    uint32_t fallback_posts = 0;
    bool inset = false;
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

// One initializer for the ladder: file metadata remains static, while the
// product vectors are assembled once. This also bounds guest-link object size.
void append_mars_insets(std::vector<BodyProduct>* products) {
    static constexpr BodyFile hmc_files[] = {
        {"HMC_11E10_dt5_rows.tif","",0,0,"hrsc_hmc30_dt5/ovr/HMC_11E10_dt5_rows.tif"},{"HMC_11E20_dt5_rows.tif","",0,0,"hrsc_hmc30_dt5/ovr/HMC_11E20_dt5_rows.tif"},{"HMC_11E30_dt5_rows.tif","",0,0,"hrsc_hmc30_dt5/ovr/HMC_11E30_dt5_rows.tif"},{"HMC_11E40_dt5_rows.tif","",0,0,"hrsc_hmc30_dt5/ovr/HMC_11E40_dt5_rows.tif"},{"HMC_11W10_dt5_rows.tif","",0,0,"hrsc_hmc30_dt5/ovr/HMC_11W10_dt5_rows.tif"},{"HMC_11W20_dt5_rows.tif","",0,0,"hrsc_hmc30_dt5/ovr/HMC_11W20_dt5_rows.tif"},{"HMC_11W30_dt5_rows.tif","",0,0,"hrsc_hmc30_dt5/ovr/HMC_11W30_dt5_rows.tif"},{"HMC_11W40_dt5_rows.tif","",0,0,"hrsc_hmc30_dt5/ovr/HMC_11W40_dt5_rows.tif"},{"HMC_13E10_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_13E10_dt5.tif"},{"HMC_13E20_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_13E20_dt5.tif"},{"HMC_13E30_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_13E30_dt5.tif"},{"HMC_13E40_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_13E40_dt5.tif"},{"HMC_20E10_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_20E10_dt5.tif"},{"HMC_20E20_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_20E20_dt5.tif"},{"HMC_20E30_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_20E30_dt5.tif"},{"HMC_20E40_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_20E40_dt5.tif"},{"HMC_20W10_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_20W10_dt5.tif"},{"HMC_20W20_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_20W20_dt5.tif"},{"HMC_20W30_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_20W30_dt5.tif"},{"HMC_20W40_dt5.tif","",0,0,"hrsc_hmc30_dt5/HMC_20W40_dt5.tif"}
    };
    products->push_back({"hrsc_hmc30_dt5","hrsc_hmc30_dt5","2026-10-21",0,0,2,false,false,0,50,0,1,
        std::vector<BodyFile>(std::begin(hmc_files),std::end(hmc_files)),nullptr,true,"hrsc_mola_blend_200m_v2",64,true});
    struct Level {const char* key; double spacing; BodyFile file; const char* backing; uint32_t posts;};
    static constexpr Level levels[] = {
        {"msl_gale_dem_1m_v3_ovr32",32,{"MSL_Gale_DEM_Mosaic_1m_v3_32m.tif","",0,0,"msl_gale_dem_1m_v3/ovr/MSL_Gale_DEM_Mosaic_1m_v3_32m.tif"},"hrsc_mola_blend_200m_v2",58},
        {"msl_gale_dem_1m_v3_ovr16",16,{"MSL_Gale_DEM_Mosaic_1m_v3_16m.tif","",0,0,"msl_gale_dem_1m_v3/ovr/MSL_Gale_DEM_Mosaic_1m_v3_16m.tif"},"hrsc_mola_blend_200m_v2",58},
        {"msl_gale_dem_1m_v3_ovr8",8,{"MSL_Gale_DEM_Mosaic_1m_v3_8m.tif","",0,0,"msl_gale_dem_1m_v3/ovr/MSL_Gale_DEM_Mosaic_1m_v3_8m.tif"},"hrsc_mola_blend_200m_v2",58},
        {"msl_gale_dem_1m_v3_ovr4",4,{"MSL_Gale_DEM_Mosaic_1m_v3_4m.tif","",0,0,"msl_gale_dem_1m_v3/ovr/MSL_Gale_DEM_Mosaic_1m_v3_4m.tif"},"hrsc_mola_blend_200m_v2",58},
        {"msl_gale_dem_1m_v3_ovr2",2,{"MSL_Gale_DEM_Mosaic_1m_v3_2m.tif","",0,0,"msl_gale_dem_1m_v3/ovr/MSL_Gale_DEM_Mosaic_1m_v3_2m.tif"},"hrsc_mola_blend_200m_v2",58},
        {"msl_gale_dem_1m_v3",1,{"MSL_Gale_DEM_Mosaic_1m_v3_rows.tif","",0,0,"msl_gale_dem_1m_v3/ovr/MSL_Gale_DEM_Mosaic_1m_v3_rows.tif"},"hrsc_mola_blend_200m_v2",58},
        {"msr_trn_hirise_dtm_1m_v003_ovr32",32,{"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_32m.tif","",0,0,"msr_trn_hirise_dtm_1m_v003/ovr/MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_32m.tif"},"hrsc_hmc30_dt5",64},
        {"msr_trn_hirise_dtm_1m_v003_ovr16",16,{"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_16m.tif","",0,0,"msr_trn_hirise_dtm_1m_v003/ovr/MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_16m.tif"},"hrsc_hmc30_dt5",64},
        {"msr_trn_hirise_dtm_1m_v003_ovr8",8,{"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_8m.tif","",0,0,"msr_trn_hirise_dtm_1m_v003/ovr/MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_8m.tif"},"hrsc_hmc30_dt5",64},
        {"msr_trn_hirise_dtm_1m_v003_ovr4",4,{"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_4m.tif","",0,0,"msr_trn_hirise_dtm_1m_v003/ovr/MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_4m.tif"},"hrsc_hmc30_dt5",64},
        {"msr_trn_hirise_dtm_1m_v003_ovr2",2,{"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_2m.tif","",0,0,"msr_trn_hirise_dtm_1m_v003/ovr/MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_2m.tif"},"hrsc_hmc30_dt5",64},
        {"msr_trn_hirise_dtm_1m_v003",1,{"MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_rows.tif","",0,0,"msr_trn_hirise_dtm_1m_v003/ovr/MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_rows.tif"},"hrsc_hmc30_dt5",64},
    };
    for(const auto& level:levels)products->push_back({level.key,level.key,"2026-10-21",0,0,4,false,false,0,level.spacing,0,1,
        {level.file},"mega_16",true,level.backing,level.posts,true});
}

const std::vector<Body>& bodies() {
    static std::vector<Body> table = {
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
             // USGS blend: area pixels, x=(lon+180)*296.3735-.5, y=(90-lat)*296.3735-.5.
             // ^IMAGE is 1-based; the label's projection sphere is 3396190 m,
             // independent of its areoid height datum (converted with MEGA DN).
             {"hrsc_mola_blend_200m_v2", "USGS:HRSC-MOLA-BlendDEM-Global-200mp-v2", "2018-01-31",
              53347, 106694, 2, false, false, 296.3735, 0, 0, 2,
              {{"Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2", "\"94ec792407f5a3da2f8b87aba42613eb-1358\"", 90, -180,
                "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif",
                "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/HRSC_MOLA_Blend/mars_hrsc_mola_blenddem_global_200mp_v2_pds3.lbl",
                854272}}, "mega_16", true, "megr_128", 4},
             // QA: exact backing-footprint averages, all overlap posts, 2026-10-21.
             // Gate median |delta| <25 m, p99 <250 m; rejected files omitted below.
             // DTM                       median_abs_m  p99_abs_m  accepted
             // HMC_11E10_dt5.tif                15.2519  130.0050 true
             // HMC_11E20_dt5.tif                21.1828  155.9545 true
             // HMC_11E30_dt5.tif                12.7417  150.5512 true
             // HMC_11E40_dt5.tif                10.8670  122.5206 true
             // HMC_11W10_dt5.tif                 6.6440   70.1423 true
             // HMC_11W20_dt5.tif                16.0957  154.7427 true
             // HMC_11W30_dt5.tif                10.5310  124.2944 true
             // HMC_11W40_dt5.tif                12.2661  158.2570 true
             // HMC_13E10_dt5.tif                16.8908  151.9861 true
             // HMC_13E20_dt5.tif                10.0971   87.6343 true
             // HMC_13E30_dt5.tif                 9.9144   85.5845 true
             // HMC_13E40_dt5.tif                 8.1215   86.0431 true
             // HMC_20E10_dt5.tif                15.3205  245.2789 true
             // HMC_20E20_dt5.tif                10.6431  107.4396 true
             // HMC_20E30_dt5.tif                10.0224  117.5476 true
             // HMC_20E40_dt5.tif                 7.9458  101.4502 true
             // HMC_20W10_dt5.tif                13.7015  119.3168 true
             // HMC_20W20_dt5.tif                14.8597  142.7901 true
             // HMC_20W30_dt5.tif                 9.3514  107.4874 true
             // HMC_20W40_dt5.tif                 8.0284   96.7240 true
             // MSL_Gale_DEM_Mosaic_1m_v3.tif    19.0310  110.0615 true
             // Jezero native                    16.6771   57.1647 true
             // Mask-ring check (32 m): Gale p99=133.255441 => N=58;
             // Jezero p99=56.655034 => N=64. HMC native N=64.
             // Datum preflight (raw-sphere / raw-blend median metres):
             // HMC MC13E10 -0.22 / -2234.75 => sphere (all HMC agree).
             // Gale +354.52 / -14.59; Jezero +1456.12 / -16.62 => add MEGA.
             {"mega_16", "MGS-M-MOLA-5-MEGDR-L3-V1.0:MEGA90N000EB", "2003-04-03", 2880, 5760, 2,
              false, false, 16, 0, 0, 1, {{"meg016/mega90n000eb", "\"80aee56389f8c21:0\"", 90, 0}}},
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
    static const bool initialized = [&] { append_mars_insets(&table[1].products); return true; }();
    (void)initialized;
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
    const BodyProduct* fill = nullptr;
    uint32_t feather_posts = 0;
    bool fill_edges = true;
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
            // JSON booleans are not numeric options.
            const auto edge_at = obj.find("\"fill_edges\"");
            if (edge_at != std::string::npos) {
                const auto value = obj.find_first_not_of(" \t\r\n", obj.find(':', edge_at) + 1);
                if (obj.compare(value, 5, "false") == 0) c.fill_edges = false;
                else if (obj.compare(value, 4, "true") != 0) { *error = "fill_edges must be boolean"; return {}; }
            }
            if (!c.product) { *error = "caps names a product this body does not know: " + key; return {}; }
            std::string fill;
            const bool has_fill = json_string_field(obj, "fill", &fill);
            if (!has_fill && obj.find("\"fill\"") != std::string::npos) {
                *error = "fill must name a product key";
                return {};
            }
            const bool has_posts = obj.find("\"feather_posts\"") != std::string::npos;
            const double n = json_number_or(obj, "feather_posts", 0);
            if ((has_fill || has_posts) && (n < 1 || n > 64 || n != std::floor(n))) {
                *error = "feather_posts must be an integer in [1, 64]";
                return {};
            }
            if (has_posts) c.feather_posts = static_cast<uint32_t>(n);
            if (has_fill) {
                c.fill = body_product(body, fill);
                if (!c.fill) { *error = "caps names an unknown fill product: " + fill; return {}; }
            }
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
        if(p.inset) {
            if(std::count_if(caps.begin(),caps.end(),[&](const BodyCap& other){return other.product==c.product&&other.min_level<=c.max_level&&other.max_level>=c.min_level;})!=1){*error="one inset cap per product per level is required";return {};}
            const long level=std::string(p.key)=="hrsc_hmc30_dt5"?10:15-static_cast<long>(std::log2(p.scale_m));
            if(c.min_level!=level||c.max_level!=level){*error="an inset cap must use its level-matched source overview";return {};}
        }
        if(p.inset)for(const auto& f:p.files)if(!body_inset(f.path)) {
            *error=std::string("invalid inset catalog: ")+f.path;
            return {};
        }
        if (p.polar && (p.south ? c.lat_max > -p.edge_lat : c.lat_min < p.edge_lat)) {
            *error = std::string("cap ") + p.key + " reaches past the latitude its polar product covers all round";
            return {};
        }
        if (!p.polar && !p.inset) {
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
    if (caps.empty() || caps[0].product->inset || caps[0].product->polar || caps[0].product->files.size() != 1 || caps[0].min_level != 0 ||
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

double body_post_spacing(const Body& body, const BodyProduct& p);

struct BodyBlock {
    long bx, by;
    double lo, hi;
    double fill_lo = 1e300, fill_hi = -1e300;
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
                    if (c.fill && body_tile_lines(body, *c.fill, level, x, y, max_grid, &lo, &hi)) {
                        b.fill_lo = std::min(b.fill_lo, lo);
                        b.fill_hi = std::max(b.fill_hi, hi);
                    }
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
std::vector<std::pair<size_t, size_t>> body_polar_batches(const Body& body, const BodyCap& cap, const std::vector<BodyBlock>& blocks,
                                                          double max_range_bytes) {
    std::vector<std::pair<size_t, size_t>> out;
    const BodyProduct& p = *cap.product;
    const double max_lines = std::floor(max_range_bytes / static_cast<double>(p.samples * p.sample_bytes));
    const double band = cap.fill ? cap.feather_posts * body_post_spacing(body, *cap.fill) : 0;
    const double primary_pad = cap.fill ? std::ceil(band / body_post_spacing(body, p)) + 2 : 0;
    const double fill_pad = cap.fill ? cap.feather_posts + 2 : 0;
    const auto decoded_rows = [](const BodyProduct& product, double lo, double hi, double pad) {
        return std::min<double>(product_lines(product) - 1, std::ceil(hi + pad)) -
               std::max(0.0, std::floor(lo - pad)) + 1;
    };
    const auto fits_fill = [&](double lo, double hi, double flo, double fhi) {
        if (!cap.fill) return true;
        const BodyProduct& f = *cap.fill;
        // Primary float grid + double EDT + worst-case invalid-post indices and
        // vector capacity, alongside the fill grid; leave room for row scratch.
        const double primary_bytes = decoded_rows(p, lo, hi, primary_pad) * p.samples * 20;
        const double fill_width = f.polar ? f.samples : 360 * f.ppd + 2;
        const double fill_bytes = decoded_rows(f, flo, fhi, fill_pad) * fill_width * (f.may_have_nodata ? 20 : 4);
        return primary_bytes + fill_bytes <= (f.fallback ? 400.0 : 480.0) * 1024 * 1024;
    };
    for (size_t i = 0; i < blocks.size();) {
        double lo = blocks[i].lo, hi = blocks[i].hi;
        double flo = blocks[i].fill_lo, fhi = blocks[i].fill_hi;
        size_t j = i + 1;
        for (; j < blocks.size() && static_cast<long>(j - i) < kBodyMaxBlocks; j++) {
            const double nlo = std::min(lo, blocks[j].lo), nhi = std::max(hi, blocks[j].hi);
            const double nflo = std::min(flo, blocks[j].fill_lo), nfhi = std::max(fhi, blocks[j].fill_hi);
            if (std::ceil(nhi) - std::floor(nlo) + 1.0 > max_lines || !fits_fill(nlo, nhi, nflo, nfhi)) break;
            flo = nflo; fhi = nfhi;
            lo = nlo;
            hi = nhi;
        }
        out.push_back({i, j});
        i = j;
    }
    return out;
}

const std::vector<std::pair<size_t,BodyUnit>>& body_inset_units(const std::vector<BodyCap>& caps,long level,double max_grid) {
    // Cache only geometry; cap pointers belong to the current invocation.
    static std::string saved_key;
    static std::array<std::vector<std::pair<size_t,BodyUnit>>,17> saved;
    static std::array<bool,17> ready{};
    std::string key=std::to_string(max_grid);
    for(const auto& c:caps) {
        char geometry[128];std::snprintf(geometry,sizeof(geometry),":%ld:%ld:%.17g:%.17g",c.min_level,c.max_level,c.lat_min,c.lat_max);
        key+='|';key+=c.product->key;key+=geometry;
    }
    if(key!=saved_key){for(auto& v:saved)v.clear();ready.fill(false);saved_key=key;}
    if(ready[level])return saved[level];
    // Finest source owns a shared block. Its backing supplies the other inset's
    // covered tiles in that same file, so a packed file is never overwritten.
    std::vector<std::array<long,3>> tiles; // x,y,cap index; sort once by whole block
    for(const auto& c:caps)if(c.product->inset&&level>=c.min_level&&level<=c.max_level) {
        const std::string family=std::strncmp(c.product->key,"hrsc_",5)==0?"HMC":std::strncmp(c.product->key,"msl_",4)==0?"Gale":"Jezero";
        const double span=tile_size_deg(level);
        for(const auto& coverage:body_inset_coverage())if(family==coverage.family)for(size_t i=0;i<coverage.count;i++) {
            const auto& r=coverage.rectangles[i];
            const long down=std::max(0L,coverage.level-level),up=std::max(0L,level-coverage.level);
            const long x0=(r[0]>>down)<<up,x1=(((r[2]>>down)+1)<<up)-1;
            const long y0=(r[1]>>down)<<up,y1=(((r[3]>>down)+1)<<up)-1;
            for(long y=y0;y<=y1;y++)for(long x=x0;x<=x1;x++) {
                if(-90+(y+1)*span<c.lat_min||-90+y*span>c.lat_max)continue;
                tiles.push_back({x,y,static_cast<long>(&c-caps.data())});
            }
        }
    }
    // The records are trivially copyable; one C sort avoids another large
    // introsort template in each shipped guest-link object.
    std::qsort(tiles.data(),tiles.size(),sizeof(tiles[0]),[](const void* left,const void* right) {
        const auto& a=*static_cast<const std::array<long,3>*>(left);
        const auto& b=*static_cast<const std::array<long,3>*>(right);
        if(a[1]/4!=b[1]/4)return a[1]/4<b[1]/4?-1:1;
        if(a[0]/4!=b[0]/4)return a[0]/4<b[0]/4?-1:1;
        for(size_t k=0;k<3;k++)if(a[k]!=b[k])return a[k]<b[k]?-1:1;
        return 0;
    });
    auto& cache=saved[level];long bx=-1,by=-1;
    for(const auto& t:tiles) {
        if(t[0]/4!=bx||t[1]/4!=by){
            bx=t[0]/4;by=t[1]/4;cache.push_back({static_cast<size_t>(t[2]),BodyUnit{}});
            cache.back().second.level=level;cache.back().second.blocks=1;
        }
        auto& row=cache.back();
        if(caps[t[2]].product->scale_m<caps[row.first].product->scale_m)row.first=t[2];
        auto& posts=row.second.tiles;
        if(posts.empty()||posts.back()[1]!=t[0]||posts.back()[2]!=t[1])posts.push_back({level,t[0],t[1]});
    }
    for(auto& row:cache)row.second.cap=&caps[row.first];
    ready[level]=true;
    return cache;
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
            if(c.product->inset) {
                for(const auto& row:body_inset_units(caps,level,max_grid))if(row.first==static_cast<size_t>(&c-caps.data())) {
                    if(wanted(count)){BodyUnit u=row.second;u.cap=&c;units->push_back(std::move(u));}count++;
                }
                continue;
            }
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
            const auto batches = body_polar_batches(body, c, blocks, max_range_bytes);
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

// A product's metric post spacing. Every window remains on that product's global lattice.
double body_post_spacing(const Body& body, const BodyProduct& p) {
    return (p.polar || p.inset) ? p.scale_m : body.radius_m * kBodyPi / 180.0 / p.ppd;
}

// Float PDS products can carry non-finite posts, including in otherwise interior units.
// An explicit fill opts into covering those holes as well as the latitude seams.
bool body_unit_needs_fill(const Body& body, const BodyUnit& u, double max_grid) {
    if (!u.cap->fill) return false;
    if (u.cap->product->inset) return true;
    // MOLA polar MEGR is measured complete (no nodata); its fill is only
    // needed near a band edge. LOLA float products retain hole protection.
    if ((u.cap->product->sample_bytes == 4 && std::string(body.name) != "mars") || u.cap->product->may_have_nodata) return true;
    if (!u.cap->fill_edges) return false;
    const double band = u.cap->feather_posts * body_post_spacing(body, *u.cap->fill);
    const double degrees = band * 180.0 / (body.radius_m * kBodyPi);
    for (const auto& t : u.tiles) {
        const double size = tile_size_deg(t[0]), halo = body_halo_deg(t[0], max_grid);
        const double south = -90 + t[2] * size - halo, north = south + size + 2 * halo;
        if ((u.cap->lat_min > -90 && south <= u.cap->lat_min + degrees) ||
            (u.cap->lat_max < 90 && north >= u.cap->lat_max - degrees)) return true;
    }
    return false;
}

// Whole-line windows include the normals' halo AND B metres of source posts for the
// invalid-mask EDT. All columns are fetched, so this also covers the horizontal halo.
BodyUnit body_product_window(const Body& body, const BodyUnit& u, const BodyProduct& p,
                             double max_grid, double band_m) {
    BodyUnit window = u;
    if(p.inset)return window;
    double lo = 1e300, hi = -1e300;
    window.lon_west = 1e300;
    window.lon_east = -1e300;
    for (const auto& t : u.tiles) {
        double a = 0, b = 0;
        if (!body_tile_lines(body, p, t[0], t[1], t[2], max_grid, &a, &b)) continue;
        lo = std::min(lo, a); hi = std::max(hi, b);
        const double size = tile_size_deg(t[0]);
        const double margin = body_halo_deg(t[0], max_grid) +
                              (band_m + body_post_spacing(body, p)) * 180 / (body.radius_m * kBodyPi);
        window.lon_west = std::min(window.lon_west, -180 + t[1] * size - margin);
        window.lon_east = std::max(window.lon_east, -180 + (t[1] + 1) * size + margin);
    }
    const double pad = std::ceil(band_m / body_post_spacing(body, p)) + 2;
    window.first_line = static_cast<uint64_t>(std::max(0.0, std::floor(lo - pad)));
    window.last_line = static_cast<uint64_t>(std::min<double>(product_lines(p) - 1, std::ceil(hi + pad)));
    return window;
}

bool body_inset_window(const BodyInset& in,const BodyUnit& u,double max_grid,BodyTiffWindow* out,double band=0) {
    double west=1e300,east=-1e300,south=1e300,north=-1e300;
    for(const auto& t:u.tiles){const double size=tile_size_deg(t[0]),halo=body_halo_deg(t[0],max_grid);
        west=std::min(west,-180+t[1]*size-halo);east=std::max(east,-180+(t[1]+1)*size+halo);
        south=std::min(south,-90+t[2]*size-halo);north=std::max(north,-90+(t[2]+1)*size+halo);}
    return in.tiff.window(west,south,east,north,band,out);
}
size_t body_window_files(const BodyProduct& p, const BodyUnit& u, double max_grid) {
    size_t count = 0;
    for (const BodyFile& f : p.files) {
        if(p.inset){auto* in=body_inset(f.path);BodyTiffWindow w;if(in&&body_inset_window(*in,u,max_grid,&w))count++;continue;}
        uint64_t a = 0, b = 0;
        if (body_file_lines(p, f, u, &a, &b)) count++;
    }
    return count;
}
