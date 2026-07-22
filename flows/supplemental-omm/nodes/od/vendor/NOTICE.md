# OD fit-core build input

`od-fit-core.o` is the frozen relocatable WASI-threads fit core linked into the
independently signed Supplemental OMM OD node. Its SHA-256 is:

```text
7ebc7409148e085759c976ae07f01c378b2f4f5a3662bd21a7c9b6ed6608782e
```

The object was built from this repository's `analysis/od` fitter using base
revision `551f6e178c3332cad46171fd1a0002345271144c` plus the then-uncommitted
multi-epoch complete-arc source delta captured verbatim in
`od-fit-core-source.patch`. The multi-epoch changes are not present in that base
revision. Apply the patch at the repository root to reconstruct the exact
compiled-source state used for this frozen object. The patch SHA-256 is:

```text
18af55440c188144082029cacafbaed35a813740d0aefc15aa43cd27bf8dd761
```

The matching `od_batch_fit.hpp` is included for the signed node's compile and
has SHA-256
`af3c5da73e117c0ecaa9dfef53f8359b6ac0e1f42a3e154b5fe709c2d21f6989`.
These inputs are vendored so a release build never reads unstaged source or
objects outside `flows/supplemental-omm/`.

The fit core contains the repository's SGP4 orbit-determination implementation
and the bundled SGP4 implementation. Its applicable Apache-2.0 license is
copied from `analysis/od/src/cpp/deps/sgp4/LICENSE` into
`SGP4-LICENSE.txt` (SHA-256
`771e7128d338686ef6321a67cd2e074c537c400225ea05e115bbd065236e609c`).
This notice records provenance and does not alter those terms.
