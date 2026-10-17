# FFM Fast E2E fixtures

`seeds.json` is the study's eight GCRF states and ballistic/radiation
coefficients, copied unchanged from `harness/inputs/seeds.json`. The E2E
replaces each UTC epoch with `2026-08-01T12:00:00.000000`, exactly as
`map/gen-inputs.mjs` does. Positions and velocities retain their original
values. The standard's `tests/lib/fullForce.mjs` supplies the DE440, EOP,
and space-weather records.

`truth/*.f64` contains 865 rows per seed, at 300 s intervals over three
days: elapsed seconds, x/y/z in km, and vx/vy/vz in km/s, all little-endian
float64. The frame is GCRF. The original T3 truth is the standard C++ force
model at commit `4d2348a6`, integrated with RKF78 at relative tolerance
`1e-14` and steps of at most 2 s through the study's stops. Its independent
integration settings provide the accuracy reference; FFM Fast never
generates its own reference values.

The truth header and the shipped resident PPE both use TT. Samples are
elapsed TT seconds from `2026-08-01T12:01:09.184000000` TT, corresponding to
the fixture UTC epoch. The C++ exporter uses the study's unchanged
two-sided quintic Hermite reader between truth stops. It applies no
additional TDB/UTC shift; the standard equations already convert TT to
TDB internally. `truth/truth.json` records input/output hashes, settings,
units, frame, and the complete regeneration command.

Regenerate all eight fixtures with one command from this worktree:

```sh
node /private/tmp/claude-501/-Users-tj-software-spacedatanetwork-stack/8e63bb40-3edf-4af4-836a-b5a00536a938/scratchpad/ffmspeed/work/export-truth.mjs --study /private/tmp/claude-501/-Users-tj-software-spacedatanetwork-stack/8e63bb40-3edf-4af4-836a-b5a00536a938/scratchpad/hpop-interval --output propagator/ffm-fast/tests/fixtures/truth --source-commit 4d2348a6
```

The exporter and its compiled scratch tool remain outside the module.
After regenerating the study's T3 files with updated standard C++ sources,
run this command again, replacing `4d2348a6` with the commit that produced
the new truth files.

The E2E uses fixed 60 s RK78 steps for implementation comparisons; its
`1e-3 m` and `1e-6 m/s` limits at three days allow accumulated roundoff
while remaining below FIT/SCREEN requirements. Lever measurements use
the stricter `1e-4 m` position limit. Default-integrator results must meet
SCREEN (`1 m`, `1 mm/s` at three days) and improve on the standard in
every seed. GPS/GEO comparisons allow the stated truth floors (`1e-4 m`,
`1e-7 m/s`). FIT (`1 cm` at one day) is informational.

`standard.json` pins the unchanged standard artifact and force source.
The source hash must also match the fork header; a mismatch requires
merging the standard changes into the fork before proceeding.
