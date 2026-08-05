#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_MANIFEST_URL =
  "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
const DEFAULT_EPHEMERIS_BASE =
  "https://api.starlink.com/public-files/ephemerides/";
const MAX_CONCURRENCY = 256;

function parseCandidate(filename, position) {
  if (
    !filename.startsWith("MEME_") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return null;
  }
  const first = filename.indexOf("_");
  const second = filename.indexOf("_", first + 1);
  const third = filename.indexOf("_", second + 1);
  const generationMatch = /_([0-9]+)_UNCLASSIFIED\.txt$/.exec(filename);
  if (second < 0 || third < 0 || !generationMatch) return null;
  return {
    filename,
    identity:
      `MEME:${filename.slice(first + 1, second)}:` +
      filename.slice(second + 1, third),
    generation: BigInt(generationMatch[1]),
    position,
  };
}

export function selectLatestManifestEntries(manifestText) {
  const selected = new Map();
  const lines = String(manifestText).split("\n");
  for (let position = 0; position < lines.length; position += 1) {
    const candidate = parseCandidate(lines[position].trim(), position);
    if (!candidate) continue;
    const current = selected.get(candidate.identity);
    if (
      !current ||
      candidate.generation > current.generation ||
      (candidate.generation === current.generation &&
        candidate.filename > current.filename)
    ) {
      selected.set(candidate.identity, candidate);
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.position - right.position)
    .map(({ filename }) => filename);
}

export function sampleEvenly(items, requestedCount) {
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) {
    throw new RangeError("sample count must be a positive integer");
  }
  if (requestedCount >= items.length) return [...items];
  if (requestedCount === 1) {
    return [items[Math.floor((items.length - 1) / 2)]];
  }
  return Array.from({ length: requestedCount }, (_, index) => {
    const sourceIndex = Math.round(
      (index * (items.length - 1)) / (requestedCount - 1),
    );
    return items[sourceIndex];
  });
}

function parseCompleteLength(response, bodyLength) {
  if (response.status === 200) return bodyLength;
  if (response.status !== 206) {
    throw new Error(`unexpected HTTP ${response.status}`);
  }
  const contentRange = response.headers.get("content-range") ?? "";
  const match = /\/([0-9]+)$/.exec(contentRange);
  if (!match) throw new Error(`invalid Content-Range ${JSON.stringify(contentRange)}`);
  const total = Number(match[1]);
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new Error(`invalid complete length ${match[1]}`);
  }
  return total;
}

export async function measureStarlinkCatalog({
  manifestUrl = DEFAULT_MANIFEST_URL,
  ephemerisBase = DEFAULT_EPHEMERIS_BASE,
  concurrency = 64,
  download = false,
  sampleCount,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_CONCURRENCY
  ) {
    throw new RangeError(`concurrency must be an integer in 1..${MAX_CONCURRENCY}`);
  }

  const startedAt = performance.now();
  const manifestResponse = await fetchImpl(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(`manifest HTTP ${manifestResponse.status}`);
  }
  const manifestText = await manifestResponse.text();
  const catalogFilenames = selectLatestManifestEntries(manifestText);
  const filenames =
    sampleCount === undefined
      ? catalogFilenames
      : sampleEvenly(catalogFilenames, sampleCount);
  const lengths = new Array(filenames.length).fill(0);
  const transferred = new Array(filenames.length).fill(0);
  const failures = [];
  let nextIndex = 0;

  async function consumeBody(response) {
    if (!response.body?.getReader) {
      return new Uint8Array(await response.arrayBuffer()).byteLength;
    }
    const reader = response.body.getReader();
    let byteLength = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return byteLength;
      byteLength += value?.byteLength ?? 0;
    }
  }

  async function probeWorker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= filenames.length) return;
      const filename = filenames[index];
      try {
        const response = await fetchImpl(
          new URL(encodeURIComponent(filename), ephemerisBase),
          download ? {} : { headers: { Range: "bytes=0-0" } },
        );
        if (!response.ok) throw new Error(`unexpected HTTP ${response.status}`);
        const transferredBytes = await consumeBody(response);
        transferred[index] = transferredBytes;
        lengths[index] = download
          ? transferredBytes
          : parseCompleteLength(response, transferredBytes);
      } catch (error) {
        failures.push({ index, filename, error: String(error?.message ?? error) });
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, filenames.length)) },
      () => probeWorker(),
    ),
  );

  failures.sort((left, right) => left.index - right.index);
  const elapsedMs = performance.now() - startedAt;
  const sourceBytes = lengths.reduce((total, length) => total + length, 0);
  const transferredBytes = transferred.reduce(
    (total, length) => total + length,
    0,
  );
  return {
    mode: download ? "download" : "census",
    manifestUrl,
    ephemerisBase,
    manifestBytes: Buffer.byteLength(manifestText),
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    catalogEntries: catalogFilenames.length,
    selectedEntries: filenames.length,
    completedEntries: filenames.length - failures.length,
    probedEntries: filenames.length - failures.length,
    sourceBytes,
    transferredBytes,
    elapsedMs,
    probesPerSecond: elapsedMs > 0 ? filenames.length / (elapsedMs / 1000) : 0,
    bytesPerSecond:
      elapsedMs > 0 ? transferredBytes / (elapsedMs / 1000) : 0,
    concurrency,
    failures,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--manifest" && value) {
      options.manifestUrl = value;
      index += 1;
    } else if (flag === "--base" && value) {
      options.ephemerisBase = value;
      index += 1;
    } else if (flag === "--concurrency" && value) {
      options.concurrency = Number(value);
      index += 1;
    } else if (flag === "--download") {
      options.download = true;
    } else if (flag === "--sample" && value) {
      options.sampleCount = Number(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument ${flag}`);
    }
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await measureStarlinkCatalog(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
