"""ISS maneuver truth from NASA's public ISS trajectory archive.

NASA JSC/FOD/TOPO publishes the ISS ephemeris (CCSDS OEM, EME2000) with a
trajectory event summary in its header: each planned maneuver's name, TIG
(ignition, GMT day-of-year), delta-V (m/s) and resulting apogee/perigee (km).
Dated copies are kept at s3://nasa-public-data/iss-coords/<date>/.

For every burn (DV > 0) this keeps the last plan issued before its TIG (issued
within 4 days of it), then checks execution with NASA's own ephemerides: the
orbit-averaged semi-major axis of the first file issued after TIG against the
pre-TIG file's modeled trajectory over the same two revolutions. A burn counts
as executed when the post-TIG file (issued before any other planned burn) agrees with the plan to 35 % of the modeled
change. No GP data is used.

usage: python3 nasa_iss_truth.py <work-dir>   (writes <work-dir>/iss-truth.json)
"""
import datetime as dt, json, os, re, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

BUCKET = 'https://nasa-public-data.s3.amazonaws.com'
MU = 398600.4418
UTC = dt.timezone.utc
work = sys.argv[1]
os.makedirs(f'{work}/hdr', exist_ok=True)
os.makedirs(f'{work}/full', exist_ok=True)

def get(url, rng=None):
    req = urllib.request.Request(url, headers={'Range': f'bytes={rng}'} if rng else {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode('latin-1')

keys, token = [], None
while True:
    url = f'{BUCKET}/?list-type=2&prefix=iss-coords/&max-keys=1000' + (f'&continuation-token={urllib.parse.quote(token)}' if token else '')
    page = get(url)
    keys += [k for k in re.findall(r'<Key>([^<]+)</Key>', page) if k.endswith('.txt') and 'OEM' in k and '/current/' not in k]
    m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', page)
    if not m: break
    token = m.group(1)
bydate = {k.split('/')[1]: k for k in keys}

def header(date):
    path = f'{work}/hdr/{date}.txt'
    if not os.path.exists(path):
        open(path, 'w').write(get(f'{BUCKET}/{bydate[date]}', '0-12000'))
    return open(path).read()

with ThreadPoolExecutor(12) as pool:
    headers = dict(zip(bydate, pool.map(header, bydate)))

files, plans, coverage, listed = [], {}, [], []
row = re.compile(r'COMMENT\s+(\S.*?)\s+(\d{3}):(\d\d):(\d\d):(\d\d(?:\.\d+)?)\s+(?:\d+\s+)?([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*$')
for date, text in headers.items():
    m = re.search(r'CREATION_DATE\s*=\s*(\S+)', text)
    if not m: continue
    created = dt.datetime.fromisoformat(m.group(1)[:19])
    files.append((created, date))
    stop = re.search(r'USEABLE_STOP_TIME\s*=\s*(\S+)', text)
    if stop: coverage.append([created.isoformat() + 'Z', stop.group(1)[:19] + 'Z'])
    for line in text.splitlines():
        r = row.match(line)
        if not r: continue
        name, doy, hh, mm, ss, dv, ha, hp = r.groups()
        year = created.year + (1 if int(doy) < created.timetuple().tm_yday - 180 else 0)
        tig = dt.datetime(year, 1, 1) + dt.timedelta(days=int(doy) - 1, hours=int(hh), minutes=int(mm), seconds=float(ss))
        if created <= tig: listed.append(tig.isoformat() + 'Z')
        if created > tig or float(dv) <= 0 or (tig - created).total_seconds() > 4 * 86400: continue
        key = round(tig.timestamp() / 21600)
        if key not in plans or created >= plans[key]['issued_dt']:
            plans[key] = dict(event=name.strip(), tig=tig.isoformat() + 'Z', dv_mps=float(dv), ha_km=float(ha), hp_km=float(hp),
                              issued=created.isoformat(), issued_dt=created)
files.sort()
burns = sorted(plans.values(), key=lambda b: b['tig'])
burn_tigs = sorted(dt.datetime.fromisoformat(b['tig'][:-1]) for b in burns)

def full(date):
    path = f'{work}/full/{date}.txt'
    if not os.path.exists(path):
        open(path, 'w').write(get(f'{BUCKET}/{bydate[date]}'))
    T, S = [], []
    for line in open(path, errors='ignore'):
        p = line.split()
        if len(p) == 7 and p[0][:2] == '20' and 'T' in p[0]:
            try:
                T.append(dt.datetime.fromisoformat(p[0][:23]).replace(tzinfo=UTC).timestamp()); S.append([float(x) for x in p[1:]])
            except ValueError: pass
    return T, S

def abar(T, S, t0, t1):
    rows = [s for t, s in zip(T, S) if t0 <= t <= t1]
    if len(rows) < 10: return None
    return sum(1 / (2 / (s[0]**2 + s[1]**2 + s[2]**2)**0.5 - (s[3]**2 + s[4]**2 + s[5]**2) / MU) for s in rows) / len(rows)

REV = 5560.0
for b in burns:
    tig_dt = dt.datetime.fromisoformat(b['tig'][:-1])
    pre = [d for c, d in files if c < tig_dt]
    # The first file issued 2 h after TIG, and before any other planned burn:
    # across an archive gap a later file can include a slipped re-plan.
    later = [t for t in burn_tigs if t > tig_dt + dt.timedelta(hours=6)]
    limit = min(later) if later else dt.datetime.max
    post = [d for c, d in files if tig_dt + dt.timedelta(hours=2) < c < limit]
    b['executed'] = None
    if not pre or not post: continue
    tig = tig_dt.replace(tzinfo=UTC).timestamp()
    Tp, Sp = full(pre[-1]); Tq, Sq = full(post[0])
    if not Tp or not Tq: continue
    before = abar(Tp, Sp, tig - 2 * REV - 600, tig - 600)
    w0 = max(Tq[0], tig + 1200)
    model, actual = abar(Tp, Sp, w0, w0 + 2 * REV), abar(Tq, Sq, w0, w0 + 2 * REV)
    if None in (before, model, actual): continue
    b.update(nasa_model_da_km=round(model - before, 4), nasa_actual_da_km=round(actual - before, 4),
             pre_file=pre[-1], post_file=post[0])
    # The burn is in NASA's trajectory when the modeled change is at least half
    # the plan's delta-V (da = 2 a dv / v, 1.77 km per m/s at the ISS); it
    # happened when the post-TIG file departs from that model by under 35 %.
    if abs(model - before) >= 0.5 * 1.77 * b['dv_mps']:
        b['executed'] = abs(actual - model) < 0.35 * abs(model - before)
for b in burns: b.pop('issued_dt')
json.dump({'source': f'{BUCKET}/iss-coords/', 'files': len(files), 'burns': burns,
           'coverage': sorted(coverage), 'listed_events': sorted(set(listed))}, open(f'{work}/iss-truth.json', 'w'), indent=1)
print(f'{len(files)} NASA files, {len(burns)} planned burns, {sum(1 for b in burns if b["executed"])} executed')
