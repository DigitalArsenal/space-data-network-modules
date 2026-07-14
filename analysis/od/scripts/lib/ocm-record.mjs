// OCM emission helpers (owner directive 2026-07-14): for every OD-fitted object
// build an SDS $OCM (Orbit Comprehensive Message, schema
// ../spacedatastandards.org/schema/OCM/main.fbs) that carries the fitted
// mean-element state, the orbit-determination metadata, and a PERTURBATIONS
// block whose FIELD SELECTION follows the US Space Force Vector Covariance
// Message (VCM) taxonomy.
//
// IMPORTANT provenance rule (owner, 2026-07-14, stated repeatedly):
//   * The VCM is used ONLY as a REFERENCE SPECIFICATION for *which* propagation-
//     context fields an OCM should carry (atmospheric density model, solar flux /
//     geomagnetic inputs, drag / ballistic coefficient, geopotential model +
//     degree/order, third-body, SRP model + coefficient).
//   * NO SDS VCM schema is imported, NO VCM record is ever read or produced, and
//     NO value here is VCM-derived. Every value is our own SGP4 fit-theory
//     context; fields the SGP4 theory does not define are emitted as honest
//     "N/A" dashes (or omitted), never fabricated.
//
// This module is pure + dependency-injected (the SDS FlatBuffer bindings are
// passed in), so it is unit-testable without the daemon or the wasm fitter.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

// ── SGP4 fit-theory constants (must match src/cpp/src/sgp4_fitter.cpp) ────────
export const OCM_VERS = "3.0"; // CCSDS 502.0-B-3
export const SGP4_FIT_WINDOW_SEC = 11520; // module default: 2 orbital periods (~192 min = 3.2 h)
export const SGP4_GM_KM3_S2 = 398600.8; // WGS-72, matches Vallado SGP4 (MU_EARTH)
export const SGP4_RE_KM = 6378.135; // WGS-72 Earth radius, matches Vallado SGP4
export const VCM_REFERENCE_SPEC =
  "US Space Force Vector Covariance Message (VCM), CCSDS 502.0-B-3 — field-selection reference ONLY, not VCM-derived";
const NA = "N/A (not modeled by SGP4 theory)";

const toNum = (v) => {
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// ── the fit-context → propagator-settings mapper (unit-tested) ───────────────
// Returns the propagation context an OCM should carry, using the VCM's
// documented atmosphere+perturbation vocabulary as the field selector, filled
// HONESTLY from the SGP4 fit theory. `null` == the theory does not define it.
export function sgp4PerturbationContext(fit = {}) {
  const bstar = toNum(fit.BSTAR);
  return {
    referenceSpec: VCM_REFERENCE_SPEC,
    theory: "SGP4 (Vallado) — analytic near-Earth mean-element theory",
    propagator: "SGP4",
    fitWindowSec: SGP4_FIT_WINDOW_SEC,

    // geopotential (VCM: geopotential model + degree/order) — SGP4 defines these
    gravityModel: "WGS-72",
    geopotentialModel: "WGS-72 zonal (J2, J3, J4)",
    gravityDegree: 4, // SGP4 carries zonal harmonics through J4
    gravityOrder: 0, // zonal-only: no tesseral terms
    gm: SGP4_GM_KM3_S2,
    zonalHarmonics: ["J2", "J3", "J4"],

    // atmospheric drag (VCM: atmospheric density model + ballistic/drag coeff)
    atmosphericDensityModel: null, // SGP4 uses NO CIRA/Jacchia/MSIS density table
    atmosphericDrag: "SGP4 analytic B* power-law drag (no density-table model)",
    ballisticCoeffBstar: bstar, // the only drag parameter SGP4 fits (1/earth-radii)
    dragCoeffCd: null, // SGP4 does not separate a drag coefficient
    dragArea: null, // SGP4 does not separate a drag area

    // solar flux / geomagnetic (VCM: F10.7 daily/avg, Ap/Kp) — unused by SGP4
    solarFluxF10p7: null, // drag is a fixed B*, not flux-driven
    solarFluxF10p7Mean: null,
    geomagKp: null,
    geomagAp: null,

    // third-body (VCM: sun/moon) — SGP4 near-Earth theory has none
    thirdBody: [], // SDP4 deep-space lunar/solar terms are not used

    // SRP (VCM: SRP model + coefficient) — SGP4 does not model SRP
    srpModel: null,
    srpCoeff: null,
    srpArea: null,

    // remaining force models the VCM enumerates — none apply to SGP4
    oceanTides: null,
    solidTides: null,
    atmosphericTides: null,
    albedo: null,
    thermal: null,
    relativity: null,
  };
}

// Render the full VCM-taxonomy field set as machine-readable name/value pairs so
// EVERY field the VCM enumerates is visibly present on the OCM (honest "N/A"
// where SGP4 leaves it undefined). Complements the native Perturbations table
// (which has no numeric slot for flux/Kp/coefficients).
export function perturbationTaxonomyPairs(ctx) {
  const dash = (v, unit) =>
    v === null || v === undefined ? NA : unit ? `${v} ${unit}` : String(v);
  return [
    ["PERT_FIELD_SELECTION_REFERENCE", ctx.referenceSpec],
    ["PERT_THEORY", ctx.theory],
    ["PERT_PROPAGATOR", ctx.propagator],
    ["PERT_GEOPOTENTIAL_MODEL", ctx.gravityModel],
    ["PERT_GEOPOTENTIAL_DEGREE", String(ctx.gravityDegree)],
    ["PERT_GEOPOTENTIAL_ORDER", String(ctx.gravityOrder)],
    ["PERT_ZONAL_HARMONICS", ctx.zonalHarmonics.join(",")],
    ["PERT_GM_KM3_S2", String(ctx.gm)],
    ["PERT_ATMOSPHERIC_DENSITY_MODEL", ctx.atmosphericDensityModel ?? NA],
    ["PERT_ATMOSPHERIC_DRAG", ctx.atmosphericDrag],
    ["PERT_BALLISTIC_COEFF_BSTAR", dash(ctx.ballisticCoeffBstar, "[1/earth-radii]")],
    ["PERT_DRAG_COEFF_CD", dash(ctx.dragCoeffCd)],
    ["PERT_SOLAR_FLUX_F10P7", dash(ctx.solarFluxF10p7)],
    ["PERT_SOLAR_FLUX_F10P7_MEAN", dash(ctx.solarFluxF10p7Mean)],
    ["PERT_GEOMAG_KP", dash(ctx.geomagKp)],
    ["PERT_GEOMAG_AP", dash(ctx.geomagAp)],
    ["PERT_THIRD_BODY", ctx.thirdBody.length ? ctx.thirdBody.join(",") : "NONE (SGP4 near-Earth)"],
    ["PERT_SRP_MODEL", ctx.srpModel ?? NA],
    ["PERT_SRP_COEFF", dash(ctx.srpCoeff)],
    ["PERT_SRP_AREA", dash(ctx.srpArea)],
    ["PERT_OCEAN_TIDES", ctx.oceanTides ?? NA],
    ["PERT_SOLID_TIDES", ctx.solidTides ?? NA],
    ["PERT_ATMOSPHERIC_TIDES", ctx.atmosphericTides ?? NA],
    ["PERT_ALBEDO", ctx.albedo ?? NA],
    ["PERT_THERMAL", ctx.thermal ?? NA],
    ["PERT_RELATIVITY", ctx.relativity ?? NA],
  ];
}

// ── SDS OCM FlatBuffer bindings loader (createRequire-anchored) ──────────────
// Resolves flatbuffers + the generated OCM JS bindings from a list of require
// anchors (package.json paths). Mirrors the anchoring the pipeline already uses
// for OMM so the same node_modules copy is used.
export async function loadOcmBindings(anchors) {
  let ocmPath;
  let fbPath;
  for (const a of anchors) {
    try {
      const r = createRequire(a);
      fbPath = r.resolve("flatbuffers");
      ocmPath = r.resolve("spacedatastandards.org/lib/js/OCM/OCM.js");
      break;
    } catch {
      /* next anchor */
    }
  }
  if (!ocmPath || !fbPath) {
    throw new Error("cannot resolve flatbuffers + spacedatastandards.org OCM bindings");
  }
  const dir = path.dirname(ocmPath);
  const imp = (name) => import(pathToFileURL(path.join(dir, name)));
  const flatbuffers = await import(pathToFileURL(fbPath));
  const [ocmMod, headerMod, metaMod, pertMod, odMod, udpMod, trajMod] = await Promise.all([
    imp("OCM.js"),
    imp("Header.js"),
    imp("Metadata.js"),
    imp("Perturbations.js"),
    imp("OrbitDetermination.js"),
    imp("UserDefinedParameters.js"),
    imp("trajectoryType.js"),
  ]);
  return {
    flatbuffers,
    OCM: ocmMod.OCM,
    OCMT: ocmMod.OCMT,
    HeaderT: headerMod.HeaderT,
    MetadataT: metaMod.MetadataT,
    PerturbationsT: pertMod.PerturbationsT,
    OrbitDeterminationT: odMod.OrbitDeterminationT,
    UserDefinedParametersT: udpMod.UserDefinedParametersT,
    trajectoryType: trajMod.trajectoryType,
  };
}

// ── OCM record builder ───────────────────────────────────────────────────────
// Builds a size-prefixed $OCM FlatBuffer for one fitted object. `fit` is the OD
// module's JSON (elements_to_json: EPOCH, MEAN_MOTION, ... , RMS, ITERATIONS,
// CONVERGED, DATA_SOURCE). `meta` is provider identity {norad, objectName,
// objectId, source}. Identity (NORAD/name/COSPAR) comes from the provider, never
// fabricated; the mean-element state mirrors the companion $OMM.
export function buildOcmFrame({ fit, meta, batchId, creationDate, sourceUrl, bindings }) {
  const {
    flatbuffers,
    OCM,
    OCMT,
    HeaderT,
    MetadataT,
    PerturbationsT,
    OrbitDeterminationT,
    UserDefinedParametersT,
  } = bindings;

  const norad = meta.norad >>> 0;
  const rms = toNum(fit.RMS);
  const refRms = toNum(fit.REFERENCE_RMS);
  const dataSource = fit.DATA_SOURCE ?? meta.source ?? "";
  const epoch = fit.EPOCH ?? "";
  const ctx = sgp4PerturbationContext(fit);

  const udp = (name, value) =>
    value === null || value === undefined || value === ""
      ? null
      : Object.assign(new UserDefinedParametersT(), { PARAM_NAME: name, PARAM_VALUE: String(value) });

  // ── HEADER ──
  const header = Object.assign(new HeaderT(), {
    CCSDS_OCM_VERS: OCM_VERS,
    COMMENT: [
      "SDN OD-fitted Orbit Comprehensive Message (App 2) — companion to the fitted supplemental $OMM.",
      `PERTURBATIONS + OD field selection follows the ${VCM_REFERENCE_SPEC}. No VCM record was read or produced; values are our own SGP4 fit-theory context.`,
      `SOURCE_NAME=${meta.source ?? ""} DATA_SOURCE=${dataSource} BATCH_ID=${batchId}`,
      `FIT: SGP4 differential correction (Levenberg-Marquardt, multi-start); window=${SGP4_FIT_WINDOW_SEC}s (2 orbital periods, ~3.2 h); RMS_KM=${rms ?? "NA"}; ITERATIONS=${fit.ITERATIONS ?? ""}; CONVERGED=${fit.CONVERGED ?? ""}.`,
      "vcm-availability: vcm-unavailable (account has no VCM feed; fit-theory defaults applied).",
    ],
    CLASSIFICATION: String(fit.CLASSIFICATION_TYPE ?? "U"),
    CREATION_DATE: creationDate,
    ORIGINATOR: meta.source ?? "",
    MESSAGE_ID: `${String(batchId).slice(0, 16)}-${norad}`,
  });

  // ── METADATA ──
  const metadata = Object.assign(new MetadataT(), {
    COMMENT: ["Object identity from provider ephemeris (NORAD/name/COSPAR); never fabricated."],
    OBJECT_NAME: meta.objectName ?? "",
    INTERNATIONAL_DESIGNATOR: meta.objectId || null,
    OBJECT_DESIGNATOR: norad ? String(norad) : null,
    OBJECT_TYPE: "PAYLOAD",
    TIME_SYSTEM: "UTC",
    EPOCH_TZERO: epoch,
    OCM_DATA_ELEMENTS: ["PERT", "OD", "USER"],
  });

  // ── PERTURBATIONS (VCM-taxonomy field selection; SGP4 honest values) ──
  const perturbations = Object.assign(new PerturbationsT(), {
    COMMENT: [
      `Field selection per ${VCM_REFERENCE_SPEC}.`,
      "SGP4 is an analytic near-Earth mean-element theory: drag via B* power-law (no atmospheric density table), zonal geopotential J2/J3/J4 only, no third-body, no SRP, no tides.",
      "Fields the SGP4 theory does not define are marked N/A (honest-absent), never fabricated. Ballistic coefficient is the fitted B* (see USER_DEFINED_PARAMETERS PERT_BALLISTIC_COEFF_BSTAR); solar-flux F10.7 / geomagnetic Kp/Ap are not used by SGP4.",
    ],
    GRAVITY_MODEL: ctx.gravityModel,
    GRAVITY_DEGREE: ctx.gravityDegree,
    GRAVITY_ORDER: ctx.gravityOrder,
    GM: ctx.gm,
    GEOPOTENTIAL_MODEL: ctx.geopotentialModel,
    ATMOSPHERIC_DRAG: ctx.atmosphericDrag,
    SOLAR_RAD_PRESSURE: NA,
    OCEAN_TIDES_MODEL: NA,
    SOLID_TIDES_MODEL: NA,
    ATMOSPHERIC_TIDES_MODEL: NA,
    ALBEDO: NA,
    THERMAL: NA,
    RELATIVITY: NA,
    // ATMOSPHERIC_MODEL (ATM enum) omitted: no CIRA/Jacchia/MSIS family applies to
    // SGP4 (documented in COMMENT + PERT_ATMOSPHERIC_DENSITY_MODEL=N/A below).
    // N_BODY_PERTURBATIONS left empty: honest zero third-body.
    // FIXED_F10P7 / FIXED_F10P7_MEAN / FIXED_GEOMAG_KP omitted: unused by SGP4.
  });

  // ── ORBIT_DETERMINATION ──
  const residuals =
    refRms !== null ? `RMS_KM=${rms}; REFERENCE_RMS_KM=${refRms}` : `RMS_KM=${rms}`;
  const orbitDetermination = Object.assign(new OrbitDeterminationT(), {
    OD_ID: `${String(batchId).slice(0, 16)}-${norad}`,
    OD_ALGORITHM: "SGP4 differential correction",
    OD_METHOD: "Levenberg-Marquardt least-squares, multi-start (equinoctial elements)",
    OD_EPOCH: epoch,
    OD_TIME_TAG: epoch,
    OD_OBSERVATIONS_TYPE: ["EPHEMERIS_STATE"],
    OD_TRACKS_USED: 1, // one provider ephemeris file = one continuous track
    OD_DATA_WEIGHTING: "UNIFORM",
    OD_CONVERGENCE_CRITERIA: `CONVERGED=${fit.CONVERGED ?? ""}; ITERATIONS=${fit.ITERATIONS ?? ""}/${fit.MAX_ITERATIONS ?? ""}`,
    OD_EST_PARAMETERS: [
      "MEAN_MOTION",
      "ECCENTRICITY",
      "INCLINATION",
      "RA_OF_ASC_NODE",
      "ARG_OF_PERICENTER",
      "MEAN_ANOMALY",
      "BSTAR",
    ],
    OD_RESIDUALS: residuals,
    OD_APRIORI_DATA: `SOURCE_EPHEMERIS=${dataSource}; FIT_WINDOW_SEC=${SGP4_FIT_WINDOW_SEC} (2 orbital periods, ~3.2 h); OD_POINT_COUNT=not-reported-by-fit-method`,
    // OD_OBSERVATIONS_USED omitted: the fit method does not report a point count.
  });

  // ── USER_DEFINED_PARAMETERS: fitted mean-element state (mirrors $OMM) +
  //     full VCM-taxonomy enumeration + provenance lineage ──
  const params = [
    // fitted GP mean-element state (schema-exact GP keys)
    udp("NORAD_CAT_ID", norad),
    udp("EPOCH", epoch),
    udp("MEAN_MOTION", fit.MEAN_MOTION),
    udp("ECCENTRICITY", fit.ECCENTRICITY),
    udp("INCLINATION", fit.INCLINATION),
    udp("RA_OF_ASC_NODE", fit.RA_OF_ASC_NODE),
    udp("ARG_OF_PERICENTER", fit.ARG_OF_PERICENTER),
    udp("MEAN_ANOMALY", fit.MEAN_ANOMALY),
    udp("BSTAR", fit.BSTAR),
    udp("MEAN_MOTION_DOT", fit.MEAN_MOTION_DOT),
    udp("MEAN_MOTION_DDOT", fit.MEAN_MOTION_DDOT),
    udp("EPHEMERIS_TYPE", fit.EPHEMERIS_TYPE),
    udp("ELEMENT_SET_NO", fit.ELEMENT_SET_NO),
    udp("REV_AT_EPOCH", fit.REV_AT_EPOCH),
    udp("CLASSIFICATION_TYPE", fit.CLASSIFICATION_TYPE),
    // full VCM-taxonomy perturbation field set (honest values / N/A dashes)
    ...perturbationTaxonomyPairs(ctx).map(([n, v]) => udp(n, v)),
    // provenance lineage
    udp("SDN_SOURCE_NAME", meta.source),
    udp("SDN_DATA_SOURCE", dataSource),
    udp("SDN_BATCH_ID", batchId),
    udp("SDN_SOURCE_URL", sourceUrl),
    udp("SDN_FIT_RMS_KM", rms),
    udp("SDN_FIT_REFERENCE_RMS_KM", refRms),
    udp("SDN_FIT_ITERATIONS", fit.ITERATIONS),
    udp("SDN_FIT_CONVERGED", fit.CONVERGED),
    udp("SDN_FIT_WINDOW_SEC", SGP4_FIT_WINDOW_SEC),
    udp("SDN_VCM_AVAILABILITY", "vcm-unavailable"),
    udp("SDN_PERTURBATION_REFERENCE_SPEC", VCM_REFERENCE_SPEC),
    udp("SDN_OMM_COMPANION", "true"),
  ].filter(Boolean);

  const ocm = Object.assign(new OCMT(), {
    HEADER: header,
    METADATA: metadata,
    TRAJ_TYPE_DESCRIPTION: "ESTIMATED",
    PERTURBATIONS: perturbations,
    ORBIT_DETERMINATION: orbitDetermination,
    USER_DEFINED_PARAMETERS: params,
  });

  const b = new flatbuffers.Builder(1024);
  const off = ocm.pack(b);
  OCM.finishSizePrefixedOCMBuffer(b, off);
  return b.asUint8Array().slice();
}
