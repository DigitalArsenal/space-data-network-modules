# NASA SpaceX Crew-8 Reference Mission Package

This package records public Crew-8 mission facts for Falcon 9 launch/ascent,
Dragon rendezvous, ISS docking, port relocation, undocking, reentry, and
splashdown validation.

The package is intentionally a public-source reconstruction. It is not a
SpaceX telemetry product and does not claim exact Falcon 9 guidance, throttle,
mass, aerodynamic coefficients, Dragon burn targeting, or Crew Dragon GNC law
equivalence.

## Units And Frames

- Times use UTC ISO 8601 strings.
- Launch-site coordinates use WGS84 degrees.
- Rendezvous ranges are meters in an ISS LVLH-style relative frame when a
  public approach gate exists.
- Docking-port offsets use an `iss-body-visualization` frame. They are
  rendering-scale approximations until a sourceable ISS port transform package
  is added.
- Vehicle dimensions preserve the source unit where NASA publishes one.

## Source Basis

Primary facts come from NASA mission overview, launch-to-dock timeline, NASA
Commercial Crew posts, NASA International Space Station blog posts, return
coverage, deorbit-burn posts, and the NASA splashdown release. Every mission
fact in these fixtures carries a source ID recorded in `sources.json`.

## Modeling Boundaries

Use this package to validate event ordering, phase coverage, source provenance,
and first-order public timing/range residuals. Do not use it as hidden truth for
private vehicle performance or docking control laws.
