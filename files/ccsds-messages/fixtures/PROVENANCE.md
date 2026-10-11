# Fixture provenance: CCSDS example messages

**Synthetic.** The five files here have the structure, keywords and quirks of the
annex examples of CCSDS 504.0-B-2 (Attitude Data Messages, Figures G-4 and G-5)
and CCSDS 503.0-B-2 Cor. 1 (Tracking Data Message, Figures E-16, E-17 and E-18),
with invented spacecraft, stations, originators, times and numbers. The Blue
Books state no terms for reproducing their annex examples, so none is kept in
this tree. `make-synthetic.mjs` writes them (seeded; rerun in place).

The file names keep the figure they follow, because that is the layout each
exercises:

| File | Layout of | Contents |
| --- | --- | --- |
| `ccsds-504.0-B-2-figure-G-4-aem.txt` | 504.0-B-2 Annex G2, Figure G-4 | Two-segment AEM, `ATTITUDE_TYPE = QUATERNION`, `INTERPOLATION_METHOD = hermite`, degree 7. **Non-uniform epochs**: the first segment steps 2336.3 s, then 1 s, then 98398 s. |
| `ccsds-504.0-B-2-figure-G-5-aem-spinner.txt` | 504.0-B-2 Annex G2, Figure G-5 | Single-segment AEM, `ATTITUDE_TYPE = SPIN`, uniform 0.125 s step, day-of-year epochs, a `COMMENT` inside the data block. |
| `ccsds-503.0-B-2-figure-E-16-tdm-optical.txt` | 503.0-B-2 Cor.1 Annex E, Figure E-16 | Two-segment TDM, ground-based optical, `ANGLE_TYPE = RADEC`, `MAG` observable. |
| `ccsds-503.0-B-2-figure-E-17-tdm-radar.txt` | 503.0-B-2 Cor.1 Annex E, Figure E-17 | Ground-based radar with `RANGE`, `ANGLE_1/2`, `CARRIER_POWER`, `RCS`, `RANGE_UNITS`, `CORRECTION_RANGE`, `EPHEMERIS_NAME`. The last `RCS` line repeats an **earlier** epoch than the line above it, as the book's example does: an observation model built on a uniform grid cannot represent it. |
| `ccsds-503.0-B-2-figure-E-18-tdm-phase.txt` | 503.0-B-2 Cor.1 Annex E, Figure E-18 | Two-segment TDM, `TRANSMIT_PHASE_CT_1` / `RECEIVE_PHASE_CT_1`, `FREQ_OFFSET`, `INTERPOLATION`/`INTERPOLATION_DEGREE`, `MESSAGE_ID`. |

The books' keyword corpus is what the format specification says; the module
reads every keyword the specification defines, not only these.

## `ndm/` and the NDM/XML twins

**Synthetic.** `ndm/ndm-*.kvn` are messages in the layout of the Blue Books for the
OMM, OEM, OPM and OCM (502.0-B-3), the CDM (508.0-B-1), the RDM (508.1-B-1) and the
APM and ACM (504.0-B-2), with invented objects, agencies, times and numbers (the
covariance, state and CDM numbers are made up; none is a measurement). The Blue
Books state no terms for reproducing their annex examples, so none is kept in this
tree. Between them they hold every kind of block, repetition and choice a message
can state: SGP4 and SGP4-XP mean elements (BTERM and AGOM in place of BSTAR and
MEAN_MOTION_DDOT), two OEM segments with two covariance matrices in one
COVARIANCE_START block, two OPM maneuvers, an OCM with trajectory, physical,
covariance, maneuver, perturbation, determination and user-defined blocks, a CDM
with a 45-cell and a 21-cell covariance, an APM with every attitude block, an ACM
with every block and two sensors, and an RDM prediction.

Each message has an NDM/XML twin, written by the module itself
(`make-ndm-xml.mjs`, after `npm run build`) and kept only because an independent
validator accepted it: `tests/ndm_xsd.test.mjs` runs `xmllint` against the NDM/XML
4.0.0 schemas. The AEM and TDM figures have twins too (`*.xml` beside the `.txt`),
except Figure E-16: its `CREATION_DATE` has no seconds, which the schema's time
pattern does not accept, and the module states an epoch exactly as the file wrote
it, so a twin of it would not validate.

The schemas (`ndmxml-4.0.0-*.xsd`, SANA registry) are not redistributed. The test
reads them from `$SDN_MODULES_PRIVATE_FIXTURES/files/ccsds-messages/fixtures/xsd/`
(`tests/lib/privateFixtures.mjs`) and skips, saying so, without them.

## `real/`

**Real messages, redistributable.** Byte-for-byte copies of fixtures already in this
repository, kept here so the codec is measured on what producers actually write:

| File | What | Terms |
| --- | --- | --- |
| `tracss-04208.ocm`, `tracss-39417.ocm`, `tracss-60094.ocm` | OCMs from the TraCSS "Dataset for Conjunction Assessment Verification" (The Aerospace Corporation / NOAA Office of Space Commerce), trimmed to nine or ten ephemeris nodes by `analysis/conjunction-assessment/tests/fixtures/aerospace-real-window/` (`tests/ndm_real_data.test.mjs` reads and writes all 42 files there the same way when this tree is whole) | CC0 1.0 |
| `nasa-iss.oem` | NASA's public ISS OEM (`ISS_OEM/ISS.OEM_J2K_EPH.txt`, retrieved 2026-07-13), trimmed to its first twelve hours by `analysis/od/tests/data/supgp-reference/iss/` | U.S. Government work, public domain |

What they show that the synthetic messages cannot: TraCSS states its version as
`CCSDS_OCM_VERS = 502.0-B-3` and `TRAJ_BASIS = OPERATIONAL`, which the standard's
enumeration does not have; the module reads both, keeps the second as it is, and so the
NDM/XML it writes for them fails the schema on that one element (and only that one).

## Corpus statistics

Counted from the annex regions of the books (when this module was written, 2026-08-30):

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
`org.orekit.files.ccsds.ndm.tdm.TdmParser`) is the second reader for messages of
these layouts.
