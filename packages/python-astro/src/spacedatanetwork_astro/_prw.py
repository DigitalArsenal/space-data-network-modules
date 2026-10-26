"""FFM marshalling: an SDS $PRW execution request in, a state out.

The WASM module integrates. Here only units are scaled (the request is SI:
metres, metres/second, seconds) and epochs are written as the request's labels.
"""
import numpy as np

from ._codec import array, obj
from .sds.PRW.frmStateRepresentation import frmStateRepresentation
from .sds.PRW.pcfGravitySelection import pcfGravitySelection
from .sds.PRW.pcfIntegratorAlgorithm import pcfIntegratorAlgorithm
from .sds.PRW.rfmAxisType import rfmAxisType
from .sds.PRW.rfmOriginKind import rfmOriginKind
from .sds.PRW.timEpochRepresentation import timEpochRepresentation
from .sds.PRW.timingStandard import timingStandard

EARTH_NAIF_ID = 399
GCRF = 'GCRF'
DEFAULT_INTEGRATOR = {'method': 'RK4', 'initialStep': 30., 'maxSteps': 100000,
                      'absTolerance': 1e-12, 'relTolerance': 1e-12}
DEFAULT_FORCES = {'pointMass': True, 'j2': False, 'j3': False, 'j4': False,
                  'thirdBody': False, 'drag': False, 'srp': False}
KM = 1000.


def _iso_tdb(jd):
    """The request's epoch label for a Julian date, to the nanosecond."""
    day = int(np.floor(jd - 2440587.5))
    seconds = (jd - 2440587.5 - day) * 86400.
    whole = int(np.floor(seconds))
    nanos = int(round((seconds - whole) * 1e9))
    if nanos == 1_000_000_000:
        whole, nanos = whole + 1, 0
    hour, rest = divmod(whole, 3600)
    return f'{np.datetime64(day, "D")}T{hour:02d}:{rest // 60:02d}:{rest % 60:02d}.{nanos:09d}'


def _vector(values):
    return obj('PRW.FRMVector3', *(float(v) * KM for v in values))


def _initial_state(position_km, velocity_km_s, epoch_jd):
    return obj('PRW.PRWResidentState',
               STATE=obj('PRW.FRMStateVector', REPRESENTATION=frmStateRepresentation.CARTESIAN,
                         POSITION=_vector(position_km), VELOCITY=_vector(velocity_km_s),
                         COORDINATE_SYSTEM_NAME=GCRF, EPOCH=_iso_tdb(float(epoch_jd)),
                         EPOCH_TIME_SYSTEM='TDB'),
               COORDINATE_SYSTEM=obj('PRW.RFMCoordinateSystem', NAME=GCRF, AXIS_TYPE=rfmAxisType.ICRF,
                                     AXIS_REFERENCE_BODY_ID=EARTH_NAIF_ID,
                                     ORIGIN=obj('PRW.RFMOrigin', KIND=rfmOriginKind.CELESTIAL_BODY,
                                                CELESTIAL_BODY_ID=EARTH_NAIF_ID)))


def _integrator(settings):
    s = {**DEFAULT_INTEGRATOR, **settings}
    algorithm = getattr(pcfIntegratorAlgorithm, str(s['method']).upper(), None)
    if algorithm is None:
        raise ValueError(f"Unknown integrator method {s['method']!r}")
    return obj('PRW.PCFIntegratorSettings', ALGORITHM=algorithm,
               INITIAL_STEP_SECONDS=float(s['initialStep']),
               MINIMUM_STEP_SECONDS=float(s.get('minStep', 1.)),
               MAXIMUM_STEP_SECONDS=float(s.get('maxStep', 3600.)),
               ABSOLUTE_TOLERANCES=[float(s['absTolerance']) * KM] * 6,
               RELATIVE_TOLERANCE=float(s['relTolerance']), MAXIMUM_STEPS=int(s['maxSteps']))


def _forces(settings):
    f = {**DEFAULT_FORCES, **settings}
    return obj('PRW.PCFForceModel', GRAVITY_CHOICE=pcfGravitySelection.INFER_FLAGS,
               ENABLE_POINT_MASS=bool(f['pointMass']), GRAVITATIONAL_PARAMETER=float(f.get('mu', 398600.4418)) * 1e9,
               ENABLE_J2=bool(f['j2']), ENABLE_J3=bool(f['j3']), ENABLE_J4=bool(f['j4']),
               ENABLE_THIRD_BODY=bool(f['thirdBody']), THIRD_BODY_IDS=[10, 301] if f['thirdBody'] else [],
               ENABLE_SRP=bool(f['srp']), ENABLE_DRAG=bool(f['drag']), EPHEMERIS_SOURCE='Analytical')


def execution_request(position_km, velocity_km_s, epoch_jd, target_jd, integrator, forces):
    """A PRW EXECUTION_REQUEST: one Earth-inertial state to a target epoch (TDB)."""
    position = array(position_km, (3,), name='position_km')
    velocity = array(velocity_km_s, (3,), name='velocity_km_s')
    array([epoch_jd, target_jd], name='epochs')
    request = obj('PRW.PRWExecutionRequest', INITIAL=_initial_state(position, velocity, epoch_jd),
                  TARGET_EPOCH=obj('PRW.TIMInstant', TIME_SYSTEM=timingStandard.TDB,
                                   EPOCH_FORMAT=timEpochRepresentation.JULIAN_DATE, JULIAN_DATE=float(target_jd)),
                  INTEGRATOR=_integrator(integrator or {}), FORCES=_forces(forces or {}))
    return obj('PRW.PRW', EXECUTION_REQUEST=request)


def final_state(prw):
    """(position km, velocity km/s, frame name) of an execution result's final sample."""
    result = prw.EXECUTION_RESULT
    if result is None:
        raise RuntimeError('FFM returned no execution result')
    resident = result.FINAL_SAMPLE.STATE
    state = resident.STATE
    to_km = lambda v: np.array([v.X, v.Y, v.Z]) / KM
    name = resident.COORDINATE_SYSTEM.NAME
    return to_km(state.POSITION), to_km(state.VELOCITY), name.decode() if isinstance(name, bytes) else name
