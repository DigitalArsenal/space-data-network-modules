# Fixture provenance — CCSDS message examples

Every file here is a **published** example message, extracted verbatim from the
CCSDS Blue Book that publishes it. Nothing here was authored by us, and nothing
here is a transcription from memory.

## Premise correction (2026-08-30)

The task body names **CCSDS 504.0-B-1** (AEM) and **CCSDS 503.0-B-1** (TDM).
Both are superseded and `public.ccsds.org` no longer serves them:

```
https://public.ccsds.org/Pubs/504x0b1c1.pdf  -> 404
https://public.ccsds.org/Pubs/504x0b1.pdf    -> 404
https://public.ccsds.org/Pubs/503x0b1.pdf    -> 404
https://public.ccsds.org/Pubs/503x0b2.pdf    -> 404
```

The published Blue Books are:

| Book | Title | Issue | File served |
| --- | --- | --- | --- |
| CCSDS 504.0-B-2 | Attitude Data Messages | January 2024 | `504x0b2.pdf` |
| CCSDS 503.0-B-2 Cor. 1 | Tracking Data Message | June 2020 | `503x0b2c1.pdf` |
| CCSDS 502.0-B-3 Errata 1 | Orbit Data Messages | — | `502x0b3e1.pdf` |

B-2 supersedes B-1 in both cases and its annex examples are the published
examples. The message version keyword therefore reads `2.0`, not `1.0`, and
the AEM examples carry keywords B-1 did not define. Verified 2026-08-30.

## Extraction

The PDFs were downloaded from `https://public.ccsds.org/Pubs/<file>` and their
text layer extracted with `pypdf`. Extraction removed only page furniture —
the running header (`CCSDS RECOMMENDED STANDARD FOR ...`), the page footer
(`CCSDS 5xx.0-B-2 Page X-N <month year>`), the figure caption line, and the
book's own `< intervening data records omitted here >` ellipsis marker. **No
keyword, value or data line was altered, reordered or reformatted**, which is
what makes these admissible for a round-trip assertion: the whitespace and
alignment are the book's.

The ellipsis removal is the one place a fixture differs from the printed page,
and it is load-bearing to say why: the book prints an ellipsis where it omitted
records for space, so the remaining records are still exactly the book's, but
the file is not a contiguous ephemeris. Nothing here asserts continuity.

## Files

| File | Source | Contents |
| --- | --- | --- |
| `ccsds-504.0-B-2-figure-G-4-aem.txt` | 504.0-B-2 Annex G2, Figure G-4 | Two-segment AEM, Mars Global Surveyor, `ATTITUDE_TYPE = QUATERNION`, `INTERPOLATION_METHOD = hermite`, degree 7. **Non-uniform epochs** — the first segment steps 21:29:07.2555 → 22:08:03.5555 → 22:08:04.5555, i.e. 2336 s then 1 s. |
| `ccsds-504.0-B-2-figure-G-5-aem-spinner.txt` | 504.0-B-2 Annex G2, Figure G-5 | Single-segment AEM, ST5-224, `ATTITUDE_TYPE = SPIN`, uniform 0.125 s step, a `COMMENT` inside the data block. |
| `ccsds-503.0-B-2-figure-E-16-tdm-optical.txt` | 503.0-B-2 Cor.1 Annex E, Figure E-16 | Two-segment TDM, ground-based optical, `ANGLE_TYPE = RADEC`, `MAG` observable. |
| `ccsds-503.0-B-2-figure-E-17-tdm-radar.txt` | 503.0-B-2 Cor.1 Annex E, Figure E-17 | Ground-based radar with `RANGE`, `ANGLE_1/2`, `CARRIER_POWER`, `RCS`, `RANGE_UNITS`, `CORRECTION_RANGE`, `EPHEMERIS_NAME`. The last `RCS` line repeats an **earlier** epoch than the line above it — this is in the published book and is exactly why an observation model built on a uniform grid cannot represent real TDM. |
| `ccsds-503.0-B-2-figure-E-18-tdm-phase.txt` | 503.0-B-2 Cor.1 Annex E, Figure E-18 | Two-segment TDM, `TRANSMIT_PHASE_CT_1` / `RECEIVE_PHASE_CT_1`, `FREQ_OFFSET`, `INTERPOLATION`/`INTERPOLATION_DEGREE`, `MESSAGE_ID`. |

## Corpus statistics

Extracted programmatically from the annex regions, not by hand:

- **AEM Annex G2 — 22 distinct keywords**: `ATTITUDE_TYPE, CCSDS_AEM_VERS,
  CENTER_NAME, COMMENT, CREATION_DATE, DATA_START, DATA_STOP,
  INTERPOLATION_DEGREE, INTERPOLATION_METHOD, MESSAGE_ID, META_START,
  META_STOP, OBJECT_ID, OBJECT_NAME, ORIGINATOR, REF_FRAME_A, REF_FRAME_B,
  START_TIME, STOP_TIME, TIME_SYSTEM, USEABLE_START_TIME, USEABLE_STOP_TIME`.
- **TDM Annex E — 70 distinct keywords** across all 18 figures.

Both lists drove the `spacedatastandards` escalation
(`upstream-spacedatastandards-10`): at SDS 1.201.0 the `$AEM` and `$TDM`
records have no carrier for most of them, and both records reconstruct epochs
from a uniform `START_TIME + i*STEP_SIZE` grid that neither published format
uses.

## Independent cross-check

Orekit 13.1 (`org.orekit.files.ccsds.ndm.adm.aem.AemParser`,
`org.orekit.files.ccsds.ndm.tdm.TdmParser`) parses the same messages. Orekit's
own test resources carry transcriptions of these figures
(`src/test/resources/ccsds/adm/aem/AEMExample*.txt`,
`src/test/resources/ccsds/tdm/kvn/TDMExample*.txt`) — useful as a second
reader, but the fixtures here come from the Blue Book PDFs directly, because a
transcription is a copy and the book is the authority.
