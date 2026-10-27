"""Extract published Lebedev/Laikov coefficients; no runtime source is copied.

Run with Python 3 from any directory. The upstream MATLAB source is hash-pinned.
The generated C++ data contains only numerical symmetry-orbit coefficients.
"""
from hashlib import sha256
from pathlib import Path
import re
from urllib.request import urlopen

URL = ('https://raw.githubusercontent.com/nasa/CARA_Analysis_Tools/'
       'ce0f00722c56808755ee0adbe47a4e3d56439484/'
       'DistributedMatlab/ProbabilityOfCollision/Utils/getLebedevSphere.m')
HASH = '56c39635f8e6d7f6ddb121710b77a174d21314e9fb2c1ebc00e8794e270be221'
source = urlopen(URL).read()
assert sha256(source).hexdigest() == HASH, 'Upstream coefficient source changed'
text = source.decode()
counts = {1: 6, 2: 12, 3: 8, 4: 24, 5: 24, 6: 48}
output = ['// Generated mathematical coefficients; see NOTICE.md and generate.py.',
          'struct LebedevOrbit {unsigned code;double a,b,weight;};']
for size in (590, 974, 2030, 3890, 5810):
    block = re.search(r'case\s+'+str(size)+r'\s*\n(.*?)(?=\n\s*(?:case|otherwise)\b)', text, re.S).group(1)
    values = dict(a='0', b='0', v='0')
    number = 0
    output.append(f'static constexpr LebedevOrbit lebedev_{size}[] = {{')
    for line in block.splitlines():
        assignment = re.fullmatch(r'\s*([abv])\s*=\s*([0-9.Ee+\-]+);\s*', line)
        if assignment:
            values[assignment[1]] = assignment[2]
        recurrence = re.search(r'getLebedevReccurencePoints\((\d),', line)
        if recurrence:
            code = int(recurrence[1])
            number += counts[code]
            a = values['a'] if code in (4, 5, 6) else '0'
            b = values['b'] if code == 6 else '0'
            output.append('    {'+f"{code},{a},{b},{values['v']}"+'},')
    assert number == size, (size, number)
    output.append('};')
target = Path(__file__).with_name('coefficients.inc')
target.write_text('\n'.join(output)+'\n')
print(f'Generated {target.name}: {len(output)} lines from SHA256 {HASH}')
