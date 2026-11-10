# Provenance

Vendored from DigitalArsenal/orbit-accuracy-experiments at commit
`c89f2bc21a3b0fa1b5e95c46c9cf717a80e90401` (origin/main, 2026-11-03), so the archive replays of
`heo-frame.e2e.mjs`, `fit-short-arc-priors.e2e.mjs` and `etalon-resonance.e2e.mjs` need no experiments checkout. These
are the files those replays import, directly or through each other, at their repository paths. `PLAN.md` of
xp2-fit-design is not included: only its `frozen()` reads it, and the replays never call that.

Three files differ from the commit. In the first two, a git check that compares an experiments directory with its
registered commit runs at import and cannot run outside that repository; the SHA-256 values below pin the files instead:

- `experiments/xp2-fit-design/common.mjs`: the top-level loop that runs `git diff --quiet <commit> -- <dir>` on the xm and xm3 directories is replaced by a comment.
- `experiments/ffm-atmosphere-xm3/common.mjs`: the top-level `xmUnchanged()` call (the same git check on XM's directory) is replaced by a comment.

The third differs for another reason. `experiments/xp-atmosphere-merit/build.json`'s `packages` object registers the
installs `modulesRoot()` in the same directory's `common.mjs` compares with the modules checkout's: each entry is the
version that folder's committed `package-lock.json` pins (spacedatastandards.org 1.279.0 since 2026-11-05 in
propagator/sdn-ap, propagator/sgp4 and analysis/gp-error-model; it registered 1.276.0, the object of commit
`a7f926fbc781351932d7da77d9aa8ce2ea1cba8a`, until 2026-11-10, and the seven replays stopped at the guard from
2026-11-05 to 2026-11-10). `test/docs-version.e2e.mjs` fails when an entry and its folder's lockfile disagree. These
are the packages that read and write records and host the modules (SDS bindings, FlatBuffers, the SDK harnesses); the
physics is in wasm the installs do not change: the sdn-ap builds each test names (this checkout's dist, a baseline from
git), and the scorer, frames, SGP4 and density-calibration builds `wasmSha256` names, taken from `modulesCommit` by
SHA-256 (foundation/frames 0.2.0 among them: the replays' GCRF truth axes go through it). The file's other
keys stay the vendored commit's: `xp2-fit-design/common.mjs` points XM's
`modulesCommit` at its own (`9a05d899b9`), and `pinned()` then needs XM's wasm SHA-256 values to equal that commit's,
which the wasm values of a7f926f (modules `33ae3750`) do not. The rest of a7f926f is not vendored: its `lib` files no
longer read the $OMM and $OBD of the 0.4 baselines these replays fly.

| File | SHA-256 (vendored) | SHA-256 at the commit |
|---|---|---|
| `experiments/e2-catalog-covariance/estimation-wire.mjs` | `69e1de8935912145588a7c73d5fd6f5859e73f9c1eff59bcc9ad2ebd3c2b7019` | same |
| `experiments/e2-catalog-covariance/ffm.mjs` | `d79af82937437ffd4b4e9e8bf7738544f3787327c24347e6d0929592049c1cd6` | same |
| `experiments/e2-catalog-covariance/product.mjs` | `61d0d91530f02e27e56b9f23531f4b992505b9bf06220b29dec1db44b07f0f7c` | same |
| `experiments/ffm-atmosphere-xm3/build.json` | `f0c31bcba21ee4000b68a4adb8452c853eb2f329024c730916d9292588d4397b` | same |
| `experiments/ffm-atmosphere-xm3/common.mjs` | `f9aa5aed0331f530c524866f6ceb7f90b546d2462f8e3544209d473be66ba663` | `1c586634eff84bda2cecf824b8a3ae9624c6e8406741c4e04ca24fa9c78d93e3` |
| `experiments/ffm-atmosphere-xm3/config.json` | `3eea04347d3e270c62f9a2bea9841b35396898c8778258698f839298570e5c85` | same |
| `experiments/operator-theory/lib/ap.mjs` | `2c7b25dd96eae923a53597d03f425bb864c8015bfb0f28e69159b043f7b16268` | same |
| `experiments/operator-theory/lib/fit.mjs` | `e8393b0264378b3fa2e0901798503ad0eee5e7e50369c55c5774c539bb5db329` | same |
| `experiments/operator-theory/lib/frame.mjs` | `9091d1813a02e616eae03705796eae90b5b70b4ef4f9181e4e6aea69ddaaad50` | same |
| `experiments/operator-theory/lib/host.mjs` | `6d0a787c0cfd11a766fafe8c97b972c7c5ffde4c667c7edb7eaa178727e368a4` | same |
| `experiments/operator-theory/lib/regimes.mjs` | `75ced1bdae24c37c0e4635a3ec333c46831eef7249455774a762385461c4f174` | same |
| `experiments/sdn-gp-starlink-ffm-match/common.mjs` | `0432a38dc50c9907004c3795a3a1bbd672f967b577e70788f4c7021b7c663964` | same |
| `experiments/sdn-gp-starlink-ffm-match/config.json` | `b3496d61fbc4159707c685577e0dbd8e6c3c8c24641eb862cd9a4466d060d76f` | same |
| `experiments/sdn-gp-starlink-ffm-match/lib/containers.mjs` | `e82dee02cd54ece0d30490bd33b5618bfd013364421db4b274e76893e4cbd62a` | same |
| `experiments/sdn-gp-starlink-ffm-match/lib/frames.mjs` | `7da4de7d955cf585b923358bdf585fe136ab0c4970f457f11ac95e516c4fc03b` | same |
| `experiments/sdn-gp-starlink-ffm-match/lib/modules.mjs` | `ffddb616fe892f8b8a1824385e7d2e135a670c8559c49abe40f19fd7133e69f1` | same |
| `experiments/sdn-gp-starlink-ffm-match/lib/sds.mjs` | `65541c6dfad688e1be49b5560be1b3fd1ed5ce4849e21f7f9d261526d158790d` | same |
| `experiments/sdn-gp-starlink-ffm-match/lib/sources.mjs` | `62dfdc28e526dab312d6017bcebb78ff7a23569a39ee7dccaaff08d48c4d5aca` | same |
| `experiments/sdn-gp-starlink-ffm-match/lib/spk-sources.mjs` | `88d364dade829a5081e5ce7b1e11bbd49dd389dc24f8519b1b1e97e126e53313` | same |
| `experiments/sdn-gp-starlink-ffm-match/lib/timeconv.mjs` | `3160e50be761ad55a0f7383c0902db2538b699527168ee226b7a0c560c4d9bc4` | same |
| `experiments/sdn-gp-starlink-ffm-match/lib/windows.mjs` | `91c8a90e643fcff89a7be8ab2712fe7aaeff01c022bbdb098a2e91c5aeff0e55` | same |
| `experiments/xp-atmosphere-merit/build.json` | `c211663690050235e0bfe33f3dd356eb8bf2ed5c2311d68141c7e4a04700bf9b` | `2af0630e62898c867f8116f70edd9d51b206f37e9a9445d9e531d26715e3f3b5` |
| `experiments/xp-atmosphere-merit/common.mjs` | `25a64b944b8ce5109b1564752fcd9f51027a04c4f4e309942bb1e4980bee152e` | same |
| `experiments/xp-atmosphere-merit/config.json` | `bb7931a25739152f8b7a81a215ec4823aef49bb2b8660b9824d32e091bc99127` | same |
| `experiments/xp-atmosphere-merit/lib/modules.mjs` | `e279629b6bcdbf3ba6a449dce12695baee7baef0f8353842b1338cb6181f55e1` | same |
| `experiments/xp-atmosphere-merit/lib/sds.mjs` | `3a817bc386b6514814c8e32fc32b57967f9e2aa634610012319c7b071c913556` | same |
| `experiments/xp-atmosphere-merit/lib/truth.mjs` | `01a8478369e51e99f118d189132d0f2e4a403a0d3c325dad2c607ee38bd2ea3a` | same |
| `experiments/xp-atmosphere-merit/lib/weather.mjs` | `c6e674fa3e476a07d97940648c902b572f14e825d89f5ee4ea1a2ca75b210fba` | same |
| `experiments/xp2-fit-design/build.json` | `722b182c6e95f9d97384711c7b349d62696404b605e0febfdba1738c9a7f2917` | same |
| `experiments/xp2-fit-design/common.mjs` | `0a1ffa9d15397f03ae4f3bfa09c1ee26fa1f3d1531e6ce4df8c0a5ff1c5bedb1` | `de1f87aee59b4180a33b18184cd5ead8dc20b2c2942f6a8b8645969214df8d16` |
| `experiments/xp2-fit-design/config.json` | `4f8ffee52f763b643e02e1bbd62d9be55ca152fb5d43c2dbe90bb2e193bdca85` | same |
| `harness/prw.mjs` | `f7c1ca85bdad35bce35c9a4808c3456f794293505bc6b9bea21f078d88f84985` | same |
| `harness/records.mjs` | `a10e2d4098e443dc731d6f43c11917a2ceacf2c8be8fa4c6d60aea48dff43499` | same |
| `harness/truth-gate.mjs` | `925d2a92170e0a34cbd2b08c6f3d663cce452b8d3e973a7576d3c0ff55f9329e` | same |
