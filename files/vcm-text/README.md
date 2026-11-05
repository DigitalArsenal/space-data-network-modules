# files/vcm-text

Writes the legacy SP Vector/Covariance Message V2.0 text (classic VCM) from one
SDS `$OCM`. It is the inverse of `files/orbit-products` `normalize_vcm`, which
reads that text into an `$OCM`: a record the reader wrote is written back value
for value. The layout is spacedatastandards.org
`survey/legacy-messages/vcm/README.md`.

| method | in | out |
| --- | --- | --- |
| `ocm_to_vcm` | `ocm`: one `$OCM`; `state` (optional, up to two): one `$OEM` each, one state at the record's epoch, EME2000 (J2K lines) or TEME of date (ECI lines); `descriptor` (optional configuration): an `$NCD`, FORMAT UNSPECIFIED or PROVIDER_DEFINED `vcm-v2-text`, whose INTERNAL_FILE_NAME and SOURCE_CID ride onto the output descriptor | `message`: size-prefixed `$NCD` (PROVIDER_DEFINED `vcm-v2-text`, SHA-256 and length of the text) followed by the text, CR LF line ends; the frame `normalize_vcm` reads |

- **Nothing invented.** Each value comes from a field that states it, or from
  the caller's states. A field with no value is left blank; a line with no
  value at all is left out. Two lines use the message's own documented form
  for "not known": the leap second (`2049 365 (31 DEC) 23:59:59.999`) and the
  covariance size (`0x0`, only when the record states that size).
- **Nothing derived.** No propagation, frame rotation or covariance
  conversion happens here. The J2K state is the record's own EME2000 state at
  its epoch or the caller's; for a mean-element set (AP, SGP4-XP) the caller
  flies the set to its epoch with its own propagator (`propagator/sdn-ap`
  `propagate`, `OUTPUT.FRAME` EME2000 and TEME) and passes both states.
- **Field map.** `src/vcm_draft.hpp` lists the field behind every line. The
  EFG state, U,V,W sigmas, equinoctial covariance, integrator, polar motion,
  nutation, thrust and center-of-mass lines and the ON/OFF switches come only
  from the layout `normalize_vcm` writes (its `VCM_*` user-defined parameters
  and perturbation comments): no typed `$OCM` field states them in the
  message's basis and units.
- **CENTER.** The record's ORIGINATOR; for a fitted element set (MEAN_ELEMENTS), the
  fit's producer (PROVENANCE.PRODUCER), never the source ephemeris' originator.
- **Digits.** The message's columns: 8 decimals of km and 12 of km/s for
  states; an E field keeps its documented digits when they hold the value
  exactly and prints the digits it needs otherwise.

Refused by name: `configuration-refused`, `invalid-configuration`, `missing-ocm`, `invalid-ocm`, `invalid-state`,
`state-epoch-mismatch`, `state-frame-unsupported`, `state-duplicate`,
`epoch-missing`, `epoch-not-millisecond`, `time-system-not-utc`,
`invalid-parameter`.

Build: `npm ci && node build.mjs` (reads `files/orbit-products/src/vcm.hpp` and
`sha256.hpp`). Test: `node --test tests/vcm_text.test.mjs`: the round trip
through `normalize_vcm` on its synthetic sample, and an AP set fitted to NASA's
public ISS ephemeris with its J2K and ECI states from `propagator/sdn-ap`.
