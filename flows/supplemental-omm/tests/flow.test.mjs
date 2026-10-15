// The Supplemental OMM flow end to end on typed contracts 1.0: the release bundle scripts/release.mjs builds (signed
// with a key generated for the test and thrown away), every node an isomorphic child of it, run in the SDK's
// isomorphic flow host. One TimerTick starts the five sources; their fetches are hostcap/http-request children answered
// here from the source modules' provider fixtures; their $OEM reach the OD node; each fit's $OMM, $OCM and $OBD go to
// hostcap/storage-ingest children (storage.ingest_with_source answered here) and each stored batch is published.
//
// Equivalence: the records the flow stores are the records the legacy flow (release 1.0.1: provider copies, FSB
// transport, FlatSQL and pubsub nodes) published for the same provider fixtures (tests/fixtures/legacy), byte for byte,
// but for LAGEOS-1's: data-source/cpf-source writes the ILRS id as the international designator (OBJECT_ID 1976-039A,
// the legacy node wrote 7603901), and only that differs (tests/od-node.test.mjs fits the source's $OEM with the legacy
// identity and gets the legacy records exactly).
import assert from "node:assert/strict";
import test from "node:test";

import { CODE_SP3, PUBLISH_URL, fixtureResponses, legacyRecords, runRelease, sha256 } from "./lib/flow.mjs";
import { decodeIngestResult, decodeOmmRecord } from "./lib/sds.mjs";

const CONFIG = {
  // The legacy flow's GLONASS feed (CODE's ultra-rapid SP3); glonass-source's default is the IAC's ftp:// product.
  "com.orbpro.glonass-source": { sourceUrl: CODE_SP3 },
  "org.sdn.flows.supplemental-omm.od": { omm_publish_url: PUBLISH_URL },
};
const SOURCES = {
  "spacex-starlink": 2,
  glonass: 25,
  intelsat: 1,
  cpf: 1,
  iss: 1,
};

let run;
const flowRun = async () => (run ??= await runRelease({ config: CONFIG }));

test("one tick: every source fetched through hostcap/http-request, every object fitted, stored and published", async () => {
  const { calls, ingests, egress } = await flowRun();
  const gets = calls.filter((c) => c.operation === "http.request" && c.params.method === "GET");
  assert.deepEqual(gets.map((c) => c.pluginId), gets.map(() => "com.digitalarsenal.hostcap.http-request"), "only the http-request children fetch");
  assert.deepEqual(
    gets.map((c) => c.params.url.replace(/^https:\/\/([^/]+)\/.*$/, "$1")).sort(),
    ["api.starlink.com", "api.starlink.com", "api.starlink.com", "edc.dgfi.tum.de", "edc.dgfi.tum.de", "my.intelsat.com", "my.intelsat.com", "nasa-public-data.s3.amazonaws.com", "www.aiub.unibe.ch"],
  );
  assert.ok(gets.filter((c) => /MEME_/.test(c.params.url)).every((c) => c.params.headers.range === "bytes=0-131071"), "Starlink files by their leading range");

  // Every object: one batch per standard, filed under its provider's source name.
  assert.equal(ingests.length, 3 * 30);
  for (const [source, objects] of Object.entries(SOURCES)) {
    for (const schema of ["OMM.fbs", "OCM.fbs", "OBD.fbs"]) {
      assert.equal(ingests.filter((i) => i.source_name === source && i.schema === schema).length, objects, `${source} ${schema}`);
    }
  }
  for (const ingest of ingests) {
    assert.equal(ingest.provider_id, "supplemental-omm");
    assert.equal(ingest.content_key_id, "public");
    assert.equal(ingest.batch_id, sha256(Buffer.concat(ingest.records)), "BATCH_ID is the SHA-256 of the stream");
    assert.equal(ingest.reconcile, "duplicates");
  }
  assert.equal(calls.filter((c) => c.operation === "storage.ingest_with_source").every((c) => c.pluginId === "com.digitalarsenal.hostcap.storage-ingest"), true);

  // Every stored batch published: the POST body the IngestResult naming it.
  const posts = calls.filter((c) => c.operation === "http.request" && c.params.url === PUBLISH_URL);
  assert.equal(posts.length, 90);
  assert.equal(egress.results.length, 90);
  assert.equal(egress.publications.length, 90);
  assert.ok(egress.publications.every((p) => p.status === 202));
  const posted = posts.map((c) => decodeIngestResult(c.params.body));
  assert.deepEqual(posted.map((r) => r.batchId).sort(), ingests.map((i) => i.batch_id).sort());
  assert.ok(posted.every((r) => r.providerId === "supplemental-omm" && r.inserted > 0n));

  // The OD node's notices: one per object, every one fitted.
  const fitted = egress.notices.filter((n) => n.reason === "fitted");
  assert.equal(fitted.length, 30);
  assert.ok(egress.notices.every((n) => n.reason === "fitted"), JSON.stringify(egress.notices.filter((n) => n.reason !== "fitted")));
  assert.ok(fitted.some((n) => n.items[0] === "OD fit complete: lageos1 (NORAD 8820)"));
  assert.ok(fitted.some((n) => n.items[0] === "OD fit complete: ISS (NORAD 25544)"));
});

test("the stored records are the legacy flow's for the same provider input; LAGEOS-1 differs only in OBJECT_ID", async () => {
  const { ingests } = await flowRun();
  for (const standard of ["OMM", "OCM", "OBD"]) {
    const stored = ingests.filter((i) => i.schema === `${standard}.fbs`).flatMap((i) => i.records);
    const legacy = legacyRecords(standard);
    assert.equal(stored.length, legacy.length, standard);
    const legacyHashes = new Set(legacy.map(sha256));
    const fresh = stored.filter((r) => !legacyHashes.has(sha256(r)));
    assert.equal(fresh.length, 1, `${standard}: every record but LAGEOS-1's is byte-identical to the legacy flow's`);
    const cpf = ingests.find((i) => i.schema === `${standard}.fbs` && i.source_name === "cpf").records;
    assert.deepEqual(fresh, cpf);
  }
  const legacyLageos = legacyRecords("OMM").map(decodeOmmRecord).find((o) => o.OBJECT_NAME === "lageos1");
  const lageos = decodeOmmRecord(ingests.find((i) => i.schema === "OMM.fbs" && i.source_name === "cpf").records[0]);
  assert.equal(legacyLageos.OBJECT_ID, "7603901");
  assert.equal(lageos.OBJECT_ID, "1976-039A");
  assert.deepEqual({ ...lageos, OBJECT_ID: legacyLageos.OBJECT_ID }, { ...legacyLageos }, "the fitted elements are the legacy's");
});

test("the status board: every provider lane, the OD lane and the store lane", async () => {
  const { routes } = await flowRun();
  const row = (key) => {
    const dss = routes.get(key);
    assert.ok(dss, `${key} was emitted`);
    return [dss.STATUS, Number(dss.SYNCED_ROWS), Number(dss.TOTAL_ROWS), Number(dss.MISSING_ROWS), dss.ERROR ?? null];
  };
  assert.deepEqual(row("od.dss"), [2, 30, 30, 0, null], "30 objects fitted (SYNCED)");
  assert.deepEqual(row("store.dss"), [2, 93, 93, 0, null], "93 records stored");
  for (const provider of ["starlink", "glonass", "intelsat", "cpf", "iss"]) {
    const [status, synced, total, missing] = row(`provider-${provider}.dss`);
    assert.equal(status, 1);
    assert.ok(synced > 0 && synced === total && missing === 0, `${provider}: ${synced} states`);
  }
});

test("a source that answers nothing: its lane says so, the other sources' objects are still fitted and stored", async () => {
  const responses = fixtureResponses();
  for (const url of [...responses.keys()]) if (url.includes("MEME_67851")) responses.delete(url);
  const { egress, ingests, routes } = await runRelease({ config: CONFIG, responses });
  const missing = egress.notices.filter((n) => n.kind === "missing");
  assert.equal(missing.length, 1);
  assert.match(missing[0].items[0], /STARLINK-36348 \(67851\): HTTP 404/);
  assert.equal(ingests.filter((i) => i.source_name === "spacex-starlink").length, 3, "the other Starlink object");
  assert.equal(ingests.length, 3 * 29);
  const starlink = routes.get("provider-starlink.dss");
  assert.equal(starlink.STATUS, 4);
  assert.equal(Number(starlink.MISSING_ROWS), 1);
  assert.match(starlink.ERROR, /objects-unavailable/);
});
