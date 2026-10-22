// Generates src/watch_sources.hpp from the terrain walk's own tables (../terrain-ingest/src/body_plan.hpp): every source
// file the walk reads (its URL, the ETag it is pinned to) and the levels it serves, so the monthly source check can never
// disagree with the encoder about what a source is. `node tools/generate-sources.mjs` writes; `--check` fails when the
// committed header is not what the tables produce (a table edited without regenerating).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const planPath = path.join(root, "..", "terrain-ingest", "src", "body_plan.hpp");
const outPath = path.join(root, "src", "watch_sources.hpp");
const NAIF = { moon: "301", mars: "499" };

// ---- a C++ brace-initializer reader: strings, numbers, identifiers/expressions and nested groups ----------------------
function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (text[j] !== '"') { if (text[j] === "\\") { s += text[j + 1]; j += 2; } else s += text[j++]; }
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if ("{},".includes(c)) { out.push({ t: c }); i++; continue; }
    let j = i;
    while (j < text.length && !"{},".includes(text[j]) && !(text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*"))) { if (text[j] === '"') break; j++; }
    out.push({ t: "atom", v: text.slice(i, j).trim() });
    i = j;
  }
  return out;
}
function parseGroup(tokens, at) {
  const items = [];
  let atoms = [];
  const flush = () => { if (atoms.length) { items.push({ atom: atoms.join(" ") }); atoms = []; } };
  for (let i = at; i < tokens.length; i++) {
    const k = tokens[i];
    if (k.t === "{") { flush(); const [g, next] = parseGroup(tokens, i + 1); items.push(g); i = next; }
    else if (k.t === "}") { flush(); return [items, i]; }
    else if (k.t === ",") flush();
    else if (k.t === "str") items.push({ str: k.v });
    else if (k.t === "atom") atoms.push(k.v);
  }
  flush();
  return [items, tokens.length];
}

const source = fs.readFileSync(planPath, "utf8");
function initializer(pattern, name) {
  const marker = source.search(pattern);
  if (marker < 0) throw new Error(`body_plan.hpp: missing ${name} initializer`);
  return parseGroup(tokenize(source.slice(source.indexOf("{", marker))), 1)[0];
}
const bodies = initializer(/static\s+(?:const\s+)?std::vector<Body>\s+table\s*=\s*\{/, "bodies()");
const str = (x) => (x && x.str !== undefined ? x.str : undefined);
const num = (x) => (x && x.atom !== undefined ? Number(x.atom.replace(/ULL$/, "")) : undefined);

const rows = [];
for (const body of bodies) {
  const name = str(body[0]);
  const base = str(body[3]);
  const products = body[4];
  const caps = body[5];
  if (!NAIF[name]) throw new Error(`no NAIF id for body ${name}`);
  for (const product of products) {
    const key = str(product[0]);
    const serves = caps
      .filter((cap) => str(cap[0]) === key)
      .map((cap) => `L${num(cap[1])}${num(cap[1]) === num(cap[2]) ? "" : `-${num(cap[2])}`} lat ${num(cap[3])}..${num(cap[4])}`)
      .join("; ");
    for (const file of product[12]) {
      const pathText = str(file[0]);
      const pinned = str(file[1]) ?? "";
      const image = file.length > 4 && str(file[4]) ? str(file[4]) : `${base}${pathText}.img`;
      rows.push({ body: name, naif: NAIF[name], product: key, file: path.posix.basename(new URL(image).pathname), url: image, pinned, size: 0, serves });
    }
    for (const fallback of [str(product[13]), str(product[15])]) void fallback; // datum / fallback products are products of their own
  }
}

// The inset catalog pins complete GeoTIFF byte lengths. The separately assembled
// BodyFile tables own their mirror paths and ETags; overview keys are NOT R2 folders.
// These files exist only in raw/499/: no public source URL is available to probe.
const [insets] = initializer(/static constexpr std::array<BodyInset,\s*\d+> rows = \{/, "body_insets()");
const insetFiles = new Map();
function addInsetFile(file, serves) {
  const name = str(file[0]);
  if (insetFiles.has(name)) throw new Error(`duplicate inset file ${name}`);
  insetFiles.set(name, { mirrorPath: str(file[4]), pinned: str(file[1]) ?? "", serves });
}
for (const file of initializer(/static constexpr BodyFile hmc_files\[\] = \{/, "HMC files")) {
  addInsetFile(file, "L10 inset 50 m");
}
for (const level of initializer(/static constexpr Level levels\[\] = \{/, "inset levels")) {
  // Level numbering follows append_mars_insets/body_caps; no terrain calculation.
  const spacing = num(level[1]);
  addInsetFile(level[2], `L${15 - Math.log2(spacing)} inset ${spacing} m`);
}
for (const inset of insets) {
  const name = str(inset[0]);
  const file = insetFiles.get(name);
  const size = num(inset[11]);
  if (!file || !Number.isSafeInteger(size) || size <= 0) throw new Error(`missing path or byte-size pin for inset ${name}`);
  const [product, ...parts] = file.mirrorPath.split("/");
  if (!product || parts.at(-1) !== name || parts.some((part) => !part || part === "..")) throw new Error(`invalid inset path ${file.mirrorPath}`);
  rows.push({ body: "mars", naif: NAIF.mars, product, file: parts.join("/"), url: "", pinned: file.pinned, serves: file.serves, size });
  insetFiles.delete(name);
}
if (insetFiles.size) throw new Error(`inset files lack body_insets() metadata: ${[...insetFiles.keys()].join(", ")}`);

const q = (s) => JSON.stringify(s);
let out = `// GENERATED by tools/generate-sources.mjs from ../terrain-ingest/src/body_plan.hpp - do not edit.\n`;
out += `// Every source file the terrain walk reads: its body, NAIF id, product, mirrored file name, URL, the ETag it is pinned to\n`;
out += `// (empty: unpinned), levels served, and byte-size pin (0: unknown). Insets have no source URL and use only the mirror;\n`;
out += `// file retains ovr/ where present, so raw/<naif>/<product>/<file> is the actual mirror key.\n#pragma once\n#include <cstdint>\n\nstruct WatchSource {\n    const char* body;\n    const char* naif;\n    const char* product;\n    const char* file;\n    const char* url;\n    const char* pinned_etag;\n    const char* serves;\n    uint64_t pinned_size;\n};\n\n`;
out += `constexpr WatchSource kWatchSources[] = {\n`;
for (const r of rows) out += `    {${q(r.body)}, ${q(r.naif)}, ${q(r.product)}, ${q(r.file)}, ${q(r.url)}, ${q(r.pinned)}, ${q(r.serves)}, ${r.size}ULL},\n`;
out += `};\nconstexpr unsigned kWatchSourceCount = sizeof(kWatchSources) / sizeof(kWatchSources[0]);\n`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  if (current !== out) { console.error("src/watch_sources.hpp is not what ../terrain-ingest/src/body_plan.hpp produces: run node tools/generate-sources.mjs"); process.exit(1); }
  console.log(`watch_sources.hpp matches body_plan.hpp (${rows.length} source files)`);
} else {
  fs.writeFileSync(outPath, out);
  console.log(`wrote src/watch_sources.hpp (${rows.length} source files)`);
}
