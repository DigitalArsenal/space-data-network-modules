#!/usr/bin/env python3
"""TEST-ONLY ORACLE. Never imported or included by shipped code.

Independent NASA/JPL NAIF CSPICE N0067 (SpiceyPy) and sunpy 6.0 reference
calculations on the exact kernels furnished to the resident WASM module.
The Node E2E starts this script with Python -I; no network is used.

Sources and numerical contract:
* Systems 0/1/2/5: CSPICE nearpt + surfnm, reclat, recpgr(body name), and
  pxform('MOON_ME', 'MOON_PA_DE440', ET). Inputs use PCK meters in IAU_<body>
  or MOON_ME; Psyche has no rotation model and uses ICRF axes. CSPICE uses
  kilometers internally. All three epochs are TDB seconds from J2000.
* Systems 3/4: Thompson 2006, A&A 449, 791; sunpy HeliographicStonyhurst and
  HeliographicCarrington(observer='earth'), with local DE440s and obstime
  from CSPICE et2utc(ET, 'ISOC', 6). Carrington uses sunpy's nearest-surface
  light time and IAU 2015 nominal solar radius (Prsa et al. 2016, B3).
* Angle tolerance: 1e-9 rad for CSPICE, 1e-6 deg for sunpy. These are the
  console's requested cross-implementation precision, allowing float64
  transformation roundoff. Longitudes compare modulo 2*pi. At the exact
  solar pole longitude is undefined after a floating frame transformation;
  those entries still test latitude and radius and are counted explicitly.
* Length tolerance: 1e-6 m + 1e-12 * point distance, allowing CSPICE's own
  ellipsoid convergence and kilometer/meter roundoff at solar distances.
* Surface reconstruction is independently closed form from the returned
  planetodetic normal and PCK triaxial axes. CSPICE surfnm must recover that
  normal within 1e-12, then the independent system conversion must recover
  the requested angles within the same angular bounds.
* System 2 additionally checks the requested normal line pgrrec(lon,lat,h):
  independent quadratic intersection with the actual PCK triaxial surface,
  choosing the real root closest to h=0. Missing intersections are reported
  as strict roundtrip failures with exact inputs, never skipped. System 2
  applies only to catalog planets and catalog moons whose direct parent is
  a catalog planet, and requires radii and a rotation model. The expected
  taxonomy below is independent test data, never read from module results.

Protocol: read one JSON line {kernels}; emit a deterministic plan; read one
JSON line with module outputs; emit the complete measurements and fail with
nonzero exit status on ANY violation. No reference is computed by the module.
"""
import json
import math
from pathlib import Path
import sys

import numpy as np
import spiceypy as sp
import astropy
import astropy.units as u
from astropy.coordinates import CartesianRepresentation, SkyCoord, solar_system_ephemeris
from astropy.time import Time
from astropy.utils import iers

# Configure both offline requirements BEFORE importing sunpy frames.
iers.conf.auto_download = False
request = json.loads(sys.stdin.readline())
kernel_paths = [Path(value) for value in request["kernels"]]
ephemeris = next(value for value in kernel_paths if value.name == "de440s.bsp")
solar_system_ephemeris.set(str(ephemeris))
import sunpy  # noqa: E402
from sunpy.coordinates import HeliographicCarrington, HeliographicStonyhurst  # noqa: E402

for kernel in kernel_paths:
    sp.furnsh(str(kernel))

SYSTEMS = ["PLANETODETIC", "PLANETOCENTRIC", "PLANETOGRAPHIC", "STONYHURST", "CARRINGTON", "MOON_PA"]
# Independent expectations for the module's 33-body catalog: Pluto is a
# dwarf planet, so Charon's direct parent is not a KindPlanet. The Sun is a
# star. The four extra asteroids have real PCK models but no catalog entry.
CATALOG_BODIES = [10, 199, 299, 399, 301, 499, 401, 402, 599, 501, 502, 503, 504,
                  699, 601, 602, 603, 604, 605, 606, 608, 799, 705, 701, 702, 703,
                  704, 899, 801, 999, 901, 2000001, 2000004]
CATALOG_PLANETS = {199, 299, 399, 499, 599, 699, 799, 899}
CATALOG_MOON_PARENTS = {301: 399, 401: 499, 402: 499,
                       501: 599, 502: 599, 503: 599, 504: 599,
                       601: 699, 602: 699, 603: 699, 604: 699, 605: 699, 606: 699, 608: 699,
                       705: 799, 701: 799, 702: 799, 703: 799, 704: 799, 801: 899, 901: 999}
PLANETOGRAPHIC_BODIES = CATALOG_PLANETS | {body for body, parent in CATALOG_MOON_PARENTS.items()
                                         if parent in CATALOG_PLANETS}
BODIES = CATALOG_BODIES + [2000433, 2025143, 2101955, 2162173]
# Additional real PCK body verifies both permitted ICRF-axes systems and the
# rejected planetographic pair without fabricating a kernel.
NO_ROTATION = 2000016  # Psyche: PCK radii, no pole/prime-meridian model.
EPOCHS = [float(sp.str2et(value)) for value in
          ["2020-01-15T12:00:00", "2025-06-21T06:30:00", "2029-11-03T18:45:00"]]
N = 200
RNG = np.random.default_rng(20261016)
PI = math.pi
TAU = 2 * PI
ANGLE_TOL = 1e-9
SOLAR_TOL = math.radians(1e-6)
RADII = {body: np.asarray(sp.bodvcd(body, "RADII", 3)[1]) * 1000 for body in BODIES + [NO_ROTATION]}


def has_rotation(body):
    return all(sp.bodfnd(body, field) for field in ["POLE_RA", "POLE_DEC", "PM"])


def applicable(body):
    result = [0, 1]
    if body in PLANETOGRAPHIC_BODIES and has_rotation(body):
        result.append(2)
    if body == 10:
        result.extend([3, 4])
    if body == 301:
        result.append(5)
    return result


def longitude_sense(body):
    if body in [10, 399, 301]:
        return 1
    if sp.bodfnd(body, "PM") and sp.bodvcd(body, "PM", 3)[1][1] < 0:
        return 1
    return -1


def points(body):
    radii = RADII[body]
    # Exact origin, both poles, prime meridian, and longitude 180 degrees.
    # Axis points inside a triaxial body's medial set have nonunique nearest
    # normals; exact axes here are on/outside, with inside cases off all axes.
    result = [np.zeros(3)]
    for scale in [1.0, 3.0]:
        for axis in range(3):
            for sign in [-1, 1]:
                p = np.zeros(3)
                p[axis] = sign * scale * radii[axis]
                result.append(p)
    for lon in [0, PI]:
        for lat in [-0.6, 0.6]:
            direction = np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
            result.append(direction / np.linalg.norm(direction / radii))
    while len(result) < N:
        direction = RNG.normal(size=3)
        direction /= np.linalg.norm(direction)
        scale = 0.5 if len(result) == 17 else (1.0 if len(result) % 4 == 0 else RNG.uniform(0.5, 3.0))
        result.append(scale * direction / np.linalg.norm(direction / radii))
    return np.asarray(result)


def surface_angles():
    return np.column_stack([RNG.uniform(-PI, PI, N), np.arcsin(RNG.uniform(-1, 1, N))])


def convert(body, system, et, xyz):
    result = np.zeros((len(xyz), 3))
    nonzero = np.linalg.norm(xyz, axis=1) != 0
    if system in [3, 4]:
        # The coordinate's input is exactly the module's IAU_SUN body frame.
        inertial = np.asarray(xyz[nonzero]) @ np.asarray(sp.pxform("IAU_SUN", "J2000", et)).T
        obstime = Time(sp.et2utc(et, "ISOC", 6), scale="utc")
        hcrs = SkyCoord(CartesianRepresentation(inertial.T * u.m), frame="hcrs", obstime=obstime)
        frame = HeliographicStonyhurst(obstime=obstime) if system == 3 else HeliographicCarrington(obstime=obstime, observer="earth")
        converted = hcrs.transform_to(frame)
        result[nonzero, 0] = converted.lon.to_value(u.rad)
        result[nonzero, 1] = converted.lat.to_value(u.rad)
        result[nonzero, 2] = converted.radius.to_value(u.m)
        return result
    radii = RADII[body] / 1000
    lunar = sp.pxform("MOON_ME", "MOON_PA_DE440", et) if system == 5 else None
    for index in np.flatnonzero(nonzero):
        point = xyz[index] / 1000
        if system == 0:
            nearest, height = sp.nearpt(point, *radii)
            normal = sp.surfnm(*radii, nearest)
            _, lon, lat = sp.reclat(normal)
            result[index] = [lon, lat, height * 1000]
        elif system == 2:
            lon, lat, altitude = sp.recpgr(sp.bodc2n(body), point, radii[0], (radii[0] - radii[2]) / radii[0])
            result[index] = [lon, lat, altitude * 1000]
        else:
            radius, lon, lat = sp.reclat(sp.mxv(lunar, point) if lunar is not None else point)
            result[index] = [lon, lat, radius * 1000]
    return result


def angular_errors(actual, expected):
    difference = np.abs(actual - expected)
    difference[:, 0] = np.abs((actual[:, 0] - expected[:, 0] + PI) % TAU - PI)
    return difference


def normal_line_intersection(body, lonlat):
    """Independent normal line from CSPICE pgrrec + surfnm, in kilometers."""
    radii = RADII[body] / 1000
    re, rp = radii[0], radii[2]
    flattening = (re - rp) / re
    lon, lat = lonlat
    base = np.asarray(sp.pgrrec(sp.bodc2n(body), lon, lat, 0, re, flattening))
    normal = np.asarray(sp.surfnm(re, re, rp, base))
    scaled_base, scaled_normal = base / radii, normal / radii
    a = np.dot(scaled_normal, scaled_normal)
    b = 2 * np.dot(scaled_base, scaled_normal)
    c = np.dot(scaled_base, scaled_base) - 1
    discriminant = b * b - 4 * a * c
    if discriminant < 0:
        return None
    roots = [(-b + math.sqrt(discriminant)) / (2 * a),
             (-b - math.sqrt(discriminant)) / (2 * a)]
    altitude = min(roots, key=abs)
    return np.asarray(sp.pgrrec(sp.bodc2n(body), lon, lat, altitude, re, flattening))


def reconstruct_surface(body, lonlat):
    normal = np.column_stack([np.cos(lonlat[:, 1]) * np.cos(lonlat[:, 0]),
                              np.cos(lonlat[:, 1]) * np.sin(lonlat[:, 0]), np.sin(lonlat[:, 1])])
    axes2 = RADII[body] ** 2
    surface = axes2 * normal / np.sqrt(np.sum(axes2 * normal ** 2, axis=1))[:, None]
    return surface, normal


def make_batch(body, system, et, xyz):
    lonlat = surface_angles()
    return {"id": body, "system": system, "et": et, "count": N,
            "xyz": xyz.reshape(-1).tolist(), "lonlat": lonlat.reshape(-1).tolist()}


batches = []
for et in EPOCHS:
    for body in BODIES + [NO_ROTATION]:
        xyz = points(body)
        for system in applicable(body):
            batches.append(make_batch(body, system, et, xyz))
rejected_planetographic = [body for body in BODIES + [NO_ROTATION] if body not in PLANETOGRAPHIC_BODIES]
rejected_pairs = [(body, 2) for body in rejected_planetographic + [123456789]]
rejected_pairs.extend([(499, 3), (499, 4), (499, 5), (10, -1), (301, 6)])
probes = [{"id": body, "system": system, "et": EPOCHS[0], "xyz": [1, 2, 3], "lonlat": [0.2, 0.3]}
          for body, system in rejected_pairs]
rotations = [{"id": body, "et": et} for et in EPOCHS for body in [2101955, 301]]
print(json.dumps({"kind": "plan", "batches": batches, "probes": probes, "rotations": rotations}), flush=True)
response = json.loads(sys.stdin.readline())
failures = []
failure_count = 0


def check(condition, message):
    global failure_count
    if not condition:
        failure_count += 1
        failures.append(message)


check(len(response["responses"]) == len(batches), "missing batch responses")
measurements = {}
polar_exclusions = 0
worst_normal = 0.0
worst_length_fraction = 0.0
for index, (batch, result) in enumerate(zip(batches, response["responses"])):
    body, system, et = batch["id"], batch["system"], batch["et"]
    label = f"body {body} {SYSTEMS[system]} ET {et:.6f}"
    for field in ["coordinateStatus", "infoStatus", "coordinateAliasStatus"]:
        check(result[field] == 0, f"{label}: {field}={result[field]}")
    check(result["coordinateAlias"] == result["coordinates"], f"{label}: in-place coordinate outputs differ")
    check(result["surfaceAliasStatuses"] == result["surfaceStatuses"], f"{label}: in-place surface statuses differ")
    check(result["info"] == [longitude_sense(body), int(system in [3, 4]), int(has_rotation(body))],
          f"{label}: info {result['info']}")
    xyz = np.asarray(batch["xyz"]).reshape(N, 3)
    actual = np.asarray(result["coordinates"]).reshape(N, 3)
    check(bool(np.all(np.isfinite(actual))), f"{label}: nonfinite coordinates")
    expected = convert(body, system, et, xyz)
    errors = angular_errors(actual[:, :2], expected[:, :2])
    if system in [3, 4]:
        polar = (xyz[:, 0] == 0) & (xyz[:, 1] == 0) & (xyz[:, 2] != 0)
        polar_exclusions += int(np.sum(polar))
        errors[polar, 0] = 0
    tolerance = SOLAR_TOL if system in [3, 4] else ANGLE_TOL
    max_angle = float(np.max(errors))
    length_errors = np.abs(actual[:, 2] - expected[:, 2])
    lengths = np.linalg.norm(xyz, axis=1)
    length_tolerances = 1e-6 + 1e-12 * lengths
    length_fraction = float(np.max(length_errors / length_tolerances))
    worst_length_fraction = max(worst_length_fraction, length_fraction)
    worst_point, component = np.unravel_index(np.argmax(errors), errors.shape)
    check(max_angle <= tolerance, f"{label}: coordinate[{worst_point}][{component}] {max_angle:.16g} rad > {tolerance:.16g}; got {actual[worst_point].tolist()}, want {expected[worst_point].tolist()}")
    check(length_fraction <= 1, f"{label}: third-value error uses {length_fraction:.9g} times tolerance")
    check(bool(np.array_equal(actual[0], np.zeros(3))), f"{label}: origin {actual[0].tolist()}")
    if system in [2, 4]:
        check(bool(np.all((actual[:, 0] >= 0) & (actual[:, 0] < TAU))), f"{label}: longitude outside [0, 2*pi)")
    else:
        check(bool(np.all((actual[:, 0] > -PI) & (actual[:, 0] <= PI))), f"{label}: longitude outside (-pi, pi]")

    returned = np.asarray(result["surface"]).reshape(N, 2)
    inputs = np.asarray(batch["lonlat"]).reshape(N, 2)
    statuses = np.asarray(result["surfaceStatuses"])
    valid = statuses == 0
    rejected = int(np.sum(~valid))
    check(rejected == 0, f"{label}: {rejected}/{N} requested surface points rejected (statuses {sorted(set(statuses[~valid].tolist()))}); strict roundtrip requires every input")
    for point in np.flatnonzero(~valid):
        check(False, f"body {body} {SYSTEMS[system]} ET {et:.17g}: rejected surface[{point}], lon={inputs[point, 0]:.17g} rad, lat={inputs[point, 1]:.17g} rad, status={statuses[point]}")
    expected_batch_status = next((value for value in result["surfaceStatuses"] if value != 0), 0)
    check(result["surfaceBatchStatus"] == expected_batch_status, f"{label}: batch status differs from individual calls")
    if rejected == 0:
        check(result["surfaceBatch"] == result["surface"], f"{label}: batch surface outputs differ from individual calls")
    aliases = np.asarray(result["surfaceAlias"]).reshape(N, 2)
    check(bool(np.array_equal(aliases[valid], returned[valid])), f"{label}: in-place successful surface outputs differ")
    check(bool(np.all(np.isfinite(returned[valid]))), f"{label}: nonfinite successful surface output")
    valid_indices = np.flatnonzero(valid)
    surface, normal = reconstruct_surface(body, returned[valid])
    recovered_normal = np.asarray([sp.surfnm(*(RADII[body] / 1000), point / 1000) for point in surface])
    normal_error = float(np.max(np.abs(recovered_normal - normal))) if len(surface) else 0.0
    worst_normal = max(worst_normal, normal_error)
    check(normal_error <= 1e-12, f"{label}: reconstructed surfnm residual {normal_error}")
    surface_reference = convert(body, system, et, surface)
    surface_errors = angular_errors(surface_reference[:, :2], inputs[valid])
    max_surface = float(np.max(surface_errors)) if len(surface) else 0.0
    if len(surface):
        worst_local, component = np.unravel_index(np.argmax(surface_errors), surface_errors.shape)
        worst_point = valid_indices[worst_local]
        check(max_surface <= tolerance, f"{label}: surface[{worst_point}][{component}] {max_surface:.16g} rad > {tolerance:.16g}; input {inputs[worst_point].tolist()}, recovered {surface_reference[worst_local, :2].tolist()}")
    line_error = 0.0
    if system == 2:
        # This diagnostic does not replace strict recpgr roundtrip checks.
        radii_km = RADII[body] / 1000
        intersections = [normal_line_intersection(body, value) for value in inputs]
        exists = np.asarray([item is not None for item in intersections])
        check(bool(np.array_equal(valid, exists)), f"{label}: module success disagrees with independent normal-line intersection existence")
        both = valid & exists
        if np.any(both):
            line_normal = np.asarray([sp.surfnm(*radii_km, item) for item, keep in zip(intersections, both) if keep])
            line_angles = np.asarray([sp.reclat(value)[1:] for value in line_normal])
            line_error = float(np.max(angular_errors(returned[both], line_angles)))
            check(line_error <= ANGLE_TOL, f"{label}: specified pgrrec normal-line intersection {line_error:.16g} rad > {ANGLE_TOL}")
    if system == 0:
        check(bool(np.array_equal(returned, inputs)), f"{label}: system 0 surface map is not identity")
    row = measurements.setdefault((body, system), [0, 0.0, 0.0, 0.0, 0.0, 0])
    row[0] += N
    row[1] = max(row[1], max_angle)
    row[2] = max(row[2], float(np.max(length_errors)))
    row[3] = max(row[3], max_surface)
    row[4] = max(row[4], line_error)
    row[5] += rejected

check(len(response["probes"]) == len(probes), "missing applicability probes")
for probe, result in zip(probes, response["probes"]):
    for field in ["coordinateStatus", "surfaceStatus", "infoStatus"]:
        check(result[field] == -12, f"inapplicable ({probe['id']}, {probe['system']}): {field}={result[field]}, expected ErrBadArgument (-12)")

worst_bennu = 0.0
worst_moon = 0.0
for probe, result in zip(rotations, response["rotations"]):
    body, et = probe["id"], probe["et"]
    check(result["failed"] == 0 and result["status"] == 0, f"orientation {body} ET {et} failed")
    expected = sp.tipbod("J2000", body, et) if body == 2101955 else sp.pxform("J2000", "MOON_ME", et)
    actual = np.asarray(result["values"][:9]).reshape(3, 3)
    delta = actual @ np.asarray(expected).T
    # The skew-part atan2 remains accurate for rotations far below sqrt(eps).
    sine = np.linalg.norm([delta[2, 1] - delta[1, 2], delta[0, 2] - delta[2, 0], delta[1, 0] - delta[0, 1]]) / 2
    error = math.atan2(sine, (np.trace(delta) - 1) / 2)
    check(error <= ANGLE_TOL, f"orientation {body} ET {et}: {error} rad > {ANGLE_TOL}")
    if body == 2101955:
        worst_bennu = max(worst_bennu, error)
    else:
        worst_moon = max(worst_moon, error)

lines = [f"CSPICE {sp.tkvrsn('TOOLKIT')}; SpiceyPy {sp.__version__}; sunpy {sunpy.__version__}; astropy {astropy.__version__}",
         "Offline DE440s; seed 20261016; 3 epochs (2020, 2025, 2029); 200 points + 200 surface angles per body/system/epoch",
         f"Coverage: {len(CATALOG_BODIES)} catalog bodies + 4 additional asteroids + Psyche; {len(PLANETOGRAPHIC_BODIES)} eligible planets/planetary moons; {len(batches) * N} coordinate points and surface attempts",
         "body     name      system          points  angle(rad)  third(m)    surface(rad) pgr-line(rad) rejected"]
for (body, system), row in measurements.items():
    line = f"{row[4]:.3e}" if system == 2 else "-"
    lines.append(f"{body:8d} {sp.bodc2n(body):9s} {SYSTEMS[system]:15s} {row[0]:5d}  {row[1]:.3e}   {row[2]:.3e}   {row[3]:.3e}    {line:9s} {row[5]:3d}")
cspice_angle = max(row[1] for (body, system), row in measurements.items() if system not in [3, 4])
cspice_surface = max(row[3] for (body, system), row in measurements.items() if system not in [3, 4])
solar_angle = max(row[1] for (body, system), row in measurements.items() if system in [3, 4])
solar_surface = max(row[3] for (body, system), row in measurements.items() if system in [3, 4])
lines.extend([
    f"Worst CSPICE angles: coordinates {cspice_angle:.9e} rad; surface {cspice_surface:.9e} rad (bound 1e-9 rad)",
    f"Worst sunpy angles: coordinates {math.degrees(solar_angle):.9e} deg; surface {math.degrees(solar_surface):.9e} deg (bound 1e-6 deg)",
    f"Worst third-value error / allowed bound: {worst_length_fraction:.9e}; reconstructed normal: {worst_normal:.9e}",
    f"Normal-line diagnostic worst {max(row[4] for row in measurements.values()):.9e} rad; {sum(row[5] for row in measurements.values())} requested random surface points rejected (all are strict failures, not skips)",
    f"Bennu quadratic-PM orientation: {worst_bennu:.9e} rad; MOON_ME orientation: {worst_moon:.9e} rad (bound 1e-9 rad)",
    f"MOON_PA coordinates use CSPICE pxform(MOON_ME, MOON_PA_DE440); {polar_exclusions} undefined solar-pole longitudes excluded; all pole latitudes/radii checked",
    f"Origin, longitude ranges, info, in-place outputs, Psyche ICRF axes, and {len(probes)} inapplicable pairs checked; {failure_count} failures",
    f"System 2 rejected by all three exports for IDs {rejected_planetographic + [123456789]} (Sun, dwarf planets, their moons, asteroids, and unknown IDs)",
])
print(json.dumps({"lines": lines, "failureCount": failure_count, "failures": failures}), flush=True)
sys.exit(1 if failure_count else 0)
