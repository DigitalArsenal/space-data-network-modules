# Test fixture provenance

`iqengine-meta.sample.json` is a verbatim cut of the **live** IQEngine bulk
metadata index, fetched 2026-08-04 anonymously over HTTPS — no token, no
account:

    GET https://www.iqengine.org/api/datasources
    -> HTTP 200, ONE public datasource: {"type":"api","account":"local",
       "container":"local","public":true,"name":"Local to Backend"}

    GET https://www.iqengine.org/api/datasources/local/local/meta
    -> HTTP 200, 31,413,709 bytes, a JSON array of 36,636 SigMF documents
       ({global, captures, annotations})

Companion endpoints, both verified 200 anonymously on the same day and both
written into `IQCPayloadRef.URL`:

    GET https://www.iqengine.org/api/datasources/local/local/pulsed_ASK.sigmf-meta
    -> 200, 516 bytes, application/json
    GET https://www.iqengine.org/api/datasources/local/local/pulsed_ASK.sigmf-data
    -> 200, Content-Length 200,804,352

`GET /api/datasources/local/local/meta/paths` (200, 2,479,009 bytes) and the
per-file `.../{path}/meta` route also answer anonymously; the module uses the
BULK route so one cycle is one request rather than 36,636.

## Live-corpus shape, measured not assumed

| property | count over the 36,636 live documents |
| --- | --- |
| `core:datatype` / `core:sample_rate` / `core:version` | 36,636 (always present) |
| `core:author` | 36,626 |
| `core:sha512` | 36,401 |
| `core:hw` | 147 |
| `core:recorder` | 136 |
| `core:license` | 112 |
| `core:collection` | 39 |
| `core:geolocation` | 19 |
| documents with annotations | 19 |
| documents with more than one capture | 4 |
| `core:extensions` | 4 |
| datatypes seen | `cf32_le` 36,512 · `ci16_le` 103 · `ci8` 16 · `rf32_le` 3 · `ci16` 2 |
| licences seen | CC BY 4.0 URL ×92 · `CC BY-SA` ×15 · `MIT License` ×4 · `CC0` ×1 |

## The 16 documents in the fixture, and what each one is for

Chosen to exercise every branch the parser has, not for appearance:

| document | exercises |
| --- | --- |
| `pulsed_ASK` | minimal record; `core:num_channels`; **no** licence; **no** geolocation |
| `AIS-Collection-…-161M975CF-…` | well-formed GeoJSON Point with altitude; CC BY 4.0 **URL** licence; `core:hw`; `core:recorder`; `core:datetime` |
| `iridium_cf32` | `CC0` licence **verbatim**; TRANSPOSED coordinates `[35.14,-106.51]`; MISSPELLED `core::datetime` |
| `space/Dwingeloo Radio Telescope/camras-…` | geolocation wrapped in a single-element ARRAY; path containing SPACES; vendor `camras:*` keys |
| `space/NOAA18-APT-…` | space capture with geolocation |
| `cellular_downlink_880MHz` | `core:extensions` (1); 8 annotations |
| `synthetic_int16_detected` | 12 annotations; CC BY 4.0 |
| `synthetic` | THREE captures -> three `IQCSegment`s |
| `cellular/rx-waveform-td-rec-0-…` | `MIT License` (a non-Creative-Commons string carried verbatim) |
| `ism_band_24` | `CC BY-SA` (a licence name that is NOT an SPDX id and is not re-spelled) |
| `rfd900p` | no `core:hw` and no `core:recorder` -> NO `HARDWARE` table at all |
| `consumer_microwave` | 2.45 GHz — the BAND-must-not-be-derived case |
| `a sign in space/A_Sign_in_Space-ATA-X` | `ci8` datatype; path with spaces |
| `Airbus-SIGENCE/ShortPulseStudy_Scenario_long_pulses` | `core:offset`, `core:metadata_only`, `core:trailing_bytes`, `core:collection`, capture `core:header_bytes`, 561 annotations |
| `bluetooth` | 184 annotations carrying `core:generator` ("OmniSIG Studio BD") — the field that keeps a classifier's label distinguishable from a human's; 2 extensions |
| `802.11ah WiFi HaLow/2mhz-mcs1-chan158` | an annotation that states ONLY `core:comment` — no label, no generator, no edges |

## `traceability:sample_length` is COMPLEX SAMPLES — verified, not assumed

`pulsed_ASK` publishes `traceability:sample_length: 25100544` with
`core:datatype: cf32_le` (8 bytes per complex sample). Its `.sigmf-data`
answers `Content-Length: 200804352`, and 25,100,544 x 8 = 200,804,352 exactly.
The field is therefore complex samples, which is what `IQC.SAMPLE_COUNT`
means. (`BYTE_LENGTH` is still left at 0 — the archive publishes no size, and
0 already means "unpublished".)

## Licence

There is **no site-wide licence** for this corpus, and the module never
invents one. IQEngine hosts third-party recordings, so licence is per
RECORDING: `core:license` rides verbatim into `IQC.LICENSE` and an absent one
leaves `LICENSE` empty, which per the standard means UNKNOWN TERMS — not
public domain and not a grant to redistribute. The fixture deliberately
contains both licensed and unlicensed documents.

## Other archives named in the owner directive

`sdn-raw-iq-sigmf-sources` names five archives. Only IQEngine has an
anonymous read surface verified here, so only IQEngine has an adapter. The
probe results for the rest are recorded in that graph task; a stub adapter
that fabricates data is forbidden, so nothing else is registered.
