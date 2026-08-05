# OD fit-core build input

`od-fit-core.o` is the frozen relocatable WASI-threads fit core linked into the
independently signed Supplemental OMM OD node. Its SHA-256 is:

```text
e1f1baa093cb52ef6fc880e4aa4de958c2bb074b8dac4d7826c50fa540e94ea8
```

The object was built from this repository's `analysis/od` fitter using base
revision `551f6e178c3332cad46171fd1a0002345271144c` plus the then-uncommitted
multi-epoch complete-arc, OMM/OCM-only, options-aware batch source delta
captured verbatim in `od-fit-core-source.patch`. Its primary multi-epoch path
selects six-hour anchors and fits every state in inclusive eight-hour windows.
If any primary epoch fails convergence or the publication RMS gate, the whole
source is retried with three-hour anchors and inclusive four-hour windows.
Ordered complete inputs shorter than eight hours retain the legacy single-epoch
path; they cannot enter the complete-arc segmentation lane.

An Earth-centered full-PV source whose final state is at or below the WGS-72
120 km reentry interface is classified before SGP4 fitting. It emits exactly one
complete TEME state-series OCM and no OMM, covariance, or OrbitDetermination
block. Normal sources still require complete OMM/OCM pairs. The SGP4 solve fits
only its seven observable parameters; mean-motion derivative is excluded from
LM, DE, and covariance because Vallado SGP4 does not consume it during
propagation. Published OMM derivatives are computed afterward from the final
ordered fitted mean-motion series with one-sided endpoint slopes and
unequal-spacing central derivatives. The delta is not present in the base
revision.
Apply the patch at the repository root to reconstruct the exact compiled-source
state used for this frozen object. The patch SHA-256 is:

```text
c9e6042809c4ec8ce38a878fb0fd6bd1969e2f9bd4f307c924e571a090b17882
```

The matching `od_batch_fit.hpp` is included for the signed node's compile and
has SHA-256
`0cc0ffaad93fa089e274e3d24d6db1aa66c01c801a73392805d8b4d15955817a`.
These inputs are vendored so a release build never reads unstaged source or
objects outside `flows/supplemental-omm/`.

The relocatable object was compiled from a temporary archive, never from the
working `analysis/od` tree, with
`ghcr.io/webassembly/wasi-sdk:wasi-sdk-24` image
`sha256:6ff1234684d0353e914106f698216a16646c64c208f46b3021676b76435cdc50`.
That config is the linux/amd64 image selected by the immutable manifest
`ghcr.io/webassembly/wasi-sdk@sha256:59df2a99139fad8ce3814d725c85a7a1b444ea97519186c4aa0be87cda8e6b1d`;
a clean machine can acquire it with
`docker pull --platform=linux/amd64` followed by that exact manifest reference.
The module-owned generated SDS and common headers come from the recorded base
revision. FlatBuffers headers come from
`DigitalArsenal/flatbuffers@5ab8e415ad13f1e9a75c1cdb1e990f37b1c79d75`.
Eigen 5.0.1 is accepted only when its complete 600-file, 9,947,142-byte header
tree has SHA-256
`b04f3dad6c88b1a90e7276c115eaabf3ba7b6c94059269209d0120a83b5989a2`
under the deterministic verifier framing. The recorded upstream archive is
`https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.tar.gz`
with SHA-256
`e9c326dc8c05cd1e044c71f30f1b2e34a6161a3b6ecf445d56b53ff1669e3dec`;
set `SDN_OD_EIGEN_DIR` to its extracted include root containing `Eigen/` and
`unsupported/`.
Every translation unit used the recorded WASI-threads flags
`--target=wasm32-wasip1-threads -std=c++17 -O3 -matomics -mbulk-memory
-fignore-exceptions -pthread -DNDEBUG -DEIGEN_DONT_PARALLELIZE -ffast-math`;
`wasm-ld -r` produced the frozen object. The OBD builder translation unit is
intentionally absent. `scripts/verify-od-fit-core-reproducibility.mjs` archives
those exact source revisions, checks the Eigen tree, disables container network
access and image pulls, and requires byte identity with both this vendored
object and the separately compiled `od_batch_fit.hpp` ABI header.

The fit core contains the repository's SGP4 orbit-determination implementation
and the bundled SGP4 implementation. Its applicable Apache-2.0 license is
copied from `analysis/od/src/cpp/deps/sgp4/LICENSE` into
`SGP4-LICENSE.txt` (SHA-256
`771e7128d338686ef6321a67cd2e074c537c400225ea05e115bbd065236e609c`).
This notice records provenance and does not alter those terms.
