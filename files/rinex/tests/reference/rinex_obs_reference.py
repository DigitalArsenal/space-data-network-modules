"""An independent reading of the committed RINEX observation excerpt, for read_observations to be held to.

georinex 1.16.2 (an open-source RINEX reader, not this module) loads the file; every observation it finds is
written as one line:

    epoch  satellite  code  value  lli  ssi

with the epoch as the file spells it and the value as the shortest repr of the double georinex read. Absent
observations (NaN) are not lines. The indicators are read from the file's own columns (the 15th and 16th
character of each 16-character field), not from georinex: georinex 1.16.2 reports LLI 0 for phase observations
the file marks (E19 L5Q at 00:07:30 is "1" in the file), so it is the authority for what is observed and what
its value is, and the columns are the authority for the indicators. A blank indicator is 0 (RINEX: LLI 0 and
SSI 0 both mean "not stated").

    python3 -I rinex_obs_reference.py <file.rnx> > <file>.reference.tsv    (georinex's venv)
"""
import math, re, sys
import georinex as gr

path = sys.argv[1]
obs = gr.load(path, useindicators=False)
text = open(path, encoding="ascii").read().splitlines()
# the epochs as written: '> 2025 01 19 00 00 30.0000000  0 49'
stamps = []
for line in text:
    if line.startswith(">"):
        y, mo, d, h, mi = line[2:6], line[7:9], line[10:12], line[13:15], line[16:18]
        stamps.append("%s-%s-%sT%s:%s:%s" % (y, mo, d, h, mi, line[19:30].strip()))
assert len(stamps) == len(obs.time)

# The indicator columns, from the file itself: {(epoch index, satellite): {code: (lli, ssi)}}.
header_types, columns = {}, {}
epoch_index, in_header, last_system = -1, True, None
for line in text:
    if in_header:
        label = line[60:80].strip()
        if label == "SYS / # / OBS TYPES":
            if line[0] != " ":
                last_system = line[0]
                header_types[last_system] = []
            header_types[last_system] += line[7:60].split()
        if label == "END OF HEADER":
            in_header = False
        continue
    if line.startswith(">"):
        epoch_index += 1
        continue
    sv = line[0] + line[1:3].replace(" ", "0")
    for k, code in enumerate(header_types[line[0]]):
        field = line[3 + 16 * k: 3 + 16 * k + 16].ljust(16)
        columns.setdefault((epoch_index, sv), {})[code] = (int(field[14]) if field[14] != " " else 0,
                                                            int(field[15]) if field[15] != " " else 0)

def indicator(name, ti, vi):
    """name is code + 'lli' or code + 'ssi'; the value comes from the file's columns."""
    code, kind = name[:3], name[3:]
    lli, ssi = columns[(ti, str(obs.sv.values[vi]))][code]
    return lli if kind == "lli" else ssi

codes = sorted({v for v in obs.data_vars if not v.endswith("lli") and not v.endswith("ssi")})
print("# georinex %s; rows: epoch satellite code value lli ssi; version %s time system %s interval %s" %
      (gr.__version__, obs.attrs["version"], obs.attrs["time_system"], obs.attrs["interval"]))
rows = 0
for ti in range(len(obs.time)):
    for vi, sv in enumerate(obs.sv.values):
        for code in codes:
            value = float(obs[code].values[ti, vi])
            if math.isnan(value):
                continue
            print("\t".join([stamps[ti], str(sv), code, repr(value), str(indicator(code + "lli", ti, vi)), str(indicator(code + "ssi", ti, vi))]))
            rows += 1
print("# %d observations" % rows)
