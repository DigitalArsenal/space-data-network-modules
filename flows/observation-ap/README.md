# Observation AP: laser normal points to an AP `$OCM`

`flows/observation-ap` 0.1.0 (`flow.mjs`, `observationAp(hosts, ingress)`). B2 part 2's design in the modules: an orbit
determined from laser ranges, carried 24 h back at 60 s under the same dynamics, and fitted as an AP element set. The flow
routes typed records between the modules' shipped artifacts and computes nothing; the modules do the physics.

```
observations ($TDM) + stations ($GST) + earth_orientation + execution
  -> flows/observation-od step  <-> propagator/ffm invoke, analysis/estimation fit_batch   (until it emits)
  -> estimate: Cartesian $OCM at TARGET_EPOCH, PVN, OD_DYNAMIC_PARAMETERS
  -> propagator/ffm propagate_oem: the estimate, the same request's dynamics and Earth orientation, the fitted
     parameters in FORCES; $PCF OUTPUT GCRF from 24 h before the epoch to it at 60 s   -> ephemeris ($OEM)
  -> propagator/sdn-ap fit: ephemeris, the caller's $PCF, the estimate's PVN on provenance, $SPW rows if given
  -> ap_ocm
```

## Ingress (the keys of `ingress`, `plugin-manifest.json`'s input ports)

| | |
| --- | --- |
| `observations` | one `$TDM` per pass, `data-source/ilrs-crd-source` `read_crd` |
| `stations` | one `$GST` per pad, `data-source/ilrs-station-coordinates` `read_sinex` |
| `earth_orientation`, `kernel` | the `$PRW` EARTH_ORIENTATION and NATIVE_INPUT (SPK) records `propagator/ffm` takes |
| `execution` | the `$PRW` EXECUTION_REQUEST of `flows/observation-od`: first guess, TARGET_EPOCH, INTEGRATOR, FORCES, STM_TECHNIQUE, DYNAMIC_PARAMETERS |
| `configuration` | `propagator/sdn-ap` `fit`'s `$PCF`: THEORY and FORCES stated (ATMOSPHERE_MODEL required) |
| `space_weather`, `config` | optional: `$SPW` rows for `fit` under WEATHER_SOURCE RECORDS; the node's ModuleConfig |

`plugin-manifest.json` states the flow's typed ports (method `run`; no artifact of its own). `hosts` are SDK module
hosts (`invoke({ methodId, inputs })`) of `flows/observation-od`, `analysis/estimation`, `propagator/ffm` and
`propagator/sdn-ap`.

## Egress

- `ap_ocm`: the AP `$OCM`, one per run, PROVENANCE the estimate's (SOURCE_KIND Observation, ORIGINATOR ILRS) with PRODUCER
  sdn-ap. Its OD_OBSERVATIONS_USED is sdn-ap's fitted-state count: neither the `$OEM` nor the `$PVN` has an observation
  count to carry.
- `estimate`: the laser `$OCM` (OD_OBSERVATIONS_USED the normal points used, FIT_RMS_KM the range residual RMS).
- `ephemeris`: the carried `$OEM`.

A refusal of any module returns as `refused`, its code and message unchanged (`no-stations: ...`).

## The carry

The request is the caller's `execution` with INITIAL the estimate's GCRF state at its epoch and, for each entry of the
estimate's OD_DYNAMIC_PARAMETERS, the FORCES field `flows/observation-od` sets for its own rounds (IN_TRACK_ACCELERATION
to IN_TRACK_ACCELERATION_M_S2; DRAG_AREA_OVER_MASS and SRP_AREA_OVER_MASS to the drag and reflectivity coefficients);
DYNAMIC_PARAMETERS and SAMPLE_EPOCHS empty. 24 h at 60 s: 1441 states.

## Weather

For a laser sphere the E2E fits under Jacchia 1970 on the theory's flux model with AP's gravity terms (tesseral to 31,
zonal to 20): MEAN_ELEMENT_THEORY AP with no `$SPW` rows. Why: Starlette (A/m about 0.001 m^2/kg, perigee about 800 km)
has a drag signal below the fit's resolution over a day (fitted BTERM 0.0099 m^2/kg, the prior's median), and no module
here writes `$SPW` rows for July 2026 from the archive (`data-source/space-weather` builds from 40 days before its
retrieval; the archive's NOAA files begin 2026-10-08). A caller with rows states NRLMSISE00 and WEATHER_SOURCE RECORDS
and passes them on `space_weather`.

## Source products

Not registered in `flows/source-products/sources.json`: that file has one writer per wave, and this task is not it.

## Test

```sh
npm ci   # or tools/deps-bundle attach
node tests/laser-ap.e2e.mjs
```

On `flows/observation-od`'s Starlette fixture (2026-07-13T15 to 07-15T15, 335 normal points, 13 pads) the flow emits
one AP `$OCM`; sdn-ap `propagate` given that `$OCM` alone, on the carry's grid in GCRF, returns states within its
FIT_STATISTICS RMS of the carried `$OEM`.
