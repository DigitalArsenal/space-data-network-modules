# Launch trajectory tracking and projected insertion

SDK module for following a launch and naming the orbit it is entering
(`$LAM` → `$LAM`, SDS 1.228.0). Background and validation:
[docs/studies/launch-trajectory-tracking-and-insertion.md](../../docs/studies/launch-trajectory-tracking-and-insertion.md).

| Method | Use |
| --- | --- |
| `track_ascent` | Live or recorded altitude and speed samples → reconstructed ascent, instantaneous impact points and apsides, and the insertion orbit once in orbit |
| `project_insertion` | A scheduled launch → nominal ascent and projected insertion orbit, and the liftoffs that join a reference plane |

Both emit a `$LAM` plus a JSON `report` (phase, azimuth, insertion elements,
latest sample, in-plane liftoffs).

## Inputs

- **`LAUNCH_DATA.SITE`:** pad latitude and longitude in degrees; altitude in
  metres, optional.
- **`LAUNCH_EPOCH`:** liftoff UTC. For `project_insertion` it may be omitted
  when a reference plane and a window (`LAUNCH_DATA.EARLIEST_LAUNCH_TIMES` /
  `LATEST_LAUNCH_TIMES`) are given; the in-plane liftoff is then used.
- **`TARGET_ORBIT`:**
  - `INCLINATION_DEG` and `PASS_DIRECTION` (northbound or southbound);
  - for projections, `INSERTION_TIME_FROM_LAUNCH_S` and optionally periapsis
    and apoapsis altitudes (above the WGS 84 equatorial radius);
  - `PLANE_REFERENCE`, a TEME (`TEMEOFDATE`) OEM of a rendezvous target,
    replaces the inclination.
- **Samples:**
  - `TIME_FROM_LAUNCH_S`, `ALTITUDE_M`, `SPEED_M_PER_S`, with
    `SPEED_REFERENCE` saying whether speed is Earth-relative (as broadcasts
    show it) or inertial;
  - for `project_insertion` these are a comparable flight's profile, which is
    time-scaled so its cutoff falls at the target insertion time;
  - samples sharing a time are averaged;
  - a liftoff anchor is added when the first sample is late.
- **`ASCENT_EVENTS`:** optional. An event named SECO, cutoff or insertion (or
  with phase `ORBIT_INSERTION`) fixes the cutoff time. Without one, cutoff is
  the first end of powered flight followed by 5 s of coast in the samples with
  periapsis above 80 km.

## Method

- **Ground track:** a great circle on the rotating Earth at one Earth-relative
  azimuth.
- **Motion along it:**
  - vertical rate from a local quadratic fit of altitude;
  - horizontal speed `sqrt(v^2 - hdot^2)`;
  - downrange integrated on a 0.25 s grid.
- **Inertial state:** Earth-fixed state plus `omega x r`, rotated by GMST
  (IAU-82) into TEME.
- **Azimuth:** solved by bisection so the insertion state has the target
  inclination.
- **Cutoff speed and altitude:** speed comes from the coast plateau when the
  samples reach it. Altitude in 100 m steps or coarser near cutoff means
  insertion is taken at an apsis.
- **Impact points:** vacuum two-body conics meeting the WGS 84 surface, with
  Earth rotation during the fall.
- **Rendezvous planes:** the Earth-fixed ascent does not depend on liftoff time,
  so RAAN = node longitude + GMST at insertion, and in-plane liftoffs are roots
  of one function of time.

Nothing is propagated past insertion. `TRAJECTORY_OEM` and
`BURN_OUT_VECTORS` are Earth-fixed (km, km/s, Earth-relative velocity). The
OEM is the segment shape `analysis/launch-cola` screens.

## Accuracy

Measured against the first catalog element sets of 12 Falcon 9 launches. The
module reports these one-sigma values in `INSERTION`:

| | RAAN | Argument of latitude | Periapsis | Apoapsis |
| --- | --- | --- | --- | --- |
| Tracking (broadcast telemetry) | 0.45 deg | 0.6 deg | 2 km | 20 km |
| Projection (comparable flight) | 0.25 deg | 1.25 deg | as targeted | as targeted |

## Build and test

```sh
npm install
npm run build
npm test
```

`SPACE_DATA_STANDARDS_ROOT` points the build and tests at an unpublished
standards checkout.

The tests use recorded broadcast telemetry (CRS-16, CRS-14, PAZ; The
Unlicense) and SGP4 truth from each launch's first catalog element set. They
cover:

- tracking a northbound and a southbound ascent to the catalog orbit;
- a partial ascent that is still suborbital, with its impact point downrange;
- a projection from a sister flight;
- the Crew-13 liftoff that joins the ISS plane;
- refusals.

`tests/fixtures/make-fixtures.py` records how the fixtures were made.
