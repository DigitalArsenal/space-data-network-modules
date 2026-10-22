// HD provenance for bounded GDAL-prepared windows; generated from tools/big/hd-sources.json.
#pragma once
#include "source.hpp"
namespace bit {
inline const Source* hd_source(const std::string& key) {
    static const Source sources[] = {
        {"moon-lo-uvvis", 301, "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_LO_UVVISv2_Hybrid_Mosaic_Global_59m.tif", "9e832ad1d4acf844467cd3bcf35622b4-2026", 0, 0, 0, 59.225293797167, 0, 0, 1737400, 9, "Lunar Orbiter + Clementine UVVIS v2 hybrid mosaic", "", "Public domain (USGS)", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits", "USGS Astrogeology; NASA Lunar Orbiter III–V and Clementine UVVIS v2", "moon-lo-uvvis", "MOON", "Moon planetocentric east; sphere 1737400 m", 1, 0, 0.0, ""},
        {"mars-ctx-mc13", 499, "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/Mars_MRO_CTX_Equi_Mosaics_Robbins/6mpp/MC13_6mpp.16bit.tif", "", 0, 0, 0, 6, 0, 0, 3396190, 13, "USGS controlled CTX MC13 mosaic 6 m", "", "Public domain (USGS)", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits", "NASA/JPL-Caltech/MSSS; controlled mosaic USGS Astrogeology (Robbins et al.)", "mars-ctx-mc13", "MARS", "Mars planetocentric east; sphere 3396190 m", 1, 0, 0.0, ""},
        {"mars-ctx-mc23", 499, "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/Mars_MRO_CTX_Equi_Mosaics_Robbins/6mpp/MC23_6mpp.16bit.tif", "", 0, 0, 0, 6, 0, 0, 3396190, 13, "USGS controlled CTX MC23 mosaic 6 m", "", "Public domain (USGS)", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits", "NASA/JPL-Caltech/MSSS; controlled mosaic USGS Astrogeology (Robbins et al.)", "mars-ctx-mc23", "MARS", "Mars planetocentric east; sphere 3396190 m", 1, 0, 0.0, ""},
        {"mars-ctx-mc18", 499, "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/Mars_MRO_CTX_Equi_Mosaics_Robbins/6mpp/MC18_6mpp.16bit.tif", "", 0, 0, 0, 6, 0, 0, 3396190, 13, "USGS controlled CTX MC18 mosaic 6 m", "", "Public domain (USGS)", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits", "NASA/JPL-Caltech/MSSS; controlled mosaic USGS Astrogeology (Robbins et al.)", "mars-ctx-mc18", "MARS", "Mars planetocentric east; sphere 3396190 m", 1, 0, 0.0, ""},
    };
    for (const auto& s : sources) if (key == s.key) return &s;
    return nullptr;
}
}
