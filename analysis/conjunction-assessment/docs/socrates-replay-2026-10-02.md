# SOCRATES controlled replay, 2026-10-02

The top 300 rows of SOCRATES `sort-maxProb.csv` reassessed by this module from
the exact GP editions SOCRATES used. Data:
[`socrates-replay-2026-10-02.json`](socrates-replay-2026-10-02.json). Script:
`scripts/socrates-controlled-replay.mjs --top 300 --via space-data-network-02`.

## Inputs

| Item | Value |
| --- | --- |
| Report | `https://celestrak.org/SOCRATES/sort-maxProb.csv`, 179,398 rows, sha256 `4164674599899b63e6840f8629976cf6b88c706f0bd5c32e34c406d85bc56261` |
| GP inputs | `SOCRATES/data.php?CATNR=a,b&FORMAT=json` per pair; sha256 of each response in the JSON (`gpSha256`) |
| Acquisition | through the celestrak.eth node (host-02), serial, 2.5 s apart, ledger-checked (3-hour rule) |
| Rows | 300 replayed, 0 errors; 233 distinct pairs |

## Settings

| Setting | This replay | SOCRATES |
| --- | --- | --- |
| Propagator | SGP4 (WGS-72) on the delivered GP records | SGP4 via STK/CAT |
| Search | reported TCA ± 600 s, 5 s coarse step, 1 ms tolerance | not published |
| Maximum probability | ALFANO_MAXIMUM, radii 5 m + 5 m | object radii not published |
| Dilution threshold | isotropic covariance: d/√2 | covariance shape not published |

## Results

The same element editions went in: the days since epoch agree within 0.0005 d,
which is the rounding of SOCRATES's three decimals. SOCRATES reports range to
1 m and speed to 1 m/s, so differences up to 0.5 m and 0.5 m/s are rounding.

| Group | Rows | \|ΔTCA\| median / p95 / max | \|Δmiss\| median / p95 / max | \|Δspeed\| max |
| --- | ---: | --- | --- | --- |
| Fast (> 10 m/s), both numbered < 100000 | 112 | 0.4 / 0.5 / 24 ms | 0.38 / 2.4 / 6.6 m | 0.49 m/s |
| Fast, one numbered ≥ 100000 | 126 | 0.4 / 4.2 / 7.6 ms | 0.58 / 20.8 / 60.9 m | 0.49 m/s |
| Slow (≤ 10 m/s): COSMOS 2581 × 2583 | 62 | 19 / 69 / 363 ms | 0.26 / 0.47 / 0.51 m | 0.50 m/s |

- **Geometry agrees.** TCA, range and speed match to SOCRATES's reported
  precision for the cataloged objects.
- **Objects numbered ≥ 100000.** These are mostly Starlink objects marked `[+]`.
  Every fast miss difference over 20 m (7 rows, 41–295 m misses) involves one
  of them. The epochs match, so the source of the difference is not visible in
  the published inputs.
- **Maximum probability is about 10× lower.** Ours is lower in 237 of 238 fast
  rows, by a median factor of 9.1 (10^0.957). Far from contact, maximum
  probability scales with the combined radius squared. Matching SOCRATES would
  need a combined radius of 30 m (median), against our 10 m: 17.6 m for the
  cataloged pairs and 32.7 m for the ≥ 100000 pairs. That is consistent with
  object-specific sizes, which SOCRATES does not publish.
- **Dilution thresholds use different covariance shapes.** SOCRATES's is
  0–0.74 × miss and ours is 0.707 × miss. Ours is the isotropic optimum; the
  covariance shape behind SOCRATES's is not published.
- **The slow pair is not comparable.** COSMOS 2581 and 2583 fly in formation
  at 0–5 m/s, with misses of 7–4510 m. Both computations assume a short-term
  encounter, which does not hold at these speeds. SOCRATES reports 0.0841 on
  every row; ours ranges from 1.8e-6 to 1.

The replay checks screening geometry against an independent implementation on
identical inputs. It does not check probability, because SOCRATES's radii and
covariance assumptions are unpublished.
