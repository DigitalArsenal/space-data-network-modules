// The roster: which platforms and sites the module publishes sensors for, and the facts it reads from a source that is
// not a table. NOTHING here is a value of a sensor that is not backed by a source document:
//   - a satellite is a WMO OSCAR slug plus the NORAD_CAT_ID it is joined by; the join is checked against the CelesTrak SATCAT
//     (the row exists; the launch date equals OSCAR's), never made by a name;
//   - a constellation (ICEYE, Capella, Umbra) is an OSCAR satellite entry plus the SATCAT OBJECT_NAME prefix of its members;
//   - an OSCAR instrument with a channel table has its bands read from the table; one without gets its bands from a Fact;
//   - a Fact is a value read from a QUOTE: the module publishes it only when the quote occurs in the fetched document and
//     the number text occurs in the quote, so a stale quote or a mistyped number stops the value, not the run.
// Sources and terms: README.md.
#pragma once
#include <cstddef>
#include <cstdint>

namespace roster {

enum class Field : uint8_t {
  BandLowHz,       // band edge (low), Hz
  BandHighHz,      // band edge (high), Hz
  BandCenterHz,    // band centre, Hz
  BandWidthHz,     // band width, Hz (edges are centre -/+ width / 2, stated as derived)
  RfBandwidthHz,
  RfPeakPowerW,
  LookInnerDeg,    // SAR inner look (off-nadir) angle
  LookOuterDeg,    // SAR outer look (off-nadir) angle
  ConeHalfAngleDeg,// conic field-of-view half angle
  MaxRangeM,
  BoresightAzDeg,  // local east-north-up azimuth, clockwise from north
  BoresightElDeg,
  ElLimitMinDeg,
  PointingFixed,   // literal 1
  ApertureM,
  Type,            // literal SensorType
  Emission,        // literal snrEmissionMode
};

// A value read from a quote. value = number (commas removed) x scale, else literal.
struct Fact {
  Field field;
  int band;            // the band index for the Band* fields, else 0
  const char* quote;   // verbatim in the document (whitespace collapsed)
  const char* number;  // a substring of quote, or nullptr when the value is `literal`
  double scale;
  double literal;
};

// A band named by the roster. designation is a substring of designation_quote, which must occur in the document.
struct BandSpec { const char* name; const char* designation; const char* designation_quote; };

struct Instrument {
  const char* slug;          // OSCAR instrument slug
  const BandSpec* bands;     // nullptr: the bands come from the channel table
  size_t band_count;
  const Fact* facts;
  size_t fact_count;
};

struct Platform {
  const char* oscar;         // OSCAR satellite slug
  int norad;                 // NORAD_CAT_ID joined by; 0 for a constellation joined by `prefix`
  const char* prefix;        // SATCAT OBJECT_NAME prefix of a constellation's members
  const char* instruments[4];
};

constexpr double kGHz = 1e9, kMHz = 1e6;

inline constexpr BandSpec kCBand[] = {{"C-band", "C", "C-band SAR, frequency 5.405 GHz"}};
inline constexpr Fact kSentinel1[] = {
    {Field::BandCenterHz, 0, "C-band SAR, frequency 5.405 GHz", "5.405", kGHz, 0},
    {Field::LookInnerDeg, 0, "Side-looking, 15-45\xC2\xB0 off-nadir", "15", 1, 0},
    {Field::LookOuterDeg, 0, "Side-looking, 15-45\xC2\xB0 off-nadir", "45", 1, 0},
};
inline constexpr BandSpec kXBand[] = {{"X-band", "X", "X-band SAR, frequency 9.65 GHz"}};
inline constexpr Fact kXSar[] = {{Field::BandCenterHz, 0, "X-band SAR, frequency 9.65 GHz", "9.65", kGHz, 0}};
inline constexpr BandSpec kUmbraBand[] = {{"X-Band", "X", "Imaging radar in X-Band with 1200 MHz bandwidth"}};
inline constexpr Fact kUmbra[] = {{Field::RfBandwidthHz, 0, "Imaging radar in X-Band with 1200 MHz bandwidth", "1200", kMHz, 0}};
inline constexpr BandSpec kLBand[] = {{"L-band", "L", "L-band frequency in the range 1.215-1.3 GHz"}};
inline constexpr Fact kNisarL[] = {
    {Field::BandLowHz, 0, "L-band frequency in the range 1.215-1.3 GHz", "1.215", kGHz, 0},
    {Field::BandHighHz, 0, "L-band frequency in the range 1.215-1.3 GHz", "1.3", kGHz, 0},
};
inline constexpr BandSpec kSBand[] = {{"S-band", "S", "S-band frequency in the range 3.162-3.237 GHz"}};
inline constexpr Fact kNisarS[] = {
    {Field::BandLowHz, 0, "S-band frequency in the range 3.162-3.237 GHz", "3.162", kGHz, 0},
    {Field::BandHighHz, 0, "S-band frequency in the range 3.162-3.237 GHz", "3.237", kGHz, 0},
};
inline constexpr BandSpec kSral[] = {{"5.4 GHz", nullptr, nullptr}, {"13.58 GHz", nullptr, nullptr}};
inline constexpr Fact kSralFacts[] = {
    {Field::BandCenterHz, 0, "Dual-frequency (5.4 and 13.58 GHz)", "5.4", kGHz, 0},
    {Field::BandCenterHz, 1, "Dual-frequency (5.4 and 13.58 GHz)", "13.58", kGHz, 0},
};
inline constexpr BandSpec kMwr[] = {{"23.8 GHz", nullptr, nullptr}, {"36.5 GHz", nullptr, nullptr}};
inline constexpr Fact kMwrFacts[] = {
    {Field::BandCenterHz, 0, "2 channels: 23.8 and 36.5 GHz", "23.8", kGHz, 0},
    {Field::BandCenterHz, 1, "2 channels: 23.8 and 36.5 GHz", "36.5", kGHz, 0},
};

#define SENSORS_TABLE(slug) {slug, nullptr, 0, nullptr, 0}
#define SENSORS_FACTS(slug, bands, facts) {slug, bands, sizeof(bands) / sizeof(bands[0]), facts, sizeof(facts) / sizeof(facts[0])}

// Instruments, by OSCAR slug. Every instrument a platform names must be here.
inline constexpr Instrument kInstruments[] = {
    SENSORS_TABLE("oli"), SENSORS_TABLE("tirs"), SENSORS_TABLE("msi_sentinel_2a"), SENSORS_TABLE("olci"), SENSORS_TABLE("slstr"),
    SENSORS_TABLE("modis"), SENSORS_TABLE("viirs"), SENSORS_TABLE("atms"), SENSORS_TABLE("abi"), SENSORS_TABLE("ahi"),
    SENSORS_TABLE("seviri"), SENSORS_TABLE("fci"),
    SENSORS_FACTS("sar_c_sentinel_1", kCBand, kSentinel1),
    SENSORS_FACTS("sar_x", kXBand, kXSar),
    SENSORS_FACTS("sar_x_paz_seosar", kXBand, kXSar),
    SENSORS_FACTS("iceye_sar", kXBand, kXSar),
    SENSORS_FACTS("capella_sar", kXBand, kXSar),
    SENSORS_FACTS("umbra_sar", kUmbraBand, kUmbra),
    SENSORS_FACTS("sar_l_nisar", kLBand, kNisarL),
    SENSORS_FACTS("sar_s_nisar", kSBand, kNisarS),
    SENSORS_FACTS("sral", kSral, kSralFacts),
    SENSORS_FACTS("mwr_sentinel_3", kMwr, kMwrFacts),
};

// Platforms. norad is checked against the SATCAT row and OSCAR's launch date (module.cpp, join()).
inline constexpr Platform kPlatforms[] = {
    {"landsat_8", 39084, nullptr, {"oli", "tirs"}},
    {"landsat_9", 49260, nullptr, {"oli", "tirs"}},
    {"sentinel_1a", 39634, nullptr, {"sar_c_sentinel_1"}},
    {"sentinel_1b", 41456, nullptr, {"sar_c_sentinel_1"}},
    {"sentinel_1c", 62261, nullptr, {"sar_c_sentinel_1"}},
    {"sentinel_1d", 66315, nullptr, {"sar_c_sentinel_1"}},
    {"sentinel_2a", 40697, nullptr, {"msi_sentinel_2a"}},
    {"sentinel_2b", 42063, nullptr, {"msi_sentinel_2a"}},
    {"sentinel_2c", 60989, nullptr, {"msi_sentinel_2a"}},
    {"sentinel_3a", 41335, nullptr, {"olci", "slstr", "sral", "mwr_sentinel_3"}},
    {"sentinel_3b", 43437, nullptr, {"olci", "slstr", "sral", "mwr_sentinel_3"}},
    {"sentinel_3c", 100690, nullptr, {"olci", "slstr", "sral", "mwr_sentinel_3"}},
    {"terra", 25994, nullptr, {"modis"}},
    {"aqua", 27424, nullptr, {"modis"}},
    {"snpp", 37849, nullptr, {"viirs", "atms"}},
    {"noaa_20", 43013, nullptr, {"viirs", "atms"}},
    {"noaa_21", 54234, nullptr, {"viirs", "atms"}},
    {"goes_16", 41866, nullptr, {"abi"}},
    {"goes_17", 43226, nullptr, {"abi"}},
    {"goes_18", 51850, nullptr, {"abi"}},
    {"goes_19", 60133, nullptr, {"abi"}},
    {"himawari_8", 40267, nullptr, {"ahi"}},
    {"himawari_9", 41836, nullptr, {"ahi"}},
    {"meteosat_10", 38552, nullptr, {"seviri"}},
    {"meteosat_11", 40732, nullptr, {"seviri"}},
    {"meteosat_12", 54743, nullptr, {"fci"}},
    {"terrasar_x", 31698, nullptr, {"sar_x"}},
    {"tandem_x", 36605, nullptr, {"sar_x"}},
    {"seosar_paz", 43215, nullptr, {"sar_x_paz_seosar"}},
    {"nisar", 65053, nullptr, {"sar_l_nisar", "sar_s_nisar"}},
    {"iceye", 0, "ICEYE-", {"iceye_sar"}},
    {"capella", 0, "CAPELLA-", {"capella_sar"}},
    {"umbra", 0, "UMBRA-", {"umbra_sar"}},
};

// ---- Ground sensors: a MediaWiki page (CC BY-SA 4.0), the $SIT it stands at, and the facts read from the page's text.
struct Ground {
  const char* id;            // SENSOR_ID suffix
  const char* site_id;       // $SIT.ID (target-models-data-repo data/sit_collection.json)
  const char* page;          // en.wikipedia.org page title
  const char* name;
  const BandSpec* bands;
  size_t band_count;
  const Fact* facts;
  size_t fact_count;
};

constexpr double kType_AESA = 3, kType_PESA = 4, kType_OPTICAL = 16;  // SensorType wire values, checked against the generated enum
constexpr double kActive = 1;                                          // snrEmissionMode::ACTIVE

inline constexpr BandSpec kFps85Bands[] = {{"UHF", "UHF", "in the UHF band"}};
inline constexpr Fact kFps85[] = {
    {Field::Type, 0, "Each antenna element receives power from a separate transmitter module", nullptr, 0, kType_AESA},
    {Field::BandCenterHz, 0, "operates at a frequency of 442 MHz", "442", kMHz, 0},
    {Field::BandWidthHz, 0, "with a 10 MHz bandwidth", "10", kMHz, 0},
    {Field::RfBandwidthHz, 0, "with a 10 MHz bandwidth", "10", kMHz, 0},
    {Field::RfPeakPowerW, 0, "a peak output power of 32 megawatts", "32", 1e6, 0},
    {Field::BoresightAzDeg, 0, "pointing south at an elevation angle of 45\xC2\xB0", nullptr, 0, 180},
    {Field::BoresightElDeg, 0, "pointing south at an elevation angle of 45\xC2\xB0", "45", 1, 0},
    {Field::PointingFixed, 0, "is steered electronically without moving the fixed antenna", nullptr, 0, 1},
    {Field::ElLimitMinDeg, 0, "an elevation range from the horizon to 15\xC2\xB0 past the zenith", nullptr, 0, 0},
    {Field::ConeHalfAngleDeg, 0, "deflected up to 60\xC2\xB0 from its central boresight axis", "60", 1, 0},
    {Field::MaxRangeM, 0, "22,000 nautical miles (41,000 km) from Earth", "41,000", 1e3, 0},
};
inline constexpr BandSpec kParcsBands[] = {{"UHF", "UHF", "the decision was made to move to UHF frequencies"}};
inline constexpr Fact kParcs[] = {
    {Field::Type, 0, "passive electronically scanned array radar system", nullptr, 0, kType_PESA},
    {Field::MaxRangeM, 0, "ranges up to 2,000 miles (3,200 km)", "3,200", 1e3, 0},
};
inline constexpr BandSpec kMillstoneBands[] = {{"UHF", "UHF", "primarily used as a UHF radar antenna"}};
inline constexpr Fact kMillstone[] = {{Field::Emission, 0, "primarily used as a UHF radar antenna", nullptr, 0, kActive}};
inline constexpr BandSpec kAltairBands[] = {{"VHF", "VHF", "tracking and signature collection at VHF and UHF"}, {"UHF", "UHF", "tracking and signature collection at VHF and UHF"}};
inline constexpr Fact kAltair[] = {{Field::Emission, 0, "high-sensitivity, wide-bandwidth, coherent, instrumentation and tracking radar", nullptr, 0, kActive}};
inline constexpr BandSpec kGlobusS[] = {{"S-band", "S", "an S-band solid state phased array"}};
inline constexpr Fact kGlobusSF[] = {{Field::Emission, 0, "dual band ground-based radar system", nullptr, 0, kActive}};
inline constexpr BandSpec kGlobusX[] = {{"X-band", "X", "an X-band dish antenna"}};
inline constexpr Fact kGlobusXF[] = {{Field::Emission, 0, "dual band ground-based radar system", nullptr, 0, kActive}};
inline constexpr Fact kAeos[] = {
    {Field::Type, 0, "The 3.67-meter telescope, known as the Advanced Electro-Optical System (AEOS)", nullptr, 0, kType_OPTICAL},
    {Field::ApertureM, 0, "The 3.67-meter telescope, known as the Advanced Electro-Optical System (AEOS)", "3.67", 1, 0},
};
inline constexpr BandSpec kMotifBands[] = {{"LWIR", "LWIR", "primarily for Long Wave infrared (LWIR)"}};
inline constexpr Fact kMotif[] = {
    {Field::Type, 0, "The system consists of two 1.2-meter telescopes on a common mount", nullptr, 0, kType_OPTICAL},
    {Field::ApertureM, 0, "The system consists of two 1.2-meter telescopes on a common mount", "1.2", 1, 0},
};
inline constexpr Fact kMsss16[] = {
    {Field::Type, 0, "a 1.6-meter telescope that performs day and night tracking and imaging", nullptr, 0, kType_OPTICAL},
    {Field::ApertureM, 0, "a 1.6-meter telescope that performs day and night tracking and imaging", "1.6", 1, 0},
};

#define SENSORS_GROUND(id, site, page, name, bands, facts) {id, site, page, name, bands, sizeof(bands) / sizeof(bands[0]), facts, sizeof(facts) / sizeof(facts[0])}
#define SENSORS_GROUND_NOBANDS(id, site, page, name, facts) {id, site, page, name, nullptr, 0, facts, sizeof(facts) / sizeof(facts[0])}

inline constexpr Ground kGround[] = {
    SENSORS_GROUND("an-fps-85", "3a24a663", "AN/FPS-85", "AN/FPS-85 phased-array radar", kFps85Bands, kFps85),
    SENSORS_GROUND("an-fpq-16-parcs", "76433a1e", "AN/FPQ-16 PARCS", "AN/FPQ-16 PARCS", kParcsBands, kParcs),
    SENSORS_GROUND("millstone-misa", "a9d2c4a0", "Millstone Hill", "Millstone Hill Steerable Antenna (MISA)", kMillstoneBands, kMillstone),
    SENSORS_GROUND("altair", "3c913198", "ARPA Long-Range Tracking And Instrumentation Radar", "ALTAIR", kAltairBands, kAltair),
    SENSORS_GROUND("globus-s-band", "a8fe5809", "GLOBUS", "GLOBUS S-band sensor", kGlobusS, kGlobusSF),
    SENSORS_GROUND("globus-x-band", "a8fe5809", "GLOBUS", "GLOBUS X-band sensor", kGlobusX, kGlobusXF),
    SENSORS_GROUND_NOBANDS("aeos", "4b5cefa0", "Maui Space Surveillance Complex", "AEOS 3.67 m telescope", kAeos),
    SENSORS_GROUND("motif", "4b5cefa0", "Maui Space Surveillance Complex", "MOTIF 1.2 m telescopes", kMotifBands, kMotif),
    SENSORS_GROUND_NOBANDS("msss-1-6m", "4b5cefa0", "Maui Space Surveillance Complex", "MSSS 1.6 m telescope", kMsss16),
};

}  // namespace roster
