# Building the modules

Every committed artifact rebuilds byte for byte from this checkout, its lockfiles and the pinned toolchains below.
`scripts/check-artifact-reproducibility.mjs` checks the ledger of what built each artifact.

## Toolchains

| Toolchain | Pin | Source | Used by |
| --- | --- | --- | --- |
| node_modules | each package's `package-lock.json` | `node tools/deps-bundle/deps-bundle.mjs attach <dir>` (stack) or `npm ci` | every build |
| emsdk | 6.0.1 (3.1.51 where a build names it) | `scripts/lib/emsdk-shared.sh`: `$SDN_TOOL_CACHE/emsdk-<version>` | Emscripten builds (`build.sh`) |
| wasi-sdk | 30.0, arm64-macos, archive sha256 `2c2ed99296857e60fd14c3f40fe226231f296409502491094704089c31a16740` | WebAssembly/wasi-sdk GitHub release | the supplemental-omm OD fit core and node |
| Eigen | 5.0.1 (the `Eigen/` tree) | GitLab release archive, or Homebrew `eigen` 5.0.1 | analysis/od, the fit core |
| flatbuffers C++ headers | 25.12.19, git tree `0bb27c3d66f4f33d2f4bd6f6a3fb86eec37755cf` of `include/` | the stack's `repos/main-packages/flatbuffers` | analysis/od, propagator/sgp4, the fit core |

`scripts/toolchain.mjs` holds the last three (version, source, content digest) and resolves them: `path <name>` prints
the directory, made under `$SDN_TOOL_CACHE` (default `~/.cache/sdn-tools`) from its source when absent; a directory is
used only when its digest is the pin's. `ensure` makes all three; `verify --rebuild fit-core` also rebuilds the fit
core from them and compares it with the committed object. The builds below call it themselves; a variable they read
(`WASI_SDK_PATH`, `SDN_OD_EIGEN_DIR`, `SDN_FLATBUFFERS_INCLUDE`, `SDN_FLATBUFFERS_INCLUDE_DIR`,
`FLATBUFFERS_INCLUDE_DIR`) names another directory for a deliberate change of toolchain.

```sh
node scripts/toolchain.mjs ensure      # once per machine; SDN_WASI_SDK_ARCHIVE / SDN_EIGEN_ARCHIVE name local copies
node scripts/toolchain.mjs verify --rebuild fit-core
```

## The consumers of foundation/sgp4-str3

A change to `foundation/sgp4-str3` changes the bytes of every module that compiles it. Rebuild them in the same change,
in this order (the flows link the modules' rebuilt artifacts):

```sh
(cd propagator/sdn-ap && node build.mjs)
(cd analysis/od && node build-wasi.mjs "$PWD/dist/isomorphic/module.wasm")
(cd analysis/od && SDM_MODULE_SIGNING_KEYPAIR_PATH=<owner keypair> bash build.sh)   # browser bundle, owner-signed command module
(cd analysis/od/fit-pipeline && node build.mjs)
for m in density-calibration epoch-state gp-error-model maneuver-detection private-screening; do (cd analysis/$m && node build.mjs); done
(cd propagator/sgp4 && bash build.sh)
(cd flows/supplemental-omm/nodes/od/vendor && bash build-fit-core.sh)   # then its SHA-256 into ../build.mjs and NOTICE.md
(cd flows/supplemental-omm/nodes/od && node build.mjs)                  # npm install in flows/supplemental-omm first
(cd flows/object-covariance && node build.mjs)
(cd flows/open-dca && node build.mjs)
node scripts/check-artifact-reproducibility.mjs --write
```

- `propagator/sgp4` compiles its committed SDS headers (`src/cpp/generated/sds`); `SDN_SGP4_REGENERATE_SDS=1`
  regenerates them from the installed `spacedatastandards.org`, a standards bump to commit with its rebuild.
- `analysis/od`'s `build.sh` reads the SDS package its lockfile pins (`node_modules/spacedatastandards.org`) unless
  `SPACE_DATA_STANDARDS_ROOT` names another, and signs the command module with `SDM_MODULE_SIGNING_KEYPAIR_PATH`
  (without it, the SDK's development key: not a release).
- The supplemental-omm OD node builds with the SDK's compile cache off (`SPACE_DATA_MODULE_SDK_COMPILE_CACHE=0`, set by
  its `build.mjs`): a replayed stub compile stages none of the headers its link reads.
- Before building a change, rebuild once from the unchanged sources and compare with the committed bytes: a build that
  does not reproduce them is a toolchain difference, not the change.
- Parity where a record exists, browser and native WasmEdge (`PATH="$HOME/.wasmedge/bin:$PATH"`):
  `propagator/sgp4` `SDM_PARITY_LANES=browser,wasmedge node tests/parity.mjs`, `analysis/density-calibration` and
  `analysis/maneuver-detection` `node tests/parity.mjs`, `analysis/od` `node tests/parity_alpha5.mjs`,
  `propagator/sdn-ap` `node test/wasmedge-parity.mjs`.
