/**
 * The ratchet's one definition of "how many vectors do we have, and how many of
 * them are green", shared by the test that enforces it and the tool that raises
 * it.
 *
 * Written once on purpose: a ratchet whose checker and whose updater count
 * differently is a ratchet that can be raised past what it protects.
 */

/**
 * `expectedToFail` is the only thing that makes a row not-green here, and that
 * is deliberate. This function does not RUN the vectors — it reads the ledger.
 * A row that is expected to pass and is failing turns the suite red on its own;
 * a row that is expected to FAIL is invisible to that mechanism, and counting
 * it is the entire reason this file exists.
 */
export function summariseVectors(vectors) {
  const byOperation = {};
  const byLibrary = {};

  for (const testCase of vectors.cases) {
    const operation = testCase.operation ?? "unknown";
    const library = testCase.source?.library ?? testCase.source?.repo ?? "in-repo";
    const green = testCase.expectedToFail ? 0 : 1;

    byOperation[operation] ??= { total: 0, green: 0, knownRed: 0 };
    byOperation[operation].total += 1;
    byOperation[operation].green += green;
    byOperation[operation].knownRed += green ? 0 : 1;

    byLibrary[library] ??= { total: 0, green: 0, knownRed: 0 };
    byLibrary[library].total += 1;
    byLibrary[library].green += green;
    byLibrary[library].knownRed += green ? 0 : 1;
  }

  return {
    total: vectors.cases.length,
    green: vectors.cases.filter((entry) => !entry.expectedToFail).length,
    byOperation,
    byLibrary,
  };
}
