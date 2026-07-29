#!/usr/bin/env node
/**
 * Gunter's Space Page retriever — Wayback-first, facts-only, always cited.
 *
 * OWNER RULING 2026-07-29, verbatim: "Look in Google cache for Gunter's stuff,
 * I have an account so it is ok." Google's cache service was discontinued in
 * 2024, so the cached route is the Wayback Machine, which holds 5,535 distinct
 * archived /doc_sdat/ spacecraft pages — effectively the whole site.
 *
 * THE CONSTRAINTS ARE THE AUTHORISATION. This retriever exists in the shape it
 * does because that shape is what the ruling permits:
 *
 *   - Wayback snapshots are the DEFAULT path; the live site is a fallback only.
 *   - PERMANENT cache. A page is fetched at most ONCE, ever. There is no
 *     debounce window to expire — `neverRefetch` is absolute.
 *   - FACTS ONLY. The labelled spec block (Nation, Type/Application, Operator,
 *     Contractors, Equipment, Propulsion, Power, Lifetime, Mass, Orbit) and the
 *     COSPAR designator table. Prose paragraphs are NOT extracted.
 *   - EVERY extracted record carries its page URL, snapshot timestamp and
 *     citation. A fact without a citation is not emitted at all.
 *   - Page text is NEVER republished wholesale.
 *
 * Serial, 2.5s minimum spacing, identifying UA — the standing discipline.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = JSON.parse(readFileSync(join(HERE, "source-policy.json"), "utf8"));
const SRC = POLICY.sources.find((s) => s.id === "gunter-space-page");

if (!/^PERMITTED/.test(SRC.access)) {
  throw new Error(`gunter-space-page access is "${SRC.access}" — refusing to fetch.`);
}

const UA = POLICY.fetchDiscipline.userAgent;
const MIN_DELAY_MS = POLICY.fetchDiscipline.minDelaySeconds * 1000;
const CACHE = join(HERE, "cache", "gunter");
const CDX = "https://web.archive.org/cdx/search/cdx";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** The labelled fields Gunter renders as a spec block. Facts, not prose. */
const SPEC_LABELS = [
  "Nation",
  "Type / Application",
  "Operator",
  "Contractors",
  "Equipment",
  "Configuration",
  "Propulsion",
  "Power",
  "Lifetime",
  "Mass",
  "Orbit",
];

/** First line of the per-satellite table that follows the spec block. */
const TABLE_HEADER = /^(Satellite|COSPAR|Date|LS|Launch Vehicle|Remarks)$/i;

/** Map Gunter's labels onto the field surface the owner asked to query by. */
const FIELD_MAP = {
  Nation: "nation",
  "Type / Application": "mission", // "Communication", "Earth observation", ...
  Operator: "operator",
  Contractors: "manufacturer", // the prime contractor — the owner's "manufacturers"
  Equipment: "equipment", // often names the RF payload band: "Ku/Ka-band payload"
  Configuration: "bus", // the platform/bus family, Gunter's unique strength
  Propulsion: "propulsion",
  Power: "power",
  Lifetime: "lifetime",
  Mass: "massText", // free text with tildes/ranges: "~260 kg" — parsed, never invented
  Orbit: "orbitText",
};

/**
 * Wayback stores original bytes; `id_` returns them still gzip-encoded.
 *
 * ENCODING IS NOT COSMETIC: these pages are largely windows-1252, and decoding
 * them as UTF-8 turns "53°" into "53�". A degree sign that silently
 * becomes a replacement character is a corrupted fact, so the charset is read
 * from the document rather than assumed.
 */
function decode(buf) {
  const bytes = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  const sniff = bytes.subarray(0, 2048).toString("latin1");
  const declared = sniff.match(/charset=["']?\s*([\w-]+)/i)?.[1]?.toLowerCase();
  const enc = !declared || /^(iso-8859-1|windows-1252|latin1)$/.test(declared) ? "latin1" : "utf8";
  return bytes.toString(enc);
}

function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&times;/g, "x")
    .replace(/&deg;/g, "deg")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract the labelled spec block.
 *
 * Gunter renders each spec as a label line followed by its value line(s). A
 * label with no following value (Gunter leaves "Configuration:" and
 * "Lifetime:" blank on many pages) yields NOTHING — absence is preserved, never
 * filled in with a guess.
 */
export function extractSpecs(lines) {
  const labelAt = new Map();
  lines.forEach((l, i) => {
    const m = l.match(/^([A-Za-z][A-Za-z /]*?):?$/);
    if (!m) return;
    const label = m[1].trim();
    if (SPEC_LABELS.includes(label) && !labelAt.has(label)) labelAt.set(label, i);
  });

  const out = {};
  const sorted = [...labelAt.entries()].sort((a, b) => a[1] - b[1]);
  for (let k = 0; k < sorted.length; k += 1) {
    const [label, i] = sorted[k];
    const nextIdx = k + 1 < sorted.length ? sorted[k + 1][1] : Math.min(i + 4, lines.length);
    // The spec block is immediately followed by the per-satellite table. Without
    // this stop the LAST label swallows the table header and "Orbit" comes out
    // as "550 km x 550 km, 53 deg (typical) Satellite COSPAR Date LS".
    const chunk = [];
    for (const line of lines.slice(i + 1, nextIdx)) {
      if (TABLE_HEADER.test(line)) break;
      chunk.push(line);
    }
    const value = chunk.join(" ").trim();
    if (!value) continue; // blank spec — stays absent
    out[FIELD_MAP[label] ?? label] = value;
  }
  return out;
}

/** "~260 kg" / "1250 kg" / "300 - 350 kg" -> a number, or null. Never a guess. */
export function parseMassKg(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)\s*(?:-\s*([\d.]+)\s*)?kg/i);
  if (!m) return null;
  const lo = Number.parseFloat(m[1]);
  const hi = m[2] ? Number.parseFloat(m[2]) : null;
  if (!Number.isFinite(lo)) return null;
  return hi && Number.isFinite(hi) ? (lo + hi) / 2 : lo;
}

/** COSPAR designators on the page give the join to NORAD via SATCAT intldes. */
export function extractCospar(lines) {
  const ids = new Set();
  for (const l of lines) {
    const m = l.match(/^(\d{4}-\d{3}[A-Z]{0,3})$/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

/** Locate cached bytes for a slug, recovering the snapshot ts from the name. */
function findCachedHtml(slug) {
  if (!existsSync(CACHE)) return null;
  const hit = readdirSync(CACHE)
    .map((f) => f.match(new RegExp(`^${slug.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\.(\\d{14})\\.html$`)))
    .find(Boolean);
  return hit ? { path: join(CACHE, hit[0]), ts: hit[1] } : null;
}

/** Build the cited fact record from raw page bytes. Single source of truth. */
function buildRecord(slug, pageUrl, raw, ts) {
  const lines = htmlToLines(decode(raw));
  const specs = extractSpecs(lines);
  return {
    slug,
    // provenance: a fact from this source is never emitted without all of it
    pageUrl,
    snapshotTimestamp: ts,
    snapshotUrl: ts ? `https://web.archive.org/web/${ts}/${pageUrl}` : null,
    retrievedAt: new Date().toISOString(),
    sha256: sha256(raw),
    citation: SRC.citationText,
    license: SRC.licenseName,
    accessBasis: "owner ruling 2026-07-29 (owner holds an account); Wayback snapshot",
    facts: { ...specs, massKg: parseMassKg(specs.massText) },
    cosparIds: extractCospar(lines),
  };
}

/** Newest HTTP-200 snapshot timestamp for a page, or null. */
async function newestSnapshot(pageUrl) {
  const q = `${CDX}?url=${encodeURIComponent(pageUrl)}&output=text&fl=timestamp&filter=statuscode:200&limit=-1`;
  const res = await fetch(q, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const t = (await res.text()).trim().split(/\s+/)[0];
  return /^\d{14}$/.test(t) ? t : null;
}

/**
 * Retrieve ONE page. Returns a fully-cited fact record.
 * A cached page is NEVER re-fetched — the cache is permanent by ruling.
 */
export async function retrievePage(slug, { allowNetwork = true } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const pageUrl = `https://space.skyrocket.de/doc_sdat/${slug}.htm`;
  const metaPath = join(CACHE, `${slug}.json`);

  // The snapshot timestamp is part of the cached page's IDENTITY, so it lives
  // in the filename. Deleting the parsed record can then never orphan the
  // provenance — the bytes still say which snapshot they came from.
  const cachedHtml = findCachedHtml(slug);

  if (existsSync(metaPath) && cachedHtml) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return { ...meta, cached: true };
  }

  // Bytes on disk but no parsed record — an extractor change, not a new page.
  // RE-PARSE, never re-fetch: improving our parser is our cost, not the
  // operator's. This is what makes the permanent cache actually permanent.
  if (cachedHtml) {
    const record = buildRecord(slug, pageUrl, readFileSync(cachedHtml.path), cachedHtml.ts);
    writeFileSync(metaPath, `${JSON.stringify(record, null, 2)}\n`);
    return { ...record, cached: true, reparsed: true };
  }

  if (!allowNetwork) return null;

  const ts = await newestSnapshot(pageUrl);
  if (!ts) return { slug, pageUrl, error: "no archived snapshot", cached: false };

  await sleep(MIN_DELAY_MS);
  const snapUrl = `https://web.archive.org/web/${ts}id_/${pageUrl}`;
  const res = await fetch(snapUrl, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res.ok) return { slug, pageUrl, error: `HTTP ${res.status}`, cached: false };

  const raw = Buffer.from(await res.arrayBuffer());
  const record = buildRecord(slug, pageUrl, raw, ts);

  // permanent cache, snapshot ts in the name: fetched at most once, ever
  writeFileSync(join(CACHE, `${slug}.${ts}.html`), raw);
  writeFileSync(metaPath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, cached: false };
}

// ------------------------------------------------------------------ CLI probe
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const slugs = process.argv.slice(2);
  if (!slugs.length) {
    console.error("usage: node gunter.mjs <slug> [slug...]   e.g. starlink-v1-0 oneweb iridium-next");
    process.exit(1);
  }
  const run = async () => {
    for (const slug of slugs) {
      const r = await retrievePage(slug);
      if (r?.error) {
        console.log(`  ${slug}: ${r.error}`);
        continue;
      }
      console.log(`\n  ${slug}  [${r.cached ? "CACHED" : "FETCHED"}] snapshot ${r.snapshotTimestamp}`);
      for (const [k, v] of Object.entries(r.facts)) {
        if (v === null || v === undefined) continue;
        console.log(`    ${k.padEnd(13)} ${String(v).slice(0, 78)}`);
      }
      console.log(`    ${"cosparIds".padEnd(13)} ${r.cosparIds.length} found${r.cosparIds.length ? ` (e.g. ${r.cosparIds.slice(0, 3).join(", ")})` : ""}`);
      console.log(`    ${"cite".padEnd(13)} ${r.snapshotUrl}`);
    }
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
