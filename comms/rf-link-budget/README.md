# rf-link-budget

Friis link-budget orchestrator. Composes per-model loss values from the
other comms/ modules into the standard transmission budget plus kTB
noise, SNR, **corrected Eb/N0**, Shannon channel capacity, and link
margin.

Phase 4 Wave E of the RF audit. Depends on Waves A–D (each model
contributes a per-loss number; this module sums them). The host
orchestrates by calling each module first then handing the composed
losses to `compute_link_budget`.

## Why this module fixes the Eb/N0 bug

The audit identified a bug at
[`RfCommsCore.js:2872`](../../../../../packages/engine/Source/Core/RfCommsCore.js):

```js
result.ebno = result.snr;     // wrong unless bandwidth == symbol rate
```

The correct relation per Sklar §4 Eq. 4.27 is:

```
Eb/N0 = SNR + 10 · log10(B / R_b)
```

where `B` is the channel bandwidth and `R_b` is the symbol/bit rate.
This module's `compute_link_budget` requires both inputs and computes
the correct value. For backwards compatibility, hosts may pass
`symbol_rate_hz = bandwidth_hz` to recover the legacy buggy
`Eb/N0 = SNR` identity.

## Exported kernels

| C entry | Form |
| --- | --- |
| `rf_link_eirp_dbw(P_W, G_t, L_t)` | `10·log10(P) + G_t − L_t` |
| `rf_link_noise_power_dbw(T_K, B_Hz, NF_dB)` | `10·log10(k·T·B·F)` |
| `rf_link_free_space_loss_db(R_m, f_Hz)` | Friis FSPL (self-contained) |
| `rf_link_ebno_db(SNR, B_Hz, R_b_Hz)` | **Sklar Eq. 4.27 fix** |
| `rf_link_capacity_bps(B_Hz, SNR_dB)` | Shannon capacity |
| `rf_link_budget_compute(...)` | Composed orchestrator → 96-byte struct |

## Result-buffer layout (96 bytes, matches legacy `CommsPlugin`)

```text
offset 0   double eirp_dbw
offset 8   double free_space_loss_db
offset 16  double total_path_loss_db
offset 24  double received_power_dbw
offset 32  double noise_power_dbw
offset 40  double snr_db
offset 48  double ebno_db                  ← FIXED (uses Sklar Eq. 4.27)
offset 56  double capacity_bps
offset 64  double link_margin_db
offset 72  double atmospheric_loss_db_echo
offset 80  double rain_loss_db_echo
offset 88  uint32 flags  (LINK_UP, BER_OK, MARGIN_OK, RAIN_FADE, ATMO_EFFECTS)
offset 92  uint32 reserved
```

## Authority

| Form | Authority |
| --- | --- |
| EIRP / received power | Pratt 4e §4.2 |
| kTB noise | Johnson 1928 / Nyquist 1928; Pratt 4e §4.4 |
| Eb/N0 = SNR + 10·log10(B/R_b) | **Sklar 2e Eq. 4.27** |
| Channel capacity | Shannon 1948 Eq. (16); Sklar Eq. 9.16 |

## Status

Skeleton complete; build verification, fixture vectors (the existing
`authoritativeRfVectors.js` `friis_ktb_1km_1ghz_1mhz` vector becomes a
canonical fixture once its `ebno: 70.527…` value is recomputed against
`Eb/N0 = SNR + 10·log10(B/R_b)`), and orbpro-integration registration
pending. Once those land, `RfCommsCore.calculateLinkBudget` becomes a
thin proxy (Phase 5).
