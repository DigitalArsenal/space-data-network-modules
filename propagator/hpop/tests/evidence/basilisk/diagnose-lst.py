#!/usr/bin/env python3
"""Measure native NRLMSISE local-solar-time wrapping at stored hourly states.

This generates diagnostic evidence, not assertions or another test suite.
Run with the installed bsk-venv/bin/python -I. No trajectory is propagated.
"""
import argparse
import datetime
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys

for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS',
              'VECLIB_MAXIMUM_THREADS', 'NUMEXPR_NUM_THREADS'):
    os.environ[_name] = '1'
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
EXPORT = HERE.parent / 'cases/hpop-reference-cases.json'


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def pin(path):
    path = Path(path).resolve()
    return {'path': os.path.relpath(path, HERE), 'sha256': digest(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--trajectories', action='append', type=Path,
                        help='stored Basilisk record; repeat for multiple records')
    parser.add_argument('--out', type=Path, default=HERE / 'lst-probes.json')
    args = parser.parse_args()
    if not sys.flags.isolated or sys.version_info[:2] != (3, 14):
        raise RuntimeError('Run the installed Python 3.14 with -I')
    paths = args.trajectories or [HERE / 'basilisk-2.12.0.json']
    backend = load_module('basilisk_lst_backend', HERE / 'basilisk-backend.py')
    native = load_module('basilisk_lst_native', HERE / 'investigate-basilisk.py')
    import Basilisk
    from Basilisk.simulation import _msisAtmosphere
    import erfa
    import numpy as np
    if Basilisk.__version__ != '2.12.0':
        raise RuntimeError('Expected the pinned Basilisk 2.12.0 wheel')
    export = json.loads(EXPORT.read_text())
    export_hash = digest(EXPORT)
    definitions = {case['id']: case for case in export['cases']}
    bsk = Path(Basilisk.__file__).parent
    erfa_dir = Path(erfa.__file__).parent
    numpy_dir = Path(np.__file__).parent
    distribution = Path(importlib.metadata.distribution('bsk')._path)
    files = [Path(__file__), EXPORT, *paths, HERE / 'basilisk-backend.py',
             HERE / 'investigate-basilisk.py', HERE.parent / 'erfa-spice/reference.py',
             HERE.parent / 'erfa-spice/tools.json', Path(sys.executable),
             bsk / '_buildAbiData.py', bsk / '_buildInfoData.py',
             distribution / 'METADATA', distribution / 'WHEEL', distribution / 'RECORD',
             erfa_dir / 'core.py', erfa_dir / 'ufunc.abi3.so', Path(np.__file__)]
    files += sorted(bsk.rglob('*.so')) + sorted((bsk / '.dylibs').glob('*.dylib'))
    files += sorted(numpy_dir.rglob('*.so')) + sorted(numpy_dir.rglob('*.dylib'))
    # These files explain the comparison; their implementation is never run.
    files += [HERE.parents[2] / 'lib/astrodynamics.cpp',
              HERE.parents[4] / 'third_party/nrlmsise00/nrlmsise-00.c']
    results = []
    maximum_absolute = maximum_relative = 0.0
    total_states = wrapped_states = 0
    for path in paths:
        record = json.loads(path.read_text())
        if record.get('caseExportSha256') != export_hash:
            raise ValueError('Trajectory/export SHA-256 mismatch: ' + str(path))
        for stored in record['cases']:
            case = definitions[stored['id']]
            drag = case['forces'].get('drag')
            if not drag or drag['atmosphere'] != 'NRLMSISE00':
                continue
            if case['frame'] != 'GCRF':
                raise ValueError('Diagnostic requires GCRF stored states: ' + case['id'])
            eop = export['earthOrientation'][case['earthOrientation']]['rows']
            utc1, utc2 = backend._reference.two_part_utc(case['epochUtc'])
            tt1, tt2 = erfa.taitt(*erfa.utctai(utc1, utc2))
            start = datetime.datetime.fromisoformat(case['epochUtc'])
            for series in ('samples', 'fineSamples'):
                if series not in stored:
                    continue
                rows = []
                for sample in stored[series]:
                    elapsed = sample[0]
                    instant = start + datetime.timedelta(seconds=elapsed)
                    epoch_utc = instant.isoformat(timespec='microseconds')
                    seconds = (instant.hour * 3600 + instant.minute * 60
                               + instant.second + instant.microsecond / 1e6)
                    rotation = backend._reference.c2t_iers2010(
                        tt1, tt2 + elapsed / 86400, eop)[0]
                    longitude, latitude, altitude = erfa.gc2gd(
                        1, rotation @ np.asarray(sample[1:4]))
                    longitude = float(np.rad2deg(longitude))
                    latitude = float(np.rad2deg(latitude))
                    weather = backend._weather(export, drag, epoch_utc)
                    raw_lst = seconds / 3600 + longitude / 15
                    wrapped_lst = raw_lst % 24
                    common = {'altitude_km': float(altitude / 1000),
                              'latitude_deg': latitude, 'longitude_deg': longitude,
                              'seconds': seconds, 'day_of_year': instant.timetuple().tm_yday,
                              'f107': weather[22], 'f107a': weather[21], 'ap': weather[0]}
                    raw_density = native.density(local_solar_time=raw_lst, **common)
                    wrapped_density = native.density(local_solar_time=wrapped_lst, **common)
                    difference = wrapped_density - raw_density
                    relative = difference / raw_density if raw_density else None
                    total_states += 1
                    wrapped_states += raw_lst != wrapped_lst
                    maximum_absolute = max(maximum_absolute, abs(difference))
                    if relative is not None:
                        maximum_relative = max(maximum_relative, abs(relative))
                    rows.append({'offsetTtS': elapsed, 'epochUtc': epoch_utc,
                                 'positionGcrfM': sample[1:4],
                                 'inputs': common, 'unwrappedLocalSolarTimeHours': raw_lst,
                                 'wrappedLocalSolarTimeHours': wrapped_lst,
                                 'unwrappedDensityKgM3': raw_density,
                                 'wrappedDensityKgM3': wrapped_density,
                                 'wrappedMinusUnwrappedDensityKgM3': difference,
                                 'relativeToUnwrapped': relative})
                results.append({'trajectoryFile': os.path.relpath(path.resolve(), HERE),
                                'variant': record['settings']['variant'], 'id': case['id'],
                                'series': series, 'rows': rows})
    result = {
        'about': 'Native Basilisk NRLMSISE gtd7d density comparison at identical stored hourly states; no propagation or pass/fail assertions.',
        'protocol': {
            'source': 'Installed AVS Lab Basilisk 2.12.0 native NRLMSISE gtd7d; pinned ERFA GCRF-to-ITRF and WGS84 gc2gd; immutable neutral-export epochs/EOP/space weather',
            'comparison': 'Identical native gtd7d inputs except local solar time: raw UTC-hours plus longitude-degrees/15 versus modulo 24 hours.',
            'rationale': 'HPOP computeNRLMSISE00 wraps mean local solar time. The frozen Basilisk adapter preserves the native unwrapped convention. The NRLMSISE source uses the rounded hourly angle constant 0.2618, so a 24-hour shift is not exactly periodic numerically.',
            'units': {'position': 'm', 'altitude_km': 'km', 'latitude_deg': 'deg',
                      'longitude_deg': 'deg', 'seconds': 'UTC seconds of day',
                      'offsetTtS': 'elapsed TT s', 'localSolarTime': 'h',
                      'density': 'kg/m^3', 'relativeToUnwrapped': 'dimensionless',
                      'f107': '10^-22 W m^-2 Hz^-1', 'f107a': '10^-22 W m^-2 Hz^-1',
                      'ap': 'daily Ap index'},
            'frame': 'Stored GCRF position rotated to exported ITRF by pinned ERFA; WGS84 geodetic altitude and latitude.',
            'epoch': 'Each row records its UTC epoch; exported TT elapsed seconds advance the split TT date for Earth orientation. These 2026 arcs contain no leap second.',
            'switches': 'All native switches are 1: SI output, daily Ap, all variations enabled; gtd7d includes anomalous oxygen at every altitude.',
            'tolerance': None,
            'limitation': 'Same-state hourly density measurements do not establish a propagated trajectory error, do not sample every integration midpoint, and do not replace recorded native midpoint density messages.'},
        'tool': {'name': 'Basilisk', 'version': Basilisk.__version__, 'python': sys.version,
                 'numpy': np.__version__, 'pyerfa': erfa.__version__, 'erfa': erfa.version.erfa_version},
        'nativeMsisLibrary': pin(_msisAtmosphere.__file__),
        'caseExportSha256': export_hash,
        'inputFiles': [pin(path) for path in dict.fromkeys(Path(p).resolve() for p in files)],
        'summary': {'states': total_states, 'statesRequiringWrap': wrapped_states,
                    'maximumAbsoluteDensityDifferenceKgM3': maximum_absolute,
                    'maximumAbsoluteRelativeDifference': maximum_relative},
        'cases': results,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1, allow_nan=False) + '\n')
    print(f'Wrote {args.out}: {total_states} same-state density comparisons; '
          f'maximum absolute relative difference {maximum_relative:.9g}')


if __name__ == '__main__':
    main()
