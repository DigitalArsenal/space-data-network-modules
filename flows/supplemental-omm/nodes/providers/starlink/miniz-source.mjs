import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vendorRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "vendor/miniz-3.1.2",
);

const expectedSha256 = {
  "miniz.c": "e2c1aeb66eef9191d8c3feb164db2def2335a61d039bf04ed849f6b042433b30",
  "miniz.h": "b53b62ed122e559b8f679e3cb787a0b0035fe87a58f909da0e44931678f4e85f",
};

async function verifiedSource(filename) {
  const bytes = await readFile(path.join(vendorRoot, filename));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256[filename]) {
    throw new Error(
      `vendored miniz 3.1.2 ${filename} SHA-256 ${actual} does not match ` +
        expectedSha256[filename],
    );
  }
  return bytes.toString("utf8");
}

export async function minizSourceFragments() {
  const [header, implementation] = await Promise.all([
    verifiedSource("miniz.h"),
    verifiedSource("miniz.c"),
  ]);
  const include = '#include "miniz.h"';
  if (!implementation.startsWith(`${include}\n`)) {
    throw new Error("vendored miniz.c no longer has the expected header include");
  }
  return [
    [
      "#define MINIZ_NO_ARCHIVE_APIS 1",
      "#define MINIZ_NO_STDIO 1",
      "#define MINIZ_NO_TIME 1",
      "#define MINIZ_NO_ZLIB_APIS 1",
      "#define MINIZ_NO_ZLIB_COMPATIBLE_NAMES 1",
      header,
    ].join("\n"),
    implementation.slice(include.length + 1),
  ];
}
