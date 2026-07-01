import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyModuleArtifact } from "space-data-module-sdk/bundle";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "dist", "spacex-starlink-source.wasm");
const KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(__dirname, "../../../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json");

const REQUIRED_EXPORTS = [
  "plugin_invoke_stream",
  "plugin_alloc",
  "plugin_free",
  "plugin_get_manifest_flatbuffer",
  "plugin_get_manifest_flatbuffer_size",
];

/**
 * Strip the trailing non-standard sections (the appended module signature uses a
 * non-standard section id) so the standard WebAssembly module can be compiled.
 */
function standardModulePrefix(bytes) {
  let off = 8; // magic (4) + version (4)
  while (off < bytes.length) {
    const id = bytes[off];
    // Standard WASM section ids are 0..13 (13 = tag, from wasm exceptions). The
    // appended module signature uses a non-standard id (16) -> module ends here.
    if (id > 13) break;
    off += 1;
    let size = 0;
    let shift = 0;
    let b;
    do {
      b = bytes[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    off += size;
  }
  return bytes.subarray(0, off);
}

test("module builds as a valid signed SDN artifact", async () => {
  assert.ok(fs.existsSync(WASM_PATH), `built module not found at ${WASM_PATH}; run \`node build.mjs\` first`);
  const wasm = fs.readFileSync(WASM_PATH);
  const keypair = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  await verifyModuleArtifact(new Uint8Array(wasm), {
    trustedPublicKeys: [keypair.publicKeyHex],
    requireSignature: true,
  });
});

test("module exports the canonical plugin ABI", async () => {
  const wasm = fs.readFileSync(WASM_PATH);
  const mod = await WebAssembly.compile(standardModulePrefix(new Uint8Array(wasm)));
  const exports = WebAssembly.Module.exports(mod).map((e) => e.name);
  for (const name of REQUIRED_EXPORTS) {
    assert.ok(exports.includes(name), `missing ABI export: ${name}`);
  }
});
