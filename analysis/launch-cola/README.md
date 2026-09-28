# Launch collision avoidance screening

SDK module for launch-window collision screening
(`screen_launch_window`, `$CQR LAUNCH_REQUEST` → `$CQR LAUNCH_RESULT`, SDS
1.227.0). It evaluates every liftoff time on a grid across the window, for
every launched segment against every orbiting object. It returns the
prohibited liftoff spans and the worst approach of each run. A JSON `report`
repeats the closures as ISO 8601 intervals for `LDM.LCOLA_WINDOW_CLOSURES`.
Background and requirements:
[docs/studies/launch-notifications-and-cola.md](../../docs/studies/launch-notifications-and-cola.md).

## Inputs

- **Frame:** one Earth-fixed frame (`BODY_FIXED`, body 399) for everything.
  Segment trajectories are OEMs for a liftoff at `NOMINAL_LIFTOFF`, and any
  other liftoff time shifts them in time. Windows whose trajectory changes
  supply one segment per `VALID_FROM`/`VALID_UNTIL` span.
- **Orbiting objects:**
  - must arrive as ephemerides in that frame, from a host-selected propagator
    followed by `foundation/frames`;
  - mean elements are refused;
  - an ephemeris that does not cover the screened absolute span is an error.
- **Criteria, one per object class:**
  - spherical radius;
  - or an ellipsoid in the orbiting object's radial/in-track/cross-track frame.
    That frame uses the inertial velocity v + ω⊕ × r.
  - Probability screening is refused until launch and object covariance are
    carried.
- **Screening limits:** only segment states at or above `MINIMUM_ALTITUDE_M`
  (WGS 84 height, default 150 km) and within `SCREEN_SECONDS_AFTER_LIFTOFF`
  (default 3 h) are screened.

## Method

1. **Candidates:** an absolute-time sweep (10 s) over coarse liftoff cells
   (10 s). A spatial hash of orbiting-object positions keeps every
   segment/object/cell whose separation at the cell centre is within the
   criterion extent plus the largest motion possible inside the cell. That is
   segment speed × (5 s + cell half-width) + object speed × 5 s, with a 5 %
   allowance for interpolation overshoot. For the interpolation model, the
   search misses no violation.
2. **Refinement:** every liftoff time of a candidate cell. Distance and
   criterion ratio are each minimised over τ with 1 s samples, then
   golden-section search to 0.1 ms.
3. **Closures:**
   - each run of violating liftoff times becomes a closure from the previous
     clear liftoff to the next one, widened by `CLOSURE_PAD_SECONDS`;
   - closures are merged across objects and segments;
   - a coordinated rendezvous is reported and never closes the window;
   - closures are not clipped to the window.

Tracks are cubic-Hermite interpolated from positions and velocities. With
2,000 orbiting objects, a 1-hour window at 1 s steps and a 3-hour screen, a
run takes about 10 s in WASM (M-series host).

## Build and test

```sh
npm install
npm run build
npm test
```

The tests are closed-form. They cover:

- a straight-line crossing whose closure bounds follow from a quadratic;
- an RTN ellipsoid on the polar axis;
- the altitude floor at the WGS 84 polar radius;
- the coordinated-rendezvous flag;
- the closure pad;
- refusals.
