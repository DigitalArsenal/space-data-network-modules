// Typed frames for the celestrak-parser tests: the HttpResponse (HRSP) hostcap/http-request answers, its CONTEXT the
// job celestrak-request sends (ONE size-prefixed $ICN record), built with the spacedatastandards.org JS bindings.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HeaderT, HttpResponse, HttpResponseT, encodeHttpResponse } from "space-data-module-sdk/runtime-contracts";

export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
export const sdsLib = (code) => import(pathToFileURL(path.join(STANDARDS_ROOT, `lib/js/${code}/main.js`)).href);
export const flatbuffers = createRequire(pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/ICN/main.js")))("flatbuffers");
const icnLib = await sdsLib("ICN");

export const HRSP = { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" };

// A request-builder job (legacy JSON key names) as the size-prefixed $ICN record celestrak-request writes.
export function icnJob(job = {}) {
  const b = new flatbuffers.Builder(1024);
  const s = (v) => (v === undefined ? 0 : b.createString(v));
  const connector = s(job.source_name ?? "unnamed"), url = s(job.source_url), source = s(job.source_name), provider = s(job.provider_id);
  const dataset = s(job.dataset_id), originId = s(job.origin_id), originName = s(job.origin_name);
  const license = s(job.license), licenseUrl = s(job.license_url), citation = s(job.citation), method = s("GET");
  const { ICN } = icnLib;
  ICN.startICN(b);
  ICN.addConnectorId(b, connector);
  ICN.addKind(b, icnLib.icnConnectorKind.HttpsPull);
  ICN.addHttpMethod(b, method);
  if (url) ICN.addEndpointUrl(b, url);
  if (source) ICN.addSourceName(b, source);
  if (provider) ICN.addProviderId(b, provider);
  if (dataset) ICN.addDatasetId(b, dataset);
  if (originId) ICN.addOriginId(b, originId);
  if (originName) ICN.addOriginName(b, originName);
  if (license) ICN.addLicense(b, license);
  if (licenseUrl) ICN.addLicenseUrl(b, licenseUrl);
  if (citation) ICN.addCitation(b, citation);
  b.finishSizePrefixed(ICN.endICN(b), "$ICN");
  return b.asUint8Array().slice();
}

// The parser's one input: the HttpResponse, its job in CONTEXT.
export function responseInput(job, body = new Uint8Array(0), headers = {}, status = 200, context = icnJob(job)) {
  return { portId: "response", typeRef: HRSP, payload: encodeHttpResponse({ url: job?.source_url ?? "", status, headers, body, context, retrievedMs: Date.UTC(2026, 0, 2, 12) }) };
}

// An HttpResponse whose header NAMEs are written exactly as given (not lower-cased): a host that does not normalize.
export function rawCaseResponseInput(job, body, headers) {
  const names = Object.entries(headers).map(([n, v]) => new HeaderT(n, v)).sort((a, b) => (a.NAME < b.NAME ? -1 : 1));
  const t = new HttpResponseT(job.source_url, 200, names, Array.from(body), Array.from(icnJob(job)), "", 0n);
  const b = new flatbuffers.Builder(1024);
  HttpResponse.finishHttpResponseBuffer(b, t.pack(b));
  return { portId: "response", typeRef: HRSP, payload: b.asUint8Array().slice() };
}
