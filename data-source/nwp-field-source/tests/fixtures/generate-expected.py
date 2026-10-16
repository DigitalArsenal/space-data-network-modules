# The independent reference for gfs-0p50-surface.grib2 (the seven surface messages gfs-0p50-clouds also carries): ecCodes
# (ECMWF's GRIB library) reads every message; the packing integer of each grid point is recovered from ecCodes' value
# exactly - X = (v 10^D - R) / 2^E - and laid out as nwp-grib2-parser must publish it (rows south to north): kept as the
# SHA-256 of those codes (little-endian uint16) and 64 sampled points to name a mismatch, beside the record's attributes
# (names as the world-clouds reference encoders name them; the parameter is ecCodes' own discipline / category / number
# and level, not nwp-grib2-parser's table) and the field's values at the 64 points as ecCodes decodes them. Deterministic:
# rerunning it leaves git diff clean.
#   python3 -I tests/fixtures/generate-expected.py        (eccodes and numpy installed)
import hashlib, json, os
import numpy as np
from eccodes import codes_grib_new_from_file, codes_get, codes_get_values, codes_release

HERE = os.path.dirname(os.path.abspath(__file__))
SET = os.path.join(HERE, 'noaa-2026100600-f024')
FILE = 'gfs-0p50-surface.grib2'
NAMES = {(0, 0, 0, 'heightAboveGround'): 'air_temperature_{}m', (0, 0, 6, 'heightAboveGround'): 'dew_point_temperature_{}m',
         (0, 2, 2, 'heightAboveGround'): 'wind_east_{}m', (0, 2, 3, 'heightAboveGround'): 'wind_north_{}m',
         (0, 3, 196, 'surface'): 'boundary_layer_height_surface', (0, 7, 6, 'surface'): 'convective_available_potential_energy_surface',
         (0, 3, 5, 'surface'): 'geopotential_height_surface'}
records = []
with open(os.path.join(SET, FILE), 'rb') as f:
    while (h := codes_grib_new_from_file(f)) is not None:
        g = lambda k: codes_get(h, k)
        key = (g('discipline'), g('parameterCategory'), g('parameterNumber'), g('typeOfLevel'))
        name = NAMES[key].format(g('level'))
        v = codes_get_values(h); ni, nj = g('Ni'), g('Nj'); R, E, D = float(g('referenceValue')), g('binaryScaleFactor'), g('decimalScaleFactor')
        assert not g('bitmapPresent') and g('packingType') == 'grid_complex_spatial_differencing'
        X = np.rint((v * 10.0 ** D - R) / 2.0 ** E).astype(np.int64)
        assert X.max() <= 65535 and X.min() >= 0
        grid = X.reshape(nj, ni)[::-1].astype('<u2')         # rows south to north
        flat = grid.ravel()
        values = v.reshape(nj, ni)[::-1].ravel()
        picks = [int(i) for i in np.linspace(0, flat.size - 1, 64).round()]
        init = int(g('dataDate')); hh = g('dataTime') // 100
        records.append(dict(name=name, sha256=hashlib.sha256(grid.tobytes()).hexdigest(), samples={str(i): int(flat[i]) for i in picks},
                            values={str(i): float(values[i]) for i in picks}, nlat=int(nj), nlon=int(ni), lat0=-90.0,
                            lon0=float(g('longitudeOfFirstGridPointInDegrees')), dlat=float(g('jDirectionIncrementInDegrees')),
                            dlon=float(g('iDirectionIncrementInDegrees')), scale=2.0 ** E / 10.0 ** D, offset=R / 10.0 ** D,
                            init=f'{init}T{hh:02d}', lead=int(g('step')), missing=0))
        codes_release(h)
with open(os.path.join(SET, 'expected.json'), 'w') as fh:
    json.dump({FILE: records}, fh, indent=1, sort_keys=True); fh.write('\n')
print(FILE, [r['name'] for r in records])
