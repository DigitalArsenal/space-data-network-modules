# The reference producer's output for the fixture files: its world product (DigitalArsenal/Cesium_Weather
# orbpro-gaussian-clouds/tools/raw_satellite.py world_product + world_level + quantize, numpy) for each file, as the
# exact codes of every world width and the record attributes the parser must reproduce. Deterministic: rerunning it
# leaves git diff clean.
#   python3 tests/fixtures/generate-expected.py <Cesium_Weather checkout>   (numpy and netCDF4 installed)
import glob, gzip, json, os, re, sys
import numpy as np
sys.path.insert(0, os.path.join(sys.argv[1], 'orbpro-gaussian-clouds', 'tools'))
import raw_satellite as R

HERE = os.path.dirname(os.path.abspath(__file__))
SET = os.path.join(HERE, 'goes19-m1-2026280-0600')
PRODUCTS = {'CMIPM1-M6C13': ('brightness_temperature_10um', 'CMI'), 'CMIPM1-M6C02': ('reflectance_064um', 'CMI'),
            'ACHAM1-M6': ('cloud_top_height', 'HT'), 'ACMM1-M6': ('cloud_mask', 'ACM'), 'ACTPM1-M6': ('cloud_phase', 'Phase')}
expected = {}
for path in sorted(glob.glob(os.path.join(SET, '*.nc'))):
    name = os.path.basename(path)
    product = next(p for p in PRODUCTS if f'-{p}_' in name)
    field, var = PRODUCTS[product]
    spec = R.FIELDS[field]
    arr, meta = R.read_nc_var(path, var)
    if 'convert' in spec: arr = spec['convert'](arr)
    grid = R.FixedGrid(meta['x'], meta['y'], meta['lon0'], meta['height'], meta['req'], meta['rpol'], meta['sweep'])
    if spec.get('fine'): arr, grid = R.block_mean(arr, grid, 4)
    fields = {field: (arr, grid)}
    if spec.get('categorical') and not spec.get('worldMean'): fields['cloud_top_height'] = (np.zeros_like(arr), grid)   # (rows from a sibling field)
    captured = {}
    R.write_world_levels = lambda blocks, r0, r1, out_dir, make: captured.update(blocks=blocks, r0=r0, r1=r1)
    R.world_product(None, 'x', {}, fields, {}, 0, HERE)
    block, r0, r1 = captured['blocks'][field], captured['r0'], captured['r1']
    cat = bool(spec.get('categorical') and not spec.get('worldMean'))
    widths = {}
    for width in R.WORLD_LEVELS:
        f = R.WORLD_W // width
        values = R.world_level(block, f, cat)
        codes, missing = R.quantize(values, spec)
        blob = codes.astype('<u2' if spec['enc'] == 'u16' else 'u1').tobytes()
        out = os.path.join(SET, f'{field}.{width}.codes.gz')
        with open(out, 'wb') as fh: fh.write(gzip.compress(blob, 9, mtime=0))
        l0, l1 = r0 // f, (r1 + f - 1) // f
        bands = [b for b in range(l0, l1, R.WORLD_ROWS)]
        valid = values[np.isfinite(values)]
        widths[str(width)] = dict(codes=os.path.basename(out), l0=l0, l1=l1, bands=len(bands), tile_count=(R.WORLD_H // f + R.WORLD_ROWS - 1) // R.WORLD_ROWS,
                                  missing=int(missing), min=float(valid.min()) if valid.size else 0.0, max=float(valid.max()) if valid.size else 0.0)
    scan = meta.get('scan') or [0, 0]
    expected[field] = dict(file=name, variable=var, units=spec['units'], variable_enum=spec['variable'], level_enum=spec['level'],
                           scale=spec['scale'], offset=spec['offset'], encoding='InlineEncodedChunk' if spec.get('codecs') else 'InlineQuantizedUint16' if spec['enc'] == 'u16' else 'InlineQuantizedUint8',
                           wavelength_um=spec.get('wavelength', {}).get('abi', 0), platform_lon0=meta['lon0'], platform_height=meta['height'],
                           scan_start_ms=scan[0], scan_end_ms=scan[1], rows=[r0, r1], widths=widths)
with open(os.path.join(SET, 'expected.json'), 'w') as fh: json.dump(expected, fh, indent=1, sort_keys=True); fh.write('\n')
print('\n'.join(f"{k}: rows {v['rows']}, " + ', '.join(f"{w} missing {x['missing']}" for w, x in v['widths'].items()) for k, v in expected.items()))
