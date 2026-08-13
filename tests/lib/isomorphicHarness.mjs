/**
 * MOVED INTO THE SDK — W1.4 of graph/tasks/official-harness-shapes-program.md.
 *
 * The isomorphic module-test harness now lives at
 * `space-data-module-sdk/testing/isomorphic` (src/testing/isomorphicHarness.js
 * in the SDK repo), where the conformance runner and every module suite drive
 * artifacts through the same loader. This file survives only so the dozens of
 * existing `../../../tests/lib/isomorphicHarness.mjs` imports keep working;
 * new tests import the SDK subpath directly.
 *
 * Requires space-data-module-sdk >= 0.8.15 (the first version exporting
 * ./testing/isomorphic). The SDK lands before this repo does — if this import
 * fails, the SDK pin is stale, not this file.
 */

export {
  STANDALONE_RUNTIME_KINDS,
  isMissingWasmEdgeError,
  isWasmEdgeAvailable,
  createStandaloneHarness,
  createStandaloneHarnessOrSkip,
  assertSuccessfulResponse,
  invokeBinaryRequest,
  invokeJsonRequest,
} from "space-data-module-sdk/testing/isomorphic";
