# Astronomical reference geometry

`com.digitalarsenal.analysis.reference-points`, version **0.1.0**, is an open
C++ WASM pure transform for astronomical reference features. The host moves
values between this module and `propagator/solar-system-bodies`; geometry stays
in C++. No kernels, network, clocks, threads, JSON contracts, or application
objects are used.

Build and test from this directory with the already linked SDK:

```sh
node build.mjs
node --test tests/*.e2e.test.mjs
```

The build uses an existing repository-local `deps/emsdk` LLVM driver through
`compileModuleFromSource`, validates the artifact, and produces
`dist/isomorphic/module.wasm` and `dist/plugin-manifest.json`. It never installs
or downloads dependencies. PCE headers come from the linked SDK's installed
standards and flatc dependencies; no schemas are authored here.

The same artifact targets browser and WasmEdge, using `wasi-sequential` with a
`pure-transform` justification. It cannot spawn threads. This SDK target still
uses shared WASM memory, so a browser host must support SharedArrayBuffer and
cross-origin isolation. The tests instantiate the built file using the SDK's
direct browser harness in Node and exercise its actual exported functions.
SDK compatibility validation is included in the E2E test file.

## Memory and frames

All arrays contain IEEE 754 doubles, with positions in meters, velocities in
meters/second, GM in meters cubed/second squared, and angles in degrees only
where explicitly specified. There is no implicit epoch conversion: states and
rotations must refer to the same caller-selected instant. Inputs use ICRF and
any common origin unless a function specifies body-fixed or normalized axes.

Allocate buffers with the SDK's `plugin_alloc(byte_count)` and release them
with `plugin_free(pointer, byte_count)`. The SDK header supplies these exports;
the module does not redefine them. Every `rp_*` call uses only stack storage
and caller-owned buffers. Buffers must be valid, 8-byte aligned, sufficiently
large, and nonoverlapping with inputs. Non-null invalid addresses are outside
the ABI contract.

A `*3` vector holds three doubles; a `*6` state holds position then velocity.
`R` is a row-major 3x3 input-to-output rotation, applied after adding the center:
`R * (center + local)`. Null means identity. `rot_icrf_to_body9` follows the same
row-major convention (null also means identity); its transpose maps back to
ICRF. Callers supply orthonormal rotations; entries are checked for finiteness.
Wire poles are unit vectors in the input frame; finite nonzero vectors are
normalized defensively. A basis is chosen deterministically: take the world
axis least aligned with the pole (ties x, then y, then z), normalize its cross
product with the pole to obtain u, then v = pole cross u.

Scalar geometry calls return **0** on success, **-1** for bad arguments.
Wire/terminator calls return the vertex count or **-1** for bad arguments,
**-2** for insufficient capacity (including counts beyond int32). Capacity is
in vertices, not doubles or bytes. Capacity refusal writes nothing. ABI version
is the exception: `rp_abi_version()` returns **1**. Required output pointers
cannot be null. Positive sizes/GM, nonzero directions/separations, finite
values, and the limits below are required.

## Direct exports

The authoritative C signatures are in `src/reference_points_module.cpp`.

| Export | Result and conditions |
| --- | --- |
| `rp_collinear(mu, out3)` | L1, L2, L3 x coordinates in normalized barycentric CR3BP axes: primary at -mu, secondary at 1-mu; 0 < mu <= 0.5. Safeguarded Newton/bisection solves force balance on each singularity-separated interval to floating-point convergence. |
| `rp_lagrange(primary6, secondary6, gm_primary, gm_secondary, R, out27)` | Positions L1 through L5 in slots 0–14; mu in 15; separation d in 16; primary/secondary distances for point i in 17+2i and 18+2i. Secondary GM must not exceed primary GM. Relative position and velocity must define a nonzero orbital normal. |
| `rp_influence(parent6, body6, gm_parent, gm_body, out3)` | Separation d, Hill radius d cbrt(GM_body/(3 GM_parent)), Laplace SOI d (GM_body/GM_parent)^(2/5). These are approximate local influence scales. |
| `rp_shadow(sun3, body3, r_sun, r_body, out8)` | Unit Sun-to-body axis (0–2), separation D (3), umbra length behind body (4), penumbra apex distance toward Sun (5), umbra/penumbra half-angle tangents (6–7). Requires r_sun > r_body > 0 and D > r_sun+r_body. |
| `rp_wire_circle(center3, pole3, R, radius, samples, out, capacity)` | Closed circle: samples+1 vertices, samples >= 3, radius > 0. |
| `rp_wire_sphere(center3, pole3, R, radius, parallels, meridians, samples, out, capacity)` | Parallels at -90+180(i+1)/(parallels+1) degrees, followed by south-to-north meridians at 360k/meridians degrees. Samples vertices per strip, samples >= 4; parallels close by repeating the first point. Either strip count may be zero, but not both. |
| `rp_wire_cone(origin3, axis3, R, r0, slope, s0, s1, rings, generators, samples, out, capacity)` | r(s)=max(0,r0+slope*s), s1 > s0. Rings at evenly spaced s including both endpoints, samples vertices per closed ring (samples >= 4). Each generator is a two-vertex straight line joining endpoint radii. Rings must be zero or >= 2; at least one strip is required. |
| `rp_wire_dipole(center3, pole3, R, equatorial_radius, L, meridians, samples, out, capacity)` | r=L R_eq cos²(latitude), from -acos(1/sqrt(L)) to its positive counterpart. L >= 1, R_eq > 0, meridians >= 1, samples >= 2. Includes both surface cuts. Odd samples include the magnetic equator. |
| `rp_terminator(sun_dir3, rot_icrf_to_body9, radii3, center3, R, samples, out, capacity)` | Closed ellipsoid terminator: samples+1 vertices, samples >= 3. Radii are positive body-fixed semi-axes. The Sun direction is from the body toward the Sun. |
| `rp_sub_point(target3, rot_icrf_to_body9, radii3, center3, R, out6)` | Ray intercept with the ellipsoid; output position (0–2), body-fixed east longitude in (-180,180] degrees (3), planetodetic latitude of the surface normal in degrees (4), target distance in meters (5). Target is a vector from the body's center, not an absolute position. Longitude uses the intercept's x/y coordinates. |
| `rp_region(kind, out2)` | Approximate boundaries below. Other kinds return -1. |
| `rp_geomagnetic_axis(out3)` | Unit north centered-dipole axis in Earth-fixed axes: +z geographic north, +x longitude zero, +y longitude 90 degrees east. |

Lagrange positions describe the **instantaneous pulsating frame**, not a
propagated invariant orbit or an ephemeris of a spacecraft. The x axis follows
the relative position, z follows relative position cross relative velocity,
and y = z cross x. L4 leads the secondary by 60 degrees in this oriented plane;
reversing relative orbital motion reverses that lead. L1–L3 positions use the
instantaneous separation and origin. Distances in `out27` are frame-invariant.

The terminator is the ellipsoid-plane intersection with body-fixed plane normal
(s_x/a², s_y/b², s_z/c²). Scaling the ellipsoid to a unit sphere produces the
plane normal (s_x/a, s_y/b, s_z/c), so its great circle maps exactly to the
terminator ellipse. This uses a parallel Sun direction; atmospheric refraction
and finite-Sun illumination are outside this geometric definition.

Polyline strips have one separating vertex with **all three coordinates NaN**,
with no leading or trailing separator. Sphere count is
`(parallels + meridians) * samples + parallels + meridians - 1`.
Cone count is `rings * samples + 2 * generators + rings + generators - 1`.
Dipole count is `meridians * samples + meridians - 1`. Cone generators connect
endpoints even when the clamped profile crosses the apex; subdivide the axial
interval at that apex if a separate collapsed-axis segment is needed.

The manifest's single SDK discovery method, `describe`, has no inputs and emits
one SDS PCE result containing only the string parameter `version = "0.1.0"`.
It is not a geometry transport. Unlike the allocation-free `rp_*` functions,
SDK discovery uses a FlatBuffer builder.

## Approximate boundaries and sources

These constants are visualization models, not sharp, time-independent physical
surfaces. Kinds 0–3 return meters; kinds 4–5 return dimensionless dipole L.
The astronomical unit is exactly 149597870700 m
([IAU 2012 Resolution B2](https://www.iau.org/static/resolutions/IAU2012_English.pdf)).

| Kind | Model and source |
| --- | --- |
| 0 | Main belt between Jupiter's 4:1 and 2:1 Kirkwood resonances: 5.20288700 au times (1/4)^(2/3) and (1/2)^(2/3). Jupiter's mean semi-major axis is from Standish's 1800–2050 table, [JPL SSD approximate planetary positions](https://ssd.jpl.nasa.gov/planets/approx_pos.html); resonance distances follow Kepler's third law. |
| 1 | Kuiper belt 30–50 au, [NASA Kuiper Belt facts](https://science.nasa.gov/solar-system/kuiper-belt/facts/). |
| 2 | Termination shock 88.85 au, the mean of Voyager 1's 94.0 au (December 2004; Stone et al., Science 309, 201–204, 2005) and Voyager 2's 83.7 au (August 2007; Stone et al., Nature 454, 71–74, 2008, doi:10.1038/nature07022). Both outputs equal this mean. |
| 3 | Heliopause 120.3 au, the mean of 121.6 au (Voyager 1, August 2012; Gurnett et al., Science 341, 1489–1492, 2013, doi:10.1126/science.1241681) and 119.0 au (Voyager 2, November 2018; Stone et al., Nature Astronomy 3, 1013–1018, 2019, doi:10.1038/s41550-019-0929-2). Both outputs equal this mean. |
| 4 | Inner Van Allen belt equatorial altitudes 1000–6000 km, converted to L=1+altitude/6378.137 km. |
| 5 | Outer Van Allen belt equatorial altitudes 13000–60000 km, converted to the same L convention. Kinds 4–5 use the task's approximate [NASA Van Allen Probes](https://science.nasa.gov/mission/van-allen-probes/) ranges; the equatorial radius is WGS84's 6378.137 km. |

The geomagnetic axis uses IGRF-13 at **2020.0**, g10=-29404.8,
g11=-1450.9, h11=4652.5 nT, and pole=-(g11,h11,g10)/B0:
80.58947 degrees north, 72.67971 degrees west. The task's approximate
80.65-degree latitude does not follow from its specified coefficients; the
coefficients and defining formula take precedence. Source: Alken et al.,
*International Geomagnetic Reference Field: the thirteenth generation*,
Earth, Planets and Space 73, 49 (2021), doi:10.1186/s40623-020-01288-x;
[IGRF coefficient archive](https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf13coeffs.txt).
The axis drifts; this fixed-epoch centered dipole is an approximation and is
not the magnetic dip pole of the full field.

Tests state source, units, frame, epoch/time interpretation, tolerance and its
rationale beside each numerical case. The Earth-Moon rounded collinear values
are the task-supplied Szebehely/NASA benchmark; force balance independently
checks the roots with DE440 GM values. No expected output is generated by the
module under test. Source citations are documented without network retrieval.

With the specified DE440 GMs, Earth's Hill radius at 1 au is approximately
1.49656e9 m (the task's 1.4963e9 m is a coarser approximation). The supplied
eight-decimal Earth-Moon L3 benchmark is truncated, so the table comparison
allows 1e-8 normalized units; the independent force residual remains <1e-13.

The specified solar and Earth radii yield an umbra length of 1.38263e9 m at
1 au; the task's 1.384e9 m comparison is treated as an approximate benchmark.

## Consumers

OrbPro bundles this module as `@orbpro/integration/reference-points`
(`createReferencePoints`). The engine's `ReferencePointsDataSource` (Lagrange
points, subsolar and sublunar points) and `CelestialReferenceGeometry` (Hill and
influence spheres, Earth's shadow, terminator, Van Allen shells, asteroid and
Kuiper belts, heliosphere boundaries) gather the ephemeris provider's ICRF
states and hand them to the exports above; every position, radius and vertex
drawn is this module's. The console shows them signed in only.
