#!/usr/bin/env node
// Build the e2e fixtures (tests/fixtures/) from a recorded live run of
// tools/run-native.mjs: the answers the sources gave, cut down to a handful
// of named sites plus every register row, so the stage chain runs end to end
// on committed data. Licences are in tests/fixtures/PROVENANCE.md.
//
//   node tools/make-fixtures.mjs <run-native --cache dir> <run-native --out dir>
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [cacheDir, outDir] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "tests", "fixtures");
mkdirSync(fixtures, { recursive: true });

// The named sites the e2e test asserts (and a research body with a ROR record).
export const NAMED = ["Q1438110", "Q1695264", "Q1536182", "Q302114", "Q1516546", "Q3664615", "Q1630042", "Q5767271", "Q757630", "Q2450052", "Q1022865", "Q105534041", "Q1076890", "Q25058143", "Q1994681", "Q122930142", "Q725100", "Q1419175", "Q11527936"];

const key = (r) => createHash("sha256").update(`${r.method}\n${r.url.replace(/[?&]sdn-req=[^&]*/, "")}\n${r.bodyB64 ?? ""}`).digest("hex");
const answer = (r) => JSON.parse(readFileSync(path.join(cacheDir, `${key(r)}.bin`)).subarray(8));
const requestsOf = (stage) => readFileSync(path.join(outDir, stage, "outputs.txt"), "utf8").trim().split("\n").map((l) => l.split("\t"))
  .filter(([port]) => port === "request").map(([, file]) => JSON.parse(readFileSync(file, "utf8")));

// Class membership: each class's bindings for the named items.
const classRequests = requestsOf("plan");
const classes = classRequests.slice(0, -1).map((r) => answer(r).results.bindings.filter((b) => NAMED.includes(b.item.value.split("/").pop())));
const settlements = answer(classRequests.at(-1)).results.bindings.map((b) => b.item.value.split("/").pop());

// Entities: every item answered, cut to the statements the module reads.
const KEEP = new Set(["P5817", "P730", "P3999", "P576", "P582", "P729", "P1619", "P571", "P31", "P361", "P1366", "P156", "P7888", "P137", "P127", "P17", "P856", "P625", "P2044", "P2109"]);
const LANGS = new Set(["mul", "en", "de", "fr", "es", "it", "ru", "ja", "nl", "sv", "pl", "cs", "uk", "zh"]);
const entities = {};
for (const stage of ["entities_a", "entities_b", "entities_c"]) {
  for (const r of requestsOf(stage)) {
    if (!r.url.includes("wbgetentities")) continue;
    for (const [qid, e] of Object.entries(answer(r).entities ?? {})) {
      const claims = Object.fromEntries(Object.entries(e.claims ?? {}).filter(([p]) => KEEP.has(p))
        .map(([p, list]) => [p, list.map(({ mainsnak, rank, qualifiers }) => ({ mainsnak: { snaktype: mainsnak.snaktype, ...(mainsnak.datavalue ? { datavalue: mainsnak.datavalue } : {}) }, rank, ...(qualifiers?.P580 ? { qualifiers: { P580: qualifiers.P580 } } : {}) }))]));
      const keepLang = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([l]) => LANGS.has(l)));
      entities[qid] = { id: e.id, lastrevid: e.lastrevid, labels: keepLang(e.labels), descriptions: keepLang(e.descriptions),
        // Only the named sites keep their articles, so the article stages ask for those alone.
        sitelinks: NAMED.includes(qid) ? e.sitelinks ?? {} : {}, claims };
    }
  }
}
// The entity answers were kept for every register row and named site; drop the rest.
const registerIds = new Set(NAMED);
for (const file of ["curated.json", "space-sites.json", "placemarks.json"]) {
  const reg = JSON.parse(readFileSync(path.join(here, "..", "register", file), "utf8"));
  for (const row of reg.facilities ?? reg.sites ?? reg.placemarks) if (row.wikidata) registerIds.add(row.wikidata);
}
for (const qid of Object.keys(entities)) if (!registerIds.has(qid)) delete entities[qid];
for (const qid of Object.keys(entities)) for (const p of ["P137", "P127"]) for (const c of entities[qid].claims[p] ?? []) registerIds.add(c.mainsnak.datavalue?.value?.id);

// Parties, countries and labels: the bindings the live run answered, by item.
const parties = {};
const countries = {};
const labels = {};
for (const r of requestsOf("parties")) {
  if (!r.url.includes("query.wikidata.org")) continue;
  const tag = r.url.split("sdn-req=")[1];
  for (const b of answer(r).results.bindings) {
    const qid = b.item.value.split("/").pop();
    if (tag.startsWith("parties")) (parties[qid] ??= []).push(b);
    else if (tag.startsWith("country")) (countries[qid] ??= []).push(b);
    else (labels[qid] ??= []).push(b);
  }
}
const keepParties = Object.fromEntries(Object.entries(parties).filter(([q]) => registerIds.has(q) || q.length));

// GEM: the units of the named plants and of every placemark join, in the tracker's own feature form.
const gemRequest = requestsOf("parties").find((r) => r.url.includes("gnpt"));
const gem = answer(gemRequest);
const placemarkUnits = new Set(JSON.parse(readFileSync(path.join(here, "..", "register", "placemarks.json"), "utf8")).placemarks.flatMap((p) => p.gemUnits));
const plantNames = ["Santa Maria de Garona", "Hinkley Point", "Neckarwestheim", "Diablo Canyon", "Kursk", "Akkuyu", "Grosswelzheim"];
const fold = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
gem.features = gem.features.filter((f) => placemarkUnits.has(f.properties["unit-id"]) || plantNames.some((n) => fold(f.properties.name).includes(fold(n))));

// Articles: the named sites' infoboxes (the infobox template only; CC BY-SA, see PROVENANCE.md).
const articles = {};
for (const stage of ["articles_a", "articles_b", "articles_c"]) {
  for (const r of requestsOf(stage)) {
    if (!r.url.includes("wikipedia.org")) continue;
    const lang = new URL(r.url).host.split(".")[0];
    let body;
    try { body = answer(r); } catch { continue; }
    for (const page of body.query?.pages ?? []) {
      const sitelinked = Object.entries(entities).some(([q, e]) => NAMED.includes(q) && e.sitelinks[`${lang}wiki`]?.title === page.title);
      if (!sitelinked || !page.revisions) continue;
      const text = page.revisions[0].slots.main.content;
      const start = text.search(/\{\{\s*(Infobox|Kernkraftwerk|Infobox Centrale|Карточка|Ficha|Infobox reattore|Kerncentrale)/i);
      let depth = 0;
      let end = start;
      for (let i = start; start >= 0 && i < text.length - 1; i++) {
        if (text[i] === "{" && text[i + 1] === "{") { depth++; i++; }
        else if (text[i] === "}" && text[i + 1] === "}") { depth--; i++; if (depth === 0) { end = i + 1; break; } }
      }
      articles[`${lang}:${page.title}`] = { title: page.title, revid: page.revisions[0].revid, content: start >= 0 ? text.slice(start, end) : "" };
    }
  }
}

const write = (name, value) => writeFileSync(path.join(fixtures, name), `${JSON.stringify(value)}\n`);
write("classes.json", classes);
write("settlements.json", settlements);
write("entities.json", entities);
write("parties.json", keepParties);
write("countries.json", countries);
write("labels.json", labels);
write("gem.geojson", gem);
write("articles.json", articles);
console.log(`classes ${classes.map((c) => c.length).join(",")}; entities ${Object.keys(entities).length}; gem units ${gem.features.length}; articles ${Object.keys(articles).length}`);
