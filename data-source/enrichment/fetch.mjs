#!/usr/bin/env node
/**
 * Polite, cache-first, ledger-backed fetcher for the catalog-enrichment sources.
 *
 * This is the LOCAL VERIFICATION harness and the fixture generator. It is NOT
 * the production retriever — production fetching happens in-WASM through the
 * hostcap/http-request connector, exactly like the celestrak family. What this
 * file guarantees is that the fetch DISCIPLINE recorded in source-policy.json
 * is executable and checkable rather than aspirational:
 *
 *   - serial only, never concurrent, minimum delay between requests
 *   - a UA that names the project and a human contact
 *   - conditional requests (If-None-Match / If-Modified-Since) on re-fetch
 *   - a debounce ledger: a body inside its window is NOT re-requested at all
 *   - every body cached with sha256 + the response validators
 *
 * Refusing to fetch is a SUCCESS path here, not an error. `node fetch.mjs`
 * twice in a row must produce exactly one set of network requests.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = JSON.parse(readFileSync(join(HERE, "source-policy.json"), "utf8"));
const CACHE = join(HERE, "cache");
const LEDGER_PATH = join(CACHE, "ledger.json");

const UA = POLICY.fetchDiscipline.userAgent;
const MIN_DELAY_MS = POLICY.fetchDiscipline.minDelaySeconds * 1000;

/** Only sources this policy actually cleared may be fetched. Fail closed. */
function assertPermitted(sourceId) {
  const src = POLICY.sources.find((s) => s.id === sourceId);
  if (!src) throw new Error(`source ${sourceId} is not in source-policy.json — refusing to fetch`);
  if (!/^PERMITTED/.test(src.access)) {
    throw new Error(
      `source ${sourceId} access is "${src.access}" — refusing to fetch. ` +
        `A source that has not been cleared is not fetched, and this is not overridable from code.`,
    );
  }
  return src;
}

const TARGETS = [
  {
    sourceId: "gcat",
    key: "gcat-satcat",
    url: "https://planet4589.org/space/gcat/tsv/cat/satcat.tsv",
    debounceHours: 168, // weekly — GCAT updates on the order of days
    why: "manufacturer, bus, mass (dry/total), length/diameter/span/shape, launch date, type, owner",
  },
  {
    sourceId: "gcat",
    key: "gcat-psatcat",
    url: "https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv",
    debounceHours: 168,
    why: "program, class, category, discipline — the mission/purpose classification",
  },
  {
    sourceId: "gcat",
    key: "gcat-orgs",
    url: "https://planet4589.org/space/gcat/tsv/tables/orgs.tsv",
    debounceHours: 168,
    why: "MANDATORY code resolution: GCAT ships Manufacturer/Owner as short codes (SPXS, KHRR). This table maps Code -> ShortName/Name/StateCode/Parent. Without it the query surface exposes codes and looks broken.",
  },
  {
    sourceId: "satnogs-db",
    key: "satnogs-satellites",
    url: "https://db.satnogs.org/api/satellites/?format=json",
    debounceHours: 24,
    why: "operator, countries, launched/deployed/decayed, alternate names, per-record citation",
  },
  {
    sourceId: "satnogs-db",
    key: "satnogs-transmitters",
    url: "https://db.satnogs.org/api/transmitters/?format=json",
    debounceHours: 24,
    why: "downlink/uplink frequencies (Hz), mode, baud, invert, service, status, IARU coordination",
  },
];

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return {};
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return {};
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const ledger = loadLedger();
  const now = Date.now();
  let networkRequests = 0;
  const report = [];

  for (const t of TARGETS) {
    const src = assertPermitted(t.sourceId);
    const prev = ledger[t.key];
    const bodyPath = join(CACHE, `${t.key}.body`);

    // --- debounce: the politest request is the one never sent -------------
    if (prev && existsSync(bodyPath)) {
      const ageMs = now - new Date(prev.fetchedAt).getTime();
      if (ageMs < t.debounceHours * 3600 * 1000) {
        const ageH = (ageMs / 3600000).toFixed(1);
        report.push({ key: t.key, action: "DEBOUNCED", detail: `cached ${ageH}h ago < ${t.debounceHours}h window` });
        continue;
      }
    }

    if (networkRequests > 0) await sleep(MIN_DELAY_MS); // serial + spaced
    networkRequests += 1;

    const headers = { "User-Agent": UA, Accept: "*/*" };
    if (prev?.etag) headers["If-None-Match"] = prev.etag;
    if (prev?.lastModified) headers["If-Modified-Since"] = prev.lastModified;

    const started = Date.now();
    let res;
    try {
      res = await fetch(t.url, { headers, redirect: "follow" });
    } catch (err) {
      report.push({ key: t.key, action: "NETWORK-ERROR", detail: String(err?.message ?? err) });
      continue; // never retry-storm; the next scheduled run tries again
    }

    if (res.status === 304) {
      ledger[t.key] = { ...prev, fetchedAt: new Date().toISOString(), lastStatus: 304 };
      report.push({ key: t.key, action: "304-NOT-MODIFIED", detail: "operator paid almost nothing" });
      continue;
    }
    if (!res.ok) {
      report.push({ key: t.key, action: `HTTP-${res.status}`, detail: res.statusText });
      continue;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const digest = sha256(buf);
    const changed = prev?.sha256 !== digest;
    writeFileSync(bodyPath, buf);

    ledger[t.key] = {
      sourceId: t.sourceId,
      url: t.url,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      bytes: buf.length,
      sha256: digest,
      etag: res.headers.get("etag") ?? null,
      lastModified: res.headers.get("last-modified") ?? null,
      lastStatus: res.status,
      // Licence travels WITH the bytes. A cached body whose licence is not
      // recorded alongside it is a body nobody can lawfully publish later.
      license: src.licenseName ?? null,
      licenseUrl: src.licenseUrl ?? null,
      citation: src.citationText ?? null,
      shareAlike: src.shareAlike ?? false,
      why: t.why,
    };
    report.push({
      key: t.key,
      action: changed ? "FETCHED-CHANGED" : "FETCHED-IDENTICAL",
      detail: `${(buf.length / 1048576).toFixed(2)} MB, sha ${digest.slice(0, 12)}`,
    });
  }

  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
  for (const r of report) console.log(`  ${r.action.padEnd(20)} ${r.key.padEnd(24)} ${r.detail}`);
  console.log(`\n  network requests issued: ${networkRequests} / ${TARGETS.length} targets`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
