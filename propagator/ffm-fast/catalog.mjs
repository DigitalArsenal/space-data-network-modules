// PRW encoding and resident identity remain the standard module's contract.
export * from '../ffm/catalog.mjs';
import { fullForceRequest as standardFullForceRequest, residentState as standardResidentState } from '../ffm/catalog.mjs';

export const FAST_CATALOG_INTEGRATOR = Object.freeze({
  tolerance: 1e-14,
  initialStep: 30,
  minStep: 0.01,
  maxStep: 120,
  maxSteps: 1000000,
});

// Describes the internal C++ resident policy; this is not a selectable mode.
export const INTEGRATION_POLICY = 'RK78 1e-14 / 120 s; forward elliptic e >= 0.25: RK78 Sundman alpha=1.5, 200/orbit (GTO perigee<1000 km, 30000<apogee<45000 km: 300/orbit); fixed diagnostics and backward requests: RK78';

// Generic clients select the same one-mode policy as fullForceRequest.
export const CATALOG_INTEGRATOR = FAST_CATALOG_INTEGRATOR;

export function fullForceRequest({ integrator = FAST_CATALOG_INTEGRATOR, ...options }) {
  return standardFullForceRequest({ ...options, integrator });
}

// Resident identity is the implementation's; every other PRW field is shared.
export const MODULE_ID = 'com.orbpro.ffm-fast';
export function residentState(options) {
  const result = standardResidentState(options);
  result.INSTANCE.MODULE_ID = MODULE_ID;
  return result;
}
