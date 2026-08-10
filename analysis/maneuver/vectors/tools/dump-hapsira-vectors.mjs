#!/usr/bin/env node
/**
 * TIER D DUMPER (1 of 2) — mechanical extraction of hapsira's OWN maneuver and
 * Lambert unit-test vectors.
 *
 * hapsira is the maintained fork of poliastro (MIT, and the LICENSE text is
 * read out of the checkout and recorded in the emitted file rather than
 * asserted from memory). Its `tests/test_iod.py` and `tests/test_maneuver.py`
 * carry, with their upstream attributions in the test names themselves, the
 * canonical Lambert and two-burn cases: Vallado example 7-5, Curtis examples
 * 5.2 and 5.3, Der's Molniya case in both the zero-revolution and the
 * ONE-REVOLUTION (two-branch) form, Vallado examples 6-1 and 6-2, and two
 * geometries the library REFUSES.
 *
 * THE RULE THIS SCRIPT ENFORCES, same as the tudat dumper it is modelled on: a
 * reference number is never retyped. Every value in the emitted file is read
 * out of the hapsira source, parsed, and evaluated here. The only way to change
 * a vector is to change hapsira.
 *
 * HAPSIRA IS AN ORACLE, NOT A DEPENDENCY. This script reads `.py` TEXT. Python
 * is never executed, hapsira is never imported, and it is not a dependency of
 * any build in this repo. The emitted JSON is the artifact; the checkout is
 * only needed when regenerating.
 *
 * WHAT IS MECHANICAL AND WHAT IS DECLARED
 * ---------------------------------------
 *   MECHANICAL: every numeric literal, every list, every astropy unit
 *   multiplication (`* u.km`, `* (u.km / u.s)`, `* u.min`), every `rtol=` /
 *   `atol=` in the test's own assertions, the total-cost figures embedded in
 *   the expected `repr()` STRINGS, and the two Earth constants — `GM_earth` and
 *   `R_earth` — which are read out of `src/hapsira/constants/general.py`
 *   because retyping them here would silently rescale every radius in the file.
 *
 *   DECLARED (`CASE_BINDINGS`, below): which extracted symbol plays which role.
 *   A parser cannot infer that `expected_va` is the departure velocity of the
 *   `solveLambert` call; a reviewer can check that in one glance against the
 *   named source line. NO NUMBER LIVES IN A BINDING.
 *
 *   DERIVED, and labelled as such in the emitted file: two things only.
 *   (1) The prograde/retrograde flag, which hapsira's Izzo solver does not take
 *       as an argument — it selects the short way in the plane of r1 x r2 — so
 *       it is computed here as the SIGN of (r1 x r2)_z and emitted as a boolean
 *       with the sign recorded. (2) For the eccentric-departure Hohmann and
 *       bi-elliptic rows, the periapsis radius and periapsis SPEED of the state
 *       hapsira's test constructs, because our module's JSON surface takes a
 *       scalar radius where hapsira takes a state vector. Those are INPUTS
 *       computed from hapsira's own inputs by the standard closed form; the
 *       EXPECTED numbers remain hapsira's.
 *
 * Usage:
 *   node dump-hapsira-vectors.mjs [--hapsira <checkout>] [--out <file>]
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(HERE, "..", "hapsira-extract.json");

/** Where a hapsira checkout may live. First hit wins; none = loud failure. */
const HAPSIRA_CANDIDATES = [
  process.env.HAPSIRA_ROOT,
  path.join(os.homedir(), "software", "upstream", "hapsira"),
  path.join(os.homedir(), "software", "worktrees", "hapsira"),
].filter(Boolean);

// ---------------------------------------------------------------------------
// A very small Python-expression evaluator, unit-aware
// ---------------------------------------------------------------------------

/**
 * A quantity is a value (scalar or 3-list) with an astropy-style dimension and
 * the factor that takes it to SI.
 *
 * Carrying the DIMENSION rather than a bare scale factor is what makes the
 * conversion checkable: `toSI(q, "L")` refuses a quantity that is a velocity,
 * so a binding that reads `expected_va` into an `r1` slot fails at extraction
 * time instead of producing a vector that is wrong by a factor of the orbital
 * speed.
 */
const UNITS = {
  "u.m": { scale: 1, dim: "L" },
  "u.km": { scale: 1000, dim: "L" },
  "u.s": { scale: 1, dim: "T" },
  "u.min": { scale: 60, dim: "T" },
  "u.h": { scale: 3600, dim: "T" },
  "u.hour": { scale: 3600, dim: "T" },
  "u.day": { scale: 86400, dim: "T" },
  "u.deg": { scale: Math.PI / 180, dim: "" },
  "u.rad": { scale: 1, dim: "" },
  "u.one": { scale: 1, dim: "" },
};

/** Dimension arithmetic on the tiny {L,T} lattice these tests need. */
function dimMul(a, b) {
  const key = [a, b].sort().join("*");
  const table = {
    "*": "",
    "*L": "L",
    "*T": "T",
    "*L/T": "L/T",
    "L*L": "L^2",
    "L*T": "L*T",
    "L/T*T": "L",
  };
  if (a === "") return b;
  if (b === "") return a;
  const hit = table[key];
  if (hit === undefined) throw new Error(`unsupported dimension product ${a} * ${b}`);
  return hit;
}

function dimDiv(a, b) {
  if (b === "") return a;
  if (a === b) return "";
  if (a === "L" && b === "T") return "L/T";
  if (a === "L^3" && b === "T^2") return "L^3/T^2";
  throw new Error(`unsupported dimension quotient ${a} / ${b}`);
}

const quantity = (value, scale, dim) => ({ value, scale, dim });
const isQuantity = (x) => x !== null && typeof x === "object" && "scale" in x;

function mapValue(value, fn) {
  return Array.isArray(value) ? value.map(fn) : fn(value);
}

function mulQ(a, b) {
  if (Array.isArray(a.value) && Array.isArray(b.value)) {
    throw new Error("refusing to multiply two vectors — the grammar has no meaning for it");
  }
  const scalarSide = Array.isArray(a.value) ? b : a;
  const vectorSide = Array.isArray(a.value) ? a : b;
  return quantity(
    mapValue(vectorSide.value, (component) => component * scalarSide.value),
    a.scale * b.scale,
    dimMul(a.dim, b.dim),
  );
}

function divQ(a, b) {
  if (Array.isArray(b.value)) throw new Error("refusing to divide by a vector");
  return quantity(
    mapValue(a.value, (component) => component / b.value),
    a.scale / b.scale,
    dimDiv(a.dim, b.dim),
  );
}

/**
 * Tokenise a Python expression.
 *
 * Deliberately tiny: literals, lists, `np.array(...)`, dotted names, the four
 * arithmetic operators, and parentheses. Anything outside that grammar throws.
 * An evaluator that silently returns a plausible number for input it did not
 * understand is exactly how a wrong vector gets frozen into a file that then
 * certifies a wrong module.
 */
function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (!match) throw new Error(`bad numeric literal at ${source.slice(index, index + 24)}`);
      tokens.push({ kind: "num", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(
        source.slice(index),
      );
      tokens.push({ kind: "name", value: match[0] });
      index += match[0].length;
      continue;
    }
    if ("+-*/(),[]".includes(character)) {
      tokens.push({ kind: character });
      index += 1;
      continue;
    }
    throw new Error(`unsupported character ${JSON.stringify(character)} in: ${source}`);
  }
  return tokens;
}

/** Recursive-descent evaluation of a Python expression against `environment`. */
function evaluatePython(source, environment) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const take = (kind) => {
    const token = tokens[position];
    if (!token || (kind && token.kind !== kind)) {
      throw new Error(`expected ${kind} at token ${position} of: ${source}`);
    }
    position += 1;
    return token;
  };

  function primary() {
    const token = peek();
    if (!token) throw new Error(`unexpected end of expression: ${source}`);
    if (token.kind === "num") {
      take("num");
      return quantity(token.value, 1, "");
    }
    if (token.kind === "-") {
      take("-");
      const operand = primary();
      return quantity(mapValue(operand.value, (v) => -v), operand.scale, operand.dim);
    }
    if (token.kind === "[") {
      take("[");
      const items = [];
      while (peek() && peek().kind !== "]") {
        const item = expression();
        if (item.dim !== "" || item.scale !== 1) {
          throw new Error("list elements must be bare numbers in these tests");
        }
        if (Array.isArray(item.value)) throw new Error("nested lists are not supported");
        items.push(item.value);
        if (peek() && peek().kind === ",") take(",");
      }
      take("]");
      return quantity(items, 1, "");
    }
    if (token.kind === "(") {
      take("(");
      const inner = expression();
      take(")");
      return inner;
    }
    if (token.kind === "name") {
      take("name");
      if (token.value === "np.array" || token.value === "numpy.array") {
        take("(");
        const inner = expression();
        take(")");
        return inner;
      }
      if (UNITS[token.value]) {
        const unit = UNITS[token.value];
        return quantity(1, unit.scale, unit.dim);
      }
      if (Object.hasOwn(environment, token.value)) {
        return environment[token.value];
      }
      throw new Error(`unbound name ${token.value} in: ${source}`);
    }
    throw new Error(`unexpected token ${token.kind} in: ${source}`);
  }

  function term() {
    let left = primary();
    while (peek() && (peek().kind === "*" || peek().kind === "/")) {
      const operator = take().kind;
      const right = primary();
      left = operator === "*" ? mulQ(left, right) : divQ(left, right);
    }
    return left;
  }

  function expression() {
    let left = term();
    while (peek() && (peek().kind === "+" || peek().kind === "-")) {
      const operator = take().kind;
      const right = term();
      if (left.dim !== right.dim) {
        throw new Error(`refusing to add ${left.dim} to ${right.dim} in: ${source}`);
      }
      const leftSI = mapValue(left.value, (v) => v * left.scale);
      const rightSI = mapValue(right.value, (v) => v * right.scale);
      const combine = (a, b) => (operator === "+" ? a + b : a - b);
      const value = Array.isArray(leftSI)
        ? leftSI.map((component, axis) => combine(component, rightSI[axis]))
        : combine(leftSI, rightSI);
      left = quantity(value, 1, left.dim);
    }
    return left;
  }

  const result = expression();
  if (position !== tokens.length) {
    throw new Error(`trailing tokens in: ${source}`);
  }
  return result;
}

/** Convert an extracted quantity to SI, ASSERTING its dimension. */
function toSI(q, expectedDim, what) {
  if (!isQuantity(q)) throw new Error(`${what}: not a quantity`);
  if (q.dim !== expectedDim) {
    throw new Error(
      `${what}: expected dimension ${expectedDim || "dimensionless"} but the ` +
        `source gives ${q.dim || "dimensionless"} — a binding is pointing at the wrong symbol`,
    );
  }
  return mapValue(q.value, (component) => component * q.scale);
}

// ---------------------------------------------------------------------------
// Python source reading
// ---------------------------------------------------------------------------

/**
 * Slice out the body of `def <name>(` by INDENTATION, the way Python itself
 * delimits it. Brace matching would be wrong here and a fixed line count would
 * rot on the first upstream edit.
 */
function functionBody(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^def\\s+${name}\\s*\\(`).test(line));
  if (start < 0) throw new Error(`hapsira source has no function ${name}`);
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      body.push(line);
      continue;
    }
    if (!/^\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * Join a block's physical lines into logical ones, so a list that wraps across
 * three source lines is still one assignment.
 */
function logicalLines(block) {
  const out = [];
  let buffer = "";
  let depth = 0;
  for (const line of block.split("\n")) {
    const stripped = line.replace(/#.*$/, "");
    buffer = buffer === "" ? stripped.trim() : `${buffer} ${stripped.trim()}`;
    for (const character of stripped) {
      if ("([".includes(character)) depth += 1;
      if (")]".includes(character)) depth -= 1;
    }
    if (depth <= 0) {
      if (buffer.trim() !== "") out.push(buffer.trim());
      buffer = "";
      depth = 0;
    }
  }
  if (buffer.trim() !== "") out.push(buffer.trim());
  return out;
}

/** Evaluate every simple `name = expr` assignment in a function body. */
function readAssignments(block, environment) {
  const bindings = { ...environment };
  for (const line of logicalLines(block)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    if (/^(==|=)/.test(match[2])) continue;
    try {
      bindings[match[1]] = evaluatePython(match[2], bindings);
    } catch {
      // Lines this grammar does not cover (Orbit constructors, pytest.raises)
      // are simply not bindings. Silence here is safe because every value the
      // emitted file uses is fetched BY NAME below and a missing name throws.
    }
  }
  return bindings;
}

/**
 * Read the tolerances the test itself states, keyed by the expected-value
 * symbol they guard.
 *
 * Taking the gate from the source rather than choosing one here is the point:
 * hapsira asserts `expected_va` at 1e-5 and `expected_vb` at 1e-4 in the same
 * test, and a single case-wide band would either over-assert one or
 * under-assert the other.
 */
function readTolerances(block) {
  const tolerances = {};
  for (const line of logicalLines(block)) {
    const match =
      /assert_(?:quantity_)?allclose\(\s*[A-Za-z_][A-Za-z0-9_.()]*\s*,\s*([A-Za-z_][A-Za-z0-9_]*)[^,)]*(?:,\s*(rtol|atol)\s*=\s*([0-9eE.+-]+))?/.exec(
        line,
      );
    if (!match) continue;
    const [, symbol, kind, value] = match;
    tolerances[symbol] = kind ? { kind, value: Number(value) } : { kind: "default", value: 1e-7 };
  }
  return tolerances;
}

/** Pull `Total cost: <number> km / s` out of an expected repr STRING literal. */
function readReprCost(block, symbol) {
  for (const line of logicalLines(block)) {
    if (!line.startsWith(`${symbol} =`)) continue;
    const match = /Total cost:\s*([0-9.]+)\s*km\s*\/\s*s/.exec(line);
    if (!match) throw new Error(`${symbol} does not carry a "Total cost: N km / s"`);
    const impulses = /Number of impulses:\s*([0-9]+)/.exec(line);
    return {
      totalDeltaV: Number(match[1]) * 1000,
      impulses: impulses ? Number(impulses[1]) : null,
      literal: line,
    };
  }
  throw new Error(`no assignment to ${symbol}`);
}

/** Read one `Constant("NAME", ..., value, unit, ...)` out of the constants module. */
function readConstant(source, name, filePath) {
  const pattern = new RegExp(
    `${name}\\s*=\\s*Constant\\(\\s*"${name}"\\s*,\\s*"[^"]*"\\s*,\\s*([0-9eE.+-]+)\\s*,\\s*"([^"]*)"`,
  );
  const match = pattern.exec(source);
  if (!match) throw new Error(`${filePath} has no Constant(${name})`);
  return { value: Number(match[1]), unit: match[2].trim(), source: filePath };
}

// ---------------------------------------------------------------------------
// Small vector helpers — used ONLY for derived INPUTS, never for expectations
// ---------------------------------------------------------------------------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Periapsis radius and periapsis SPEED of an inertial state.
 *
 * DERIVED INPUT, declared as such. hapsira's `Maneuver.hohmann` propagates the
 * orbit to periapsis and then departs from the state it finds there; our
 * module's JSON surface takes a scalar radius. This closes that gap on the
 * INPUT side with the textbook closed form, so the expected number stays
 * hapsira's.
 */
function periapsisState(position, velocity, mu) {
  const r = norm(position);
  const v = norm(velocity);
  const a = 1 / (2 / r - (v * v) / mu);
  const h = norm(cross(position, velocity));
  const eccentricity = Math.sqrt(Math.max(0, 1 - (h * h) / (mu * a)));
  const rp = a * (1 - eccentricity);
  return {
    semiMajorAxis: a,
    eccentricity,
    periapsisRadius: rp,
    periapsisSpeed: Math.sqrt(mu * (2 / rp - 1 / a)),
  };
}

// ---------------------------------------------------------------------------
// CASE BINDINGS — metadata only. Never a number.
// ---------------------------------------------------------------------------

const IOD_FILE = path.join("tests", "test_iod.py");
const MANEUVER_FILE = path.join("tests", "test_maneuver.py");

/**
 * Lambert cases: which symbol in which test function is which argument of
 * `solveLambert`, and which expected symbol is which returned velocity.
 *
 * `upstream` records the attribution the hapsira test itself carries — these
 * are not hapsira's own numbers either, they are Vallado's, Curtis's and Der's,
 * and saying so is the difference between one reference and three.
 */
const LAMBERT_BINDINGS = [
  {
    id: "hapsira-vallado-7-5",
    file: IOD_FILE,
    test: "test_vallado75",
    symbols: { r1: "r0", r2: "r", tof: "tof", v1: "expected_va", v2: "expected_vb" },
    nRevs: 0,
    upstream: "Vallado, Fundamentals of Astrodynamics and Applications, example 7-5",
    note:
      "Coplanar equatorial Lambert transfer over 76 minutes. hapsira runs it " +
      "through BOTH of its solvers (its Vallado universal-variable and its Izzo " +
      "implementation) against the same expected pair.",
  },
  {
    id: "hapsira-curtis-5-2",
    file: IOD_FILE,
    test: "test_curtis52",
    symbols: { r1: "r0", r2: "r", tof: "tof", v1: "expected_va", v2: "expected_vb" },
    nRevs: 0,
    upstream: "Curtis, Orbital Mechanics for Engineering Students, example 5.2",
    note:
      "A fully three-dimensional geometry — the only tier-D Lambert row whose " +
      "positions are not coplanar with an axis — so it is the row that catches a " +
      "solver whose plane handling is right only in the equatorial special case.",
  },
  {
    id: "hapsira-curtis-5-3",
    file: IOD_FILE,
    test: "test_curtis53",
    symbols: { r1: "r0", r2: "r", tof: "tof", v1: "expected_va" },
    nRevs: 0,
    upstream: "Curtis, example 5.3 (hapsira records an ERRATUM: the j component is positive)",
    note:
      "A 13.5-hour high-apogee arc. hapsira asserts the departure velocity only, " +
      "so this row does too — asserting an arrival velocity the source does not " +
      "state would be inventing a reference.",
  },
  {
    id: "hapsira-der-molniya-0rev",
    file: IOD_FILE,
    test: "test_molniya_der_zero_full_revolution",
    symbols: { r1: "r0", r2: "r", tof: "tof", v1: "expected_va", v2: "expected_vb" },
    nRevs: 0,
    upstream: 'Der, "Superior Lambert Algorithm" — Molniya geometry, zero full revolutions',
    note:
      "The SAME case Orekit carries in IodLambertTest.testIssue752, at a " +
      "different gravitational parameter (hapsira: GM_earth; Orekit: EGM96). Two " +
      "independent libraries, one upstream paper, two mu values — a row that " +
      "agrees with both is agreeing with the physics, not with a constant.",
  },
  {
    id: "hapsira-der-molniya-1rev-highpath",
    file: IOD_FILE,
    test: "test_molniya_der_one_full_revolution",
    symbols: { r1: "r0", r2: "r", tof: "tof", v1: "expected_va_l", v2: "expected_vb_l" },
    nRevs: 1,
    branch: "high-path (hapsira lowpath=False)",
    upstream: 'Der, "Superior Lambert Algorithm" — Molniya geometry, ONE full revolution',
    note:
      "MULTI-REVOLUTION. A one-revolution Lambert problem has TWO solutions, and " +
      "hapsira exposes the choice as `lowpath`. This row is the high-path branch.",
  },
  {
    id: "hapsira-der-molniya-1rev-lowpath",
    file: IOD_FILE,
    test: "test_molniya_der_one_full_revolution",
    symbols: { r1: "r0", r2: "r", tof: "tof", v1: "expected_va_r", v2: "expected_vb_r" },
    nRevs: 1,
    branch: "low-path (hapsira lowpath=True)",
    upstream: 'Der, "Superior Lambert Algorithm" — Molniya geometry, ONE full revolution',
    note:
      "The OTHER one-revolution branch of the identical geometry. Our module's " +
      "multi-revolution path scans the bounded interval and takes the FIRST sign " +
      "change, so it can return only one of these two arcs and the JSON surface " +
      "carries no way to ask for the other.",
  },
  {
    id: "hapsira-issue840-retrograde",
    file: IOD_FILE,
    test: "test_issue840",
    symbols: { r1: "r0", r2: "rf", tof: "tof", v1: "expected_va", v2: "expected_vb" },
    nRevs: 0,
    muSymbol: "k",
    upstream: "hapsira issue #840 — a geometry whose short way is RETROGRADE",
    note:
      "hapsira's own regression for a transfer whose angular momentum points " +
      "along -z: its Vallado solver has to be told `prograde=False` and its Izzo " +
      "solver infers it. The row exists because a solver that hardwires prograde " +
      "answers this one confidently and wrongly.",
  },
];

/** Geometries the LIBRARY refuses. A refusal is a result, and it is testable. */
const REFUSAL_BINDINGS = [
  {
    id: "hapsira-der-molniya-1rev-infeasible",
    file: IOD_FILE,
    test: "test_raises_exception_for_non_feasible_solution",
    symbols: { r1: "r0", r2: "r", tof: "tof" },
    nRevs: 1,
    upstreamMessage: "No feasible solution, try lower M",
    note:
      "NON-SOLUTION SCREENING. The Molniya geometry again, with the time of " +
      "flight cut to five hours: there is no ONE-revolution arc that flies it. " +
      "hapsira raises. The only wrong answer here is a velocity pair with " +
      "converged:true — which is precisely what 0.1.0 returned for 50 of 52 " +
      "routine LEO geometries (modules-maneuver-lambert-returns-non-solutions).",
  },
  {
    id: "hapsira-collinear-refusal",
    file: IOD_FILE,
    test: "test_collinear_vectors_input",
    symbols: { r1: "r0", r2: "r", tof: "tof" },
    nRevs: 0,
    upstreamMessage: "Lambert solution cannot be computed for collinear vectors",
    note:
      "DEGENERATE GEOMETRY. r1 and r2 are the same vector, so the transfer plane " +
      "is undefined. hapsira raises rather than picking a plane.",
  },
];

/** Two-burn transfers. */
const TRANSFER_BINDINGS = [
  {
    id: "hapsira-vallado-6-1-hohmann",
    file: MANEUVER_FILE,
    test: "test_hohmann_maneuver",
    operation: "hohmannTransfer",
    altitudes: { r1: "alt_i", r2: "alt_f" },
    symbols: { totalDeltaV: "expected_dv", tof: "expected_t_trans" },
    /**
     * hapsira asserts the transfer TIME through `expected_total_time`, which is
     * `expected_t_pericenter + expected_t_trans`. The test is parametrised over
     * `nu` and the `nu = 0` member has `t_pericenter = 0`, so on that member the
     * two are the same number and the stated tolerance is the one that guards
     * our `tof`. The dumper asserts the parametrisation carries `0` rather than
     * assuming it.
     */
    toleranceSymbols: { tof: "expected_total_time" },
    requiresZeroTrueAnomalyMember: true,
    upstream: "Vallado, example 6-1 — circular LEO to circular GEO",
    note:
      "The canonical Hohmann. Our tier B already reproduces Vallado's own " +
      "printed dv_a/dv_b/tau; this row is the same transfer as a THIRD party " +
      "states it, over hapsira's Earth radius rather than ours, which is what " +
      "makes it an independent check rather than a restatement.",
  },
  {
    id: "hapsira-vallado-6-2-bielliptic",
    file: MANEUVER_FILE,
    test: "test_bielliptic_maneuver",
    operation: "biEllipticTransfer",
    altitudes: { r1: "alt_i", rIntermediate: "alt_b", r2: "alt_f" },
    symbols: { totalDeltaV: "expected_dv", tof: "expected_t_trans" },
    toleranceSymbols: { tof: "expected_total_time" },
    requiresZeroTrueAnomalyMember: true,
    upstream: "Vallado, example 6-2 — bi-elliptic transfer via a 503873 km apoapsis",
    note:
      "THIS ROW SETTLES A DISCREPANCY THIS REPO RECORDED AND COULD NOT CLOSE. " +
      "vectors/PROVENANCE.md withdrew the published bi-elliptic anchor because " +
      "3.904057 km/s did not reproduce. It reproduces exactly here: the three " +
      "radii are ALTITUDES above hapsira's R_earth, and the total is the sum of " +
      "the burn MAGNITUDES — the third burn is a deceleration and enters the " +
      "total with its sign flipped.",
  },
];

/** The eccentric-departure rows — the Hohmann departure-speed defect, foreign-sourced. */
const ECCENTRIC_DEPARTURE_BINDINGS = [
  {
    id: "hapsira-eccentric-departure-hohmann",
    file: MANEUVER_FILE,
    test: "test_repr_maneuver",
    operation: "hohmannTransfer",
    stateSymbols: { position: "r", velocity: "v" },
    altitudes: { r2: "alt_f" },
    reprSymbol: "expected_hohmann_maneuver",
    upstream: "hapsira Maneuver.hohmann applied to an ECCENTRIC departure orbit",
    note:
      "hapsira departs from the orbit's actual periapsis STATE: " +
      "dv_a = sqrt(2k/r_i - k/a_trans) - v_i, with v_i the true periapsis speed. " +
      "Our computeHohmannTransfer assumes a CIRCULAR departure and the JSON " +
      "surface gives the caller no way to say otherwise — which is exactly " +
      "graph task modules-maneuver-hohmann-departure-speed.",
  },
  {
    id: "hapsira-eccentric-departure-bielliptic",
    file: MANEUVER_FILE,
    test: "test_repr_maneuver",
    operation: "biEllipticTransfer",
    stateSymbols: { position: "r", velocity: "v" },
    altitudes: { rIntermediate: "alt_b", r2: "alt_fi" },
    reprSymbol: "expected_bielliptic_maneuver",
    upstream: "hapsira Maneuver.bielliptic applied to an ECCENTRIC departure orbit",
    note:
      "The same defect seen through the three-burn transfer: computeBiElliptic" +
      "Transfer shares the circular-departure assumption with computeHohmann" +
      "Transfer, so the departure-speed parameter has to reach both.",
  },
];

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function resolveCheckout(explicit) {
  const candidates = explicit ? [explicit] : HAPSIRA_CANDIDATES;
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "src", "hapsira", "constants", "general.py"))) {
      return candidate;
    }
  }
  throw new Error(
    "no hapsira checkout found. Pass --hapsira <dir>, set HAPSIRA_ROOT, or clone:\n" +
      "  git clone --filter=blob:none --depth 1 https://github.com/pleiszenburg/hapsira.git " +
      "~/software/upstream/hapsira\n" +
      "hapsira is READ as text; it is never imported and never built.",
  );
}

function gitHead(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * prograde/retrograde, DERIVED — hapsira's Izzo solver takes no such flag.
 *
 * THE RULE IS TAKEN FROM THE PUBLISHED ANSWER, NOT FROM THE GEOMETRY, and the
 * difference is not academic. The first version of this dumper derived the flag
 * from the sign of `(r1 x r2)_z` — "the short way" — which is right for six of
 * the seven Lambert rows and WRONG for hapsira's own issue-840 regression,
 * where the published departure velocity is a PROGRADE arc sweeping 328 degrees
 * while the short way is retrograde. Deriving it from `(r1 x v1)_z` asks the
 * only question our `prograde` flag actually answers — which sense does the
 * published arc circulate in — and gets it right by construction on every row.
 *
 * It uses nothing but the source's own numbers. The module is never consulted.
 */
function progradeFromPublishedArc(r1, v1) {
  const momentumZ = cross(r1, v1)[2];
  if (momentumZ === 0) {
    throw new Error("the published departure velocity is radial: the sense is undefined");
  }
  return {
    prograde: momentumZ > 0,
    momentumZ,
    rule:
      "sign of (r1 x v1)_z on the PUBLISHED departure velocity — the sense the " +
      "source's own answer circulates in. hapsira's Izzo solver takes no prograde flag.",
  };
}

/** The short-way sense, for rows with no published velocity (the refusals). */
function progradeFromGeometry(r1, r2) {
  const momentumZ = cross(r1, r2)[2];
  return {
    prograde: momentumZ > 0,
    momentumZ,
    rule:
      "sign of (r1 x r2)_z — the short way. Used only where the source publishes " +
      "no velocity to read the sense from, i.e. the rows where it REFUSES.",
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const readFlag = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  const root = resolveCheckout(readFlag("--hapsira"));
  const outPath = readFlag("--out") ?? DEFAULT_OUT;

  const constantsPath = path.join("src", "hapsira", "constants", "general.py");
  const constantsSource = await readFile(path.join(root, constantsPath), "utf8");
  const gmEarth = readConstant(constantsSource, "GM_earth", constantsPath);
  const rEarth = readConstant(constantsSource, "R_earth", constantsPath);
  if (gmEarth.unit !== "m3 / (s2)") {
    throw new Error(`GM_earth is stated in ${gmEarth.unit}; this dumper assumes SI`);
  }
  if (rEarth.unit !== "m") {
    throw new Error(`R_earth is stated in ${rEarth.unit}; this dumper assumes metres`);
  }
  const MU = gmEarth.value;
  const RE = rEarth.value;

  const licenseText = await readFile(path.join(root, "LICENSE"), "utf8");
  const licenseFirstLine = licenseText.split("\n")[0].trim();
  if (!/MIT/i.test(licenseFirstLine)) {
    throw new Error(
      `hapsira's LICENSE no longer reads as MIT (first line: ${licenseFirstLine}). ` +
        "Lifting vectors is a licensing decision, not a technical one — stop and re-check.",
    );
  }

  const sources = new Map();
  const loadSource = async (relative) => {
    if (!sources.has(relative)) {
      sources.set(relative, await readFile(path.join(root, relative), "utf8"));
    }
    return sources.get(relative);
  };

  // Constants the tests reference by dotted name.
  const globalEnvironment = {
    "Earth.k": quantity(MU, 1, "L^3/T^2"),
    "Earth.R": quantity(RE, 1, "L"),
    "c.GM_earth": quantity(MU, 1, "L^3/T^2"),
    "c.GM_earth.to": quantity(MU, 1, "L^3/T^2"),
  };

  const cases = [];

  for (const binding of LAMBERT_BINDINGS) {
    const source = await loadSource(binding.file);
    const block = functionBody(source, binding.test);
    const bindings = readAssignments(block, globalEnvironment);
    const tolerances = readTolerances(block);
    const read = (symbol, dim) => {
      if (!Object.hasOwn(bindings, symbol)) {
        throw new Error(`${binding.test}: no binding for ${symbol}`);
      }
      return toSI(bindings[symbol], dim, `${binding.id}/${symbol}`);
    };

    const r1 = read(binding.symbols.r1, "L");
    const r2 = read(binding.symbols.r2, "L");
    const tof = read(binding.symbols.tof, "T");
    const values = { r1, r2, tof, mu: MU };
    const stated = {};
    for (const role of ["v1", "v2"]) {
      const symbol = binding.symbols[role];
      if (!symbol) continue;
      values[role] = read(symbol, "L/T");
      stated[role] = tolerances[symbol] ?? null;
      if (!stated[role]) {
        throw new Error(
          `${binding.test}: no assert_quantity_allclose tolerance found for ${symbol}. ` +
            "A vector with no stated gate is a vector we would have to invent a gate for.",
        );
      }
    }
    const geometry = progradeFromPublishedArc(r1, values.v1);

    cases.push({
      id: binding.id,
      kind: "lambert",
      operation: "solveLambert",
      source: {
        library: "hapsira",
        file: binding.file,
        testCase: binding.test,
        symbols: binding.symbols,
        upstream: binding.upstream,
        license: "MIT",
      },
      nRevs: binding.nRevs,
      branch: binding.branch ?? null,
      prograde: geometry.prograde,
      progradeDerivation: geometry,
      values,
      tolerances: stated,
      note: binding.note,
    });
  }

  for (const binding of REFUSAL_BINDINGS) {
    const source = await loadSource(binding.file);
    const block = functionBody(source, binding.test);
    const bindings = readAssignments(block, globalEnvironment);
    const read = (symbol, dim) => toSI(bindings[symbol], dim, `${binding.id}/${symbol}`);
    const r1 = read(binding.symbols.r1, "L");
    const r2 = read(binding.symbols.r2, "L");
    const tof = read(binding.symbols.tof, "T");
    const geometry = progradeFromGeometry(r1, r2);
    if (!block.includes(binding.upstreamMessage)) {
      throw new Error(
        `${binding.test} no longer asserts "${binding.upstreamMessage}" — the refusal ` +
          "this row records is not the refusal the library now makes",
      );
    }
    cases.push({
      id: binding.id,
      kind: "refusal",
      operation: "solveLambert",
      source: {
        library: "hapsira",
        file: binding.file,
        testCase: binding.test,
        symbols: binding.symbols,
        license: "MIT",
      },
      nRevs: binding.nRevs,
      prograde: geometry.prograde,
      progradeDerivation: geometry,
      values: { r1, r2, tof, mu: MU },
      upstreamMessage: binding.upstreamMessage,
      note: binding.note,
    });
  }

  for (const binding of TRANSFER_BINDINGS) {
    const source = await loadSource(binding.file);
    const block = functionBody(source, binding.test);
    const bindings = readAssignments(block, globalEnvironment);
    const tolerances = readTolerances(block);
    const values = { mu: MU };
    const radiiFrom = {};
    for (const [role, symbol] of Object.entries(binding.altitudes)) {
      const altitude = toSI(bindings[symbol], "L", `${binding.id}/${symbol}`);
      values[role] = RE + altitude;
      radiiFrom[role] = { altitudeSymbol: symbol, altitude, earthRadius: RE };
    }
    if (binding.requiresZeroTrueAnomalyMember) {
      const parametrised = /@pytest\.mark\.parametrize\(\s*"nu"\s*,\s*\[\s*0\s*,/.test(
        source.slice(0, source.indexOf(`def ${binding.test}(`)),
      );
      if (!parametrised) {
        throw new Error(
          `${binding.test} is no longer parametrised with nu = 0 as its first member. ` +
            "The transfer-time expectation is only equal to the total time on that " +
            "member (t_pericenter = 0); on any other it is not, and this row would " +
            "silently start asserting the wrong quantity.",
        );
      }
    }
    const expect = {};
    const stated = {};
    for (const [field, symbol] of Object.entries(binding.symbols)) {
      const dim = field === "tof" ? "T" : "L/T";
      expect[field] = toSI(bindings[symbol], dim, `${binding.id}/${symbol}`);
      const toleranceSymbol = binding.toleranceSymbols?.[field] ?? symbol;
      stated[field] = tolerances[toleranceSymbol] ?? null;
      if (!stated[field]) {
        throw new Error(
          `${binding.test}: no stated tolerance for ${field} (looked up ${toleranceSymbol})`,
        );
      }
      if (toleranceSymbol !== symbol) {
        stated[field] = { ...stated[field], statedVia: toleranceSymbol };
      }
    }
    cases.push({
      id: binding.id,
      kind: "transfer",
      operation: binding.operation,
      source: {
        library: "hapsira",
        file: binding.file,
        testCase: binding.test,
        symbols: { ...binding.altitudes, ...binding.symbols },
        upstream: binding.upstream,
        license: "MIT",
      },
      values,
      radiiFrom,
      expect,
      tolerances: stated,
      note: binding.note,
    });
  }

  for (const binding of ECCENTRIC_DEPARTURE_BINDINGS) {
    const source = await loadSource(binding.file);
    const block = functionBody(source, binding.test);
    const bindings = readAssignments(block, globalEnvironment);
    const position = toSI(bindings[binding.stateSymbols.position], "L", `${binding.id}/r`);
    const velocity = toSI(bindings[binding.stateSymbols.velocity], "L/T", `${binding.id}/v`);
    const periapsis = periapsisState(position, velocity, MU);
    const values = { mu: MU, r1: periapsis.periapsisRadius };
    const radiiFrom = {};
    for (const [role, symbol] of Object.entries(binding.altitudes)) {
      const altitude = toSI(bindings[symbol], "L", `${binding.id}/${symbol}`);
      values[role] = RE + altitude;
      radiiFrom[role] = { altitudeSymbol: symbol, altitude, earthRadius: RE };
    }
    const cost = readReprCost(block, binding.reprSymbol);
    cases.push({
      id: binding.id,
      kind: "eccentric-departure",
      operation: binding.operation,
      source: {
        library: "hapsira",
        file: binding.file,
        testCase: binding.test,
        symbols: { ...binding.stateSymbols, ...binding.altitudes, cost: binding.reprSymbol },
        upstream: binding.upstream,
        license: "MIT",
      },
      values,
      radiiFrom,
      derivedDepartureState: {
        rule:
          "periapsis radius and periapsis SPEED of the state hapsira's test builds. " +
          "hapsira's Maneuver.hohmann propagates to periapsis and departs from the " +
          "state it finds there; our JSON surface takes a scalar radius. This is an " +
          "INPUT conversion — the expected number below is hapsira's, untouched.",
        position,
        velocity,
        ...periapsis,
      },
      expect: { totalDeltaV: cost.totalDeltaV },
      reprLiteral: cost.literal,
      impulses: cost.impulses,
      /**
       * The repr() the test asserts prints six decimal places of a km/s figure,
       * so the last published digit is worth 1 m/s and half of it is the honest
       * gate. Stating it here keeps the tolerance derived from the source's own
       * printed precision rather than chosen to make a row pass.
       */
      tolerances: {
        totalDeltaV: {
          kind: "atol",
          value: 0.5e-6 * 1000,
          rationale:
            "half a unit in the last decimal place hapsira's repr() prints: six " +
            "decimals of km/s resolve 1e-6 km/s = 1 mm/s, so the honest gate is " +
            "+/- 0.5 mm/s = 5e-4 m/s. Nothing tighter is assertable about a number " +
            "that reached us through a formatted string.",
        },
      },
      note: binding.note,
    });
  }

  const payload = {
    "//":
      "MECHANICALLY EXTRACTED from hapsira test sources by " +
      "vectors/tools/dump-hapsira-vectors.mjs. Do not hand-edit: regenerate. " +
      "hapsira is consulted as an ORACLE — it is never imported, executed, or " +
      "depended on by any build in this repo.",
    generator: "vectors/tools/dump-hapsira-vectors.mjs",
    hapsira: {
      root,
      head: gitHead(root),
      version: (/__version__\s*=\s*"([^"]+)"/.exec(
        await readFile(path.join(root, "src", "hapsira", "__init__.py"), "utf8"),
      ) ?? [])[1] ?? null,
      license: "MIT",
      licenseFirstLine,
      licenseNote:
        "MIT permits reuse of the values with attribution and does not reach our " +
        "artifact. No hapsira CODE is copied into this repo: the dumper reads the " +
        "test sources as text and re-expresses the inputs and expected numbers in " +
        "our own JSON. (The GPL firewall Perses applies to SSBM does not bind here " +
        "— it would if the source were GPL, which is why the licence is read out " +
        "of the checkout and asserted above rather than assumed.)",
    },
    constants: { GM_earth: gmEarth, R_earth: rEarth },
    cases,
  };

  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stderr.write(
    `wrote ${outPath}: ${cases.length} cases from hapsira ${payload.hapsira.head ?? "(no git)"}\n`,
  );
}

await main();
