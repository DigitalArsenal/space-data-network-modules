// The task's acceptance entry point must never turn source qualification into
// a false production pass. Replace this gate only after the SDS oracle rules,
// a compliant module is built, and local-node publication is actually verified.
import {captureEvidence} from './source-evidence.mjs';
try {
  await captureEvidence();
  console.error('BLOCKED: source evidence captured; no approved solar SDS contract, compiled module, or CID publication/read-back. See data-source/solar-activity/REPORT.md.');
  process.exitCode = 2;
} catch (error) {
  console.error(`Source qualification failed: ${error.message}`);
  process.exitCode = 1;
}
