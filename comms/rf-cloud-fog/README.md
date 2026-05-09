# rf-cloud-fog

Cloud / fog liquid-water absorption — ITU-R P.840-9 Annex 1 §1
double-Debye permittivity for liquid water. Two exported kernels:

- `rf_cloud_specific_attenuation_coeff(f_GHz, T_C)` — mass-specific
  attenuation coefficient `K_l` in dB/(km · g/m³).
- `rf_cloud_attenuation_db(f_GHz, T_C, ρ_g_per_m3, path_km)` — total
  slant-path attenuation `A = K_l · ρ · path_km` in dB.

Phase 4 Wave B of the RF audit. Constants ported verbatim from
`RfCommsCore.js:4911-4935` (which itself follows the published P.840
form).

## Authority

ITU-R P.840-9 Annex 1 §1, double-Debye dispersion form for liquid
water. Constants 77.66, 103.3, 0.0671, 3.52, 20.2, 146.0, 316.0, 39.8,
0.819 match P.840-9 Annex 1 to first-order rounding.

## Status

Skeleton complete; build verification + orbpro-integration registration
pending. Phase 2 of the audit replaces the constants with values
transcribed verbatim from ITU-R P.840-9 Annex 1 (the current values
match the published form to the precision the JS port preserves).
