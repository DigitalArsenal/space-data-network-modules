// -----------------------------------------------------------------------------
// The library's own density-table values where they differ from the printed
// SR 313 Table 6 (j70_table6.inc stays the source of truth). Observed black-box
// (coordinator ruling 2026-10-24): raising or lowering each listed entry by
// 0.001 makes the named side-A spec vector exact (n-dot to 5e-9 or better)
// without moving any other drag vector of sections 3, 3.2, 3.5, 3.6 and 3.7.
// SGP4XP only; SDN-AP and every other use of the table read the printed values. Seven earlier entries (125/1150,
// 290/900, 300/1150, 320/1200, 360/1150, 370/1000, 420/1150) were slips of this transcription, now corrected in
// j70_table6.inc (side A's 3.11 row probes: the library holds the printed values there).
// Heights km, temperatures K, log10 densities in thousandths.
// -----------------------------------------------------------------------------
struct J70Override {
  int16_t h, T;
  int16_t printed, library;
  const char* vector;
};
inline constexpr J70Override kJ70LibraryOverrides[] = {
    {92, 650, -8620, -8619, "3.7 2009 d83.6 92 km and 2019 d266 92 km (with 92/700-800 K, 94/700 K)"},
    {92, 700, -8620, -8619, "3.7 2009 d83.6 92 km and 2019 d266 92 km"},
    {92, 750, -8620, -8619, "3.7 2009 d83.6 92 km and 2019 d266 92 km"},
    {92, 800, -8620, -8619, "3.7 2009 d83.6 92 km and 2019 d266 92 km"},
    {94, 700, -8780, -8779, "3.7 2009 d83.6 92 km"},
    {125, 850, -10880, -10879, "3.7 2019 d266 120 km"},
    {130, 650, -11130, -11129, "3.7 2019 d266 130 km and 2009 d83.6 130 km"},
    {160, 1100, -11860, -11859, "3.9 2026 d282.5 and d292.5 160 km, node right ascensions 0, 90, 180, 270 (SPEC amendment 2)"},
    {320, 1250, -13570, -13569, "3.5 2024 d100.5 hp 300 km e 0.0001 i 97.5; 3.6 perigee-latitude w 0"},
    {330, 1350, -13570, -13569, "3.5 1990 d180.5 hp 250 km e 0.05 i 0.1"},
    {360, 800, -14550, -14549, "3.5 2009 d120.5 hp 250 km e 0.1 i 63.4"},
    {370, 750, -14780, -14779, "3.5 2009 d120.5 hp 300 km e 0.01 i 51.6"},
    {380, 750, -14880, -14879, "3.5 2009 d120.5 hp 350 km e 0.0001 i 97.5"},
    {380, 850, -14620, -14619, "3.5 2009 d120.5 hp 350 km e 0.01 i 51.6"},
    {500, 700, -16200, -16199, "3.7 2019 d266 500 km and 2009 d83.6 500 km; 3 2009 500 km"},
    {740, 900, -16971, -16970, "3.5 2014 d120.5 hp 600 km e 0.01 i 51.6"},
    {1600, 700, -18699, -18700, "3.5 2009 d120.5 hp 700 km e 0.1 i 63.4"},
};
