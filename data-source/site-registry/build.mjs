// Build data-source/site-registry through the SDK compiler lane: the $SIT and
// $GNP headers generated from the pinned spacedatastandards.org package
// (SPACE_DATA_STANDARDS_ROOT overrides it), the registers compiled into C++
// tables (register/*.json are build input only: nothing parses them at run
// time), nlohmann json for the sources' JSON answers, the vendored miniz
// (data-source/geonames-source, SHA-256 pinned) for the ROR dump, and the
// module's own headers. One translation unit on wasi-threads ("emscripten-pthreads" in the SDK's
// naming: clang --target=wasm32-wasip1-threads, shared imported memory, wasi.thread-spawn): the
// stages parse the answers and read the articles on four pthreads (src/parallel.hpp).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "./sds-header.mjs";
import { minizSourceFragments } from "../geonames-source/miniz-source.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const { header: sit, version } = await generateSdsHeader("SIT", import.meta.url);
if (!/struct SITCitationBuilder/.test(sit)) throw new Error(`spacedatastandards.org@${version} has no SIT 1.1.0 (SITCitation); this module needs 1.249.0 or later.`);
const gnp = (await generateSdsHeader("GNP", import.meta.url)).header.replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", "FLATBUFFERS_GENERATED_MAIN_GNP_H_");
const json = await fs.readFile(path.resolve(root, "../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp"), "utf8");
const sha = await fs.readFile(path.resolve(root, "../../files/orbit-products/src/sha256.hpp"), "utf8");
const [minizHeader, minizImplementation] = await minizSourceFragments();
const own = /^#include "(?:regex|text|rules|state|register|parallel|stages|ror|reconcile|finish|driver)\.hpp"\s*$/gm;
const local = async (file) => (await fs.readFile(path.join(root, "src", file), "utf8")).replace(/^#pragma once\s*$/m, "").replace(own, "");
const register = await registerSource();
const sources = [minizHeader, minizImplementation, sit, gnp, json, sha, ...(await Promise.all(["regex.hpp", "text.hpp", "rules.hpp", "state.hpp", "register.hpp", "parallel.hpp"].map(local))), register,
  ...(await Promise.all(["stages.hpp", "ror.hpp", "reconcile.hpp", "finish.hpp", "driver.hpp", "site_registry.cpp"].map(local)))];
// node build.mjs --emit-core <file>: the translation unit without the plugin entry points, for a native build
// of the same rules (tools/native-run.mjs replays recorded answers through it).
const emit = process.argv.indexOf("--emit-core");
if (emit > 0) {
  await fs.writeFile(process.argv[emit + 1], sources.slice(0, -1).join("\n"));
  console.log(`Wrote the core translation unit to ${process.argv[emit + 1]}`);
  process.exit(0);
}
// node build.mjs --flow-host: the same source on one thread (SR_THREADS 1, no thread code), in
// flow-host/, for the provider flow. The SDN flow runtime bounds a threaded guest's call at 30 s
// when the caller gives no budget (sdn-server internal/wasmrt/runtime.go, executeDirect), and the
// flow's linked drain runs its HTTP requests inside that call (minutes). Follow-up
// sdn-flow-threaded-drain-budget-20261013 gives scheduled drains a budget; the provider flow then
// links dist/ (wasi-threads) and this variant goes away.
const flowHost = process.argv.includes("--flow-host");
const out = flowHost ? path.join(root, "flow-host") : root;
const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const threadModel = flowHost ? "wasi-sequential" : "emscripten-pthreads";
if (flowHost) {
  delete manifest.threadModel;
  manifest.sequentialJustification = { kind: "pure-transform",
    detail: "Provider-flow variant of the threaded module (the same source with SR_THREADS 1): the SDN flow runtime bounds a threaded guest's call at 30 s and this flow's linked drain carries its HTTP requests, so the flow links this variant until scheduled drains carry a budget (sdn-flow-threaded-drain-budget-20261013). The canonical artifact, dist/isomorphic/module.wasm, parses the answers and reads the articles on four wasi-threads workers." };
}
const outputPath = path.join(out, "dist/isomorphic/module.wasm");
await fs.rm(path.join(out, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const sourceCode = (flowHost ? "#define SR_THREADS 1\n" : "") + sources.join("\n");
const result = await compileModuleFromSource({ manifest, sourceCode, language: "c++", outputPath, threadModel });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
const guest = path.join(out, "dist/guest-link");
await fs.mkdir(guest, { recursive: true });
await fs.writeFile(path.join(guest, "module-link.o"), result.guestLink.objectBytes);
const { format, language, symbolPrefix, methodSymbols } = result.guestLink;
await fs.writeFile(path.join(guest, "metadata.json"), JSON.stringify({ version: 1, format, language, threadModel: result.guestLink.threadModel, symbolPrefix, methodSymbols }, null, 2) + "\n");
await fs.writeFile(path.join(out, "plugin-manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
await fs.copyFile(path.join(out, "plugin-manifest.json"), path.join(out, "dist/plugin-manifest.json"));
await fs.writeFile(path.join(out, "dist/build-provenance.json"), `${JSON.stringify({ spacedatastandards: version, schemas: ["SIT", "GNP"], threadModel: flowHost ? "wasi-sequential" : "wasi-threads", workers: flowHost ? 1 : 4, miniz: "3.1.2" }, null, 2)}\n`);
console.log(`Built ${outputPath} (${flowHost ? "wasi-sequential flow-host variant" : "wasi-threads"}) against spacedatastandards.org@${version}`);

// ── registers -> C++ tables ───────────────────────────────────────────────
async function registerSource() {
  const read = async (name) => JSON.parse(await fs.readFile(path.join(root, "register", name), "utf8"));
  const c = (v) => (v === undefined || v === null ? '""' : JSON.stringify(String(v)));
  const n = (v) => (Number.isFinite(v) ? String(v) : "NAN");
  const b = (v) => (v ? "true" : "false");
  const sources = await read("sources.json");
  const classes = await read("classes.json");
  const curated = await read("curated.json");
  const space = await read("space-sites.json");
  const reviewed = await read("reviewed.json");
  const regulators = await read("regulators.json");
  const placemarks = await read("placemarks.json");
  const countries = await read("countries.json");
  const languages = await read("languages.json");
  const dockets = await read("nrc-dockets.json");
  const lines = ["namespace reg {"];
  const table = (type, name, rows) => lines.push(`inline const ${type} ${name}[] = {`, ...rows.map((r) => `  {${r}},`), "};", `constexpr size_t ${name}Count = ${rows.length};`);
  table("Source", "kSources", sources.sources.map((s) => [s.id, s.name, s.licenseClass, s.licenseId, s.attribution, s.credit, s.version, s.recordUrl, s.use, s.data].map(c).join(", ")));
  table("Network", "kNetworks", Object.entries(classes.networks).map(([code, name]) => `${c(code)}, ${c(name)}`));
  table("Class", "kClasses", classes.classes.map(([network, qid, kind, transitive]) => `${c(network)}, ${c(qid)}, ${c(kind)}, ${b(transitive)}`));
  table("Curated", "kCurated", curated.facilities.map((r) => [c(r.name), c(r.category), c(r.kind), c(r.cc), c(r.wikidata), n(r.lat), n(r.lon), c(r.position), c(r.positionUrl), c(r.positionTitle), c(r.page)].join(", ")));
  table("SpaceCode", "kSpaceCodes", Object.entries(space.codes).map(([code, name]) => `${c(code)}, ${c(name)}`));
  table("SpaceSite", "kSpaceSites", space.sites.map((r) => [c(r.name), c(r.ascii), c(r.code), n(r.lat), n(r.lon), c(r.cc), c(r.admin1), c(r.wikidata), c(r.status), c(r.statusDate), c(r.statusUrl), c(r.statusTitle), c(r.geonames), c(r.page)].join(", ")));
  const steps = [];
  const units = [];
  const facts = reviewed.evidence.map((f) => {
    const stepBegin = steps.length;
    for (const s of f.steps ?? []) steps.push(`${c(s.status)}, ${c(s.date)}`);
    const unitBegin = units.length;
    for (const u of f.units ?? []) units.push(c(u));
    return [c(f.qid), c(f.source), c(f.wiki), c(f.title), c(f.revision), c(f.reviewedAt), stepBegin, (f.steps ?? []).length, unitBegin, (f.units ?? []).length].join(", ");
  });
  table("Step", "kSteps", steps);
  lines.push(`inline const char* const kFactUnits[] = {${units.join(", ") || '""'}};`);
  table("Fact", "kFacts", facts);
  table("Duplicate", "kDuplicates", reviewed.duplicates.map((d) => `${c(d.keep)}, ${c(d.drop)}`));
  table("NotFacility", "kNotFacilities", reviewed.notFacilities.map((d) => c(d.qid)));
  table("DismantlingReviewed", "kDismantlingReviewed", (reviewed.dismantlingReviewed ?? []).map((d) => `${c(d.qid)}, ${c(d.recordId)}, ${c(d.phrase)}`));
  table("Regulator", "kRegulators", Object.entries(regulators.regulators).map(([cc, qid]) => `${c(cc)}, ${c(qid)}`));
  lines.push(`inline const char* const kRegulatorExcludeKinds = ${c(regulators.excludeKinds)};`, `inline const char* const kRegulatorStoreKinds = ${c(regulators.storeKinds)};`);
  const gemUnits = [];
  table("Placemark", "kPlacemarks", placemarks.placemarks.map((p) => {
    const begin = gemUnits.length;
    for (const u of p.gemUnits) gemUnits.push(c(u));
    return [c(p.geonameId), c(p.name), c(p.ascii), c(p.code), c(p.cc), c(p.admin1), n(p.lat), n(p.lon), c(p.wikidata), b(p.unitItem), begin, p.gemUnits.length, b(p.unitPlant), c(p.network)].join(", ");
  }));
  lines.push(`inline const char* const kPlacemarkGemUnits[] = {${gemUnits.join(", ") || '""'}};`, `inline const char* const kPlacemarkEpoch = ${c(placemarks.dataset.epoch)};`);
  table("Country", "kCountries", Object.entries(countries.countries).map(([a2, r]) => `${c(a2)}, ${c(r.numeric)}, ${c(r.wikidata)}, ${c(r.name)}`));
  table("Alias", "kCountryAliases", Object.entries(countries.gemNames ?? {}).map(([name, a2]) => `${c(name)}, ${c(a2)}`));
  table("Alias", "kLanguages", Object.entries(languages.languages).map(([a2, lang]) => `${c(a2)}, ${c(lang)}`));
  table("Docket", "kDockets", (dockets.dockets ?? []).map((d) => [c(d.wikidata), c(d.docket), c(d.unit), c(d.url), c(d.checked)].join(", ")));
  lines.push("}  // namespace reg");
  return lines.join("\n");
}
