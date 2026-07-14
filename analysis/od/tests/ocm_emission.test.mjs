// OCM emission unit tests (owner directive 2026-07-14). Proves:
//   1. the SGP4 fit-context -> propagator-settings mapper carries the VCM's
//      documented perturbation taxonomy with our honest SGP4 values and honest
//      null/N-A where the theory does not define a field (NO VCM record used);
//   2. buildOcmFrame produces a valid, size-prefixed $OCM FlatBuffer that
//      round-trips through the generated SDS OCM reader with identity, the
//      PERTURBATIONS block, OD metadata, and the fitted mean-element state intact.
//
// These are pure (no wasm fitter, no daemon), so they run in the standard
// `node --test` lane alongside the SDK-compat suite.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SGP4_FIT_WINDOW_SEC,
  SGP4_GM_KM3_S2,
  VCM_REFERENCE_SPEC,
  sgp4PerturbationContext,
  perturbationTaxonomyPairs,
  loadOcmBindings,
  buildOcmFrame,
} from "../scripts/lib/ocm-record.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const anchors = [
  path.resolve(__dirname, "../../../propagator/sgp4/package.json"),
  path.resolve(__dirname, "../../../propagator/hpop/package.json"),
  path.resolve(__dirname, "../node_modules/space-data-module-sdk/package.json"),
];

// A representative fit-method result (od::elements_to_json shape). Realistic
// LEO Starlink-like values; identity fields mimic the module placeholder.
const FIT = {
  OBJECT_NAME: "STARLINK-36348",
  OBJECT_ID: "",
  EPOCH: "2026-07-14T12:00:00.000Z",
  MEAN_MOTION: 15.12345678,
  ECCENTRICITY: 0.0001234,
  INCLINATION: 53.2164,
  RA_OF_ASC_NODE: 123.4567,
  ARG_OF_PERICENTER: 88.1234,
  MEAN_ANOMALY: 271.9876,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 99999,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 12345,
  BSTAR: 1.23456e-4,
  MEAN_MOTION_DOT: 1.1e-6,
  MEAN_MOTION_DDOT: 0,
  RMS: "0.123",
  REFERENCE_RMS: "0.200",
  ITERATIONS: 7,
  MAX_ITERATIONS: 50,
  CONVERGED: true,
  DATA_SOURCE: "SpaceX-E",
};
const META = { norad: 67851, objectName: "STARLINK-36348", objectId: "", source: "SpaceX-E" };
const BATCH_ID = "b".repeat(64);

test("sgp4PerturbationContext: VCM-taxonomy field selection, honest SGP4 values", () => {
  const ctx = sgp4PerturbationContext(FIT);
  // geopotential — SGP4 defines these
  assert.equal(ctx.gravityModel, "WGS-72");
  assert.equal(ctx.gravityDegree, 4);
  assert.equal(ctx.gravityOrder, 0);
  assert.equal(ctx.gm, SGP4_GM_KM3_S2);
  assert.deepEqual(ctx.zonalHarmonics, ["J2", "J3", "J4"]);
  // drag — B* is the ONLY drag parameter SGP4 fits
  assert.equal(ctx.ballisticCoeffBstar, 1.23456e-4);
  assert.equal(ctx.dragCoeffCd, null);
  // atmosphere / SRP / third-body / flux — SGP4 does NOT model these -> honest null
  assert.equal(ctx.atmosphericDensityModel, null);
  assert.equal(ctx.srpModel, null);
  assert.equal(ctx.solarFluxF10p7, null);
  assert.equal(ctx.geomagKp, null);
  assert.deepEqual(ctx.thirdBody, []);
  assert.equal(ctx.fitWindowSec, SGP4_FIT_WINDOW_SEC);
  assert.match(ctx.referenceSpec, /Vector Covariance Message/);
});

test("sgp4PerturbationContext: absent/invalid BSTAR yields honest null, never fabricated", () => {
  assert.equal(sgp4PerturbationContext({}).ballisticCoeffBstar, null);
  assert.equal(sgp4PerturbationContext({ BSTAR: "n/a" }).ballisticCoeffBstar, null);
});

test("perturbationTaxonomyPairs: N/A dashes for undefined, real values where SGP4 defines them", () => {
  const pairs = new Map(perturbationTaxonomyPairs(sgp4PerturbationContext(FIT)));
  assert.equal(pairs.get("PERT_GEOPOTENTIAL_MODEL"), "WGS-72");
  assert.equal(pairs.get("PERT_GEOPOTENTIAL_DEGREE"), "4");
  assert.equal(pairs.get("PERT_GEOPOTENTIAL_ORDER"), "0");
  assert.equal(pairs.get("PERT_GM_KM3_S2"), String(SGP4_GM_KM3_S2));
  assert.match(pairs.get("PERT_BALLISTIC_COEFF_BSTAR"), /0\.000123456.*earth-radii/);
  assert.match(pairs.get("PERT_ATMOSPHERIC_DENSITY_MODEL"), /N\/A/);
  assert.match(pairs.get("PERT_SOLAR_FLUX_F10P7"), /N\/A/);
  assert.match(pairs.get("PERT_GEOMAG_KP"), /N\/A/);
  assert.match(pairs.get("PERT_SRP_MODEL"), /N\/A/);
  assert.match(pairs.get("PERT_THIRD_BODY"), /NONE/);
});

test("buildOcmFrame: builds a valid size-prefixed $OCM that decodes with the SDS reader", async () => {
  const bindings = await loadOcmBindings(anchors);
  const frame = buildOcmFrame({
    fit: FIT,
    meta: META,
    batchId: BATCH_ID,
    creationDate: "2026-07-14T12:00:00Z",
    sourceUrl: "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt",
    bindings,
  });
  assert.ok(frame instanceof Uint8Array && frame.length > 0, "frame is bytes");

  // decode via the generated reader (size-prefixed root) + $OCM file identifier
  const bb = new bindings.flatbuffers.ByteBuffer(frame);
  bb.setPosition(bb.position() + bindings.flatbuffers.SIZE_PREFIX_LENGTH);
  assert.ok(bindings.OCM.bufferHasIdentifier(bb), "carries $OCM file identifier");
  bb.setPosition(0);
  const o = bindings.OCM.getSizePrefixedRootAsOCM(bb).unpack();

  // header + provenance
  assert.equal(o.HEADER.CCSDS_OCM_VERS, "3.0");
  assert.equal(o.HEADER.ORIGINATOR, "SpaceX-E");
  assert.ok(o.HEADER.COMMENT.some((c) => c.includes(VCM_REFERENCE_SPEC)), "cites VCM reference spec");
  assert.ok(o.HEADER.COMMENT.some((c) => /vcm-unavailable/.test(c)), "declares vcm-unavailable");

  // identity — from provider, never fabricated
  assert.equal(o.METADATA.OBJECT_NAME, "STARLINK-36348");
  assert.equal(o.METADATA.OBJECT_DESIGNATOR, "67851");
  assert.equal(o.METADATA.TIME_SYSTEM, "UTC");

  // PERTURBATIONS — VCM vocabulary, SGP4 honest values
  assert.equal(o.PERTURBATIONS.GRAVITY_MODEL, "WGS-72");
  assert.equal(o.PERTURBATIONS.GRAVITY_DEGREE, 4);
  assert.equal(o.PERTURBATIONS.GRAVITY_ORDER, 0);
  assert.equal(o.PERTURBATIONS.GM, SGP4_GM_KM3_S2);
  assert.match(o.PERTURBATIONS.SOLAR_RAD_PRESSURE, /N\/A/);
  assert.match(o.PERTURBATIONS.RELATIVITY, /N\/A/);
  assert.ok(o.PERTURBATIONS.COMMENT.some((c) => c.includes("VCM")), "perturbations comment cites VCM");

  // OD block
  assert.equal(o.ORBIT_DETERMINATION.OD_ALGORITHM, "SGP4 differential correction");
  assert.match(o.ORBIT_DETERMINATION.OD_METHOD, /Levenberg-Marquardt/);
  assert.match(o.ORBIT_DETERMINATION.OD_METHOD, /multi-start/);
  assert.equal(o.ORBIT_DETERMINATION.OD_EPOCH, FIT.EPOCH);
  assert.match(o.ORBIT_DETERMINATION.OD_RESIDUALS, /RMS_KM=0\.123/);
  assert.match(o.ORBIT_DETERMINATION.OD_APRIORI_DATA, new RegExp(`FIT_WINDOW_SEC=${SGP4_FIT_WINDOW_SEC}`));

  // fitted mean-element state mirrors the companion $OMM (carried as UDP pairs)
  const udp = new Map(o.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
  assert.equal(udp.get("NORAD_CAT_ID"), "67851");
  assert.equal(udp.get("MEAN_MOTION"), "15.12345678");
  assert.equal(udp.get("INCLINATION"), "53.2164");
  assert.equal(udp.get("BSTAR"), "0.000123456");
  assert.match(udp.get("PERT_BALLISTIC_COEFF_BSTAR"), /0\.000123456/);
  assert.match(udp.get("PERT_SOLAR_FLUX_F10P7"), /N\/A/);
  assert.equal(udp.get("SDN_VCM_AVAILABILITY"), "vcm-unavailable");
  assert.equal(udp.get("SDN_BATCH_ID"), BATCH_ID);
});
