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

## CelesTrak SupGP reference rows

The overlap-object fixtures (Starlink 67850/67851, ISS 25544, GLONASS 32393) draw
their orbital elements from the checked-in **CelesTrak SupGP** reference CSVs at
`analysis/od/tests/data/supgp-reference/<provider>/…csv` (read-only; captured
2026-07-13 via the space-data-network-02 reader proxy, per the A2.4 progress
notes). Winner epochs equal the reference epoch so the element-space diff is
epoch-aligned.
