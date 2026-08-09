// The REFERENCE contract for graph task
// `modules-guest-nodes-drop-batched-frames`: ONE RESPONSE FRAME PER REQUEST
// FRAME, in input order, INCLUDING failures.
//
// This node is the one that already paid for the class defect. The compiled
// flow runtime's `space_data_module_runtime_begin_node_invocation` pops a
// node's WHOLE queue port-blind (budget 64) while `maxStreams`, `maxBatch` and
// `drainPolicy` stay purely declarative, so when
// `data-source/cell-tower-source::route` fanned out N provider descriptors, all
// N arrived here in ONE invocation — and this entry read
// `plugin_get_input_frame(0)` and returned. Measured live on host-01 from the
// daemon's own connector ledger (`fetch_events`, written by
// caps.SetFetchObserver — not a harness): a two-provider request incremented
// exactly ONE url's fetch_count, always the first descriptor's, and the answer
// was byte-identical to that provider run alone (live P1
// `cellular-multiprovider-returns-only-first-provider`).
//
// None of that was ever asserted here, because every behavioural test in the
// sibling suite was dead: the fixtures omitted the aligned-typeRef fields the
// SDK invoke codec requires, so the invoke threw before the wasm was entered
// and the suite failed identically against old and new artifacts. Both are
// repaired under this task; this file asserts the contract itself.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requestInput(url) {
  const payload = encoder.encode(JSON.stringify({ url, method: "GET" }));
  return {
    portId: "request",
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

// Answers every url with a body naming it, so a response can be traced back to
// the request it belongs to — which is the whole point of the ordering
// contract. `failUrls` maps a url to the host error it raises.
function createStub({ failUrls = {} } = {}) {
  const urls = [];
  const dispatch = (operation, params) => {
    if (operation !== "http.request") throw new Error(`unexpected hostcall: ${operation}`);
    const url = String(params.url);
    urls.push(url);
    if (failUrls[url]) throw new Error(failUrls[url]);
    return {
      url,
      status: 200,
      statusText: "OK",
      ok: true,
      headers: { "content-type": "text/plain" },
      body: encoder.encode(`body-for:${url}`),
    };
  };
  return { urls, dispatch };
}

async function invoke(t, inputs, stub) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId: "request", inputs });
}

function slots(response) {
  return response.outputs.map((frame) => {
    assert.equal(frame.portId, "response");
    return JSON.parse(decoder.decode(new Uint8Array(frame.payload)));
  });
}

function bodyOf(slot) {
  return decoder.decode(Uint8Array.from(atob(slot.bodyB64), (c) => c.charCodeAt(0)));
}

const URLS = ["https://a.test/1", "https://b.test/2", "https://c.test/3"];

test("every request frame in a batch produces its own outbound fetch", async (t) => {
  const stub = createStub();
  const response = await invoke(t, URLS.map(requestInput), stub);
  assert.equal(response.statusCode, 0, response.errorMessage);
  // The exact figure the live ledger showed as 1-instead-of-N.
  assert.deepEqual(stub.urls, URLS, "one fetch per descriptor, in descriptor order");
});

test("responses come back one per request, in input order", async (t) => {
  const stub = createStub();
  const response = await invoke(t, URLS.map(requestInput), stub);
  const answers = slots(response);
  assert.equal(answers.length, URLS.length);
  answers.forEach((slot, i) => {
    assert.equal(slot.status, 200);
    assert.equal(bodyOf(slot), `body-for:${URLS[i]}`, `response ${i} must answer request ${i}`);
  });
});

test("a failed request STILL occupies its slot, so later responses do not shift left", async (t) => {
  // This is the assertion that matters most. A failure emitting nothing moves
  // every later body one slot left, and a positional consumer downstream
  // (cell-tower-source::parse correlates responses to providers by emission
  // order) then attributes a payload to a provider that never served it — a
  // mast published under a regulator's name that never asserted it.
  const stub = createStub({ failUrls: { [URLS[1]]: "origin not permitted by this host" } });
  const response = await invoke(t, URLS.map(requestInput), stub);
  const answers = slots(response);

  assert.equal(answers.length, 3, "the failed request must not vanish from the sequence");
  assert.equal(answers[0].status, 200);
  assert.equal(bodyOf(answers[0]), `body-for:${URLS[0]}`);

  assert.equal(answers[1].status, 0, "status 0 is outside 2xx: dropped like a 500, slot preserved");
  assert.equal(answers[1].bodyB64, "");
  assert.equal(answers[1].error, "http-request-failed");

  assert.equal(answers[2].status, 200);
  assert.equal(
    bodyOf(answers[2]),
    `body-for:${URLS[2]}`,
    "request 2's body must still be in slot 2, not slot 1",
  );
});

test("partial failure is a partial success, not a batch failure", async (t) => {
  const stub = createStub({ failUrls: { [URLS[0]]: "dead mirror" } });
  const response = await invoke(t, URLS.map(requestInput), stub);
  assert.equal(
    response.statusCode,
    0,
    "one dead mirror must not delete the providers queued behind it",
  );
  assert.deepEqual(stub.urls, URLS, "the batch continues past a failure");
});

test("a batch in which nothing succeeded returns a non-zero status", async (t) => {
  const failUrls = Object.fromEntries(URLS.map((url) => [url, "dead mirror"]));
  const stub = createStub({ failUrls });
  const response = await invoke(t, URLS.map(requestInput), stub);
  assert.notEqual(response.statusCode, 0);
  assert.equal(slots(response).length, 3, "every slot is still accounted for");
});

test("N == 1 behaves exactly as the single-frame node did", async (t) => {
  const stub = createStub();
  const response = await invoke(t, [requestInput(URLS[0])], stub);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const answers = slots(response);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].status, 200);
  assert.equal(bodyOf(answers[0]), `body-for:${URLS[0]}`);
});

// ---------------------------------------------------------------------------
// SOURCE LOCK: no port-blind frame-0 reads.
//
// `plugin_get_input_frame(0)` takes the invocation's FIRST frame regardless of
// which port it arrived on, and frame 0 is NOT promised to be on any particular
// port — the compiled runtime hands a node whatever is queued on it, in queue
// order. hostcap/flatsql-query::query executed SQL from such a read and
// ::sandbox_query fell back to one when it could not find its `decision` port:
// not a dropped frame, a CONFUSED one, which is worse. Port-filtered access
// (`plugin_find_input_index(port, ordinal)`) is the only admissible form.
//
// This is asserted against the source because the harness cannot express the
// failure: it validates portIds against the manifest before the invoke, so an
// off-port frame never reaches the guest here. It does in a baked flow.
test("hostcap/http-request source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/http_request_module.cpp", import.meta.url)), "utf8");
  const offenders = source
    .split("\n")
    .map((line, i) => [i + 1, line])
    // Comment lines are excluded: several of these modules DOCUMENT the defect
    // by quoting the offending call, and a lock that cannot tell an
    // explanation from a call would push the explanation out of the source.
    .filter(([, line]) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
      return code.includes("plugin_get_input_frame(0)");
    });
  assert.deepEqual(
    offenders,
    [],
    `port-blind frame-0 read(s): ${offenders.map(([n, l]) => `${n}: ${l.trim()}`).join(" | ")}`,
  );
});
