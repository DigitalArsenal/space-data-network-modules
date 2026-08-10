#!/usr/bin/env node
/**
 * TIER D COMPOSER — turn the committed library extracts into vector rows.
 *
 * The two dumpers (`dump-hapsira-vectors.mjs`, `dump-orekit-vectors.mjs`) read
 * upstream test SOURCE and emit `hapsira-extract.json` / `orekit-extract.json`.
 * This file does no reading of upstream at all: it maps those extracts onto the
 * module's JSON operation surface and derives each row's tolerance band. Split
 * that way, regenerating a vector needs an upstream checkout; CONSUMING one
 * needs nothing.
 *
 * THE BAND POLICY FOR TIER D, and why it differs from tier A
 * ---------------------------------------------------------
 * Tier A floors the relative gate at 1e-6 because Tudat prints some of its
 * references to six significant figures and a case-wide floor was the only
 * thing available. Tier D does not need a floor: both dumpers carry the
 * source's OWN stated tolerance per expected symbol, and the printed precision
 * is recoverable from the literal itself. So:
 *
 *     rel = the tolerance the upstream test states for THAT symbol
 *     abs = half a unit in the last decimal place actually published
 *
 * Both terms come from the source. Nothing here is chosen to make a row pass,
 * and no row is gated tighter than the digits its reference published.
 *
 * THE REGRESSION WATERMARK IS A FRACTION OF THE ROW'S OWN BUDGET, not a
 * multiple of the source tolerance, and the difference is the whole reason the
 * watermark is worth having.
 *
 * Tier A can afford `sourceTolerance * 1e-3` because Tudat quotes its
 * highest-authority rows to fifteen significant figures and the solver
 * reproduces them at 1e-12 — three decades inside the gate is empty space
 * there. Tier D's references are printed to five to seven figures and hapsira
 * gates at 1e-5 BECAUSE ITS OWN TWO SOLVERS ONLY AGREE TO THAT. Applying the
 * tier-A construction here lit twenty-two alarms on a fully green run, which is
 * an alarm nobody reads and therefore no alarm at all.
 *
 * So a tier-D row alarms when it has consumed more than `alarmBudgetFraction`
 * of the gate the SOURCE stated. That is a statement about margin rather than
 * about precision: "this row is within twenty percent of the tolerance its own
 * reference demanded" is unambiguous, cannot be permanently on unless the row
 * genuinely is near its cliff, and is exactly what the worst-row line the
 * runner prints on every pass is already measuring.
 */
const ALARM_BUDGET_FRACTION = 0.8;

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HAPSIRA_EXTRACT = path.resolve(HERE, "..", "hapsira-extract.json");
const OREKIT_EXTRACT = path.resolve(HERE, "..", "orekit-extract.json");

/**
 * Half a unit in the last decimal place a number was PUBLISHED to.
 *
 * `-5992.5` was published as `-5.9925 km/s`; its last decimal place is worth
 * 0.1 m/s and half of that is the finest absolute claim the reference supports.
 * Deriving this from the literal is what keeps `abs` honest at components that
 * are legitimately zero, where a relative band asserts nothing at all.
 */
export function halfUlpOfPublishedValue(value) {
  if (!Number.isFinite(value)) return 0;
  if (value === 0) return 0;
  // `toPrecision(17)` then trimming is not enough: 1000x unit conversion can
  // introduce a trailing 0000001. Round to 12 significant digits first, which
  // is far beyond any published reference and well inside double precision.
  const text = Number(value.toPrecision(12)).toString();
  if (text.includes("e") || text.includes("E")) {
    const exponent = Number(text.split(/[eE]/)[1]);
    const mantissa = text.split(/[eE]/)[0];
    const decimals = (mantissa.split(".")[1] ?? "").length;
    return 0.5 * 10 ** (exponent - decimals);
  }
  const decimals = (text.split(".")[1] ?? "").length;
  return 0.5 * 10 ** -decimals;
}

/** Widest half-ulp across the components of one expected field. */
function absFor(values) {
  const list = Array.isArray(values) ? values : [values];
  return list.reduce((worst, value) => Math.max(worst, halfUlpOfPublishedValue(value)), 0);
}

/**
 * Build one band from an upstream tolerance statement and the published values
 * it guards.
 *
 * `rtol` becomes the relative term; `atol` becomes the absolute term and the
 * relative term goes to zero, because a source that stated an absolute gate
 * stated an absolute gate.
 */
function bandFrom(tolerance, values, extra = {}) {
  if (!tolerance) throw new Error("a tier-D band needs the source's own stated tolerance");
  const published = absFor(values);
  if (tolerance.kind === "atol") {
    return {
      abs: Math.max(tolerance.value, published),
      rel: 0,
      alarmBudgetFraction: ALARM_BUDGET_FRACTION,
      sourceTolerance: tolerance.value,
      sourceToleranceKind: "atol",
      publishedHalfUlp: published,
      ...extra,
    };
  }
  return {
    abs: published,
    rel: tolerance.value,
    alarmBudgetFraction: ALARM_BUDGET_FRACTION,
    sourceTolerance: tolerance.value,
    sourceToleranceKind: tolerance.kind,
    publishedHalfUlp: published,
    ...extra,
  };
}

/**
 * Rows the module does not currently satisfy, and the defect each one names.
 *
 * A known-red row is not a disabled test: `tests/vectors.test.mjs` ASSERTS that
 * it fails, so the day the defect is fixed the suite goes red and forces a
 * deliberate re-baseline in front of a human. The marker is applied HERE, in
 * the generator, and never by hand in `vectors.json` — a hand-edited marker
 * survives no regeneration and the file's own `--check` would reject it.
 */
const TIER_D_KNOWN_RED = {
  "hapsira-curtis-5-3": "lambertRefusesSolvableArc",
  "hapsira-der-molniya-1rev-highpath": "lambertMultiRevBranch",
};

/** The defect ledger for tier D. Every known-red row names one of these. */
export const TIER_D_DEFECTS = {
  lambertRefusesSolvableArc:
    "modules-maneuver-lambert-refuses-a-solvable-arc — solveLambert answers " +
    "`no-solution` for Curtis example 5.3, a geometry hapsira solves and whose " +
    "solution this repo's own independent propagator confirms arrives. The " +
    "zero-revolution downward march starts at |step| = max(1, |z0|) and only " +
    "DOUBLES; this root sits at z = -0.173, so the first probe lands at z = -1 " +
    "where y < 0 and F is not finite, and every probe after it is deeper in the " +
    "empty domain. A whole class of short-transfer-angle hyperbolic arcs is " +
    "unreachable, reported as if no arc existed.",
  lambertPublishesNoPerigee:
    "modules-maneuver-lambert-publishes-no-transfer-perigee — solveLambert " +
    "returns a converged arc without saying how low it goes. Five of the eight " +
    "published conformance geometries in this tier produce transfers that pass " +
    "THROUGH the Earth, so refusing them is not the answer and the tier-C " +
    "`lambert-earth-floor` classification proves it; publishing `perigeeRadius` " +
    "is. Without it the only place to screen is the console, in JavaScript, " +
    "which the no-JS-physics law forbids — and an operator met the consequence " +
    "live on 2026-08-10.",
  hohmannDepartureSpeed:
    "modules-maneuver-hohmann-departure-speed — computeHohmannTransfer (and " +
    "computeBiEllipticTransfer, which shares the assumption) departs from a " +
    "CIRCULAR orbit of radius r1, and the JSON surface gives the caller no way " +
    "to state the true departure speed. hapsira's own Maneuver.hohmann takes " +
    "the speed from the departure STATE, so its eccentric-departure figures are " +
    "the difference the missing parameter is worth.",
  lambertMultiRevBranch:
    "modules-maneuver-lambert-multi-rev-exposes-one-branch-of-two — a " +
    "multi-revolution Lambert problem has TWO arcs for a given revolution " +
    "count. solveLambert scans the bounded interval and returns the FIRST sign " +
    "change, and the JSON surface carries no way to ask for the other branch.",
};

function commonSource(extract, entry, library) {
  const head = library === "hapsira" ? extract.hapsira.head : extract.orekit.head;
  const version = library === "hapsira" ? extract.hapsira.version : null;
  return {
    library,
    head,
    version,
    license: entry.source.license,
    file: entry.source.file,
    testCase: entry.source.testCase,
    symbols: entry.source.symbols,
    upstream: entry.source.upstream ?? null,
  };
}

/** hapsira Lambert rows -> solveLambert vectors. */
function hapsiraLambertCase(extract, entry) {
  const expect = {};
  const fieldBands = {};
  for (const field of ["v1", "v2"]) {
    const values = entry.values[field];
    if (!values) continue;
    for (let axis = 0; axis < 3; axis += 1) expect[`${field}.${axis}`] = values[axis];
    fieldBands[field] = bandFrom(entry.tolerances[field], values);
  }
  const knownRed = TIER_D_KNOWN_RED[entry.id];
  return {
    id: entry.id,
    tier: "D",
    operation: "solveLambert",
    params: {
      r1: entry.values.r1,
      r2: entry.values.r2,
      tof: entry.values.tof,
      mu: entry.values.mu,
      prograde: entry.prograde,
      nRevs: entry.nRevs,
    },
    expect,
    fieldBands,
    ...(knownRed ? { expectedToFail: { defect: TIER_D_DEFECTS[knownRed] } } : {}),
    source: commonSource(extract, entry, "hapsira"),
    note: entry.note,
    derived: { prograde: entry.progradeDerivation },
    branch: entry.branch ?? null,
  };
}

/**
 * THE PERIGEE-SCREENING ROW — foreign INPUTS and a foreign-derived expected
 * number, but a requirement that is ours, and the file says so.
 *
 * The owner hit a through-Earth transfer live on 2026-08-10. The obvious fix —
 * make `solveLambert` REFUSE an arc whose perigee is inside the planet — is
 * wrong, and this vector set is what proves it: the tier-C `lambert-earth-floor`
 * invariant classifies every Lambert row on every run, and FIVE OF THE EIGHT
 * published conformance geometries produce arcs that pass through the Earth.
 * Vallado's example 7-5 dives to 3,186 km from the centre; Der's Molniya case,
 * which both hapsira and Orekit carry, dives to 909 km. These are correct
 * answers to the Lambert problem, and a solver that refused them would fail its
 * own conformance suite against three separate libraries.
 *
 * So the requirement is not a refusal, it is a REPORT: `solveLambert` must
 * publish the transfer arc's perigee radius, so the consumer that knows whether
 * it is planning a spacecraft manoeuvre or solving an orbit-determination
 * problem can screen on it. Today it publishes neither the perigee nor a flag,
 * and the only way for the console to screen is to re-derive the conic from the
 * returned velocity IN JAVASCRIPT — which the no-JS-physics law forbids. That
 * is the defect, and it is a one-field defect rather than a behaviour change.
 *
 * The expected number is derived from hapsira's OWN published r1 and v1 by the
 * standard conic relations, which is the same class of derivation the
 * eccentric-departure rows already declare. The module is never consulted.
 */
function perigeeReportingCase(extract, source) {
  const r1 = source.values.r1;
  const v1 = source.values.v1;
  const mu = source.values.mu;
  const rMagnitude = Math.sqrt(r1[0] ** 2 + r1[1] ** 2 + r1[2] ** 2);
  const vMagnitude = Math.sqrt(v1[0] ** 2 + v1[1] ** 2 + v1[2] ** 2);
  const momentum = [
    r1[1] * v1[2] - r1[2] * v1[1],
    r1[2] * v1[0] - r1[0] * v1[2],
    r1[0] * v1[1] - r1[1] * v1[0],
  ];
  const h = Math.sqrt(momentum[0] ** 2 + momentum[1] ** 2 + momentum[2] ** 2);
  const energy = (vMagnitude * vMagnitude) / 2 - mu / rMagnitude;
  const semiLatusRectum = (h * h) / mu;
  const eccentricity = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
  const perigeeRadius = semiLatusRectum / (1 + eccentricity);

  return {
    id: "lambert-perigee-radius-not-published-SCREENING",
    tier: "D",
    operation: "solveLambert",
    params: {
      r1: source.values.r1,
      r2: source.values.r2,
      tof: source.values.tof,
      mu: source.values.mu,
      prograde: source.prograde,
      nRevs: source.nRevs,
    },
    expect: { perigeeRadius },
    fieldBands: {
      /**
       * The gate is hapsira's own velocity tolerance carried through: the
       * perigee radius is a smooth function of the published v1, so a 1e-6
       * relative claim about the velocity supports about the same about the
       * conic. Nothing here is tighter than the digits hapsira printed.
       */
      perigeeRadius: {
        abs: 1,
        rel: source.tolerances.v1.value,
        alarmBudgetFraction: ALARM_BUDGET_FRACTION,
        sourceTolerance: source.tolerances.v1.value,
        sourceToleranceKind: "derived from the published v1 tolerance",
      },
    },
    expectedToFail: {
      defect: TIER_D_DEFECTS.lambertPublishesNoPerigee,
      classification: {
        perigeeRadius,
        earthRadius: 6378137,
        note:
          "this published, foreign, entirely correct Lambert solution dives to " +
          `${Math.round(perigeeRadius)} m from the Earth's CENTRE. The module ` +
          "returns it as converged and says nothing about that, which is the " +
          "whole defect.",
      },
    },
    source: {
      ...commonSource(extract, source, "hapsira"),
      /**
       * Stated separately from `source` on purpose. The INPUTS and the number
       * are hapsira's (the second through a declared derivation); the
       * REQUIREMENT that the module publish it is this repo's. Letting a
       * locally-authored requirement sit inside a block that otherwise means
       * "somebody else published this" is exactly the provenance rot the tier
       * exists to prevent.
       */
      expectationOrigin:
        "this repo — owner directive 2026-08-10 (a through-Earth transfer reached " +
        "an operator). No contributing library reports a transfer perigee, so " +
        "there is no vector to lift for the REQUIREMENT; the NUMBER is derived " +
        "from hapsira's published r1 and v1 by the standard conic relations.",
      derivation: {
        rule: "p = h^2/mu; e^2 = 1 + 2 E h^2 / mu^2; r_p = p / (1 + e)",
        angularMomentum: h,
        specificEnergy: energy,
        eccentricity,
        semiLatusRectum,
      },
    },
    note:
      "Der's Molniya geometry again — the row three libraries agree on — asked " +
      "the one question none of them asks: how low does this arc go?",
  };
}

/** hapsira refusal rows -> a REFUSAL expectation. */
function hapsiraRefusalCase(extract, entry) {
  return {
    id: entry.id,
    tier: "D",
    operation: "solveLambert",
    params: {
      r1: entry.values.r1,
      r2: entry.values.r2,
      tof: entry.values.tof,
      mu: entry.values.mu,
      prograde: entry.prograde,
      nRevs: entry.nRevs,
    },
    /**
     * A refusal row asserts a NEGATIVE, and the negative has to be precise or
     * it is worthless. Three things together:
     *   - the call returns a STRUCTURED failure (non-zero status), never a trap
     *     and never a success;
     *   - the response body carries no velocity, so nothing downstream can read
     *     a burn out of a refusal;
     *   - the instance still answers afterwards, which `tests/error_path.mjs`
     *     asserts for the whole probe set and this row inherits by running on
     *     the shared harness.
     */
    expectRefusal: {
      upstreamMessage: entry.upstreamMessage,
      forbidFields: ["v1", "v2", "converged"],
    },
    expect: {},
    source: commonSource(extract, entry, "hapsira"),
    note: entry.note,
  };
}

/** hapsira two-burn transfers -> hohmannTransfer / biEllipticTransfer vectors. */
function hapsiraTransferCase(extract, entry) {
  const params = { r1: entry.values.r1, r2: entry.values.r2, mu: entry.values.mu };
  if (entry.values.rIntermediate !== undefined) {
    params.rIntermediate = entry.values.rIntermediate;
  }
  const expect = {};
  const fieldBands = {};
  for (const [field, value] of Object.entries(entry.expect)) {
    expect[field] = value;
    fieldBands[field] = bandFrom(entry.tolerances[field], value);
  }
  return {
    id: entry.id,
    tier: "D",
    operation: entry.operation,
    params,
    expect,
    fieldBands,
    source: commonSource(extract, entry, "hapsira"),
    note: entry.note,
    derived: { radii: entry.radiiFrom },
  };
}

/** hapsira eccentric-departure rows -> KNOWN-RED against the departure-speed task. */
function hapsiraEccentricDepartureCase(extract, entry) {
  const params = { r1: entry.values.r1, r2: entry.values.r2, mu: entry.values.mu };
  if (entry.values.rIntermediate !== undefined) {
    params.rIntermediate = entry.values.rIntermediate;
  }
  return {
    id: entry.id,
    tier: "D",
    operation: entry.operation,
    params,
    expect: { totalDeltaV: entry.expect.totalDeltaV },
    fieldBands: {
      totalDeltaV: bandFrom(entry.tolerances.totalDeltaV, entry.expect.totalDeltaV),
    },
    expectedToFail: {
      defect: TIER_D_DEFECTS.hohmannDepartureSpeed,
      /**
       * The row records the SIZE of the gap as well as its existence. A
       * known-red marker that says only "this fails" cannot tell a fix from a
       * different, larger break.
       */
      departureSpeed: {
        circularAssumption: Math.sqrt(entry.values.mu / entry.values.r1),
        actual: entry.derivedDepartureState.periapsisSpeed,
        eccentricity: entry.derivedDepartureState.eccentricity,
        note:
          "the whole disagreement is the difference between these two speeds: " +
          "the module computes dv1 against sqrt(mu/r1), hapsira against the " +
          "orbit's true periapsis speed, and every other term is identical.",
      },
    },
    source: commonSource(extract, entry, "hapsira"),
    note: entry.note,
    derived: {
      radii: entry.radiiFrom,
      departureState: entry.derivedDepartureState,
    },
    reprLiteral: entry.reprLiteral,
  };
}

/** Orekit's Der case -> a solveLambert vector asserted on the MAGNITUDES only. */
function orekitLambertMagnitudeCase(extract, entry) {
  return {
    id: entry.id,
    tier: "D",
    operation: "solveLambert",
    params: {
      r1: entry.values.r1,
      r2: entry.values.r2,
      tof: entry.values.tof,
      mu: entry.values.mu,
      prograde: entry.prograde,
      nRevs: entry.nRevs,
    },
    expect: {
      v1Magnitude: entry.values.v1Magnitude,
      v2Magnitude: entry.values.v2Magnitude,
    },
    fieldBands: {
      v1Magnitude: bandFrom(entry.tolerances.v1Magnitude, entry.values.v1Magnitude),
      v2Magnitude: bandFrom(entry.tolerances.v2Magnitude, entry.values.v2Magnitude),
    },
    source: commonSource(extract, entry, "orekit"),
    note: entry.note,
    derived: { prograde: entry.progradeCheck },
  };
}

/**
 * Orekit's inertial impulsive-burn identity.
 *
 * NOT a module operation, and the file says so rather than pretending. The
 * maneuver module exports no burn-application op; the surface that applies a
 * burn and recovers elements is `plugin_entity_apply_impulsive_burn` in
 * `propagator/sgp4`, which an ACTIVE lane owns
 * (`orbpro-propagators-have-no-native-burn-surface`). Conformance against that
 * ABI is filed there rather than duplicated here, and this row asserts the part
 * the maneuver module DOES own: the RIC <-> inertial algebra every `*_ric`
 * field in every response depends on, checked against a foreign triple and a
 * foreign tolerance.
 */
function orekitImpulsiveBurnCase(extract, entry) {
  return {
    id: entry.id,
    tier: "D",
    operation: "ricFrameAlgebra",
    frameAlgebra: {
      initialVelocity: entry.values.initialVelocity,
      deltaV: entry.values.deltaV,
      expectedFinalVelocity: entry.values.expectedFinalVelocity,
      tolerance: entry.tolerances.finalVelocity.value,
    },
    expect: {},
    source: commonSource(extract, entry, "orekit"),
    note: entry.note,
    unmappedModuleSurface: {
      abi: "plugin_entity_apply_impulsive_burn (propagator/sgp4), plugin_set_burns (propagator/hpop)",
      owner: "orbpro-propagators-have-no-native-burn-surface",
      why:
        "the burn-application ABI is mid-flight in another lane; adding a second " +
        "suite against the artifact it is rebuilding would race a republish. The " +
        "follow-on is filed rather than dropped.",
    },
  };
}

export async function buildLibraryCases() {
  const cases = [];
  if (!existsSync(HAPSIRA_EXTRACT)) {
    throw new Error(
      `${HAPSIRA_EXTRACT} is missing. Run vectors/tools/dump-hapsira-vectors.mjs ` +
        "(it needs a hapsira checkout to READ; hapsira is never imported).",
    );
  }
  if (!existsSync(OREKIT_EXTRACT)) {
    throw new Error(
      `${OREKIT_EXTRACT} is missing. Run vectors/tools/dump-orekit-vectors.mjs ` +
        "(it needs an orekit checkout to READ; orekit is never compiled).",
    );
  }
  const hapsira = JSON.parse(await readFile(HAPSIRA_EXTRACT, "utf8"));
  const orekit = JSON.parse(await readFile(OREKIT_EXTRACT, "utf8"));

  for (const entry of hapsira.cases) {
    if (entry.kind === "lambert") {
      cases.push(hapsiraLambertCase(hapsira, entry));
      if (entry.id === "hapsira-der-molniya-0rev") {
        cases.push(perigeeReportingCase(hapsira, entry));
      }
    }
    else if (entry.kind === "refusal") cases.push(hapsiraRefusalCase(hapsira, entry));
    else if (entry.kind === "transfer") cases.push(hapsiraTransferCase(hapsira, entry));
    else if (entry.kind === "eccentric-departure") {
      cases.push(hapsiraEccentricDepartureCase(hapsira, entry));
    } else throw new Error(`unknown hapsira extract kind ${entry.kind}`);
  }
  for (const entry of orekit.cases) {
    if (entry.kind === "lambert-magnitude") cases.push(orekitLambertMagnitudeCase(orekit, entry));
    else if (entry.kind === "impulsive-burn") cases.push(orekitImpulsiveBurnCase(orekit, entry));
    else throw new Error(`unknown orekit extract kind ${entry.kind}`);
  }
  return cases;
}

export async function libraryProvenance() {
  const hapsira = JSON.parse(await readFile(HAPSIRA_EXTRACT, "utf8"));
  const orekit = JSON.parse(await readFile(OREKIT_EXTRACT, "utf8"));
  return {
    hapsira: {
      head: hapsira.hapsira.head,
      version: hapsira.hapsira.version,
      license: hapsira.hapsira.license,
      licenseNote: hapsira.hapsira.licenseNote,
      constants: hapsira.constants,
    },
    orekit: {
      head: orekit.orekit.head,
      license: orekit.orekit.license,
      licenseNote: orekit.orekit.licenseNote,
      copyrightNotice: orekit.orekit.copyrightNotice,
      constants: orekit.constants,
    },
  };
}
