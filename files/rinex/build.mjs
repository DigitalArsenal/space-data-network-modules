import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders } from "./generate-sds-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const srcRoot = path.join(packageRoot, "src");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

/* The $NCD frame decoder and the SHA-256 are the sibling package's: ONE
 * definition of how a file arrives, included by every module that reads such a
 * frame, so the framing cannot drift between them. */
const productsSrc = path.join(packageRoot, "..", "orbit-products", "src");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

// SDS comes from the PUBLISHED package this repo pins, never a sibling
// checkout (published-deps law, owner 2026-08-21).
const { version: sdsVersion, headers } = await generateSdsHeaders();

if (!headers.GNO || !headers.GNO.includes("gnssSatObs")) {
  throw new Error(
    `spacedatastandards.org@${sdsVersion} generated no $GNO. This module's observation port is typed on it; ` +
      "bump the pinned spacedatastandards.org and re-run npm ci.",
  );
}
if (!headers.NCD || !headers.NCD.includes("ncdContainerFormat")) {
  throw new Error(`spacedatastandards.org@${sdsVersion} generated no $NCD (minted in 1.202.0).`);
}

// One pin decides both the generated headers and the manifest validation.
process.env.SPACE_DATA_STANDARDS_ROOT = path.join(packageRoot, "node_modules", "spacedatastandards.org");

async function read(file) {
  return fs.readFile(file, "utf8");
}

/* The generated SDS headers cross-reference each other by family; concatenated
 * into one unit those paths do not exist, so they are stripped and the
 * concatenation order satisfies the dependency. */
function stripSdsCrossIncludes(source) {
  return source.replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, "");
}

function stripLocalIncludes(source) {
  return source
    .replace(/^#include "sha256\.hpp"\n/gm, "")
    .replace(/^#include "ncd_frame\.hpp"\n/gm, "")
    .replace(/^#include "rinex_obs\.hpp"\n/gm, "");
}

/* ONE TRANSLATION UNIT in dependency order: $OEM pulls RFM, TIM, CAT and PPE;
 * CAT pulls IDM, PLD and LCC. */
const pieces = [
  stripSdsCrossIncludes(headers.RFM),
  stripSdsCrossIncludes(headers.TIM),
  stripSdsCrossIncludes(headers.IDM),
  stripSdsCrossIncludes(headers.PLD),
  stripSdsCrossIncludes(headers.LCC),
  stripSdsCrossIncludes(headers.CAT),
  stripSdsCrossIncludes(headers.PPE),
  stripSdsCrossIncludes(headers.OEM),
  stripSdsCrossIncludes(headers.NCD),
  stripSdsCrossIncludes(headers.GNO),
  stripLocalIncludes(await read(path.join(productsSrc, "sha256.hpp"))),
  stripLocalIncludes(await read(path.join(productsSrc, "ncd_frame.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "rinex_obs.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "rinex_module.cpp"))),
];

const sourceCode = pieces.join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred. Reading a file is one forward
  // pass over one resident buffer and the projection is a second pass over what
  // it produced; this guest genuinely cannot spawn.
  threadModel: "wasi-sequential",
});

if (compilation.threadModel !== "wasi-sequential") {
  throw new Error(`Compiler resolved threadModel "${compilation.threadModel}", not wasi-sequential.`);
}

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
fsSync.writeFileSync(
  path.join(distRoot, "build-provenance.json"),
  [
    "{",
    `  "spacedatastandards": "${sdsVersion}",`,
    '  "threadModel": "wasi-sequential",',
    '  "records": { "in": ["$NCD"], "out": ["$GNO", "$OEM", "$NCD"] },',
    '  "formats": ["rinex-obs", "rinex-nav"]',
    "}",
    "",
  ].join("\n"),
);

if (!compilation.report?.ok) {
  const issues = (compilation.report?.issues ?? []).map((issue) => `  ${issue.code ?? ""} ${issue.message ?? issue}`);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues.join("\n")}`);
}

/* SIGN, IN THE BUILD, ALWAYS: the declared consumer verifies before it
 * instantiates and has no unsigned fallback. */
if (process.argv.includes("--unsigned")) {
  console.log("Unsigned local validation build (--unsigned); no signing key read.");
} else {
  execFileSync(
    process.execPath,
    [path.join(packageRoot, "..", "..", "scripts", "sign-module-artifact.mjs"), outputPath],
    { stdio: "inherit" },
  );
}

console.log(
  `Built ${path.relative(packageRoot, outputPath)} against spacedatastandards.org@${sdsVersion} ` +
    `(exports: ${(compilation.report?.exportNames ?? []).join(", ")})`,
);
