// Minimal public-SDK reproduction of the remaining manifest blockers.
// No SDK source changes, compiler subprocesses, signing, or schema aliases.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
for (const name of ["propagator/hpop", "analysis/conjunction-assessment", "analysis/access"]) {
  const directory = path.join(root, name);
  const require = createRequire(path.join(directory, "package.json"));
  const { validateManifestWithStandards, validateArtifactWithStandards } = await import(pathToFileURL(require.resolve("space-data-module-sdk")));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "plugin-manifest.json")));
  const authoring = await validateManifestWithStandards(manifest);
  const artifact = await validateArtifactWithStandards({ manifest, wasmPath: path.join(directory, "dist/isomorphic/module.wasm") });
  const errors = (report) => report.issues.filter((issue) => issue.severity === "error");
  console.log(JSON.stringify({ module: name, manifestErrors: errors(authoring), artifactErrors: errors(artifact) }, null, 2));
  if (!authoring.ok || !artifact.ok) process.exitCode = 1;
}
