#!/usr/bin/env node
// Authoritative format oracle: SDK transport encryptBytesForRecipient and the
// unchanged licensing/core + client-decrypt artifacts. Equality is exact bytes
// (SHA-256), tolerance zero. Units bytes; frame/epoch/time scale not applicable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { createCidV1Raw, encryptBytesForRecipient, generateX25519Keypair, decryptBytesFromEnvelope } from 'space-data-module-sdk/transport';
import { getWasmWallet } from 'space-data-module-sdk/utils/wasm-crypto';
import { decodeLicensingGrant, validateLicensingGrant } from 'space-data-module-sdk/licensing';
import { createSdkBrowserShimSyncHarness } from '../../core/tests/lib/sdkBrowserShimHarness.mjs';
import { decryptArtifactInputs } from '../../client-decrypt/index.js';
import { sealRequest, checkLayout, sha256, decodeFileContent } from './lib/wire.mjs';
import {
  publicationCids, createServerHostDispatch, makeRuntimeConfig, configureServerSync,
  buildModuleDescriptor, publishModuleSync, createSession, createWalletAccount,
  signModuleDeliveryKey, buildRequesterEpm, requestLease, decodeModuleDescriptor,
} from './lib/lease.mjs';

const context = 'space-data-network/terrain/20261022';
const names = ['499-root.dtts.gz', '499-12-1462_615.dtts.gz', '301-root.dtts.gz', '301-9-0_0.dtts.gz'];
const sizes = [49113, 61571, 453508, 17145];
const fixtures = names.map((name, i) => {
  const bytes = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  assert.equal(bytes.length, sizes[i], `${name}: fixture size`);
  return bytes;
});
const wasm = relative => {
  const file = new URL(relative, import.meta.url);
  assert.ok(fs.existsSync(file), `Required real WASM artifact missing: ${fileURLToPath(file)}; build it before running this test.`);
  return fs.readFileSync(file);
};
const sealerBytes = wasm('../dist/isomorphic/module.wasm');
const coreBytes = wasm('../../core/dist/isomorphic/module.wasm');
const decryptBytes = wasm('../../client-decrypt/dist/isomorphic/module.wasm');
const resources = [];
const secrets = [];
try {
  const wallet = await getWasmWallet();
  const release = await generateX25519Keypair(); secrets.push(release.privateKey);
  const sealer = await createBrowserModuleHarness({ wasmSource: sealerBytes, surface: 'direct' }); resources.push(sealer);
  const decryptor = await createBrowserModuleHarness({ wasmSource: decryptBytes, surface: 'direct' }); resources.push(decryptor);
  const config = makeRuntimeConfig(); secrets.push(...config.keySlots.values());
  const store = new Map();
  const server = await createSdkBrowserShimSyncHarness({ wasmSource: coreBytes, dispatch: createServerHostDispatch(store, config.keySlots, wallet) }); resources.push(server);
  configureServerSync(server, config);
  const request = sealRequest(fixtures, release.privateKey, context, names);
  const begin = performance.now();
  const result = await sealer.invoke(request);
  const elapsed = (performance.now() - begin) / 1000;
  request.inputs.find(x => x.portId === 'release_key').payload.fill(0);
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(result.outputs.length, fixtures.length);
  const sealed = result.outputs.map(output => {
    assert.equal(output.portId, 'file');
    return decodeFileContent(output.payload).slice();
  });
  const layouts = sealed.map((bytes, i) => {
    const layout = checkLayout(bytes, fixtures[i].length, `${context}/${names[i]}`);
    console.log(`FILE ${names[i]} plaintext=${fixtures[i].length} sealed=${bytes.length} overhead=${bytes.length - fixtures[i].length} B`);
    return layout;
  });
  console.log(`SEAL throughput ${(fixtures.length / elapsed).toFixed(2)} files/s ${(fixtures.reduce((s, b) => s + b.length, 0) / elapsed / 1e6).toFixed(2)} MB/s (${elapsed.toFixed(4)} s, direct browser harness)`);
  assert.equal(new Set(layouts.map(x => Buffer.from(x.parsed.enc.ephemeralPublicKey).toString('hex'))).size, 4, 'fresh per-file ephemeral keys');
  assert.equal(new Set(layouts.map(x => Buffer.from(x.parsed.enc.nonceStart).toString('hex'))).size, 4, 'fresh per-file nonces');

  // Honest CIDv1 raw/SHA-256 of the ordered sealed tileset bytes. No fabricated
  // WASM address, and no production descriptor/decryptor changes in this task.
  const tileset = Buffer.concat(sealed);
  const publish = async (id, content, key) => {
    const cid = await createCidV1Raw(content);
    publicationCids.set(sha256(content), cid);
    const descriptor = publishModuleSync(server,
      buildModuleDescriptor({ moduleId: id, version: '1.0.0', allowedXpubs: ['*'] }),
      content, key, { algorithm: 'x25519' });
    assert.equal(decodeModuleDescriptor(descriptor).WASM_CID(), cid, 'key server registers actual sealed-byte CID');
    assert.equal(sha256(store.get(cid)), sha256(content));
    return { moduleId: id, moduleVersion: '1.0.0' };
  };
  const publication = await publish('com.digitalarsenal.terrain.seal-test', tileset, release.privateKey);
  const account = createWalletAccount(wallet);
  const session = await createSession(wallet); secrets.push(session.seed, session.encryption.privateKey);
  const proof = signModuleDeliveryKey(account, session);
  const epm = buildRequesterEpm(wallet, { signerSeed: session.seed, proof });
  const grantFor = publication => {
    const grant = requestLease(server, wallet, { ...publication, requesterXpub: account.xpub, session, epm });
    assert.equal(grant.statusCode, 0, 'real key server grants EPM-proved session');
    validateLicensingGrant(decodeLicensingGrant(grant.grantBytes));
    return grant.grantBytes;
  };
  const grant = grantFor(publication);
  console.log('PASS real key server: publish -> $LCH -> EPM-proved $LPF -> $LGR');
  const decrypt = async (content, grantBytes = grant, key = session.encryption.privateKey) => {
    const inputs = decryptArtifactInputs({ grantResponseBytes: grantBytes, privateKey: key, encryptedBundle: content });
    try { return await decryptor.invoke({ methodId: 'decrypt_artifact', inputs }); }
    finally { inputs.find(x => x.portId === 'recipient_key')?.payload.fill(0); }
  };
  const assertPlain = (response, i) => {
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    assert.equal(sha256(decodeFileContent(response.outputs[0].payload)), sha256(fixtures[i]), names[i]);
  };
  for (let i = 0; i < sealed.length; i++) {
    assertPlain(await decrypt(sealed[i]), i);
    const sdk = await encryptBytesForRecipient({ plaintext: fixtures[i], recipientPublicKey: release.publicKey, context: `${context}/${names[i]}` });
    const sdkBytes = Buffer.from(sdk.protectedBlobBase64, 'base64');
    const sdkLayout = checkLayout(sdkBytes, fixtures[i].length, `${context}/${names[i]}`);
    assert.equal(layouts[i].trailerLength, sdkLayout.trailerLength, 'SDK and C++ trailer layout lengths');
    assertPlain(await decrypt(sdkBytes), i);
    const sdkPlain = await decryptBytesFromEnvelope({ envelope: { protectedBlobBase64: Buffer.from(sealed[i]).toString('base64') }, recipientPrivateKey: release.privateKey });
    assert.equal(sha256(sdkPlain), sha256(fixtures[i]), 'SDK independently decrypts module output');
    console.log(`PASS ${names[i]}: module + SDK sealed bytes decrypt through real client-decrypt; sha256=${sha256(fixtures[i])}`);
  }
  const otherKey = await generateX25519Keypair(); secrets.push(otherKey.privateKey);
  const otherSdk = await encryptBytesForRecipient({ plaintext: fixtures[0], recipientPublicKey: otherKey.publicKey, context: 'other-publication' });
  const otherPublication = await publish('com.digitalarsenal.terrain.other-test', Buffer.from(otherSdk.protectedBlobBase64, 'base64'), otherKey.privateKey);
  const otherGrant = grantFor(otherPublication);
  const wrongSession = randomBytes(32); secrets.push(wrongSession);
  const refused = (r, label) => { assert.notEqual(r.statusCode, 0, label); assert.equal(r.outputs.length, 0, `${label}: no plaintext`); };
  for (let i = 0; i < sealed.length; i++) {
    const noGrantInputs = decryptArtifactInputs({ grantResponseBytes: grant, privateKey: session.encryption.privateKey, encryptedBundle: sealed[i] }).filter(x => x.portId !== 'grant_response');
    refused(await decryptor.invoke({ methodId: 'decrypt_artifact', inputs: noGrantInputs }), 'no grant');
    noGrantInputs.find(x => x.portId === 'recipient_key').payload.fill(0);
    refused(await decrypt(sealed[i], otherGrant), 'grant for another publication');
    refused(await decrypt(sealed[i], grant, wrongSession), 'wrong session key');
    const nonce = Buffer.from(layouts[i].parsed.enc.nonceStart);
    const nonceOffset = Buffer.from(sealed[i]).indexOf(nonce, layouts[i].trailerStart);
    assert.ok(nonceOffset >= layouts[i].trailerStart);
    for (const [label, offset] of [['ciphertext', 0], ['tag', fixtures[i].length], ['ENC', nonceOffset]]) {
      const changed = sealed[i].slice(); changed[offset] ^= 1;
      refused(await decrypt(changed), `flipped ${label} byte`);
    }
    assert.throws(() => checkLayout(sealed[i], fixtures[i].length, `${context}/different-name.dtts.gz`), /reader refuses/);
    console.log(`REFUSED ${names[i]}: no grant; another publication; wrong session key; ciphertext bit; tag bit; ENC bit; different name CONTEXT`);
  }
  // Feed a syntactically valid EPM without its account chain proof to the real
  // server: anonymous callers cannot get the release key via wildcard policy.
  const anonymousEpm = buildRequesterEpm(wallet, { signerSeed: session.seed, proof, withAccountProof: false });
  const anonymous = requestLease(server, wallet, { ...publication, requesterXpub: account.xpub, session, epm: anonymousEpm });
  assert.ok(anonymous.statusCode !== 0 || anonymous.challengeError, 'EPM without account proof is refused');
  console.log('REFUSED missing EPM account proof');
  console.log('PASS publication-seal grant/decrypt E2E (4 fixtures, SDK format oracle, 28 file refusal checks)');
} finally {
  for (const secret of secrets) secret.fill(0);
  for (const resource of resources.reverse()) await resource.destroy();
}
