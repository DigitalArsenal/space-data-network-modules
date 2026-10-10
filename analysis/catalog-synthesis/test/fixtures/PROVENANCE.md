# Fixture provenance

## `spacetrack-gp-current-sample.json`

**Synthetic.** Three records shaped like a Space-Track `class/gp` response
(schema-exact CCSDS OMM v3.0 JSON keys) for VANGUARD 1 (NORAD 5), VANGUARD 2
(NORAD 11) and VANGUARD R/B (NORAD 12). Identity and epochs are kept so the
precedence cases have something to order; the element values are invented,
ORIGINATOR is "SYNTHETIC", and nothing in the file comes from Space-Track.
(The earlier real trimmed response was removed from this repository's history
on 2026-10-09: Space-Track data is not redistributed.)

The catalog-synthesis test encodes these gp rows into `$OMM` **FlatBuffer**
records via the SDS OMM binding — the same on-the-wire form the Go current-gp
ingest lane (`internal/ingest/spacetrack_supplemental.go` → `ingestGPRows` →
`sds.NewOMMBuilder` → `store.StoreWithSourceTags`) produces when it stores
Space-Track GP, tagged `SourceName="spacetrack-gp"`, `ProviderID="space-track"`.

## `reference-elements.csv`

**Synthetic.** Four element rows in the layout of a CelesTrak SupGP CSV: the
first two objects of the Starlink-style suite
(`analysis/od/tests/data/supgp-reference/starlink`), an ISS-like row (NORAD
25544) and a GLONASS-like row (NORAD 32393). Catalog numbers and designators are
kept so the precedence cases have identities to order; every element value is
invented. Written by `analysis/od/scripts/synthetic-fixtures.mjs`. The overlap
objects' winner epochs equal the row epochs so the element-space diff is
epoch-aligned.
