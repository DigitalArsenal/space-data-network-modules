"""Rebuild the launch-trajectory test fixtures (provenance record; not run by the tests).

Inputs:
  * Webcast telemetry from github.com/shahar603/Telemetry-Data (The Unlicense),
    "<mission>/JSON/stage2 raw.json": time (s), velocity (m/s, Earth-relative),
    altitude (km), captured at 30 frames per second.
  * Space-Track GP history (Archives2.zip, one CSV per object), first element set
    of each launch's A piece.
  * The newest ISS element set in the Space-Track gp_history archive.
Truth is python-sgp4 2.24 (WGS-72, Vallado SGP4) in TEME, as osculating elements.

  python make-fixtures.py <telemetry-dir> <archive-zip> <iss-gp-json>
"""
import csv, io, json, math, sys, zipfile
from datetime import datetime, timedelta, timezone
from sgp4.api import Satrec, WGS72, jday

MU, RE = 398600.4418, 6378.137
MISSIONS = {
    'crs16': dict(dir='SpaceX_CRS-16', name='SpX CRS-16', t0='2018-12-05T18:16:16Z', pad=[28.56194122, -80.57735736],
                  norad=43827, intldes='2018-101A', cut=537.3, inclination_pass='NORTHBOUND'),
    'crs14': dict(dir='SpaceX_CRS-14', name='SpX CRS-14', t0='2018-04-02T20:30:38Z', pad=[28.56194122, -80.57735736],
                  norad=43267, intldes='2018-032A', cut=548.8, inclination_pass='NORTHBOUND'),
    'paz': dict(dir='Paz', name='PAZ & Microsat-2a, Microsat-2b', t0='2018-02-22T14:17:00Z', pad=[34.632, -120.611],
                norad=43215, intldes='2018-020A', cut=551.5, inclination_pass='SOUTHBOUND'),
}

def satrec(row):
    ep = datetime.fromisoformat(row['EPOCH'].replace('Z', '')).replace(tzinfo=timezone.utc)
    s = Satrec()
    s.sgp4init(WGS72, 'i', int(row['NORAD_CAT_ID']), (ep - datetime(1949, 12, 31, tzinfo=timezone.utc)).total_seconds() / 86400,
               float(row['BSTAR']), 0.0, 0.0, float(row['ECCENTRICITY']), math.radians(float(row['ARG_OF_PERICENTER'])),
               math.radians(float(row['INCLINATION'])), math.radians(float(row['MEAN_ANOMALY'])),
               float(row['MEAN_MOTION']) * 2 * math.pi / 1440, math.radians(float(row['RA_OF_ASC_NODE'])))
    return s

def teme(s, t):
    jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond / 1e6)
    e, r, v = s.sgp4(jd, fr)
    assert e == 0
    return r, v

def elements(r, v):
    rx = math.sqrt(sum(x * x for x in r)); vx = math.sqrt(sum(x * x for x in v))
    h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]]; hm = math.sqrt(sum(x * x for x in h))
    n = [-h[1], h[0], 0.0]; nm = math.hypot(n[0], n[1]); rv = sum(a * b for a, b in zip(r, v))
    e = [(vx * vx / MU - 1 / rx) * r[i] - rv / MU * v[i] for i in range(3)]; em = math.sqrt(sum(x * x for x in e))
    a = 1 / (2 / rx - vx * vx / MU)
    u = math.degrees(math.acos(max(-1, min(1, sum(p * q for p, q in zip(n, r)) / (nm * rx)))))
    if r[2] < 0: u = 360 - u
    return dict(inclination_deg=math.degrees(math.acos(h[2] / hm)), raan_deg=math.degrees(math.atan2(n[1], n[0])) % 360,
                argument_of_latitude_deg=u, periapsis_altitude_km=a * (1 - em) - RE, apoapsis_altitude_km=a * (1 + em) - RE)

def main(tel_dir, archive, iss_json):
    z = zipfile.ZipFile(archive)
    for key, m in MISSIONS.items():
        raw = json.load(open(f"{tel_dir}/{m['dir']}-stage2.json"))
        keep = [i for i, t in enumerate(raw['time']) if t <= m['cut'] + 20][::3]
        rows = [r for r in csv.DictReader(io.TextIOWrapper(z.open(f"Archives2/sat{m['norad']:09d}.csv")))
                if r['OBJECT_ID'] == m['intldes']]
        rows.sort(key=lambda r: r['EPOCH']); first = rows[0]; s = satrec(first)
        t0 = datetime.fromisoformat(m['t0'].replace('Z', '')).replace(tzinfo=timezone.utc)
        truth = []
        for k in range(int(m['cut']) - 30, int(m['cut']) + 31):
            r, v = teme(s, t0 + timedelta(seconds=k))
            truth.append(dict(time_from_launch_s=k, **{a: round(b, 6) for a, b in elements(r, v).items()}))
        json.dump(dict(mission=m['name'], liftoff=m['t0'], pad=dict(latitude_deg=m['pad'][0], longitude_deg=m['pad'][1]),
                       pass_direction=m['inclination_pass'], cutoff_s=m['cut'],
                       telemetry=dict(source='https://github.com/shahar603/Telemetry-Data', license='The Unlicense',
                                      file=f"{m['dir'].replace('_', ' ')}/JSON/stage2 raw.json", note='every third 30 fps sample, to cutoff + 20 s',
                                      speed_reference='EARTH_RELATIVE',
                                      time_s=[raw['time'][i] for i in keep], altitude_km=[raw['altitude'][i] for i in keep],
                                      velocity_m_s=[raw['velocity'][i] for i in keep]),
                       catalog=dict(norad=m['norad'], object_id=m['intldes'], element_set_epoch=first['EPOCH'],
                                    truth='python-sgp4 2.24 osculating TEME elements of the first catalog element set', elements=truth)),
                  open(f'{key}.json', 'w'), separators=(',', ':'))
    iss = json.load(open(iss_json))
    json.dump(iss, open('iss-teme-crew13.json', 'w'), separators=(',', ':'))

if __name__ == '__main__':
    main(*sys.argv[1:4])
