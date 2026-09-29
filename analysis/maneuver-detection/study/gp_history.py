"""One object's GP history from the SDN GP archive (Space-Track gp_history
day files plus the 1959-2022 per-object zip). One element set per EPOCH, the
latest CREATION_DATE.

usage: python3 gp_history.py <archive-root> <norad> <from-epoch> <out.json>
"""
import csv, glob, gzip, io, json, sys, zipfile
from multiprocessing import Pool

root, norad, since, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

def day(path):
    try: rows = json.loads(gzip.open(path).read())
    except Exception: return []
    return [r for r in rows if str(r.get('NORAD_CAT_ID')) == norad]

if __name__ == '__main__':
    files = sorted(glob.glob(f'{root}/spacetrack/gp_history/by-creation/*/*.json.gz'))
    rows = []
    with Pool() as pool:
        for part in pool.imap_unordered(day, files, chunksize=4): rows += part
    zips = glob.glob(f'{root}/historical/*/Archives2.zip')
    if zips:
        with zipfile.ZipFile(zips[0]) as z:
            try: rows += list(csv.DictReader(io.TextIOWrapper(z.open(f'Archives2/sat{int(norad):09d}.csv'))))
            except KeyError: pass
    latest = {}
    for r in rows:
        if r['EPOCH'] < since: continue
        if r['EPOCH'] not in latest or r.get('CREATION_DATE', '') >= latest[r['EPOCH']].get('CREATION_DATE', ''):
            latest[r['EPOCH']] = r
    sets = [latest[k] for k in sorted(latest)]
    json.dump(sets, open(out, 'w'))
    print(f'{len(sets)} element sets for {norad} since {since}')
