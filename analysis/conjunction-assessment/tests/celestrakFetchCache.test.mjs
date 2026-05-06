import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fetchCachedText,
  readCachedText,
} from "../scripts/lib/celestrakFetchCache.mjs";

test("CelesTrak fetch cache reuses cached responses before network fetch", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "celestrak-cache-test-"));
  try {
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        text: async () => `payload-${fetchCount}`,
      };
    };
    const url = "https://celestrak.org/SOCRATES/data.php?CATNR=1,2&FORMAT=json";

    const first = await fetchCachedText(url, {
      cacheDir,
      extension: "json",
      fetchImpl,
    });
    const second = await fetchCachedText(url, {
      cacheDir,
      extension: "json",
      fetchImpl,
    });

    assert.equal(fetchCount, 1);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(second.text, "payload-1");
    assert.equal(await readCachedText(url, { cacheDir, extension: "json" }), "payload-1");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("CelesTrak fetch cache supports explicit force refresh", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "celestrak-cache-test-"));
  try {
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        text: async () => `payload-${fetchCount}`,
      };
    };
    const url = "https://celestrak.org/SOCRATES/sort-maxProb.csv";

    await fetchCachedText(url, { cacheDir, extension: "csv", fetchImpl });
    const refreshed = await fetchCachedText(url, {
      cacheDir,
      extension: "csv",
      fetchImpl,
      forceRefresh: true,
    });

    assert.equal(fetchCount, 2);
    assert.equal(refreshed.cacheHit, false);
    assert.equal(refreshed.text, "payload-2");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
