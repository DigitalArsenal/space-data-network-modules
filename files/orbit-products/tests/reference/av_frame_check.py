# Run with the interpreter that has spiceypy: python3 -I av_frame_check.py
# Which frame is a CK's angular velocity expressed in? SPICE's own convention, via rav2xf/xf2rav, against the analytic
# derivative of C(t) = M * Rz_frame(w t) (a fixed instrument misalignment M on a frame spinning about the reference z).
import math, spiceypy as sp, numpy as np
w = 0.01
M = np.array(sp.eul2m(0.3, -0.7, 1.1, 1, 2, 3))      # an arbitrary fixed rotation
def Rz_f(a): return np.array([[math.cos(a), math.sin(a), 0], [-math.sin(a), math.cos(a), 0], [0, 0, 1]])
t0 = 37.0
C = M @ Rz_f(w * t0)
dC = M @ (w * np.array([[-math.sin(w*t0), math.cos(w*t0), 0], [-math.cos(w*t0), -math.sin(w*t0), 0], [0, 0, 0]]))
w_ref = np.array([0, 0, w])          # angular velocity of the instrument frame relative to the reference frame, in the reference frame
w_inst = C @ w_ref                    # the same vector expressed in the instrument frame
for name, av in (("reference frame", w_ref), ("instrument frame", w_inst)):
    xf = np.array(sp.rav2xf(C.tolist(), av.tolist()))
    err = np.max(np.abs(xf[3:, :3] - dC))
    print("rav2xf with av expressed in the %-16s -> dC/dt error %.3e" % (name, err))
rot, av_back = sp.xf2rav(np.block([[C, np.zeros((3,3))], [dC, C]]).tolist())
print("xf2rav of the true state transformation returns av", np.round(av_back, 12), "; w_ref", w_ref, "; w_inst", np.round(w_inst, 12))
