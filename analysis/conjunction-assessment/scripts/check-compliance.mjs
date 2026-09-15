#!/usr/bin/env node
/**
 * Run the SDK's compliance checks against the conjunction-assessment build.
 *
 * Validates:
 *   1. The canonical PLG manifest (plugin-manifest.json) against the schema.
 *   2. The compiled isomorphic WASM artifact against its embedded manifest
 *      bytes and the required plugin ABI exports.
 *
 * Exits non-zero when either check fails. Intended for CI and local
 * verification — the equivalent checks run inline inside
 * `tests/sdk_compat.test.mjs`, so this script is a thin CLI surface for
 * operators who want a quick pass/fail without spinning up the test runner.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { encodePluginManifest, decodePluginManifest } from "space-data-module-sdk/manifest";

import {
  validateArtifactWithStandards,
  validateManifestWithStandards,
} from "space-data-module-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const standardsRoot = path.join(packageRoot, "node_modules", "spacedatastandards.org");
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const wasmPath = path.join(
  packageRoot,
  "dist",
  "isomorphic",
  "module.wasm",
);

function printIssues(report) {
  if (report.ok) {
    console.log(`[compliance] ok: ${report.sourceName}`);
    return;
  }

  console.error(`[compliance] failed: ${report.sourceName}`);
  for (const issue of report.issues ?? []) {
    console.error(`- ${issue.severity}: ${issue.message}`);
  }
}

async function main() {
  const manifestRaw = await fs.readFile(manifestPath, "utf8").catch((error) => {
    throw new Error(
      `Could not read plugin manifest at ${manifestPath}: ${error.message}`,
    );
  });
  const manifest = JSON.parse(manifestRaw);

  const manifestReport = await validateManifestWithStandards(manifest, {
    sourceName: manifestPath,
    standardsRoot,
  });
  printIssues(manifestReport);
  if (!manifestReport.ok) {
    process.exitCode = 1;
    return;
  }

  await fs.access(wasmPath).catch(() => {
    throw new Error(
      `Compiled WASM artifact missing at ${wasmPath}. Run \`node build.mjs\` first.`,
    );
  });

  const artifactReport = await validateArtifactWithStandards({
    manifest,
    standardsRoot,
    wasmPath,
    sourceName: wasmPath,
  });
  printIssues(artifactReport);
  const bytes = encodePluginManifest(manifest);
  assert.deepEqual(encodePluginManifest(decodePluginManifest(bytes)), bytes,
    "PLG encode/decode must preserve the canonical bytes");
  const issues = [manifestReport, artifactReport].flatMap(report => report.issues ?? []);
  // Both checks repeat the same port warnings under different source paths.
  const warnings = [...new Map(issues.filter(issue => issue.severity === "warning")
    .map(issue => [`${issue.code}:${issue.location?.replace(/^.*(?=\.methods\[)/, 'manifest')}`, issue])).values()];
  console.log(JSON.stringify({
    standards: "1.220.0",
    errors: issues.filter(issue => issue.severity === "error").length,
    warnings: warnings.length,
    warningCodes: [...new Set(warnings.map(issue => issue.code))],
    plgRoundTrip: true,
  }, null, 2));
  if (!artifactReport.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
