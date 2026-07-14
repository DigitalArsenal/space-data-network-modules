# Fixture provenance

## `spacetrack-gp-current-sample.json`

Verbatim copy of the SDN repo fixture
`space-data-network/sdn-server/internal/ingest/testdata/spacetrack/gp-current-sample.json`
(read-only source; copied here so this module's test is self-contained).

Per that fixture's own `PROVENANCE.md`: a **real trimmed Space-Track**
`basicspacedata/query/class/gp` response, captured live **2026-07-13**
(`orderby NORAD_CAT_ID asc / limit 3`), ORIGINATOR **"18 SPCS"**, schema-exact
CCSDS OMM (v3.0) JSON keys. Three objects: VANGUARD 1 (NORAD 5), VANGUARD 2
(NORAD 11), VANGUARD R/B (NORAD 12).

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
