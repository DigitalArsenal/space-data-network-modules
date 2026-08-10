#!/usr/bin/env node
/**
 * TIER D DUMPER (2 of 2) — mechanical extraction of Orekit's OWN maneuver and
 * Lambert unit-test vectors.
 *
 * Orekit is Apache-2.0 (the licence header of every file this reads is checked
 * below, not assumed), and it is already the parity authority this repo uses
 * for `foundation/time`. Its `IodLambertTest` carries Der's "Superior Lambert
 * Algorithm" case as a fully self-contained vector — positions in metres,
 * velocities in m/s, a stated time of flight, a NAMED gravitational parameter,
 * and an absolute tolerance — and its `ImpulseManeuverTest` carries the
 * inertial-frame impulsive burn identity in a form that needs no propagator.
 *
 * THE RULE, unchanged from the tudat and hapsira dumpers: a reference number is
 * never retyped. Every value here is parsed out of the Orekit source. Orekit is
 * an ORACLE — this script reads `.java` TEXT; nothing is compiled, linked, or
 * depended on.
 *
 * WHAT IS MECHANICAL: every numeric literal, every `new Vector3D(...)` triple,
 * every `shiftedBy(...)` offset, every tolerance argument of the assertions,
 * and the gravitational parameters, which are read out of
 * `src/main/java/org/orekit/utils/Constants.java` — Orekit's Der case runs at
 * EGM96's mu and hapsira's runs at the IAU value, and hardcoding either here
 * would quietly merge two different physics problems into one row.
 *
 * WHAT IS DECLARED: `CASE_BINDINGS` — which symbol plays which role. No number.
 *
 * Usage:
 *   node dump-orekit-vectors.mjs [--orekit <checkout>] [--out <file>]
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(HERE, "..", "orekit-extract.json");

const OREKIT_CANDIDATES = [
  process.env.OREKIT_ROOT,
  path.join(os.homedir(), "software", "upstream", "orekit"),
  path.join(os.homedir(), "software", "worktrees", "orekit"),
].filter(Boolean);

const IOD_LAMBERT = path.join(
  "src", "test", "java", "org", "orekit", "estimation", "iod", "IodLambertTest.java",
);
const IMPULSE_MANEUVER = path.join(
  "src", "test", "java", "org", "orekit", "forces", "maneuvers", "ImpulseManeuverTest.java",
);
const CONSTANTS = path.join("src", "main", "java", "org", "orekit", "utils", "Constants.java");

// ---------------------------------------------------------------------------
// A very small Java-expression reader
// ---------------------------------------------------------------------------

/** Slice a method body out of a Java source by BRACE MATCHING from its signature. */
function methodBody(source, name) {
  const signature = new RegExp(`(?:public|private|protected)?\\s*(?:static\\s+)?void\\s+${name}\\s*\\(`);
  const match = signature.exec(source);
  if (!match) throw new Error(`Orekit source has no method ${name}`);
  const open = source.indexOf("{", match.index);
  if (open < 0) throw new Error(`method ${name} has no body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Strip `//` and block comments so a commented-out literal can never be read. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Java numeric literal -> number. Rejects anything that is not a plain literal. */
function javaNumber(text, what) {
  const cleaned = text.trim().replace(/[dDfF]$/, "");
  if (!/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(cleaned)) {
    throw new Error(`${what}: ${JSON.stringify(text)} is not a plain numeric literal`);
  }
  return Number(cleaned);
}

/**
 * `final Vector3D name = new Vector3D(a, b, c);` -> [a, b, c].
 *
 * A component may be a literal or the name of a `double` declared earlier in
 * the same method — Orekit writes both forms, sometimes in the same test — so
 * an identifier is resolved by looking its declaration up in the same block.
 * Anything else throws.
 */
function readVector3D(block, name) {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*new\\s+Vector3D\\s*\\(([^;]*?)\\)\\s*;`,
  );
  const match = pattern.exec(block);
  if (!match) throw new Error(`no "new Vector3D" assignment to ${name}`);
  const parts = splitTopLevel(match[1]);
  if (parts.length !== 3) {
    throw new Error(`${name}: expected three components, got ${parts.length}`);
  }
  return parts.map((part, axis) => {
    const text = part.trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
      return readScalar(block, text);
    }
    return javaNumber(text, `${name}[${axis}]`);
  });
}

/** `<Type> name = <base>.shiftedBy(N);` -> N seconds. */
function readShiftedBy(block, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*[A-Za-z_][A-Za-z0-9_]*\\.shiftedBy\\(([^)]*)\\)`);
  const match = pattern.exec(block);
  if (!match) throw new Error(`no shiftedBy assignment to ${name}`);
  return javaNumber(match[1], `${name}.shiftedBy`);
}

/** `double name = <literal>;` -> number. */
function readScalar(block, name) {
  const pattern = new RegExp(`\\b(?:final\\s+)?double\\s+${name}\\s*=\\s*([^;]+);`);
  const match = pattern.exec(block);
  if (!match) throw new Error(`no double assignment to ${name}`);
  return javaNumber(match[1], name);
}

/**
 * The tolerance an assertion states, found by the SYMBOL it is asserting about.
 *
 * Orekit writes `assertEquals(0.0, orbit.getVelocity().getNorm() - velR1.getNorm(), 1e-3)`,
 * so the tolerance belongs to `velR1` and is found by looking for the assertion
 * that mentions it. Reading the gate from the source is what stops us choosing
 * one that happens to make a row pass.
 */
function readAssertionTolerance(block, symbol) {
  const lines = block.split(";");
  for (const line of lines) {
    if (!line.includes("assertEquals")) continue;
    if (!new RegExp(`\\b${symbol}\\b`).test(line)) continue;
    const args = /assertEquals\(([\s\S]*)\)\s*$/.exec(line.trim());
    if (!args) continue;
    const parts = splitTopLevel(args[1]);
    if (parts.length < 3) continue;
    return javaNumber(parts[parts.length - 1], `tolerance for ${symbol}`);
  }
  throw new Error(`no assertEquals with a tolerance mentions ${symbol}`);
}

/** Split a Java argument list at top-level commas. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let buffer = "";
  for (const character of text) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(buffer);
      buffer = "";
      continue;
    }
    buffer += character;
  }
  if (buffer.trim() !== "") parts.push(buffer);
  return parts;
}

/** `double NAME = <literal>;` out of Constants.java. */
function readNamedConstant(source, name) {
  const pattern = new RegExp(`\\bdouble\\s+${name}\\s*=\\s*([^;]+);`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`Constants.java has no ${name}`);
  return javaNumber(match[1], name);
}

/** Refuse to lift from a file whose licence header is not the Apache one. */
function assertApacheHeader(source, file) {
  const header = source.slice(0, 1200);
  if (!/Apache License, Version 2\.0/.test(header)) {
    throw new Error(
      `${file} does not carry the Apache-2.0 header this dumper depends on. ` +
        "Lifting vectors is a licensing decision — stop and re-check before regenerating.",
    );
  }
  return /Copyright\s+([0-9-]+)\s+([^\n*]+)/.exec(header)?.[0]?.trim() ?? null;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// ---------------------------------------------------------------------------
// CASE BINDINGS — metadata only. Never a number.
// ---------------------------------------------------------------------------

const LAMBERT_BINDINGS = [
  {
    id: "orekit-der-superior-lambert",
    file: IOD_LAMBERT,
    test: "testIssue752",
    symbols: {
      r1: "posR1",
      r2: "posR2",
      tof: "date2",
      v1: "velR1",
      v2: "velR2",
      mu: "EGM96_EARTH_MU",
    },
    nRevs: 0,
    prograde: true,
    upstream: 'Der, "Superior Lambert Algorithm"',
    note:
      "Orekit's own regression for the Der Molniya case, at EGM96's mu rather " +
      "than the IAU value hapsira uses. Orekit asserts only the NORMS of the two " +
      "velocities, to 1e-3 m/s, so this row asserts exactly those — v1Magnitude " +
      "and v2Magnitude, which the module publishes. Asserting the components " +
      "would be asserting something Orekit does not.",
    /**
     * `posigrade = true` and `nRev = 0` are read as arguments of the
     * `lambert.estimate(...)` call rather than inferred, and the extractor
     * checks them against the source text below.
     */
    estimateCall: "lambert.estimate(inertialFrame, true, 0,",
  },
];

const IMPULSE_BINDINGS = [
  {
    id: "orekit-inertial-impulsive-burn",
    file: IMPULSE_MANEUVER,
    test: "testInertialManeuver",
    symbols: {
      vx: "initialVx",
      vy: "initialVy",
      vz: "initialVz",
      dv: "deltaV",
      tolerance: "maneuverTolerance",
    },
    upstream: "Orekit ImpulseManeuverTest.testInertialManeuver",
    note:
      "THE IMPULSIVE-BURN IDENTITY, in the frame where it has no free " +
      "parameters: a delta-v applied in an INERTIAL frame adds component by " +
      "component to the inertial velocity, and Orekit asserts exactly that to " +
      "1e-4 m/s after propagating through the burn. Our maneuver module exposes " +
      "no burn-application op, so this row is carried as the RIC round-trip's " +
      "inertial anchor: the same three components, expressed in the RIC triad of " +
      "a stated state and converted back, must reproduce them.",
  },
];

// ---------------------------------------------------------------------------

function resolveCheckout(explicit) {
  const candidates = explicit ? [explicit] : OREKIT_CANDIDATES;
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, CONSTANTS))) return candidate;
  }
  throw new Error(
    "no orekit checkout found. Pass --orekit <dir>, set OREKIT_ROOT, or clone:\n" +
      "  git clone --filter=blob:none --no-checkout --depth 1 --branch develop \\\n" +
      "    https://gitlab.orekit.org/orekit/orekit.git ~/software/upstream/orekit\n" +
      "  (then: git sparse-checkout set src/test/java/org/orekit src/main/java/org/orekit/utils)\n" +
      "Orekit is READ as text; it is never compiled and never linked.",
  );
}

function gitHead(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const readFlag = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  const root = resolveCheckout(readFlag("--orekit"));
  const outPath = readFlag("--out") ?? DEFAULT_OUT;

  const constantsSource = await readFile(path.join(root, CONSTANTS), "utf8");
  assertApacheHeader(constantsSource, CONSTANTS);
  const constants = {
    EGM96_EARTH_MU: readNamedConstant(constantsSource, "EGM96_EARTH_MU"),
    WGS84_EARTH_MU: readNamedConstant(constantsSource, "WGS84_EARTH_MU"),
  };

  const sources = new Map();
  const loadSource = async (relative) => {
    if (!sources.has(relative)) {
      const text = await readFile(path.join(root, relative), "utf8");
      assertApacheHeader(text, relative);
      sources.set(relative, text);
    }
    return sources.get(relative);
  };

  const cases = [];

  for (const binding of LAMBERT_BINDINGS) {
    const raw = await loadSource(binding.file);
    const block = stripComments(methodBody(raw, binding.test));
    if (!block.replace(/\s+/g, " ").includes(binding.estimateCall.replace(/\s+/g, " "))) {
      throw new Error(
        `${binding.test} no longer calls ${binding.estimateCall} — the posigrade flag ` +
          "and revolution count this row records are no longer the ones the source uses",
      );
    }
    const r1 = readVector3D(block, binding.symbols.r1);
    const r2 = readVector3D(block, binding.symbols.r2);
    const tof = readShiftedBy(block, binding.symbols.tof);
    const v1 = readVector3D(block, binding.symbols.v1);
    const v2 = readVector3D(block, binding.symbols.v2);
    const mu = constants[binding.symbols.mu];
    if (!mu) throw new Error(`unknown constant ${binding.symbols.mu}`);
    const toleranceV1 = readAssertionTolerance(block, binding.symbols.v1);
    const toleranceV2 = readAssertionTolerance(block, binding.symbols.v2);
    cases.push({
      id: binding.id,
      kind: "lambert-magnitude",
      operation: "solveLambert",
      source: {
        library: "orekit",
        file: binding.file,
        testCase: binding.test,
        symbols: binding.symbols,
        upstream: binding.upstream,
        license: "Apache-2.0",
      },
      nRevs: binding.nRevs,
      prograde: binding.prograde,
      progradeCheck: {
        rule: "the source passes posigrade=true; the geometry agrees (sign of (r1 x r2)_z)",
        momentumZ: cross(r1, r2)[2],
      },
      values: {
        r1,
        r2,
        tof,
        mu,
        v1Magnitude: norm(v1),
        v2Magnitude: norm(v2),
        v1Components: v1,
        v2Components: v2,
      },
      tolerances: {
        v1Magnitude: { kind: "atol", value: toleranceV1 },
        v2Magnitude: { kind: "atol", value: toleranceV2 },
      },
      note: binding.note,
    });
  }

  for (const binding of IMPULSE_BINDINGS) {
    const raw = await loadSource(binding.file);
    const block = stripComments(methodBody(raw, binding.test));
    const deltaV = readVector3D(block, binding.symbols.dv);
    const velocity = [
      readScalar(block, binding.symbols.vx),
      readScalar(block, binding.symbols.vy),
      readScalar(block, binding.symbols.vz),
    ];
    const tolerance = readScalar(block, binding.symbols.tolerance);
    cases.push({
      id: binding.id,
      kind: "impulsive-burn",
      operation: "ricRoundTrip",
      source: {
        library: "orekit",
        file: binding.file,
        testCase: binding.test,
        symbols: binding.symbols,
        upstream: binding.upstream,
        license: "Apache-2.0",
      },
      values: {
        initialVelocity: velocity,
        deltaV,
        expectedFinalVelocity: velocity.map((component, axis) => component + deltaV[axis]),
      },
      tolerances: { finalVelocity: { kind: "atol", value: tolerance } },
      note: binding.note,
    });
  }

  const payload = {
    "//":
      "MECHANICALLY EXTRACTED from Orekit test sources by " +
      "vectors/tools/dump-orekit-vectors.mjs. Do not hand-edit: regenerate. " +
      "Orekit is consulted as an ORACLE — it is never compiled, linked, or " +
      "depended on by any build in this repo.",
    generator: "vectors/tools/dump-orekit-vectors.mjs",
    orekit: {
      root,
      head: gitHead(root),
      license: "Apache-2.0",
      licenseNote:
        "Apache-2.0 permits reuse of the values with attribution and does not " +
        "reach our artifact. No Orekit CODE is copied: the dumper reads the test " +
        "sources as text and re-expresses inputs and expected numbers in our own " +
        "JSON. Every file it reads is checked for the Apache header before a " +
        "single number is taken from it.",
      copyrightNotice: assertApacheHeader(constantsSource, CONSTANTS),
    },
    constants,
    cases,
  };

  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stderr.write(
    `wrote ${outPath}: ${cases.length} cases from orekit ${payload.orekit.head ?? "(no git)"}\n`,
  );
}

await main();
