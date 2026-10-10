// evaluate_teag requests for the tri-runtime parity plan: the scalar
// closed-form case of ESPF-HJ section 4, a medoid, events and alpha-cuts
// with the Choquet basin, a 6-D MVEE of the numpy reference, Smolyak and
// Minkowski bounds, and the truncated entropy. Framing only.
import fs from 'node:fs';
import { encode, typeRef } from './wire.mjs';

const request = (teag_request) => ({ methodId: 'evaluate_teag', inputs: [{ portId: 'request', typeRef, payload: encode({ teag_request }) }] });

export function teagCases() {
  const h = Array.from({ length: 49 }, (_, i) => -6 + 0.25 * i);
  const prior = h.map((x) => x * x / 2), psi = h.map((x) => (x - 3) ** 2 / 8);
  const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/mvee-numpy-reference.json', import.meta.url), 'utf8')).cases;
  const cloud = cases.find((c) => c.dimension === 6 && c.kind === 'gauss' && c.points.length === 6 * 85);
  const small = cases.find((c) => c.dimension === 3 && c.kind === 'gauss');
  const q = Array.from({ length: small.points.length / 3 }, (_, i) => ((i * 17) % 30) / 10);
  return [
    { id: 'teag-scalar-front', request: request({ dimension: 1, points: h, prior_impossibility: prior, surprisal: psi }) },
    { id: 'teag-scalar-medoid', request: request({ dimension: 1, points: h, subset: h.map((_, i) => i).filter((i) => h[i] >= -3 && h[i] <= 1), metric_shape: [1] }) },
    { id: 'teag-events-basin', request: request({ dimension: 1, points: h, prior_impossibility: prior, whitened_squared_innovation: psi.map((v) => 2 * v),
      alpha_levels: [0.9, 0.5, 0.1], events: [...h.map((x) => (x < 0 ? 1 : 0)), ...h.map((x) => (x >= 0 ? 1 : 0))], event_count: 2, effective_dimension: 6 }) },
    { id: 'teag-mvee-medoid-6d', request: request({ dimension: 6, points: cloud.points, mvee: true, mvee_tolerance: 1e-12 }) },
    { id: 'teag-entropy-3d', request: request({ dimension: 3, points: small.points, mvee: true, whitened_squared_innovation: q, entropy: true }) },
    { id: 'teag-smolyak-minkowski', request: request({ smolyak_dimension: 6, smolyak_level: 3, shape_a: [4, 1, 0, 1, 2, 0.3, 0, 0.3, 1], shape_b: [0.5, 0, 0.1, 0, 3, 0, 0.1, 0, 0.25] }) },
  ];
}
