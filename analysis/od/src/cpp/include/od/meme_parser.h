#ifndef OD_MEME_PARSER_H
#define OD_MEME_PARSER_H

/**
 * SpaceX MEME Ephemeris Parser
 *
 * Parses SpaceX Modified Extended Mission Ephemeris (MEME) format files
 * from: https://api.starlink.com/public-files/ephemerides/
 *
 * Format:
 *   created:2026-03-10 20:32:53 UTC
 *   ephemeris_start:2026-03-10 20:16:42 UTC ephemeris_stop:2026-03-13 20:16:42 UTC step_size:60
 *   ephemeris_source:blend
 *   UVW
 *   YYYYDDDHHMMSS.sss X Y Z VX VY VZ
 *   <21 covariance elements, lower triangular 6×6, 3 lines of 7 values>
 *   ... repeats every step_size seconds
 *
 * State vectors are EME2000 (J2000 mean equator and equinox), km and km/s,
 * UTC epochs. "UVW" names the covariance frame only. Use meme_state_series
 * (state_series.h) to hand them to the fitter in TEME.
 *
 * Filename pattern:
 *   MEME_{NORAD}_{NAME}_{COSPAR}_{Status}_{UnixTimestamp}_UNCLASSIFIED.txt
 */

#include <cstdint>
#include <string>
#include <vector>

namespace od {

/// Single ephemeris state point with covariance
struct EphemerisPoint {
    double epoch_jd;           // Julian Date
    std::string timestamp_str; // Original YYYYDDDHHMMSS.sss
    double x, y, z;           // Position (km)
    double vx, vy, vz;        // Velocity (km/s)
    double covariance[21];     // Lower triangular 6×6 (pos+vel)
    bool has_covariance = false;
};

/// MEME file metadata
struct MEMEHeader {
    std::string created;
    std::string ephemeris_start;
    std::string ephemeris_stop;
    int step_size_sec = 60;
    std::string ephemeris_source;
    std::string reference_frame;  // "UVW": the covariance frame (states are EME2000)

    // Parsed from filename
    int norad_cat_id = 0;
    std::string object_name;
    std::string cospar_id;
    std::string status;          // "Operational", etc.
    int64_t unix_timestamp = 0;
};

/// Parsed MEME file
struct MEMEFile {
    MEMEHeader header;
    std::vector<EphemerisPoint> points;
};

/// Parse a MEME ephemeris file from string content
MEMEFile parse_meme(const std::string& content);

/// Parse a MEME ephemeris file from file path
MEMEFile parse_meme_file(const std::string& path);

/// Extract metadata from MEME filename
/// e.g., "MEME_51878_STARLINK-3575_0692016_Operational_1457468220_UNCLASSIFIED.txt"
MEMEHeader parse_meme_filename(const std::string& filename);

/// Parse MEME timestamp: YYYYDDDHHMMSS.sss → Julian Date
double meme_timestamp_to_jd(const std::string& ts);

/// Parse ISO 8601 timestamp → Julian Date
double iso_to_jd(const std::string& iso);

/// Julian Date → ISO 8601 string
std::string jd_to_iso_supgp(double jd);

/// Parse MANIFEST.txt → list of filenames
std::vector<std::string> parse_manifest(const std::string& content);

}  // namespace od

#endif  // OD_MEME_PARSER_H
