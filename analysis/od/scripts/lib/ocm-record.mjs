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
  const [ocmMod, headerMod, metaMod, pertMod, odMod, fitMod, pvnMod, trajMod] = await Promise.all([
    imp("OCM.js"),
    imp("Header.js"),
    imp("Metadata.js"),
    imp("Perturbations.js"),
    imp("OrbitDetermination.js"),
    imp("OCMFitStatistics.js"),
    imp("PVN.js"),
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
    OCMFitStatisticsT: fitMod.OCMFitStatisticsT,
    PVNT: pvnMod.PVNT,
    trajectoryType: trajMod.trajectoryType,
  };
}

// ── OCM record builder ───────────────────────────────────────────────────────
// Builds a size-prefixed $OCM FlatBuffer for one fitted object. `fit` is the OD
// module's JSON (elements_to_json: EPOCH, MEAN_MOTION, ... , RMS, ITERATIONS,
// CONVERGED, DATA_SOURCE). `meta` is provider identity {norad, objectName,
// objectId, source}. Identity (NORAD/name/COSPAR) comes from the provider, never
// fabricated; the mean elements are the companion $OMM's. Every field is typed:
// the fit in FIT_STATISTICS, the source in PROVENANCE.
export function buildOcmFrame({ fit, meta, batchId, creationDate, sourceUrl, bindings }) {
  const {
    flatbuffers,
    OCM,
    OCMT,
    HeaderT,
    MetadataT,
    PerturbationsT,
    OrbitDeterminationT,
    OCMFitStatisticsT,
    PVNT,
  } = bindings;

  const norad = meta.norad >>> 0;
  const rms = toNum(fit.RMS);
  const dataSource = fit.DATA_SOURCE ?? meta.source ?? "";
  const epoch = fit.EPOCH ?? "";
  const ctx = sgp4PerturbationContext(fit);
  const fitStop = epoch ? new Date(Date.parse(epoch) + SGP4_FIT_WINDOW_SEC * 1000).toISOString() : "";

  // ── HEADER ──
  const header = Object.assign(new HeaderT(), {
    CCSDS_OCM_VERS: OCM_VERS,
    COMMENT: [
      "SDN OD-fitted Orbit Comprehensive Message (App 2) — companion to the fitted supplemental $OMM.",
      `PERTURBATIONS + OD field selection follows the ${VCM_REFERENCE_SPEC}. No VCM record was read or produced; values are our own SGP4 fit-theory context.`,
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
    NORAD_CAT_ID: norad,
    OBJECT_TYPE: "PAYLOAD",
    TIME_SYSTEM: "UTC",
    EPOCH_TZERO: epoch,
    OCM_DATA_ELEMENTS: ["PERT", "OD"],
  });

  // ── PERTURBATIONS (VCM-taxonomy field selection; SGP4 honest values) ──
  const perturbations = Object.assign(new PerturbationsT(), {
    COMMENT: [
      `Field selection per ${VCM_REFERENCE_SPEC}.`,
      "SGP4 is an analytic near-Earth mean-element theory: drag via B* power-law (no atmospheric density table), zonal geopotential J2/J3/J4 only, no third-body, no SRP, no tides.",
      "Fields the SGP4 theory does not define are marked N/A (honest-absent), never fabricated. The drag term is the companion $OMM's fitted B*; solar-flux F10.7 / geomagnetic Kp/Ap are not used by SGP4.",
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
    // SGP4 (documented in COMMENT).
    // N_BODY_PERTURBATIONS left empty: honest zero third-body.
    // FIXED_F10P7 / FIXED_F10P7_MEAN / FIXED_GEOMAG_KP omitted: unused by SGP4.
  });

  // ── ORBIT_DETERMINATION: the fit window and statistics, typed ──
  const orbitDetermination = Object.assign(new OrbitDeterminationT(), {
    OD_ID: `${String(batchId).slice(0, 16)}-${norad}`,
    OD_ALGORITHM: "SGP4 differential correction",
    OD_METHOD: "Levenberg-Marquardt least-squares, multi-start (equinoctial elements)",
    OD_EPOCH: epoch,
    OD_TIME_TAG: epoch,
    OD_OBSERVATIONS_TYPE: ["EPHEMERIS_STATE"],
    OD_TRACKS_USED: 1, // one provider ephemeris file = one continuous track
    OD_DATA_WEIGHTING: "UNIFORM",
    OD_EST_PARAMETERS: [
      "MEAN_MOTION",
      "ECCENTRICITY",
      "INCLINATION",
      "RA_OF_ASC_NODE",
      "ARG_OF_PERICENTER",
      "MEAN_ANOMALY",
      "BSTAR",
    ],
    ACTUAL_OD_SPAN: SGP4_FIT_WINDOW_SEC / 86400,
    FIT_STATISTICS: Object.assign(new OCMFitStatisticsT(), {
      FIT_RMS_KM: rms ?? Number.NaN,
      ITERATIONS: Number(fit.ITERATIONS ?? 0),
      CONVERGED: fit.CONVERGED === true || fit.CONVERGED === "true",
      FIT_START: epoch,
      FIT_STOP: fitStop,
    }),
    // OD_OBSERVATIONS_USED omitted: the fit method does not report a point count.
  });

  // ── PROVENANCE: the source and where it was retrieved ──
  const provenance = Object.assign(new PVNT(), {
    SOURCE_ID: meta.source ?? "",
    ORIGINATOR: dataSource,
    SOURCE_URL: sourceUrl ?? "",
  });

  const ocm = Object.assign(new OCMT(), {
    HEADER: header,
    METADATA: metadata,
    TRAJ_TYPE_DESCRIPTION: "ESTIMATED",
    PERTURBATIONS: perturbations,
    ORBIT_DETERMINATION: orbitDetermination,
    PROVENANCE: provenance,
    ORB_REVNUM: Number(fit.REV_AT_EPOCH ?? 0),
  });

  const b = new flatbuffers.Builder(1024);
  const off = ocm.pack(b);
  OCM.finishSizePrefixedOCMBuffer(b, off);
  return b.asUint8Array().slice();
}
