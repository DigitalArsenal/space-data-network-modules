// The C++ headers of the Space Data Standards this module reads and writes (scripts/lib/sds-cpp-headers.mjs),
// from the spacedatastandards.org and flatc-wasm packages it pins.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import createFlatc from "flatc-wasm/module";
import { generateSdsHeaders as generate } from "../../scripts/lib/sds-cpp-headers.mjs";

export const generateSdsHeaders = (roots, from) => generate(roots, from, createFlatc);

// The $XMT JavaScript binding for the editor and the tests, bundled from the TypeScript of a standards tree (lib/ts).
// The bundle names its sources relative to the module, wherever the process runs.
export const bundleXmt = (standardsRoot, outfile) => build({
  stdin: { contents: "export * from './XMT/main.ts';", resolveDir: path.join(standardsRoot, "lib/ts"), sourcefile: "xmt-entry.ts", loader: "ts" },
  bundle: true, format: "esm", platform: "neutral", target: "es2022", outfile, external: ["flatbuffers"], logLevel: "warning", preserveSymlinks: true,
  absWorkingDir: path.dirname(fileURLToPath(import.meta.url)),
});
