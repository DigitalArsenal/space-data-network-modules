// One synchronous-looking HTTP exchange for the test host: the wasm import `space_data_module_host.call` cannot await, so
// the host spawns this helper and waits. argv: <request.json> <response-prefix>. The request file names the method, url,
// headers (an object), an optional body file and timeout; the response is written to <prefix>.json (status, url,
// headers as "name: value" lines) and <prefix>.body.
import fs from "node:fs";

const [requestPath, prefix] = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
const body = request.bodyPath ? fs.readFileSync(request.bodyPath) : undefined;
try {
  const response = await fetch(request.url, {
    method: request.method || "GET",
    headers: request.headers || {},
    body: body && body.length ? body : undefined,
    redirect: request.redirect || "follow",
    signal: AbortSignal.timeout(request.timeoutMs || 300000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(`${prefix}.body`, bytes);
  const headers = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\r\n");
  fs.writeFileSync(`${prefix}.json`, JSON.stringify({ status: response.status, url: response.url, headers }));
} catch (error) {
  fs.writeFileSync(`${prefix}.json`, JSON.stringify({ status: 0, url: request.url, headers: "", error: String(error?.cause?.message || error?.message || error) }));
  fs.writeFileSync(`${prefix}.body`, "");
}
