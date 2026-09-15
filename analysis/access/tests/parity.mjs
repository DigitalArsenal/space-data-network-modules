import fs from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { normalizeParityFixture, runParityHarness, formatParityReport } from "space-data-module-sdk/testing";
import { vectors, requestFor } from "./orekit-fixture.mjs";
const cases = vectors.map((vector, index) => {
  const request = requestFor(vector);
  return { id: `orekit-${index}`, request: { ...request, inputs: request.inputs.map(({ payload, ...frame }) => ({ ...frame, payloadHex: Buffer.from(payload).toString("hex") })) } };
});
const plan = await normalizeParityFixture({ name: "lane10 access Orekit and command errors", threadCounts: [1, 2, 4, 8], cases: [...cases,
  { id: "empty-stdin", stdinUtf8: "" }, { id: "malformed-stdin", stdinUtf8: "not a PIV frame" }, { id: "truncated-piv-header", stdinHex: "24504956" },
] });
const report = await runParityHarness({ wasmPath: fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)), plan, timeoutMs: 60000, log: console.log });
console.log(formatParityReport(report));
if (process.env.LANE10_PARITY_REPORT) fs.writeFileSync(process.env.LANE10_PARITY_REPORT, JSON.stringify(report, null, 2));
assert.equal(report.ok, true, JSON.stringify(report.failures));
