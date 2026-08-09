#!/usr/bin/env node
/**
 * TIER A DUMPER — mechanical extraction of Tudat's own Lambert unit-test
 * vectors.
 *
 * THE RULE THIS SCRIPT EXISTS TO ENFORCE: a reference number is never retyped.
 * Every value in the emitted file is read out of the Tudat source, parsed, and
 * evaluated here; nothing in this file contains a hand-copied expected value.
 * If a human wants to change a vector, the only way is to change Tudat.
 *
 * TUDAT IS AN ORACLE, NOT A DEPENDENCY. This script reads `.cpp` TEXT. It never
 * compiles Tudat, never links it, and never becomes part of any build. The
 * emitted JSON is the artifact; the checkout is only needed when regenerating.
 *
 * WHAT IS MECHANICAL AND WHAT IS NOT — stated plainly, because "mechanical" is
 * a claim about provenance and a vague claim is worth nothing:
 *
 *   MECHANICAL: every numeric literal, every arithmetic expression, every
 *   `Eigen::Vector3d` triple, every tolerance, and the unit conversions
 *   (`convertAstronomicalUnitsToMeters`, `convertJulianDaysToSeconds`,
 *   `convertDegreesToRadians`) whose factors are themselves read out of Tudat's
 *   `physicalConstants.h` / `unitConversions.h`.
 *
 *   DECLARED (metadata, in `CASE_BINDINGS` below): which extracted symbol plays
 *   which role — that `positionAtDepartureHyperbola` is the `r1` of the
 *   `solveLambert` call and `expectedInertialVelocityAtDeparture` is its `v1`.
 *   A parser cannot infer intent; a reviewer can check a binding in one glance
 *   against the source line it names. No NUMBER lives in a binding.
 *
 * Usage:
 *   node dump-tudat-vectors.mjs [--tudat <mission_segments dir>] [--out <file>]
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(HERE, "..", "tudat-extract.json");

/** Where a tudat checkout may live. First hit wins; none = loud failure. */
const TUDAT_CANDIDATES = [
  path.join(os.homedir(), "software", "worktrees", "tudat-wasm"),
  path.join(HERE, "..", "..", "..", "..", "..", "ancillary-packages", "tudat-wasm"),
];

const MISSION_SEGMENTS = path.join(
  "tests",
  "test_tudat",
  "src",
  "astro",
  "mission_segments",
);

// ---------------------------------------------------------------------------
// A very small C++-expression evaluator
// ---------------------------------------------------------------------------

/**
 * Tokenise a C++ arithmetic expression.
 *
 * Deliberately tiny: the declarations these tests use are literals, named
 * constants, `*`/`/`/`+`/`-`, parentheses, and a handful of conversion calls.
 * Anything outside that grammar throws — an evaluator that silently returns a
 * plausible number for input it did not understand is how a wrong vector gets
 * frozen into a file that then certifies a wrong module.
 */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!match) throw new Error(`bad numeric literal at ${src.slice(i, i + 20)}`);
      tokens.push({ kind: "num", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      tokens.push({ kind: "ident", value: match[0] });
      i += match[0].length;
      continue;
    }
    if ("+-*/(),".includes(ch)) {
      tokens.push({ kind: ch });
      i += 1;
      continue;
    }
    throw new Error(`unsupported character ${JSON.stringify(ch)} in expression: ${src}`);
  }
  return tokens;
}

/** Recursive-descent evaluation of the token stream against `env`. */
function evaluate(src, env, fns) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (kind) => {
    const token = tokens[pos];
    if (!token || (kind && token.kind !== kind)) {
      throw new Error(`expected ${kind} at token ${pos} of: ${src}`);
    }
    pos += 1;
    return token;
  };

  function primary() {
    const token = peek();
    if (!token) throw new Error(`unexpected end of expression: ${src}`);
    if (token.kind === "num") {
      pos += 1;
      return token.value;
    }
    if (token.kind === "-") {
      pos += 1;
      return -primary();
    }
    if (token.kind === "+") {
      pos += 1;
      return primary();
    }
    if (token.kind === "(") {
      pos += 1;
      const value = expression();
      take(")");
      return value;
    }
    if (token.kind === "ident") {
      pos += 1;
      if (peek()?.kind === "(") {
        pos += 1;
        const args = [];
        if (peek()?.kind !== ")") {
          args.push(expression());
          while (peek()?.kind === ",") {
            pos += 1;
            args.push(expression());
          }
        }
        take(")");
        const fn = fns[token.value];
        if (!fn) throw new Error(`unknown function ${token.value}() in: ${src}`);
        return fn(...args);
      }
      if (!(token.value in env)) {
        throw new Error(`unbound identifier ${token.value} in: ${src}`);
      }
      return env[token.value];
    }
    throw new Error(`unexpected token ${token.kind} in: ${src}`);
  }

  function term() {
    let value = primary();
    for (;;) {
      const token = peek();
      if (token?.kind === "*") {
        pos += 1;
        value *= primary();
      } else if (token?.kind === "/") {
        pos += 1;
        value /= primary();
      } else {
        return value;
      }
    }
  }

  function expression() {
    let value = term();
    for (;;) {
      const token = peek();
      if (token?.kind === "+") {
        pos += 1;
        value += term();
      } else if (token?.kind === "-") {
        pos += 1;
        value -= term();
      } else {
        return value;
      }
    }
  }

  const result = expression();
  if (pos !== tokens.length) {
    throw new Error(`trailing tokens in expression: ${src}`);
  }
  if (!Number.isFinite(result)) {
    throw new Error(`expression did not evaluate to a finite number: ${src}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Unit-conversion factors — themselves extracted, never typed
// ---------------------------------------------------------------------------

/**
 * Read a `constexpr`/`const` double out of a Tudat header by name.
 *
 * The conversions the Lambert tests apply (AU→m, Julian days→s, deg→rad) are
 * the one place a dumper is tempted to hardcode "149597870700.0" and call it
 * mechanical. It would not be: a stale factor silently rescales every
 * position in the file. So the factors come out of the same tree as the tests.
 */
async function readNamedConstant(file, name, fns) {
  const text = await readFile(file, "utf8");
  const pattern = new RegExp(`\\b${name}\\s*=\\s*([^;]+);`, "gm");
  const candidates = [...stripComments(text).matchAll(pattern)].map((m) =>
    // Tudat writes long-double literals with an `L` suffix; the digits are the
    // value and the suffix is a storage class, so it is dropped, not parsed.
    m[1].trim().replace(/([0-9])[Ll]\b/g, "$1"),
  );
  if (candidates.length === 0) {
    throw new Error(`constant ${name} not found in ${file}`);
  }
  // A header may define the same constant twice behind a preprocessor branch
  // (`#ifdef M_PI` / `#else` in mathematicalConstants.h). Take the branch this
  // grammar can evaluate WITHOUT inventing a binding for a compiler-provided
  // macro, and require every evaluable branch to agree bit-for-bit — a header
  // whose branches disagree is a finding, not something to pick from.
  const evaluated = [];
  for (const expression of candidates) {
    try {
      evaluated.push({ expression, value: evaluate(expression, {}, fns) });
    } catch {
      /* a branch naming a compiler macro is not evaluable here — skip it */
    }
  }
  if (evaluated.length === 0) {
    throw new Error(
      `constant ${name} in ${file} has no branch this dumper can evaluate: ` +
        candidates.join(" | "),
    );
  }
  const [first, ...rest] = evaluated;
  for (const other of rest) {
    if (other.value !== first.value) {
      throw new Error(
        `constant ${name} in ${file} has disagreeing definitions: ` +
          `${first.expression} = ${first.value} vs ${other.expression} = ${other.value}`,
      );
    }
  }
  return { expression: first.expression, source: file };
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

// ---------------------------------------------------------------------------
// Declaration scanner
// ---------------------------------------------------------------------------

/**
 * Pull `{ name -> expression }` for every scalar and 3-vector declaration in a
 * test-case body, in source order, and evaluate each against the accumulating
 * environment. Order matters: `expectedValueOfSemiMajorAxisEllipse = 5.4214 *
 * distanceUnit` is only meaningful after `distanceUnit` is bound.
 */
function scanCaseBody(body, fns) {
  const env = {};
  const vectors = {};
  const trace = [];
  const clean = stripComments(body);

  // Declarations are scanned with a BALANCED-PAREN reader, not a regex.
  // `Eigen::Vector3d p( convertAstronomicalUnitsToMeters( 0.02 ), 0.0, 0.0 )`
  // defeats every non-recursive pattern: a lazy `[^;]*?` stops at the inner
  // `)` and yields an unbalanced expression that then evaluates to something
  // plausible and wrong. A reader that counts depth cannot make that mistake.
  const hits = scanDeclarations(clean);

  for (const hit of hits) {
    try {
      if (hit.kind === "scalar") {
        if (hit.name in env) continue;
        env[hit.name] = evaluate(hit.expr, env, fns);
        trace.push({ name: hit.name, expression: hit.expr, value: env[hit.name] });
      } else {
        if (hit.name in vectors) continue;
        const parts = splitTopLevel(hit.expr);
        if (parts.length !== 3) continue;
        const value = parts.map((part) => evaluate(part, env, fns));
        vectors[hit.name] = value;
        trace.push({ name: hit.name, expression: hit.expr, value });
      }
    } catch {
      // A declaration this grammar does not cover (an Eigen matrix, a
      // constructor call) is SKIPPED, never guessed. If a binding later names
      // it, the binding resolution fails loudly — which is the correct
      // outcome, and is why nothing here swallows a binding error.
    }
  }

  // Keplerian `<<` comma-initialisers: `state << e0, e1, ..., e5;`
  const kepler = {};
  for (const m of clean.matchAll(
    /([A-Za-z_][A-Za-z0-9_]*)\s*<<\s*([^;]+);/g,
  )) {
    try {
      kepler[m[1]] = splitTopLevel(m[2]).map((part) => evaluate(part, env, fns));
    } catch {
      /* not an arithmetic comma-initialiser — skip */
    }
  }

  return { env, vectors, kepler, trace };
}

/**
 * Read every `double` / `Eigen::Vector3d` declarator in source order.
 *
 * Handles the two forms these tests use and their comma-continued lists:
 *
 *   double a = <expr>, b = <expr>;
 *   const Eigen::Vector3d p( <expr>, <expr>, <expr> ), q( ... );
 *
 * Returns `{index, kind, name, expr}` records; `expr` for a vector is the
 * WHOLE balanced argument list, split into components by the caller.
 */
function scanDeclarations(text) {
  const hits = [];
  const declKeyword = /\b(double|Eigen::Vector3d)\s+/g;
  for (const keyword of text.matchAll(declKeyword)) {
    const kind = keyword[1] === "double" ? "scalar" : "vector";
    let i = keyword.index + keyword[0].length;

    // Walk the comma-separated declarator list to the terminating `;`.
    for (;;) {
      const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
      if (!nameMatch) break;
      const name = nameMatch[1];
      i += nameMatch[0].length;

      const rest = text.slice(i);
      const opener = /^\s*([=(])/.exec(rest);
      if (!opener) break;
      i += opener[0].length;

      let expr;
      if (opener[1] === "(") {
        // Balanced read to the matching `)`.
        let depth = 1;
        let j = i;
        while (j < text.length && depth > 0) {
          if (text[j] === "(") depth += 1;
          else if (text[j] === ")") depth -= 1;
          j += 1;
        }
        if (depth !== 0) break;
        expr = text.slice(i, j - 1).trim();
        i = j;
      } else {
        // Read to the next top-level `,` or `;`.
        let depth = 0;
        let j = i;
        while (j < text.length) {
          const ch = text[j];
          if (ch === "(") depth += 1;
          else if (ch === ")") depth -= 1;
          else if (depth === 0 && (ch === "," || ch === ";")) break;
          j += 1;
        }
        expr = text.slice(i, j).trim();
        i = j;
      }

      hits.push({ index: keyword.index, kind, name, expr });

      const separator = /^\s*([,;])/.exec(text.slice(i));
      if (!separator || separator[1] === ";") break;
      i += separator[0].length;
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(src) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of src) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Split a file into `{ caseName -> body }` at BOOST_AUTO_TEST_CASE braces. */
function splitTestCases(text) {
  const cases = new Map();
  const re = /BOOST_AUTO_TEST_CASE\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
  for (const match of text.matchAll(re)) {
    const open = text.indexOf("{", match.index + match[0].length);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    cases.set(match[1], text.slice(open + 1, end));
  }
  return cases;
}

// ---------------------------------------------------------------------------
// BINDINGS — the only hand-written part, and it holds no numbers
// ---------------------------------------------------------------------------

/**
 * `file :: testCase -> role -> extracted symbol name`.
 *
 * Every right-hand side is a SYMBOL, never a value. Review this table against
 * the named source and you have reviewed the provenance of every Tier-A vector.
 */
const CASE_BINDINGS = [
  {
    id: "tudat-izzo-hyperbolic",
    file: "unitTestLambertTargeterIzzo.cpp",
    testCase: "testHyperbolicCase",
    retrograde: false,
    bind: {
      r1: { vector: "positionAtDepartureHyperbola" },
      r2: { vector: "positionAtArrivalHyperbola" },
      tof: { scalar: "timeOfFlightHyperbola" },
      mu: { scalar: "earthGravitationalParameter" },
      v1: { vector: "expectedInertialVelocityAtDeparture" },
      v2: { vector: "expectedInertialVelocityAtArrival" },
      semiMajorAxis: { scalar: "expectedValueOfSemiMajorAxisHyperbola" },
      toleranceVelocity: { scalar: "toleranceVelocity" },
    },
    note:
      "Hyperbolic Earth-centred arc, 100-day time of flight. Tudat's own note: results from the Noomen Lambert-targeter Excel reference. Departure/arrival positions are AU-scaled on the x and -y axes.",
  },
  {
    id: "tudat-izzo-elliptical",
    file: "unitTestLambertTargeterIzzo.cpp",
    testCase: "testEllipticalCase",
    retrograde: false,
    bind: {
      r1: { vector: "positionAtDepartureEllipse" },
      r2: { vector: "positionAtArrivalEllipse" },
      tof: { scalar: "timeOfFlightEllipse" },
      mu: { scalar: "earthGravitationalParameter" },
      v1: { vector: "expectedInertialVelocityAtDeparture" },
      v2: { vector: "expectedInertialVelocityAtArrival" },
      semiMajorAxis: { scalar: "expectedValueOfSemiMajorAxisEllipse" },
      toleranceVelocity: { scalar: "toleranceVelocity" },
    },
    note:
      "Elliptical case in Earth canonical units. Tudat's own note: Mengali & Quarta, Fondamenti di Meccanica del volo Spaziale, Example 6.1, pages 159-162. The 120-degree transfer angle is what makes it a real Lambert case rather than a Hohmann in disguise.",
  },
  {
    id: "tudat-izzo-retrograde",
    file: "unitTestLambertTargeterIzzo.cpp",
    testCase: "testRetrograde",
    retrograde: true,
    bind: {
      r1: { vector: "positionAtDeparture" },
      r2: { vector: "positionAtArrival" },
      tof: { scalar: "timeOfFlight" },
      mu: { scalar: "solarGravitationalParameter" },
      v1: { vector: "expectedInitialVelocity" },
      v2: { vector: "expectedFinalVelocity" },
      toleranceVelocity: { scalar: "tolerance" },
    },
    note:
      "RETROGRADE heliocentric Earth-Mars transfer, 300 days. This is the highest-authority row in the tier: Tudat quotes departure and arrival velocities to 15 significant figures against ESA/ACT's Keplerian_Toolbox and gates itself at 1e-9. It is also the ONLY case that exercises the solver's retrograde branch.",
  },
  {
    id: "tudat-izzo-near-pi",
    file: "unitTestLambertTargeterIzzo.cpp",
    testCase: "testNearPi",
    retrograde: false,
    bind: {
      r1: { kepler: "keplerianStateAtDeparture" },
      r2: { kepler: "keplerianStateAtArrival" },
      tof: { scalar: "timeOfFlight" },
      mu: { scalar: "solarGravitationalParameter" },
      v1: { vector: "expectedInitialVelocity" },
      v2: { vector: "expectedFinalVelocity" },
      toleranceVelocity: { scalar: "tolerance" },
    },
    note:
      "NEAR-PI transfer (179.999 degrees), the classic Lambert singularity: the transfer plane is barely determined and a solver that normalises a near-zero cross product loses the orbit entirely. Positions are stated in Tudat as circular equatorial Keplerian elements and converted below by the closed form for e=0, i=0, raan=0, argp=0 — r = a*(cos(nu), sin(nu), 0) — which is exact, not an approximation.",
  },
];

/**
 * Keplerian -> Cartesian POSITION for the restricted case the near-pi test
 * uses: `e = 0, i = 0, raan = 0, argp = 0`. For that element set the general
 * conversion collapses to `r = a * (cos(nu), sin(nu), 0)` with no
 * approximation, so the extraction stays exact.
 *
 * The restriction is ASSERTED, not assumed: a non-zero element throws rather
 * than silently producing a position from a formula that no longer applies.
 */
function positionFromCircularEquatorialKepler(elements, label) {
  const [a, e, inc, raan, argp, nu] = elements;
  for (const [name, value] of [
    ["eccentricity", e],
    ["inclination", inc],
    ["raan", raan],
    ["argumentOfPeriapsis", argp],
  ]) {
    if (Math.abs(value) > 0) {
      throw new Error(
        `${label}: the circular-equatorial closed form requires ${name} = 0, got ${value}. ` +
          "Extend the dumper with the general conversion rather than letting this through.",
      );
    }
  }
  return [a * Math.cos(nu), a * Math.sin(nu), 0];
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, tudat: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") options.out = path.resolve(argv[++i]);
    else if (argv[i] === "--tudat") options.tudat = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return options;
}

function resolveTudatRoot(explicit) {
  const candidates = explicit ? [explicit] : TUDAT_CANDIDATES;
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, MISSION_SEGMENTS))) return candidate;
  }
  throw new Error(
    "no tudat checkout found. Tudat is an ORACLE, not a build dependency: this " +
      "script only READS its unit-test sources, and the emitted JSON is what the " +
      "harness consumes. Pass --tudat <checkout>. Tried:\n  " +
      candidates.join("\n  "),
  );
}

function gitHead(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tudatRoot = resolveTudatRoot(options.tudat);
  const segmentsDir = path.join(tudatRoot, MISSION_SEGMENTS);

  // Conversion factors, extracted from the same tree as the tests.
  const includeRoot = path.join(tudatRoot, "include", "tudat");
  const physicalConstants = path.join(includeRoot, "astro", "basic_astro", "physicalConstants.h");
  const mathConstants = path.join(includeRoot, "math", "basic", "mathematicalConstants.h");

  const baseFns = { sqrt: Math.sqrt };
  const auConst = await readNamedConstant(physicalConstants, "ASTRONOMICAL_UNIT", baseFns);
  const dayConst = await readNamedConstant(physicalConstants, "JULIAN_DAY", baseFns);
  const piConst = await readNamedConstant(mathConstants, "PI", baseFns);

  const AU = evaluate(auConst.expression, {}, baseFns);
  const JULIAN_DAY = evaluate(dayConst.expression, {}, baseFns);
  const PI = evaluate(piConst.expression, {}, baseFns);
  if (PI !== Math.PI) {
    throw new Error(
      `extracted PI (${PI}) is not the IEEE-754 double Math.PI (${Math.PI}); ` +
        "the degree conversion would then differ from the C++ one by ULPs.",
    );
  }

  const fns = {
    sqrt: Math.sqrt,
    convertAstronomicalUnitsToMeters: (value) => value * AU,
    convertJulianDaysToSeconds: (value) => value * JULIAN_DAY,
    convertDegreesToRadians: (value) => (value * PI) / 180,
  };

  const sources = new Map();
  const extracted = [];

  for (const binding of CASE_BINDINGS) {
    const file = path.join(segmentsDir, binding.file);
    if (!sources.has(file)) {
      sources.set(file, splitTestCases(stripComments(await readFile(file, "utf8"))));
    }
    const body = sources.get(file).get(binding.testCase);
    if (!body) {
      throw new Error(`${binding.file}: test case ${binding.testCase} not found`);
    }
    const scanned = scanCaseBody(body, fns);

    const resolve = (role, spec) => {
      if (spec.scalar !== undefined) {
        if (!(spec.scalar in scanned.env)) {
          throw new Error(
            `${binding.id}: scalar ${spec.scalar} not extracted for role ${role}`,
          );
        }
        return scanned.env[spec.scalar];
      }
      if (spec.vector !== undefined) {
        if (!(spec.vector in scanned.vectors)) {
          throw new Error(
            `${binding.id}: vector ${spec.vector} not extracted for role ${role}`,
          );
        }
        return scanned.vectors[spec.vector];
      }
      if (spec.kepler !== undefined) {
        const elements = scanned.kepler[spec.kepler];
        if (!elements || elements.length !== 6) {
          throw new Error(
            `${binding.id}: keplerian ${spec.kepler} not extracted for role ${role}`,
          );
        }
        return positionFromCircularEquatorialKepler(
          elements,
          `${binding.id}/${spec.kepler}`,
        );
      }
      throw new Error(`${binding.id}: binding for ${role} names no symbol`);
    };

    const values = {};
    const symbols = {};
    for (const [role, spec] of Object.entries(binding.bind)) {
      values[role] = resolve(role, spec);
      symbols[role] = spec.scalar ?? spec.vector ?? spec.kepler;
    }

    extracted.push({
      id: binding.id,
      source: {
        repo: "tudat",
        head: gitHead(tudatRoot),
        file: path.join(MISSION_SEGMENTS, binding.file),
        testCase: binding.testCase,
        symbols,
      },
      retrograde: binding.retrograde,
      note: binding.note,
      values,
      /** Full symbol trace: what the scanner saw, so a reviewer can audit it. */
      trace: scanned.trace,
    });
  }

  const payload = {
    "//":
      "MECHANICALLY EXTRACTED from Tudat unit-test sources by " +
      "vectors/tools/dump-tudat-vectors.mjs. Do not hand-edit: regenerate. " +
      "Tudat is consulted as an ORACLE — it is never compiled, linked, or " +
      "depended on by any build in this repo.",
    generator: "vectors/tools/dump-tudat-vectors.mjs",
    tudat: { root: tudatRoot, head: gitHead(tudatRoot) },
    conversions: {
      ASTRONOMICAL_UNIT: { value: AU, ...auConst },
      JULIAN_DAY: { value: JULIAN_DAY, ...dayConst },
      PI: { value: PI, ...piConst },
    },
    cases: extracted,
  };

  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stderr.write(
    `dump-tudat-vectors: ${extracted.length} cases -> ${options.out}\n`,
  );
}

await main();
