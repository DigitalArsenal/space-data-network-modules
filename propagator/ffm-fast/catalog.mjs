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
export const INTEGRATION_POLICY = 'Forward GJ8 PEC on common TT grids: LEO 10/15/12/24 s by perigee band; near-circular GPS 75 s and GEO 600 s; other low-eccentricity elliptic orbits 24 s. Eccentricity >=0.25: RK78 Sundman alpha=1.5, 200/orbit (GTO-like: 300/orbit). Tight RK alignment <=one GJ step; corrected conical dense acceleration; daily-Ap restart trim; selected-object batches of 32. Fixed diagnostics, backward requests, nonelliptic states, unsupported GJ force families, or insufficient startup coverage retain RK78.';

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
