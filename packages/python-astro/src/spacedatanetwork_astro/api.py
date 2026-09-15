"""NumPy-friendly orchestration of the pinned C++ WASM modules.

Units and frames are explicit at each boundary. All physics stays in WASM.
The generated ``sds`` and ``invoke`` packages expose advanced request fields.
"""
from dataclasses import dataclass
import json
import numpy as np
from ._codec import obj, pack, unpack, array, plain
from .runtime import Module, Frame


def frame(port, value, family, *, schema=None, identifier=None, root_type=None):
    return Frame(port, pack(value, identifier or '$' + family),
                 schema or family + '.fbs', identifier or '$' + family, root_type or family)


def output(frames, port=None):
    selected = [f for f in frames if port is None or f.port_id == port]
    if not selected:
        raise RuntimeError(f'Module returned no output on {port!r}')
    return selected[0].payload


@dataclass(frozen=True)
class State:
    """Cartesian state; see units/frame/epoch attributes (arrays are copies)."""
    position: np.ndarray
    velocity: np.ndarray
    frame: str
    position_unit: str
    velocity_unit: str
    epoch: float
    epoch_scale: str = ""


class SGP4:
    """Resident SGP4 catalog. OMM epochs are UTC; angles degrees, motion rev/day."""
    def __init__(self):
        self.module = Module('propagator/sgp4')
        self.count = 0
        self._indices = {}

    def ingest(self, omm):
        """Ingest a CCSDS OMM mapping (uppercase field names); return resident index."""
        value = obj('OMM.OMM')
        for key, val in dict(omm).items():
            if not hasattr(value, key):
                raise ValueError(f'Unknown OMM field {key}')
            setattr(value, key, val)
        self.module.invoke('ingest_omm', [frame('omm', value, 'OMM', schema='orbpro.sds.omm')])
        norad = int(value.NORAD_CAT_ID)
        if norad not in self._indices:
            self._indices[norad] = self.count
            self.count += 1
        index = self._indices[norad]
        return index

    def propagate(self, julian_date, handles=None):
        """Return ECEF states in m and m/s at the module's UTC-like Julian date.

        SGP4 uses the legacy module JD convention (86400 s/day, no leap label).
        The returned frame is decoded from PRST, never assumed by the wrapper.
        """
        indices = list(range(self.count)) if handles is None else list(handles)
        if not indices or any(not isinstance(i, (int, np.integer)) or i < 0 or i >= self.count for i in indices):
            raise ValueError('handles must identify ingested objects')
        array([julian_date], name='julian_date')
        request = obj('legacy.orbpro.propagator.PropagatorBatchRequest', local=True)
        request.epoch = float(julian_date)
        request.entityHandles = indices
        request.maxCount = len(indices)
        frames = self.module.invoke('propagate_state', [Frame('request', pack(request),
            'orbpro.propagator.PropagatorBatchRequest', 'PROP', 'PropagatorBatchRequest')])
        states = []
        for entry in frames:
            if entry.port_id != 'state':
                continue
            state = unpack('orbpro.plugins.PropagatorState', entry.payload, local=True)
            if not state.valid:
                raise RuntimeError(f'SGP4 invalid state for resident index {state.entityIndex}')
            names = {0: 'ECI', 1: 'ECEF', 2: 'TEME', 3: 'ICRF'}
            states.append(State(np.array(state.position), np.array(state.velocity),
                names.get(state.referenceFrame, str(state.referenceFrame)), 'm', 'm/s', float(julian_date), 'UTC JD (86400 s/day)'))
        if len(states) != len(indices):
            raise RuntimeError(f'SGP4 returned {len(states)} states for {len(indices)} handles')
        return states

    def close(self):
        self.module.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def sgp4(omm, julian_dates):
    """Propagate one OMM; return an (N,6) array in ECEF m and m/s."""
    dates = array(julian_dates, name='julian_dates').reshape(-1)
    with SGP4() as propagator:
        propagator.ingest(omm)
        states = [propagator.propagate(float(jd))[0] for jd in dates]
        if any(s.frame != 'ECEF' for s in states):
            raise RuntimeError('This SGP4 artifact did not return ECEF')
        return np.array([np.concatenate((s.position, s.velocity)) for s in states]).reshape(-1, 6)


def hpop(position_km, velocity_km_s, epoch_jd, target_jd, *, integrator=None, forces=None):
    """Propagate an Earth inertial Cartesian state; return km, km/s.

    Epoch and target JD are TDB, as required by the HPOP module. Force settings are the
    module's documented mapping. The current module invoke payload is JSON
    inside binary PIV/TAB; no Python integrator or force model is used.
    """
    position = array(position_km, (3,), name='position_km')
    velocity = array(velocity_km_s, (3,), name='velocity_km_s')
    array([epoch_jd, target_jd], name='epochs')
    request = {'operation': 'propagate', 'params': {
        'position': position.tolist(), 'velocity': velocity.tolist(),
        'epochJD': float(epoch_jd), 'targetJD': float(target_jd),
        'integrator': integrator or {'method': 'RK4', 'initialStep': 30., 'maxSteps': 100000,
                                     'absTolerance': 1e-12, 'relTolerance': 1e-12},
        'forces': forces if forces is not None else {'pointMass': True, 'j2': False, 'j3': False,
            'j4': False, 'thirdBody': False, 'drag': False, 'srp': False}}}
    with Module('propagator/hpop') as module:
        result = json.loads(output(module.invoke('invoke', [Frame('request', json.dumps(request, allow_nan=False).encode(),
            'orbpro.hpop.InvokeRequest')]), 'response'))
    if 'error' in result:
        raise RuntimeError(result['error'])
    return State(array(result['position'], (3,)), array(result['velocity'], (3,)),
                 'Earth inertial (HPOP)', 'km', 'km/s', float(target_jd), 'TDB')


def convert_time(epoch, source='UTC', target='TAI', *, dut1_seconds=None):
    """Convert an ISO-8601 epoch in WASM. Return the full TIM result mapping."""
    from .sds.TIM.timingStandard import timingStandard
    source_id = getattr(timingStandard, source.upper())
    target_id = getattr(timingStandard, target.upper())
    instant = obj('TIM.TIMInstant', TIME_SYSTEM=source_id, EPOCH_FORMAT=3, ISO8601=str(epoch))
    request = obj('TIM.TIMConversionRequest', SOURCE=instant, TARGET_TIME_SYSTEM=target_id,
                  TARGET_EPOCH_FORMAT=3, HAS_DUT1=dut1_seconds is not None,
                  DUT1_SECONDS=0 if dut1_seconds is None else float(dut1_seconds))
    envelope = obj('TIM.TIM', TIME_SYSTEM=source_id, CONVERSION_REQUEST=request)
    with Module('foundation/time') as module:
        result = unpack('TIM.TIM', output(module.invoke('convert_time', [frame('request', envelope, 'TIM')]))).CONVERSION_RESULT
    if result.STATUS != 0:
        raise RuntimeError(plain(result.ERROR_MESSAGE))
    return plain(result)


def transform_position(position, *, operation=1, dcm=None, equatorial_radius_m=6378136.3,
                       polar_radius_m=6356752.3):
    """FRM position operation: PCI_TO_PCPF=1, inverse=2, LLA_TO_PCPF=3, inverse=4.

    LLA inputs/outputs use radians and metres. Cartesian units are preserved.
    For fixed PCI/PCPF rotation supply a 3x3 direction cosine matrix.
    """
    vector = obj('FRM.FRMVector3', *array(position, (3,), name='position'))
    matrix = None if dcm is None else obj('FRM.FRMMatrix3', *array(dcm, (3, 3), name='dcm').ravel())
    request = obj('FRM.FRMFrameTransformRequest', operation, vector, matrix,
                  equatorial_radius_m, polar_radius_m, 'python')
    with Module('foundation/frames') as module:
        result = unpack('FRM.FRM', output(module.invoke('transform_frame_position',
            [frame('request', obj('FRM.FRM', request, None), 'FRM')]))).FRAME_TRANSFORM_RESULT
    if result.STATUS != 0:
        raise RuntimeError(plain(result.ERROR_MESSAGE))
    return np.array([result.POSITION.X, result.POSITION.Y, result.POSITION.Z])


def lambert_izzo(r1_km, r2_km, tof_seconds, *, mu_km3_s2=398600.4418, max_revs=0,
                 transfer_way=0, reference_frame='GCRF', epoch='2026-05-05T00:00:00Z'):
    """Return LMO solution branches; V1/V2 are NumPy arrays in km/s."""
    r1, r2 = array(r1_km, (3,)), array(r2_km, (3,))
    array([tof_seconds, mu_km3_s2])
    request = obj('LMS.LMS', 'python', *r1, *r2, float(tof_seconds), float(mu_km3_s2),
                  transfer_way, max_revs, reference_frame, epoch, 0)
    with Module('analysis/lambert-izzo') as module:
        result = unpack('LMO.LMO', output(module.invoke('solve_lambert', [frame('request', request, 'LMS')])) )
    decoded = plain(result)
    for branch in [decoded.get('SINGLE')] + list(decoded.get('MULTI') or []):
        if branch is not None:
            for field in ('V1', 'V2'):
                if branch.get(field) is not None:
                    branch[field] = np.array([branch[field][c] for c in ('X', 'Y', 'Z')])
    return decoded


def initial_orbit(positions_m, *, method='GIBBS', mu_m3_s2=3.986004415e14,
                  epoch_jd=2451545., intervals_seconds=(1., 1.)):
    """Three inertial positions -> middle-epoch IOD state (m, m/s), via WASM."""
    positions = array(positions_m, (3, 3), name='positions_m')
    methods = {'GAUSS': 0, 'LAPLACE': 1, 'GIBBS': 2, 'HERRICK_GIBBS': 3}
    if method.upper() not in ('GIBBS', 'HERRICK_GIBBS'):
        raise ValueError('Position input supports GIBBS or HERRICK_GIBBS; use estimation() for angles-only requests')
    request = obj('orbpro.estimation.InitialOrbitRequest', local=True)
    request.positionsM = positions.ravel()
    request.observerPositionsM = np.zeros(9)
    request.rightAscensionsRad = np.zeros(3)
    request.declinationsRad = np.zeros(3)
    request.epochs = obj('orbpro.estimation.EstimationEpoch', local=True)
    request.epochs.jdDay = float(epoch_jd)
    request.epochs.seconds = 0.
    request.interval12Seconds, request.interval23Seconds = map(float, intervals_seconds)
    request.gravitationalParameterM3S2 = float(mu_m3_s2)
    request.method = methods[method.upper()]
    envelope = obj('orbpro.estimation.EstimationEnvelope', local=True)
    envelope.initialOrbitRequest = request
    decoded = estimation(envelope, method='initial_orbit')
    result = decoded.initialOrbitResult
    if result.status != 0:
        raise RuntimeError(f'Initial orbit status {result.status}')
    return np.array(result.state)


def estimation(request, *, propagator_samples=None, method='run_estimation'):
    """Invoke an EstimationEnvelope generated object, returning its decoded result.

    The caller supplies state/STM samples from its selected propagator. Fixed
    array fields accept contiguous NumPy arrays; no provider is hardwired.
    """
    inputs = [Frame('request', pack(request, '$EST'), 'Estimation.fbs', '$EST', 'EstimationEnvelope')]
    if propagator_samples is not None:
        inputs.append(Frame('propagator_samples', pack(propagator_samples, '$EST'),
                            'Estimation.fbs', '$EST', 'EstimationEnvelope'))
    with Module('analysis/estimation') as module:
        return unpack('orbpro.estimation.EstimationEnvelope', output(module.invoke(method, inputs), 'observations' if method == 'simulate_tracking' else 'result'), local=True)


def conjunction_assessment(request, *, method='screen_catalog', start_jd=None,
                           duration_days=7., threshold_km=5., threads=1):
    """Screen a sequence of CCSDS OMM mappings, or invoke a generated request.

    Screen request GP angles are degrees and motion rev/day; track positions km,
    velocities km/s, epochs JD. numThreads is explicit in the request.
    """
    if isinstance(request, (list, tuple)):
        if method != 'screen_catalog' or start_jd is None:
            raise ValueError('An OMM catalog requires screen_catalog and start_jd')
        fields = {'OBJECT_NAME':'objectName','OBJECT_ID':'objectId','EPOCH':'epoch',
            'MEAN_MOTION':'meanMotion','ECCENTRICITY':'eccentricity','INCLINATION':'inclination',
            'RA_OF_ASC_NODE':'raOfAscNode','ARG_OF_PERICENTER':'argOfPericenter',
            'MEAN_ANOMALY':'meanAnomaly','EPHEMERIS_TYPE':'ephemerisType',
            'CLASSIFICATION_TYPE':'classificationType','NORAD_CAT_ID':'noradCatId',
            'ELEMENT_SET_NO':'elementSetNo','REV_AT_EPOCH':'revAtEpoch','BSTAR':'bstar',
            'MEAN_MOTION_DOT':'meanMotionDot','MEAN_MOTION_DDOT':'meanMotionDdot'}
        gps = []
        for record in request:
            gp = obj('orbpro.conjunction.GpRecord', local=True)
            for key, value in record.items():
                if key in fields:
                    setattr(gp, fields[key], value)
            gps.append(gp)
        request = obj('orbpro.conjunction.ConjunctionScreenCatalogRequest', local=True)
        request.primaryGps = gps
        request.startJd = float(start_jd)
        request.durationDays = float(duration_days)
        request.thresholdKm = float(threshold_km)
        if not isinstance(threads, int) or threads < 1:
            raise ValueError('threads must be a positive integer')
        request.numThreads = threads
    types = {'screen_catalog': ('ConjunctionScreenCatalogRequest', 'CASQ', 'ConjunctionScreenCatalogResult'),
             'compute_pc': ('ConjunctionPcRequest', 'CAPR', 'ConjunctionPcResult'),
             'alfano_max_probability': ('ConjunctionAlfanoRequest', 'CAAR', 'ConjunctionAlfanoResult'),
             'find_tca': ('ConjunctionPairRequest', 'CAPQ', 'ConjunctionFindTcaResult'),
             'assess_conjunction': ('ConjunctionPairRequest', 'CAPQ', 'ConjunctionEvent')}
    name, identifier, result_name = types[method]
    with Module('analysis/conjunction-assessment') as module:
        data = output(module.invoke(method, [Frame('request', pack(request, identifier),
                            'orbpro.conjunction.' + name, identifier, name)]))
    return plain(unpack('orbpro.conjunction.' + result_name, data, local=True))


def conjunction_track(julian_dates, states_km, *, norad_id, reference_frame=3):
    """Marshal an (N,6) km/km/s array into a caller-propagated track (TEME=3)."""
    dates = array(julian_dates).reshape(-1)
    states = array(states_km, (len(dates), 6))
    if len(dates) < 2 or np.any(np.diff(dates) <= 0):
        raise ValueError('Track epochs must contain two or more increasing JDs')
    track = obj('orbpro.conjunction.PropagatedTrack', local=True)
    track.noradCatId = int(norad_id)
    track.referenceFrame = int(reference_frame)
    track.samples = []
    for jd, state in zip(dates, states):
        sample = obj('orbpro.conjunction.PropagatedSample', local=True)
        sample.jd = float(jd)
        for key, value in zip(('xKm','yKm','zKm','vxKmS','vyKmS','vzKmS'), state):
            setattr(sample, key, float(value))
        track.samples.append(sample)
    return track


def estimation_samples(julian_dates, states_si, state_transition_matrices):
    """Marshal caller-selected propagator states (N,6) and STMs (N,6,6).

    Positions are m, velocities m/s. Epoch days use the estimation frame/time
    convention supplied in the request; this helper performs no propagation.
    """
    dates = array(julian_dates).reshape(-1)
    states = array(states_si, (len(dates), 6))
    matrices = array(state_transition_matrices, (len(dates), 6, 6))
    envelope = obj('orbpro.estimation.EstimationEnvelope', local=True)
    envelope.propagatorSamples = []
    for jd, state, matrix in zip(dates, states, matrices):
        sample = obj('orbpro.estimation.EstimationPropagatorSample', local=True)
        sample.epoch = obj('orbpro.estimation.EstimationEpoch', local=True)
        sample.epoch.jdDay = float(jd)
        sample.state = state
        sample.stm = matrix.ravel()
        envelope.propagatorSamples.append(sample)
    return envelope


def access(julian_dates_tt, positions_ecef_m, stations, *, target_station_id=None,
           min_elevation_rad=0.):
    """Compute ACW windows from ECEF metres and TT Julian dates.

    stations is a sequence of generated ACWGroundStationT or mappings using
    ratified field names (STATION_ID, LATITUDE_RAD, LONGITUDE_RAD, ALTITUDE_M).
    """
    dates = array(julian_dates_tt).reshape(-1)
    positions = array(positions_ecef_m, (len(dates), 3))
    if len(dates) < 2 or np.any(np.diff(dates) <= 0):
        raise ValueError('At least two strictly increasing TT Julian dates required')
    station_objects = [obj('ACW.ACWGroundStation', **s) if isinstance(s, dict) else s for s in stations]
    samples = [obj('ACW.ACWStateSample', float(jd), *xyz) for jd, xyz in zip(dates, positions)]
    request = obj('ACW.ACWRequest', 1, station_objects, samples, target_station_id,
                  min_elevation_rad, 'python')
    with Module('analysis/access') as module:
        result = unpack('ACW.ACW', output(module.invoke('compute_access_windows',
            [frame('request', obj('ACW.ACW', request, None), 'ACW')]))).RESULT
    if result.STATUS != 0:
        raise RuntimeError(plain(result.ERROR_MESSAGE))
    return plain(result.WINDOWS)


def events(epochs_utc, states_km, request, *, earth_orientation=None):
    """Locate events on caller-provided Cartesian ephemeris (km, km/s).

    request is an EVLEventLocationRequestT. Its frame/time context is explicit;
    epochs_utc are ISO-8601 labels. Return the EVL event report as a mapping.
    """
    states = array(states_km, (len(epochs_utc), 6))
    lines = [obj('OEM.ephemerisDataLine', EPOCH=epoch, X=row[0], Y=row[1], Z=row[2],
                 X_DOT=row[3], Y_DOT=row[4], Z_DOT=row[5]) for epoch, row in zip(epochs_utc, states)]
    ephemeris = obj('OEM.OEM', EPHEMERIS_DATA_BLOCK=[obj('OEM.ephemerisDataBlock', EPHEMERIS_DATA_LINES=lines)])
    inputs = [frame('request', obj('EVL.EVL', LOCATION_REQUEST=request), 'EVL'), frame('ephemeris', ephemeris, 'OEM')]
    if earth_orientation is not None:
        inputs.append(frame('earth_orientation', earth_orientation, 'EOP'))
    with Module('propagator/events') as module:
        result = unpack('EVL.EVL', output(module.invoke('locate_events', inputs), 'report'))
    return plain(result.EVENT_REPORT)
