// foundation/discovery-shape SDK-compat tests (gateway loop G.2): the shape
// nodes join the discovery routing decision with the p2p.*_snapshot hostcall
// envelope and emit decision/body/etag for http-respond — stored $EPM/$PNM
// frames spliced VERBATIM, synthesized minimal EPMs for profile-less peers,
// bare-array JSON presentation, one shared FNV-1a-64 etag per logical stream.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { fnv1a64Hex } from "space-data-module-sdk/http";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { EPM, EntityType } from "../../../../spacedatastandards.org/lib/js/EPM/main.js";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CELESTRAK_PEER = "16Uiu2HAm9oK2jAeVC2RMESFcYfq7BKGp2K2CCDxzoKhB5s9vpbj3";
const OTHER_PEER = "16Uiu2HAm1LbvwjEHW2GDP2ZQZvwHLZrz2jbYoRLQmJEQ3wZ5Fm45";

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

// Build a bare (unprefixed) $EPM buffer with the JS generated code.
function buildEPM({ dn, legalName, alternateNames = [], addrs = [], signature }) {
  const builder = new flatbuffers.Builder(512);
  const dnOffset = dn ? builder.createString(dn) : 0;
  const legalOffset = legalName ? builder.createString(legalName) : 0;
  const altOffset = alternateNames.length
    ? EPM.createAlternateNamesVector(builder, alternateNames.map((name) => builder.createString(name)))
    : 0;
  const addrsOffset = addrs.length
    ? EPM.createMultiformatAddressVector(builder, addrs.map((addr) => builder.createString(addr)))
    : 0;
  const sigOffset = signature ? builder.createString(signature) : 0;
  EPM.startEPM(builder);
  if (dnOffset) EPM.addDn(builder, dnOffset);
  if (legalOffset) EPM.addLegalName(builder, legalOffset);
  if (altOffset) EPM.addAlternateNames(builder, altOffset);
  if (addrsOffset) EPM.addMultiformatAddress(builder, addrsOffset);
  if (sigOffset) EPM.addSignature(builder, sigOffset);
  EPM.addEntityType(builder, EntityType.Node);
  const root = EPM.endEPM(builder);
  EPM.finishEPMBuffer(builder, root);
  return builder.asUint8Array().slice();
}

function sizePrefixedStream(frames) {
  const total = frames.reduce((sum, frame) => sum + 4 + frame.length, 0);
  const stream = new Uint8Array(total);
  const view = new DataView(stream.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, true);
    stream.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return stream;
}

function splitStream(stream) {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const frames = [];
  let offset = 0;
  while (offset + 4 <= stream.length) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length === 0) continue;
    frames.push(stream.subarray(offset, offset + length));
    offset += length;
  }
  return frames;
}

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4 + segments.reduce((sum, seg) => sum + 4 + seg.length, 0);
  const envelope = new Uint8Array(total);
  const view = new DataView(envelope.buffer);
  let offset = 0;
  view.setUint32(offset, metaBytes.length, true);
  envelope.set(metaBytes, offset + 4);
  offset += 4 + metaBytes.length;
  view.setUint32(offset, segments.length, true);
  offset += 4;
  for (const segment of segments) {
    view.setUint32(offset, segment.length, true);
    envelope.set(segment, offset + 4);
    offset += 4 + segment.length;
  }
  return envelope;
}

function input(portId, payload) {
  return { portId, typeRef: { wireFormat: "aligned-binary" }, payload };
}

function jsonInput(portId, value) {
  return input(portId, encoder.encode(JSON.stringify(value)));
}

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  return new Map(response.outputs.map((frame) => [frame.portId, frame]));
}

// Peers snapshot fixture: celestrak has a stored EPM (frame 0), the other
// peer has none (synthesized downstream).
const CELESTRAK_EPM = buildEPM({
  dn: "celestrak",
  legalName: "CelesTrak",
  alternateNames: ["celestrak.eth"],
  addrs: [`/p2p/${CELESTRAK_PEER}`],
  signature: "aa".repeat(64),
});

function peersEnvelope() {
  return encodeHostcallEnvelope(
    {
      ok: true,
      result: {
        self: OTHER_PEER,
        peers: [
          {
            peer_id: CELESTRAK_PEER,
            addrs: ["/ip4/167.172.219.213/tcp/4001"],
            connected: true,
            self: false,
            agent_version: "spacedatanetwork/1.0.4",
            standards: ["CAT", "OMM", "SPW"],
            epm_index: 0,
          },
          {
            peer_id: OTHER_PEER,
            addrs: ["/ip4/104.131.11.220/tcp/4001"],
            connected: true,
            self: true,
            standards: [],
            epm_index: -1,
          },
        ],
        records: { $bin: 0 },
      },
    },
    [sizePrefixedStream([CELESTRAK_EPM])],
  );
}

const PNM_FRAME_A = encoder.encode("fake-pnm-frame-a-bytes__");
const PNM_FRAME_B = encoder.encode("fake-pnm-frame-b");

function standardsEnvelope() {
  return encodeHostcallEnvelope(
    {
      ok: true,
      result: {
        entries: [
          {
            peer_id: CELESTRAK_PEER,
            standard: "OMM",
            schema: "OMM.fbs",
            file_id: "celestrak:gp:OMM.fbs:2026-07-06T03:00:00Z",
            file_name: "gp.fbs",
            cid: "bafy-omm",
            publish_timestamp: "2026-07-06T03:00:00Z",
            pnm_index: 0,
          },
          {
            peer_id: CELESTRAK_PEER,
            standard: "CAT",
            schema: "CAT.fbs",
            file_id: "celestrak:satcat:CAT.fbs:2026-07-06T02:00:00Z",
            cid: "bafy-cat",
            publish_timestamp: "2026-07-06T02:00:00Z",
            pnm_index: 1,
          },
        ],
        records: { $bin: 0 },
      },
    },
    [sizePrefixedStream([PNM_FRAME_A, PNM_FRAME_B])],
  );
}

test("foundation/discovery-shape artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("peers_list flatbuffer: stored EPM verbatim + synthesized EPM, shared etag", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "shape_peers",
    inputs: [
      jsonInput("decision", { route: "peers_list", format: "flatbuffer" }),
      input("snapshot", peersEnvelope()),
    ],
  });
  const byPort = outputsByPort(response);
  const body = byPort.get("body").payload;
  const frames = splitStream(body);
  assert.equal(frames.length, 2, "one $EPM frame per peer");

  // Frame 0: celestrak's stored profile VERBATIM.
  assert.deepEqual(Array.from(frames[0]), Array.from(CELESTRAK_EPM));

  // Frame 1: synthesized minimal EPM for the profile-less peer.
  const synthesized = EPM.getRootAsEPM(new flatbuffers.ByteBuffer(frames[1].slice()));
  assert.equal(synthesized.DN(), OTHER_PEER);
  assert.equal(synthesized.MULTIFORMAT_ADDRESS(0), `/p2p/${OTHER_PEER}`);
  assert.equal(synthesized.MULTIFORMAT_ADDRESS(1), "/ip4/104.131.11.220/tcp/4001");
  assert.equal(synthesized.ENTITY_TYPE(), EntityType.Node);
  assert.equal(synthesized.SIGNATURE(), null, "synthesized profiles are unsigned");

  // etag: word-folded FNV-1a-64 over exactly the body bytes.
  const etag = decoder.decode(byPort.get("etag").payload);
  assert.equal(etag, `W/"fnv1a64-${fnv1a64Hex(body)}"`);

  // decision passthrough.
  assert.equal(JSON.parse(decoder.decode(byPort.get("decision").payload)).route, "peers_list");
});

test("peers_list json: bare array presentation; etag matches the fb encoding", async (t) => {
  const harness = await createHarness(t);
  const fb = await harness.invoke({
    methodId: "shape_peers",
    inputs: [
      jsonInput("decision", { route: "peers_list", format: "flatbuffer" }),
      input("snapshot", peersEnvelope()),
    ],
  });
  const json = await harness.invoke({
    methodId: "shape_peers",
    inputs: [
      jsonInput("decision", { route: "peers_list", format: "json" }),
      input("snapshot", peersEnvelope()),
    ],
  });
  const fbPorts = outputsByPort(fb);
  const jsonPorts = outputsByPort(json);

  assert.equal(
    decoder.decode(jsonPorts.get("etag").payload),
    decoder.decode(fbPorts.get("etag").payload),
    "identical logical stream => identical tag on both encodings",
  );

  const records = JSON.parse(decoder.decode(jsonPorts.get("body").payload));
  assert.ok(Array.isArray(records), "json body is a BARE top-level array");
  assert.equal(records.length, 2);

  const celestrak = records[0];
  assert.equal(celestrak.peer_id, CELESTRAK_PEER);
  assert.equal(celestrak.connected, true);
  assert.equal(celestrak.self, false);
  assert.equal(celestrak.agent_version, "spacedatanetwork/1.0.4");
  assert.deepEqual(celestrak.standards, ["CAT", "OMM", "SPW"]);
  assert.equal(celestrak.epm.dn, "celestrak");
  assert.equal(celestrak.epm.legal_name, "CelesTrak");
  assert.deepEqual(celestrak.epm.alternate_names, ["celestrak.eth"]);
  assert.equal(celestrak.epm.entity_type, "Node");
  assert.equal(celestrak.epm.signed, true);

  const other = records[1];
  assert.equal(other.peer_id, OTHER_PEER);
  assert.equal(other.self, true);
  assert.equal(other.agent_version, null);
  assert.equal(other.epm, null, "no stored profile => epm null in json");
});

test("peer_get selects one peer; unknown ids rewrite to not_found", async (t) => {
  const harness = await createHarness(t);
  const hit = await harness.invoke({
    methodId: "shape_peers",
    inputs: [
      jsonInput("decision", { route: "peer_get", format: "json", peerId: CELESTRAK_PEER }),
      input("snapshot", peersEnvelope()),
    ],
  });
  const hitPorts = outputsByPort(hit);
  const records = JSON.parse(decoder.decode(hitPorts.get("body").payload));
  assert.equal(records.length, 1);
  assert.equal(records[0].peer_id, CELESTRAK_PEER);

  const miss = await harness.invoke({
    methodId: "shape_peers",
    inputs: [
      jsonInput("decision", { route: "peer_get", format: "json", peerId: "16Uiu2Nobody" }),
      input("snapshot", peersEnvelope()),
    ],
  });
  const missPorts = outputsByPort(miss);
  const decision = JSON.parse(decoder.decode(missPorts.get("decision").payload));
  assert.equal(decision.route, "not_found");
  assert.match(decision.error, /unknown to this node/);
  assert.equal(missPorts.has("body"), false, "no body on not_found");
  assert.equal(missPorts.has("etag"), false, "no etag on not_found");
});

test("standards: $PNM frames verbatim in entry order + json presentation", async (t) => {
  const harness = await createHarness(t);
  const fb = await harness.invoke({
    methodId: "shape_standards",
    inputs: [
      jsonInput("decision", { route: "standards", format: "flatbuffer" }),
      input("snapshot", standardsEnvelope()),
    ],
  });
  const fbPorts = outputsByPort(fb);
  const frames = splitStream(fbPorts.get("body").payload);
  assert.equal(frames.length, 2);
  assert.deepEqual(Array.from(frames[0]), Array.from(PNM_FRAME_A));
  assert.deepEqual(Array.from(frames[1]), Array.from(PNM_FRAME_B));

  const json = await harness.invoke({
    methodId: "shape_standards",
    inputs: [
      jsonInput("decision", { route: "standards", format: "json" }),
      input("snapshot", standardsEnvelope()),
    ],
  });
  const jsonPorts = outputsByPort(json);
  assert.equal(
    decoder.decode(jsonPorts.get("etag").payload),
    decoder.decode(fbPorts.get("etag").payload),
  );
  const records = JSON.parse(decoder.decode(jsonPorts.get("body").payload));
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    peer_id: CELESTRAK_PEER,
    standard: "OMM",
    schema: "OMM.fbs",
    file_id: "celestrak:gp:OMM.fbs:2026-07-06T03:00:00Z",
    file_name: "gp.fbs",
    cid: "bafy-omm",
    publish_timestamp: "2026-07-06T03:00:00Z",
  });
  assert.equal(records[1].standard, "CAT");
  assert.equal(records[1].file_name, null, "absent snapshot fields present as null");
});

test("a failed snapshot envelope is a node error; not_found passes through", async (t) => {
  const harness = await createHarness(t);
  const failed = await harness.invoke({
    methodId: "shape_peers",
    inputs: [
      jsonInput("decision", { route: "peers_list", format: "json" }),
      input("snapshot", encodeHostcallEnvelope({ ok: false, error: { message: "p2p offline" } })),
    ],
  });
  assert.notEqual(failed.statusCode, 0);

  const notFound = await harness.invoke({
    methodId: "shape_peers",
    inputs: [
      jsonInput("decision", { route: "not_found", format: "json", error: "no route" }),
      input("snapshot", encodeHostcallEnvelope({ ok: true, result: {} })),
    ],
  });
  const ports = outputsByPort(notFound);
  assert.equal(JSON.parse(decoder.decode(ports.get("decision").payload)).route, "not_found");
  assert.equal(ports.has("body"), false);
});
