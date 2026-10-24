"""An independent evaluation of the committed RINEX navigation excerpt, for evaluate_navigation to be held to.

Written out again from the standards, not from the module: the 8-line broadcast records are read here with Python's
float() (georinex 1.16.2 was tried first and is not used: on a merged multi-constellation file it misaligns the
Galileo and BeiDou health and accuracy words), the position is IS-GPS-200 table 20-IV with each constellation's own
constants (GPS and QZSS: IS-GPS-200 and IS-QZSS; Galileo: OS SIS ICD; BeiDou: BDS-SIS-ICD, CGCS2000). The absolute Toe
comes from the record's week field (GPS week for G, J and E; BDT week for C), a different route from the module's
(which places Toe within half a week of Toc), so a disagreement shows up. The velocity is the central difference of this
position function over +-0.5 s (error well under 1e-5 m/s), not the module's analytic derivative.

The rules the module documents are applied here by the same words: every 300 s, from the message whose Toe is nearest
within +-7200 s, a message whose health word is not 0 not used, BeiDou GEO (PRN 1-5, 59 and above), GLONASS, SBAS and
IRNSS not evaluated.

    python3 -I nav_reference.py <file.rnx> > <file>.reference.tsv

Columns: satellite, epoch (ISO, the system's own time), x y z (km), vx vy vz (km/s) as shortest-repr doubles.
"""
import math, sys

path = sys.argv[1]

UNIX_OF_WEEK_ZERO = {"G": 315964800, "J": 315964800, "E": 315964800, "C": 1136073600}   # 1980-01-06, 2006-01-01 (unix, system scale)
CONST = {"G": (3.986005e14, 7.2921151467e-5), "J": (3.986005e14, 7.2921151467e-5),
         "E": (3.986004418e14, 7.2921151467e-5), "C": (3.986004418e14, 7.292115e-5)}

def position(p, mu, we, t):
    tk = t - p["toe_abs"]
    A = p["sqrtA"] ** 2
    n = math.sqrt(mu / A ** 3) + p["DeltaN"]
    M = p["M0"] + n * tk
    E = M
    for _ in range(100):
        E_next = M + p["e"] * math.sin(E)
        if abs(E_next - E) < 1e-15:
            E = E_next
            break
        E = E_next
    nu = math.atan2(math.sqrt(1 - p["e"] ** 2) * math.sin(E), math.cos(E) - p["e"])
    phi = nu + p["omega"]
    du = p["Cus"] * math.sin(2 * phi) + p["Cuc"] * math.cos(2 * phi)
    dr = p["Crs"] * math.sin(2 * phi) + p["Crc"] * math.cos(2 * phi)
    di = p["Cis"] * math.sin(2 * phi) + p["Cic"] * math.cos(2 * phi)
    u = phi + du
    r = A * (1 - p["e"] * math.cos(E)) + dr
    i = p["Io"] + di + p["IDOT"] * tk
    xp, yp = r * math.cos(u), r * math.sin(u)
    om = p["Omega0"] + (p["OmegaDot"] - we) * tk - we * p["Toe"]
    return [xp * math.cos(om) - yp * math.cos(i) * math.sin(om),
            xp * math.sin(om) + yp * math.cos(i) * math.cos(om),
            yp * math.sin(i)]

def iso(t):
    import datetime as dt
    d = dt.datetime.fromtimestamp(t, dt.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S") + ".0000000"

lines = open(path, encoding="ascii").read().split("\n")
body = lines[[i for i, l in enumerate(lines) if l[60:80].strip() == "END OF HEADER"][0] + 1:]

def num(text):
    text = text.replace("D", "E").replace("d", "e")
    return float(text) if text.strip() else 0.0

records = {}
i = 0
while i < len(body):
    head = body[i]
    if not head or head[0] not in "GECJRSI":
        i += 1
        continue
    j = i + 1
    while j < len(body) and body[j].startswith(" "):
        j += 1
    system = head[0]
    if system in "GECJ":
        v = [num(line[4 + 19 * k: 4 + 19 * k + 19]) for line in body[i + 1:j] for k in range(4)]
        assert len(v) == 28, (head, len(v))
        week = v[18]
        prn = int(head[1:3])
        if not (system == "C" and (prn <= 5 or prn >= 59)) and v[21] == 0.0:
            toe_abs = UNIX_OF_WEEK_ZERO[system] + week * 604800 + v[8]
            records.setdefault(head[:3], []).append({
                "toe_abs": toe_abs, "Toe": v[8], "sqrtA": v[7], "e": v[5], "M0": v[3], "DeltaN": v[2], "omega": v[14],
                "Omega0": v[10], "OmegaDot": v[15], "Io": v[12], "IDOT": v[16], "Cuc": v[4], "Cus": v[6], "Crc": v[13],
                "Crs": v[1], "Cic": v[9], "Cis": v[11]})
    i = j

print("# satellite epoch x y z vx vy vz (km, km/s); IS-GPS-200 table 20-IV, 300 s grid, nearest Toe within 7200 s")
rows = 0
for s in sorted(records):
    system = s[0]
    mu, we = CONST[system]
    messages = records[s]
    lo = min(m["toe_abs"] for m in messages) - 7200
    hi = max(m["toe_abs"] for m in messages) + 7200
    k = math.ceil(lo / 300)
    while k * 300 <= hi:
        t = k * 300.0
        best = min(messages, key=lambda m: abs(t - m["toe_abs"]))
        if abs(t - best["toe_abs"]) <= 7200:
            x = position(best, mu, we, t)
            xp, xm = position(best, mu, we, t + 0.5), position(best, mu, we, t - 0.5)
            v = [(a - b) / 1.0 for a, b in zip(xp, xm)]
            print("\t".join([s, iso(t)] + [repr(c / 1000.0) for c in x] + [repr(c / 1000.0) for c in v]))
            rows += 1
        k += 1
print("# %d states" % rows)
