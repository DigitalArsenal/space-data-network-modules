"""Native-wheel model probes for interpreting the Basilisk evidence.

This is a diagnostic evidence generator, not an additional test suite.  Run
with bsk-venv/bin/python -I -B.  It evaluates the installed Basilisk models
and its bundled NRLMSISE entry points, without importing FFM physics.
"""
import ctypes as ct
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time

for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'
os.environ['TZ'] = 'UTC'
time.tzset()

from Basilisk.architecture import astroConstants, messaging
from Basilisk.simulation import dragDynamicEffector, msisAtmosphere, spacecraft
from Basilisk.simulation import _msisAtmosphere

sys.path.insert(0, str(Path(sys.prefix).parent / 'erfa-spice/lib/python3.14/site-packages'))
import erfa
import numpy as np


class ApArray(ct.Structure):
    _fields_ = [('a', ct.c_double * 7)]


class MsisInput(ct.Structure):
    _fields_ = [('year', ct.c_int), ('doy', ct.c_int)] + [
        (name, ct.c_double) for name in
        ('sec', 'alt', 'g_lat', 'g_long', 'lst', 'f107A', 'f107', 'ap')
    ] + [('ap_a', ct.POINTER(ApArray))]


class MsisFlags(ct.Structure):
    _fields_ = [('switches', ct.c_int * 24), ('sw', ct.c_double * 24),
                ('swc', ct.c_double * 24)]


class MsisOutput(ct.Structure):
    _fields_ = [('d', ct.c_double * 9), ('t', ct.c_double * 2)]


_native_msis = ct.CDLL(_msisAtmosphere.__file__)
for _name in ('gtd7', 'gtd7d'):
    _function = getattr(_native_msis, _name)
    _function.argtypes = [ct.POINTER(MsisInput), ct.POINTER(MsisFlags),
                          ct.POINTER(MsisOutput)]
    _function.restype = None


def density(*, altitude_km, latitude_deg, longitude_deg=0.0, seconds=0.0,
            local_solar_time=0.0, day_of_year=214, f107=150.0, f107a=150.0,
            ap=15.0, variant='gtd7d'):
    """Evaluate the wheel's native NRLMSISE; output is kg/m³."""
    request = MsisInput(2026, day_of_year, seconds, altitude_km, latitude_deg,
                        longitude_deg, local_solar_time, f107a, f107, ap, None)
    flags, result = MsisFlags(), MsisOutput()
    flags.switches[:] = [1] * 24
    getattr(_native_msis, variant)(ct.byref(request), ct.byref(flags), ct.byref(result))
    return result.d[5]


def probe_msis():
    """Equator/pole isolate shape; 400/600 km isolate gtd7 selection."""
    model = msisAtmosphere.MsisAtmosphere()
    model.planetRadius = 6378137.0
    sc_payload = messaging.SCStatesMsgPayload()
    sc_msg = messaging.SCStatesMsg().write(sc_payload)
    model.addSpacecraftToModel(sc_msg)
    epoch = messaging.EpochMsgPayload()
    epoch.year, epoch.month, epoch.day = 2026, 8, 2
    epoch_msg = messaging.EpochMsg().write(epoch)
    model.epochInMsg.subscribeTo(epoch_msg)
    weather_messages = []
    for index, value in enumerate([15.0] * 21 + [150.0, 150.0]):
        payload = messaging.SwDataMsgPayload()
        payload.dataValue = value
        message = messaging.SwDataMsg().write(payload)
        weather_messages.append(message)
        model.swDataInMsgs[index].subscribeTo(message)
    model.Reset(0)
    rows = []
    for name, position, altitude, latitude, seconds in (
        ('equator-400km', [6778137.0, 0.0, 0.0], 400.0, 0.0, 0.0),
        ('pole-radius-a-plus-400km', [0.0, 0.0, 6778137.0], 400.0, 90.0, 0.0),
        ('equator-600km', [6978137.0, 0.0, 0.0], 600.0, 0.0, 0.0),
        ('equator-400km-fractional-second', [6778137.0, 0.0, 0.0], 400.0, 0.0, 0.3125),
    ):
        sc_payload.r_BN_N = position
        sc_msg.write(sc_payload)
        model.UpdateState(int(seconds * 1e9))
        longitude, geodetic_latitude, height = erfa.gc2gd(1, position)
        kwargs = {'seconds': seconds, 'local_solar_time': seconds / 3600}
        rows.append({
            'id': name, 'positionM': position,
            'secondsSinceEpoch': seconds,
            'sphericalAltitudeKm': altitude, 'latitudeDeg': latitude,
            'nativeErfaWgs84AltitudeM': float(height),
            'nativeErfaWgs84LatitudeDeg': float(np.rad2deg(geodetic_latitude)),
            'basiliskModuleDensityKgM3': model.envOutMsgs[0].read().neutralDensity,
            'nativeGtd7KgM3': density(altitude_km=altitude, latitude_deg=latitude, variant='gtd7', **kwargs),
            'nativeGtd7dKgM3': density(altitude_km=altitude, latitude_deg=latitude, **kwargs),
            'nativeGtd7dWgs84KgM3': density(altitude_km=float(height / 1000),
                                            latitude_deg=float(np.rad2deg(geodetic_latitude)), **kwargs),
        })
    return {
        'epochUtc': '2026-08-02T00:00:00Z', 'frame': 'Earth fixed, identity orientation',
        'weather': {'f107': 150, 'f107a': 150, 'dailyAp': 15},
        'switches': 'all 1: SI density, daily Ap, all variations enabled',
        'rows': rows,
    }


def probe_drag():
    """Exercise 2.12's native air-velocity input at an identical state."""
    states = spacecraft.DynParamManager()
    sigma = states.registerState(3, 1, 'sigma')
    velocity = states.registerState(3, 1, 'velocity')
    sigma.setState([[0], [0], [0]])
    velocity.setState([[0], [7500], [0]])
    drag = dragDynamicEffector.DragDynamicEffector()
    drag.setStateNameOfSigma('sigma')
    drag.setStateNameOfVelocity('velocity')
    drag.coreParams.projectedArea, drag.coreParams.dragCoeff = 20.0, 2.2
    atmosphere = messaging.AtmoPropsMsgPayload()
    atmosphere.neutralDensity = 1e-12
    atmosphere_message = messaging.AtmoPropsMsg().write(atmosphere)
    drag.atmoDensInMsg.subscribeTo(atmosphere_message)
    wind = messaging.WindMsgPayload()
    wind_message = messaging.WindMsg().write(wind)
    drag.windVelInMsg.subscribeTo(wind_message)
    drag.linkInStates(states)
    drag.Reset(0)
    rows = []
    for air in ([0.0, 0.0, 0.0], [0.0, 500.0, 0.0]):
        wind.v_air_N = air
        wind_message.write(wind)
        drag.UpdateState(0)
        drag.computeForceTorque(0.0, 0.0)
        rows.append({'airVelocityMS': air,
                     'nativeRelativeVelocityMS': [row[0] for row in drag.v_B],
                     'nativeForceN': [row[0] for row in drag.forceExternal_B]})
    return {'frame': 'inertial N, body aligned with N', 'velocityMS': [0, 7500, 0],
            'densityKgM3': 1e-12, 'cd': 2.2, 'areaM2': 20, 'rows': rows}


def probe():
    return {
        'about': 'Measured native Basilisk 2.12.0 model behavior; diagnostic evidence only.',
        'protocol': {
            'source': 'Installed AVS Lab Basilisk 2.12.0 MSIS/drag modules and bundled native NRLMSISE gtd7/gtd7d; ERFA 2.0.1 gc2gd WGS84 conversion',
            'units': {'position': 'm', 'velocity': 'm/s', 'density': 'kg/m^3', 'force': 'N',
                      'AU': 'km', 'REQ_SUN': 'km', 'REQ_EARTH': 'km', 'SPEED_LIGHT': 'm/s', 'SOLAR_FLUX_EARTH': 'W/m^2'},
            'tolerance': None,
            'rationale': 'These are same-state diagnostic measurements with no pass/fail threshold. The sole E2E applies the unchanged exported trajectory tolerances and 0.3 mm convergence bound.'},
        'basiliskVersion': importlib.metadata.version('bsk'), 'pythonVersion': sys.version,
        'nativeMsisLibrary': {'path': _msisAtmosphere.__file__,
                              'sha256': hashlib.sha256(Path(_msisAtmosphere.__file__).read_bytes()).hexdigest()},
        'nativeConstants': {name: getattr(astroConstants, name) for name in
                            ('AU', 'SPEED_LIGHT', 'SOLAR_FLUX_EARTH', 'REQ_SUN', 'REQ_EARTH')},
        'msis': probe_msis(), 'dragAirVelocity': probe_drag(),
    }


if __name__ == '__main__':
    result = json.dumps(probe(), indent=2, allow_nan=False) + '\n'
    if len(sys.argv) == 2:
        Path(sys.argv[1]).write_text(result)
    else:
        print(result, end='')
