# Clean-main baseline, lane 09 second pass

Source: `e4612363998bd1c732aaab2b242de0015104f096`, detached private worktree
`/Users/tj/software/worktrees/modules-python-astro-baseline`. The checkout was
clean before committed-artifact checks. No canonical checkout was edited.
No commits were created. Build outputs remain in the disposable baseline.

## Original failures reproduce on clean main

`node --test --test-reporter=tap <test>` in each module; WasmEdge 0.16.4 on PATH,
published SDK 0.8.18 and JS SDS 1.202.0. Exact commands and logs:
[baseline-checks.json](baseline-checks.json).

| Module | Test | Pass / fail | Precise failure |
| --- | --- | --- | --- |
| HPOP | `tests/sdk_compat.test.mjs` | 9 / 1 | `built artifact passes SDK compliance checks`: missing-canonical-file-identifier, missing-aligned-file-identifier, paired-type-identity-mismatch |
| Conjunction | `tests/sdk_compat.test.mjs` | 9 / 1 | `built artifact passes SDK compliance checks`: missing-canonical-root-type-name, missing-canonical-file-identifier, paired-type-identity-mismatch |
| Lambert | `tests/sdk-compat.test.mjs` | 14 / 2 | `built artifact loads through the WasmEdge server path when available`; `built artifact returns deterministic circular benchmark output in browser and WasmEdge`; both: `WasmEdge command harness exited with code 1.` |
| Access | `test/manifestContract.test.mjs` | 0 / 1 | imports `/Users/tj/software/worktrees/spacedatastandards.org/lib/js/ACW/main.js`; `ERR_MODULE_NOT_FOUND` before tests execute |

## Builds and post-build checks

[build-checks.json](build-checks.json) records exact argv, environment, return
codes, hashes, failing names and log paths. Commands below run from module root.

| Module | Build command | Build | Test pass / fail | Byte-identical to committed e461 artifact |
| --- | --- | --- | --- | --- |
| SGP4 | `bash build.sh` | PASS | 7 / 0 | yes |
| HPOP | `bash build.sh` | PASS | 9 / 1 | yes |
| Estimation | `node build.mjs` | PASS | conformance 1 / 0 | yes |
| Conjunction | `bash build.sh` | PASS | 9 / 1 | no |
| Access | `node build.js --force` | PASS | original 0 / 1; layout-adapted 5 / 0 | no |
| Events | `node build.mjs` | FAIL | committed artifact 2 / 0 | no rebuilt artifact |
| Lambert | `node build.mjs` | PASS | 14 / 2 | yes |
| Time | `node build.mjs` | PASS | 4 / 0 | yes |
| Frames | `node build.mjs` | PASS | 5 / 0 | no |

Events is a new main integration failure: its build amalgamates the frames axis
engine but omits the new `iau_body_models.hpp` dependency. The compiler reports
`fatal error: 'iau_body_models.hpp' file not found` at generated line 72881.
The committed events artifact was restored directly from its e461 git object
and passes both new DE440 SDK cases (browser and native WasmEdge).

Access uses existing OrbPro build helpers copied into ignored baseline
`analysis/access/node_modules/.orbpro-build`, with SDK headers and the local
EMSDK linked read-only. The helper's build workspace and EM_CACHE are private.
Its initial build lacked FLATBUFFERS_INCLUDE_DIR; the recorded final build
sets that variable and succeeds. Its test-only loader redirects the two
hard-coded sibling imports; no tracked test or expected value was changed.
Canonical SDS has no lib/js, so the adapted check uses published JS SDS 1.202.0.
SGP4's first post-build check similarly failed on canonical SDS's missing
lib/js; retesting with published JS SDS gives 7 / 0.

Build schemas came from canonical SDS 1.217.0+1789398499674 at git
`b76da41467e260c83b3432ba7f34a1eb05cc7ac7`; SDK was 0.8.18. A later isolated
npm installation confirmed published SDS 1.217.0 is available. Of its 248
schema files, only `schema/RFM/main.fbs` differs from the canonical checkout.
That published 1.217 copy was not used by these test receipts. Git status shows
canonical `schema/RFM/main.fbs` and `lib/py/RFM/rfmAxisType.py` are modified;
the build schema inputs therefore include canonical working-tree changes and
must not be attributed solely to the b76da414 commit.

The Python lane retains committed e461 artifacts. Rebuilt conjunction, access
and frames artifacts differ and must not be described as verification of the
exact distributed bytes. [artifact-section-differences.json](artifact-section-differences.json)
records conjunction/access section differences; all full artifact hashes are
in build-checks.json. Frames differs even after removing the publication
trailer (395473 vs 395517 loadable bytes).

### Signing disclosure

The frames build script automatically invoked `scripts/sign-module-artifact.mjs`
and loaded the repository development test key through an existing stack-layout
symlink, even with SDM_MODULE_SIGNING_KEYPAIR_PATH unset. This was not anticipated
when the build was launched. No private-key contents were printed, copied or
included in evidence; only public metadata appears in the build log. No further
signing was performed. No deployment or publication occurred.

Numerical Python and three-runtime parity evidence are owned by the parent lane;
these baseline checks do not claim that coverage.
