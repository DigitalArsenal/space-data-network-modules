import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tests/data/.celestrak-cache",
);

export function defaultCelestrakCacheDir(env = process.env) {
  return (
    env.CONJUNCTION_ASSESSMENT_CELESTRAK_CACHE_DIR ||
    env.CELESTRAK_CACHE_DIR ||
    DEFAULT_CACHE_DIR
  );
}

export function cacheKeyForUrl(url) {
  return createHash("sha256").update(String(url)).digest("hex");
}

export function cachePathForUrl(url, {
  cacheDir = defaultCelestrakCacheDir(),
  extension = "txt",
} = {}) {
  const safeExtension = String(extension || "txt").replace(/[^a-z0-9._-]/gi, "_");
  return path.join(cacheDir, `${cacheKeyForUrl(url)}.${safeExtension}`);
}

export async function readCachedText(url, options = {}) {
  return readFile(cachePathForUrl(url, options), "utf8");
}

export async function writeCachedText(url, text, options = {}) {
  const cachePath = cachePathForUrl(url, options);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, text, "utf8");
  return cachePath;
}

export async function fetchCachedText(url, {
  cacheDir = defaultCelestrakCacheDir(),
  extension = "txt",
  forceRefresh = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  headers = {},
} = {}) {
  if (!forceRefresh) {
    try {
      return {
        text: await readCachedText(url, { cacheDir, extension }),
        cacheHit: true,
        cachePath: cachePathForUrl(url, { cacheDir, extension }),
      };
    } catch {
      // Fall through to network.
    }
  }

  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchCachedText requires a fetch implementation");
  }
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30000)),
    headers,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const text = await response.text();
  const cachePath = await writeCachedText(url, text, { cacheDir, extension });
  return {
    text,
    cacheHit: false,
    cachePath,
  };
}
