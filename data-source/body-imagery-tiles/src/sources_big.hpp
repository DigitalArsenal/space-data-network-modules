// THE LARGE-BODY SOURCES: one global equirectangular 8-bit mosaic per body, one image row per strip, uncompressed and contiguous
// (a GeoTIFF's strips, a PDS3 IMG's records: rows follow strip0 at `width` bytes each), 0 = no data. Unlike sources_small.hpp the
// table states each file's own frame: x0_m / y0_m are the GeoTIFF's (or the PDS label's, read by GDAL) edge coordinates in metres
// from (lon0_deg east, 0 N), planetocentric east longitude taken literally (the IAU gazetteer centers land on the right craters:
// tests/big.e2e.test.mjs, 10 features per body within one pixel).
//
//   Mercury  MESSENGER MDIS basemap BDR 166 m (NASA/JHUAPL/CIW; mosaic USGS Astrogeology)
//   Venus    Magellan SAR left-look 75 m, 80 S to 84 N; its no data (the caps, holes) is filled from the C3-MDIR 2025 m mosaic
//   Ceres    Dawn FC LAMO clear filter 35 m (DLR), the IAU Kait longitude system
//   Vesta    Dawn FC LAMO clear filter 20 m (DLR), the IAU Claudia Double Prime longitude system (the console's PCK, pck00011,
//            carries the same W0 = 285.39: no offset)
// Venus C3-MDIR (key venus-magellan-c3mdir) is the fill source only; the unit selects bodies by NAIF id and never names it.
#pragma once
#include <string>

#include "source.hpp"

namespace bit {

inline const Source* big_sources(size_t* count) {
    static const Source table[] = {
    {"mercury-mdis-bdr", 199,
     "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mercury_MESSENGER_MDIS_Basemap_BDR_Mosaic_Global_166m.tif",
     "\"a4cd0c5c563f0580176483c08a97af3b-507\"", 92160, 46080, 738101,
     166.310788176, -7663601.119166941, 3831800.5595834707, 2439400.0, 8,
     "Mercury MESSENGER MDIS basemap BDR global mosaic 166 m (USGS Astrogeology)", "2022-11-10T05:12:12.000Z",
     "Public domain (NASA/JHUAPL/CIW)", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
     "NASA/Johns Hopkins University Applied Physics Laboratory/Carnegie Institution of Washington; mosaic USGS Astrogeology",
     "mdis-bdr-mercury", "MERCURY", "MERCURY (IAU sphere 2439.4 km)",
     1, 0, 0.0, ""},
    {"venus-magellan-left", 299,
     "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Venus_Magellan_LeftLook_mosaic_global_75m.tif",
     "\"f242b14ace35ace3f9c81422c9c1a2ee-6979\"", 506928, 230948, 3695971,
     75.0, -19009775.9367, 8871191.6025, 6051000.0, 10,
     "Venus Magellan SAR left-look global mosaic 75 m (USGS Astrogeology), no data filled from the C3-MDIR 2025 m mosaic", "2022-12-16T01:02:22.000Z",
     "Public domain (USGS Astrogeology; NASA/JPL Magellan)", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
     "NASA/JPL Magellan; mosaic USGS Astrogeology",
     "magellan-sar-left-venus", "VENUS", "VENUS (IAU sphere 6051 km)",
     1, 0, 0.0, "venus-magellan-c3mdir"},
    {"ceres-dawn-lamo", 2000001,
     "https://sbnarchive.psi.edu/pds3/dawn/fc/DWNCLCFC2_2/DATA/CE_LAMO_G_00N_180E_EQU_CLR.IMG",
     "\"d42e9850-53bc66a53e640\"", 84376, 42187, 253128,
     35.0, -1476562.5, 738272.5, 470000.0, 7,
     "Ceres Dawn FC LAMO clear-filter global mosaic 35 m (DLR, DAWN-A-FC2-5-CERESMOSAIC-V1.0)", "2016-09-05T17:57:37.000Z",
     "Public domain (NASA Dawn, PDS)", "https://www.nasa.gov/nasa-brand-center/images-and-media/",
     "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA; mosaic DLR (Roatsch et al.)",
     "dawn-fc-lamo-ceres", "CERES", "CERES (IAU sphere 470 km, Kait longitude system)",
     1, 0, 180.0, ""},
    {"vesta-dawn-lamo", 2000004,
     "https://sbnarchive.psi.edu/pds3/dawn/fc/DWNVFC2_2/DATA/LAMO_CLEAR/VE_LAMO_00N_330E_CYL_CLEAR.IMG",
     "\"bf458cf7-50ec5ca10d440\"", 80111, 40054, 240333,
     20.0, -801110.0, 400550.0, 255000.0, 7,
     "Vesta Dawn FC LAMO clear-filter global mosaic 20 m (DLR, DAWN-A-FC2-5-MOSAIC-V1.0)", "2015-02-11T01:19:05.000Z",
     "Public domain (NASA Dawn, PDS)", "https://www.nasa.gov/nasa-brand-center/images-and-media/",
     "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA; mosaic DLR (Roatsch et al.)",
     "dawn-fc-lamo-vesta", "VESTA", "VESTA (IAU sphere 255 km, Claudia Double Prime longitude system)",
     1, 0, 330.0, ""},
    // The fill of Venus: global to 82.4 S, 90 N (Magellan did not image the south pole).
    {"venus-magellan-c3mdir", 299,
     "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Venus_Magellan_C3-MDIR_Global_Mosaic_2025m.tif",
     "\"6c5c001af6270d6be425447e7669eef5-22\"", 18775, 9388, 75753,
     2025.0, -19009777.146871999, 9504888.573435999, 6051000.0, 5,
     "Venus Magellan C3-MDIR global mosaic 2025 m (USGS Astrogeology)", "2022-11-10T06:15:56.000Z",
     "Public domain (USGS Astrogeology; NASA/JPL Magellan)", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
     "NASA/JPL Magellan; mosaic USGS Astrogeology",
     "magellan-c3mdir-venus", "VENUS", "VENUS (IAU sphere 6051 km)",
     1, 0, 0.0, ""},
    };
    *count = sizeof(table) / sizeof(table[0]);
    return table;
}

inline const Source* find_big_source(const std::string& key) {
    size_t n = 0;
    const Source* t = big_sources(&n);
    for (size_t i = 0; i < n; i++)
        if (key == t[i].key) return &t[i];
    return nullptr;
}

}  // namespace bit
