#!/usr/bin/env node
// Candidate Wikidata items for the register rows that name no item (space
// sites, curated facilities): a name search, then each candidate's classes,
// coordinate and description, with its distance from the row. The output is
// a review sheet; a reviewer copies the accepted ids into the register
// (wikidata), so no match is ever made by this tool alone.
//
//   node tools/match-register-qids.mjs space-sites|curated [first row] > candidates.tsv
// Requests go one at a time, a second apart (Wikimedia API etiquette).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UA = "SDN-site-registry/0.1.0 (+https://spacedatanetwork.org)";
const here = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2];
const first = Number(process.argv[3] ?? 0);
const register = JSON.parse(readFileSync(path.join(here, "..", "register", `${which}.json`), "utf8"));
const rows = which === "space-sites" ? register.sites : register.facilities.filter((r) => !r.wikidata || r.position !== "Wikidata");
const api = async (params) => {
  const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: "json", ...params })}`;
  for (let attempt = 1; ; attempt++) {
    await new Promise((res) => setTimeout(res, 1000));
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (r.ok) return r.json();
    if (attempt > 6) throw new Error(`${r.status} ${url}`);
    const wait = Number(r.headers.get("retry-after") ?? 0) * 1000 || 30000 * attempt;
    await new Promise((res) => setTimeout(res, wait));
  }
};
const km = (a, b) => Math.hypot((a.lat - b.lat) * 111.32, (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180));
const labels = new Map();
async function labelOf(ids) {
  const missing = [...new Set(ids)].filter((id) => !labels.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const body = await api({ action: "wbgetentities", ids: missing.slice(i, i + 50).join("|"), props: "labels", languages: "en" });
    for (const [id, e] of Object.entries(body.entities ?? {})) labels.set(id, e.labels?.en?.value ?? id);
  }
  return ids.map((id) => labels.get(id) ?? id);
}
if (!first) console.log(["row", "name", "qid", "label", "km", "classes", "description"].join("\t"));
for (const [index, row] of rows.entries()) {
  if (index < first) continue;
  const names = [row.name, ...(row.ascii ? [row.ascii] : [])];
  const found = new Set();
  for (const name of names) {
    const body = await api({ action: "wbsearchentities", search: name, language: "en", limit: "6", type: "item" });
    for (const hit of body.search ?? []) found.add(hit.id);
  }
  if (!found.size) { console.log([index, row.name, "", "", "", "", ""].join("\t")); continue; }
  const ents = await api({ action: "wbgetentities", ids: [...found].join("|"), props: "claims|descriptions|labels", languages: "en" });
  for (const [id, e] of Object.entries(ents.entities ?? {})) {
    const coord = e.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    const d = coord ? km(row, { lat: coord.latitude, lon: coord.longitude }) : NaN;
    const classes = (e.claims?.P31 ?? []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
    const classLabels = await labelOf(classes);
    console.log([index, row.name, id, e.labels?.en?.value ?? "", Number.isFinite(d) ? d.toFixed(2) : "", classLabels.join("; "), e.descriptions?.en?.value ?? ""].join("\t"));
  }
  await new Promise((res) => setTimeout(res, 200));
}
