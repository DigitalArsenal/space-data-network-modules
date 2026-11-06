#!/usr/bin/env node
// E2E (modules-module-signing-owner-key-20261106): every current-version dist is signed by a trusted publisher and the check
// that says so refuses what it must.
//
//   1. this checkout: `node scripts/check-module-signatures.mjs` PASSES (every current dist a trusted publisher's key; 0 dev-key,
//      0 unsigned, 0 untrusted; every module section equal to the ledger wasmSha256) and the counts are printed;
//   2. scripts/sign-module-artifact.mjs refuses without SDM_MODULE_SIGNING_KEYPAIR_PATH (exit 2, names the variable, writes
//      nothing), and `--unsigned` records signed: false in the dist's build-provenance.json without touching the dist;
//   3. a scratch tree (one current module's dist, a scratch Ed25519 key generated here, never the owner's): an unsigned dist is
//      refused naming the module; after signing with the scratch key, a stale ledger wasmSha256 is refused; with the ledger
//      updated and the scratch key trusted the tree passes as owner-key; with another key trusted the signer is refused as
//      untrusted; the signing kept the canonical module hash (sds.* sections stripped) and every non-sds byte.
//   node scripts/tests/module-signatures.e2e.mjs
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, artifactForm, canonicalModuleBytes, currentDists, loadBundle, measure, moduleSectionBytes, sha256Hex, summary } from "../check-module-signatures.mjs";

const node = (args, env = {}) => spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, SDM_MODULE_SIGNING_KEYPAIR_PATH: undefined, SDM_MODULE_UNSIGNED_BUILD: undefined, ...env } });
const checkScript = path.join(REPO_ROOT, "scripts", "check-module-signatures.mjs");
const signScript = path.join(REPO_ROOT, "scripts", "sign-module-artifact.mjs");

// 1. this checkout
const real = await measure(REPO_ROOT);
const realLine = summary(real);
assert.equal(real.problems.length, 0, `${realLine}\n${real.problems.map((p) => `  - ${p}`).join("\n")}`);
assert.ok(real.rows.length >= 100, `only ${real.rows.length} current dists`);
assert.ok(real.rows.every((r) => r.kind === "owner-key" || r.kind.startsWith("unsigned")), "a current dist carries a dev-key, untrusted or invalid signature");
assert.ok(real.rows.some((r) => r.kind === "owner-key"), "no current dist is owner-key signed");
// a bundled dist without a signature (a trailer carrying the manifest and nothing else, as the flow compiler writes) is
// unsigned, not a failure; it is counted so the report names how many could sign trailer-only
const bundledUnsigned = real.rows.filter((r) => r.form === "bundled" && r.kind !== "owner-key").map((r) => r.modulePath);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "module-signatures-"));
try {
  // a scratch keypair in the SDK's file layout, mode 0600, and a second one that is never trusted
  const keypairFile = (name, keyId) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const file = path.join(scratch, name);
    const publicKeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
    fs.writeFileSync(file, JSON.stringify({ algorithm: "ed25519", keyId, privateKeySeedHex: Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString("hex"), publicKeyHex }), { mode: 0o600 });
    return { file, keyId, publicKeyHex };
  };
  const scratchKey = keypairFile("scratch-keypair.json", "scratch-e2e");
  const otherKey = keypairFile("other-keypair.json", "other-e2e");

  // the scratch tree: one bundled (owner-signed) current module; a build-provenance.json is given to it when it ships none
  const ownerSigned = new Set(real.rows.filter((r) => r.kind === "owner-key").map((r) => r.modulePath));
  const subject = currentDists().find((d) => ownerSigned.has(d.modulePath) && fs.existsSync(path.join(REPO_ROOT, d.rel)) && artifactForm(fs.readFileSync(path.join(REPO_ROOT, d.rel))) === "bundled");
  assert.ok(subject, "no current module ships an owner-signed bundled dist");
  const tree = path.join(scratch, "tree");
  const put = (rel, content) => { fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true }); fs.writeFileSync(path.join(tree, rel), content); };
  const dist = path.join(tree, subject.rel);
  fs.mkdirSync(path.dirname(dist), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, subject.rel), dist, fs.constants.COPYFILE_FICLONE);
  const provenanceRel = `${subject.modulePath}/dist/build-provenance.json`;
  const shipped = path.join(REPO_ROOT, provenanceRel);
  put(provenanceRel, fs.existsSync(shipped) ? fs.readFileSync(shipped) : JSON.stringify({ wasmSha256: sha256Hex(moduleSectionBytes(fs.readFileSync(dist))) }, null, 2));
  put(`${subject.modulePath}/package.json`, JSON.stringify({ name: "scratch-module", version: "0.0.0", type: "module" }));
  const row = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs", "current-module-parity-index.json"), "utf8")).modules.find((m) => m.modulePath === subject.modulePath);
  put("docs/current-module-parity-index.json", JSON.stringify({ modules: [row] }));
  const trust = (key) => put("scripts/trusted-publishers.json", JSON.stringify({ version: 1, publishers: [{ keyId: key.keyId, publicKeyHex: key.publicKeyHex, role: "owner", since: "2026-11-06" }] }));
  const ledger = () => { const bytes = fs.readFileSync(dist); put("scripts/artifact-provenance.json", JSON.stringify({ version: 1, artifacts: { [subject.rel]: { sha256: sha256Hex(bytes), bytes: bytes.length, wasmSha256: sha256Hex(moduleSectionBytes(bytes)), canonicalModuleSha256: sha256Hex(canonicalModuleBytes(bytes)) } } })); };
  trust(scratchKey);

  // the dist as it is in this checkout is signed by the owner; the scratch tree trusts only the scratch key, so it is untrusted
  const bundle = await loadBundle();
  const committed = fs.readFileSync(dist);
  const committedSection = Buffer.from(bundle.toLoadableWasmBytes(new Uint8Array(committed)));
  const canonicalCommitted = (await bundle.computeCanonicalModuleHash(committedSection)).hashHex;
  ledger();
  const untrustedOwner = node([checkScript, "--root", tree]);
  assert.equal(untrustedOwner.status, 1, `the owner-signed dist under a tree trusting only the scratch key was not refused: ${untrustedOwner.stdout}`);
  assert.ok(untrustedOwner.stderr.includes(`${subject.modulePath}: untrusted`), `no "untrusted" line: ${untrustedOwner.stderr}`);

  // an unsigned dist: the module section alone (the trailer stripped) is reported as unsigned (signs at next version), not refused
  fs.writeFileSync(dist, committedSection);
  ledger();
  const unsigned = node([checkScript, "--root", tree]);
  assert.equal(unsigned.status, 0, `the unsigned dist was refused: ${unsigned.stdout}${unsigned.stderr}`);
  assert.ok(unsigned.stdout.includes("| unsigned (signs at next version) |"), `the unsigned dist is not reported as such: ${unsigned.stdout}`);

  // 2. the sign script: refuses without the variable and writes nothing; --unsigned records signed: false
  const before = fs.readFileSync(dist);
  const refusal = node([signScript, dist]);
  assert.equal(refusal.status, 2, `the sign script did not refuse without the variable (exit ${refusal.status}): ${refusal.stdout}${refusal.stderr}`);
  assert.ok(refusal.stderr.includes("SDM_MODULE_SIGNING_KEYPAIR_PATH"), `the refusal does not name the variable: ${refusal.stderr}`);
  assert.ok(before.equals(fs.readFileSync(dist)), "the refused sign step changed the dist");
  const unsignedBuild = node([signScript, "--unsigned", dist]);
  assert.equal(unsignedBuild.status, 0, `--unsigned failed: ${unsignedBuild.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tree, provenanceRel), "utf8")).signed, false, "--unsigned did not record signed: false");
  assert.ok(before.equals(fs.readFileSync(dist)), "--unsigned changed the dist");

  // 3. signing with the scratch key through the variable: canonical hash and non-sds bytes kept, manifest moved to the trailer
  const signed = node([signScript, dist], { SDM_MODULE_SIGNING_KEYPAIR_PATH: scratchKey.file });
  assert.equal(signed.status, 0, `signing with the scratch key failed: ${signed.stdout}${signed.stderr}`);
  const signedReport = JSON.parse(signed.stdout.trim().split("\n").at(-1));
  assert.equal(signedReport.keyId, "scratch-e2e");
  assert.equal(signedReport.publicKeyHex, scratchKey.publicKeyHex);
  assert.ok(!signed.stdout.includes(JSON.parse(fs.readFileSync(scratchKey.file, "utf8")).privateKeySeedHex), "the sign script printed the seed");
  const after = fs.readFileSync(dist);
  const afterSection = Buffer.from(bundle.toLoadableWasmBytes(new Uint8Array(after)));
  assert.equal((await bundle.computeCanonicalModuleHash(afterSection)).hashHex, canonicalCommitted, "signing changed the canonical module hash");
  assert.ok(afterSection.equals(Buffer.from(bundle.stripWasmCustomSections(committedSection, (s) => s.name.startsWith("sds.")))), "signing changed a non-sds byte");
  const provenanceAfter = JSON.parse(fs.readFileSync(path.join(tree, provenanceRel), "utf8"));
  assert.equal(provenanceAfter.signed, true);
  assert.equal(provenanceAfter.signer.keyId, "scratch-e2e");
  assert.equal(provenanceAfter.canonicalWasmSha256, sha256Hex(afterSection));

  // the stale ledger (the pre-sign section) is refused; the regenerated ledger with the scratch key trusted passes as owner-key
  const stale = node([checkScript, "--root", tree]);
  assert.equal(stale.status, 1, `a stale ledger wasmSha256 was not refused: ${stale.stdout}`);
  assert.ok(stale.stderr.includes("ledger wasmSha256"), `no ledger line: ${stale.stderr}`);
  ledger();
  const trusted = node([checkScript, "--root", tree]);
  assert.equal(trusted.status, 0, `the scratch-signed, scratch-trusted tree was refused: ${trusted.stdout}${trusted.stderr}`);
  assert.ok(trusted.stdout.includes("1 current dists: 1 owner-key"), `unexpected summary: ${trusted.stdout}`);

  // another key trusted: the scratch signer is untrusted, and the report names the module
  trust(otherKey);
  const untrusted = node([checkScript, "--root", tree]);
  assert.equal(untrusted.status, 1, `an untrusted signer was not refused: ${untrusted.stdout}`);
  assert.ok(untrusted.stderr.includes(`${subject.modulePath}: untrusted`), `no "untrusted" line: ${untrusted.stderr}`);

  console.log(`MODULE-SIGNATURES E2E PASS: ${realLine}; ${bundledUnsigned.length} bundled dists unsigned (trailer without a signature: ${bundledUnsigned.join(", ") || "none"}); scratch ${subject.modulePath}: owner-signed under a foreign trust list refused (untrusted), unsigned reported not refused, sign script exit 2 without the variable and byte-identical dist, --unsigned recorded signed: false, scratch-key signing kept canonical ${canonicalCommitted.slice(0, 12)} and every non-sds byte (section ${committedSection.length} -> ${afterSection.length} B, trailer ${after.length - afterSection.length} B), stale ledger refused, trusted scratch key passes, other key refused`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
