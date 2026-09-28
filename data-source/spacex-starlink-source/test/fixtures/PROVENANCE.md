# Starlink adapter test fixtures — provenance

These fixtures drive the offline, mock-host integration test
(`test/module.test.mjs`). No live network is touched by the test.

## `MANIFEST.sample.txt`

A 3-line sample of the SpaceX public ephemeris index
(`https://api.starlink.com/public-files/ephemerides/MANIFEST.txt`): one MEME
filename per line. The first two entries have matching trimmed MEME fixtures
below; the third (`MEME_99999_...`) has no fixture on purpose, to exercise the
per-object 404-skip path when the object cap is raised past 2.

## `meme/MEME_67850_*.txt`, `meme/MEME_67851_*.txt`

Real SpaceX Starlink MEME operator-ephemeris files, **trimmed to the first 12
state vectors** (4 header lines + 12 × [1 state row + 3 covariance rows]).

- **Upstream source:** `https://api.starlink.com/public-files/ephemerides/`
  (SpaceX Starlink public ephemerides, format `txt`, operator SpaceX,
  authentication none).
- **Captured via:** the checked-in OD reference suite
  (`analysis/od/tests/data/supgp-reference/starlink/meme/`, captured 2026-05-14;
  see that suite's `provider.json`). Copied and head-trimmed to 52 lines each so
  the canonical-record assertions stay small and byte-stable.
- **Frame note:** MEME state vectors are EME2000. The `UVW` line labels the
  *covariance* frame, not the state-vector frame — the adapter emits
  `REFERENCE_FRAME` `EME2000` accordingly, and analysis/od rotates the states
  to TEME for the fit. (A fit's own RMS cannot reveal a frame error; scoring
  CelesTrak SupGP on the fitted states does — see `test/module.test.mjs`.)
- **Filename fields:** `MEME_{NORAD}_{NAME}_{COSPAR-internal}_{Status}_{UnixTS}_UNCLASSIFIED.txt`.
  The 4th field is a SpaceX-internal id, NOT an international designator, so the
  adapter leaves `OBJECT_ID` unset (per A2.2a labeling rules).

The bytes are otherwise verbatim, so a test can independently SHA-256 a fixture
and assert it equals the adapter's `SOURCE_SHA256` provenance.
