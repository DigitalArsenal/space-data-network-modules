# Cosmology

One C++ WASM module supplies Planck18 distances, the heliocentric-to-CMB
redshift correction, Galactic-to-supergalactic coordinates, and catalog-based
radial placement. JavaScript only encodes and decodes SDS PCE FlatBuffers.
No cosmology schema is added. `CSO.DISTANCE_MPC` is a luminosity distance and
must never be passed as `comoving_distance_mpc`.

The implementation separates quadrature (`src/cosmology.hpp`), frame math
(`src/frames.hpp`), catalog precedence (`src/placement.hpp`), and wire validation
(`src/wire.hpp`); `src/module.cpp` connects those parts to the SDK ABI.

## Request and result

Call `encodeRequest(methodId, parameters)` and send it through an SDK harness.
Decode its single `result` output with `decodeResult(payload)`. Both ports are
`PCE.fbs` / `$PCE`: one evaluation sample with provider-defined, named real
vectors. Result catalogs describe each vector's type, length, and unit. All
parameters below are arrays of equal length, between 1 and 4096 elements.
Inputs must be finite; unknown names, malformed buffers, mismatched lengths,
and invalid domains fail with no partial output.

| Method | Input vectors | Output vectors |
| --- | --- | --- |
| `distances` | `redshift_cmb` in [0,1100] | `comoving_distance_mpc`, `luminosity_distance_mpc`, `light_travel_distance_mpc`, `lookback_time_gyr` |
| `cmb_redshift` | `redshift_heliocentric` in (-1,1100], `galactic_longitude_rad`, `galactic_latitude_rad` | `redshift_cmb` |
| `supergalactic` | `comoving_distance_mpc`, `galactic_longitude_rad`, `galactic_latitude_rad` | `supergalactic_longitude_rad`, `supergalactic_latitude_rad`, `sgx_comoving_mpc`, `sgy_comoving_mpc`, `sgz_comoving_mpc` |
| `place` | `redshift_cmb`, Galactic angles, optional catalog vectors below | All distance and supergalactic outputs, `placement_redshift_cmb`, `distance_source` |

Galactic longitudes are [0,2π), latitudes [-π/2,π/2]. Supergalactic Cartesian
coordinates use the observer as origin and present-day comoving Mpc. The
supplied direction is preserved at zero distance. These are static angular
frames, with no epoch-dependent solar motion or Galactocentric translation.

```js
const response = await harness.invoke(encodeRequest('distances', {redshift_cmb: [0, 1, 1100]}));
if (response.statusCode !== 0) throw new Error(response.errorMessage);
const samples = decodeResult(response.outputs[0].payload);
```

`place` accepts optional `cf4_luminosity_distance_mpc` (zero means absent),
and paired `tempel2017_group_id` / `tempel2017_group_redshift_cmb` vectors.
Group IDs are integers 1–88662; zero denotes an isolated galaxy and requires
a zero group-redshift placeholder. All members of a supplied group must carry
the same group redshift. The host joins **published** catalog membership by
identifier; the module neither invents membership nor fetches catalogs.

1. A positive CF4 luminosity distance wins. It is inverted with Planck18's
   luminosity-distance relation, then converted to comoving distance. The
   observed redshift, which includes peculiar motion, does not set this radius.
2. Otherwise a Tempel group member takes the supplied group's CMB redshift.
   Every member keeps its own angular direction. This is full radial group
   collapse, not smoothing and not Tempel's separate dispersion-compressed
   `Distcor` column. Their precomputed distances use a different cosmology.
3. Otherwise the individual CMB redshift sets the distance.

`distance_source` values are 2=CF4, 1=Tempel 2017, 0=individual redshift.
A blueshift can be placed using a measured CF4 distance or a valid group;
an unresolved blueshift is rejected. `placement_redshift_cmb` and the returned
lookback/light-travel values describe the selected Planck18 radial placement,
not a measurement of peculiar velocity. Preserve catalog distances and their
uncertainties upstream; this module does not recalibrate CF4 to a new H0.
The catalog supplies luminosity distances in Mpc, never `h^-1 Mpc`.

## Model and sources

The flat model matches [Astropy Planck18](https://docs.astropy.org/en/stable/api/astropy.cosmology.realizations.Planck18.html):
H0=67.66 km/s/Mpc, Om0=0.30966 excluding neutrinos, Tcmb0=2.7255 K,
Neff=3.046, and neutrino masses [0,0,0.06] eV. The rounded Planck total
matter value 0.3111 includes massive neutrinos; using it as Om0 would count
them twice. Photons and evolving neutrino energy density use the Komatsu
2011 fit used by Astropy. Adaptive integration in log(1+z) gives comoving
distance and lookback time; light-travel distance is c times lookback time,
and luminosity distance is (1+z) times comoving distance. This comparison
tests the Planck18 numerical realization, not cosmological parameter uncertainty.

The [Planck 2018 I](https://arxiv.org/abs/1807.06205) dipole is 369.82 km/s
toward Galactic (264.021°,48.253°). For the **observed heliocentric** sightline,
the exact Doppler factor is `sqrt(1-beta²)/(1-beta dot n)`, following
[Planck 2013 XXVII, equation 1](https://doi.org/10.1051/0004-6361/201321556).
Redshifts compose multiplicatively. This includes transverse motion; it is
not the radial-only approximation or an additive `z + v/c` correction.

The supergalactic pole is Galactic (47.37°,6.32°), with zero longitude at
(137.37°,0°), as in [Astropy Supergalactic / Lahav et al. 2000](https://docs.astropy.org/en/stable/api/astropy.coordinates.Supergalactic.html).
Catalog evidence comes from [CF4, Tully et al. 2023](https://cdsarc.cds.unistra.fr/ftp/J/ApJ/944/94/ReadMe)
and [Tempel et al. 2017](https://cdsarc.cds.unistra.fr/ftp/J/A+A/602/A100/ReadMe).
The fixture generator records CF4 PGC 41361 and 44717 and Tempel group 1
(GalID 2, 297963, 314723, 381383, 408210), retrieved 2026-10-17.

## Build and one E2E

Install the exact published dependencies with `npm ci`. Provision the
repository-local LLVM toolchain at `deps/emsdk`, then run `npm run build`.
The SDK 0.9.2 compiler uses `clang --target=wasm32-wasip1-threads` and an
explicit `wasi-sequential` pure-transform justification. The same
`dist/isomorphic/module.wasm` loads in browser, native WasmEdge and Docker
WasmEdge. Browser pages require COOP/COEP and shared memory. The build validates
the embedded manifest and thread model and emits a guest-link object plus
SHA-256 provenance. SDS headers are generated from the pinned published
`spacedatastandards.org@1.220.0`; no sibling schema checkout is consumed.

`npm test` runs **one** E2E, `tests/cosmology-vs-astropy.e2e.mjs`. It checks
266 redshifts (including zero and 1100), 262 sky directions, 35 dipole cases,
10 catalog placements, malformed requests, the maximum batch, and successful
recovery after failures. It validates SDK compliance and requires identical
output bytes and errors from the real Chromium headless shell, native
WasmEdge 0.16.4, and Docker WasmEdge 0.16.4. It starts no persistent services.
Set `SDM_CHROME_BINARY`, `WASMEDGE_BIN`, or `COSMOLOGY_DOCKER_IMAGE` to use
explicit installed runtime paths; only the Playwright headless shell is allowed.

The independent fixture generator uses Astropy 7.2.0 and SciPy 1.17.0 installed
in a **scratch venv outside the repository**. Run that venv's Python on
`tests/generate-oracle.py` to regenerate `tests/astropy-oracle.json`. No module
outputs are used as golden data. Acceptance tolerances are 1e-6 relative for
distances/time, 1e-9 rad for angles, 2e-8 Mpc for Cartesian values and 2e-12
absolute for corrected/inferred redshifts. The stricter auxiliary limits
allow quadrature/rotation roundoff while detecting sign and unit errors.

Independent scale checks use these deliberately broad physical tolerances:

| Target | Reference and rationale | Accepted comoving scale |
| --- | --- | --- |
| Virgo | [NED NGVS reference, 16.5 Mpc](https://ned.ipac.caltech.edu/NED%3A%3ARefcode/2020ApJ...890..128F); test uses CF4 M87 instead of peculiar-velocity-biased redshift | 15–18 Mpc |
| Coma | [NED-hosted distance discussion, 102±6 Mpc](https://ned.ipac.caltech.edu/level5/Sept13/Kissler/Kissler7.html); z=0.023 | 96–108 Mpc |
| Shapley | [NED-hosted review, 140/h Mpc](https://ned.ipac.caltech.edu/level5/Birkinshaw/Birk4_2.html); h=0.6766, z=0.048, extended structure | 190–230 Mpc |
| Sloan Great Wall | [NED-hosted structure discussion](https://ned.ipac.caltech.edu/level5/March12/Coil/Coil9.html), with [Feindt et al. z=0.07–0.08](https://doi.org/10.1051/0004-6361/201321880); representative z=0.07804 | 300–370 Mpc |

These are literature scale checks, not a claim that NED's default cosmology
equals Planck18. The NED legacy object endpoint timed out during verification;
the Sloan radial range comes from the cited primary paper, since NED's review
quotes its **length**, not its distance. Detailed results, runtime identities,
artifact hashes and error maxima are written to `.build/e2e-report.json`.
Publication on host-01 and UI integration are outside this module task.
