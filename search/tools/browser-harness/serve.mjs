/**
 * Minimal same-origin static server for the harness (zero external bytes).
 *
 * Serves `../lib` as `/lib` so the page imports the REAL encoder and planner
 * rather than copies. Copies in a harness are how a reference implementation
 * and its consumer silently diverge, and `lib/encoder.mjs` is the parity oracle
 * the WASM module is measured against — it must have exactly one definition.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const LIB = path.resolve(ROOT, "..", "lib");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
};
createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = rel.startsWith("lib/")
    ? path.join(LIB, rel.slice(4))
    : path.join(ROOT, rel);
  if (!file.startsWith(ROOT) && !file.startsWith(LIB)) { res.writeHead(403).end(); return; }
  try {
    await stat(file);
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch { res.writeHead(404).end("not found"); }
}).listen(8199, () => console.log("harness on http://127.0.0.1:8199"));
