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
const TIER_D_KNOWN_RED = {};

/**
 * ROWS THAT WERE HELD OPEN AND ARE NOW GREEN, with what closed them.
 *
 * The marker comes off in the SAME commit as the fix — the runner asserts that
 * a marked row still fails, so a repaired defect turns the suite red until a
 * human takes the marker off deliberately. That is the mechanism working, and
 * the repair record is what stops the row from looking like it was never
 * broken. Compare `TIER_A_REPAIRED` in build-vectors.mjs, which does the same
 * for the three Tudat rows 0.2.0 fixed.
 */
export const TIER_D_REPAIRED = {
  "hapsira-curtis-5-3": {
    task: "modules-maneuver-lambert-refuses-a-solvable-arc",
    landedWith: "maneuver-planner 0.3.0",
    note:
      "Held open from the tier-D suite's first run. The row is unchanged — same " +
      "hapsira source, same 1e-4 tolerance, same adjudicating invariant. What " +
      "changed is the SEARCH: the zero-revolution downward march started at " +
      "|step| = max(1, |z0|) and only doubled, so for this geometry — root at " +
      "z = -0.173, domain boundary at z = -0.398 — the first probe at z = -1 " +
      "landed outside the domain and every later probe landed further outside. " +
      "The march now keeps a bracket in step space and bisects TOWARD the " +
      "boundary on a non-finite probe. No expression in the formulation was " +
      "touched, and the 72-geometry LEO sweep plus every other Lambert row is " +
      "bit-identical.",
  },
  "hapsira-der-molniya-1rev-highpath": {
    task: "modules-maneuver-lambert-multi-rev-exposes-one-branch-of-two",
    landedWith: "maneuver-planner 0.3.0",
    note:
      "Held open from the tier-D suite's first run, and never a wrong ANSWER — " +
      "a missing half of a surface. A one-revolution Lambert problem has two " +
      "arcs; the scan took the first sign change and the JSON surface carried " +
      "no way to ask for the second. The request now takes `branch: \"low\" | " +
      "\"high\"` (default low = 0.2.0's arc, so no existing caller moves) and " +
      "the response names the branch it returned. This row asks for the high " +
      "path explicitly; its low-path twin still passes with the default AND " +
      "with the selector stated.",
  },
  "lambert-perigee-radius-not-published-SCREENING": {
    task: "modules-maneuver-lambert-publishes-no-transfer-perigee",
    landedWith: "maneuver-planner 0.3.0",
    note:
      "Held open from the tier-D suite's first run. The module now publishes " +
      "the transfer arc's own conic — perigeeRadius, transferEccentricity, " +
      "transferConic, and apogeeRadius/transferSemiMajorAxis where they exist — " +
      "so a consumer can screen a through-Earth arc without computing orbital " +
      "mechanics in JavaScript. It still SOLVES this geometry and the five " +
      "others that pass through the planet, because they are correct answers " +
      "that hapsira, Orekit and Vallado assert; the fix was a report, never a " +
      "refusal. The tier-C `lambert-earth-floor` invariant was upgraded in the " +
      "same commit from classifying its own reconstruction to CHECKING the " +
      "module's reported field against it, on every Lambert row.",
  },
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

/**
 * Which arc of a multi-revolution row the upstream case is, on OUR request
 * surface.
 *
 * hapsira spells the choice `lowpath=True/False` and records it in the
 * extract's prose `branch` field; 0.3.0's request surface spells it
 * `branch: "low" | "high"`. Mapping it HERE — from the extract's own words, by
 * a rule with no default — is what keeps the two vocabularies reconciled in one
 * place. A row whose prose says neither is a dumper defect and throws rather
 * than silently defaulting to the arc that happens to pass.
 */
function requestBranchOf(entry) {
  if (entry.nRevs === 0 || !entry.branch) return null;
  if (/low-path/.test(entry.branch)) return "low";
  if (/high-path/.test(entry.branch)) return "high";
  throw new Error(
    `${entry.id}: multi-revolution row whose branch prose ("${entry.branch}") ` +
      "names neither the low nor the high path. A one-revolution Lambert " +
      "problem has exactly two arcs; a vector that cannot say which one it " +
      "asserts is asserting nothing.",
  );
}

/**
 * hapsira Lambert rows -> solveLambert vectors.
 *
 * `explicitBranch` selects how the branch reaches the request: `null` sends no
 * `branch` param at all (the DEFAULT path, which must keep returning 0.2.0's
 * arc), while a string states it. Both forms exist in the vector set for the
 * low path on purpose — "the default still returns the low arc" and "asking for
 * the low arc returns the low arc" are two different claims, and only the pair
 * of them pins the selector without loosening the default.
 */
function hapsiraLambertCase(extract, entry, options = {}) {
  const expect = {};
  const fieldBands = {};
  for (const field of ["v1", "v2"]) {
    const values = entry.values[field];
    if (!values) continue;
    for (let axis = 0; axis < 3; axis += 1) expect[`${field}.${axis}`] = values[axis];
    fieldBands[field] = bandFrom(entry.tolerances[field], values);
  }
  const requestBranch = requestBranchOf(entry);
  // A multi-revolution response must NAME the arc it returned, whether or not
  // the request named one — otherwise a caller cannot tell which of the two it
  // was given, which is the surface half that was missing.
  if (requestBranch) expect.branch = requestBranch;
  const knownRed = TIER_D_KNOWN_RED[entry.id];
  const repaired = TIER_D_REPAIRED[entry.id];
  const stateBranch = options.stateBranch ?? false;
  return {
    id: options.id ?? entry.id,
    tier: "D",
    operation: "solveLambert",
    params: {
      r1: entry.values.r1,
      r2: entry.values.r2,
      tof: entry.values.tof,
      mu: entry.values.mu,
      prograde: entry.prograde,
      nRevs: entry.nRevs,
      // The HIGH path is unreachable without stating it, so its row always
      // states it; the LOW path is the default and gets both forms.
      ...(requestBranch && (stateBranch || requestBranch === "high")
        ? { branch: requestBranch }
        : {}),
    },
    expect,
    fieldBands,
    ...(knownRed ? { expectedToFail: { defect: TIER_D_DEFECTS[knownRed] } } : {}),
    ...(repaired && !options.id ? { repairedBy: repaired } : {}),
    source: commonSource(extract, entry, "hapsira"),
    note: options.note ?? entry.note,
    derived: { prograde: entry.progradeDerivation },
    branch: entry.branch ?? null,
    requestBranch: requestBranch
      ? {
          value: requestBranch,
          stated: Boolean(stateBranch || requestBranch === "high"),
          rule:
            "0.3.0 request surface: branch?: \"low\" | \"high\", default \"low\". " +
            "hapsira's own spelling is lowpath=True/False; the mapping is in " +
            "requestBranchOf().",
        }
      : null,
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
 * problem can screen on it. 0.2.0 published neither the perigee nor a flag, so
 * the only way for the console to screen was to re-derive the conic from the
 * returned velocity IN JAVASCRIPT — which the no-JS-physics law forbids. That
 * was the defect, and it was a report defect rather than a behaviour change:
 * 0.3.0 still solves this geometry and the five others that pass through the
 * planet, and now says how low each one goes.
 *
 * The expected numbers are derived from hapsira's OWN published r1 and v1 by the
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

  const semiMajorAxis = -mu / (2 * energy);
  const apogeeRadius = semiMajorAxis * (1 + eccentricity);

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
    /**
     * The COMPANION fields are asserted too, and from the same derivation.
     * `perigeeRadius` alone would pass against a module that reported the
     * perigee and got the conic type wrong, and the conic type is exactly what
     * a consumer reads to tell "this arc has no apoapsis" from "this field was
     * dropped" (SDK ruling, 2026-08-10: an omitted key is only legible beside
     * an always-present discriminant).
     */
    expect: {
      perigeeRadius,
      apogeeRadius,
      transferEccentricity: eccentricity,
      transferSemiMajorAxis: semiMajorAxis,
      transferConic: "elliptic",
    },
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
      apogeeRadius: {
        abs: 1,
        rel: source.tolerances.v1.value,
        alarmBudgetFraction: ALARM_BUDGET_FRACTION,
        sourceTolerance: source.tolerances.v1.value,
        sourceToleranceKind: "derived from the published v1 tolerance",
      },
      transferSemiMajorAxis: {
        abs: 1,
        rel: source.tolerances.v1.value,
        alarmBudgetFraction: ALARM_BUDGET_FRACTION,
        sourceTolerance: source.tolerances.v1.value,
        sourceToleranceKind: "derived from the published v1 tolerance",
      },
      transferEccentricity: {
        abs: 0,
        rel: source.tolerances.v1.value,
        alarmBudgetFraction: ALARM_BUDGET_FRACTION,
        sourceTolerance: source.tolerances.v1.value,
        sourceToleranceKind: "derived from the published v1 tolerance",
      },
    },
    repairedBy: TIER_D_REPAIRED["lambert-perigee-radius-not-published-SCREENING"],
    classification: {
      perigeeRadius,
      earthRadius: 6378137,
      note:
        "this published, foreign, entirely correct Lambert solution dives to " +
        `${Math.round(perigeeRadius)} m from the Earth's CENTRE. Against 0.2.0 ` +
        "the module returned it as converged and said nothing about that, which " +
        "was the whole defect; 0.3.0 still returns it — it is a correct answer " +
        "three libraries publish — and now says how low it goes, so the consumer " +
        "that cares can refuse it and the consumer solving an IOD problem need " +
        "not.",
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

// ---------------------------------------------------------------------------
// Orekit Cartesian-state -> element rows, for `phasingFromTargetState`
// ---------------------------------------------------------------------------

const TWO_PI = 2 * Math.PI;
/** [0, 2pi) — the fold the module applies to every absolute angle it reports. */
const normalizeAngle = (angle) => {
  const folded = angle % TWO_PI;
  const positive = folded < 0 ? folded + TWO_PI : folded;
  return positive >= TWO_PI ? 0 : positive;
};
/** (-pi, pi] — the fold the module applies to every SIGNED angle it reports. */
const wrapToPi = (angle) => {
  const folded = angle % TWO_PI;
  if (folded <= -Math.PI) return folded + TWO_PI;
  if (folded > Math.PI) return folded - TWO_PI;
  return folded;
};

/**
 * FIRST-ORDER TOLERANCE PROPAGATION, done by measurement rather than by
 * calculus.
 *
 * Orekit states a gate on each quantity it asserts. Three of the quantities
 * this row needs — the equinoctial case's RAAN, its mean ARGUMENT of latitude,
 * and the pair's relative phase — are FUNCTIONS of several of those, so their
 * honest gate is the sum of the source gates weighted by the sensitivities.
 * Rather than write six partial derivatives out and hope, each input is
 * perturbed by its own stated tolerance and the absolute changes are summed.
 * That is the same number the calculus gives to first order, and it cannot
 * drift out of step with the expression above it.
 *
 * Asserting anything tighter would be asserting digits Orekit never published.
 */
function propagateTolerance(fn, inputs, tolerances) {
  const base = fn(inputs);
  let budget = 0;
  for (const key of Object.keys(tolerances)) {
    const nudged = { ...inputs, [key]: inputs[key] + tolerances[key] };
    budget += Math.abs(fn(nudged) - base);
  }
  return { value: base, tolerance: budget };
}

function propagatedBand(propagated, provenance) {
  return {
    abs: propagated.tolerance,
    rel: 0,
    alarmBudgetFraction: ALARM_BUDGET_FRACTION,
    sourceTolerance: propagated.tolerance,
    sourceToleranceKind: "propagated-atol",
    provenance,
  };
}

/**
 * ONE Orekit Cartesian state, put in BOTH craft slots.
 *
 * The claim is entirely about element recovery: the operation's front door is
 * `stateToClassicalElements`, and this row drives it with a foreign state and
 * checks it against the foreign answer, at the foreign tolerance. The strongly
 * eccentric geometry is the point — e = 0.7435 is where a true anomaly
 * recovered any other way still looks right, and where the mean anomaly is
 * most sensitive to getting the eccentric anomaly's quadrant wrong.
 */
function orekitCartesianElementsCase(extract, entry) {
  const v = entry.values;
  const state = { position: v.position, velocity: v.velocity };
  const expect = { chaserSemiMajorAxis: v.semiMajorAxis, relativePhaseAngle: 0 };
  const fieldBands = {
    chaserSemiMajorAxis: bandFrom(entry.tolerances.semiMajorAxis, v.semiMajorAxis),
    // The same state in both slots: the separation is identically zero, and
    // the thing being checked is that the wrap says 0 and not 2*pi.
    relativePhaseAngle: { abs: 1e-12, rel: 0 },
  };
  const derived = {};

  if (entry.tolerances.meanAnomaly) {
    // KEPLERIAN shape: Orekit asserts every angle separately, so every angle
    // is pinned separately.
    const lambda = propagateTolerance(
      ({ argp, m }) => normalizeAngle(argp + m),
      { argp: v.argumentOfPerigee, m: v.meanAnomaly },
      {
        argp: entry.tolerances.argumentOfPerigee.absolute,
        m: entry.tolerances.meanAnomaly.absolute,
      },
    );
    expect.chaserEccentricity = v.eccentricity;
    expect.chaserMeanAnomaly = normalizeAngle(v.meanAnomaly);
    expect.chaserMeanArgumentOfLatitude = lambda.value;
    fieldBands.chaserEccentricity = bandFrom(entry.tolerances.eccentricity, v.eccentricity);
    fieldBands.chaserMeanAnomaly = bandFrom(entry.tolerances.meanAnomaly, v.meanAnomaly);
    fieldBands.chaserMeanArgumentOfLatitude = propagatedBand(
      lambda,
      "argumentOfPerigee + meanAnomaly, gated by the SUM of the two gates the " +
        "source states for them — a gate of 1e-7 relative to the sum would be " +
        "tighter than either source claim and would fail on digits Orekit " +
        "never published",
    );
    derived.meanArgumentOfLatitude =
      "argumentOfPerigee + meanAnomaly, both asserted separately by the source";
  } else {
    // EQUINOCTIAL shape: at e = 0.002 and i = 0.4 degrees Orekit does not
    // assert the parts, because the parts are not resolvable. It asserts the
    // equinoctial set, so the eccentricity and the mean ARGUMENT of latitude
    // are reconstructed from it by the source's own definitions.
    const eccentricity = propagateTolerance(
      ({ ex, ey }) => Math.hypot(ex, ey),
      { ex: v.equinoctialEx, ey: v.equinoctialEy },
      {
        ex: entry.tolerances.equinoctialEx.absolute,
        ey: entry.tolerances.equinoctialEy.absolute,
      },
    );
    const lambda = propagateTolerance(
      ({ hx, hy, lm }) => normalizeAngle(lm - Math.atan2(hy, hx)),
      { hx: v.equinoctialHx, hy: v.equinoctialHy, lm: v.meanLongitude },
      {
        hx: entry.tolerances.equinoctialHx.absolute,
        hy: entry.tolerances.equinoctialHy.absolute,
        lm: entry.tolerances.meanLongitude.absolute,
      },
    );
    expect.chaserEccentricity = eccentricity.value;
    expect.chaserMeanArgumentOfLatitude = lambda.value;
    fieldBands.chaserEccentricity = propagatedBand(
      eccentricity,
      "sqrt(ex^2 + ey^2) — the source's own eccentricity expression, which it " +
        "asserts in that form — gated by the ex and ey tolerances",
    );
    fieldBands.chaserMeanArgumentOfLatitude = propagatedBand(
      lambda,
      "meanLongitude - atan2(hy, hx): Orekit pins the mean LONGITUDE " +
        "(raan + argp + M) and this module reports the mean ARGUMENT OF " +
        "LATITUDE (argp + M), so the RAAN the equinoctial hx/hy encode is " +
        "subtracted, and its gate is carried through",
    );
    derived.eccentricity = { expression: "sqrt(ex^2 + ey^2)", ...eccentricity };
    derived.meanArgumentOfLatitude = { expression: "LM - atan2(hy, hx)", ...lambda };
  }

  return {
    id: entry.id,
    tier: "D",
    operation: "phasingFromTargetState",
    params: { chaserState: state, targetState: state, mu: v.mu },
    expect,
    fieldBands,
    source: commonSource(extract, entry, "orekit"),
    note: entry.note,
    derived,
  };
}

/**
 * The TWO Orekit Cartesian states as a PAIR.
 *
 * This is the row that reaches the phase geometry itself. Each craft's mean
 * argument of latitude is fixed by Orekit — the eccentric one by its separately
 * asserted argument of perigee and mean anomaly, the near-circular one by the
 * mean LONGITUDE it asserts minus the RAAN its equinoctial `hx`/`hy` encode.
 * The combination rule on top (the quasi-nonsingular relative mean longitude)
 * is this repo's, is stated in classical.h, and is pinned analytically by the
 * tier-B constructions; what this row adds is that the ELEMENTS it combines are
 * the elements a foreign implementation recovers from the same bytes.
 *
 * The pair is deliberately NOT flyable — different orbits, different planes —
 * and the row asserts the module says so: `coplanar` and `coOrbital` both
 * false. An operation that reported a phasing plan for this pair without those
 * flags would be handing an operator a maneuver that does not rendezvous.
 */
function orekitCartesianPairCase(extract, keplerian, equinoctial) {
  const c = keplerian.values;
  const t = equinoctial.values;

  const chaserLambda = normalizeAngle(c.argumentOfPerigee + c.meanAnomaly);
  const chaserLambdaTolerance =
    keplerian.tolerances.argumentOfPerigee.absolute +
    keplerian.tolerances.meanAnomaly.absolute;

  // Orekit's own equinoctial definitions: hx = tan(i/2) cos(raan),
  // hy = tan(i/2) sin(raan); the inclination expression below is the one the
  // source's own assertion uses, character for character in meaning.
  const targetRaanOf = ({ hx, hy }) => Math.atan2(hy, hx);
  const targetInclinationOf = ({ hx, hy }) =>
    2 * Math.asin(Math.sqrt((hx * hx + hy * hy) / 4));
  const targetLambdaOf = ({ hx, hy, lm }) => normalizeAngle(lm - Math.atan2(hy, hx));

  const hxTolerance = equinoctial.tolerances.equinoctialHx.absolute;
  const hyTolerance = equinoctial.tolerances.equinoctialHy.absolute;
  const lmTolerance = equinoctial.tolerances.meanLongitude.absolute;
  const equinoctialInputs = { hx: t.equinoctialHx, hy: t.equinoctialHy, lm: t.meanLongitude };

  const targetRaan = propagateTolerance(targetRaanOf, equinoctialInputs, {
    hx: hxTolerance, hy: hyTolerance,
  });
  const targetInclination = propagateTolerance(targetInclinationOf, equinoctialInputs, {
    hx: hxTolerance, hy: hyTolerance,
  });
  const targetLambda = propagateTolerance(targetLambdaOf, equinoctialInputs, {
    hx: hxTolerance, hy: hyTolerance, lm: lmTolerance,
  });

  const relativePhaseOf = ({ lambdaT, lambdaC, raanT, raanC, incC }) =>
    wrapToPi(lambdaT - lambdaC + wrapToPi(raanT - raanC) * Math.cos(incC));
  const relativePhase = propagateTolerance(
    relativePhaseOf,
    {
      lambdaT: targetLambda.value,
      lambdaC: chaserLambda,
      raanT: targetRaan.value,
      raanC: c.raan,
      incC: c.inclination,
    },
    {
      lambdaT: targetLambda.tolerance,
      lambdaC: chaserLambdaTolerance,
      raanT: targetRaan.tolerance,
      raanC: keplerian.tolerances.raan.absolute,
      incC: keplerian.tolerances.inclination.absolute,
    },
  );

  const raanDifferenceOf = ({ raanT, raanC }) => wrapToPi(raanT - raanC);
  const raanDifference = propagateTolerance(
    raanDifferenceOf,
    { raanT: targetRaan.value, raanC: c.raan },
    { raanT: targetRaan.tolerance, raanC: keplerian.tolerances.raan.absolute },
  );

  const inclinationDifferenceOf = ({ incT, incC }) => incT - incC;
  const inclinationDifference = propagateTolerance(
    inclinationDifferenceOf,
    { incT: targetInclination.value, incC: c.inclination },
    {
      incT: targetInclination.tolerance,
      incC: keplerian.tolerances.inclination.absolute,
    },
  );

  return {
    id: "orekit-cartesian-phase-pair",
    tier: "D",
    operation: "phasingFromTargetState",
    params: {
      chaserState: { position: c.position, velocity: c.velocity },
      targetState: { position: t.position, velocity: t.velocity },
      mu: c.mu,
    },
    expect: {
      chaserSemiMajorAxis: c.semiMajorAxis,
      targetSemiMajorAxis: t.semiMajorAxis,
      chaserMeanArgumentOfLatitude: chaserLambda,
      targetMeanArgumentOfLatitude: targetLambda.value,
      raanDifference: raanDifference.value,
      inclinationDifference: inclinationDifference.value,
      relativePhaseAngle: relativePhase.value,
      coplanar: false,
      coOrbital: false,
    },
    fieldBands: {
      chaserSemiMajorAxis: bandFrom(keplerian.tolerances.semiMajorAxis, c.semiMajorAxis),
      targetSemiMajorAxis: bandFrom(equinoctial.tolerances.semiMajorAxis, t.semiMajorAxis),
      chaserMeanArgumentOfLatitude: {
        abs: chaserLambdaTolerance,
        rel: 0,
        alarmBudgetFraction: ALARM_BUDGET_FRACTION,
        sourceTolerance: chaserLambdaTolerance,
        sourceToleranceKind: "propagated-atol",
        provenance: "argumentOfPerigee gate + meanAnomaly gate, both from the source",
      },
      targetMeanArgumentOfLatitude: propagatedBand(
        targetLambda,
        "meanLongitude - atan2(hy, hx), gated by the source's own hx, hy and LM tolerances",
      ),
      raanDifference: propagatedBand(
        raanDifference,
        "atan2(hy, hx) for the equinoctial craft minus the asserted RAAN of the keplerian one",
      ),
      inclinationDifference: propagatedBand(
        inclinationDifference,
        "2*asin(sqrt((hx^2+hy^2)/4)) — the source's OWN inclination expression — minus the asserted inclination",
      ),
      relativePhaseAngle: propagatedBand(
        relativePhase,
        "the quasi-nonsingular relative mean longitude of the two, gated by every Orekit tolerance it consumes",
      ),
    },
    source: {
      ...commonSource(extract, keplerian, "orekit"),
      file: [keplerian.source.file, equinoctial.source.file],
      testCase: [keplerian.source.testCase, equinoctial.source.testCase],
      upstream:
        "Orekit CartesianOrbitTest.testCartesianToKeplerian (chaser) + " +
        ".testCartesianToEquinoctial (target)",
    },
    note:
      "NEITHER hapsira NOR Orekit implements the operation this row tests. That " +
      "was checked rather than assumed (see PROVENANCE.md): hapsira has no " +
      "phasing maneuver and no angular-separation helper at all, and Orekit's " +
      "closest surface, WalkerConstellation, SYNTHESISES a phased orbit from a " +
      "T/P/F spec instead of measuring the phase between two given craft. So " +
      "the foreign claim available is the PRIMITIVE — Cartesian state in, mean " +
      "anomaly and mean longitude out — and this row buys exactly that, on two " +
      "states at once, and lets the combination rule be pinned by the analytic " +
      "tier-B constructions where the truth is exact.",
    derived: {
      targetRaan: {
        expression: "atan2(hy, hx)",
        value: targetRaan.value,
        tolerance: targetRaan.tolerance,
      },
      targetInclination: {
        expression: "2*asin(sqrt((hx^2 + hy^2)/4))",
        value: targetInclination.value,
        tolerance: targetInclination.tolerance,
      },
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
      /**
       * THE DEFAULT AND THE SELECTOR ARE TWO CLAIMS, so the low path is
       * asserted twice.
       *
       * The row above sends no `branch` at all, which pins that 0.3.0's default
       * still returns the arc 0.2.0 returned — the compatibility half. This one
       * states `branch: "low"` and pins that the selector, when exercised,
       * selects the same arc — the correctness half. A suite carrying only the
       * first would pass against a module whose selector was ignored entirely;
       * one carrying only the second would pass against a module that had
       * silently changed its default.
       */
      if (entry.id === "hapsira-der-molniya-1rev-lowpath") {
        cases.push(
          hapsiraLambertCase(hapsira, entry, {
            id: "hapsira-der-molniya-1rev-lowpath-selector",
            stateBranch: true,
            note:
              "The same upstream arc as hapsira-der-molniya-1rev-lowpath, asked " +
              "for by name instead of by default. Both rows must agree, and the " +
              "pair is what pins the selector without loosening the default " +
              "(graph: modules-maneuver-lambert-multi-rev-exposes-one-branch-of-two).",
          }),
        );
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
    else if (entry.kind === "cartesian-elements") {
      cases.push(orekitCartesianElementsCase(orekit, entry));
    }
    else throw new Error(`unknown orekit extract kind ${entry.kind}`);
  }

  // The PAIR row needs both Cartesian cases at once, so it is built after the
  // loop rather than inside it. Both must be present: a pair row assembled
  // from one extract and a memory of the other is exactly the retyping this
  // whole dumper exists to prevent.
  const keplerianState = orekit.cases.find((c) => c.id === "orekit-cartesian-to-keplerian");
  const equinoctialState = orekit.cases.find((c) => c.id === "orekit-cartesian-to-equinoctial");
  if (keplerianState && equinoctialState) {
    cases.push(orekitCartesianPairCase(orekit, keplerianState, equinoctialState));
  } else if (keplerianState || equinoctialState) {
    throw new Error(
      "the orekit extract carries one Cartesian element case but not the other; " +
        "the phase-pair row needs both states and will not be assembled from one",
    );
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
