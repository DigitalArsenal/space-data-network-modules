// PRW encoding and resident identity remain the standard module's contract.
export * from '../hpop/catalog.mjs';
import { fullForceRequest as standardFullForceRequest } from '../hpop/catalog.mjs';

export const FAST_CATALOG_INTEGRATOR = Object.freeze({
  tolerance: 1e-14,
  initialStep: 30,
  minStep: 0.01,
  maxStep: 120,
  maxSteps: 1000000,
});

export function fullForceRequest({ integrator = FAST_CATALOG_INTEGRATOR, ...options }) {
  return standardFullForceRequest({ ...options, integrator });
}
