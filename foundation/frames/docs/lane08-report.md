# Lane08 coordinator report — 2026-09-15

Branch: `tmpl/lane08-frames`. Implementation commit: `d8057fc280db01a4e8440d95bbbc1c24658cdf31`.
The following test/evidence commit is the branch tip (see Git history).
Private worktree: `/Users/tj/software/worktrees/modules-lane08-frames`.
Base: `283026f506f0d24e15834a6e438f19f6f984abe1` (origin/main at start).
No merge to main or stack pin update; coordinator owns landing.

## Implemented

- Append-only C++ `AxisType` selectors for GCRF_1996, GCRF_2003, VNC,
  SEZ/ENU/NED, and seven named IAU body-fixed orientations.
- IERS1996 observed-correction IAU76/80/82/94 chain; separately documented
  TN21 fixed-ecliptic precession-rate correction coefficients. IERS2003
  IAU2000A/Lieske-with-rate-adjustments chain via ERFA. Default2006 unchanged.
- Full C++ body rotation series for Moon, Mars, Venus, Mercury, Jupiter,
  Saturn and Sun, including periodic and lunar quadratic terms; TT→TDB.
- Production FRM BODY_FIXED and associated non-Earth pole/topocentric paths
  use the full models. Non-Earth axes no longer require unrelated Earth EOP;
  Earth axes and Earth ground-site origins still require EOP.
- SDK-built production artifact and separate SDK-built C++ reference guest.
  Both have same-byte browser/V8, native WasmEdge0.16.4, and container
  WasmEdge0.16.4 evidence. No production physics was added to JavaScript.

## Files changed (all under foundation/frames/)

```text
README.md
build.mjs
dist/build-provenance.json
dist/isomorphic/module.wasm
src/axis_engine.hpp
src/frames_module.cpp
src/iau_body_models.hpp
docs/reference-frames.md
docs/lane08-report.md
tests/body_fixed.test.mjs
tests/body_fixed_utc_reference.json
tests/body_orientation_reference.json
tests/generate_body_orientation_reference.py
tests/reference_frame_cases.cpp
tests/reference_frame_completeness.test.mjs
tests/run_body_fixed_runtimes.mjs
```

## Authoritative measurements

Source and full units/frame/time/tolerance/rationale metadata are in
[reference-frames.md](reference-frames.md) and the two fixture JSON files.
Errors below are maximum absolute matrix elements unless marked km.

| Case | Authority | Measured error | Tolerance |
|---|---|---:|---:|
| IERS1996, UTC2007-04-05 noon | SOFA cookbook5.2 |3.801126081e-13|1e-12|
| IERS2003, same epoch | SOFA cookbook5.4 |2.969846591e-15|1e-12|
| IERS2010 default, same epoch | SOFA cookbook5.6 |2.636779683e-15|1e-12|
| ITRF→GCRF, Vallado3-15 | CelesTrak/Vallado companion |2.802662493e-7km|1e-6km|
| GCRF→ITRF, Vallado3-15 | same printed independent states |2.477963790e-7km|1e-6km|
| VNC | rational velocity/normal/conormal directions |2.220446049e-16|1e-15|
| ENU,SEZ,NED each | closed-form latitude30°,longitude0 triads |1.110223025e-16|1e-15|
| Moon, worst of4 TDB epochs | NAIF CSPICE_N0067/pck00011 |1.731392807e-13|1e-12|

The22 independently generated TDB body fixtures cover all7 bodies at J2000,
d=2651.5 and d=-1000; Moon also at d=36525. All pass. Their largest error is
5.87e-12 (Jupiter); nonzero nonlunar epochs allow1e-11 for large-W reduction
rounding. J2000 and all lunar cases allow1e-12.

Production FRM wire at UTC2007-04-05T12:00:00, with independent PyERFA2.0.1.5
UTC→TDB and CSPICE_N0067 expected matrices:

| Body | Production WASM error (all three hosts) |
|---|---:|
| Sun |6.27831120e-14|
| Mercury |7.99360578e-14|
| Venus |7.04991621e-15|
| Moon |1.38888900e-13|
| Mars |5.71542813e-13|
| Jupiter |3.69593245e-13|
| Saturn |1.74193993e-12|

Published sources:
[SOFA cookbook](https://www.iausofa.org/s/sofa_pn_c.pdf),
[IERS TN21](https://ilrs.gsfc.nasa.gov/docs/1996/iers_1996_conventions.pdf),
[Vallado companion](https://github.com/CelesTrak/fundamentals-of-astrodynamics/blob/main/software/matlab/ex3_15.m),
[WGCCRE2015](https://doi.org/10.1007/s10569-017-9805-5),
[NAIF PCK](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc).

## Commands and pass lines

Working directory: `foundation/frames`. Native WasmEdge was added with
`PATH=/Users/tj/.wasmedge/bin:$PATH`. Nodev25.4.0, SDK0.8.15,
SDK sdn-emception1.0.0, SDS1.202.0. SDK's normal build used its published
synthetic development-signing fixture; no production signing material.

```text
SDM_MODULE_SIGNING_KEYPAIR_PATH=/Users/tj/software/spacedatanetwork-stack/repos/ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json node build.mjs
Built dist/isomorphic/module.wasm against spacedatastandards.org@1.202.0 with 248 vendored ERFA sources
exit0

node --test tests/sdk_compat.test.mjs
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ skipped 0
exit0

node --test tests/*.test.mjs
ℹ tests 39
ℹ pass 38
ℹ fail 0
ℹ skipped 1
exit0

SDN_FRAME_TRI_RUNTIME=1 node --test tests/reference_frame_completeness.test.mjs
111 checks, 0 failures
PASS browser/V8: authoritative frame checks
PASS native WasmEdge: authoritative frame checks
PASS container WasmEdge: authoritative frame checks
ℹ tests 2
ℹ pass 2
ℹ fail 0
ℹ skipped 0
exit0

node tests/run_body_fixed_runtimes.mjs
PASS production browser/V8: BODY_FIXED (7 bodies) and missing-EOP refusal
PASS production native WasmEdge: BODY_FIXED (7 bodies) and missing-EOP refusal
PASS production container WasmEdge: BODY_FIXED (7 bodies) and missing-EOP refusal
Each host: tests10, pass10, fail0, skipped0
exit0

git diff --check
exit0
```

The routine suite's one skip is the opt-in reference-guest tri-runtime gate;
it was run explicitly and passed above. Existing axis-engine and coordinate
system parity tests remain green. No other requested runtime checks skipped.

Production executable-byte SHA256:
`b8d68863842549739c13e259c908983367393e227d74af8a0c806011f97644e0`.
Reference-guest executable-byte SHA256:
`4631bfe82556b3466955c4dbb2b6c3c5108df19570606ab726ea5a25860fa626`.

## Blockers and precise limitations

1. **SDS selection blocker.** `rfmAxisType` lacks GCRF_1996/GCRF_2003 and the
   named local/orbital selectors. Names appearing in other RFM enums do not
   make them usable by FRM's RFMCoordinateSystem. No schema or wire value was
   invented. The new C++ selectors run in the SDK reference guest; their
   production FRM selection awaits SDS ratification. Existing BODY_FIXED
   plus AXIS_REFERENCE_BODY_ID supports the shipped7-body surface today.
2. **1996 scope.** The implemented TN21 route uses total observed nutation
   corrections, which include precession-rate/frame effects. Zero offsets
   mean legacy FK5, not a high-accuracy GCRF realization. The distinct full
   Herring1996 prediction theory/Tables5.2–5.3 is not implemented. The exposed
   secular coefficients are not advertised as a replacement for that theory.
3. **Lunar naming.** The2015 report omits lunar rotation elements. The lunar
   model is NAIF's retained WGCCRE2009 analytical IAU_MOON series; no claim of
   binary-PCK lunar principal-axis precision is made.
4. **Vallado input precision.** The brief rounds UTC seconds. The companion
   uses28.386009 and collapses JDUT1 to2453101.827406783. The1mm reproduction
   test preserves those published calculation inputs; production date
   precision was not degraded to fit the printed answer.
5. Rates still use the existing numerical differentiation; its truncation
   depends on angular speed and step (documented for faster Jupiter spin).
   This lane's new authoritative body tests measure orientation, not a
   mission-specific angular-rate accuracy guarantee.

## Commit guard

Commits use the owner's explicit override:

```text
GRAPH_PROTOCOL_GENERATION=main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f
GRAPH_GUARD_OVERRIDE=TMPL parity lane lane08 (owner goal 2026-09-15)
```

The guard found an unrelated task claim and logged its refusal as overridden.
Only this lane's exact files were staged; no other lane's files were edited.
