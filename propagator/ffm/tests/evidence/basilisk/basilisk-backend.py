"""Basilisk 2.12 wheel adapter; only the reference oracle is run here.

The native Spacecraft and RKF78 own the propagated state. Python supplies
external environment messages at the midpoint of each bounded integration
interval. This is a second-order sample-and-hold coupling, independently
halved by the runner, not a replacement force model or integrator.
"""
import datetime
from functools import lru_cache
import importlib.util
import math
import os
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
os.environ['TZ'] = 'UTC'
time.tzset()

HERE = Path(__file__).resolve().parent
REFERENCE_SITE = Path(sys.prefix).parent / 'erfa-spice/lib/python3.14/site-packages'
sys.path.insert(0, str(REFERENCE_SITE))
import numpy as np
import erfa
from Basilisk.architecture import messaging, astroConstants
from Basilisk.simulation import (spacecraft, gravityEffector, svIntegrators,
                                spiceInterface, radiationPressure, eclipse,
                                msisAtmosphere, dragDynamicEffector)

_spec = importlib.util.spec_from_file_location('pinned_erfa_spice_reference', HERE.parent / 'erfa-spice/reference.py')
_reference = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_reference)

_EOP_SERIES = {}


@lru_cache(maxsize=800000)
def _orientation(eop_key, tt1, tt2, elapsed):
    """Share identical native ERFA evaluations across independent cases.

    The cache changes no interpolation or arithmetic. 800k entries hold all
    distinct dyadic midpoints from 8 down to 0.25 s over a 24-hour arc;
    matrices are immutable and the cache is bounded (roughly 300 MB).
    """
    value = _reference.c2t_iers2010(tt1, tt2 + elapsed / 86400, _EOP_SERIES[eop_key])[0]
    value.setflags(write=False)
    return value


def _ns(t):
    return int(round(t * 1e9))


def _epoch_message(iso):
    dt = datetime.datetime.fromisoformat(iso)
    value = messaging.EpochMsgPayload()
    value.year, value.month, value.day = dt.year, dt.month, dt.day
    value.hours, value.minutes = dt.hour, dt.minute
    value.seconds = dt.second + dt.microsecond / 1e6
    return messaging.EpochMsg().write(value)


def _weather(export, drag, iso):
    """Native MSIS uses daily Ap (switch 9 = 1); populate all 23 ports."""
    if drag['spaceWeather'] == 'constant':
        w = export['spaceWeather']['constant']
        return [w['ap']] * 21 + [w['f107a'], w['f107']]
    rows = {r['DATE']: r for r in export['spaceWeather']['cssi']['rows']}
    day = datetime.datetime.fromisoformat(iso).date()
    current = rows[day.isoformat()]
    prior = rows[(day - datetime.timedelta(days=1)).isoformat()]
    return [current['AP_AVG']] * 21 + [current['F107_OBS_CENTER81'], prior['F107_OBS']]


def run(config):
    export, case = config['export'], config['case']
    constants, forces = export['constants'], case['forces']
    field, srp_cfg, drag_cfg = forces['gravityField'], forces['solarRadiationPressure'], forces['drag']
    variant = config.get('variant', 'nominal')
    native_density = None
    if variant == 'wgs84-gtd7d':
        spec = importlib.util.spec_from_file_location('basilisk_native_msis_diagnostic', HERE / 'investigate-basilisk.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        native_density = module.density
    step = float(config['maxStepS'])
    if step <= 0 or step > 10:
        raise ValueError('Basilisk environment step must be in (0, 10] s')
    rows = export['earthOrientation'][case['earthOrientation']]['rows']
    eop_key = tuple(tuple(sorted(row.items())) for row in rows)
    _EOP_SERIES.setdefault(eop_key, rows)
    utc1, utc2 = _reference.two_part_utc(case['epochUtc'])
    tt1, tt2 = erfa.taitt(*erfa.utctai(utc1, utc2))
    # Retain the split date: adding small elapsed times to a full JD loses
    # tens of microseconds, which would exceed submillimeter convergence.
    tt2 = float(tt2)

    earth = gravityEffector.GravBodyData()
    earth.planetName = 'earth'
    earth.isCentralBody = True
    earth.mu = forces['centralBody']['gmM3S2']
    earth.radEquator = field['radiusM'] if field else constants['fieldRadiusM']
    if field:
        earth.useSphericalHarmonicsGravityModel(str(config['gravityFile']), field['degree'])
    earth_message = messaging.SpicePlanetStateMsg()
    earth_payload = messaging.SpicePlanetStateMsgPayload()
    earth_payload.PlanetName = 'custom'  # Eclipse uses explicitly supplied rEqCustom.
    earth_payload.computeOrient = True
    earth_payload.J20002Pfix = np.eye(3).tolist()
    earth_payload.J20002Pfix_dot = np.zeros((3, 3)).tolist()
    earth_message.write(earth_payload, 0)
    earth.planetBodyInMsg.subscribeTo(earth_message)
    bodies = [earth]

    needed = list(dict.fromkeys([b.lower() for b in forces['thirdBodies']] + (['sun'] if srp_cfg else [])))
    spice = None
    planet_messages = {}
    if needed:
        spice = spiceInterface.SpiceInterface()
        spice.referenceBase, spice.zeroBase = 'J2000', 'earth'
        spice.UTCCalInit = case['epochUtc']
        # Empty frame names disable PCK orientation. Earth orientation comes
        # exclusively from the export's ERFA/IERS chain below.
        spice.planetFrames = [''] * len(needed)
        spice.addPlanetNames(needed)
        support = Path(config['supportData'])
        spice.addKernelPaths([str(config['kernel']), str(support / 'EphemerisData/naif0012.tls')])
        spice.Reset(0)
        for name, message in zip(needed, spice.planetStateOutMsgs):
            planet_messages[name] = message
            if name.upper() in forces['thirdBodies']:
                body = gravityEffector.GravBodyData()
                body.planetName = name
                body.mu = constants[name + 'GmM3S2']
                body.planetBodyInMsg.subscribeTo(message)
                bodies.append(body)

    sc = spacecraft.Spacecraft()
    sc.ModelTag = 'BasiliskFfmReference'
    sc.pointMassTranslationalOnly = True
    sc.hub.mHub = constants['spacecraft']['massKg']
    sc.hub.r_CN_NInit = case['initialState']['positionM']
    sc.hub.v_CN_NInit = case['initialState']['velocityMS']
    sc.gravField.gravBodies = gravityEffector.GravBodyVector(bodies)
    integrator = svIntegrators.svIntegratorRKF78(sc)
    integrator.relTol = 1e-14
    integrator.absTol = 1e-12
    sc.setIntegrator(integrator)
    midpoint_state = messaging.SCStatesMsg()
    midpoint_payload = messaging.SCStatesMsgPayload()
    midpoint_state.write(midpoint_payload)
    atmosphere_state = messaging.SCStatesMsg()
    atmosphere_payload = messaging.SCStatesMsgPayload()
    atmosphere_state.write(atmosphere_payload)

    srp = shadow = None
    if srp_cfg:
        srp = radiationPressure.RadiationPressure()
        srp.setUseCannonballModel()
        srp.area = srp_cfg['areaM2']
        # Exact settings conversion from exported pressure/AU to Basilisk's
        # hardcoded irradiance/AU convention; this is not trajectory fitting.
        srp.coefficientReflection = (srp_cfg['cr'] * constants['solarPressureAt1AuNm2']
                                     / (astroConstants.SOLAR_FLUX_EARTH / astroConstants.SPEED_LIGHT)
                                     * (constants['auM'] / (astroConstants.AU * 1000)) ** 2)
        srp.sunEphmInMsg.subscribeTo(planet_messages['sun'])
        shadow = eclipse.Eclipse()
        shadow.rEqCustom = srp_cfg['occultingBodyRadiusM']
        shadow.sunInMsg.subscribeTo(planet_messages['sun'])
        shadow.addPlanetToModel(earth_message)
        shadow.addSpacecraftToModel(midpoint_state)
        if variant != 'no-eclipse':
            srp.sunEclipseInMsg.subscribeTo(shadow.eclipseOutMsgs[0])
        sc.addDynamicEffector(srp)

    atmosphere = drag = wind_message = density_override = None
    weather_messages, weather_payloads = [], []
    weather_values = []
    epoch_message = None
    if drag_cfg:
        if drag_cfg['atmosphere'] != 'NRLMSISE00':
            raise ValueError('Basilisk native atmosphere is NRLMSISE00 only')
        atmosphere = msisAtmosphere.MsisAtmosphere()
        atmosphere.planetRadius = constants['wgs84']['equatorialRadiusM']
        atmosphere.planetPosInMsg.subscribeTo(earth_message)
        atmosphere.addSpacecraftToModel(atmosphere_state)
        epoch_message = _epoch_message(case['epochUtc'])
        atmosphere.epochInMsg.subscribeTo(epoch_message)
        weather_values = _weather(export, drag_cfg, case['epochUtc'])
        for index, value in enumerate(weather_values):
            payload = messaging.SwDataMsgPayload()
            payload.dataValue = value
            message = messaging.SwDataMsg().write(payload)
            # SWIG's vector iterator yields copies of ReadFunctor; indexing
            # addresses the actual reader retained by the native atmosphere.
            atmosphere.swDataInMsgs[index].subscribeTo(message)
            weather_payloads.append(payload)
            weather_messages.append(message)
        drag = dragDynamicEffector.DragDynamicEffector()
        drag.coreParams.projectedArea = drag_cfg['areaM2']
        drag.coreParams.dragCoeff = drag_cfg['cd']
        if native_density:
            density_payload = messaging.AtmoPropsMsgPayload()
            density_override = messaging.AtmoPropsMsg().write(density_payload)
            drag.atmoDensInMsg.subscribeTo(density_override)
        else:
            drag.atmoDensInMsg.subscribeTo(atmosphere.envOutMsgs[0])
        wind_message = messaging.WindMsg()
        wind_payload = messaging.WindMsgPayload()
        wind_message.write(wind_payload)
        if variant != 'no-wind':
            drag.windVelInMsg.subscribeTo(wind_message)
        sc.addDynamicEffector(drag)

    diagnostics = {'environmentStepS': step, 'integrator': 'Basilisk svIntegratorRKF78',
                   'relativeTolerance': integrator.relTol, 'absoluteTolerance': integrator.absTol,
                   'environmentUpdates': 0, 'nativeSunRadiusM': astroConstants.REQ_SUN * 1000,
                   'variant': variant, 'orientationEvaluation': 'memoized exact pinned ERFA',
                   'orientationCacheLimit': 800000}
    if drag_cfg:
        diagnostics['densityModel'] = ('native wheel gtd7d at every altitude' if native_density
                                       else 'native MsisAtmosphere: gtd7 below 500 km, gtd7d above')
    altitude_deltas = []
    density_samples, shadow_samples = [], []
    start_dt = datetime.datetime.fromisoformat(case['epochUtc'])

    def environment(t, r, v, half_step=0):
        nonlocal weather_values
        qtt2 = tt2 + t / 86400
        rotation = _orientation(eop_key, tt1, tt2, t) if field or drag else np.eye(3)
        earth_payload.J20002Pfix = rotation.tolist()
        earth_message.write(earth_payload, _ns(t))
        if spice:
            # SpiceInterface increments ET linearly; resetting its epoch each
            # sample supplies the exact geocentric TT -> TDB conversion.
            tai = erfa.tttai(tt1, qtt2)
            u = erfa.taiutc(*tai)
            ut_frac = (u[0] % 1 + u[1] % 1) % 1
            et = ((tt1 - 2451545.0) + qtt2) * 86400 + erfa.dtdb(tt1, qtt2, ut_frac, 0, 0, 0)
            spice.J2000ETInit = et - t
            spice.UpdateState(_ns(t))
        if srp or drag:
            # Central-force Taylor predictor only supplies midpoint external
            # environment inputs. Native RKF78 still integrates the complete
            # state. Halving the coupling step bounds predictor/hold error.
            radius = np.linalg.norm(r)
            acceleration = -earth.mu * r / radius ** 3
            jerk = -earth.mu * (v / radius ** 3 - 3 * r * np.dot(r, v) / radius ** 5)
            predicted_r = r + half_step * v + 0.5 * half_step ** 2 * acceleration + half_step ** 3 / 6 * jerk
            predicted_v = v + half_step * acceleration + 0.5 * half_step ** 2 * jerk
            midpoint_payload.r_BN_N = predicted_r.tolist()
            midpoint_payload.v_BN_N = predicted_v.tolist()
            midpoint_state.write(midpoint_payload, _ns(t))
            if shadow:
                shadow.UpdateState(_ns(t))
                srp.UpdateState(_ns(t))
            if atmosphere:
                fixed = rotation @ predicted_r
                lon, lat, altitude = erfa.gc2gd(1, fixed)
                spherical_altitude = np.linalg.norm(fixed) - atmosphere.planetRadius
                altitude_deltas.append(float(spherical_altitude - altitude))
                atmospheric_r = predicted_r
                if variant in ('wgs84', 'wgs84-gtd7d'):
                    # Diagnostic only: preserve native MSIS evaluation while
                    # making its spherical-coordinate input equal WGS84 LLA.
                    sphere = (atmosphere.planetRadius + altitude) * np.array([
                        math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
                    atmospheric_r = rotation.T @ sphere
                atmosphere_payload.r_BN_N = atmospheric_r.tolist()
                atmosphere_payload.v_BN_N = predicted_v.tolist()
                atmosphere_state.write(atmosphere_payload, _ns(t))
                if drag_cfg['spaceWeather'] == 'cssi':
                    instant = (start_dt + datetime.timedelta(seconds=t)).isoformat()
                    weather_values = _weather(export, drag_cfg, instant)
                    for message, payload, value in zip(weather_messages, weather_payloads, weather_values):
                        payload.dataValue = value
                        message.write(payload, _ns(t))
                atmosphere.UpdateState(_ns(t))
                if native_density:
                    instant = start_dt + datetime.timedelta(seconds=int(t))
                    seconds = instant.hour * 3600 + instant.minute * 60 + instant.second + instant.microsecond / 1e6 + t - int(t)
                    longitude = float(np.rad2deg(lon))
                    density_payload.neutralDensity = native_density(
                        altitude_km=float(altitude / 1000), latitude_deg=float(np.rad2deg(lat)),
                        longitude_deg=longitude, seconds=seconds,
                        local_solar_time=seconds / 3600 + longitude / 15,
                        day_of_year=instant.timetuple().tm_yday,
                        f107=weather_values[22], f107a=weather_values[21], ap=weather_values[0])
                    density_payload.localTemp = atmosphere.envOutMsgs[0].read().localTemp
                    density_override.write(density_payload, _ns(t))
                wind_payload.v_air_N = np.cross(rotation[2] * 7.292115e-5, predicted_r).tolist()
                wind_message.write(wind_payload, _ns(t))
                if drag_cfg.get('areaOverMassRateM2KgS'):
                    # The exported rate is d(Cd*A/m)/dt, not d(A/m)/dt.
                    drag.coreParams.dragCoeff = (drag_cfg['cd'] + drag_cfg['massKg'] / drag_cfg['areaM2']
                                                 * drag_cfg['areaOverMassRateM2KgS'] * t)
                drag.UpdateState(_ns(t))
        diagnostics['environmentUpdates'] += 1

    if shadow:
        shadow.Reset(0)
        srp.Reset(0)
    if atmosphere:
        atmosphere.Reset(0)
        drag.Reset(0)
    initial_r = np.asarray(case['initialState']['positionM'])
    initial_v = np.asarray(case['initialState']['velocityMS'])
    environment(0, initial_r, initial_v)
    sc.Reset(0)
    sc.UpdateState(0)
    samples = []
    current = 0.0
    for offset, iso in zip(case['sampleOffsetsS'], case['sampleEpochsUtc']):
        while current < offset - 1e-10:
            dt = min(step, offset - current)
            previous = sc.scStateOutMsg.read()
            r, v = np.asarray(previous.r_BN_N), np.asarray(previous.v_BN_N)
            environment(current + dt / 2, r, v, dt / 2)
            current += dt
            sc.UpdateState(_ns(current))
        state = sc.scStateOutMsg.read()
        samples.append([offset, *state.r_BN_N, *state.v_BN_N])
        if atmosphere:
            density_samples.append((density_override or atmosphere.envOutMsgs[0]).read().neutralDensity)
        if shadow:
            value = shadow.eclipseOutMsgs[0].read()
            # The wheel's eclipse-module payload wrapper retains the old
            # field name; architecture.messaging exposes the renamed one.
            shadow_samples.append(value.illuminationFactor if hasattr(value, 'illuminationFactor') else value.shadowFactor)
    if altitude_deltas:
        diagnostics['sphericalMinusWgs84AltitudeM'] = {'min': min(altitude_deltas), 'max': max(altitude_deltas)}
        diagnostics['hourlyNativeDensityKgM3'] = density_samples
    if shadow:
        diagnostics['hourlyShadowFactor'] = shadow_samples
    return {'samples': samples, 'diagnostics': diagnostics}
