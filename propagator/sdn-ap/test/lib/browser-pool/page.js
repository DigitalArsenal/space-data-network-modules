// The page of test/browser-pool.e2e.mjs: one hosting Worker per thread count; the results are posted back to the test's own server.
const threadCounts = JSON.parse(new URLSearchParams(location.search).get("threads") ?? "[0]");
const token = new URLSearchParams(location.search).get("token");
const runWorker = (threads) => new Promise((resolve, reject) => {
  const w = new Worker("/host-worker.js", { type: "module" });
  let timer;
  const finish = (result) => { clearTimeout(timer); w.terminate(); resolve(result); };
  const arm = (name) => {
    const label = `${threads} threads: ${name}`;
    clearTimeout(timer);
    timer = setTimeout(() => { w.terminate(); reject(new Error(`${label}: exceeded 5 minutes`)); }, 5 * 60 * 1000);
    void fetch(`/progress?token=${encodeURIComponent(token)}&case=${encodeURIComponent(label)}`, { method: "POST" });
  };
  arm("host startup");
  w.onerror = (e) => finish({ ok: false, error: `worker error: ${e.message}` });
  w.onmessage = (e) => {
    if (e.data.type === "booted") w.postMessage({ job: "all", args: { threads } });
    else if (e.data.type === "case") arm(e.data.name);
    else finish(e.data.type === "result" ? { ok: true, result: e.data.result } : { ok: false, error: e.data.error, stack: e.data.stack });
  };
});
const out = { crossOriginIsolated: self.crossOriginIsolated, userAgent: navigator.userAgent, runs: {} };
try { for (const t of threadCounts) out.runs[t] = await runWorker(t); } catch (e) { out.fatal = String(e); }
await fetch(`/done?token=${encodeURIComponent(new URLSearchParams(location.search).get("token"))}`, { method: "POST", body: JSON.stringify(out) });
