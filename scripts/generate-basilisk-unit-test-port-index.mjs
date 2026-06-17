#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBasiliskRoot } from "./lib/resolve-basilisk-root.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceIndexPath = path.join(repoRoot, "docs", "basilisk-source-test-index.json");
const modulePlanPath = path.join(repoRoot, "docs", "basilisk-module-plan.json");
const outPath = path.join(repoRoot, "docs", "basilisk-unit-test-port-index.json");

const sourceIndex = readJson(sourceIndexPath);
const modulePlan = readJson(modulePlanPath);
const basiliskRoot = resolveBasiliskRoot(repoRoot);
const plannedModules = flattenPlannedModules(modulePlan);

const overrides = [
  {
    prefix: "src/architecture/messaging",
    disposition: "mapped",
    targetFamily: "core-runtime-and-messaging",
    targetModule: "basilisk/runtime",
    reason: "Architecture message tests back the SDK runtime and message bridge contract.",
  },
  {
    prefix: "src/architecture/system_model",
    disposition: "mapped",
    targetFamily: "core-runtime-and-messaging",
    targetModule: "basilisk/runtime",
    reason: "System model tests back the SDK runtime scheduler contract.",
  },
  {
    prefix: "src/architecture/utilitiesSelfCheck/_UnitTest/test_BSpline.py",
    disposition: "mapped",
    targetFamily: "foundation-shared",
    targetModule: "foundation/math-bspline",
    reason: "Basilisk B-spline utility parity is covered by the shared foundation math B-spline module.",
  },
  {
    prefix: "src/architecture/utilitiesSelfCheck/_UnitTest/test_avsLibrarySelfCheck.py",
    disposition: "mapped",
    targetFamily: "foundation-shared",
    targetModule: "foundation/attitude-math",
    reason: "Basilisk AVS rigid-body kinematics parity is covered by the shared foundation attitude math module; remaining AVS utility groups stay tracked as follow-up parity work in that module.",
  },
  {
    prefix: "src/architecture/utilitiesSelfCheck/_UnitTest/test_keplerianOrbit.py",
    disposition: "mapped",
    targetFamily: "foundation-shared",
    targetModule: "foundation/orbits",
    reason: "Keplerian utility tests should port through the shared orbit foundation instead of a Basilisk duplicate.",
  },
  {
    prefix: "src/architecture/utilitiesSelfCheck/_UnitTest/test_swigDeprecated.py",
    disposition: "excluded",
    exclusionCategory: "python-binding-compatibility",
    reason: "SWIG Python compatibility checks do not represent C++ SDK module behavior.",
  },
  {
    prefix: "src/architecture/utilitiesSelfCheck/_UnitTest/test_swigEigen.py",
    disposition: "excluded",
    exclusionCategory: "python-binding-compatibility",
    reason: "SWIG Eigen binding checks do not represent C++ SDK module behavior.",
  },
  {
    prefix: "src/simulation/dynamics/DynOutput/orbElemConvert",
    disposition: "mapped",
    targetFamily: "foundation-shared",
    targetModule: "foundation/orbits",
    reason: "Basilisk orbit-element conversion tests belong in the shared orbit foundation, with wrappers importing it.",
  },
  {
    prefix: "src/simulation/mujocoDynamics/_GeneralModuleFiles",
    disposition: "deferred",
    proposedTargetModule: "basilisk/mujoco/runtime",
    blocker: "MuJoCo bridge, license, and MJCF asset contract are not yet explicit.",
    reason: "Shared MuJoCo runtime tests are tracked with the deferred MuJoCo module family.",
  },
  {
    prefix: "src/simulation/vizard",
    disposition: "excluded",
    exclusionCategory: "visualization-bridge",
    reason: "Vizard visualization interfaces are outside the current C++ SDK parity module plan.",
  },
  {
    prefix: "src/moduleTemplates",
    disposition: "excluded",
    exclusionCategory: "developer-template",
    reason: "Module template tests validate upstream developer scaffolding, not product module functionality.",
  },
];

const unitTestFiles = sourceIndex.families
  .flatMap((family) => family.testFiles ?? [])
  .filter((file) => path.basename(file).startsWith("test_") && file.endsWith(".py"))
  .sort();

const allUnitTestFiles = new Set(sourceIndex.families.flatMap((family) => family.testFiles ?? []));
const mappings = unitTestFiles.map((upstreamTestFile) => buildMapping(upstreamTestFile));

const document = {
  schemaVersion: 1,
  sourceIndex: "docs/basilisk-source-test-index.json",
  modulePlan: "docs/basilisk-module-plan.json",
  policy: {
    requiredFiles: "Every Basilisk _UnitTest/test_*.py file must be mapped, deferred, excluded, or marked as requiring a module-plan addition.",
    mappedDisposition: "Mapped tests must port numeric and message-contract assertions into C++ SDK module tests before that target module can be marked complete.",
  },
  upstream: sourceIndex.upstream,
  mappingCount: mappings.length,
  dispositionCounts: countBy(mappings, "disposition"),
  mappings,
};

fs.writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${path.relative(repoRoot, outPath)} (${mappings.length} Basilisk Python unit-test mappings)`);

function buildMapping(upstreamTestFile) {
  const sourcePath = path.join(basiliskRoot, upstreamTestFile);
  const source = fs.readFileSync(sourcePath, "utf8");
  const testFunctions = extractTestFunctions(source);
  const supportFiles = collectSupportFiles(upstreamTestFile);
  const override = findOverride(upstreamTestFile);
  const plannedMatch = override?.disposition ? null : findPlannedModule(upstreamTestFile);
  const disposition = override?.disposition ?? (plannedMatch ? "mapped" : "requires-plan-addition");
  const mapping = {
    id: `basilisk-unit-${slug(upstreamTestFile)}`,
    upstreamTestFile,
    upstreamTestFunctions: testFunctions,
    sourceContains: testFunctions.slice(0, 5),
    evidenceKinds: extractEvidenceKinds(source),
    supportFiles,
    disposition,
  };

  if (disposition === "mapped") {
    const target = override ?? plannedMatch;
    mapping.targetFamily = target.targetFamily;
    mapping.targetModule = target.targetModule;
    if (target.reason) {
      mapping.reason = target.reason;
    }
    if (target.targetSourcePrefix) {
      mapping.targetSourcePrefix = target.targetSourcePrefix;
    }
    return mapping;
  }

  if (disposition === "requires-plan-addition") {
    mapping.proposedTargetModule = override?.proposedTargetModule ?? inferProposedTarget(upstreamTestFile);
    mapping.reason = override?.reason ?? "No module-plan target currently owns this upstream unit-test path.";
    return mapping;
  }

  if (disposition === "deferred") {
    mapping.proposedTargetModule = override.proposedTargetModule;
    mapping.blocker = override.blocker;
    mapping.reason = override.reason;
    return mapping;
  }

  if (disposition === "excluded") {
    mapping.exclusionCategory = override.exclusionCategory;
    mapping.reason = override.reason;
    return mapping;
  }

  throw new Error(`Unknown disposition ${disposition} for ${upstreamTestFile}`);
}

function findOverride(upstreamTestFile) {
  const matches = overrides.filter((override) => (
    upstreamTestFile === override.prefix || upstreamTestFile.startsWith(`${override.prefix}/`)
  ));
  matches.sort((a, b) => b.prefix.length - a.prefix.length);
  return matches[0] ?? null;
}

function findPlannedModule(upstreamTestFile) {
  const matches = plannedModules.filter((module) => upstreamTestFile.startsWith(`${module.targetSourcePrefix}/`));
  matches.sort((a, b) => b.targetSourcePrefix.length - a.targetSourcePrefix.length);
  return matches[0] ?? null;
}

function flattenPlannedModules(plan) {
  return plan.families.flatMap((family) => (
    family.modules.flatMap((module) => extractSourcePrefixes(module.upstreamSource).map((targetSourcePrefix) => ({
      targetFamily: family.id,
      targetModule: module.modulePath,
      targetSourcePrefix,
    })))
  ));
}

function extractSourcePrefixes(upstreamSource) {
  return String(upstreamSource)
    .split(/\s+plus\s+|,\s*/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith("src/"));
}

function extractTestFunctions(source) {
  const pytestFunctions = [...source.matchAll(/^def\s+(test[A-Za-z0-9_]+)/gm)]
    .map((match) => match[1])
    .sort();
  if (pytestFunctions.length > 0) {
    return pytestFunctions;
  }
  return [...source.matchAll(/^def\s+([A-Za-z_][A-Za-z0-9_]*)/gm)]
    .map((match) => match[1])
    .sort();
}

function extractEvidenceKinds(source) {
  const evidence = [];
  const patterns = [
    ["pytest-parametrize", /@pytest\.mark\.parametrize/],
    ["approximate-numeric-assertion", /(pytest\.approx|numpy\.testing|np\.testing|assert_allclose|isArrayEqual|isVectorEqual|isMatrixEqual|isDoubleEqual|compareArray|compareVector|compareDouble|accuracy\s*=)/],
    ["message-contract-assertion", /(messaging\.|MsgPayload|subscribeTo|\.write\(|\.recorder\()/],
    ["scenario-simulation-assertion", /(SimulationBaseClass|ExecuteSimulation|ConfigureStopTime|AddModelToTask)/],
    ["plain-assertion", /\bassert\b/],
    ["pytest-expectation", /pytest\./],
  ];
  for (const [kind, pattern] of patterns) {
    if (pattern.test(source)) {
      evidence.push(kind);
    }
  }
  return evidence.length > 0 ? evidence : ["source-presence"];
}

function collectSupportFiles(upstreamTestFile) {
  const unitTestIndex = upstreamTestFile.indexOf("/_UnitTest/");
  if (unitTestIndex < 0) {
    return [];
  }
  const unitTestRoot = upstreamTestFile.slice(0, unitTestIndex + "/_UnitTest/".length);
  return [...allUnitTestFiles]
    .filter((file) => file.startsWith(`${unitTestRoot}Support/`))
    .sort();
}

function inferProposedTarget(upstreamTestFile) {
  const parts = upstreamTestFile.split("/");
  const testName = path.basename(upstreamTestFile, ".py").replace(/^test_/, "");
  if (parts[1] === "simulation") {
    return `basilisk/${parts.slice(2, -2).join("/") || testName}`;
  }
  if (parts[1] === "fswAlgorithms") {
    return `basilisk/fsw/${parts.slice(2, -2).join("/") || testName}`;
  }
  if (parts[1] === "architecture") {
    return `basilisk/runtime/${parts.slice(2, -2).join("/") || testName}`;
  }
  return `basilisk/unmapped/${testName}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function slug(value) {
  return value
    .replace(/^src\//, "")
    .replace(/\/_UnitTest\//g, "/unit-test/")
    .replace(/\.py$/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function countBy(rows, key) {
  return rows.reduce((counts, row) => {
    counts[row[key]] = (counts[row[key]] ?? 0) + 1;
    return counts;
  }, {});
}
