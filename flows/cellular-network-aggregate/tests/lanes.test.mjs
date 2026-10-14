/*
 * Flow-level tests for the LIVE and CREDENTIAL lanes of cellular-network-aggregate on the typed contracts (1.0).
 *
 * LIVE: an /aggregate request with REFRESH:true runs route -> hostcap/http-request -> parse -> deconflict ->
 * foundation/http-respond inside the compiled artifact. The provider body is a REAL OpenStreetMap Overpass answer
 * (data-source/cell-tower-source/tests/fixtures/overpass-berlin.sample.json, ODbL), served for the primary endpoint;
 * the two mirrors fail (a 504 and a host refusal), as they do in production. Attribution travels in
 * HttpRequest.CONTEXT (the $APR run contract), so a failed mirror can no longer shift any body onto the wrong provider.
 *
 * CREDENTIAL: /providers and /credentials/<id> run route -> cell-tower-credentials -> respond_query, with the
 * secrets.* / keyslot.unwrap / node.publicKey hostcalls answered as the Go node answers them. The sealed envelope is
 * built here with real X25519 + HKDF-SHA256 + AES-256-GCM and opened by the test host, so the plaintext crosses only
 * the hostcall boundary - and the test proves it is echoed nowhere.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  configHandler,
  createHostStub,
  frames,
  htqTrigger,
  httpAnswer,
  httpAnswerOf,
  readPage,
  runFlow,
  sds,
  unpack,
} from "./typed-host.mjs";

const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);
const OVERPASS = fs.readFileSync(new URL("../../../data-source/cell-tower-source/tests/fixtures/overpass-berlin.sample.json", import.meta.url));
const OVERPASS_IDS = JSON.parse(OVERPASS).elements.map((e) => String(e.id));
const BERLIN = { south: 52.3, west: 13.0, north: 52.7, east: 13.8 };

const fetches = (stub) => stub.calls.filter((c) => c.operation === "http.request");
async function exchange(stub, request) {
  const { egress } = await runFlow(FLOW_WASM, stub, htqTrigger(request));
  return { answer: httpAnswerOf(egress), egress };
}

function liveHost() {
  return createHostStub({
    "plugin.getConfig": configHandler({}),
    "http.request": (c) => {
      if (c.url.startsWith("https://overpass-api.de/")) return httpAnswer(200, OVERPASS, { "content-type": "application/json" });
      if (c.url.includes("kumi.systems")) return { error: { code: "timeout", message: "mirror timed out" } };
      return httpAnswer(504, "<html>Gateway Timeout</html>");
    },
  });
}

test("live lane: a real Overpass answer becomes $DAV + deconflicted $TBS sites, every report attributed", async () => {
  const stub = liveHost();
  const { answer } = await exchange(stub, {
    method: "POST", path: "/api/v1/cellular/aggregate",
    body: JSON.stringify({ PROVIDERS: ["openstreetmap-overpass"], METHOD: "HIGHEST_SAMPLE_COUNT", BBOX: BERLIN, REFRESH: true }),
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.header("content-type"), "application/vnd.sdn.flatbuffers.stream");
  // the primary and both mirrors were asked, in the same run
  assert.equal(fetches(stub).length, 3);
  assert.ok(fetches(stub).every((c) => c.url.includes("?data=")), "an Overpass program on every endpoint");

  const [head, ...records] = frames(answer.body);
  const dav = unpack("DAV", head);
  assert.equal(dav.SOURCE_NAME, "cellular-aggregate");
  assert.equal(Number(dav.RECORD_COUNT), records.length);
  assert.equal(answer.header("x-sdn-record-count"), String(records.length));
  assert.ok(records.length > 0 && records.length <= OVERPASS_IDS.length);

  // CONSERVATION: every reported mast lands in exactly one site, attributed to the provider that reported it
  const sites = records.map((r) => unpack("TBS", r));
  const sources = sites.flatMap((s) => s.SOURCES);
  assert.equal(sources.length, OVERPASS_IDS.length, "the failed mirrors contributed nothing, the primary every element");
  assert.ok(sources.every((p) => p.PROVIDER_ID === "openstreetmap-overpass" && p.LICENSE === "ODbL 1.0"));
  assert.deepEqual(sources.map((p) => p.NATIVE_ID).sort(), OVERPASS_IDS.slice().sort());
  for (const s of sites) {
    assert.equal(s.CONSENSUS.METHOD, sds.TBS.tbsMergeMethod.HIGHEST_SAMPLE_COUNT);
    assert.equal(s.CONSENSUS.PROVIDERS_CONSULTED, 1);
    assert.equal(s.CONSENSUS.WINNING_PROVIDER_ID, "openstreetmap-overpass");
  }
  // the run's summary rides as the answer's headers
  assert.equal(answer.header("x-sdn-providers-consulted"), "openstreetmap-overpass");
  assert.equal(answer.header("x-sdn-sites-out"), String(records.length));
  assert.equal(answer.header("x-sdn-reports-in"), String(OVERPASS_IDS.length));
  assert.equal(answer.header("x-sdn-merge-method"), "HIGHEST_SAMPLE_COUNT");
  assert.equal(answer.header("x-sdn-truncated"), "false");
});

test("live lane: an unknown merge method is refused 400 by route, and nothing is fetched", async () => {
  const stub = liveHost();
  const { answer } = await exchange(stub, {
    method: "POST", path: "/api/v1/cellular/aggregate", query: "format=json",
    body: JSON.stringify({ PROVIDERS: ["openstreetmap-overpass"], METHOD: "VIBES", BBOX: BERLIN, REFRESH: true }),
  });
  assert.equal(answer.status, 400);
  const error = JSON.parse(Buffer.from(answer.body).toString("utf8"));
  assert.equal(error.code, "unknown-method");
  assert.equal(fetches(stub).length, 0);
});

test("live lane: a run with nothing fetchable answers an empty dataset and names why, without fetching", async () => {
  const stub = liveHost();
  const { answer } = await exchange(stub, {
    method: "POST", path: "/api/v1/cellular/aggregate",
    body: JSON.stringify({ PROVIDERS: ["opencellid", "no-such-registry"], REFRESH: true }),
  });
  assert.equal(answer.status, 200);
  assert.equal(fetches(stub).length, 0);
  // an empty dataset is answered as its $DAV alone
  assert.equal(answer.header("content-type"), "application/x-flatbuffers");
  assert.equal(Number(unpack("DAV", answer.body).RECORD_COUNT), 0);
  const skipped = answer.header("x-sdn-providers-skipped");
  assert.match(skipped, /opencellid=needs-mediator/);
  assert.match(skipped, /no-such-registry=unknown-provider/);
});

// ── the credential lane ─────────────────────────────────────────────────────

const SLOT = crypto.generateKeyPairSync("x25519");
const SLOT_PUBLIC_RAW = SLOT.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const INFO = "sdn-server/keyslot.unwrap/v1";

function seal(plaintext) {
  const eph = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: SLOT.publicKey });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32));
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    slotId: "provider-wrapping",
    ephemeralPublicKey: eph.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
function open(ephemeralRaw, nonce, ciphertext) {
  const ephemeral = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(ephemeralRaw)]), format: "der", type: "spki" });
  const shared = crypto.diffieHellman({ privateKey: SLOT.privateKey, publicKey: ephemeral });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32));
  const body = Buffer.from(ciphertext);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(nonce));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}

function credentialHost(store = new Map()) {
  return createHostStub({
    "plugin.getConfig": configHandler({}),
    "node.publicKey": () => ({ raw: { value: SLOT_PUBLIC_RAW.toString("hex") } }),
    "secrets.status": (c) => ({ result: { ID: c.params.ID, CONFIGURED: store.has(c.params.ID) } }),
    "keyslot.unwrap": (c) => {
      assert.equal(c.params.SLOT_ID, "provider-wrapping");
      return { raw: { data: open(c.raw.ephemeral_public_key, c.raw.nonce, c.raw.ciphertext) } };
    },
    "secrets.put": (c) => {
      store.set(c.params.ID, { username: c.params.USERNAME ?? "", secret: Buffer.from(c.raw.secret).toString("utf8") });
      return { result: { ID: c.params.ID, CONFIGURED: true } };
    },
    "secrets.clear": (c) => { store.delete(c.params.ID); return {}; },
  });
}

test("credential lane: the catalog says which lanes are held and publishes the node's real key slot", async () => {
  const stub = credentialHost(new Map([["cell_opencellid", { secret: "x" }]]));
  const { answer } = await exchange(stub, { method: "GET", path: "/api/v1/cellular/providers" });
  assert.equal(answer.status, 200);
  const { rows } = readPage(answer.body);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.ok(byId.opencellid && byId["openstreetmap-overpass"]);
  assert.equal(byId.opencellid.credentialRequired, true);
  assert.equal(byId.opencellid.credentialConfigured, true, "the held lane is reported as held");
  assert.equal(byId.opencellid.defaultSelected, true);
  assert.equal(byId["opencellid-bulk"].credentialConfigured, false, "an unheld lane is not");
  assert.equal(byId["openstreetmap-overpass"].credentialRequired, false);
  for (const r of rows) {
    assert.equal(r.keySlotId, "provider-wrapping");
    assert.equal(r.keySlotAlgorithm, "X25519");
    assert.deepEqual(Buffer.from(r.keySlotPublicKey), SLOT_PUBLIC_RAW, "the node's own X25519 public half, never invented");
  }
  // and rendered for a browser: the key as base64, exactly what WebCrypto imports
  const json = await exchange(credentialHost(), { method: "GET", path: "/api/v1/cellular/providers", query: "format=json" });
  const listed = JSON.parse(Buffer.from(json.answer.body).toString("utf8"));
  assert.equal(listed[0].keySlotPublicKey, SLOT_PUBLIC_RAW.toString("base64"));
});

test("credential lane: a sealed PUT is opened by the host and stored, and the secret is echoed nowhere", async () => {
  const store = new Map();
  const stub = credentialHost(store);
  const secret = "ocid-token-5f3e9a";
  const envelope = seal(JSON.stringify({ username: "", secret }));
  const { answer, egress } = await exchange(stub, {
    method: "PUT", path: "/api/v1/cellular/credentials/opencellid", body: JSON.stringify(envelope),
    headers: { "content-type": "application/json" },
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(store.get("cell_opencellid"), { username: "", secret });
  const { rows } = readPage(answer.body);
  assert.deepEqual(rows, [{ providerId: "opencellid", credentialLane: "cell_opencellid", credentialConfigured: true, stored: true }]);
  const everything = Buffer.concat(egress.map((e) => Buffer.from(e.body ?? [])));
  assert.ok(!everything.includes(Buffer.from(secret)), "no egress byte carries the secret");

  // DELETE clears it and answers identically whether or not anything was there
  const cleared = await exchange(stub, { method: "DELETE", path: "/api/v1/cellular/credentials/opencellid" });
  assert.equal(cleared.answer.status, 200);
  assert.equal(store.has("cell_opencellid"), false);
  const again = await exchange(stub, { method: "DELETE", path: "/api/v1/cellular/credentials/opencellid" });
  assert.deepEqual(readPage(again.answer.body).rows, readPage(cleared.answer.body).rows, "no presence oracle");
});

test("credential lane: an unsealed credential, an unknown provider and a login-free provider are refused", async () => {
  const stub = credentialHost();
  const unsealed = await exchange(stub, {
    method: "PUT", path: "/api/v1/cellular/credentials/opencellid", query: "format=json", body: JSON.stringify({ secret: "plain" }),
  });
  assert.equal(unsealed.answer.status, 400);
  assert.equal(JSON.parse(Buffer.from(unsealed.answer.body).toString("utf8")).code, "unsealed-credential");
  assert.equal(stub.calls.filter((c) => c.operation === "secrets.put" || c.operation === "keyslot.unwrap").length, 0);

  const unknown = await exchange(stub, { method: "PUT", path: "/api/v1/cellular/credentials/nope", query: "format=json", body: "{}" });
  assert.equal(unknown.answer.status, 404);
  assert.equal(JSON.parse(Buffer.from(unknown.answer.body).toString("utf8")).code, "unknown-provider");

  const free = await exchange(stub, { method: "DELETE", path: "/api/v1/cellular/credentials/openstreetmap-overpass", query: "format=json" });
  assert.equal(free.answer.status, 400);
  assert.equal(JSON.parse(Buffer.from(free.answer.body).toString("utf8")).code, "credential-not-required");
});
