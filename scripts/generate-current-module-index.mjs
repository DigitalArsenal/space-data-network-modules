#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCurrentModuleIndex } from "./lib/current-module-index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(repoRoot, "docs", "current-module-parity-index.json");
const index = createCurrentModuleIndex(repoRoot);

fs.writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${path.relative(repoRoot, outPath)} (${index.moduleCount} modules)`);
