#!/usr/bin/env node
// Prints the PUBLIC half of a module signing keypair file, and nothing else.
//
//   SDM_MODULE_SIGNING_KEYPAIR_PATH=<keypair.json> node scripts/extract-public-key.mjs
//
// Output: one JSON line, {"keyId": <string|null>, "publicKeyHex": <64 hex>}. The file is read
// in-process; the seed (privateKeySeedHex) never reaches stdout, stderr, an error message or
// an argument. The script takes no arguments and no flags: anything on the command line is
// refused (exit 2), so no option can widen what it prints. The path comes only from the
// environment variable, never from argv, so a shell history never names it.
import { readFileSync } from "node:fs";

if (process.argv.length > 2) {
  process.stderr.write("extract-public-key: takes no arguments; set SDM_MODULE_SIGNING_KEYPAIR_PATH and run it bare\n");
  process.exit(2);
}
const keypairPath = process.env.SDM_MODULE_SIGNING_KEYPAIR_PATH;
if (!keypairPath) {
  process.stderr.write("extract-public-key: SDM_MODULE_SIGNING_KEYPAIR_PATH is unset\n");
  process.exit(2);
}

let keypair;
try {
  keypair = JSON.parse(readFileSync(keypairPath, "utf8"));
} catch (error) {
  // The message names the path only; never the content.
  process.stderr.write(`extract-public-key: cannot read a keypair JSON object at ${keypairPath} (${error.code ?? error.name})\n`);
  process.exit(2);
}

const publicKeyHex = String(keypair?.publicKeyHex ?? "").trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) {
  process.stderr.write("extract-public-key: the file carries no 32-byte publicKeyHex\n");
  process.exit(2);
}
const keyId = typeof keypair.keyId === "string" && keypair.keyId.trim() ? keypair.keyId.trim() : null;
process.stdout.write(`${JSON.stringify({ keyId, publicKeyHex })}\n`);
