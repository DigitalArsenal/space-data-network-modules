# GLONASS adapter test fixtures — provenance

These fixtures drive the offline, mock-host integration test
(`test/module.test.mjs`). No live network is touched by the test. Because
`SOURCE_SHA256` provenance binds to the raw bytes the adapter fetched, the test
independently SHA-256s the trimmed fixture and asserts equality with the
adapter's `SOURCE_SHA256` (the mock host serves these exact bytes).

## `synthetic_glonass.sp3.glo`

**Synthetic.** A GLONASS-style precise ephemeris in SP3-d, written by
`analysis/od/scripts/synthetic-fixtures.mjs`; nothing in it comes from IAC or any
other centre. The real IAC product this stands in for
(`ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/.../rapid/Sta24266.sp3.glo`) publishes no
reuse terms, so no copy of it is kept in this tree.

- **Content:** 25 satellites (R01-R24, R26), 3 epochs at 900 s from
  2026-07-11T00:00:00 GPS time, 75 `P` records, CRLF line terminators. Each
  satellite is SGP4 truth (Vallado 2020-07-13, deep-space branch) from an invented
  element set (n about 2.131 rev/day, i about 64.8 deg, three planes 120 deg
  apart, eight slots a plane), written Earth-fixed by `propagate_state` of
  `propagator/sgp4` with the epochs shifted by the 18 s between GPS time and UTC.
  Clocks are invented. The header is written from the SP3-d description, with
  agency `SYN` and comments that say the file is synthetic.
- **Edge case kept:** `PR01` at the first epoch carries the SP3 absent-clock
  sentinel `999999.999999`. The adapter drops the clock (not orbital) and **keeps
  the position**: the test asserts R01 still has 3 states.

### Frame / time (as declared in the file header — a mission correction)

The A2.2c-2 packet expected "PZ-90.11 ECEF state vectors". The IAC precise SP3
products declare, and the synthetic file's header follows them:

- **Coordinate system (line 1, cols 47–51): `IGS20`** — the IGS realization of
  ITRF2020. **NOT PZ-90.11.**
- **Time system (`%c` line, cols 10–12): `GPS`** — GPS system time. **NOT
  GLONASS time / UTC(SU).**
- Orbit type `FIT`, agency `SYN` (the real product's is `IAC`).

PZ-90.11 / GLONASS-time is the frame of the GLONASS **broadcast navigation
message** — a *different* product. IAC, as a full multi-GNSS IGS Analysis Center
(AC code "IAC"), publishes its **precise** orbits in standard IGS conventions
(IGS20 / GPS time) for interoperability. The adapter **preserves what the file
declares** (`REFERENCE_FRAME = IGS20`, `TIME_SYSTEM = GPS`) and does not relabel
to PZ-90.11 or transform frames — the OD module owns any transform (A2.2a).

### Representation: position-only

Every IAC SP3 sampled when this adapter was written (and the CODE/GFZ MGEX
products cross-checked) was **position-only** — `P` records, no `V`/velocity records. The adapter emits a
verbose OEM with `STATE_VECTOR_SIZE = 3` and `X`/`Y`/`Z` only. **No velocity is
fabricated** (e.g. by finite-differencing).

## `supgp-reference-draft/`

A2.4 seed: the CelesTrak SupGP (`sup-gp.php?SOURCE=GLONASS-RE`) same-epoch
reference pair could NOT be captured (celestrak.org **timed out / unreachable**
from this env, matching A2.1). A `provider.json` DRAFT + README with the exact
query and the parity plan (including the OD-side frame/time prerequisites) are
checked in there.

## Live source note (transport)

`glonass-iac.ru` **HTTPS** was returning `502 Bad Gateway` at capture time; the
live products are on the IAC **anonymous FTP** server (`ftp.glonass-iac.ru`,
reachable, `226`). The adapter's default `sourceUrl` therefore points at the FTP
`LATEST/Final.sp3`; whether the host `http` capability can fetch `ftp://` is a
host-transport concern flagged in the adapter README (OWNER-ASSIST).
