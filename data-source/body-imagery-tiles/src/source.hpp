// THE SOURCE: one global equirectangular mosaic, read by HTTP range.
//
// USGS Astrogeology's Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif (NASA
// Mars Odyssey THEMIS daytime infrared, Edwards et al. 2011, Arizona State
// University / NASA JPL; public domain): a BigTIFF of 213390 x 106696 8-bit
// samples, one image row per strip, uncompressed and contiguous, 0 = no data.
// Its CRS is Equidistant Cylindrical on the 3396190 m Mars sphere, centre
// longitude 180, planetocentric latitude and east longitude: the pixel edges
// are x = X0 + 100 i, y = Y0 - 100 j metres from (180 E, 0 N).
//
// The table is the file as its own header states it (the encode tool re-reads the
// header and the strip offsets before a run); the range requests carry If-Match on
// the file's ETag, so a reprocessed mosaic stops the run.
#pragma once
#include <cmath>
#include <cstdint>
#include <string>

namespace bit {

struct Source {
    const char* key;
    int naif;
    const char* url;
    const char* etag;
    uint64_t width, height;
    uint64_t strip0;         // byte offset of row 0 (rows follow at `width` bytes each)
    double pixel_m, x0_m, y0_m, sphere_m;
    int max_level;           // the deepest output level (256 px tiles, two at level 0)
    const char* dataset_name;
    const char* epoch;
    const char* license;
    const char* license_url;
    const char* citation;
    const char* tileset;     // DTT TILESET_ID
    const char* center;      // DTT CENTER_NAME
    const char* datum;       // DTT HORIZONTAL_DATUM_NAME
    int bands;               // 1 (gray) or 3 (RGB, one plane after another: plane b starts at strip0 + b * plane_stride); 0 reads as 1
    uint64_t plane_stride;   // bytes from one plane's row 0 to the next plane's (height * width)
    double lon0_deg = 180.0; // the east longitude at x = 0 of x0_m (the module's frame is 180; sources_big.hpp states the file's own)
    const char* fill_key = "";  // "" or the key of a coarser source whose pixels fill this one's no data (outside its latitudes, holes)
};
inline int band_count(const Source& s) { return s.bands == 3 ? 3 : 1; }

inline const Source& themis_day_ir() {
    static const Source s{
        "themis-day-ir", 499,
        "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif",
        "\"f6a82c639d6c2b4b2c499fb99663728c-2715\"", 213390, 106696, 1707925,
        100.0, -10669500.0, 5334800.0, 3396190.0, 9,
        "Mars Odyssey THEMIS Day IR global mosaic 100 m v12 (USGS Astrogeology)", "2022-11-10T03:49:10.000Z",
        "Public domain (NASA/JPL/ASU)", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
        "THEMIS: NASA/JPL/ASU (Christensen et al. 2004; Edwards et al. 2011, JGR 116, E10008); mosaic USGS Astrogeology",
        "themis-day-ir-mars", "MARS", "MARS (IAU MOLA sphere 3396.19 km)"};
    return s;
}

// Metres of the CRS per degree on its sphere.
inline double m_per_deg(const Source& s) { return s.sphere_m * 3.14159265358979323846 / 180.0; }

// The source's pixel coordinates (edges at integers) of a planetocentric latitude and an east longitude in [0, 360).
inline double source_row(const Source& s, double lat) { return (s.y0_m - lat * m_per_deg(s)) / s.pixel_m; }
inline double source_col(const Source& s, double lon_e) {
    double d = lon_e - s.lon0_deg;  // [-180, 180) around the CRS centre
    while (d < -180.0) d += 360.0;
    while (d >= 180.0) d -= 360.0;
    return (d * m_per_deg(s) - s.x0_m) / s.pixel_m;
}

}  // namespace bit
