"""Independent pyerfa reference for check-classical-frames.mjs.

Only reference evaluation happens here. Epoch generation and every comparison,
maximum, angular reduction and physical error bound are in the C++ harness.
UTC input is split exactly at midnight; future leap seconds are held at ERFA's
last published offset. UT1=UTC, no polar motion, no frame bias, FK5 TEME.
"""
import json
import sys
import warnings
import erfa
import numpy as np

warnings.simplefilter("ignore", erfa.ErfaWarning)
epochs = np.loadtxt(sys.argv[1])
u1 = np.floor(epochs - 0.5) + 0.5
u2 = epochs - u1
a1, a2 = erfa.utctai(u1, u2)
t1, t2 = erfa.taitt(a1, a2)

def matrices(tt1, tt2, ut11, ut12):
    p = erfa.pmat76(tt1, tt2)
    n = erfa.nutm80(tt1, tt2)
    pn = erfa.pnm80(tt1, tt2)
    eqeq = erfa.eqeq94(tt1, tt2)
    # Evaluate GMST explicitly too: its polynomial derivative defines velocity.
    erfa.gmst82(ut11, ut12)
    sidereal = erfa.gst94(ut11, ut12)
    ident = np.broadcast_to(np.eye(3), p.shape).copy()
    teme = erfa.rz(eqeq, ident.copy()) @ pn
    pef = erfa.rz(sidereal, ident.copy()) @ n @ p
    fixed = erfa.pom00(np.zeros_like(eqeq), np.zeros_like(eqeq), np.zeros_like(eqeq)) @ pef
    return np.stack([teme, ident, fixed, ident, fixed, pef, pn, p], axis=1)

bases = matrices(t1, t2, u1, u2)
minus = matrices(t1, t2 - 1.0 / 86400, u1, u2 - 1.0 / 86400)
plus = matrices(t1, t2 + 1.0 / 86400, u1, u2 + 1.0 / 86400)
centuries = ((u1 - 2451545.0) + u2) / 36525.0
spin = (1 + (8640184.812866 + (2 * 0.093104 - 3 * 6.2e-6 * centuries) * centuries)
        / (36525.0 * 86400.0)) * (2 * np.pi / 86400.0)
np.column_stack([epochs, t1, t2, u1, u2, spin,
                 bases.reshape(-1, 72), minus.reshape(-1, 72), plus.reshape(-1, 72)]) \
    .astype('<f8').tofile(sys.argv[2])
with open(sys.argv[3], 'w') as out:
    json.dump({'pyerfa': erfa.__version__, 'erfa': erfa.version.erfa_version,
               'sofa': erfa.version.sofa_version, 'numpy': np.__version__}, out)
