// Exercise poisoned batches, late writers, reload and destruction with wide sets.
process.env.SDNAP_TEST_WIDE_POOL = "1";
await import("./epoch-pool-safety.e2e.mjs");
