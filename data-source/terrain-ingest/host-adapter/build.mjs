import fs from "node:fs/promises";
import path from "node:path";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { adapterRoot as root, composeAdapter } from "./source.mjs";

// The Moon terrain flow's IPFS adapter (wasmedge only).
const { manifest, sourceCode } = await composeAdapter();
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, sourceCode, language: "c++", outputPath, threadModel: "wasi-sequential", allowUndefinedImports: true });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
const guest = path.join(root, "dist/guest-link");
await fs.mkdir(guest, { recursive: true });
await fs.writeFile(path.join(guest, "module-link.o"), result.guestLink.objectBytes);
const { format, language, threadModel, symbolPrefix, methodSymbols } = result.guestLink;
await fs.writeFile(path.join(guest, "metadata.json"), JSON.stringify({ version: 1, format, language, threadModel, symbolPrefix, methodSymbols }, null, 2) + "\n");
console.log(`Built ${outputPath}`);
