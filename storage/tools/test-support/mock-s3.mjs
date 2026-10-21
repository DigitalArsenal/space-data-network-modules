// An S3-compatible server for the object-s3 tests, with its own independent SigV4 verification (node:crypto) so a
// signing mistake in the module is a 403 here, not a pass. One bucket; objects, ListObjectsV2 (prefix, delimiter,
// max-keys, continuation-token, start-after), HEAD, ranged GET, DELETE and multipart (5 MiB minimum part size, composite
// ETag). Run as a child process: `node mock-s3.mjs <accessKey> <secret> <bucket> <region>`; it prints its port.
// Test control: POST /_mock/fail-part?n=2 makes the next UploadPart number 2 answer 500; POST /_mock/seed?key=&size=&modified=
// stores an object; GET /_mock/state is a JSON dump {objects, aborted, requests}; POST /_mock/reset.
import crypto from "node:crypto";
import http from "node:http";

const [ACCESS, SECRET, BUCKET, REGION] = process.argv.slice(2);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const md5 = (b) => crypto.createHash("md5").update(b).digest();
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let objects = new Map();   // key -> { body, etag, modified, contentType }
let uploads = new Map();   // id -> { key, parts: Map(n -> {body, etag}) }
let aborted = [];
let requests = [];
let failPart = null;
let counter = 0;

function verify(req, bodyHash, url) {
  const auth = req.headers.authorization || "";
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return "malformed Authorization";
  const [, access, day, region, signedHeaders, signature] = m;
  if (access !== ACCESS) return "InvalidAccessKeyId";
  if (region !== REGION) return `bad region ${region}`;
  const amzDate = req.headers["x-amz-date"];
  if (!amzDate || !amzDate.startsWith(day)) return "bad x-amz-date";
  const names = signedHeaders.split(";");
  for (const required of ["host", "x-amz-content-sha256", "x-amz-date"]) if (!names.includes(required)) return `${required} not signed`;
  const canonicalHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? "").trim()}\n`).join("");
  const query = [...url.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const canonical = [req.method, url.pathname, query.map(([k, v]) => `${k}=${v}`).join("&"), canonicalHeaders, signedHeaders, req.headers["x-amz-content-sha256"]].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let key = hmac(`AWS4${SECRET}`, day);
  for (const part of [region, "s3", "aws4_request"]) key = hmac(key, part);
  if (crypto.createHmac("sha256", key).update(toSign).digest("hex") !== signature) return "SignatureDoesNotMatch";
  const declared = req.headers["x-amz-content-sha256"];
  if (declared !== "UNSIGNED-PAYLOAD" && declared !== bodyHash) return "XAmzContentSHA256Mismatch";
  return "";
}

function error(res, status, code, message) {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`;
  res.writeHead(status, { "content-type": "application/xml", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function ok(res, status, body = "", headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { "content-length": buf.length, ...headers });
  res.end(buf);
}
const etagOf = (body) => `"${md5(body).toString("hex")}"`;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/_mock/")) {
    if (url.pathname === "/_mock/state") {
      const state = { objects: Object.fromEntries([...objects].map(([k, v]) => [k, { size: v.body.length, sha256: sha256(v.body), etag: v.etag, contentType: v.contentType }])), aborted, requests };
      return ok(res, 200, JSON.stringify(state), { "content-type": "application/json" });
    }
    if (url.pathname === "/_mock/fail-part") { failPart = Number(url.searchParams.get("n")); return ok(res, 200, "ok"); }
    if (url.pathname === "/_mock/seed") {  // POST ?key=&size=&modified=<ISO>: an object of `size` zero bytes, unauthenticated test control
      const size = Number(url.searchParams.get("size") || 0);
      const body = Buffer.alloc(size);
      objects.set(url.searchParams.get("key"), { body, etag: etagOf(body), modified: url.searchParams.get("modified") || new Date().toISOString(), contentType: "binary/octet-stream" });
      return ok(res, 200, "ok");
    }
    if (url.pathname === "/_mock/reset") { objects = new Map(); uploads = new Map(); aborted = []; requests = []; failPart = null; return ok(res, 200, "ok"); }
  }
  const problem = verify(req, sha256(body), url);
  requests.push({ method: req.method, path: url.pathname, query: url.search, auth: problem || "ok", authorization: req.headers.authorization, host: req.headers.host });
  if (problem) return error(res, 403, problem === "SignatureDoesNotMatch" ? "SignatureDoesNotMatch" : "AccessDenied", problem);
  const parts = url.pathname.split("/").filter(Boolean);
  if (decodeURIComponent(parts[0] || "") !== BUCKET) return error(res, 404, "NoSuchBucket", "no such bucket");
  const key = parts.slice(1).map(decodeURIComponent).join("/");
  const q = url.searchParams;

  if (!key) {  // bucket level
    if (req.method !== "GET" || q.get("list-type") !== "2") return error(res, 400, "NotImplemented", "list-type=2 only");
    const prefix = q.get("prefix") || "";
    const delimiter = q.get("delimiter") || "";
    const max = Math.min(Number(q.get("max-keys") || 1000), 1000);
    const token = q.get("continuation-token");
    const startAfter = token ? Buffer.from(token, "base64url").toString() : q.get("start-after") || "";
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > startAfter).sort();
    const contents = [];
    const prefixes = new Set();
    let truncated = false, last = "";
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      const entry = cut >= 0 ? prefix + rest.slice(0, cut + delimiter.length) : null;
      if (entry && prefixes.has(entry)) { last = k; continue; }
      if (contents.length + prefixes.size >= max) { truncated = true; break; }
      if (entry) prefixes.add(entry); else contents.push(k);
      last = k;
    }
    const out = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${contents.length + prefixes.size}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
      (truncated ? `<NextContinuationToken>${Buffer.from(last).toString("base64url")}</NextContinuationToken>` : "") +
      contents.map((k) => `<Contents><Key>${xml(k)}</Key><LastModified>${objects.get(k).modified}</LastModified><ETag>${xml(objects.get(k).etag)}</ETag><Size>${objects.get(k).body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("") +
      [...prefixes].map((p) => `<CommonPrefixes><Prefix>${xml(p)}</Prefix></CommonPrefixes>`).join("") + "</ListBucketResult>";
    return ok(res, 200, out, { "content-type": "application/xml" });
  }

  const uploadId = q.get("uploadId");
  if (req.method === "POST" && q.has("uploads")) {
    const id = `upload-${++counter}`;
    uploads.set(id, { key, parts: new Map() });
    return ok(res, 200, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { "content-type": "application/xml" });
  }
  if (uploadId) {
    const upload = uploads.get(uploadId);
    if (!upload || upload.key !== key) return error(res, 404, "NoSuchUpload", "no such upload");
    if (req.method === "PUT") {
      const n = Number(q.get("partNumber"));
      if (failPart === n) { failPart = null; return error(res, 500, "InternalError", "injected part failure"); }
      const etag = etagOf(body);
      upload.parts.set(n, { body, etag });
      return ok(res, 200, "", { etag });
    }
    if (req.method === "DELETE") { uploads.delete(uploadId); aborted.push(uploadId); return ok(res, 204); }
    if (req.method === "POST") {
      const listed = [...body.toString().matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>(.*?)<\/ETag><\/Part>/g)].map((m) => [Number(m[1]), m[2].replace(/&quot;/g, '"')]);
      const numbers = [...upload.parts.keys()].sort((a, b) => a - b);
      if (listed.length !== numbers.length || listed.some(([n, e], i) => n !== numbers[i] || upload.parts.get(n).etag !== e)) return error(res, 400, "InvalidPart", "part list does not match");
      for (const n of numbers.slice(0, -1)) if (upload.parts.get(n).body.length < 5 * 1024 * 1024) return error(res, 400, "EntityTooSmall", "part too small");
      const whole = Buffer.concat(numbers.map((n) => upload.parts.get(n).body));
      const etag = `"${crypto.createHash("md5").update(Buffer.concat(numbers.map((n) => md5(upload.parts.get(n).body)))).digest("hex")}-${numbers.length}"`;
      objects.set(key, { body: whole, etag, modified: new Date().toISOString(), contentType: "application/octet-stream" });
      uploads.delete(uploadId);
      return ok(res, 200, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${xml(key)}</Key><ETag>${xml(etag)}</ETag></CompleteMultipartUploadResult>`, { "content-type": "application/xml" });
    }
  }
  if (req.method === "PUT") {
    const etag = etagOf(body);
    objects.set(key, { body, etag, modified: new Date().toISOString(), contentType: req.headers["content-type"] || "binary/octet-stream" });
    return ok(res, 200, "", { etag });
  }
  if (req.method === "DELETE") { objects.delete(key); return ok(res, 204); }
  if (req.method === "GET" || req.method === "HEAD") {
    const o = objects.get(key);
    if (!o) return error(res, 404, "NoSuchKey", "The specified key does not exist.");
    let status = 200, slice = o.body;
    const headers = { etag: o.etag, "last-modified": new Date(o.modified).toUTCString(), "content-type": o.contentType, "accept-ranges": "bytes" };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      const a = Number(range[1]), b = range[2] === "" ? o.body.length - 1 : Math.min(Number(range[2]), o.body.length - 1);
      slice = o.body.subarray(a, b + 1);
      status = 206;
      headers["content-range"] = `bytes ${a}-${b}/${o.body.length}`;
    }
    if (req.method === "HEAD") { res.writeHead(status, { ...headers, "content-length": slice.length }); return res.end(); }
    return ok(res, status, slice, headers);
  }
  return error(res, 405, "MethodNotAllowed", "method not allowed");
});
server.listen(0, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
