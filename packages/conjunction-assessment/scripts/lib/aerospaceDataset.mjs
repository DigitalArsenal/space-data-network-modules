import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

export function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index++;
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

  let headers = null;
  let rowCount = 0;
  const limit =
    options.limit === undefined ? Number.POSITIVE_INFINITY : options.limit;

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
    for (let index = 0; index < headers.length; index++) {
      row[headers[index]] = values[index] ?? "";
    }
    rowCount++;
    yield row;
  }
}

export async function* readGzipCsvRows(filePath, options = {}) {
  yield* readCsvRows(filePath, options);
}

export function spawnCommandLines(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    child,
    lines: readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    }),
  };
}

export async function* listTarEntries(tarPath, options = {}) {
  const tarArgs = ["-tzf", tarPath];
  if (options.entries?.length) {
    tarArgs.push(...options.entries);
  }

  const { child, lines } = spawnCommandLines("tar", tarArgs, options);
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  try {
    for await (const line of lines) {
      yield line;
    }
  } finally {
    lines.close();
  }

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `tar -tzf failed for ${tarPath}: ${Buffer.concat(stderrChunks).toString("utf8")}`,
    );
  }
}

export async function readTarEntryText(tarPath, entryPath, options = {}) {
  const child = spawn("tar", ["-xOf", tarPath, entryPath], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `tar -xOf failed for ${entryPath}: ${Buffer.concat(stderrChunks).toString("utf8")}`,
    );
  }
  return Buffer.concat(stdoutChunks).toString("utf8");
}

export async function collectTarEntries(tarPath, options = {}) {
  const entries = [];
  for await (const entry of listTarEntries(tarPath, options)) {
    entries.push(entry);
  }
  return entries;
}

export async function listOcmEntries(tarPath, options = {}) {
  const entries = [];
  const suffix = options.suffix ?? ".ocm";
  const contains = options.contains ? String(options.contains) : "";

  for await (const entry of listTarEntries(tarPath, options)) {
    if (!entry.endsWith(suffix)) {
      continue;
    }
    if (contains && !entry.includes(contains)) {
      continue;
    }
    entries.push(entry);
  }

  return entries;
}

export async function listOcmDirectoryEntries(rootDir, options = {}) {
  const entries = [];
  const suffix = options.suffix ?? ".ocm";
  const contains = options.contains ? String(options.contains) : "";

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
      const relativePath = path.relative(rootDir, fullPath).split(path.sep).join("/");
      if (contains && !relativePath.includes(contains)) {
        continue;
      }
      entries.push(relativePath);
    }
  }

  await walk(rootDir);
  return entries.sort();
}

export async function readOcmDirectoryEntryText(rootDir, entryPath) {
  return readFile(path.join(rootDir, entryPath), "utf8");
}

export async function maybeWriteJson(outputPath, value) {
  if (!outputPath) {
    return;
  }
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
