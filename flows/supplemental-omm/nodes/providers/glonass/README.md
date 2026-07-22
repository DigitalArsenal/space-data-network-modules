# GLONASS provider source

The production default is the Center for Orbit Determination in Europe (CODE)
stable ultra-rapid orbit alias:

```text
https://www.aiub.unibe.ch/download/CODE/COD0OPSULT.SP3
```

CODE is operated by the University of Bern's Astronomical Institute and is an
official International GNSS Service Global Analysis Center. Its documented
ultra-rapid product combines GPS, GLONASS, and Galileo orbits at five-minute
sampling. The Supplemental OMM OD node selects the `PRxx` GLONASS records from
this mixed SP3-d response.

Authoritative provenance:

- [CODE Analysis Center](https://www.aiub.unibe.ch/research/code___analysis_center/index_eng.html)
- [CODE 2025 technical report](https://igstr.aiub.unibe.ch/2025_techreport_draft.pdf)

Live verification on 2026-07-21 followed the University of Bern redirects to
its object-storage delivery endpoint and returned an uncompressed SP3-d file:
3,337,569 bytes, 577 epochs at 300-second spacing, and 11,540 `PR` records for
20 GLONASS satellites. The stable alias is intentionally mutable; each emitted
FSB response carries the full byte length and SHA-256 so downstream nodes can
verify the exact retrieved object.

The provider WASM fetches CODE directly over HTTPS and does not embed an
external catalog dependency, Tor, or proxy policy; any development-only proxy
is a generic host transport concern.
