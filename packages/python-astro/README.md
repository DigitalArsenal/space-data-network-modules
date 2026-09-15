# spacedatanetwork-astro

NumPy interfaces to nine pinned **C++ WASM** modules: SGP4, HPOP, estimation,
conjunction assessment, access, events, Lambert Izzo, time and frames. Python
marshals inputs and orchestrates calls; WasmEdge **0.16.4** executes all physics.

**Status:** all nine Python numerical tests pass. This is a prerelease with
known upstream build, manifest and SDK browser-harness failures; see
[verification](docs/verification.md). No PyPI publication is performed.

## Install on macOS arm64

Install WasmEdge 0.16.4 using the SDN repository's
`scripts/install-wasmedge.sh`, then install the locally built wheel:

```sh
python3 -m pip install dist/spacedatanetwork_astro-*-macosx_11_0_arm64.whl
python3 -m spacedatanetwork_astro doctor
```

The host locates `libwasmedge` through `WASMEDGE_LIB`, `~/.wasmedge/lib`, then
system paths. `WASMEDGE_LIB` may point directly to `libwasmedge.dylib`.
The wheel requires NumPy, FlatBuffers and cryptography (used by generated REC imports); it contains the original WASM bytes
and vendored generated SDS bindings, but does not bundle the native runtime.
Python 3.10+ is declared; this build is tested with Python 3.14 on macOS arm64.

## SGP4 and HPOP in 20 lines

This is the executable [example](examples/sgp4_hpop.py), tested against the wheel.
Its two initial states have different frames and units, stated at each call.

```python
import numpy as np
from spacedatanetwork_astro import sgp4, hpop
# Vallado verification satellite; OMM angles are degrees, motion rev/day.
omm = dict(NORAD_CAT_ID=5, OBJECT_NAME="Vallado", OBJECT_ID="1958-002B",
           EPOCH="2000-06-27T18:50:19.733568", MEAN_MOTION=10.82419157,
           ECCENTRICITY=0.1859667, INCLINATION=34.2682,
           RA_OF_ASC_NODE=348.7242, ARG_OF_PERICENTER=331.7664,
           MEAN_ANOMALY=19.3264, BSTAR=0.000028098,
           MEAN_MOTION_DOT=0.00000023, MEAN_MOTION_DDOT=0.0)
# SGP4 returns ECEF metres and metres/second.
ecef = sgp4(omm, [2451726.28495062])
print("SGP4 ECEF [m, m/s]:", ecef[0])
# Separate inertial state from the Tudat fixture; HPOP epoch is JD TDB.
r_km = np.array([6993.000000000001, 0., 0.])
v_km_s = np.array([0., 5.3412039886853915, 5.341203988685391])
epoch_jd = 2451545.0
state = hpop(r_km, v_km_s, epoch_jd, epoch_jd + 1170. / 86400.)
print("HPOP inertial [km]:", state.position)
print("HPOP inertial [km/s]:", state.velocity)
assert np.isfinite(state.position).all()
```

## Interfaces

| Interface | Input / output |
| --- | --- |
| `sgp4(omm, julian_dates)` | CCSDS OMM mapping + UTC-like JD → `(N,6)` ECEF metres and m/s |
| `SGP4()` | Context-managed resident catalog; `ingest()` upserts by NORAD, `propagate()` returns states with explicit frame metadata |
| `hpop(r_km, v_km_s, epoch_jd, target_jd, forces=..., integrator=...)` | Earth inertial km/km/s, **JD TDB** → `State` with NumPy arrays |
| `initial_orbit(positions_m, method='GIBBS')` | `(3,3)` inertial positions → middle-epoch state in metres and m/s; also Herrick-Gibbs |
| `estimation(request, propagator_samples=...)` | Advanced generated EstimationEnvelope for WLS/EKF/UKF/RTS or simulation; caller chooses propagator |
| `estimation_samples(epochs, states, stms)` | Marshal `(N,6)` SI states and `(N,6,6)` STMs supplied by that propagator |
| `conjunction_assessment(catalog, start_jd=..., threads=...)` | OMM mappings → screen results; also accepts generated requests for TCA/Pc/Alfano methods |
| `conjunction_track(epochs, states_km, norad_id=...)` | Marshal `(N,6)` caller-propagated tracks; explicitly select reference frame |
| `access(julian_dates_tt, positions_ecef_m, stations)` | `(N,3)` ECEF metres + geodetic station mappings → access windows |
| `events(epochs_utc, states_km, request)` | `(N,6)` OEM states + generated EVL configuration → event report |
| `lambert_izzo(r1_km, r2_km, tof_seconds, ...)` | LMS parameters → LMO branches with NumPy velocity arrays in km/s |
| `convert_time(epoch, source='UTC', target='TAI')` | ISO label → complete TIM conversion result |
| `transform_position(position, operation=1, dcm=...)` | FRM fixed-frame/geodetic position transform; radians/metres for LLA |

Advanced ratified objects live under `spacedatanetwork_astro.sds`, module-local
objects under `.invoke.orbpro`, and SGP4 legacy batch objects under
`.invoke.legacy.orbpro`. `Module`/`Frame` expose the typed binary PIV/TAB boundary
for additional artifact methods. Requests and results are generated FlatBuffers;
HPOP's existing JSON-in-PIV invoke payload is documented in
[dependencies](docs/dependencies.md). No substitute Python physics is provided.

## Reproduce and build

From the modules root, install its pinned npm dependencies and build the modules
through their SDK-backed build scripts. A wheel build only packages reviewed
outputs; it does not compile or download WASM.

```sh
python3 -m venv /tmp/astro-build
. /tmp/astro-build/bin/activate
python -m pip install setuptools==84.0.0 build wheel numpy flatbuffers==25.12.19 cryptography==46.0.4 pytest
python packages/python-astro/prepare_artifacts.py
python packages/python-astro/scripts/vendor_sds.py --sds-repo /path/to/spacedatastandards.org --check
node packages/python-astro/scripts/extract_vectors.mjs
PYTHONPATH=packages/python-astro/src:packages/python-astro python -m pytest -q -s packages/python-astro/tests
cd packages/python-astro
python -m build --wheel --no-isolation -C--build-option=--plat-name=macosx_11_0_arm64
python -m build --sdist --no-isolation
```

For an intentional artifact update, `scripts/pin_artifacts.py --source-revision
<SHA>` first checks the source artifacts against that commit. Then rerun
`prepare_artifacts.py` and vendoring. Artifact, binding and wheel hashes are
checked by the build backend; a stale lock fails the build.

### Linux and Windows builds

Use the same source distribution, install WasmEdge **0.16.4** for the target
architecture and set `WASMEDGE_LIB` to its native shared library. Run the same
Python tests on that host. `python -m build --wheel` makes a portable `py3-none-any`
wheel because the distribution contains Python and platform-neutral WASM.
The macOS-specific tag above identifies the host validated in this lane.
For target-specific internal wheels, use `--plat-name=linux_x86_64`,
`linux_aarch64`, `win_amd64`, or `win_arm64`; do not label these manylinux without
its separate compatibility validation. Windows dependent DLLs must be on the
loader search path. Linux/Windows wheels and execution were **not** tested here.

## Provenance and limitations

The artifacts are exactly the committed bytes from modules
`e4612363998bd1c732aaab2b242de0015104f096`. SDS generated source is immutable
`b76da41467e260c83b3432ba7f34a1eb05cc7ac7` (1.217.0), independent of concurrent
working-tree edits. `artifacts.lock.json` and `bindings.lock.json` record hashes,
module-declared dependency versions, schema sources and compiler stamps.

See [authoritative vectors](docs/authoritative-vectors.md),
[verification](docs/verification.md), and [binding generation](docs/sds-generation.md).
The Python measurements validate the selected cases, not every operation of all
nine engines. Additional HPOP trajectory schemas, clean SDK parity for the two
legacy artifacts, and the events rebuild remain upstream work.
