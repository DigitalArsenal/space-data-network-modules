# FFM Fast E2E fixtures

`seeds.json` is the study's eight GCRF states and ballistic/radiation
coefficients, copied unchanged from `harness/inputs/seeds.json`. The E2E
replaces each UTC epoch with `2026-08-01T12:00:00.000000`, exactly as
`map/gen-inputs.mjs` does. Positions and velocities retain their original
values. The standard's `tests/lib/fullForce.mjs` supplies the DE440, EOP,
and space-weather records.

`truth/*.f64` contains a 10 s grid plus every native truth stop over three
days (including 1 s perigee refinement for the eccentric seeds): elapsed seconds, x/y/z in km, and vx/vy/vz in km/s, all little-endian
float64. The frame is GCRF. The T3 truth is the standard C++ force
model at commit `5cc2d3b68edcc89fcab61ab6168fa83f0ed32b86`, integrated with
RKF78 at relative tolerance
`1e-14` and steps of at most 2 s through the study's stops. Its finer native
integration settings provide the accuracy reference; FFM Fast never
generates its own reference values.

The truth header and the shipped resident PPE both use TT. Samples are
elapsed TT seconds from `2026-08-01T12:01:09.184000000` TT, corresponding to
the fixture UTC epoch. The C++ exporter uses the study's unchanged
two-sided quintic Hermite reader between truth stops. It applies no
additional TDB/UTC shift; the standard equations already convert TT to
TDB internally. `truth/truth.json` records input/output hashes, settings,
units, frame, and the complete regeneration command.

The 10 s grid samples resident 300 s Chebyshev interiors. Keeping all native
stops also retains the tighter perigee grid and exact weather boundaries.
The E2E scores both exported PPE and direct resident dense-state queries. It reuses the existing T3 integrations;
exporting more samples does not rerun propagation.

Regenerate all eight fixtures from the repository root, setting `--study`
to the directory containing `data/truth/*-T3.st` and `harness/src/hxio.h`:

```sh
node propagator/ffm-fast/scripts/export-truth.mjs --study /path/to/study --source-commit 5cc2d3b68edcc89fcab61ab6168fa83f0ed32b86
```

The checked-in native exporter reuses that study reader without copying it.
The JavaScript wrapper only compiles, invokes, and records provenance; all
interpolation remains in C++. The output defaults to this fixture directory;
`--output` can select another directory. `truth/truth.json` records the
actual source directory used, native exporter and reader hashes, T3 input
hashes, and exported output hashes. When the study sources change, generate
new T3 inputs first and pass the full commit that produced those inputs.
The E2E verifies the exporter source hash against the fixture provenance.

The E2E uses fixed 60 s RK78 steps for implementation comparisons; its
`1e-3 m` and `1e-6 m/s` limits at three days allow accumulated roundoff
while remaining below FIT/SCREEN requirements. Lever measurements use
the stricter `1e-4 m` position limit. Default-integrator results must meet
FIT (`1 cm` through one day), SCREEN (`1 m`, `1 mm/s` through three days),
and improve on the standard in every seed. GPS/GEO comparisons allow
the stated truth floors (`1e-4 m`,
`1e-7 m/s`). Every FIT and SCREEN limit is a required gate.

`standard.json` pins the unchanged standard artifact and force source.
The source hash must also match the fork header; a mismatch requires
merging the standard changes into the fork before proceeding.
