#!/usr/bin/env node
// Signs module artifacts with the publisher keypair the environment names; the signature is a trailer and the module
// section (the bytes a runtime instantiates) is asserted byte-identical before the file is written.
//
//   SDM_MODULE_SIGNING_KEYPAIR_PATH=<keypair.json> node scripts/sign-module-artifact.mjs <dist/isomorphic/module.wasm> [...]
//   node scripts/sign-module-artifact.mjs --unsigned <artifact.wasm> [...]          an explicitly unsigned build
//   SDM_MODULE_UNSIGNED_BUILD=1 node scripts/sign-module-artifact.mjs <artifact.wasm>  the same, for build scripts
//
// There is no fallback key. Without SDM_MODULE_SIGNING_KEYPAIR_PATH the script refuses (exit 2) unless the build is
// declared unsigned, and an unsigned build is recorded: the dist's build-provenance.json (when the dist has one) gets
// `signed: false`; a signed one gets `signed: true` and the signer's keyId and public key. The keypair file is read
// in-process; only its keyId and publicKeyHex ever reach stdout. The SDK's development keypair is public and is never
// used here (modules-sign-script-revoked-key-fallback-20261031).
import { readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const unsignedFlag = args.includes("--unsigned") || process.env.SDM_MODULE_UNSIGNED_BUILD === "1";
// --trailer-only: refuse any artifact whose module section would change (a raw build with an embedded sds.manifest: its first
// signing is a version step); a re-signing of an already bundled dist always satisfies it.
const trailerOnly = args.includes("--trailer-only");
const artifacts = args.filter((a) => a !== "--unsigned" && a !== "--trailer-only").map((a) => path.resolve(a));
const keypairPath = process.env.SDM_MODULE_SIGNING_KEYPAIR_PATH;

function refuse(message) {
  process.stderr.write(`sign-module-artifact: ${message}\n`);
  process.exit(2);
}

if (!artifacts.length) refuse("usage: [SDM_MODULE_SIGNING_KEYPAIR_PATH=<keypair.json>] sign-module-artifact.mjs [--unsigned] <artifact.wasm> [...]");
if (!keypairPath && !unsignedFlag) {
  refuse(
    "refusing to sign: SDM_MODULE_SIGNING_KEYPAIR_PATH is unset and there is no fallback key. Set it to the publisher " +
      "keypair file, or declare an unsigned build with --unsigned (or SDM_MODULE_UNSIGNED_BUILD=1), which records " +
      "signed: false in the dist's build-provenance.json.",
  );
}
if (keypairPath && unsignedFlag) refuse("both SDM_MODULE_SIGNING_KEYPAIR_PATH and an unsigned build were given; choose one");
for (const artifact of artifacts) if (!fs.existsSync(artifact)) refuse(`${artifact}: no such artifact`);

// The nearest package.json at or above the artifact decides which SDK signs (the module's own pin when it has one
// installed, else this repository's), the way the module's build resolves it.
function packageDirOf(artifact) {
  for (let dir = path.dirname(artifact); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  }
  return repoRoot;
}

async function loadBundle(packageDir) {
  for (const base of [packageDir, repoRoot]) {
    try {
      return await import(pathToFileURL(createRequire(path.join(base, "package.json")).resolve("space-data-module-sdk/bundle")).href);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND" || base === repoRoot) throw error;
    }
  }
  throw new Error("space-data-module-sdk/bundle is not installed");
}

// The dist's build-provenance file (.json, else .txt): the nearest `dist` directory at or above the artifact, within its package.
function provenanceFileOf(artifact, packageDir) {
  for (let dir = path.dirname(artifact); dir.startsWith(packageDir); dir = path.dirname(dir)) {
    if (path.basename(dir) === "dist") {
      return ["build-provenance.json", "build-provenance.txt"].map((name) => path.join(dir, name)).find((file) => fs.existsSync(file)) ?? null;
    }
  }
  return null;
}

// The provenance record of a signing. wasmSha256 (or sha256) stays what the build emitted; canonicalWasmSha256 is the
// module section as shipped after signing (the sds.* sections moved into the trailer), which the ledger check compares.
function recordProvenance(file, record) {
  if (!file) return false;
  if (file.endsWith(".txt")) {
    const kept = fs.readFileSync(file, "utf8").split("\n").filter((line) => !/^(signed|signer-key-id|signer-public-key|canonical-sha256) /.test(line));
    while (kept.length && kept.at(-1) === "") kept.pop();
    kept.push(`signed ${record.signed}`);
    if (record.signed) kept.push(`signer-key-id ${record.keyId}`, `signer-public-key ${record.publicKeyHex}`, `canonical-sha256 ${record.canonicalWasmSha256}`);
    fs.writeFileSync(file, `${kept.join("\n")}\n`);
    return true;
  }
  const provenance = JSON.parse(fs.readFileSync(file, "utf8"));
  provenance.signed = record.signed;
  if (record.signed) {
    provenance.signer = { keyId: record.keyId, publicKeyHex: record.publicKeyHex };
    provenance.canonicalWasmSha256 = record.canonicalWasmSha256;
  } else {
    delete provenance.signer;
    delete provenance.canonicalWasmSha256;
  }
  fs.writeFileSync(file, `${JSON.stringify(provenance, null, 2)}\n`);
  return true;
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

let keypair = null;
if (keypairPath) {
  try {
    keypair = JSON.parse(await readFile(keypairPath, "utf8"));
  } catch (error) {
    refuse(`cannot read a keypair JSON object at ${keypairPath} (${error.code ?? error.name})`);
  }
  if (!/^[0-9a-f]{64}$/i.test(String(keypair.privateKeySeedHex ?? "")) || !/^[0-9a-f]{64}$/i.test(String(keypair.publicKeyHex ?? ""))) {
    refuse(`${keypairPath}: not an Ed25519 keypair file (privateKeySeedHex and publicKeyHex of 32 bytes)`);
  }
}

for (const artifact of artifacts) {
  const packageDir = packageDirOf(artifact);
  const bundle = await loadBundle(packageDir);
  const provenanceFile = provenanceFileOf(artifact, packageDir);
  const before = await readFile(artifact);
  const beforeSection = Buffer.from(bundle.toLoadableWasmBytes(new Uint8Array(before)));

  if (!keypair) {
    const recorded = recordProvenance(provenanceFile, { signed: false });
    console.log(JSON.stringify({ artifactPath: artifact, signed: false, wasmSha256: sha256Hex(beforeSection), provenanceRecorded: recorded }));
    continue;
  }

  // What a signing may change, and what it may not. The SDK's trailer bundle carries the plugin manifest, so the writer
  // moves an embedded `sds.manifest` custom section (any `sds.*` section) out of the module into the bundle: a first signing
  // of a raw build shrinks the module section by exactly those sections. Everything else is fixed, and asserted here before
  // the file is written: the canonical module hash (the SDK's identity, sds.* stripped, the hash the signature covers), every
  // non-sds section byte for byte, and the manifest bytes (the stripped section equals the bundle's manifest entry).
  const canonicalBefore = (await bundle.computeCanonicalModuleHash(beforeSection)).hashHex;
  const manifestBefore = bundle.getWasmCustomSections(beforeSection, bundle.SDS_MANIFEST_SECTION_NAME)[0] ?? null;
  const signed = await bundle.signModuleArtifact(new Uint8Array(before), {
    privateKeySeedHex: keypair.privateKeySeedHex,
    keyId: keypair.keyId ?? null,
  });
  await bundle.verifyModuleArtifact(signed.wasmBytes, { trustedPublicKeys: [keypair.publicKeyHex], requireSignature: true });
  const afterSection = Buffer.from(bundle.toLoadableWasmBytes(signed.wasmBytes));
  const canonicalAfter = (await bundle.computeCanonicalModuleHash(afterSection)).hashHex;
  const strippedBefore = Buffer.from(bundle.stripWasmCustomSections(beforeSection, (section) => section.name.startsWith(bundle.SDS_CUSTOM_SECTION_PREFIX)));
  if (canonicalAfter !== canonicalBefore || !afterSection.equals(strippedBefore)) {
    throw new Error(`${artifact}: signing changed the module beyond its sds.* sections (canonical ${canonicalBefore} -> ${canonicalAfter}); nothing written`);
  }
  if (trailerOnly && !afterSection.equals(beforeSection)) {
    throw new Error(`${artifact}: --trailer-only, but a first signing would move ${beforeSection.length - afterSection.length} bytes of sds.* sections into the trailer (a version step); nothing written`);
  }
  if (manifestBefore) {
    const parsed = await bundle.parseSingleFileBundle(signed.wasmBytes);
    const entry = (parsed.bundle?.entries ?? []).find((e) => e.entryId === "manifest");
    if (!entry || sha256Hex(Buffer.from(entry.payload ?? [])) !== sha256Hex(Buffer.from(manifestBefore))) {
      throw new Error(`${artifact}: the bundle's manifest entry is not the module's sds.manifest bytes; nothing written`);
    }
  }
  await writeFile(artifact, signed.wasmBytes);
  const recorded = recordProvenance(provenanceFile, { signed: true, keyId: signed.signature.keyId, publicKeyHex: signed.signature.publicKeyHex, canonicalWasmSha256: sha256Hex(afterSection) });
  console.log(
    JSON.stringify({
      artifactPath: artifact,
      signed: true,
      keyId: signed.signature.keyId,
      publicKeyHex: signed.signature.publicKeyHex,
      wasmSha256: sha256Hex(afterSection),
      canonicalModuleHash: canonicalAfter,
      sectionBytesBefore: beforeSection.length,
      sectionBytesAfter: afterSection.length,
      manifestMovedToTrailer: Boolean(manifestBefore),
      fileSha256: sha256Hex(signed.wasmBytes),
      trailerBytes: signed.wasmBytes.length - afterSection.length,
      provenanceRecorded: recorded,
    }),
  );
}
