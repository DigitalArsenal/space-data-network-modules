// possibility_of_collision's $SCR records: the request (POSSIBILITY_REQUEST)
// and the result (POSSIBILITY_RESULT) as plain objects.
import * as flatbuffers from 'flatbuffers';
import { SCR, SCRPossibilityKernelT, SCRPossibilityPointT, SCRPossibilityRequestT, SCRT, scrPossibilityModel } from '../../src/js/sds/SCR.mjs';

/**
 * mode 0: finite supports, a and b rows [x, y, z, vx, vy, vz, possibility] (SI);
 * mode 1: ellipsoidal kernels, a and b { center[6], shape[36] }.
 */
export function possibilityRequest({ radius, window = 600, mode, a, b, alpha = [] }) {
  const q = new SCRPossibilityRequestT(radius, window, mode === 0 ? scrPossibilityModel.FiniteSupport : scrPossibilityModel.EllipsoidalKernel);
  if (mode === 0) {
    q.A_POINTS = a.map((row) => new SCRPossibilityPointT(...row));
    q.B_POINTS = b.map((row) => new SCRPossibilityPointT(...row));
  } else {
    q.A_KERNEL = new SCRPossibilityKernelT(a.center, a.shape);
    q.B_KERNEL = new SCRPossibilityKernelT(b.center, b.shape);
  }
  q.ALPHA_LEVELS = alpha;
  const root = new SCRT();
  root.POSSIBILITY_REQUEST = q;
  const builder = new flatbuffers.Builder(1024);
  builder.finish(root.pack(builder), '$SCR');
  return builder.asUint8Array().slice();
}

export function possibilityResult(payload) {
  const bb = new flatbuffers.ByteBuffer(payload);
  if (!SCR.bufferHasIdentifier(bb)) throw new Error('result is not a $SCR record');
  const p = SCR.getRootAsSCR(bb).POSSIBILITY_RESULT();
  if (!p) throw new Error('result is not a POSSIBILITY_RESULT');
  const r = { possibility: p.POSSIBILITY_COLLISION(), necessity: p.NECESSITY_COLLISION(), necessityNoCollision: p.NECESSITY_NO_COLLISION(),
    minMiss: p.MIN_MISS_M(), maxMiss: p.MAX_MISS_M(), tcaMin: p.TCA_MIN_S(), tcaMax: p.TCA_MAX_S(),
    pairs: Number(p.PAIRS()), colliding: Number(p.COLLIDING_PAIRS()), alpha: [] };
  for (let k = 0; k < p.alphaCutsLength(); ++k) {
    const c = p.ALPHA_CUTS(k);
    r.alpha.push({ alpha: c.ALPHA(), minMiss: c.MIN_MISS_M(), maxMiss: c.MAX_MISS_M(), tcaMin: c.TCA_MIN_S(), tcaMax: c.TCA_MAX_S() });
  }
  return r;
}
