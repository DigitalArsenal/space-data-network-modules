// The page of test/browser-pool.e2e.mjs: one hosting Worker per thread count; the results are posted back to the test's own server.
const threadCounts = JSON.parse(new URLSearchParams(location.search).get("threads") ?? "[0]");
const runWorker = (threads) => new Promise((resolve) => {
  const w = new Worker("/host-worker.js", { type: "module" });
  w.onerror = (e) => { w.terminate(); resolve({ ok: false, error: `worker error: ${e.message}` }); };
  w.onmessage = (e) => {
    if (e.data.type === "booted") w.postMessage({ job: "all", args: { threads } });
    else { w.terminate(); resolve(e.data.type === "result" ? { ok: true, result: e.data.result } : { ok: false, error: e.data.error, stack: e.data.stack }); }
  };
});
const out = { crossOriginIsolated: self.crossOriginIsolated, userAgent: navigator.userAgent, runs: {} };
try { for (const t of threadCounts) out.runs[t] = await runWorker(t); } catch (e) { out.fatal = String(e); }
await fetch(`/done?token=${encodeURIComponent(new URLSearchParams(location.search).get("token"))}`, { method: "POST", body: JSON.stringify(out) });
