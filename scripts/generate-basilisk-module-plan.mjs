#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const basiliskRoot = path.resolve(repoRoot, process.env.BASILISK_ROOT ?? "../basilisk");
const outPath = path.join(repoRoot, "docs", "basilisk-module-plan.json");

const familyRules = [
  {
    id: "simulation-dynamics",
    sourceRoot: "src/simulation/dynamics",
    modulePath: "basilisk/dynamics",
    schemas: ["OPM", "OEM", "OCM", "OSM", "MNV", "MET", "MPE", "AEM", "APM", "XTC"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging", "deterministic-random", "kernel-data-fetch"],
    authoritativeSources: ["Basilisk upstream dynamics unit tests", "closed-form two-body and rigid-body kinematics cases", "Vallado/Curtis orbital mechanics examples"],
  },
  {
    id: "simulation-environment",
    sourceRoot: "src/simulation/environment",
    modulePath: "basilisk/environment",
    schemas: ["OEM", "EOP", "ATM", "ENV", "GNO", "LND", "RFM", "XTC", "MBL"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging", "kernel-data-fetch", "filesystem", "optional-ipfs"],
    authoritativeSources: ["NAIF SPICE tutorial kernels", "NOAA/WMM reference values", "Basilisk upstream environment unit tests"],
  },
  {
    id: "simulation-sensors-navigation",
    sourceRoot: "src/simulation/sensors",
    extraRoots: ["src/simulation/navigation"],
    modulePath: "basilisk/sensors",
    schemas: ["AEM", "APM", "OEM", "TDM", "TRK", "RFM", "XTC", "SEN"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging", "deterministic-random", "camera-fixture-fetch"],
    authoritativeSources: ["Basilisk upstream sensor/navigation unit tests", "noise-off analytical geometry cases", "fixed-seed sensor noise cases"],
  },
  {
    id: "simulation-power-thermal-data",
    sourceRoot: "src/simulation/power",
    extraRoots: ["src/simulation/thermal", "src/simulation/onboardDataHandling", "src/simulation/deviceInterface"],
    modulePath: "basilisk/power",
    schemas: ["XTC", "ENV", "PHY", "TIM"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging", "deterministic-random"],
    authoritativeSources: ["Basilisk upstream power/thermal/data tests", "energy-balance closed forms", "link-budget/storage accounting identities"],
  },
  {
    id: "simulation-mujoco",
    sourceRoot: "src/simulation/mujocoDynamics",
    modulePath: "basilisk/mujoco",
    schemas: ["OPM", "AEM", "APM", "XTC"],
    xtceRequired: true,
    deferredReason: "MuJoCo dependency, licensing, and browser/WasmEdge portability must be resolved before implementation.",
    hostCapabilities: ["time", "logging", "filesystem"],
    authoritativeSources: ["Basilisk upstream MuJoCo tests", "MuJoCo benchmark dynamics cases"],
  },
  {
    id: "fsw-attitude-control",
    sourceRoot: "src/fswAlgorithms/attControl",
    modulePath: "basilisk/fsw/attitude-control",
    schemas: ["AEM", "APM", "ACM", "ATD", "MNV", "XTC"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging"],
    authoritativeSources: ["Basilisk upstream controller tests", "published control-law examples", "zero-error and known-error closed-form cases"],
  },
  {
    id: "fsw-attitude-determination",
    sourceRoot: "src/fswAlgorithms/attDetermination",
    modulePath: "basilisk/fsw/attitude-determination",
    schemas: ["AEM", "APM", "ACM", "ATD", "TDM", "XTC"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging", "deterministic-random"],
    authoritativeSources: ["Basilisk upstream filter tests", "attitude kinematics identity and 180-degree edge cases"],
  },
  {
    id: "fsw-attitude-guidance",
    sourceRoot: "src/fswAlgorithms/attGuidance",
    modulePath: "basilisk/fsw/attitude-guidance",
    schemas: ["AEM", "APM", "ACM", "ATD", "XTC"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging"],
    authoritativeSources: ["Basilisk upstream guidance tests", "closed-form pointing and tracking-error cases"],
  },
  {
    id: "fsw-effector-interfaces",
    sourceRoot: "src/fswAlgorithms/effectorInterfaces",
    modulePath: "basilisk/fsw/effector-interfaces",
    schemas: ["MNV", "MET", "MPE", "XTC"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging"],
    authoritativeSources: ["Basilisk upstream effector interface tests", "known actuator allocation examples"],
  },
  {
    id: "fsw-orbit-formation-navigation",
    sourceRoot: "src/fswAlgorithms/orbitControl",
    extraRoots: ["src/fswAlgorithms/formationFlying", "src/fswAlgorithms/transDetermination", "src/fswAlgorithms/smallBodyNavigation"],
    modulePath: "basilisk/fsw/orbit-formation-navigation",
    schemas: ["OMM", "OPM", "OEM", "OCM", "OSM", "TDM", "AEM", "APM", "MNV", "XTC"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging", "deterministic-random"],
    authoritativeSources: ["Basilisk Lambert/orbit-control unit tests", "published Lambert benchmark cases", "CCSDS orbit examples"],
  },
  {
    id: "fsw-sensor-optical-image",
    sourceRoot: "src/fswAlgorithms/sensorInterfaces",
    extraRoots: ["src/fswAlgorithms/opticalNavigation", "src/fswAlgorithms/imageProcessing"],
    modulePath: "basilisk/optical",
    schemas: ["XTC", "AEM", "APM", "OEM", "SEN"],
    xtceRequired: true,
    hostCapabilities: ["time", "logging", "deterministic-random", "image-fixture-fetch"],
    authoritativeSources: ["Basilisk upstream optical-navigation tests", "synthetic images with known circle/limb/centroid geometry"],
  },
];

function listModuleDirs(relativeRoot) {
  const absoluteRoot = path.join(basiliskRoot, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) {
    return [];
  }
  return fs.readdirSync(absoluteRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("_"))
    .sort();
}

function moduleEntry(name, family) {
  const deferred = Boolean(family.deferredReason);
  return {
    name,
    status: deferred ? "deferred" : "planned",
    modulePath: `${family.modulePath}/${name}`,
    upstreamSource: family.sourceRootsByName[name],
    standards: {
      primarySchemas: family.schemas,
      xtceRequired: family.xtceRequired,
      invokeEnvelope: "PIV",
      payloadFrame: "TAB",
      manifest: "PLG",
      publication: "PNM",
    },
    authoritativeTests: family.authoritativeSources.map((source) => ({
      source,
      units: "documented per port before implementation",
      frame: "documented per port before implementation",
      timeScale: "documented per port before implementation",
      tolerance: "must be justified against source precision",
    })),
    runtimeTargets: ["browser", "wasmedge"],
    hostCapabilities: family.hostCapabilities,
    dependencyStrategy: family.deferredReason ?? "thin SDN module wrapper over upstream Basilisk source; no copied Basilisk source dump",
    failClosedOnMissingStandards: true,
  };
}

const families = [
  {
    id: "core-runtime-and-messaging",
    modulePath: "basilisk/runtime",
    schemas: ["XTC", "PIV", "TAB", "PLG", "REC", "MBL", "PNM", "EPM"],
    xtceRequired: true,
    status: "implemented-seed",
    modules: [
      {
        name: "basilisk-runtime",
        status: "implemented-seed",
        modulePath: "basilisk/runtime",
        upstreamSource: "src/basilisk_wasm plus architecture runtime/messaging",
        standards: {
          primarySchemas: ["XTC", "PIV", "TAB", "PLG", "REC", "MBL", "PNM", "EPM"],
          xtceRequired: true,
          invokeEnvelope: "PIV",
          payloadFrame: "TAB",
          manifest: "PLG",
          publication: "PNM",
        },
        authoritativeTests: [
          {
            source: "Basilisk upstream WASM quick suite: 1810/1810 passing",
            units: "runtime/message tests declare units per payload",
            frame: "payload-specific",
            timeScale: "payload-specific",
            tolerance: "exact byte-preserving SDK echo for seeded XTC path; numerical tolerances required before scenario replay completion",
          },
        ],
        runtimeTargets: ["browser", "wasmedge"],
        hostCapabilities: ["time", "logging", "filesystem", "kernel-data-fetch", "deterministic-random", "optional-ipfs"],
        dependencyStrategy: "keep Basilisk as upstream source dependency and expose scheduler/message/scenario methods through SDK invoke surfaces",
        failClosedOnMissingStandards: true,
      },
    ],
  },
];

for (const rule of familyRules) {
  const sourceRoots = [rule.sourceRoot, ...(rule.extraRoots ?? [])];
  const sourceRootsByName = {};
  const names = new Set();
  for (const root of sourceRoots) {
    for (const name of listModuleDirs(root)) {
      names.add(name);
      sourceRootsByName[name] = `${root}/${name}`;
    }
  }
  const family = {
    ...rule,
    sourceRoots,
    sourceRootsByName,
    status: rule.deferredReason ? "deferred" : "planned",
  };
  families.push({
    id: rule.id,
    modulePath: rule.modulePath,
    status: family.status,
    standards: {
      primarySchemas: rule.schemas,
      xtceRequired: rule.xtceRequired,
    },
    modules: [...names].sort().map((name) => moduleEntry(name, family)),
  });
}

const plan = {
  generatedAt: new Date().toISOString(),
  upstreamBasiliskRoot: path.relative(repoRoot, basiliskRoot),
  artifactContract: {
    primaryArtifact: "dist/isomorphic/module.wasm",
    browserAndWasmEdgeSameArtifact: true,
    manifestSchema: "PLG",
    invokeEnvelope: "PIV",
    payloadFrame: "TAB",
  },
  migrationDecision: {
    canonicalModulesMigration: "migrate stable modules from space-data-network-plugins after Basilisk runtime/family contracts are checked into space-data-network-modules; do not block Basilisk work on that migration",
    stackPinRule: "do not update orbpro-stack submodule pins until affected component commits are pushed",
  },
  families,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log(`wrote ${path.relative(repoRoot, outPath)}`);
