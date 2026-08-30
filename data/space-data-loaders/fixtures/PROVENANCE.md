# EOP fixture provenance

## `finals2000A.daily`

The IERS Rapid Service / Prediction Centre's daily Earth-orientation file, as
published — not a reconstruction, not a sample, and not edited in any way.

| | |
| --- | --- |
| Source | `https://maia.usno.navy.mil/ser7/finals2000A.daily` (mirrored at `https://datacenter.iers.org/products/eop/rapid/daily/finals2000A.daily`, byte-identical on retrieval) |
| Retrieved | 2026-08-29 UTC |
| SHA-256 | `9a496d8ea6a2efb84d5a10bee7ff5dd036bd3a6d5f23d6e092170e4303788bc2` |
| Rows | 181 (MJD 61192 .. 61372) |
| Format | IERS `finals2000A` fixed-column, described in the IERS "readme.finals2000A" |

**Why it is vendored.** The acceptance for
`gmat-08-frames-and-state-representations` is that interpolated dUT1 and polar
motion agree with the **published** values at the table nodes to 1e-9 s and
1e-9 arcsec. A test that fetched this file at run time would measure a moving
target and would fail offline; a test against numbers typed by hand would not be
measuring the published values at all. So the published bytes are committed, and
their hash is recorded here and asserted by the suite.

**Refreshing it.** Re-fetch from the source above, update the SHA-256 and the
row range in this table, and re-run `npm test`. The tests read the node values
out of this file rather than carrying copies of them, so a refresh needs no
expectation edits.
