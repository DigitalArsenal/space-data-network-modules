import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "..");
const generatedDir = path.join(packageRoot, "src", "cpp", "generated", "sds");

test("licensing package checks in canonical SDS generated headers for module delivery", () => {
  for (const family of ["PLG", "ENC", "REC", "LCH", "LPF", "LGR", "LMR", "LCF", "KRF", "KMF"]) {
    const headerPath = path.join(generatedDir, `${family}_generated.h`);
    assert.equal(
      fs.existsSync(headerPath),
      true,
      `${family} generated header missing`,
    );
  }
});
