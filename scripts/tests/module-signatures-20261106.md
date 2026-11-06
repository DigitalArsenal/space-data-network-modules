# Module signatures audit, 2026-11-06 (modules-module-signing-owner-key-20261106)

Measured on modules main 03ee8623 with `node scripts/check-module-signatures.mjs --report` before any dist was touched.

## Before-state

154 index rows with an isomorphic dist (152 at `dist/isomorphic/module.wasm`, 2 flows at `dist/runtime/isomorphic/module.wasm`).

| class | count | which |
|---|---|---|
| owner-key (`module-owner-2026-10-15`) | 2 | analysis/covariance, licensing/client-decrypt |
| dev-key (`sdm-dev-test-2026`, the public SDK development key) | 12 | analysis/launch-ascent, analysis/reentry, analysis/vcm-adapter, basilisk/runtime, data-source/gp-archive-records, data-source/spk-source, files/ccsds-messages, files/orbit-products, files/rinex, files/vcm-text, foundation/frames, propagator/hypersonics |
| unsigned | 138 | every other current module |

Build-provenance files: 25 of 25 agree with the module section. The ledger of that commit carried no `wasmSha256`; the ledger regenerated on the same unsigned tree records one per entry (equal to the whole-file sha256 of an unsigned dist).

## What a signing changes (measured on scratch copies with a scratch key)

The SDK's trailer writer (`createSingleFileBundle`, used by `signModuleArtifact` and by the stage-2 wrapper of the node-signed form) strips every `sds.*` custom section from the module and carries the plugin manifest in the trailer bundle. 138 of the 154 current dists embed `sds.manifest`, so a first signing shrinks the module section (analysis/conjunction-assessment 1,751,724 -> 1,721,599 B; analysis/access 240,305 -> 238,701 B) and moves its sha256. Re-signing an already-bundled dist (foundation/frames) is trailer-only: the section is byte-identical.

Invariant under signing, asserted by `scripts/sign-module-artifact.mjs` before it writes: the canonical module hash (sha256 with `sds.*` stripped; the hash the signature covers) is unchanged; every non-sds section is byte-identical; the manifest bytes are preserved (the `sds.manifest` section equals the bundle's manifest entry). The whole-file sha256 of a first-signed dist moves, and with it every record that cites it (flow `dist/**/artifact.json` linked-node pins, the python-astro locks, delivery catalog entries, the sdn-ap SPEC/README `dist` header).

Decision pending (coordinator, 2026-11-06): whether a shipped version's bytes may change after the fact, or the 138 unsigned dists are signed at their next version step while the 14 bundled ones re-sign now. No dist has been written.

## Before table

| module | version | signature | keyId | module section sha256 | ledger wasmSha256 | build-provenance |
|---|---|---|---|---|---|---|
| analysis/access | 1.0.0 | unsigned |  | 1277308cfb5abafc | disagrees | none |
| analysis/association | 0.3.0 | unsigned |  | 5eaa6ae43506fb1f | disagrees | agrees |
| analysis/catalog-composer | 0.6.0 | unsigned |  | c336aeb3cdb5609b | disagrees | none |
| analysis/catalog-synthesis | 0.3.0 | unsigned |  | bf9b7374d2d198be | disagrees | agrees |
| analysis/conjunction-assessment | 0.18.4 | unsigned |  | fe7533e9168c65f3 | disagrees | agrees |
| analysis/covariance | 0.2.0 | owner-key | module-owner-2026-10-15 | ff626e0a629fd8ad | disagrees | none |
| analysis/density-calibration | 0.7.0 | unsigned |  | cc8dcc72cea9a92c | disagrees | none |
| analysis/dop | 1.0.1 | unsigned |  | bb80e36a6a409850 | disagrees | none |
| analysis/epoch-state | 0.5.0 | unsigned |  | 681820b30e2cf134 | disagrees | none |
| analysis/estimation | 0.8.1 | unsigned |  | acaf8ca33d22d9c6 | disagrees | none |
| analysis/gp-error-model | 0.14.0 | unsigned |  | f946bafb1c8106bc | disagrees | none |
| analysis/lambert-izzo | 0.2.0 | unsigned |  | 6ab466391b30858b | disagrees | none |
| analysis/launch-ascent | 0.1.0 | dev-key | sdm-dev-test-2026 | 83445e1cc40958f8 | disagrees | none |
| analysis/launch-cola | 0.2.0 | unsigned |  | 3e30ec48520cfa2e | disagrees | none |
| analysis/launch-trajectory | 0.2.0 | unsigned |  | b5e13893dd5836a9 | disagrees | none |
| analysis/maneuver-detection | 0.9.0 | unsigned |  | ecddd8e3ab1fa798 | disagrees | none |
| analysis/maneuver | 0.7.0 | unsigned |  | 9502b10c683cc851 | disagrees | none |
| analysis/mission-screening | 0.1.0 | unsigned |  | ea2f9ce16bb130cb | disagrees | none |
| analysis/observation-simulator | 0.1.1 | unsigned |  | 95b637300af2b2a6 | disagrees | none |
| analysis/od/fit-pipeline | 0.2.0 | unsigned |  | fd63112d38e92edc | disagrees | none |
| analysis/od | 0.3.0 | unsigned |  | 1cb9b8d55c5cced6 | disagrees | none |
| analysis/optical-astrometry | 0.3.0 | unsigned |  | 5d7c19752340c7aa | disagrees | agrees |
| analysis/parameters | 0.1.0 | unsigned |  | fb0a588ba2f08f9b | disagrees | none |
| analysis/private-screening | 0.3.0 | unsigned |  | 1782365525d0e3bf | disagrees | none |
| analysis/reentry | 0.1.0 | dev-key | sdm-dev-test-2026 | 0df51c0b1c621440 | disagrees | none |
| analysis/reference-points | 0.1.0 | unsigned |  | 5d31f8b0796934a1 | disagrees | none |
| analysis/reference-states | 0.4.0 | unsigned |  | 51477903cb13d877 | disagrees | none |
| analysis/rf-phased-array | 0.1.0 | unsigned |  | 0d2fede222f5abf8 | disagrees | none |
| analysis/rpo-history | 0.2.0 | unsigned |  | 0aefc5c7afe2855f | disagrees | none |
| analysis/science-http | 0.1.0 | unsigned |  | 97f0f6af13a6b2a3 | disagrees | none |
| analysis/targeting | 0.1.0 | unsigned |  | 83f81e20d8c7f0aa | disagrees | agrees |
| analysis/vcm-adapter | 0.3.0 | dev-key | sdm-dev-test-2026 | dfa14ff98b3bfadf | disagrees | none |
| basilisk/runtime | 0.3.0 | dev-key | sdm-dev-test-2026 | 49947426b5bfdbaa | disagrees | none |
| data-source/body-imagery-tiles | 0.5.0 | unsigned |  | 06e2770f2f050aa6 | disagrees | agrees |
| data-source/body-imagery/host-adapter | 0.2.0 | unsigned |  | f37ab64658124c27 | disagrees | none |
| data-source/body-imagery | 0.2.0 | unsigned |  | 5ddd216115246be8 | disagrees | none |
| data-source/bond-attestation-source | 1.1.0 | unsigned |  | 4f126760c48de4fc | disagrees | none |
| data-source/catalog-source | 0.3.0 | unsigned |  | d964ecea8b5c3727 | disagrees | none |
| data-source/celestrak-parser | 0.2.0 | unsigned |  | 7db965f3933cafa2 | disagrees | none |
| data-source/celestrak-reference | 0.2.0 | unsigned |  | 5392abb0e3770540 | disagrees | none |
| data-source/celestrak-request | 0.2.0 | unsigned |  | 727880a48e16d6ab | disagrees | none |
| data-source/celestrak-supgp | 2.0.0 | unsigned |  | 2b4d2b44f1d7d7dc | disagrees | none |
| data-source/cell-tower-credentials | 0.2.0 | unsigned |  | 54b8b30c6636d872 | disagrees | none |
| data-source/cell-tower-ingest | 0.2.0 | unsigned |  | 9cde36ec9ac1b0b4 | disagrees | none |
| data-source/cell-tower-source | 0.2.0 | unsigned |  | 77c69ffaf7d96d25 | disagrees | none |
| data-source/cpf-source | 1.1.0 | unsigned |  | 4edab160c53d71af | disagrees | agrees |
| data-source/deep-space-spacecraft | 0.3.1 | unsigned |  | 5c43ae89b2a05acc | disagrees | agrees |
| data-source/eop-parser | 0.2.0 | unsigned |  | 03afedc590707a1d | disagrees | none |
| data-source/eop-request | 0.2.0 | unsigned |  | 6d2716ec13113991 | disagrees | none |
| data-source/ephemeris-source/host-adapter | 0.2.0 | unsigned |  | b741d39338042322 | disagrees | none |
| data-source/ephemeris-source | 0.2.0 | unsigned |  | 5c789c4758679a03 | disagrees | none |
| data-source/geonames-ingest | 0.2.0 | unsigned |  | 62b2c3bb57dd9489 | disagrees | none |
| data-source/geonames-source | 0.2.0 | unsigned |  | 686766bf670ecb1e | disagrees | none |
| data-source/gibs/host-adapter | 0.1.0 | unsigned |  | c0d684c5549157d7 | disagrees | none |
| data-source/gibs | 0.1.0 | unsigned |  | 4ab43d3e7034f8a5 | disagrees | none |
| data-source/glonass-source | 1.1.0 | unsigned |  | db7e375ca038074f | disagrees | agrees |
| data-source/gp-archive-records | 0.2.0 | dev-key | sdm-dev-test-2026 | 06f55fc3cd037efb | disagrees | none |
| data-source/gps-source | 1.0.0 | unsigned |  | 9c554bbabeccda55 | disagrees | none |
| data-source/ilrs-crd-source | 0.2.0 | unsigned |  | 1671b59287d5e3dc | disagrees | agrees |
| data-source/ilrs-station-coordinates | 0.1.0 | unsigned |  | d775a12572114dc3 | disagrees | agrees |
| data-source/imager-observation-parser | 0.2.0 | unsigned |  | 747bff97e8d41786 | disagrees | none |
| data-source/imager-observation-source | 0.2.0 | unsigned |  | d3bd0a8972b13417 | disagrees | none |
| data-source/intelsat-source | 1.1.0 | unsigned |  | be8547f2a6e3da12 | disagrees | agrees |
| data-source/iss-source | 1.1.0 | unsigned |  | ddf6be062dca5145 | disagrees | agrees |
| data-source/launch-schedule/host-adapter | 0.2.0 | unsigned |  | b53a6deb7fbf142e | disagrees | none |
| data-source/launch-schedule | 0.2.0 | unsigned |  | 901a56b57b176423 | disagrees | none |
| data-source/lowell-astorb/host-adapter | 0.4.0 | unsigned |  | 76bbaacaf4816514 | disagrees | none |
| data-source/lowell-astorb | 0.4.0 | unsigned |  | cada8076c539d040 | disagrees | none |
| data-source/lvdb-source | 0.1.0 | unsigned |  | e35e6e2c18149ea8 | disagrees | none |
| data-source/mlab-starlink-connectivity | 0.2.0 | unsigned |  | f89ad02b309455ed | disagrees | none |
| data-source/moon-imagery | 0.1.0 | unsigned |  | ce166d2b44f2bb6b | disagrees | agrees |
| data-source/naif-kernels/host-adapter | 0.1.0 | unsigned |  | 5fbc9c99faca7db2 | disagrees | none |
| data-source/naif-kernels | 0.1.0 | unsigned |  | b89b8c6705f47cb5 | disagrees | none |
| data-source/nwp-field-source | 0.3.1 | unsigned |  | feb8604803dc7a98 | disagrees | none |
| data-source/nwp-grib2-parser | 0.3.0 | unsigned |  | 05768ae2712678f7 | disagrees | none |
| data-source/oem-source-iss | 0.2.0 | unsigned |  | 1ee970d263d17a48 | disagrees | none |
| data-source/oneweb-source | 1.0.0 | unsigned |  | e70bf07eed4c36bb | disagrees | none |
| data-source/open-meteo/host-adapter | 0.2.0 | unsigned |  | 70bac58df517b88d | disagrees | none |
| data-source/open-meteo | 0.2.0 | unsigned |  | 47208a14312d8678 | disagrees | none |
| data-source/operator-states-public | 0.2.0 | unsigned |  | 7065ca13170cd0fc | disagrees | none |
| data-source/osm-source | 0.2.0 | unsigned |  | 66d7a2f0ee2e460a | disagrees | none |
| data-source/record-retention | 0.2.0 | unsigned |  | fb768c185d7f3804 | disagrees | none |
| data-source/retrieval | 0.2.0 | unsigned |  | ae4d46cc57e38338 | disagrees | none |
| data-source/satnogs-optical-source | 0.1.0 | unsigned |  | a23705bbdf052fa9 | disagrees | agrees |
| data-source/satnogs-source | 0.2.0 | unsigned |  | 09a98c96dc5c8d04 | disagrees | none |
| data-source/sdn-element-sync | 0.2.0 | unsigned |  | 37f0ea34ccc2bf7b | disagrees | agrees |
| data-source/sensor-definitions | 0.1.1 | unsigned |  | fe21d884d24b7b17 | disagrees | agrees |
| data-source/sigmf-captures | 0.2.0 | unsigned |  | 4590d71e0c17de88 | disagrees | none |
| data-source/sp3-precise-source | 0.2.0 | unsigned |  | 9d5dccf6e2249d13 | disagrees | agrees |
| data-source/space-infrastructure | 0.1.1 | unsigned |  | 9d64c4ea7281c40e | disagrees | agrees |
| data-source/space-weather | 0.3.0 | unsigned |  | 7abd9f36f0044a9d | disagrees | none |
| data-source/spacemapper-aoe-source | 0.3.0 | unsigned |  | ec36a314da42a59a | disagrees | agrees |
| data-source/spacetrack-source | 0.4.0 | unsigned |  | 1c17ca36c2cda2c5 | disagrees | agrees |
| data-source/spacex-starlink-source | 1.2.0 | unsigned |  | 7b88f0791df66e04 | disagrees | none |
| data-source/spk-source | 0.1.1 | dev-key | sdm-dev-test-2026 | e965c4ddc38714f9 | disagrees | none |
| data-source/swpc-realtime | 0.2.0 | unsigned |  | 75a54b76a04dd290 | disagrees | none |
| data-source/terrain-ingest/host-adapter | 0.1.0 | unsigned |  | 089559b5a5b05d29 | disagrees | none |
| data-source/terrain-ingest | 0.9.0 | unsigned |  | 802641da0f74bcfb | disagrees | none |
| data-source/terrain-source-watch | 0.1.0 | unsigned |  | 0218e2f15821e076 | disagrees | none |
| data-source/terrain-source | 0.8.1 | unsigned |  | 448a6d4bfe2e7288 | disagrees | none |
| data-source/vimpel-source | 0.2.0 | unsigned |  | 4132f09a46cf1f36 | disagrees | agrees |
| data-source/weathernext-parser | 0.2.0 | unsigned |  | 4ea019e9b5c9427c | disagrees | none |
| data-source/weathernext-source | 0.2.0 | unsigned |  | eff7ca8f44453f04 | disagrees | none |
| exporter/vcard-projection | 0.2.0 | unsigned |  | c89c584f1e47726d | disagrees | none |
| files/ccsds-messages | 0.3.0 | dev-key | sdm-dev-test-2026 | 6ccd5a5c8a2b6d99 | disagrees | none |
| files/geotiff | 0.2.0 | unsigned |  | 31a776c30a340e46 | disagrees | none |
| files/misb-klv | 0.2.0 | unsigned |  | 4bc5cb22b625334a | disagrees | none |
| files/orbit-products | 0.2.0 | dev-key | sdm-dev-test-2026 | 3326b6cfcd57369e | disagrees | none |
| files/rinex | 0.2.0 | dev-key | sdm-dev-test-2026 | 0cfeac0560f4b42c | disagrees | none |
| files/vcm-text | 0.1.2 | dev-key | sdm-dev-test-2026 | bd10229862546a7b | disagrees | none |
| flows/angles-only-od | 0.3.0 | unsigned |  | 8dceb574b30f97d7 | disagrees | none |
| flows/eop | 0.1.0 | missing |  |  | disagrees | none |
| flows/object-covariance | 0.1.0 | missing |  |  | disagrees | none |
| flows/observation-od | 0.4.0 | unsigned |  | 86681788202dbe4b | disagrees | none |
| flows/supplemental-omm/nodes/od | 2.1.2 | unsigned |  | 61ea6f17325ebc99 | disagrees | none |
| flows/supplemental-omm/nodes/status | 2.0.0 | unsigned |  | c90d019b6af5654c | disagrees | none |
| foundation/attitude-math | 0.1.0 | unsigned |  | 84d2bfaed714761f | disagrees | none |
| foundation/cosmology | 0.1.0 | unsigned |  | ffee33a750598537 | disagrees | agrees |
| foundation/frames | 0.2.0 | dev-key | sdm-dev-test-2026 | fc289225bb174bdb | disagrees | none |
| foundation/http-respond | 0.3.1 | unsigned |  | 77f3c9263b161a49 | disagrees | none |
| foundation/http-route | 0.8.0 | unsigned |  | bf56ef63d3a814f4 | disagrees | none |
| foundation/math-bspline | 0.1.0 | unsigned |  | 2dc637e5c6236c94 | disagrees | none |
| foundation/numerics | 0.1.0 | unsigned |  | 1eda96fac8323dd3 | disagrees | none |
| foundation/orbits | 0.1.0 | unsigned |  | 7fb367fa947c69ef | disagrees | none |
| foundation/time | 0.1.0 | unsigned |  | 61abbb27a8358b05 | disagrees | none |
| hostcap/clock | 0.2.0 | unsigned |  | 87213b407b18c407 | disagrees | none |
| hostcap/file | 0.2.0 | unsigned |  | 97c4e4de65faa75f | disagrees | none |
| hostcap/flatsql-query | 0.3.1 | unsigned |  | 55b298c4e6cc7d6b | disagrees | none |
| hostcap/flatsql-store | 0.2.0 | unsigned |  | 23dadfbf806a1baf | disagrees | none |
| hostcap/http-request | 0.2.0 | unsigned |  | 219919c46aa3c884 | disagrees | none |
| hostcap/node-activity | 0.2.0 | unsigned |  | 876b4ab4aa198600 | disagrees | none |
| hostcap/node-status | 0.2.0 | unsigned |  | 0de13c1391be5f98 | disagrees | none |
| hostcap/p2p-discovery | 0.4.0 | unsigned |  | 2388e2737211a088 | disagrees | none |
| hostcap/random | 0.2.0 | unsigned |  | aa261a12824f9035 | disagrees | none |
| hostcap/storage-ingest | 0.6.1 | unsigned |  | 4153b3437e27d1d4 | disagrees | none |
| hostcap/storage-write | 0.2.0 | unsigned |  | 2a4fc044825fbd6f | disagrees | none |
| licensing/client-decrypt | 0.2.0 | owner-key | module-owner-2026-10-15 | 1dfefb2e7d7c81e1 | disagrees | none |
| licensing/core | 0.2.0 | unsigned |  | 1e3a0938482e81d1 | disagrees | none |
| licensing/publication-seal | 0.1.0 | unsigned |  | 73fd21d93c44b9c3 | disagrees | none |
| maneuver/star-search | 0.2.0 | unsigned |  | 7accc66dd3321c6d | disagrees | none |
| network/cloudflare-registrar | 0.2.0 | unsigned |  | b525a20d4242444e | disagrees | none |
| propagator/atmosphere | 0.2.0 | unsigned |  | a8d1123b83547dd8 | disagrees | none |
| propagator/cislunar | 0.2.0 | unsigned |  | af687cae6c825e28 | disagrees | none |
| propagator/events | 0.1.0 | unsigned |  | 1a856dc5a4903919 | disagrees | none |
| propagator/ffm | 2.2.1 | unsigned |  | a9133120775291c4 | disagrees | agrees |
| propagator/ffm/tests/reference | 1.4.1 | unsigned |  | e8c7b4f59d54a114 | disagrees | none |
| propagator/hypersonics | 0.1.1 | dev-key | sdm-dev-test-2026 | b12acbfa3d3f41f8 | disagrees | none |
| propagator/keplerian-reference | 1.9.0 | unsigned |  | 312cd01b88146169 | disagrees | none |
| propagator/sdn-ap | 0.6.3 | unsigned |  | aa3ed22aa61a3a51 | disagrees | agrees |
| propagator/sgp4-xp | 0.2.2 | unsigned |  | 1f8aa4c7e3c01a9e | disagrees | none |
| propagator/sgp4 | 1.4.1 | unsigned |  | 2fe246b716c78a4b | disagrees | none |
| propagator/solar-system-bodies | 0.5.2 | unsigned |  | 9d32a15d9333b832 | disagrees | none |
| storage/credentials | 0.1.1 | unsigned |  | 401f5d7adf231181 | disagrees | none |
| storage/object-s3 | 0.1.0 | unsigned |  | 956671c19ee9c446 | disagrees | none |

FAIL module signatures: 304 problems; 154 current dists: 12 dev-key, 2 missing, 2 owner-key, 138 unsigned; 0/154 module sections equal the ledger wasmSha256; 25/25 equal their build-provenance file


## Ruling (SDN-AP session via the coordinator, 2026-11-06)

A shipped version's bytes do not change after the fact. The 14 bundled dists (12 dev-key, 2 owner-key) are re-signed now with
`module-owner-2026-10-15`, trailer-only, module section byte-identical (asserted by `scripts/sign-module-artifact.mjs
--trailer-only`: 14/14 sections unchanged, `manifestMovedToTrailer: false` for every one). The 138 unsigned raw builds (plus the
two flow runtimes at `dist/runtime/isomorphic/module.wasm`) stay unsigned and sign at their next version (sdn-ap at 0.6.4
first; the rest in the SDS 1.279 whole-repo program); the classifier reports them as "unsigned (signs at next version)", not
as a failure. Both identities are recorded per dist in the ledger: the whole-file `sha256` and `canonicalModuleSha256`.

Whole-file citations of the 14 re-signed dists moved in the same push: `files/ccsds-messages/conformance/{answers,parity}.json`,
`files/orbit-products/conformance/parity.json`, `files/rinex/conformance/parity.json` (their `artifactSha256`, asserted by the
modules' parity tests), `packages/python-astro/src/spacedatanetwork_astro/{artifacts,bindings}.lock.json` (foundation/frames,
repinned with `scripts/pin_artifacts.py`). Left as they are: the vendored experiments snapshot under
`propagator/sdn-ap/test/vendor/orbit-accuracy-experiments-c89f2bc/**/build.json` (a record of another repository's build at
c89f2bc, not a pin of these dists). No flow `artifact.json` and no delivery catalog entry cites any of the 14.

## After-state

| module | version | form | signature | keyId | module section sha256 | canonical module sha256 | whole file sha256 | ledger | build-provenance |
|---|---|---|---|---|---|---|---|---|---|
| analysis/access | 1.0.0 | raw | unsigned (signs at next version) |  | 1277308cfb5abafc | bb517a8a34749535 | 1277308cfb5abafc | agrees | none |
| analysis/association | 0.3.0 | raw | unsigned (signs at next version) |  | 5eaa6ae43506fb1f | e934f14a61e2c2ef | 5eaa6ae43506fb1f | agrees | agrees |
| analysis/catalog-composer | 0.6.0 | bundled | unsigned (signs at next version) |  | c336aeb3cdb5609b | c336aeb3cdb5609b | ecc80af2cd3daec4 | agrees | none |
| analysis/catalog-synthesis | 0.3.0 | raw | unsigned (signs at next version) |  | bf9b7374d2d198be | 34a0e6a849aec811 | bf9b7374d2d198be | agrees | agrees |
| analysis/conjunction-assessment | 0.18.4 | raw | unsigned (signs at next version) |  | fe7533e9168c65f3 | e7b3df40faf5f4c5 | fe7533e9168c65f3 | agrees | agrees |
| analysis/covariance | 0.2.0 | bundled | owner-key | module-owner-2026-10-15 | ff626e0a629fd8ad | ff626e0a629fd8ad | ab438a4e8ed2c5ee | agrees | none |
| analysis/density-calibration | 0.7.0 | raw | unsigned (signs at next version) |  | cc8dcc72cea9a92c | c9a11d4e0a90d767 | cc8dcc72cea9a92c | agrees | none |
| analysis/dop | 1.0.1 | raw | unsigned (signs at next version) |  | bb80e36a6a409850 | b59aa4bdf939bf23 | bb80e36a6a409850 | agrees | none |
| analysis/epoch-state | 0.5.0 | raw | unsigned (signs at next version) |  | 681820b30e2cf134 | 5b29827cf8dd73f5 | 681820b30e2cf134 | agrees | none |
| analysis/estimation | 0.8.1 | raw | unsigned (signs at next version) |  | acaf8ca33d22d9c6 | 7b400e68955bb6af | acaf8ca33d22d9c6 | agrees | none |
| analysis/gp-error-model | 0.14.0 | raw | unsigned (signs at next version) |  | f946bafb1c8106bc | 41d4911ea25b7bc4 | f946bafb1c8106bc | agrees | none |
| analysis/lambert-izzo | 0.2.0 | raw | unsigned (signs at next version) |  | 6ab466391b30858b | 85a3247d5a1069e2 | 6ab466391b30858b | agrees | none |
| analysis/launch-ascent | 0.1.0 | bundled | owner-key | module-owner-2026-10-15 | 83445e1cc40958f8 | 83445e1cc40958f8 | c50cdeaaac30786b | agrees | none |
| analysis/launch-cola | 0.2.0 | raw | unsigned (signs at next version) |  | 3e30ec48520cfa2e | 6f1f13d6ce945859 | 3e30ec48520cfa2e | agrees | none |
| analysis/launch-trajectory | 0.2.0 | raw | unsigned (signs at next version) |  | b5e13893dd5836a9 | 7b3fbffcb839d778 | b5e13893dd5836a9 | agrees | none |
| analysis/maneuver-detection | 0.9.0 | raw | unsigned (signs at next version) |  | ecddd8e3ab1fa798 | 79cd950a69b0fa5b | ecddd8e3ab1fa798 | agrees | none |
| analysis/maneuver | 0.7.0 | raw | unsigned (signs at next version) |  | 9502b10c683cc851 | 05b28f4b9e6880f2 | 9502b10c683cc851 | agrees | none |
| analysis/mission-screening | 0.1.0 | raw | unsigned (signs at next version) |  | ea2f9ce16bb130cb | 9d635a86a10702cc | ea2f9ce16bb130cb | agrees | none |
| analysis/observation-simulator | 0.1.1 | raw | unsigned (signs at next version) |  | 95b637300af2b2a6 | 08b45760b3799e59 | 95b637300af2b2a6 | agrees | none |
| analysis/od/fit-pipeline | 0.2.0 | raw | unsigned (signs at next version) |  | fd63112d38e92edc | 82e314c100fe18cb | fd63112d38e92edc | agrees | none |
| analysis/od | 0.3.0 | raw | unsigned (signs at next version) |  | 1cb9b8d55c5cced6 | ab8c94bca90c3712 | 1cb9b8d55c5cced6 | agrees | none |
| analysis/optical-astrometry | 0.3.0 | raw | unsigned (signs at next version) |  | 5d7c19752340c7aa | 10fbdde6015ea618 | 5d7c19752340c7aa | agrees | agrees |
| analysis/parameters | 0.1.0 | raw | unsigned (signs at next version) |  | fb0a588ba2f08f9b | 957529a5259fd7e6 | fb0a588ba2f08f9b | agrees | none |
| analysis/private-screening | 0.3.0 | raw | unsigned (signs at next version) |  | 1782365525d0e3bf | bb04771503d582ab | 1782365525d0e3bf | agrees | none |
| analysis/reentry | 0.1.0 | bundled | owner-key | module-owner-2026-10-15 | 0df51c0b1c621440 | 0df51c0b1c621440 | f2f91b7003670272 | agrees | none |
| analysis/reference-points | 0.1.0 | raw | unsigned (signs at next version) |  | 5d31f8b0796934a1 | 66cd576cbe34384e | 5d31f8b0796934a1 | agrees | none |
| analysis/reference-states | 0.4.0 | raw | unsigned (signs at next version) |  | 51477903cb13d877 | 9ec910985b5237eb | 51477903cb13d877 | agrees | none |
| analysis/rf-phased-array | 0.1.0 | raw | unsigned (signs at next version) |  | 0d2fede222f5abf8 | 9e59e69d82ccd844 | 0d2fede222f5abf8 | agrees | none |
| analysis/rpo-history | 0.2.0 | raw | unsigned (signs at next version) |  | 0aefc5c7afe2855f | 12aac1aa58456831 | 0aefc5c7afe2855f | agrees | none |
| analysis/science-http | 0.1.0 | raw | unsigned (signs at next version) |  | 97f0f6af13a6b2a3 | 1ad18ef11ccf23ec | 97f0f6af13a6b2a3 | agrees | none |
| analysis/targeting | 0.1.0 | raw | unsigned (signs at next version) |  | 83f81e20d8c7f0aa | f979c4993876aa24 | 83f81e20d8c7f0aa | agrees | agrees |
| analysis/vcm-adapter | 0.3.0 | bundled | owner-key | module-owner-2026-10-15 | dfa14ff98b3bfadf | dfa14ff98b3bfadf | 3e4d13ea07047740 | agrees | none |
| basilisk/runtime | 0.3.0 | bundled | owner-key | module-owner-2026-10-15 | 49947426b5bfdbaa | 49947426b5bfdbaa | cff031b65662e1d4 | agrees | none |
| data-source/body-imagery-tiles | 0.5.0 | raw | unsigned (signs at next version) |  | 06e2770f2f050aa6 | 780f23d43062da5b | 06e2770f2f050aa6 | agrees | agrees |
| data-source/body-imagery/host-adapter | 0.2.0 | raw | unsigned (signs at next version) |  | f37ab64658124c27 | 3f12d973fc066cd3 | f37ab64658124c27 | agrees | none |
| data-source/body-imagery | 0.2.0 | raw | unsigned (signs at next version) |  | 5ddd216115246be8 | 5becba49b3718445 | 5ddd216115246be8 | agrees | none |
| data-source/bond-attestation-source | 1.1.0 | raw | unsigned (signs at next version) |  | 4f126760c48de4fc | 629d03aa97db9a5a | 4f126760c48de4fc | agrees | none |
| data-source/catalog-source | 0.3.0 | raw | unsigned (signs at next version) |  | d964ecea8b5c3727 | 7720edc7043e5bfa | d964ecea8b5c3727 | agrees | none |
| data-source/celestrak-parser | 0.2.0 | raw | unsigned (signs at next version) |  | 7db965f3933cafa2 | e513b5c08ce1e023 | 7db965f3933cafa2 | agrees | none |
| data-source/celestrak-reference | 0.2.0 | raw | unsigned (signs at next version) |  | 5392abb0e3770540 | 098adaaa73881dea | 5392abb0e3770540 | agrees | none |
| data-source/celestrak-request | 0.2.0 | raw | unsigned (signs at next version) |  | 727880a48e16d6ab | 8640508cf4300a11 | 727880a48e16d6ab | agrees | none |
| data-source/celestrak-supgp | 2.0.0 | raw | unsigned (signs at next version) |  | 2b4d2b44f1d7d7dc | 06a868bbad6fdd7a | 2b4d2b44f1d7d7dc | agrees | none |
| data-source/cell-tower-credentials | 0.2.0 | raw | unsigned (signs at next version) |  | 54b8b30c6636d872 | e8dc0b2621357f22 | 54b8b30c6636d872 | agrees | none |
| data-source/cell-tower-ingest | 0.2.0 | raw | unsigned (signs at next version) |  | 9cde36ec9ac1b0b4 | c146244e605ef787 | 9cde36ec9ac1b0b4 | agrees | none |
| data-source/cell-tower-source | 0.2.0 | raw | unsigned (signs at next version) |  | 77c69ffaf7d96d25 | 003738f89a059406 | 77c69ffaf7d96d25 | agrees | none |
| data-source/cpf-source | 1.1.0 | raw | unsigned (signs at next version) |  | 4edab160c53d71af | 11d69988d2839dd7 | 4edab160c53d71af | agrees | agrees |
| data-source/deep-space-spacecraft | 0.3.1 | raw | unsigned (signs at next version) |  | 5c43ae89b2a05acc | 2799db2b2cfb47f6 | 5c43ae89b2a05acc | agrees | agrees |
| data-source/eop-parser | 0.2.0 | raw | unsigned (signs at next version) |  | 03afedc590707a1d | 1df03b8481a7121f | 03afedc590707a1d | agrees | none |
| data-source/eop-request | 0.2.0 | raw | unsigned (signs at next version) |  | 6d2716ec13113991 | e78b25337889b4cf | 6d2716ec13113991 | agrees | none |
| data-source/ephemeris-source/host-adapter | 0.2.0 | raw | unsigned (signs at next version) |  | b741d39338042322 | c60bf822dde960b8 | b741d39338042322 | agrees | none |
| data-source/ephemeris-source | 0.2.0 | raw | unsigned (signs at next version) |  | 5c789c4758679a03 | a6f02a016530fa71 | 5c789c4758679a03 | agrees | none |
| data-source/geonames-ingest | 0.2.0 | raw | unsigned (signs at next version) |  | 62b2c3bb57dd9489 | 72ac4ccf74fca7fd | 62b2c3bb57dd9489 | agrees | none |
| data-source/geonames-source | 0.2.0 | raw | unsigned (signs at next version) |  | 686766bf670ecb1e | 0fd8471a93ba235a | 686766bf670ecb1e | agrees | none |
| data-source/gibs/host-adapter | 0.1.0 | raw | unsigned (signs at next version) |  | c0d684c5549157d7 | 80dcf5564dbfe54e | c0d684c5549157d7 | agrees | none |
| data-source/gibs | 0.1.0 | raw | unsigned (signs at next version) |  | 4ab43d3e7034f8a5 | 4175420cb4279f6c | 4ab43d3e7034f8a5 | agrees | none |
| data-source/glonass-source | 1.1.0 | raw | unsigned (signs at next version) |  | db7e375ca038074f | d897f5c73134cfc7 | db7e375ca038074f | agrees | agrees |
| data-source/gp-archive-records | 0.2.0 | bundled | owner-key | module-owner-2026-10-15 | 06f55fc3cd037efb | 06f55fc3cd037efb | 28b0968a9dd8c8d6 | agrees | none |
| data-source/gps-source | 1.0.0 | raw | unsigned (signs at next version) |  | 9c554bbabeccda55 | 9c554bbabeccda55 | 9c554bbabeccda55 | agrees | none |
| data-source/ilrs-crd-source | 0.2.0 | raw | unsigned (signs at next version) |  | 1671b59287d5e3dc | 2ce59c3d18b9ef97 | 1671b59287d5e3dc | agrees | agrees |
| data-source/ilrs-station-coordinates | 0.1.0 | raw | unsigned (signs at next version) |  | d775a12572114dc3 | 9b6b592120e238f8 | d775a12572114dc3 | agrees | agrees |
| data-source/imager-observation-parser | 0.2.0 | raw | unsigned (signs at next version) |  | 747bff97e8d41786 | 4d8caaa6310cb8ed | 747bff97e8d41786 | agrees | none |
| data-source/imager-observation-source | 0.2.0 | raw | unsigned (signs at next version) |  | d3bd0a8972b13417 | 30c95fa1b978f99d | d3bd0a8972b13417 | agrees | none |
| data-source/intelsat-source | 1.1.0 | raw | unsigned (signs at next version) |  | be8547f2a6e3da12 | bae098933d065dd7 | be8547f2a6e3da12 | agrees | agrees |
| data-source/iss-source | 1.1.0 | raw | unsigned (signs at next version) |  | ddf6be062dca5145 | 4d9af713244795b5 | ddf6be062dca5145 | agrees | agrees |
| data-source/launch-schedule/host-adapter | 0.2.0 | raw | unsigned (signs at next version) |  | b53a6deb7fbf142e | 39941b70300007e0 | b53a6deb7fbf142e | agrees | none |
| data-source/launch-schedule | 0.2.0 | raw | unsigned (signs at next version) |  | 901a56b57b176423 | d3c338067a001e3c | 901a56b57b176423 | agrees | none |
| data-source/lowell-astorb/host-adapter | 0.4.0 | raw | unsigned (signs at next version) |  | 76bbaacaf4816514 | 7ff0dbf724157ccb | 76bbaacaf4816514 | agrees | none |
| data-source/lowell-astorb | 0.4.0 | raw | unsigned (signs at next version) |  | cada8076c539d040 | 76a25b0fcef907aa | cada8076c539d040 | agrees | none |
| data-source/lvdb-source | 0.1.0 | raw | unsigned (signs at next version) |  | e35e6e2c18149ea8 | a53b8851a433d0ad | e35e6e2c18149ea8 | agrees | none |
| data-source/mlab-starlink-connectivity | 0.2.0 | raw | unsigned (signs at next version) |  | f89ad02b309455ed | cc3eebc71bff9b1c | f89ad02b309455ed | agrees | none |
| data-source/moon-imagery | 0.1.0 | raw | unsigned (signs at next version) |  | ce166d2b44f2bb6b | 811b202c8ee1b850 | ce166d2b44f2bb6b | agrees | agrees |
| data-source/naif-kernels/host-adapter | 0.1.0 | raw | unsigned (signs at next version) |  | 5fbc9c99faca7db2 | 99e757423c02dcd6 | 5fbc9c99faca7db2 | agrees | none |
| data-source/naif-kernels | 0.1.0 | raw | unsigned (signs at next version) |  | b89b8c6705f47cb5 | 779cae0cc5c44379 | b89b8c6705f47cb5 | agrees | none |
| data-source/nwp-field-source | 0.3.1 | raw | unsigned (signs at next version) |  | feb8604803dc7a98 | b468a612155e71ea | feb8604803dc7a98 | agrees | none |
| data-source/nwp-grib2-parser | 0.3.0 | raw | unsigned (signs at next version) |  | 05768ae2712678f7 | e58cee25842b7d3c | 05768ae2712678f7 | agrees | none |
| data-source/oem-source-iss | 0.2.0 | raw | unsigned (signs at next version) |  | 1ee970d263d17a48 | 093c1b57997216ee | 1ee970d263d17a48 | agrees | none |
| data-source/oneweb-source | 1.0.0 | raw | unsigned (signs at next version) |  | e70bf07eed4c36bb | e70bf07eed4c36bb | e70bf07eed4c36bb | agrees | none |
| data-source/open-meteo/host-adapter | 0.2.0 | raw | unsigned (signs at next version) |  | 70bac58df517b88d | c9c83568e6cee555 | 70bac58df517b88d | agrees | none |
| data-source/open-meteo | 0.2.0 | raw | unsigned (signs at next version) |  | 47208a14312d8678 | 868019031fa0bae9 | 47208a14312d8678 | agrees | none |
| data-source/operator-states-public | 0.2.0 | raw | unsigned (signs at next version) |  | 7065ca13170cd0fc | f958ce506ab4d27b | 7065ca13170cd0fc | agrees | none |
| data-source/osm-source | 0.2.0 | raw | unsigned (signs at next version) |  | 66d7a2f0ee2e460a | 8e91a272234020fc | 66d7a2f0ee2e460a | agrees | none |
| data-source/record-retention | 0.2.0 | raw | unsigned (signs at next version) |  | fb768c185d7f3804 | e1d644a797ef2f42 | fb768c185d7f3804 | agrees | none |
| data-source/retrieval | 0.2.0 | raw | unsigned (signs at next version) |  | ae4d46cc57e38338 | deaffc41f965786e | ae4d46cc57e38338 | agrees | none |
| data-source/satnogs-optical-source | 0.1.0 | raw | unsigned (signs at next version) |  | a23705bbdf052fa9 | 7db6a11916eaa3f2 | a23705bbdf052fa9 | agrees | agrees |
| data-source/satnogs-source | 0.2.0 | raw | unsigned (signs at next version) |  | 09a98c96dc5c8d04 | fd31e85df76729d1 | 09a98c96dc5c8d04 | agrees | none |
| data-source/sdn-element-sync | 0.2.0 | raw | unsigned (signs at next version) |  | 37f0ea34ccc2bf7b | 10f8486d474bbea9 | 37f0ea34ccc2bf7b | agrees | agrees |
| data-source/sensor-definitions | 0.1.1 | raw | unsigned (signs at next version) |  | fe21d884d24b7b17 | 96f1909509216225 | fe21d884d24b7b17 | agrees | agrees |
| data-source/sigmf-captures | 0.2.0 | raw | unsigned (signs at next version) |  | 4590d71e0c17de88 | f28a3a26d42ff3bb | 4590d71e0c17de88 | agrees | none |
| data-source/sp3-precise-source | 0.2.0 | raw | unsigned (signs at next version) |  | 9d5dccf6e2249d13 | 10cefada5e739df2 | 9d5dccf6e2249d13 | agrees | agrees |
| data-source/space-infrastructure | 0.1.1 | raw | unsigned (signs at next version) |  | 9d64c4ea7281c40e | 6d080e02c22f85fd | 9d64c4ea7281c40e | agrees | agrees |
| data-source/space-weather | 0.3.0 | raw | unsigned (signs at next version) |  | 7abd9f36f0044a9d | 4d37f1c1e3fb5ce3 | 7abd9f36f0044a9d | agrees | none |
| data-source/spacemapper-aoe-source | 0.3.0 | raw | unsigned (signs at next version) |  | ec36a314da42a59a | 3573d02e5f92b50d | ec36a314da42a59a | agrees | agrees |
| data-source/spacetrack-source | 0.4.0 | raw | unsigned (signs at next version) |  | 1c17ca36c2cda2c5 | 56ed959a98306fa9 | 1c17ca36c2cda2c5 | agrees | agrees |
| data-source/spacex-starlink-source | 1.2.0 | raw | unsigned (signs at next version) |  | 7b88f0791df66e04 | df8302ab409b0c2a | 7b88f0791df66e04 | agrees | none |
| data-source/spk-source | 0.1.1 | bundled | owner-key | module-owner-2026-10-15 | e965c4ddc38714f9 | e965c4ddc38714f9 | 968a99bc7d16ad90 | agrees | none |
| data-source/swpc-realtime | 0.2.0 | raw | unsigned (signs at next version) |  | 75a54b76a04dd290 | 6079dc7e03d7a7f6 | 75a54b76a04dd290 | agrees | none |
| data-source/terrain-ingest/host-adapter | 0.1.0 | raw | unsigned (signs at next version) |  | 089559b5a5b05d29 | ba8e13de44db5c6a | 089559b5a5b05d29 | agrees | none |
| data-source/terrain-ingest | 0.9.0 | raw | unsigned (signs at next version) |  | 802641da0f74bcfb | 9775064ce18825f6 | 802641da0f74bcfb | agrees | none |
| data-source/terrain-source-watch | 0.1.0 | raw | unsigned (signs at next version) |  | 0218e2f15821e076 | 6c31fd53c96735b6 | 0218e2f15821e076 | agrees | none |
| data-source/terrain-source | 0.8.1 | raw | unsigned (signs at next version) |  | 448a6d4bfe2e7288 | 28360c06e1dfa689 | 448a6d4bfe2e7288 | agrees | none |
| data-source/vimpel-source | 0.2.0 | raw | unsigned (signs at next version) |  | 4132f09a46cf1f36 | 2ae480f9db0cd087 | 4132f09a46cf1f36 | agrees | agrees |
| data-source/weathernext-parser | 0.2.0 | raw | unsigned (signs at next version) |  | 4ea019e9b5c9427c | 961cf88fba9ce21a | 4ea019e9b5c9427c | agrees | none |
| data-source/weathernext-source | 0.2.0 | raw | unsigned (signs at next version) |  | eff7ca8f44453f04 | e2b130b1dbf11e1c | eff7ca8f44453f04 | agrees | none |
| exporter/vcard-projection | 0.2.0 | raw | unsigned (signs at next version) |  | c89c584f1e47726d | b3664daa55704341 | c89c584f1e47726d | agrees | none |
| files/ccsds-messages | 0.3.0 | bundled | owner-key | module-owner-2026-10-15 | 6ccd5a5c8a2b6d99 | 6ccd5a5c8a2b6d99 | 74d68ebbdf8d1b84 | agrees | none |
| files/geotiff | 0.2.0 | raw | unsigned (signs at next version) |  | 31a776c30a340e46 | 8f0f4cf5fcb7d2ad | 31a776c30a340e46 | agrees | none |
| files/misb-klv | 0.2.0 | raw | unsigned (signs at next version) |  | 4bc5cb22b625334a | d4c30e5fcf4cb125 | 4bc5cb22b625334a | agrees | none |
| files/orbit-products | 0.2.0 | bundled | owner-key | module-owner-2026-10-15 | 3326b6cfcd57369e | 3326b6cfcd57369e | df42851260ee54dc | agrees | none |
| files/rinex | 0.2.0 | bundled | owner-key | module-owner-2026-10-15 | 0cfeac0560f4b42c | 0cfeac0560f4b42c | c4acf50555df5120 | agrees | none |
| files/vcm-text | 0.1.2 | bundled | owner-key | module-owner-2026-10-15 | bd10229862546a7b | bd10229862546a7b | d4ced5cb4a1ede1a | agrees | none |
| flows/angles-only-od | 0.3.0 | raw | unsigned (signs at next version) |  | 8dceb574b30f97d7 | 75280af18219c45c | 8dceb574b30f97d7 | agrees | none |
| flows/eop | 0.1.0 | raw | unsigned (signs at next version) |  | cef6cd73cbfc9ebc | 3c4673f7dc34af94 | cef6cd73cbfc9ebc | agrees | none |
| flows/object-covariance | 0.1.0 | raw | unsigned (signs at next version) |  | 26bfc9171b71f6ab | 7eebcf1ae965bf67 | 26bfc9171b71f6ab | agrees | none |
| flows/observation-od | 0.4.0 | raw | unsigned (signs at next version) |  | 86681788202dbe4b | 016efb4d06d227b3 | 86681788202dbe4b | agrees | none |
| flows/supplemental-omm/nodes/od | 2.1.2 | raw | unsigned (signs at next version) |  | 61ea6f17325ebc99 | d32c772bc4a9c54e | 61ea6f17325ebc99 | agrees | none |
| flows/supplemental-omm/nodes/status | 2.0.0 | raw | unsigned (signs at next version) |  | c90d019b6af5654c | 15e84823d5cf0880 | c90d019b6af5654c | agrees | none |
| foundation/attitude-math | 0.1.0 | raw | unsigned (signs at next version) |  | 84d2bfaed714761f | dc4da18b300e5c55 | 84d2bfaed714761f | agrees | none |
| foundation/cosmology | 0.1.0 | raw | unsigned (signs at next version) |  | ffee33a750598537 | c52aec3bf87488ed | ffee33a750598537 | agrees | agrees |
| foundation/frames | 0.2.0 | bundled | owner-key | module-owner-2026-10-15 | fc289225bb174bdb | fc289225bb174bdb | 7ac3240368b1156c | agrees | none |
| foundation/http-respond | 0.3.1 | raw | unsigned (signs at next version) |  | 77f3c9263b161a49 | 5b8c333e9ecc1132 | 77f3c9263b161a49 | agrees | none |
| foundation/http-route | 0.8.0 | raw | unsigned (signs at next version) |  | bf56ef63d3a814f4 | 3df258686c7bc130 | bf56ef63d3a814f4 | agrees | none |
| foundation/math-bspline | 0.1.0 | raw | unsigned (signs at next version) |  | 2dc637e5c6236c94 | 67814bd6eb560cc3 | 2dc637e5c6236c94 | agrees | none |
| foundation/numerics | 0.1.0 | raw | unsigned (signs at next version) |  | 1eda96fac8323dd3 | 68aee96541bd5cf5 | 1eda96fac8323dd3 | agrees | none |
| foundation/orbits | 0.1.0 | raw | unsigned (signs at next version) |  | 7fb367fa947c69ef | 53b0b810db0bdd89 | 7fb367fa947c69ef | agrees | none |
| foundation/time | 0.1.0 | raw | unsigned (signs at next version) |  | 61abbb27a8358b05 | babe826a03506ad7 | 61abbb27a8358b05 | agrees | none |
| hostcap/clock | 0.2.0 | raw | unsigned (signs at next version) |  | 87213b407b18c407 | db8ece3ff20bfa2d | 87213b407b18c407 | agrees | none |
| hostcap/file | 0.2.0 | raw | unsigned (signs at next version) |  | 97c4e4de65faa75f | c6379fff656326c0 | 97c4e4de65faa75f | agrees | none |
| hostcap/flatsql-query | 0.3.1 | raw | unsigned (signs at next version) |  | 55b298c4e6cc7d6b | 29954dc29a242e82 | 55b298c4e6cc7d6b | agrees | none |
| hostcap/flatsql-store | 0.2.0 | raw | unsigned (signs at next version) |  | 23dadfbf806a1baf | bd109b956247a113 | 23dadfbf806a1baf | agrees | none |
| hostcap/http-request | 0.2.0 | raw | unsigned (signs at next version) |  | 219919c46aa3c884 | 09718fb0e18e54e4 | 219919c46aa3c884 | agrees | none |
| hostcap/node-activity | 0.2.0 | raw | unsigned (signs at next version) |  | 876b4ab4aa198600 | 0ecaae0f874c544d | 876b4ab4aa198600 | agrees | none |
| hostcap/node-status | 0.2.0 | raw | unsigned (signs at next version) |  | 0de13c1391be5f98 | 1cea380376857f2b | 0de13c1391be5f98 | agrees | none |
| hostcap/p2p-discovery | 0.4.0 | raw | unsigned (signs at next version) |  | 2388e2737211a088 | 9b9a4ce9e73bc13a | 2388e2737211a088 | agrees | none |
| hostcap/random | 0.2.0 | raw | unsigned (signs at next version) |  | aa261a12824f9035 | b6a6bd51e54cb826 | aa261a12824f9035 | agrees | none |
| hostcap/storage-ingest | 0.6.1 | raw | unsigned (signs at next version) |  | 4153b3437e27d1d4 | 17d2e8f51c6f1540 | 4153b3437e27d1d4 | agrees | none |
| hostcap/storage-write | 0.2.0 | raw | unsigned (signs at next version) |  | 2a4fc044825fbd6f | 7711f88d7ac4fb61 | 2a4fc044825fbd6f | agrees | none |
| licensing/client-decrypt | 0.2.0 | bundled | owner-key | module-owner-2026-10-15 | 1dfefb2e7d7c81e1 | 1dfefb2e7d7c81e1 | 7f2e5177f7a8f665 | agrees | none |
| licensing/core | 0.2.0 | raw | unsigned (signs at next version) |  | 1e3a0938482e81d1 | 1e3a0938482e81d1 | 1e3a0938482e81d1 | agrees | none |
| licensing/publication-seal | 0.1.0 | raw | unsigned (signs at next version) |  | 73fd21d93c44b9c3 | 73fd21d93c44b9c3 | 73fd21d93c44b9c3 | agrees | none |
| maneuver/star-search | 0.2.0 | raw | unsigned (signs at next version) |  | 7accc66dd3321c6d | 340c0a4fe8cbecfe | 7accc66dd3321c6d | agrees | none |
| network/cloudflare-registrar | 0.2.0 | raw | unsigned (signs at next version) |  | b525a20d4242444e | 659f65dcf93ff1ca | b525a20d4242444e | agrees | none |
| propagator/atmosphere | 0.2.0 | raw | unsigned (signs at next version) |  | a8d1123b83547dd8 | a8d1123b83547dd8 | a8d1123b83547dd8 | agrees | none |
| propagator/cislunar | 0.2.0 | raw | unsigned (signs at next version) |  | af687cae6c825e28 | 051e5f8b26bd1231 | af687cae6c825e28 | agrees | none |
| propagator/events | 0.1.0 | raw | unsigned (signs at next version) |  | 1a856dc5a4903919 | fc14f0d500dedf20 | 1a856dc5a4903919 | agrees | none |
| propagator/ffm | 2.2.1 | raw | unsigned (signs at next version) |  | a9133120775291c4 | 1817fa679f27bf6b | a9133120775291c4 | agrees | agrees |
| propagator/ffm/tests/reference | 1.4.1 | raw | unsigned (signs at next version) |  | e8c7b4f59d54a114 | 8c57bee39264b57f | e8c7b4f59d54a114 | agrees | none |
| propagator/hypersonics | 0.1.1 | bundled | owner-key | module-owner-2026-10-15 | b12acbfa3d3f41f8 | b12acbfa3d3f41f8 | c66477102ac25b5d | agrees | none |
| propagator/keplerian-reference | 1.9.0 | raw | unsigned (signs at next version) |  | 312cd01b88146169 | e0831c8d6ebfb6b1 | 312cd01b88146169 | agrees | none |
| propagator/sdn-ap | 0.6.3 | raw | unsigned (signs at next version) |  | aa3ed22aa61a3a51 | 613c4378c5d2993a | aa3ed22aa61a3a51 | agrees | agrees |
| propagator/sgp4-xp | 0.2.2 | raw | unsigned (signs at next version) |  | 1f8aa4c7e3c01a9e | f3bef86de21cb1ab | 1f8aa4c7e3c01a9e | agrees | none |
| propagator/sgp4 | 1.4.1 | raw | unsigned (signs at next version) |  | 2fe246b716c78a4b | 2fe246b716c78a4b | 2fe246b716c78a4b | agrees | none |
| propagator/solar-system-bodies | 0.5.2 | raw | unsigned (signs at next version) |  | 9d32a15d9333b832 | 06c15b0e7c984212 | 9d32a15d9333b832 | agrees | none |
| storage/credentials | 0.1.1 | raw | unsigned (signs at next version) |  | 401f5d7adf231181 | e64fbc9f6b400ef9 | 401f5d7adf231181 | agrees | none |
| storage/object-s3 | 0.1.0 | raw | unsigned (signs at next version) |  | 956671c19ee9c446 | f6505d62bbbf3497 | 956671c19ee9c446 | agrees | none |

PASS module signatures: 154 current dists: 14 owner-key, 140 unsigned (signs at next version); 154/154 module sections and canonical hashes equal the ledger; 25/25 equal their build-provenance file
