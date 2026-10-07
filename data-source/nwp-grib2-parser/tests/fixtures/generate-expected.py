# The independent reference for the fixture files: ecCodes (ECMWF's GRIB library) reads every message; the packing
# integer of each grid point is recovered from ecCodes' value exactly - X = (v 10^D - R) / 2^E - and laid out as the
# parser must publish it (rows south to north, every `stride`-th point): kept as the SHA-256 of those codes (and 64
# sampled points to name a mismatch), with the record attributes (names as the
# world-clouds reference encoders name them, from ecCodes' own shortName / typeOfLevel / level keys). Deterministic:
# rerunning it leaves git diff clean.
#   python3 tests/fixtures/generate-expected.py        (eccodes and numpy installed)
import hashlib, json, os
import numpy as np
from eccodes import codes_grib_new_from_file, codes_get, codes_get_values, codes_release

HERE = os.path.dirname(os.path.abspath(__file__))
SET = os.path.join(HERE, 'noaa-2026100600-f024')
# the jobs the source module's select node emits for these products
JOBS = json.load(open(os.path.join(HERE, 'jobs.json')))
NAMES = {('u', 'isobaricInhPa'): 'wind_east_{}hPa', ('v', 'isobaricInhPa'): 'wind_north_{}hPa', ('gh', 'isobaricInhPa'): 'geopotential_height_{}hPa',
         ('tcc', 'atmosphere'): 'cloud_cover_total', ('lcc', 'lowCloudLayer'): 'cloud_cover_low', ('mcc', 'middleCloudLayer'): 'cloud_cover_mid',
         ('hcc', 'highCloudLayer'): 'cloud_cover_high', ('2t', 'heightAboveGround'): 'air_temperature_{}m'}
PERCENT = {'tcc', 'lcc', 'mcc', 'hcc'}
expected = {}
for file, job in JOBS.items():
    records = []
    with open(os.path.join(SET, file), 'rb') as f:
        index = 0
        while (h := codes_grib_new_from_file(f)) is not None:
            g = lambda k: codes_get(h, k)
            short, kind, level = g('shortName'), g('typeOfLevel'), g('level')
            name = NAMES[(short, kind)].format(level) + ('_spread' if job.get('spread') else '')
            v = codes_get_values(h); ni, nj = g('Ni'), g('Nj'); R, E, D = float(g('referenceValue')), g('binaryScaleFactor'), g('decimalScaleFactor')
            missing = v == g('missingValue') if g('bitmapPresent') else np.zeros(v.size, bool)
            X = np.where(missing, 65535, np.rint((v * 10.0 ** D - R) / 2.0 ** E)).astype(np.int64)
            assert X.max() <= 65535 and X.min() >= 0
            grid = X.reshape(nj, ni)[::-1]                      # rows south to north
            s = job.get('stride', 1)
            grid = grid[::s, ::s].astype('<u2')
            factor = 0.01 if short in PERCENT else 1.0
            band = job.get('band_rows') or grid.shape[0]
            flat = grid.ravel()
            sha = hashlib.sha256(grid.tobytes()).hexdigest()                 # (little-endian uint16, rows south to north)
            picks = [int(i) for i in np.linspace(0, flat.size - 1, 64).round()]
            init = int(g('dataDate')); hh = g('dataTime') // 100
            records.append(dict(name=name, short=short, sha256=sha, samples={str(i): int(flat[i]) for i in picks}, nlat=int(grid.shape[0]), nlon=int(grid.shape[1]), band_rows=int(band),
                                bands=int(-(-grid.shape[0] // band)), lat0=-90.0, lon0=float(g('longitudeOfFirstGridPointInDegrees')),
                                dlat=float(g('jDirectionIncrementInDegrees')) * s, dlon=float(g('iDirectionIncrementInDegrees')) * s,
                                scale=2.0 ** E / 10.0 ** D * factor, offset=R / 10.0 ** D * factor, init=f'{init}T{hh:02d}', lead=int(g('step')),
                                missing=int(missing.reshape(nj, ni)[::-1][::s, ::s].sum())))
            codes_release(h); index += 1
    expected[file] = records
with open(os.path.join(SET, 'expected.json'), 'w') as fh: json.dump(expected, fh, indent=1, sort_keys=True); fh.write('\n')
for file, recs in expected.items(): print(file, [r['name'] for r in recs])
