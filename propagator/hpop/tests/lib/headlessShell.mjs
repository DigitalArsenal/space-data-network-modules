// The only browser the receipts may launch: Chromium's headless shell from the
// Playwright cache (owner rule 2026-10-16). Never Google Chrome.app, Chrome for
// Testing or a `channel` browser: a full Chrome launched from a background
// process registers with the window server, aborts in HIServices and throws
// crash dialogs on the owner's screen. The SDK's parity lanes and this
// package's resident receipt read SDM_CHROME_BINARY, so every receipt script
// sets it here before any lane runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const FORBIDDEN = /Google Chrome|Chrome for Testing|Chromium\.app|google-chrome|chromium-browser/;

// The newest installed headless shell, or an explicit headless-shell path.
export function headlessShell(explicit = process.env.SDM_CHROME_BINARY) {
  if (explicit) {
    if (FORBIDDEN.test(explicit) || !/chrome-headless-shell/.test(explicit)) {
      throw new Error(`SDM_CHROME_BINARY must be a chrome-headless-shell binary, not ${explicit}`);
    }
    return explicit;
  }
  const dirs = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter((d) => /^chromium_headless_shell-\d+$/.test(d)) : [];
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const dir of dirs) {
    for (const sub of fs.readdirSync(path.join(CACHE, dir))) {
      const bin = path.join(CACHE, dir, sub, 'chrome-headless-shell');
      if (sub.startsWith('chrome-headless-shell') && fs.existsSync(bin)) return bin;
    }
  }
  throw new Error(`no chromium headless shell under ${CACHE} (npx playwright install chromium-headless-shell)`);
}

// Pins the browser for the SDK lanes of this process.
export function useHeadlessShell() {
  process.env.SDM_CHROME_BINARY = headlessShell();
  return process.env.SDM_CHROME_BINARY;
}
