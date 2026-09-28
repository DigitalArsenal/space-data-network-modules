# Launch notifications and launch collision avoidance (COLA)

Study, 2026-09-28. Scope: one provider node that publishes upcoming-launch
notices and screens launch windows against the orbiting catalog, both as
digitally signed Space Data Standards records.

## Regulatory basis

14 CFR 450.169 (current eCFR text, fetched 2026-09-28) sets the criteria an
orbital or suborbital launch must meet for its vehicle, jettisoned components
and payloads. The operator establishes window closures that keep every
launched object within one criterion per class:

| Class | Probability of collision | Distance |
| --- | --- | --- |
| Inhabitable objects | ≤ 1 × 10⁻⁶ | 200 km spherical, or ellipsoid 200 km in-track × 50 km cross-track × 50 km radial |
| Objects that are neither debris nor inhabitable | ≤ 1 × 10⁻⁵ | 25 km spherical |
| Known debris (RCS > 1 m² large, 0.1–1 m² medium) | ≤ 1 × 10⁻⁵ | 2.5 km spherical |

Screening time (450.169(b)):

- orbital launch: from 150 km during ascent to initial orbital insertion, and
  for at least 3 hours from liftoff;
- suborbital launch: the whole flight segment above 150 km;
- reentry and disposal: from the initial burn down to 150 km.

Other rules:

- **Exception (d):** objects whose maximum planned altitude stays below 150 km
  need no screening.
- **Rendezvous (c):** pre-coordinated rendezvous or close approaches within the
  screening time are not violations.
- **Uncertainty (e)(2):** the analysis must account for vehicle performance and
  timing uncertainties, and each closure must include the extra time they add.
- **Timing (f):**
  - file the input data 7 days before the first attempt, or 15 days for a
    first-time requester;
  - obtain results no later than 3 hours before the window opens;
  - after a delay, request an update at least 12 hours before the new window.
- **Who performs it (e):** a Federal entity identified by the FAA, or another
  entity agreed to by the Administrator.

The network's screening is therefore a transparent, reproducible cross-check
and planning tool. It does not replace the analysis the operator must obtain
unless the FAA agrees to it.

Appendix A to Part 450 (the collision analysis worksheet) fixes the inputs:

- mission name;
- launch site latitude and longitude;
- window open and close times (UTC and Julian date) for each attempt;
- the epoch of expected liftoff;
- segments (each stage or payload after thrust ends, including jettisoned
  parts) with their orbital parameters;
- object dimensions and masses;
- powered-flight times and the sequence of events;
- the requested L-times for results;
- the screening choice:
  - spherical;
  - ellipsoidal, given as ΔU radial, ΔV in-track and ΔW cross-track in km
    around the orbiting object;
  - collision probability, which needs position covariance;
- trajectory files:
  - Earth-Fixed Greenwich (EFG) position in km and velocity in km/s for each
    stage or payload, from below 150 km through the screening period;
  - radar cross section per file;
  - covariance if probability screening is chosen;
  - separate files for each valid window span when the trajectory changes
    during the window.

## Sources for launch notices

Probed 2026-09-28 from the owner machine.

| Source | State | Content | Access |
| --- | --- | --- | --- |
| Launch Library 2 (The Space Devs), `ll.thespacedevs.com/2.3.0` | Live, 367 upcoming launches | NET with precision, window start/end, status, pad latitude/longitude, mission, target orbit, vehicle configuration, provider, webcast links | Free; 15 anonymous requests per hour; higher rates with a supporter key |
| RocketLaunch.live, `fdo.rocketlaunch.live/json/launches/next/5` | Live | Next five launches with `win_open`/`win_close`, `t0`, pad, vehicle, provider | Free next-5 endpoint; full feed needs a key; terms to confirm before use |
| Maritime navigational warnings (NGA MSI broadcast warnings API) | Resolves only through public DNS from this network; returned nothing newer than 2024 | Hazard areas as coordinate lists with effective times | Public U.S. government data; needs a working current endpoint before use |
| FAA NOTAM search | 403 to scripted access | Space-operations airspace closures | FAA NOTAM API requires registration |
| Space-Track | No pre-launch notices | Post-launch catalog entries, launch sites | Account; COLA requests themselves are private to the operator |

Primary source: Launch Library 2, pulled at most hourly. That is one request
per hour against a budget of fifteen, and every client reads the node's copy
instead of calling upstream. RocketLaunch.live is a later cross-check.
Hazard areas wait for a current feed. The airspace volume standard ($AVL)
already carries polygon volumes when one is available.

## Records

**Notices use the existing Launch Data Message ($LDM).** One record per
upcoming launch. The new `ID` field carries the source's stable launch ID.

| Launch Library 2 | $LDM |
| --- | --- |
| `id` | `ID` |
| `net` | `NET` (ISO 8601 UTC) |
| `window_start`, `window_end` | `EARLIEST_LAUNCH_TIMES[0]`, `LATEST_LAUNCH_TIMES[0]` |
| `status.name` | `LAUNCH_STATUS` |
| `launch_service_provider.name` | `AGENCY_NAME` |
| `rocket.configuration.full_name` | `ROCKET_CONFIGURATION.NAME` |
| `mission.name`, `.description`, `.type` | `MISSION_NAME`, `MISSION_DESCRIPTION`, `MISSION_TYPE` |
| `mission.orbit.abbrev` | `ORBIT_TYPE` |
| `pad.name`, `.latitude`, `.longitude` | `SITE.NAME`, `SITE.LATITUDE`, `SITE.LONGITUDE` |
| webcast URL | `WEBCAST_URL` |
| launch URL | `REFERENCES` |

Retrieval time, producer, source URL and attribution travel in the storage
provenance, the same way as the weather source.

**Screening uses new launch arms on the conjunction standard ($CQR).**
Existing $CQR screens one time span. Launch screening sweeps liftoff times
across a window, so it gets its own request and result:

- **criteria:** one per object class — spherical radius, RTN ellipsoid, or
  maximum probability;
- **segments:** one per launched object. Each is an Earth-fixed OEM relative
  to the nominal liftoff, with a valid liftoff span when trajectories change
  across the window, a radius and a radar cross section;
- **objects:** each orbiting object with its class and a
  coordinated-rendezvous flag;
- **request:** the window, the liftoff step, the 150 km altitude floor, the
  screening duration and the closure pad;
- **result:** closures (spans of prohibited liftoff times, each naming the
  objects that caused it) and approaches (the worst approach for each
  segment/object run, with liftoff, TCA, miss distance, RTN offset and the
  criterion ratio).

`LDM.LCOLA_WINDOW_CLOSURES` keeps working as a plain list of ISO 8601
intervals for readers that only need the answer.

## Screening method

Inputs share one Earth-fixed frame:

- **Launched objects:** the trajectory is Earth-fixed and relative to liftoff.
  For a fixed-azimuth ascent, the Earth-fixed state at liftoff + τ is the same
  for every liftoff time, which is why Appendix A asks for EFG files. When a
  window changes azimuth, the operator supplies one segment per valid liftoff
  span.
- **Orbiting objects:** catalog elements go through a host-selected propagator
  module to sampled OEM states, then through the frames module (TEME→ITRF with
  Earth-orientation data) into the same Earth-fixed frame. The screening module
  never picks a propagator.

For each segment, orbiting object and liftoff time on the grid
(window open + kΔ, Δ = 1 s by default):

1. Skip trajectory samples below the altitude floor or past the screening
   duration.
2. Sweep absolute time over the orbiting object's samples. The launched
   object's position at τ = t − liftoff comes from Hermite interpolation of
   its trajectory.
3. Keep a candidate when the distance is within the largest criterion extent
   plus the motion allowed by the sample spacing.
4. Refine the time of closest approach with golden-section search on both
   Hermite-interpolated tracks (1 ms tolerance).
5. Evaluate the criterion:
   - sphere: d / R;
   - ellipsoid: √((r/R_r)² + (t/R_t)² + (n/R_n)²), in the orbiting object's RTN
     frame. That frame uses its inertial velocity, approximated in the
     Earth-fixed frame as v + ω⊕ × r.

   A ratio below 1 violates the criterion. Coordinated rendezvous targets are
   reported but do not close the window.

Closures:

- Each contiguous run of violating liftoff times [t_a, t_b] becomes a closure
  [t_a − Δ, t_b + Δ). That is conservative for the grid spacing.
- Closures are widened by the requested pad and merged across objects and
  segments.
- The pad is where the operator's performance and timing uncertainty goes
  (450.169(e)(2)).

Probability screening needs covariance for both objects. The first release
refuses it explicitly instead of approximating. The existing
conjunction-assessment probability methods (Foster, Alfano and others) are the
route once launch covariance is carried.

Cost, for a 2-hour window at 1 s, a 3-hour screen, 30,000 objects and 60 s
catalog sampling:

- an altitude-band prefilter removes most objects;
- the sweep then evaluates about 7,200 liftoff times against each remaining
  object's 180 samples;
- only candidates are refined.

## Node

Launch provider node, next in the owner-machine provider fleet
(`deployment/launch-provider-node`), with its own identity, store and IPFS
node:

- **Notices flow:** hourly timer → plan → HTTP → parse → FlatSQL storage of
  $LDM → signed dataset publication.
- **Screening flow:**
  - on request, per launch;
  - a request carries the window and the trajectory segments;
  - orbiting objects come from the network's catalog through a propagator
    module and the frames module;
  - results are stored as $CQR and published.
- **Trajectories:**
  - operator-supplied EFG files;
  - or the existing `analysis/launch-ascent` module, which has a Crew-8
    reference mission, for planning studies.

## Not in the first release

- Probability screening (covariance for launched and orbiting objects).
- Maritime and airspace hazard areas (needs a current feed; $AVL exists).
- The COLA gap after insertion: screening deployed objects from their insertion
  vectors until they are catalogued.
- Suborbital and reentry screening. The request already covers them (altitude
  floor, duration); only the fixtures are orbital.

## Implementation (2026-09-28)

| Piece | Where | State |
| --- | --- | --- |
| $CQR launch arms, $LDM.ID | spacedatastandards.org 1.227.0 | Released |
| Launch notices source | `data-source/launch-schedule` | Built; tested against a recorded upstream page |
| Launch COLA screening | `analysis/launch-cola` | Built; closed-form tests; 2,000 objects × 1 h window at 1 s × 3 h screen in about 10 s (WASM) |
| Provider node | stack `deployment/launch-provider-node` | Running on the owner machine (`127.0.0.1:7217`); first hourly cycle stored and auto-published 100 notices; COLA module installed |
