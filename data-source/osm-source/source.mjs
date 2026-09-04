// The ONE place the osm-source translation unit is composed: the SDK-owned
// HTTP envelope headers ($HTQ / $HTR, generated C++) inlined ahead of the
// implementation, exactly as data-source/terrain-source does. No SDS standard
// is inlined: the epoch record is an application/json body (its SDS table,
// the $VTT/OSM-context record, is still to land), so nothing here is a
// FlatBuffer beyond the HTTP envelopes.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sdsPackageVersion } from "./sds-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "osm_source_module.cpp");

export { packageRoot, sdsPackageVersion };

export async function composeOsmSource() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const implementationSource = await fs.readFile(sourcePath, "utf8");
  const sdkHttpCppRoot = fileURLToPath(
    new URL("./node_modules/space-data-module-sdk/src/generated/http/cpp/", import.meta.url),
  );
  const [httpRequestHeader, httpResponseHeader] = await Promise.all([
    fs.readFile(path.join(sdkHttpCppRoot, "HttpRequestAbi_generated.h"), "utf8"),
    fs.readFile(path.join(sdkHttpCppRoot, "HttpResponseAbi_generated.h"), "utf8"),
  ]);
  const sourceCode = [
    httpRequestHeader,
    httpResponseHeader.replace(/#include "HttpRequestAbi_generated\.h"\s*\n/g, ""),
    implementationSource,
  ].join("\n\n");
  return { manifest, sourceCode };
}
