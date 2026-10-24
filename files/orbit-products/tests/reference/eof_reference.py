"""Independent reading of the committed Sentinel EOF excerpts, for the module to be held to.

Parses with xml.etree.ElementTree (not the module's reader), converts meters to kilometers with one
division, and writes one TSV per file: epoch, x y z (km), vx vy vz (km/s) as shortest-repr doubles.
Also prints the overlap statistics of the two solutions.
usage: eof_reference.py <fixtures dir>   (writes <name>.reference.tsv for each committed excerpt)
"""
import math, os, sys, xml.etree.ElementTree as ET
d = sys.argv[1]
names = ["S1A_AUX_POEORB_V20240108_overlap", "S1A_AUX_POEORB_V20240109_overlap", "S1A_AUX_RESORB_V20240109_excerpt"]
tables = {}
for n in names:
    root = ET.parse(os.path.join(d, n + ".EOF")).getroot()
    ref = root.find("Earth_Explorer_Header/Variable_Header/Time_Reference").text
    assert ref == "UTC"
    rows = []
    for osv in root.find("Data_Block/List_of_OSVs"):
        epoch = osv.find("UTC").text.split("=", 1)[1]
        v = [float(osv.find(k).text) / 1000.0 for k in ("X", "Y", "Z", "VX", "VY", "VZ")]
        rows.append((epoch, v))
    tables[n] = rows
    with open(os.path.join(d, n + ".reference.tsv"), "w") as f:
        f.write("# independent parse of %s.EOF (xml.etree, float(text)/1000.0); epoch x y z vx vy vz, km and km/s\n" % n)
        for epoch, v in rows:
            f.write("\t".join([epoch] + [repr(x) for x in v]) + "\n")
    print(n, len(rows), rows[0][0], rows[-1][0])
a, b = (dict(tables[n]) for n in names[:2])
common = sorted(set(a) & set(b))
dr = [math.dist(a[e][:3], b[e][:3]) * 1000.0 for e in common]
dv = [math.dist(a[e][3:], b[e][3:]) * 1000.0 for e in common]
print("common epochs", len(common), "pos diff m: max %.4f rms %.4f; vel diff mm/s: max %.4f" % (max(dr), math.sqrt(sum(x * x for x in dr) / len(dr)), max(dv) * 1000))
