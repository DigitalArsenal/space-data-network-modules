// Copy a run's REPORTS out of the (gitignored) store directory and into the
// committed evidence tree.
//
// WHY THIS EXISTS. Every headline data-correctness number this lane published —
// tile counts, seam disagreements, worst shared-edge delta, uniform-mask ratio,
// availability closure, durable $IRM marks — came out of `tools/terrain-pyramid/out`,
// which is gitignored and is DELETED by the disk-hygiene sweep. A reviewer
// reading the task md could not check a single one of them without
// re-downloading the region and re-running, which is not review, it is
// re-derivation. The store itself does not belong in git (tens of MB of records
// and hundreds of MB of cached granules); the REPORTS do, and they are small.
//
// WHAT IS COMMITTED. run-report.json (the builder's own numbers, including the
// encoder counters), verify-report.json (everything re-derived from the record
// bytes by verify.mjs, which is the one that matters) and accuracy-report.json
// when measure-accuracy.mjs was run. Plus a REPRODUCE.md stating the exact
// commands, the module and flow artifact hashes the run used, and the pinned
// WasmEdge — so a third party can reproduce them rather than trust them.
//
//   node tools/terrain-pyramid/snapshot-evidence.mjs --out <store dir> --name <label>

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--name") args.name = argv[++i];
    else if (argv[i] === "--config") args.config = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.out) throw new Error("--out <store dir> is required");
  if (!args.name) throw new Error("--name <label> is required");
  return args;
}

const sha256 = (file) =>
  fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out);
const evidenceDir = path.join(HERE, "evidence", args.name);
fs.mkdirSync(evidenceDir, { recursive: true });

const copied = [];
for (const name of ["run-report.json", "verify-report.json", "accuracy-report.json", "cross-check-report.json", "layer-json-config.json"]) {
  const from = path.join(outDir, name);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(evidenceDir, name));
  copied.push(name);
}
if (!copied.includes("verify-report.json")) {
  throw new Error(
    `no verify-report.json in ${outDir}: run verify.mjs before snapshotting, because the ` +
      "builder's own report is the builder's word for it and is not the evidence",
  );
}

const artifacts = {
  "data-source/terrain-source/dist/isomorphic/module.wasm": sha256(
    path.join(REPO, "data-source/terrain-source/dist/isomorphic/module.wasm"),
  ),
  "data-source/terrain-source/dist/parity/module.wasm": sha256(
    path.join(REPO, "data-source/terrain-source/dist/parity/module.wasm"),
  ),
  "data-source/terrain-ingest/dist/isomorphic/module.wasm": sha256(
    path.join(REPO, "data-source/terrain-ingest/dist/isomorphic/module.wasm"),
  ),
  "flows/terrain-ingest/dist/runtime.wasm": sha256(path.join(REPO, "flows/terrain-ingest/dist/runtime.wasm")),
  "flows/terrain-serving/dist/runtime.wasm": sha256(path.join(REPO, "flows/terrain-serving/dist/runtime.wasm")),
};

const gitSha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim();
  } catch {
    return null;
  }
})();
const wasmedge = (() => {
  try {
    return execFileSync("wasmedge", ["--version"]).toString().trim().split("\n")[0];
  } catch {
    return null;
  }
})();

const config = args.config ?? "tools/terrain-pyramid/regions/<the config this run used>";
fs.writeFileSync(
  path.join(evidenceDir, "REPRODUCE.md"),
  `# ${args.name} — how these numbers were produced

Committed so a reviewer can check the lane's published figures without
re-downloading the region. The store itself is not here (it is tens of MB of
records plus hundreds of MB of cached granules, and \`tools/terrain-pyramid/out\`
is gitignored); these are the reports read off it.

- modules commit: \`${gitSha ?? "unknown"}\`
- WasmEdge: \`${wasmedge ?? "not on PATH when this was snapshotted"}\`
- run config: \`${config}\`

## The commands

\`\`\`
node tools/terrain-pyramid/run.mjs --config ${config}
node tools/terrain-pyramid/verify.mjs --out <the config's "out" dir>
node tools/terrain-pyramid/measure-accuracy.mjs --out <the config's "out" dir>
node tools/terrain-pyramid/cross-check-accuracy.mjs --out <same>
node tools/terrain-pyramid/snapshot-evidence.mjs --out <same> --name ${args.name}
\`\`\`

The granules come from the open Copernicus GLO-30 S3 bucket by URL, derived by
the ingest module from the region bbox — there is no separate granule manifest
to pin, because the enumeration is a pure function of the run config and the
durable mark. Re-running with the same config against the same dataset edition
(\`dataset_epoch\`) reproduces the same store, and \`run.mjs\` re-cuts every cell
under the pinned native WasmEdge and refuses the run if the two engines disagree
on a single byte.

## The artifacts this run executed

| artifact | sha256 |
| --- | --- |
${Object.entries(artifacts)
  .map(([file, hash]) => `| \`${file}\` | \`${hash ?? "absent"}\` |`)
  .join("\n")}

## What is in each file

- \`verify-report.json\` — **the evidence.** Everything re-derived from the
  record bytes by \`verify.mjs\`: the FlatBuffers are walked by hand, payloads
  gunzipped and quantized-mesh headers read from the spec, so a bug in the
  encoder cannot also hide itself in the check. Bounds, seam continuity,
  availability closure, digests, mask geometry.
- \`run-report.json\` — the builder's own numbers: timings, fetches, cells,
  durable marks, the WasmEdge cross-check, and the encoder counters
  (\`edgeClampedPosts\`, \`bandBridgedPosts\`, \`tilesAtCeiling\`) that are not in
  the records and can only come from here.
- \`accuracy-report.json\` — triangulation density against a denser re-sample
  through the same module. Read its header comment for what it is NOT
  independent of.
- \`cross-check-report.json\` — the record's OWN stated VERTICAL_ACCURACY_M
  joined per address against that re-sample's max error. The encoder writes the
  field and selects the mesh density by it, so this is the one number in the
  store with a second opinion attached: a ratio near 1.0 on the flat controls
  AND on the high-relief tiles is the result to want, and a high-relief ratio
  far above 1 while the controls sit at 1 is the signature of a probe that only
  looks where the terrain is smooth.
- \`layer-json-config.json\` — the serving config keys this run implies
  (\`terrain_available\`, \`terrain_maxzoom\`, \`terrain_ocean_synth_min_level\`,
  \`terrain_mount_path\`), which is what the deploy actually installs.
`,
);

console.log(`wrote ${path.relative(REPO, evidenceDir)}: ${[...copied, "REPRODUCE.md"].join(", ")}`);
