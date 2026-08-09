#!/usr/bin/env node
//
// ARTIFACT REPRODUCIBILITY CHECK
//
// Graph task: modules-dist-not-reproducible-at-sdk-pin.
//
// The defect this exists to catch is not "the compiler is flaky" — it is not.
// Measured: rebuilding a module at HEAD from a different absolute path is
// byte-identical, and the historical artifact bc808cd2 reproduces EXACTLY when
// the SDK is checked back out at its era pin. The defect is that NOTHING RECORDS
// WHICH TOOLCHAIN PRODUCED WHICH BYTES, so a committed dist/ artifact is not
// evidence of what its source says, and a signature over those bytes anchors to
// nothing auditable.
//
// So the check is a ledger check, in three lanes:
//
//   LEDGER (default, fast, runs in `npm test`)
//     Every committed dist/ wasm is in scripts/artifact-provenance.json with a
//     matching sha256, and every ledger entry still exists. Committing rebuilt
//     bytes without recording the toolchain that made them FAILS here.
//
//   DECLARATION (default, fast)
//     A module whose build.mjs does not DECLARE `threadModel` while its manifest
//     targets wasmedge/browser is STRUCTURALLY non-reproducible: the SDK infers
//     the thread model, that inference has already moved once
//     (-> EMSCRIPTEN_PTHREADS for runtimeTargets [browser, wasmedge]), and the
//     artifact guard then correctly refuses the result. Such a module cannot be
//     rebuilt at all at the current pin — verified, it throws and leaves a
//     partial 80,638-byte wasm behind. These are listed as a census, and the
//     count is held at or below the recorded baseline so the class shrinks and
//     never grows.
//
//   REBUILD (opt-in: --rebuild <n|module,...>, or MODULES_REPRO_REBUILD)
//     Actually recompile N representative modules from pinned source into a temp
//     directory — never into the module's own dist/, because build.mjs rm -rf's
//     it and a failed compile leaves a poisoned partial artifact — and compare
//     sha256 against what is committed. ~16s per module, which is why it is not
//     in the default lane.
//
// Usage:
//   node scripts/check-artifact-reproducibility.mjs
//   node scripts/check-artifact-reproducibility.mjs --rebuild 3
//   node scripts/check-artifact-reproducibility.mjs --rebuild hostcap/storage-ingest
//   node scripts/check-artifact-reproducibility.mjs --write [--super-repo <path>]

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  REPO_ROOT,
  describeToolchain,
  resolveToolchain,
} from "./build-provenance.mjs";
import { THREAD_MODELS, assertArtifactThreadModel } from "./lib/thread-model.mjs";

const LEDGER_PATH = path.join(REPO_ROOT, "scripts", "artifact-provenance.json");

// The representative set the REBUILD lane draws from when asked for N modules.
// Chosen to cover the distinct compile paths rather than to be a big number:
// a hostcall capability node, a pure-transform foundation node, a data-source
// carrying SDS C++ bindings, and a flow node that imports a shared helper from
// outside its own package. The last two are deliberately modules whose artifacts
// landed at an OLDER SDK pin — a lane where every member was rebuilt yesterday
// proves only that today equals today. Order is the priority order.
const REPRESENTATIVE_MODULES = Object.freeze([
  "hostcap/storage-ingest",
  "hostcap/http-request",
  "foundation/omm-json",
  "data-source/celestrak-parser",
  "flows/supplemental-omm/nodes/timer",
  "flows/supplemental-omm/nodes/providers/starlink",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(args, cwd = REPO_ROOT) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function trackedArtifacts() {
  const listed = git(["ls-files", "*.wasm"]) ?? "";
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("/dist/"))
    .sort();
}

// The module package that owns an artifact: the nearest ancestor of dist/ that
// has a build.mjs. Flow-baked runtimes have no build.mjs of their own (they are
// composed by a bake script), which is itself worth recording rather than
// papering over.
function owningModule(artifactPath) {
  const distIndex = artifactPath.indexOf("/dist/");
  const dir = artifactPath.slice(0, distIndex);
  return fs.existsSync(path.join(REPO_ROOT, dir, "build.mjs")) ? dir : null;
}

// Does this module DECLARE its thread model, or does it ride an inference?
//
// Inference is the reproducibility hazard: the lane is then a property of the SDK
// VERSION, not of the source, so the same source produces different bytes — or,
// once the inference moved to EMSCRIPTEN_PTHREADS, NO bytes at all — as the SDK
// moves. Eleven modules were in exactly that state and are not any more.
//
// A DECLARATION is a STRING LITERAL in the module's OWN build.mjs, in either of
// the two forms the repo actually uses:
//
//   threadModel: "single-thread"     passed to compileModuleFromSource, or to a
//                                    repo-owned build helper that forwards it
//   const THREAD_MODEL = "…"         for the modules that drive a vendored `em++`
//                                    directly and never reach the SDK compiler
//
// Three ways to get this WRONG, all of which were live here:
//
//   1. Grepping the file for `threadModel`. Every SDK-compiled build.mjs writes
//      `threadModel: compilation.guestLink.threadModel` into
//      dist/guest-link/metadata.json — a REPORT of what the SDK decided, not a
//      declaration of what the module requires. That false positive hid three
//      modules that then failed to rebuild at all. The literal-quote requirement
//      is what excludes it.
//   2. Bracket-matching only `compileModuleFromSource(...)`. That was the first
//      fix, and it over-corrected: it counted eight `flows/supplemental-omm`
//      nodes as undeclared when their lane was declared by a repo-owned helper
//      default, and thirteen more that never call the SDK compiler at all. A
//      module can only be judged by what its own build.mjs says, wherever it says
//      it — which is why those helper defaults are now gone and each node states
//      its own lane.
//   3. Judging by `runtimeTargets`. That IS the bug; a deployment target says
//      nothing about whether a guest threads.
function declaredThreadModels(source) {
  const found = new Set();
  const patterns = [
    /\bthreadModel\s*:\s*["'`]([^"'`]+)["'`]/g,
    /\bTHREAD_MODEL\s*=\s*["'`]([^"'`]+)["'`]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

function declarationAudit(moduleDir) {
  const buildPath = path.join(REPO_ROOT, moduleDir, "build.mjs");
  const manifestPath = path.join(REPO_ROOT, moduleDir, "plugin-manifest.json");
  const build = fs.existsSync(buildPath) ? fs.readFileSync(buildPath, "utf8") : "";
  let runtimeTargets = [];
  try {
    runtimeTargets = JSON.parse(fs.readFileSync(manifestPath, "utf8")).runtimeTargets ?? [];
  } catch { /* a module without a manifest still has to declare */ }
  const declared = declaredThreadModels(build);
  const unknown = declared.filter((model) => !THREAD_MODELS.includes(model));
  // A build.mjs that emits no wasm has no thread model to declare. Everything in
  // this repo does, but the check should say WHY it is demanding a declaration
  // rather than demanding one from any file that happens to be named build.mjs.
  const emitsWasm = /wasm/i.test(build);
  return {
    declares: declared.length > 0 && unknown.length === 0,
    threadModels: declared,
    unknownThreadModels: unknown,
    emitsWasm,
    runtimeTargets: runtimeTargets.map((t) => String(t).toLowerCase()),
    inferenceHazard: emitsWasm && declared.length === 0,
  };
}

// Every module that owns a build.mjs, whether or not it has a committed artifact.
// The artifact-level census alone is not enough: a module with no dist/ yet still
// gets to ship an undeclared lane the first time someone builds it.
function allBuildModules() {
  const listed = git(["ls-files", "*/build.mjs"]) ?? "";
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(0, -"/build.mjs".length))
    .sort();
}

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Archaeology, optional: the modules repo does not know which SDK it was built
// against, but the SUPER-REPO gitlink history does. Given --super-repo, resolve
// the SDK gitlink as of the artifact's last-touching commit date. This is
// INFERRED provenance, and the ledger labels it as such — it says which SDK the
// stack was pinned to that day, not which SDK the builder actually had linked.
function inferSdkPin(superRepo, isoDate) {
  if (!superRepo || !isoDate) return null;
  const commit = git(["rev-list", "-1", `--before=${isoDate}`, "main"], superRepo);
  if (!commit) return null;
  const entry = git(["ls-tree", commit, "repos/ancillary-packages/space-data-module-sdk"], superRepo);
  const sha = entry?.split(/\s+/)?.[2] ?? null;
  return sha ? { superRepoCommit: commit, sdkCommit: sha } : null;
}

function buildCensus({ superRepo } = {}) {
  const previous = loadLedger();
  const artifacts = {};
  for (const rel of trackedArtifacts()) {
    const abs = path.join(REPO_ROOT, rel);
    const bytes = fs.readFileSync(abs);
    const lastCommit = git(["log", "-1", "--format=%H|%aI", "--", rel]);
    const [commit, isoDate] = (lastCommit ?? "|").split("|");
    const moduleDir = owningModule(rel);
    const prior = previous?.artifacts?.[rel];
    artifacts[rel] = {
      sha256: sha256(bytes),
      bytes: bytes.length,
      module: moduleDir,
      lastCommit: commit || null,
      lastCommitDate: isoDate || null,
      // "recorded" is only claimable by a build that stamped the toolchain at
      // build time. Everything already in the tree is "inferred": archaeology
      // from the super-repo pin on the day the bytes landed.
      provenance: prior?.provenance === "recorded" && prior?.sha256 === sha256(bytes) ? "recorded" : "inferred",
      toolchain: prior?.sha256 === sha256(bytes) ? (prior.toolchain ?? null) : null,
      sdkPinAtCommit:
        prior?.sha256 === sha256(bytes) && prior?.sdkPinAtCommit
          ? prior.sdkPinAtCommit
          : inferSdkPin(superRepo, isoDate),
      ...(moduleDir ? { declaration: declarationAudit(moduleDir) } : { declaration: null }),
    };
  }
  return artifacts;
}

async function measureRebuildBaseline() {
  const checkout = await createSourceCheckout("HEAD");
  const baseline = {};
  try {
    for (const moduleDir of REPRESENTATIVE_MODULES) {
      const result = await rebuildAndCompare(checkout, moduleDir);
      baseline[moduleDir] = result.status;
      console.log(`  baseline ${moduleDir}: ${result.status}`);
    }
  } finally {
    await checkout.dispose();
  }
  return baseline;
}

async function writeLedger({ superRepo, withRebuild }) {
  const toolchain = resolveToolchain();
  const artifacts = buildCensus({ superRepo });
  const rebuildBaseline = withRebuild
    ? await measureRebuildBaseline()
    : (loadLedger()?.rebuildBaseline ?? {});
  const inferenceHazards = Object.values(artifacts).filter((a) => a.declaration?.inferenceHazard).length;
  const undeclaredModules = allBuildModules().filter((m) => declarationAudit(m).inferenceHazard);
  const ledger = {
    version: 1,
    note:
      "Which toolchain produced which bytes. Regenerate with " +
      "`node scripts/check-artifact-reproducibility.mjs --write [--super-repo <path>]`. " +
      "See scripts/build-provenance.mjs for why each recorded input can change the bytes.",
    generatedBy: toolchain.id,
    toolchains: {
      ...(loadLedger()?.toolchains ?? {}),
      [toolchain.id]: toolchain,
    },
    // The inference-hazard census is a RATCHET: the check refuses an increase.
    // An artifact here is one whose owning module never declared a thread model,
    // so its lane was decided by whichever SDK last ran the build.
    inferenceHazardBaseline: inferenceHazards,
    // The same ratchet, one level up and STRICTER: every module that owns a
    // build.mjs must declare, artifact or no artifact. The artifact census can
    // only see modules that already shipped; this one closes the door in front of
    // the next module instead of behind it. Once at zero it stays at zero.
    undeclaredModuleBaseline: undeclaredModules.length,
    // What the REBUILD lane currently achieves per representative module. Also a
    // ratchet: a module recorded as "reproduced" that stops reproducing is a hard
    // failure; one already recorded as unreproducible is reported, not re-counted.
    // Refresh with `--write --with-rebuild`.
    rebuildBaseline,
    // WHY a module still does not reproduce, once its thread model is no longer
    // the answer. Prose, deliberately: the value of this field is that the next
    // reader does not have to re-derive it, and every entry here was measured by
    // running the build, not predicted. Carried forward across regenerations.
    unreproducibleReasons: loadLedger()?.unreproducibleReasons ?? {},
    // Modules PROVEN reproducible byte-for-byte at a named era SDK pin, from
    // committed source. This is the strongest statement the repo can make about a
    // stale artifact: not "it probably came from somewhere", but "these exact
    // bytes come back when the toolchain is put back". Each entry was produced by
    // an SDK `git worktree` at that pin + `npm ci` + that SDK's own locked
    // spacedatastandards.org, never by argument.
    eraPinReproductions: loadLedger()?.eraPinReproductions ?? {},
    artifacts,
  };
  fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(REPO_ROOT, LEDGER_PATH)}: ${Object.keys(artifacts).length} artifacts, ` +
      `${inferenceHazards} undeclared-lane artifacts, ${undeclaredModules.length} undeclared modules`,
  );
}

function checkLedger() {
  const ledger = loadLedger();
  const failures = [];
  if (!ledger) {
    return [`${path.relative(REPO_ROOT, LEDGER_PATH)} is missing. Regenerate: node scripts/check-artifact-reproducibility.mjs --write`];
  }

  const tracked = trackedArtifacts();
  const seen = new Set();
  let inferenceHazards = 0;
  const hazardList = [];

  for (const rel of tracked) {
    seen.add(rel);
    const entry = ledger.artifacts?.[rel];
    const actual = sha256(fs.readFileSync(path.join(REPO_ROOT, rel)));
    if (!entry) {
      failures.push(
        `UNLEDGERED ARTIFACT ${rel} (sha256 ${actual}). A committed artifact with no recorded toolchain cannot be audited. ` +
          `Regenerate the ledger in the same commit: node scripts/check-artifact-reproducibility.mjs --write`,
      );
      continue;
    }
    if (entry.sha256 !== actual) {
      failures.push(
        `ARTIFACT DRIFT ${rel}\n    ledger  ${entry.sha256} (${entry.bytes} B, ${entry.provenance}, toolchain ${entry.toolchain ?? "unknown"})\n    on disk ${actual} (${fs.statSync(path.join(REPO_ROOT, rel)).size} B)\n    Bytes changed without recording what produced them. Regenerate the ledger in the same commit.`,
      );
    }
    const moduleDir = owningModule(rel);
    if (moduleDir) {
      const audit = declarationAudit(moduleDir);
      if (audit.inferenceHazard) {
        inferenceHazards += 1;
        hazardList.push(`${rel} (${moduleDir}, runtimeTargets [${audit.runtimeTargets.join(", ")}])`);
      } else if (audit.threadModels.length === 1) {
        // THE DECLARATION IS CHECKED AGAINST THE COMMITTED BYTES, not merely
        // required to exist. This is the difference between a declaration and a
        // comment, and it costs milliseconds: the threading facts are in the
        // import/memory/export sections, so no rebuild is involved. All 65
        // owned artifacts agreed with their module's declaration when this
        // landed — which is the evidence that the declarations are the TRUTH of
        // the shipped bytes and not a guess that happens to compile.
        try {
          assertArtifactThreadModel(path.join(REPO_ROOT, rel), audit.threadModels[0], rel);
        } catch (error) {
          failures.push(`DECLARATION CONTRADICTS SHIPPED BYTES: ${error.message}`);
        }
      }
    }
  }

  for (const rel of Object.keys(ledger.artifacts ?? {})) {
    if (!seen.has(rel)) {
      failures.push(`STALE LEDGER ENTRY ${rel} is recorded but no longer tracked. Regenerate the ledger.`);
    }
  }

  const baseline = ledger.inferenceHazardBaseline ?? 0;
  if (inferenceHazards > baseline) {
    failures.push(
      `THREAD-MODEL INFERENCE HAZARD GREW: ${inferenceHazards} artifacts (baseline ${baseline}).\n` +
        `    A build.mjs that does not DECLARE threadModel rides SDK inference, which has already moved ` +
        `(runtimeTargets [browser, wasmedge] now infers EMSCRIPTEN_PTHREADS and the artifact guard refuses the result).\n` +
        `    Such a module cannot be rebuilt at the current pin at all. Declare threadModel explicitly.\n` +
        hazardList.map((h) => `      - ${h}`).join("\n"),
    );
  }

  // MODULE-LEVEL DECLARATION, the strict lane. Every module that owns a build.mjs
  // declares — not only the ones that already have committed bytes. This is what
  // stops the class from being re-created by the next module rather than merely
  // cleaned up behind the last one.
  const undeclared = [];
  const misdeclared = [];
  for (const moduleDir of allBuildModules()) {
    const audit = declarationAudit(moduleDir);
    if (audit.unknownThreadModels.length) {
      misdeclared.push(`${moduleDir} declares ${JSON.stringify(audit.unknownThreadModels)}`);
    } else if (audit.inferenceHazard) {
      undeclared.push(`${moduleDir} (runtimeTargets [${audit.runtimeTargets.join(", ")}])`);
    }
  }
  const moduleBaseline = ledger.undeclaredModuleBaseline ?? 0;
  if (undeclared.length > moduleBaseline) {
    failures.push(
      `MODULES WITH NO THREAD-MODEL DECLARATION: ${undeclared.length} (baseline ${moduleBaseline}).\n` +
        `    Declare the lane as a string literal in the module's OWN build.mjs — ` +
        `\`threadModel: "…"\` for an SDK-compiled module, \`const THREAD_MODEL = "…"\` for one that drives em++ directly.\n` +
        `    Allowed: ${JSON.stringify(THREAD_MODELS)}. Rationale: scripts/lib/thread-model.mjs.\n` +
        undeclared.map((m) => `      - ${m}`).join("\n"),
    );
  }
  if (misdeclared.length) {
    failures.push(
      `UNRECOGNISED THREAD MODEL (expected one of ${JSON.stringify(THREAD_MODELS)}):\n` +
        misdeclared.map((m) => `      - ${m}`).join("\n"),
    );
  }

  const modules = allBuildModules().length;
  console.log(
    `ledger: ${tracked.length} artifacts checked against ${Object.keys(ledger.artifacts ?? {}).length} recorded; ` +
      `${inferenceHazards} undeclared-lane artifacts (baseline ${baseline}); ` +
      `${modules - undeclared.length}/${modules} modules declare a thread model (baseline ${moduleBaseline} undeclared).`,
  );
  if (inferenceHazards > 0 && failures.length === 0) {
    console.log(`  (${inferenceHazards} artifacts are NOT rebuildable at the current pin — see graph task modules-dist-not-reproducible-at-sdk-pin)`);
  }
  return failures;
}

// A THROWAWAY CHECKOUT OF COMMITTED SOURCE, not a copy of the working tree.
//
// Two reasons it must be a checkout and not the module directory:
//   * build.mjs does `fs.rm(distRoot, {recursive:true})` and writes the wasm
//     BEFORE the SDK's artifact guard runs. Building in place would destroy the
//     committed artifact and, on a guard rejection, leave a TRUNCATED one in its
//     place — verified: a rejected build leaves an 80,638-byte wasm behind.
//   * "reproducible" means reproducible from what is COMMITTED. Measuring the
//     working tree would let uncommitted edits pass as reproduction.
//
// And it must be the whole repo, not just the package: build.mjs files import
// shared helpers across module boundaries (flows/supplemental-omm/nodes/
// signing.mjs) and resolve the SDS C++ headers as
// `new URL("../../../spacedatastandards.org/", import.meta.url)` — a sibling of
// the checkout, reached by a hard-coded number of `../` that differs with how
// deep the module sits, and IGNORING SPACE_DATA_STANDARDS_ROOT for the includes
// themselves. So the pinned standards root is offered at every level the build
// could climb to; whichever it reaches, it gets the pin.
async function createSourceCheckout(ref) {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "modules-repro-"));
  const repo = path.join(scratch, "repo");
  execFileSync("git", ["worktree", "add", "--detach", repo, ref], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  await fsp.mkdir(path.join(repo, "node_modules"), { recursive: true });
  await fsp.symlink(
    path.join(REPO_ROOT, "node_modules", "space-data-module-sdk"),
    path.join(repo, "node_modules", "space-data-module-sdk"),
  );
  const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
    ?? path.join(REPO_ROOT, "..", "spacedatastandards.org");
  const levels = new Set([scratch, repo]);
  for (const moduleDir of REPRESENTATIVE_MODULES) {
    for (let dir = path.join(repo, moduleDir); dir.startsWith(repo); dir = path.dirname(dir)) {
      levels.add(dir);
    }
  }
  for (const dir of levels) {
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    await fsp.symlink(standardsRoot, path.join(dir, "spacedatastandards.org")).catch(() => {});
  }
  return {
    repo,
    standardsRoot,
    async dispose() {
      execFileSync("git", ["worktree", "remove", "--force", repo], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      });
      await fsp.rm(scratch, { recursive: true, force: true });
    },
  };
}

async function rebuildAndCompare(checkout, moduleDir) {
  const committed = path.join(REPO_ROOT, moduleDir, "dist/isomorphic/module.wasm");
  if (!fs.existsSync(committed)) {
    return { module: moduleDir, status: "skipped", detail: "no dist/isomorphic/module.wasm" };
  }
  const audit = declarationAudit(moduleDir);
  const pkgDir = path.join(checkout.repo, moduleDir);
  try {
    for (let dir = pkgDir; dir.startsWith(checkout.repo); dir = path.dirname(dir)) {
      await fsp.symlink(checkout.standardsRoot, path.join(dir, "spacedatastandards.org")).catch(() => {});
    }
    execFileSync(process.execPath, ["build.mjs"], {
      cwd: pkgDir,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: checkout.standardsRoot },
    });
    const rebuilt = sha256(await fsp.readFile(path.join(pkgDir, "dist/isomorphic/module.wasm")));
    const expected = sha256(await fsp.readFile(committed));
    return {
      module: moduleDir,
      status: rebuilt === expected ? "reproduced" : "drifted",
      committed: expected,
      rebuilt,
      declaresThreadModel: audit.declares,
    };
  } catch (error) {
    return {
      module: moduleDir,
      status: "build-failed",
      declaresThreadModel: audit.declares,
      detail: String(error?.stderr ?? error?.message ?? error).split("\n").slice(0, 6).join("\n"),
    };
  }
}

function selectRebuildTargets(spec) {
  if (!spec || spec === "true") return REPRESENTATIVE_MODULES.slice(0, 2);
  const n = Number(spec);
  if (Number.isInteger(n) && n > 0) return REPRESENTATIVE_MODULES.slice(0, n);
  return String(spec).split(",").map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : (argv[i + 1]?.startsWith("--") ? "true" : argv[i + 1] ?? "true");
  };

  if (argv.includes("--write")) {
    await writeLedger({ superRepo: flag("super-repo"), withRebuild: argv.includes("--with-rebuild") });
    return;
  }

  const toolchain = resolveToolchain();
  console.log(`toolchain ${toolchain.id}: ${describeToolchain(toolchain)}`);
  if (toolchain.sdk?.dirty) {
    console.log("  WARNING: the linked SDK checkout is DIRTY — anything built here is reproducible by nobody.");
  }

  const failures = checkLedger();

  const rebuildSpec = flag("rebuild") ?? process.env.MODULES_REPRO_REBUILD;
  if (rebuildSpec) {
    const ref = flag("ref") ?? "HEAD";
    const checkout = await createSourceCheckout(ref);
    try {
      for (const moduleDir of selectRebuildTargets(rebuildSpec)) {
        const result = await rebuildAndCompare(checkout, moduleDir);
        console.log(`  rebuild ${moduleDir}: ${result.status}${result.rebuilt ? ` (${result.rebuilt.slice(0, 12)} vs committed ${result.committed.slice(0, 12)})` : ""}`);
        if (result.status === "drifted") {
          failures.push(
            `REBUILD DRIFT ${moduleDir}: unmodified source at ${ref} on this toolchain produces ${result.rebuilt}, committed is ${result.committed}. ` +
              `The signed bytes do not correspond to the pinned source.`,
          );
        } else if (result.status === "build-failed") {
          failures.push(
            `REBUILD FAILED ${moduleDir}${result.declaresThreadModel ? "" : " (does NOT declare threadModel — rides SDK inference)"}:\n    ${result.detail}`,
          );
        }
      }
      // Same ratchet as the inference-hazard census: a member that is ALREADY
      // known-unreproducible is reported, not counted twice — but a member that
      // used to reproduce and now does not is a hard regression.
      const baseline = loadLedger()?.rebuildBaseline ?? {};
      for (let index = failures.length - 1; index >= 0; index -= 1) {
        const match = /^REBUILD (?:DRIFT|FAILED) ([^\s:]+)/.exec(failures[index]);
        if (match && baseline[match[1]] && baseline[match[1]] !== "reproduced") {
          console.log(`  (known-unreproducible, recorded baseline "${baseline[match[1]]}": ${match[1]})`);
          failures.splice(index, 1);
        }
      }
    } finally {
      await checkout.dispose();
    }
  }

  if (failures.length) {
    console.error(`\nFAIL — artifact reproducibility (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS — artifact reproducibility");
}

await main();
