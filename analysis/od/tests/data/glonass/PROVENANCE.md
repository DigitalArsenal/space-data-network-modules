# GLONASS SP3 fixture — provenance (A2.4-prereq OD test data)

## `iac_glonass.sp3.glo`

A verbatim copy of the GLONASS data-source adapter's checked-in fixture
(`data-source/glonass-source/test/fixtures/iac_glonass.sp3.glo`), copied here so
the OD frame/time/position-only tests own their input under `analysis/od/`
(the adapter fixtures are read-only to this worker).

- **Upstream:** IAC (Information-Analytical Center for PNT, Russia) GLONASS-only
  **precise SP3-d** rapid product, anonymous FTP
  `ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/26192/rapid/Sta24266.sp3.glo`
  (retrieved 2026-07-13; full file 96 epochs at 900 s over 24 h, 25 satellites
  R01–R24 + R26). This fixture is the adapter's TRIM: the full 22-line SP3-d
  header (epoch-count field updated 96→3 for self-consistency) + the first 3
  epoch blocks (3 × 25 = 75 `P` records) + the `EOF` terminator. No values
  altered. See the adapter's own `PROVENANCE.md` for full retrieval evidence.

### What the OD tests use it for

- **Frame:** header line 1 cols 47–51 declare **`IGS20`** (the IGS realization of
  ITRF2020) — an Earth-fixed (ECEF) frame. `od::classify_frame("IGS20")` →
  `FrameKind::Ecef`; the OD side rotates ECEF→TEME via `od::ecef_to_teme` (GMST).
- **Time:** `%c` line cols 10–12 declare **`GPS`** system time. The OD side maps
  GPS→UTC via `od::gps_jd_to_utc` (leap table, currently GPS = UTC + 18 s).
- **Representation:** position-only (`P` records, no `V`) → `STATE_VECTOR_SIZE 3`;
  the fit seeds velocity from the positions (documented finite-difference
  initializer), never fabricates it.

The native test `tests/test_frame_time_fit.cpp` parses satellite **R03** (clean
positions and clocks across all three epochs) from this file, transforms
ECEF(IGS20)/GPS → TEME/UTC, and fits SGP4 position-only. Expected credible
GLONASS elements: a ≈ 25510 km, e ≈ 0, i ≈ 64.8° (measured ~65.3° for this
short 3-epoch arc / this satellite), period ≈ 11.26 h.

**NOTE (short arc):** the trimmed fixture is only 3 epochs (30 min); a full IAC
SP3 has 96 epochs (24 h). Three position vectors 900 s apart still determine a
2-body orbit (Gibbs-equivalent), so the recovered elements are credible, but the
fit RMS over a 3-point arc is near-exact by construction and not a
parity-strength RMS.
