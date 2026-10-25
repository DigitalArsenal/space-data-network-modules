# OD fit-core build input

`od-fit-core.o` is the relocatable WASI-threads fit core linked into the
independently signed Supplemental OMM OD node. Its SHA-256 is:

```text
68660fb44ab2ab550f2c9363fa1ba1c45e938c333d6536dcf42e89094a003b3d
```

`build-fit-core.sh` rebuilds it byte for byte. It takes this repository's
`analysis/od` fitter sources at base revision
`551f6e178c3332cad46171fd1a0002345271144c`: OD's own files, `common/` and the
generated SDS headers of `licensing/core`, never the `deps/` trees. It applies
`od-fit-core-source.patch` (the multi-epoch complete-arc delta, and the fitter's
SGP4 calls on the clean-room SGP4/SDP4 base `foundation/sgp4-str3`, as
`analysis/od` makes them). It compiles the fitter's eleven translation units
with wasi-sdk 30.0 and partial-links them. The patch SHA-256 is:

```text
09174a2c731afb6da671976429504a5956d978ed91590bf2c5153fbe56791779
```

The build inputs:

| Input | Version |
| --- | --- |
| wasi-sdk | 30.0 (clang 21.1.4, libc++ 21), `wasi-sdk-30.0-arm64-macos.tar.gz` from the WebAssembly/wasi-sdk GitHub release, SHA-256 `2c2ed99296857e60fd14c3f40fe226231f296409502491094704089c31a16740` as published |
| `foundation/sgp4-str3` | tree `d57437de4dd5ec163a65a72d3cb381eca197a708` |
| Eigen | 5.0.1 (Homebrew, `SDN_OD_EIGEN_DIR`) |
| FlatBuffers headers | main-packages `flatbuffers` `01c1c01e6c9cf3ac55ecfea42169e1ce3136a7de` (`SDN_FLATBUFFERS_INCLUDE`) |

The node is compiled against the matching `od_batch_fit.hpp`, which has
SHA-256 `af3c5da73e117c0ecaa9dfef53f8359b6ac0e1f42a3e154b5fe709c2d21f6989`.
These inputs are vendored so a release build never reads unstaged source or
objects outside `flows/supplemental-omm/`.

The fit core holds the repository's SGP4 orbit-determination code
(`analysis/od/src/cpp/src/sgp4_fitter.cpp` and the fitter it serves) and the
clean-room SGP4/SDP4 base `foundation/sgp4-str3`. It holds no third-party
propagator code and no libsgp4 code.

`SGP4-LICENSE.txt` is the Apache-2.0 text of libsgp4 (Daniel Warner), copied
from `analysis/od/src/cpp/deps/sgp4/LICENSE` (SHA-256
`771e7128d338686ef6321a67cd2e074c537c400225ea05e115bbd065236e609c`). libsgp4 is
not compiled into this object. The file is the Apache-2.0 text, which is also
the repository's license for this directory's own files.
This notice records provenance and does not alter any terms.
