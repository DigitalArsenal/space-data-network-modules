# TMPL lane09 second-pass handoff

Branch: **tmpl/python-astro**. Push only; coordinator integrates main.

Implementation commits:

- `82b85fb05048c8dc9cf795d186e67be2d4ae5808`: merge main baseline
  `e4612363998bd1c732aaab2b242de0015104f096` into the private lane branch.
- `b7b226ea4179ec5dbf544a0250b6aa035e43753f`: immutable SDS/module bindings,
  licenses, artifact repin, package dependencies and build integrity gates.
- `1524842acf4e6057311814865ad2b57c38c0199b`: ctypes host, nine wrappers,
  NumPy helpers, authoritative vectors, tests and executable example.

The final receipt commit follows these. Prior `d280cd1` and `dbd1471` remain
ancestors. No main merge or stack-pin update was performed by this lane.

## Files and implementation

All lane-owned changes are under `packages/python-astro/`; the upstream merge
also carries the already-landed lane01/lane08 changes. The exact package file
inventory is [second-pass-files.txt](evidence/second-pass-files.txt).

- `src/spacedatanetwork_astro/runtime.py`: WasmEdge0.16.4 ctypes C API, WASI,
  artifact/trailer loading, PIV/TAB, size-prefix transport, aligned guest memory,
  serialized lifetime, native threading and actionable discovery errors.
- `api.py`, `_codec.py`, package entrypoints: nine wrappers, NumPy arrays,
  persistent SGP4 catalog upsert, caller-selected estimation propagator samples,
  conjunction GP/track input helpers and frame/unit metadata.
- `sds/`, `invoke/`, `bindings.lock.json`, `scripts/vendor_sds.py`: immutable SDS
  1.217.0 source and generated module schemas, import rewriting, full source
  manifest, artifact/compiler/schema stamps and license notices.
- `artifacts.lock.json`, `_version.py`, `scripts/pin_artifacts.py`,
  `pyproject.toml`, `build_backend.py`, `MANIFEST.in`: reviewed byte-pinned wheel
  and sdist packaging. Existing `prepare_artifacts.py` remains the staging gate.
- `tests/test_{runtime,api_contract,numerical,vendoring}.py`,
  `tests/fixtures/module-vectors.json`, `scripts/extract_vectors.mjs`: executable
  runtime/binding tests and expected values extracted from existing module tests.
- README, `examples/sgp4_hpop.py`, dependency/vector/verification/generation docs,
  and `docs/evidence/second-pass*`: commands, measured errors and limitations.

No physics was implemented in Python or JS. No SDS schema was invented.

## Numerical results

The fresh installed wheel passes **36 tests and2194 subtests**. All9 Python
numerical cases pass on the distributed primary artifacts.
Sources, frame/time scale and tolerance rationales:
[authoritative-vectors.md](authoritative-vectors.md).

| Module / authority | Measured maximum error | Existing tolerance |
| --- | --- | --- |
| SGP4 / Vallado |3.63960862159729e-6m radius|.01m|
| HPOP / Tudat6 samples |1.676726684077683e-4km;1.810651650404945e-7km/s|5e-4km;5e-7km/s|
| Estimation / Vallado Gibbs |9.094947017729282e-13m/s|1e-9m/s|
| Conjunction / SOCRATES3 pairs |.0007644295692443848s;4.255402527124869m;.4787075052021805m/s|.010s;5m;5m/s|
| Access / Orekit6 elevations |4.731326441742567e-12rad|1e-10rad|
| Events / analytic4 nodes |0s at report precision|.001s|
| Lambert / circular quarter orbit |2.322023968427338e-15km/s|1e-6km/s|
| Time / Orekit UTC→TAI |0s|1e-12s|
| Frames / Basilisk fixed DCM |0|exact|

The installed-wheel test receipt also includes doctor/example output:
[evidence/second-pass-installed-wheel.log](evidence/second-pass-installed-wheel.log).

## Builds and parity

Exact commands, pass/fail lines, dependencies, clean-main failure names and
hashes: [verification.md](verification.md) and
[evidence/second-pass-baseline/README.md](evidence/second-pass-baseline/README.md).

- macOS arm64 wheel and sdist build: PASS. SHA256 and source-vs-distribution
  byte checks are in [second-pass-distribution.json](evidence/second-pass-distribution.json).
- Nine SDK module builds attempted:8PASS; eventsFAIL (`iau_body_models.hpp`
  omitted from amalgamation). Five rebuilt artifacts match committed bytes;
  access/conjunction/frames differ, so committed artifacts remain packaged.
- SDK command parity on browser/V8 + native/container WasmEdge:7PASS;
  access/conjunctionFAIL because browser command harness rejects legacy profile.
- Clean-main original failures reproduce: HPOP9/1, conjunction9/1,
  Lambert14/2, access0/1. Access layout-adapted test5/0. These are not introduced
  by Python. Estimation has no sdk_compat suite; its conformance check passes1/0.

## Unfinished and scope limits

- Correct the upstream events include, SDK manifest identity failures, Lambert
  command runner and legacy access/conjunction parity harness/profile issues.
  This lane does not claim the broader tri-runtime gate green.
- HPOP has no source `.fbs` for its named InvokeRequest/InvokeResponse. Its
  actual JSON-in-PIV payload is mirrored; extra trajectory-segment schema sources
  are also absent. Advanced full estimation/events requests use generated objects.
- No missing generated SDS symbol was observed; all imports resolve with declared
  dependencies, so there is no artificial expected-failure or silent skip.
- Linux/Windows execution and wasi.thread-spawn execution remain unverified.
  Platform build instructions are in README. No PyPI publication occurred.
- Frames' baseline build unexpectedly invoked its repository development signer.
  No key contents were printed/copied/packaged; disclosure is in the baseline
  receipt. No further signing, deployment or publication occurred.

The canonical checkout was not edited. The private lane worktree and dirty
baseline worktree remain for coordinator review. The prescribed
`GRAPH_PROTOCOL_GENERATION=main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f` and
`GRAPH_GUARD_OVERRIDE="TMPL parity lane python-astro (owner goal 2026-09-15)"`
were used. The first commit attempt hit an unrelated ROOT_OPERATION_ACTIVE lock;
retry succeeded with the authorized override and was logged by the guard.
