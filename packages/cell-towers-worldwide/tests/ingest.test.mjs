import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ingestRecords,
  normalizeProviderRecord,
  parseCsv,
  recordsFromPayload,
  resolveProviderEndpoint,
} from "../src/index.mjs";

const fixtureUrl = new URL("./fixtures/opencellid.csv", import.meta.url);

test("OpenCelliD CSV normalizes identity, coordinates, cell metadata, and provenance", async () => {
  const rows = parseCsv(await readFile(fixtureUrl, "utf8"));
  const result = ingestRecords("opencellid", rows, { retrievedAt: "2026-08-05T12:00:00.000Z" });

  assert.equal(result.statistics.input, 3);
  assert.equal(result.statistics.duplicates, 1);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records[0], {
    id: "opencellid:LTE:310:260:40495:17811",
    nativeId: undefined,
    radio: "LTE",
    mcc: 310,
    mnc: 260,
    lac: 40495,
    tac: undefined,
    cellId: "17811",
    latitude: 40.7484,
    longitude: -73.9857,
    rangeMeters: 450,
    samples: 12,
    operator: undefined,
    frequencyMhz: undefined,
    siteName: undefined,
    countryCode: undefined,
    observedAt: "1710000000",
    provenance: {
      providerId: "opencellid",
      authority: "Unwired Labs / OpenCelliD contributors",
      // CORRECTED 2026-08-14: the provenance URL follows the registry, and the
      // registry's bulk endpoint is no longer the human download page.
      sourceUrl:
        "https://opencellid.org/ocid/downloads?token=<token>&type=full&file=cell_towers.csv.gz",
      retrievedAt: "2026-08-05T12:00:00.000Z",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://wiki.opencellid.org/wiki/Menu_map_view",
      attribution: "OpenCelliD Project (https://opencellid.org/)",
    },
  });
});

test("OpenStreetMap elements normalize without an application-specific host adapter", () => {
  const tower = normalizeProviderRecord("openstreetmap-overpass", {
    type: "node",
    id: 1234,
    lat: 48.8566,
    lon: 2.3522,
    tags: {
      man_made: "mast",
      "communication:mobile_phone": "yes",
      operator: "Example Mobile",
      name: "Paris test fixture",
    },
  }, { retrievedAt: "2026-08-05T12:00:00.000Z" });

  assert.equal(tower.id, "openstreetmap-overpass:node/1234");
  assert.equal(tower.radio, "CELLULAR_SITE");
  assert.equal(tower.operator, "Example Mobile");
  assert.equal(tower.latitude, 48.8566);
  assert.equal(tower.provenance.license, "ODbL 1.0");
});

test("invalid coordinates can fail closed or be counted and skipped", () => {
  assert.throws(() => normalizeProviderRecord("opencellid", { lat: 100, lon: 0 }), /invalid latitude/);
  const result = ingestRecords("opencellid", [{ lat: 100, lon: 0 }], { onInvalid: "skip" });
  assert.deepEqual(result.statistics, { input: 1, emitted: 0, duplicates: 0, invalid: 1 });
});

test("CSV parser supports quoted delimiters, escaped quotes, CRLF, and final lines", () => {
  assert.deepEqual(parseCsv('latitude,longitude,operator\r\n1,2,"A, Inc."\r\n3,4,"B ""Mobile"""'), [
    { latitude: "1", longitude: "2", operator: "A, Inc." },
    { latitude: "3", longitude: "4", operator: 'B "Mobile"' },
  ]);
});

test("provider endpoint seam exposes auth metadata without handling secrets", () => {
  const endpoint = resolveProviderEndpoint("opencellid");

  // The load-bearing fields, asserted individually rather than by deep-equal on
  // the whole object. A deep-equal here also pinned the endpoint's PROSE, which
  // meant the registry could not record why a URL had been corrected without
  // failing a test about authentication metadata — and that is how the wrong
  // URL survived: the assertion made documenting the correction expensive.
  assert.equal(endpoint.kind, "bulk");
  assert.equal(endpoint.providerId, "opencellid");
  assert.equal(endpoint.refresh, "daily");

  // CORRECTED 2026-08-14 (graph: mod-cell-tower-opencellid-bulk). This asserted
  // `https://opencellid.org/downloads.php` + `csv-zip`. Both were wrong: that
  // URL is the human download PAGE (verified live: 200, text/html, 14,729 B)
  // and the real export is GZIP, not ZIP.
  assert.equal(
    endpoint.url,
    "https://opencellid.org/ocid/downloads?token=<token>&type=full&file=cell_towers.csv.gz",
  );
  assert.equal(endpoint.format, "csv-gz");

  // The seam publishes WHERE the credential comes from and never the credential.
  assert.equal(endpoint.loginRequired, true);
  assert.equal(endpoint.credentialEnv, "OPENCELLID_TOKEN");
  assert.equal(endpoint.registrationUrl, "https://opencellid.org/");
  assert.equal(endpoint.termsUrl, "https://wiki.opencellid.org/wiki/Server_usage_policy");
  for (const key of ["token", "secret", "credential", "key", "apiKey", "password"]) {
    assert.equal(key in endpoint, false, `the endpoint seam exposes a ${key} field`);
  }
});

test("payload seam handles Overpass JSON and rejects discovery-only catalogs", () => {
  const records = recordsFromPayload("openstreetmap-overpass", { elements: [{ type: "node", id: 9 }] });
  assert.deepEqual(records, [{ type: "node", id: 9 }]);
  assert.throws(() => recordsFromPayload("cellmapper", "<html>"), /discovery-only/);
});
