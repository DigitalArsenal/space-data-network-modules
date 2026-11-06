#!/usr/bin/env node
// MODULE SIGNATURES (modules-module-signing-owner-key-20261106, modules-build-provenance-wasm-sha-check-20261106).
//
// Every current-version dist (docs/current-module-parity-index.json, <module>/dist/isomorphic/module.wasm) is signed by a
// publisher in scripts/trusted-publishers.json, and the signature is a trailer: the module section (the bytes a runtime
// instantiates, before the publication trailer) hashes to the wasmSha256 the ledger (scripts/artifact-provenance.json)
// records and to the wasmSha256 (or sha256) the module's own dist/build-provenance file claims.
//
// Each dist is classified: owner-key (a trusted publisher), dev-key (the module SDK's PUBLIC development key
// sdm-dev-test-2026, which proves nothing), unsigned, untrusted (a signer not in trusted-publishers.json), invalid (a
// signature that does not verify), unreadable. A dev-key, untrusted or invalid signature is a failure, as is a module
// section or canonical hash that disagrees with the ledger or the build-provenance file. An unsigned raw build is reported
// ("signs at next version") and is not a failure: the SDK's trailer writer moves the module's sds.manifest section into the
// trailer, so a first signing changes the shipped bytes and is a version step (ruling 2026-11-06); a bundled dist re-signs
// trailer-only. Two identities are recorded for every dist: the whole-file sha256 (what a bundled dist's citations name) and
// the canonical module sha256 (sds.* sections stripped; what the signature covers and what survives a first signing).
//
//   node scripts/check-module-signatures.mjs                       the check on this checkout (exit 1 on any failure)
//   node scripts/check-module-signatures.mjs --report              the same table, exit 0 (an audit before signing)
//   node scripts/check-module-signatures.mjs --markdown <file>     also write the table as Markdown
//   node scripts/check-module-signatures.mjs --root <checkout>     measure another tree (the SDK still comes from this one)
//
// The check never reads a private key: trusted-publishers.json holds public keys only, and the SDK verifier works from
// the trailer. scripts/sign-module-artifact.mjs is the only script that reads the keypair file, in-process.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The module SDK's development keypair is shipped in the SDK repository (test/support/dev-module-signing-keypair.json):
// its public key is public and its seed is public, so a signature by it is no statement of origin.
export const DEV_KEY = Object.freeze({
  keyId: "sdm-dev-test-2026",
  publicKeyHex: "cf4625795484d8efe18860141cfdeaaaed7bbee9209488405b6ddeac7543fe78",
});

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

let bundlePromise;
// The SDK's bundle API (trailer split, signature verification), resolved from this repository's own dependency pin.
export function loadBundle() {
  bundlePromise ??= import(
    pathToFileURL(createRequire(path.join(REPO_ROOT, "package.json")).resolve("space-data-module-sdk/bundle")).href
  );
  return bundlePromise;
}

// The module section of a dist: the bytes before the publication trailer, the whole file when it carries none.
export function moduleSection(bundle, bytes) {
  return bundle.toLoadableWasmBytes(new Uint8Array(bytes));
}

// The same split without the SDK, for the ledger scripts (which run where the SDK may not be installed): a publication
// trailer ends in an 8-byte footer, the record collection's byte length (u32 little-endian) then the magic "$REC"; the
// module section is everything before the collection. A file without that footer is all module section.
export function moduleSectionBytes(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (buffer.length < 8 || buffer.subarray(buffer.length - 4).toString("latin1") !== "$REC") return buffer;
  const collectionLength = buffer.readUInt32LE(buffer.length - 8);
  const collectionOffset = buffer.length - 8 - collectionLength;
  return collectionOffset < 0 ? buffer : buffer.subarray(0, collectionOffset);
}

// Whether a dist carries a publication trailer (the bundled form: manifest in the trailer, signature possible) or is the raw
// build (the module with its sds.manifest custom section embedded, no trailer).
export function artifactForm(bytes) {
  return moduleSectionBytes(bytes).length === bytes.length ? "raw" : "bundled";
}

// The canonical module: the module section with every `sds.*` custom section removed (the SDK's computeCanonicalModuleHash
// basis, what a signature covers). For a bundled dist it is the module section itself; for a raw build it is what a future
// signing leaves as the module section, so recording it beside the whole-file hash names both identities in advance.
export function canonicalModuleBytes(bytes) {
  const section = moduleSectionBytes(bytes);
  if (section.length < 8) return section;
  const parts = [section.subarray(0, 8)];
  let offset = 8;
  const leb = () => { let value = 0, shift = 0, byte; do { byte = section[offset++]; value |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80); return value; };
  while (offset < section.length) {
    const start = offset;
    const id = section[offset++];
    const size = leb();
    const end = offset + size;
    if (end > section.length) return section;
    let drop = false;
    if (id === 0) {
      const nameStart = offset;
      const nameLength = leb();
      drop = section.subarray(offset, offset + nameLength).toString("utf8").startsWith("sds.");
      offset = nameStart;
    }
    if (!drop) parts.push(section.subarray(start, end));
    offset = end;
  }
  return Buffer.concat(parts);
}

export function readTrustedPublishers(base = REPO_ROOT) {
  const file = JSON.parse(fs.readFileSync(path.join(base, "scripts", "trusted-publishers.json"), "utf8"));
  const publishers = (file.publishers ?? []).map((p) => ({
    keyId: p.keyId ?? null,
    publicKeyHex: String(p.publicKeyHex ?? "").trim().toLowerCase(),
    role: p.role ?? "publisher",
  }));
  if (!publishers.length) throw new Error("scripts/trusted-publishers.json names no publisher");
  for (const p of publishers) {
    if (!/^[0-9a-f]{64}$/.test(p.publicKeyHex)) throw new Error(`scripts/trusted-publishers.json: ${p.keyId}: publicKeyHex is not 32 bytes of hex`);
    if (p.publicKeyHex === DEV_KEY.publicKeyHex) throw new Error("scripts/trusted-publishers.json lists the public SDK development key; it is never trusted");
  }
  return publishers;
}

// Who a trailer says signed it, for the report only (never for trust): null when the trailer cannot be read.
async function declaredSigner(bundle, bytes) {
  try {
    const parsed = await bundle.parseSingleFileBundle(new Uint8Array(bytes));
    const entry = (parsed.bundle?.entries ?? []).find(
      (e) => e.entryId === "signature" || e.sectionName === "sds.signature" || String(e.role).toLowerCase() === "signature",
    );
    if (!entry) return null;
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(entry.payload ?? [])));
    return { keyId: payload.keyId ?? null, publicKeyHex: String(payload.publicKeyHex ?? "").toLowerCase() || null };
  } catch {
    return null;
  }
}

// kind: owner-key (or <role>-key for another trusted publisher) | dev-key | unsigned | untrusted | invalid | unreadable
export async function classify(bundle, bytes, publishers) {
  let section;
  try {
    section = moduleSection(bundle, bytes);
  } catch (error) {
    return { kind: "unreadable", reason: error.code ?? error.message, keyId: null, publicKeyHex: null, section: null, trusted: false };
  }
  let result;
  try {
    result = await bundle.verifyModuleArtifact(new Uint8Array(bytes), {
      trustedPublicKeys: [...publishers.map((p) => p.publicKeyHex), DEV_KEY.publicKeyHex],
      requireSignature: false,
    });
  } catch (error) {
    const signer = await declaredSigner(bundle, bytes);
    return {
      kind: error.code === "untrusted_signer" ? "untrusted" : "invalid",
      reason: error.code ?? error.message,
      keyId: signer?.keyId ?? null,
      publicKeyHex: signer?.publicKeyHex ?? null,
      section,
      trusted: false,
    };
  }
  if (!result.signed) return { kind: "unsigned", reason: null, keyId: null, publicKeyHex: null, section, trusted: false };
  if (result.publicKeyHex === DEV_KEY.publicKeyHex) {
    return { kind: "dev-key", reason: "the public SDK development key", keyId: result.keyId ?? null, publicKeyHex: result.publicKeyHex, section, trusted: false };
  }
  const publisher = publishers.find((p) => p.publicKeyHex === result.publicKeyHex);
  return { kind: `${publisher.role}-key`, reason: null, keyId: result.keyId ?? null, publicKeyHex: result.publicKeyHex, section, trusted: true, publisher };
}

// The isomorphic dist layouts the module index recognizes (scripts/lib/current-module-index.mjs), in its order.
const ARTIFACT_LAYOUTS = ["dist/isomorphic/module.wasm", "dist/runtime/isomorphic/module.wasm"];

// The current-version dists: one isomorphic module.wasm per module the parity index lists with one, at the first layout
// present (a module index row with none present is reported as missing).
export function currentDists(base = REPO_ROOT) {
  const index = JSON.parse(fs.readFileSync(path.join(base, "docs", "current-module-parity-index.json"), "utf8"));
  return index.modules
    .filter((m) => m.hasIsomorphicWasm)
    .map((m) => {
      const rel = ARTIFACT_LAYOUTS.map((layout) => `${m.modulePath}/${layout}`).find((candidate) => fs.existsSync(path.join(base, candidate)))
        ?? `${m.modulePath}/${ARTIFACT_LAYOUTS[0]}`;
      return { modulePath: m.modulePath, version: m.version ?? null, rel };
    });
}

// The module-section sha256 a dist's own build-provenance file claims, or null when the module ships none: for a signed dist
// the canonicalWasmSha256 the sign step recorded (the module section as shipped, sds.* moved to the trailer); otherwise the
// build's wasmSha256 (else sha256), or the .txt form's `canonical-sha256` / `sha256 <hex>` line.
export function claimedBuildHash(base, modulePath) {
  const dist = path.join(base, modulePath, "dist");
  const json = path.join(dist, "build-provenance.json");
  const txt = path.join(dist, "build-provenance.txt");
  if (fs.existsSync(json)) {
    const p = JSON.parse(fs.readFileSync(json, "utf8"));
    return (p.signed === true ? p.canonicalWasmSha256 : null) ?? p.wasmSha256 ?? p.sha256 ?? null;
  }
  if (fs.existsSync(txt)) {
    const text = fs.readFileSync(txt, "utf8");
    return text.match(/^canonical-sha256 (\S+)$/m)?.[1] ?? text.match(/^sha256 (\S+)$/m)?.[1] ?? null;
  }
  return null;
}

export async function measure(base = REPO_ROOT) {
  const bundle = await loadBundle();
  const publishers = readTrustedPublishers(base);
  const ledger = JSON.parse(fs.readFileSync(path.join(base, "scripts", "artifact-provenance.json"), "utf8")).artifacts ?? {};
  const rows = [];
  for (const dist of currentDists(base)) {
    const file = path.join(base, dist.rel);
    if (!fs.existsSync(file)) {
      rows.push({ ...dist, kind: "missing", keyId: null, publicKeyHex: null, wasmSha256: null, ledgerAgrees: false, buildProvenance: null, problems: [`${dist.modulePath}: the module index lists ${dist.rel}, which is not here`] });
      continue;
    }
    const bytes = fs.readFileSync(file);
    const c = await classify(bundle, bytes, publishers);
    const wasmSha256 = c.section ? sha256Hex(c.section) : null;
    const canonical = sha256Hex(canonicalModuleBytes(bytes));
    const form = artifactForm(bytes);
    const problems = [];
    // An unsigned raw build is not a failure: its first signing moves the sds.manifest section into the trailer and so changes
    // the shipped bytes, which is a version step; each such module signs at its next version (ruling 2026-11-06). A dev-key
    // signature, an untrusted or invalid one, is a failure now.
    if (!c.trusted && c.kind !== "unsigned") problems.push(`${dist.modulePath}: ${c.kind}${c.reason ? ` (${c.reason})` : ""}${c.keyId ? `, keyId ${c.keyId}` : ""}`);
    const entry = ledger[dist.rel];
    const ledgerWasm = entry?.wasmSha256 ?? null;
    if (!entry) problems.push(`${dist.modulePath}: no ledger entry for ${dist.rel}`);
    else if (!ledgerWasm) problems.push(`${dist.modulePath}: the ledger entry records no wasmSha256 (regenerate the ledger)`);
    else if (ledgerWasm !== wasmSha256) problems.push(`${dist.modulePath}: module section is ${wasmSha256}, the ledger wasmSha256 ${ledgerWasm}`);
    if (entry && entry.canonicalModuleSha256 !== canonical) problems.push(`${dist.modulePath}: canonical module is ${canonical}, the ledger canonicalModuleSha256 ${entry.canonicalModuleSha256 ?? "absent"}`);
    const claimed = claimedBuildHash(base, dist.modulePath);
    if (claimed && claimed !== wasmSha256) problems.push(`${dist.modulePath}: module section is ${wasmSha256}, build-provenance says ${claimed}`);
    rows.push({
      ...dist,
      kind: c.kind === "unsigned" ? "unsigned (signs at next version)" : c.kind,
      form,
      keyId: c.keyId,
      publicKeyHex: c.publicKeyHex,
      wasmSha256,
      canonicalModuleSha256: canonical,
      fileSha256: sha256Hex(bytes),
      bytes: bytes.length,
      trailerBytes: bytes.length - (c.section?.length ?? bytes.length),
      ledgerAgrees: ledgerWasm !== null && ledgerWasm === wasmSha256 && entry.canonicalModuleSha256 === canonical,
      buildProvenance: claimed ? claimed === wasmSha256 : null,
      problems,
    });
  }
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return { rows, counts, problems: rows.flatMap((r) => r.problems), publishers };
}

export function summary(result) {
  const { rows, counts, problems } = result;
  const kinds = Object.entries(counts).sort().map(([k, n]) => `${n} ${k}`).join(", ");
  const ledger = rows.filter((r) => r.ledgerAgrees).length;
  const claimed = rows.filter((r) => r.buildProvenance !== null);
  const agree = claimed.filter((r) => r.buildProvenance).length;
  const facts = `${rows.length} current dists: ${kinds}; ${ledger}/${rows.length} module sections and canonical hashes equal the ledger; ${agree}/${claimed.length} equal their build-provenance file`;
  return problems.length ? `FAIL module signatures: ${problems.length} problems; ${facts}` : `PASS module signatures: ${facts}`;
}

export function markdownTable(result) {
  const lines = ["| module | version | form | signature | keyId | module section sha256 | canonical module sha256 | whole file sha256 | ledger | build-provenance |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of result.rows) {
    lines.push(`| ${r.modulePath} | ${r.version ?? ""} | ${r.form ?? ""} | ${r.kind} | ${r.keyId ?? ""} | ${r.wasmSha256 ? r.wasmSha256.slice(0, 16) : ""} | ${r.canonicalModuleSha256 ? r.canonicalModuleSha256.slice(0, 16) : ""} | ${r.fileSha256 ? r.fileSha256.slice(0, 16) : ""} | ${r.ledgerAgrees ? "agrees" : "disagrees"} | ${r.buildProvenance === null ? "none" : r.buildProvenance ? "agrees" : "disagrees"} |`);
  }
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const base = flag("--root") ? path.resolve(flag("--root")) : REPO_ROOT;
  const result = await measure(base);
  const line = summary(result);
  if (flag("--markdown")) {
    fs.writeFileSync(flag("--markdown"), `${markdownTable(result)}\n\n${line}\n`);
  }
  console.log(markdownTable(result));
  if (result.problems.length) {
    console.error(`${line}\n${result.problems.map((p) => `  - ${p}`).join("\n")}`);
    if (!argv.includes("--report")) process.exit(1);
    console.log(line);
  } else {
    console.log(line);
  }
}
