/**
 * CelesTrak fetch policy helpers (see ../CELESTRAK_FETCH_POLICY.md).
 *
 * Enforces: >=2.5s serial pacing (flag values below the floor are raised),
 * the 3-hour same-key rule via a persistent ledger of successful fetches,
 * and run-abort after 30 consecutive failures.
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export const MIN_INTERVAL_MS = 2500;
export const WINDOW_MS = 10_800_000; // 3 hours
export const HALT_AFTER = 30;

export class FetchPolicy {
  constructor(ledgerPath) {
    this.ledgerPath = ledgerPath;
    this.last = new Map();
    this.consecutiveFailures = 0;
    mkdirSync(dirname(ledgerPath), { recursive: true });
    if (existsSync(ledgerPath)) {
      for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
        const [key, epoch] = line.split('\t');
        if (key && epoch) this.last.set(key, Number(epoch) * 1000);
      }
    }
  }

  /** Enforce the rate floor on a user-supplied interval. */
  static clampInterval(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < MIN_INTERVAL_MS) return MIN_INTERVAL_MS;
    return n;
  }

  /** true when the key may be fetched (not successfully fetched in 3h). */
  allowed(key) {
    const t = this.last.get(key);
    return !(t && Date.now() - t < WINDOW_MS);
  }

  /** Record a successful fetch of key. */
  record(key) {
    const now = Date.now();
    this.last.set(key, now);
    appendFileSync(this.ledgerPath, `${key}\t${Math.floor(now / 1000)}\n`);
  }

  /** Register a failure; throws when the run must halt. */
  noteFailure(context = '') {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= HALT_AFTER) {
      throw new Error(
        `POLICY HALT: ${this.consecutiveFailures} consecutive failures${context ? ` (${context})` : ''} — aborting run; investigate, do not hammer.`,
      );
    }
  }

  noteSuccess() {
    this.consecutiveFailures = 0;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
