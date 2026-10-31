# XM7 test build: NRLMSISE-00's 3-hourly branch

A test build on a wip ref, for an exploratory arm on spent windows (orbit-accuracy-experiments, experiments/ffm-3h-ap). Not for main: no module version change, no selection field.

**Selection, test only.** A row carries the 3-hourly ap when AP1 to AP8 are non-negative, not all zero, and their mean agrees with AP_AVG to 1. An instant uses switch 9 = -1 with the 7-element ap_array when the rows of its day and the three days before all carry it. Otherwise it reads daily Ap as before.

**Not touched.** The resident path's daily shortcut (src/cpp/src/resident_dynamics.cpp:129-139), the manifest, the docs, the schema.

**Build.** Unpatched, the snapshot rebuilds the pinned wasm byte for byte (c36f1b14, SPACE_DATA_MODULE_SDK_COMPILE_CACHE=off). Patched: f470c861.

**Independent reference: Orekit 13.1**, LEO400 W1 (20 x 20, Sun, Moon, SRP, NRLMSISE-00), on GFZ's rows in the CSSI layout and the same finals2000A rows; `-Dorekit.simpleEOP=true`. Largest 3D position difference over 24 h, FFM at RK78 1e-13 with steps up to 300 s (up to 30 s in parentheses); Orekit DormandPrince853, steps up to 10 s. The suite's drag tolerance is 0.1 m.

| Epoch | A: test wasm, rows with AP1-8, against switch -1 | B: test wasm, rows without, against switch 1 | C: pinned wasm against switch 1 | D: test wasm, rows with, against switch 1 |
| --- | --- | --- | --- | --- |
| 2026-01-19T00:00 | 0.041 m (0.031) | 0.012 m (0.006) | 0.012 m (0.006) | 14,762 m |
| 2026-01-20T12:00 | 0.009 m (0.010) | 0.058 m (0.041) | 0.058 m (0.041) | 8,891 m |
| 2026-01-25T00:00 | 0.019 m (0.004) | 0.010 m (0.007) | 0.010 m (0.007) | 2,500 m |

D is the size of the branch on this object (A/m 0.02 m2/kg, Cd 2.2, 400 km), not an error.

Reproduce: `make-inputs.mjs`, `run-orekit.sh` with `OrekitReference.java.patch`, then `xm7-orekit-check.mjs`. GFZ data: CC BY 4.0, Matzka et al. (2021), doi:10.5880/Kp.0001. Orekit: CS GROUP, Apache-2.0.
