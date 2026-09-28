# Launch trajectory tracking and projected orbit insertion

Question: can the network follow a launch in flight and say which orbit it is
putting objects into, before, during and just after the ascent?

Answer: yes, to a stated accuracy, from sources the network can read today.

- **In flight:** broadcast speed and altitude reconstruct the ascent. Output:
  ground track, instantaneous impact point, current osculating orbit, and the
  insertion orbit at engine cutoff. Measured RAAN error is 0.41 deg RMS over 12
  launches.
- **Before flight:** a scheduled launch's insertion orbit is projected from its
  pad, liftoff time, target orbit and a comparable flight's profile. Measured
  RAAN error is 0.21 deg RMS over 9 launches.
- **Rendezvous launches:** the module finds the liftoff time that joins a
  target's orbit plane. For Crew-13 it lands 61 s before the published time.

Built as `analysis/launch-trajectory` on SDS 1.228.0 (`$LAM`).

## What already existed

- **The 2026-07-30 launch intelligence design**
  (`docs/superpowers/specs/2026-07-30-launch-intelligence-program-design.md` in
  the stack):
  - a source census of hazard areas, notices, social and cislunar sources;
  - the SDS launch family.
- **SDS launch family:**
  - `$LDM` is the planned launch.
  - `$LND` is a sensed launch.
  - `$LNE` is the launch registry.
  - `$BOV` is the Earth-fixed burnout vector.
  - `$LAM` is the trajectory hub. It already carried samples (latitude,
    longitude, altitude, downrange, speed, flight-path angle), impact-point
    arrays, events, `BURN_OUT_VECTORS`, a trajectory OEM/OCM and the propagator
    name.
- **`analysis/launch-ascent`:** a 3-DOF point-mass ascent simulator with
  Falcon 9 defaults and a Crew-8 reference package. It reads and writes JSON
  labelled `$LAM`, not `$LAM` FlatBuffers. It answers "what would this vehicle
  do". This study answers "where is this flight going", from observed or
  published numbers.

## Sources

Probed 2026-09-28.

| Source | What it gives | Access |
| --- | --- | --- |
| Launch broadcasts | Speed (Earth-relative) and altitude overlays, 1-30 Hz. The only public in-flight numbers. | Video. No machine feed from any provider. |
| [Telemetry-Data](https://github.com/shahar603/Telemetry-Data) | Those overlays captured at 30 fps for 35 Falcon launches, 2015-2019. | The Unlicense. Used here for validation. |
| Launch Library 2, `mode=detailed` | `timeline` event times (MECO, SECO-1, deployment), `launch_designator` after launch, `flightclub_url`. | 15 requests/hour anonymous, already pulled hourly by the notices flow. |
| Flight Club API (`api.flightclub.io/v3`) | Simulated trajectories per launch. | 401 without a key. |
| r/SpaceX API (`api.spacexdata.com/v4`) | Historical liftoff times. | 525 (down). |
| Space-Track / CelesTrak GP | First catalog element sets of launched objects, 0.4-4 h after liftoff in the sample below. | Already archived by the network. |

No provider publishes a live state-vector feed. The network's answer is a
standard shape any publisher can fill: `$LAM` samples of time, altitude and
speed (an observer reading a broadcast, or an operator), or full states in
`TRAJECTORY_OEM`.

## Method

### Ascent model

The ground track is a great circle on the rotating Earth. It leaves the pad at
one Earth-relative azimuth. The altitude and speed samples fix the motion along
it:

- vertical rate from a local quadratic fit of altitude;
- horizontal Earth-relative speed `sqrt(v^2 - hdot^2)`;
- downrange integrated along the circle.

The inertial state is the Earth-fixed state plus `omega x r`, rotated by GMST
(IAU-82) into TEME. The azimuth is solved so the insertion state has the
target inclination. Northbound azimuths run west to east through north,
southbound through south, and the inclination is monotonic along each.

Two properties follow:

- **Inclination depends on the azimuth alone.** The Earth-fixed ascent does not
  depend on the liftoff time, so the node advances with GMST: `RAAN = node
  longitude + GMST(liftoff + insertion time)`.
- **Rendezvous timing is a one-dimensional root.** A launch joins a reference
  plane at the liftoff where that RAAN equals the reference RAAN at insertion.

The obvious alternative is an inertial plane through the pad at liftoff. Its
RAAN is off by 1.50 deg RMS on the same launches, always the same sign,
because the Earth turns about 2 deg during an ascent. A second variant
(Earth-fixed first stage, inertial upper stage) was also worse, at 1.05 deg RMS.

### Engine cutoff

Cutoff comes from one of two places:

- an `ASCENT_EVENTS` entry (SECO, cutoff, insertion);
- otherwise, the first end of powered flight (dv/dt above 2 m/s^2) followed by
  5 s of coast in the samples, whose osculating periapsis is above 80 km.
  Staging coasts are suborbital and are skipped. Gaps in the samples confirm
  nothing.

At cutoff, speed comes from the coast plateau when the samples reach it.
Broadcast altitude above 100 km is shown in whole kilometres, which cannot
resolve a near-zero vertical rate: a 1 km step inside a 20 s fit is 50 m/s. So
when the altitude near cutoff moves in 100 m steps or coarser, insertion is
taken at an apsis. That is how direct LEO insertions fly.

### Impact point and instantaneous orbit

Every sample carries the vacuum two-body impact point (the conic of its inertial
state meeting the WGS 84 surface, with the Earth's rotation during the fall)
and its osculating periapsis and apoapsis. Together they show a live ascent
turning from suborbital to orbital.

### Projection

A comparable flight's profile is time-scaled so its cutoff falls at the target
insertion time. The published `timeline` gives SECO-1 for most Falcon flights.
The insertion is placed at the target periapsis radius with zero flight-path
angle, and its speed comes from vis-viva for the target apsides. With a
reference ephemeris (TEME) in `TARGET_ORBIT.PLANE_REFERENCE`, the plane comes
from it, and `IN_PLANE_LIFTOFF_EPOCHS` lists the liftoffs that join it.

Nothing is propagated. Output ends at insertion, and the insertion state goes
to whichever propagator the caller composes.

## Validation

Truth for each launch is the first catalog element set of its A piece (Space-Track GP history), propagated with python-sgp4 to osculating TEME elements at the module's insertion second. Telemetry is Telemetry-Data (stage-2 files, stage 1 where the broadcast switched). Liftoff times from Launch Library 2. Cutoff comes from the module when the samples run at least 5 s past it, and otherwise from an event at the start of the speed plateau.

### Tracking from broadcast telemetry

| Launch | Cutoff | RAAN error | Argument of latitude error | Periapsis error | Apoapsis error | Naive-plane RAAN error |
| --- | --- | --- | --- | --- | --- | --- |
| Orbcomm OG2 M2 | T+570.7 detected | +0.704 | | | | -1.11 |
| Jason-3 | T+546.4 detected | +0.815 | | | | -0.63 |
| CRS-8 | T+597.2 detected | +0.273 | -0.26 | +2.1 km | +2.9 km | -1.53 |
| CRS-12 | T+551.3 detected | +0.156 | -1.36 | +1.8 km | -2.1 km | -1.57 |
| FormoSat-5 | T+560.3 event | +0.066 | +0.25 | +3.8 km | -0.5 km | -1.57 |
| Iridium NEXT 3 | T+542.6 event | -0.305 | | | | -1.72 |
| CRS-13 | T+542.4 event | +0.245 | -0.30 | +0.5 km | -3.5 km | -1.41 |
| PAZ | T+551.9 detected | -0.011 | +0.24 | +0.6 km | +1.5 km | -1.53 |
| Iridium NEXT 5 | T+546.1 event | +0.023 | | | | -1.31 |
| CRS-14 | T+548.8 event | +0.081 | -0.15 | +1.2 km | -48.1 km | -1.53 |
| CRS-16 | T+536.4 event | +0.093 | -0.10 | -0.2 km | +1.2 km | -1.53 |
| Iridium NEXT 8 | T+535.5 detected | -0.755 | | | | -2.13 |
| **RMS** | | **0.41 deg** | **0.55 deg** | **1.9 km** | **18 km** | 1.50 deg |

All angles are in degrees.
- **Which launches count for apsides and argument of latitude:** only the seven
  single-burn launches. The Iridium, Jason-3 and OG2 upper stages burned again
  before the first element set, which moves both but not the plane.
- **Worst cases:**
  - Jason-3: its first cutoff enters an elliptical transfer.
  - Iridium NEXT 8: its broadcast drops the upper stage from T+165 s to T+464 s.
  - CRS-14: its broadcast ends at cutoff, and apoapsis moves about 3.5 km per
    m/s of cutoff speed.

### Projection from a comparable flight

| Launch | Reference | RAAN error | Argument of latitude error |
| --- | --- | --- | --- |
| CRS-8 | CRS-14 | +0.246 | +0.62 |
| CRS-12 | CRS-16 | +0.100 | +0.14 |
| CRS-13 | CRS-14 | +0.187 | +1.33 |
| CRS-14 | CRS-16 | +0.126 | -1.41 |
| CRS-16 | CRS-14 | +0.048 | +1.15 |
| PAZ | FormoSat-5 | +0.115 | -1.39 |
| FormoSat-5 | PAZ | -0.063 | +1.84 |
| Iridium NEXT 5 | Iridium NEXT 3 | +0.016 | |
| Iridium NEXT 3 | Iridium NEXT 5 | -0.510 | |
| **RMS** | | **0.21 deg** | **1.24 deg** |

Apsides are the target's, so they are not scored. The module's one-sigma
values are these RMS figures, rounded up:
- tracking: RAAN 0.45 deg, argument of latitude 0.6 deg, periapsis 2 km,
  apoapsis 20 km;
- projection: RAAN 0.25 deg, argument of latitude 1.25 deg.

### A rendezvous launch before it flies

Crew-13 (SLC-40) is scheduled for 2026-10-01T15:10:06Z per Launch Library 2,
2026-09-28, with SECO-1 at T+8:47.
- **Inputs:** CRS-16 as the reference profile, and the ISS plane from its newest
  catalog element set (epoch 2026-09-28T03:24:39Z) propagated with SGP4.
- **Result:** the ascent joins the ISS plane at liftoff 15:09:05.3Z. That is
  60.7 s before the published time, or 0.25 deg of RAAN, which is the
  projection's accuracy.

## Standards (SDS 1.228.0, append-only)

`$LAM` gains:
- `TARGET_ORBIT` (`lamTargetOrbit`): inclination, pass direction, apsis
  altitudes, insertion time, and an optional TEME reference ephemeris;
- `INSERTION` (`lamInsertionOrbit`): epoch, frame, osculating elements, apsis
  altitudes and one-sigma values;
- `TRAJECTORY_SOURCE` (projected, telemetry, tracking or simulated);
- `SPEED_REFERENCE` (Earth-relative or inertial);
- `INSTANTANEOUS_PERIAPSIS_ALTITUDE_M` and `INSTANTANEOUS_APOAPSIS_ALTITUDE_M`;
- `IN_PLANE_LIFTOFF_EPOCHS`.

Apsis altitudes are measured above the WGS 84 equatorial radius.

## Module

`com.digitalarsenal.analysis.launch-trajectory` 0.1.0 is pure, single-thread
and has no capabilities.

| Method | In | Out |
| --- | --- | --- |
| `track_ascent` | `$LAM`: liftoff, pad, target inclination and pass direction, speed reference, samples so far, optional cutoff event | `$LAM` (TELEMETRY): samples to cutoff or to the latest sample, impact points, instantaneous apsides, Earth-fixed `TRAJECTORY_OEM`, and `INSERTION` + `BURN_OUT_VECTORS` once in orbit; JSON report |
| `project_insertion` | `$LAM`: pad, liftoff or window, target orbit (or reference plane), speed reference, reference profile | `$LAM` (PROJECTED): nominal samples, Earth-fixed `TRAJECTORY_OEM`, `INSERTION` + `BURN_OUT_VECTORS`, `IN_PLANE_LIFTOFF_EPOCHS`; JSON report |

The module is stateless. A live track re-invokes with the samples so far,
typically every few seconds while a publisher streams them.

The Earth-fixed `TRAJECTORY_OEM` is the segment shape `analysis/launch-cola`
screens. A projection feeds launch-window screening directly.

## Limits

- **Direct ascents only.** Doglegs and plane changes are not modelled; a target
  inclination below the pad latitude is refused.
- **Constant ground-track azimuth.** The residual (0.1-0.3 deg RAAN on clean
  data) is the guidance the model leaves out.
- **Webcast accuracy:**
  - Apoapsis depends on cutoff speed (about 3.5 km per m/s in LEO).
  - Whole-kilometre altitude forces the zero-flight-path-angle assumption, so
    an insertion that is not at an apsis (a transfer-orbit first cutoff) gets
    wrong apsides but the right plane.
- **Time and frame:** UT1 is taken as UTC (under 0.004 deg of RAAN), and GMST
  is IAU-82 (TEME).
- **No propagation past insertion.** Screening the deployed objects before they
  are catalogued means composing a propagator on `INSERTION`.
- **A comparable flight is needed for projection.** The published SECO time
  sets its scale. Other vehicles need their own reference profiles.
- **Situational awareness only.** This is not range safety: vacuum impact
  points, no dispersions.
