// The tests' recipes as the module takes them: one size-prefixed $XMT per recipe port (dist/sds/xmt.mjs is the
// standard's binding, built from its TypeScript by build.mjs). The compose and match recipes go through the editor's
// own encoder (app/xmt.js); the integrate recipe and the epoch-fit policy are written here from the same fields.
import * as x from '../dist/sds/xmt.mjs';
import { XMT_TYPE, composeRecipe, decodeXmt, encodeXmt, matchRequest } from '../app/xmt.js';

export { x, XMT_TYPE, composeRecipe, decodeXmt, matchRequest };
const table = (Type, fields) => Object.assign(new Type(), fields);
export const recipeFrame = (payload) => ({ portId: 'recipe', typeRef: XMT_TYPE, payload });

const STATUS = (name) => (typeof name === 'number' ? name : x.maneuverStatus[name]);
// asOf in Unix seconds; selection, maneuvers and identity as the integrate tests write them.
export function integrateRecipe({ asOf, selection, maneuvers, identity } = {}) {
  const s = selection && table(x.XMTSelectionPolicyT, {
    ...(selection.horizonDays != null ? { HORIZON_DAYS: selection.horizonDays } : {}),
    ...(selection.minSamples != null ? { MIN_SAMPLES: selection.minSamples } : {}),
    ...(selection.maxAgeDays != null ? { MAX_AGE_DAYS: selection.maxAgeDays } : {}),
    SOURCE_ORDER: selection.sourceOrder ?? [],
    MEASURED: (selection.table ?? []).map((r) => table(x.XMTMeasuredErrorT, { SOURCE_ID: r.source, PRODUCT: r.product, REGIME: r.regime, HORIZON_DAYS: r.horizonDays, MEDIAN_3D_KM: r.median3dKm, SAMPLES: r.samples })),
  });
  const m = maneuvers && table(x.XMTManeuverPolicyT, {
    ...(maneuvers.timeToleranceSeconds != null ? { TIME_TOLERANCE_S: maneuvers.timeToleranceSeconds } : {}),
    ...(maneuvers.deltaVToleranceKmS != null ? { DELTA_V_TOLERANCE_KM_S: maneuvers.deltaVToleranceKmS } : {}),
    ...(maneuvers.deltaVRelativeTolerance != null ? { DELTA_V_RELATIVE_TOLERANCE: maneuvers.deltaVRelativeTolerance } : {}),
    MANEUVERABLE_STATUSES: (maneuvers.maneuverableStatuses ?? []).map(STATUS),
    RETIRING_STATUSES: (maneuvers.retiringStatuses ?? []).map(STATUS),
  });
  const i = identity && table(x.XMTMatchRequestT, {
    POLICY: table(x.XMTMatchPolicyT, { POSITION_TOLERANCE_KM: identity.positionToleranceKm, VELOCITY_TOLERANCE_KM_S: identity.velocityToleranceKmS,
      FINITE_DIFFERENCE_TOLERANCE_KM_S: identity.finiteDifferenceToleranceKmS, MINIMUM_SPAN_S: identity.minimumSpanSeconds }),
    TRAJECTORIES: identity.candidates.map((c) => table(x.XMTTrajectoryT, { ID: c.id, PROVIDER: c.provider, NATIVE_ID: c.nativeId, RECORD_ID: c.recordId })),
    PAIRS: identity.pairs.map((p) => table(x.OILLinkT, {
      LEFT: table(x.OILIdentifierT, { TRAJECTORY_ID: p.native }),
      RIGHT: table(x.OILIdentifierT, { TRAJECTORY_ID: p.reference, NORAD_CAT_ID: p.object?.norad ?? 0, INTERNATIONAL_DESIGNATOR: p.object?.cospar ?? null }),
      STATUS: x.oilLinkStatus.Proposed,
      EVIDENCE: table(x.OILEvidenceT, { SOURCE: p.evidence?.source ?? null, RECORD_ID: p.evidence?.recordId ?? null }),
    })),
  });
  const recipe = table(x.XMTIntegrateRecipeT, { AS_OF_MS: BigInt(Math.round((asOf ?? 0) * 1000)), SELECTION: s ?? null, MANEUVERS: m ?? null, IDENTITY: i ?? null });
  return encodeXmt({ INTEGRATE_RECIPE: recipe });
}

// The epoch-fit policy. `forceModel` names the forces as the propagator runners do ({centralBody, j2, j3, j4, thirdBody,
// srp, drag, ephemerisSource, integrator, limitation}) and becomes a $PRW force configuration; null leaves it out.
export function epochPolicy(p) {
  const f = p.forceModel, i = f?.integrator;
  return encodeXmt({ EPOCH_FIT_POLICY: table(x.XMTEpochFitPolicyT, {
    PROPAGATOR_ID: p.propagatorId, PROPAGATOR_ARTIFACT_SHA256: p.propagatorArtifactSha256,
    FORCE_MODEL: f == null ? null : table(x.PRWForceConfigurationT, {
      ENABLE_POINT_MASS: !!f.centralBody, ENABLE_J2: !!f.j2, ENABLE_J3: !!f.j3, ENABLE_J4: !!f.j4, ENABLE_THIRD_BODY: !!f.thirdBody, ENABLE_SRP: !!f.srp, ENABLE_DRAG: !!f.drag,
      EPHEMERIS_SOURCE: f.ephemerisSource ?? 'none' }),
    INTEGRATOR: i ? table(x.PRWIntegratorSettingsT, { INITIAL_STEP_SECONDS: i.initialStep, MINIMUM_STEP_SECONDS: i.minStep, MAXIMUM_STEP_SECONDS: i.maxStep,
      ABSOLUTE_TOLERANCES: Array(6).fill(i.absTolerance), RELATIVE_TOLERANCE: i.relTolerance }) : null,
    FORCE_MODEL_LIMITATION: f?.limitation ?? null,
    FRAME_TRANSFORMATION_REF: p.frameTransformationRef, HOLDOUT_STRIDE: p.holdoutStride, POSITION_TOLERANCE_KM: p.positionToleranceKm,
    ...(p.maximumHoldoutRmsKm != null ? { MAXIMUM_HOLDOUT_RMS_KM: p.maximumHoldoutRmsKm } : {}),
    POSITION_PERTURBATION_KM: p.positionPerturbationKm ?? 0, VELOCITY_PERTURBATION_KM_S: p.velocityPerturbationKmS ?? 0,
    POSITION_WEIGHT_KM: p.positionWeightKm ?? 0, POSITION_REGULARIZATION_KM: p.positionRegularizationKm ?? 0, VELOCITY_REGULARIZATION_KM_S: p.velocityRegularizationKmS ?? 0,
  }) });
}

// The report of a response, unpacked ($XMT object API).
export const reportOf = (response) => {
  const frame = response.outputs.find((f) => f.portId === 'report');
  return frame ? decodeXmt(frame.payload) : null;
};
