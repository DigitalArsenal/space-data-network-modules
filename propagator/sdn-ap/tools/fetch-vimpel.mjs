#!/usr/bin/env node
// Fetches JSC Vimpel data-portal files (spacedata.vimpel.ru, registered users; register at the portal) into a local
// directory, each once:
//   node tools/fetch-vimpel.mjs --out DIR --files orbits.YYYYMMDD.txt,ephem.YYYYMMDD.rar   (or --latest: the newest pair)
// One login per run and no retry (a refused login stops the run); a file already in DIR is not fetched again; each
// file's size and SHA-256 are printed. Credentials: the file VIMPEL_CREDENTIALS names, else
// ~/.sdn-keys/vimpel-credentials.json ({ "site": "http://spacedata.vimpel.ru/", "username", "password" }); read here
// only, never printed or written. The portal serves its login over plain HTTP. The files are Vimpel's and carry no
// redistribution terms: keep them local and commit nothing of them.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const out = arg("out");
if (!out) { console.error("usage: fetch-vimpel.mjs --out DIR (--files a,b | --latest)"); process.exit(1); }
const UA = "spacedatanetwork-stack-ci (+https://github.com/DigitalArsenal)";
const cred = JSON.parse(fs.readFileSync(process.env.VIMPEL_CREDENTIALS ?? path.join(os.homedir(), ".sdn-keys/vimpel-credentials.json"), "utf8"));
const site = new URL(cred.site);
const jar = new Map();
const keep = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
const headers = (extra = {}) => ({ "User-Agent": UA, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...extra });
const front = await fetch(site, { headers: headers(), redirect: "manual" });
keep(front);
const build = /name="form_build_id"[^>]*value="([^"]+)"/.exec(await front.text())?.[1] ?? "";
const login = await fetch(new URL("/welcome?destination=data_provider", site), {
  method: "POST", redirect: "manual", headers: headers({ "Content-Type": "application/x-www-form-urlencoded" }),
  body: new URLSearchParams({ name: cred.username, pass: cred.password, form_build_id: build, form_id: "user_login_block", op: "Log in" }),
});
keep(login);
const listing = await fetch(new URL("/data_provider", site), { headers: headers(), redirect: "manual" });
keep(listing);
const page = await listing.text();
if (!/\/logout/.test(page)) { console.error(`login refused (HTTP ${login.status}); not retried`); process.exit(2); }
const offered = [...page.matchAll(/file=([^&']+)&path=(\w+)'/g)].map((m) => ({ file: m[1], dir: m[2] }));
let wanted = arg("files")?.split(",") ?? [];
if (process.argv.includes("--latest")) {
  const last = (re) => offered.map((o) => o.file).filter((f) => re.test(f)).sort().at(-1);
  wanted = [last(/^orbits\.\d{8}\.txt$/), last(/^ephem\.\d{8}\.rar$/)];
}
fs.mkdirSync(out, { recursive: true });
for (const name of wanted) {
  const o = offered.find((q) => q.file === name);
  if (!o) { console.error(`${name}: not offered`); process.exit(3); }
  const target = path.join(out, name);
  if (fs.existsSync(target)) { console.log(`${name}: present, not fetched again`); continue; }
  const r = await fetch(new URL(`/download.php?file=${encodeURIComponent(o.file)}&path=${o.dir}`, site), { headers: headers() });
  if (!r.ok) { console.error(`${name}: HTTP ${r.status}`); process.exit(4); }
  const bytes = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(target, bytes);
  console.log(`${name}: ${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
}
await fetch(new URL("/logout", site), { headers: headers(), redirect: "manual" });
