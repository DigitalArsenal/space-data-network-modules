"""Conjunction-assessment marshalling: SDS $CQR objects in, mappings out.

The WASM module screens, finds the time of closest approach and computes the
probability of collision. Nothing here propagates, interpolates or integrates.
"""
import numpy as np

from ._codec import array, obj
from .sds.CQR.CelestialFrame import CelestialFrame
from .sds.CQR.RFMUnion import RFMUnion
from .sds.CQR.meanElementSource import meanElementSource
from .sds.CQR.rfmAxisType import rfmAxisType
from .sds.CQR.rfmOriginKind import rfmOriginKind
from .sds.CQR.timEpochRepresentation import timEpochRepresentation
from .sds.CQR.timingStandard import timingStandard

EARTH_NAIF_ID = 399
# Evaluation-frame axes by the frame names a caller passes; TEME is the
# true-equator mean-equinox-of-date frame (SGP4 output) and its SANA name is
# TEMEOFDATE.
_AXES = {'TEME': rfmAxisType.TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE,
         'TEMEOFDATE': rfmAxisType.TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE,
         'GCRF': rfmAxisType.ICRF, 'ICRF': rfmAxisType.ICRF,
         'EME2000': rfmAxisType.MEAN_EQUATOR_EQUINOX_J2000,
         'J2000': rfmAxisType.MEAN_EQUATOR_EQUINOX_J2000}


def _celestial_name(name):
    name = str(name).upper()
    if name not in _AXES:
        raise ValueError(f'Unknown reference frame {name!r}; use one of {sorted(_AXES)}')
    return 'TEMEOFDATE' if name == 'TEME' else name


def evaluation_frame(name='TEME'):
    """Earth-centred coordinate system the encounter is evaluated in."""
    name = _celestial_name(name)
    return obj('CQR.RFMCoordinateSystem', NAME=name, AXIS_TYPE=_AXES[name],
               ORIGIN=obj('CQR.RFMOrigin', KIND=rfmOriginKind.CELESTIAL_BODY,
                          CELESTIAL_BODY_ID=EARTH_NAIF_ID))


def _frame_wrapper(name):
    return obj('CQR.RFM', REFERENCE_FRAME_type=RFMUnion.CelestialFrameWrapper,
               REFERENCE_FRAME=obj('CQR.CelestialFrameWrapper',
                                   frame=getattr(CelestialFrame, _celestial_name(name))))


def utc_julian_date(jd):
    return obj('CQR.TIMInstant', TIME_SYSTEM=timingStandard.UTC,
               EPOCH_FORMAT=timEpochRepresentation.JULIAN_DATE, JULIAN_DATE=float(jd))


def screening_controls(start_jd, duration_days, threshold_km, threads):
    if not isinstance(threads, int) or threads < 1:
        raise ValueError('threads must be a positive integer')
    return obj('CQR.CQRScreeningControls', START_EPOCH=utc_julian_date(start_jd),
               DURATION_SECONDS=float(duration_days) * 86400.,
               THRESHOLD_M=float(threshold_km) * 1000., REQUESTED_WORKERS=threads)


def omm_source(record):
    """A CQR source of SGP4 mean elements from a CCSDS OMM mapping.

    Angles are degrees and motion rev/day, as in the OMM. The elements are TEME
    of date, UTC, for the SGP4 theory.
    """
    omm = obj('CQR.OMM', CENTER_NAME='EARTH', REFERENCE_FRAME=_frame_wrapper('TEME'),
              TIME_SYSTEM=timingStandard.UTC, MEAN_ELEMENT_THEORY=meanElementSource.SGP4,
              EPHEMERIS_TYPE=meanElementSource.SGP4)
    for key, value in dict(record).items():
        if key in ('EPHEMERIS_TYPE', 'MEAN_ELEMENT_THEORY', 'CENTER_NAME', 'REFERENCE_FRAME', 'TIME_SYSTEM'):
            continue
        if not hasattr(omm, key):
            raise ValueError(f'Unknown OMM field {key}')
        setattr(omm, key, value)
    norad = int(omm.NORAD_CAT_ID)
    return obj('CQR.CQRObjectSource', OBJECT_ID=omm.OBJECT_ID or str(norad),
               OBJECT_NAME=omm.OBJECT_NAME, NORAD_CATALOG_ID=norad,
               PROPAGATOR_PORT_ID='sgp4', MEAN_ELEMENTS=omm)


def _iso_utc(jd):
    day = int(np.floor(jd - 2440587.5))
    seconds = (jd - 2440587.5 - day) * 86400.
    whole = int(np.floor(seconds))
    nanos = int(round((seconds - whole) * 1e9))
    if nanos == 1_000_000_000:
        whole, nanos = whole + 1, 0
    hour, rest = divmod(whole, 3600)
    date = np.datetime64(day, 'D')
    return f'{date}T{hour:02d}:{rest // 60:02d}:{rest % 60:02d}.{nanos:09d}Z'


def track_source(julian_dates, states_km, *, norad_id, reference_frame='TEME', object_id=None):
    """A CQR source of caller-propagated states.

    julian_dates are UTC JD, increasing; states are (N,6) km and km/s in
    reference_frame, which the caller names (a sampled source never guesses it).
    """
    dates = array(julian_dates).reshape(-1)
    states = array(states_km, (len(dates), 6))
    if len(dates) < 2 or np.any(np.diff(dates) <= 0):
        raise ValueError('Track epochs must contain two or more increasing JDs')
    lines = [obj('CQR.ephemerisDataLine', EPOCH=_iso_utc(float(jd)), X=row[0], Y=row[1], Z=row[2],
                 X_DOT=row[3], Y_DOT=row[4], Z_DOT=row[5]) for jd, row in zip(dates, states)]
    block = obj('CQR.ephemerisDataBlock', CENTER_NAME='EARTH', CENTER_NAIF_ID=EARTH_NAIF_ID,
                REFERENCE_FRAME=_frame_wrapper(reference_frame), TIME_SYSTEM=timingStandard.UTC,
                EPHEMERIS_DATA_LINES=lines)
    return obj('CQR.CQRObjectSource', OBJECT_ID=object_id or str(int(norad_id)),
               NORAD_CATALOG_ID=int(norad_id),
               EPHEMERIS=obj('CQR.OEM', EPHEMERIS_DATA_BLOCK=[block]))


def catalog_request(records, *, start_jd, duration_days, threshold_km, threads):
    """Screen every pair of the given OMM mappings (primaries against each other)."""
    request = obj('CQR.CQRCatalogRequest', PRIMARIES=[omm_source(r) for r in records],
                  CONTROLS=screening_controls(start_jd, duration_days, threshold_km, threads),
                  EVALUATION_FRAME=evaluation_frame('TEME'))
    return obj('CQR.CQR', CATALOG_REQUEST=request)


def _text(value):
    return value.decode('utf8') if isinstance(value, bytes) else value


def conjunction(event):
    """One CQREvent as a mapping; ranges km, speeds km/s, epochs UTC JD."""
    probability = event.PROBABILITY
    return {'obj1Name': _text(event.PRIMARY_NAME), 'obj1Id': _text(event.PRIMARY_ID),
            'obj1Norad': event.PRIMARY_NORAD_ID, 'obj2Name': _text(event.SECONDARY_NAME),
            'obj2Id': _text(event.SECONDARY_ID), 'obj2Norad': event.SECONDARY_NORAD_ID,
            'tcaJd': event.TCA.JULIAN_DATE, 'tcaIso': _text(event.TCA.ISO8601),
            'minRangeKm': event.MISS_DISTANCE_M / 1000., 'relSpeedKms': event.RELATIVE_SPEED_M_S / 1000.,
            'maxProbability': None if probability is None else probability.PROBABILITY}


def catalog_result(result):
    """A CQRCatalogResult as a mapping with its conjunctions and statistics."""
    stats = result.STATISTICS
    return {'objectsParsed': result.OBJECTS_PARSED, 'conjunctionsFound': result.CONJUNCTIONS_FOUND,
            'conjunctions': [conjunction(e) for e in (result.EVENTS or [])],
            'stats': None if stats is None else {
                'totalObjects': stats.TOTAL_OBJECTS, 'pairsScreened': stats.PAIRS_SCREENED,
                'pairsPrefiltered': stats.PAIRS_PREFILTERED, 'kdtreeCandidates': stats.KD_TREE_CANDIDATES,
                'tcaRefined': stats.TCA_REFINED, 'conjunctionsFound': stats.CONJUNCTIONS_FOUND,
                'propagations': stats.PROPAGATIONS, 'failedPairs': stats.FAILED_PAIRS}}
