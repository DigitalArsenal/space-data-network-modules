import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

export function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  values.push(current);
  return values;
}

export async function* readCsvRows(filePath, options = {}) {
  const input = createReadStream(filePath);
  const stream = String(filePath).endsWith(".gz")
    ? input.pipe(zlib.createGunzip())
    : input;
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const limit =
    options.limit === undefined ? Number.POSITIVE_INFINITY : Number(options.limit);
  let headers = null;
  let rowCount = 0;

  for await (const line of lineReader) {
    if (!headers) {
      headers = parseCsvLine(line);
      continue;
    }
    if (rowCount >= limit) {
      break;
    }
    const values = parseCsvLine(line);
    const row = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index]] = values[index] ?? "";
    }
    rowCount += 1;
    yield row;
  }
}

export async function listOcmDirectoryEntries(rootDir, options = {}) {
  const entries = [];
  const suffix = options.suffix ?? ".ocm";

  async function walk(currentDir) {
    const dirEntries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith(suffix)) {
        continue;
      }
      entries.push(path.relative(rootDir, fullPath).split(path.sep).join("/"));
    }
  }

  await walk(rootDir);
  return entries.sort();
}

export async function readOcmDirectoryEntryText(rootDir, entryPath) {
  return readFile(path.join(rootDir, entryPath), "utf8");
}
