import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = fs.readFileSync(
  path.join(packageRoot, "nodes/od/src/node.cpp"),
  "utf8",
);

test("OD applies one 256 MiB budget to parsing, fitting, and output assembly", () => {
  assert.match(
    source,
    /bool transient_budget_allows\s*\(\s*size_t workspace_bytes\s*\)/,
  );
  assert.match(
    source,
    /queued_storage_bytes\(\)[^]*kGuestTransientBudgetBytes/s,
    "the global check must combine live queues with phase-local workspace",
  );

  const fit = source.slice(source.indexOf('extern "C" int fit(void)'));
  const parseCheck = fit.indexOf("native_parse_workspace_bytes");
  const parseCall = fit.indexOf("parse_native_response");
  assert.ok(parseCheck >= 0 && parseCheck < parseCall);
  assert.match(fit, /fit_workspace_bytes[^]*run_batch_fit/s);
  assert.match(fit, /output_workspace_bytes[^]*append_result/s);
});

test("OD parses the completed native response without a full text duplicate", () => {
  assert.match(
    source,
    /std::string_view content\s*\([^;]+assembly\.bytes\.data\(\)[^;]+assembly\.bytes\.size\(\)\s*\)/s,
  );
  assert.doesNotMatch(
    source,
    /std::string content\s*\(\s*assembly\.bytes\.begin\(\)\s*,\s*assembly\.bytes\.end\(\)\s*\)/,
  );
  assert.doesNotMatch(
    source,
    /const std::string line\s*\(\s*line_view\s*\)/,
    "an unterminated adversarial line must not duplicate the complete response",
  );
  assert.match(
    source,
    /std::array<std::string_view,\s*TokenCapacity>/,
    "native tokenization must use bounded views rather than heap-owned tokens",
  );
});

test("OD cannot admit an oversized first object past the fit batch byte cap", () => {
  assert.match(
    source,
    /candidate\.object\.oem\.size\(\)\s*>\s*kMaxFitBatchBytes/,
    "oversized OEMs must fail before entering the pending queue",
  );
  assert.doesNotMatch(
    source,
    /if\s*\(\s*!batch_objects\.empty\(\)\s*&&\s*\(\s*batch_bytes\s*>=\s*kMaxFitBatchBytes/s,
    "the first object must be subject to the same batch byte predicate",
  );
  assert.match(
    source,
    /if\s*\(\s*object_bytes\s*>\s*kMaxFitBatchBytes\s*\|\|[^]*?object_bytes\s*>\s*kMaxFitBatchBytes\s*-\s*batch_bytes\s*\)/s,
  );
});

test("OD admission backs off before popping a batch that would exceed the budget", () => {
  const fit = source.slice(source.indexOf('extern "C" int fit(void)'));
  const prospectiveCheck = fit.indexOf("prospective_fit_workspace");
  const pendingMove = fit.indexOf(
    "PendingFitObject pending =",
    prospectiveCheck,
  );
  assert.ok(prospectiveCheck >= 0 && prospectiveCheck < pendingMove);
  assert.match(
    fit,
    /transient_budget_allows_after_releasing\s*\(\s*prospective_fit_workspace\s*,\s*candidate_storage_bytes\s*\)/,
  );
  assert.doesNotMatch(
    fit,
    /for\s*\(\s*size_t index = admitted\.size\(\)[^]*g_pending_fit_objects\.push_front/s,
    "a repeatedly restored over-budget prefix can poison every continuation",
  );
});

test("OD admission protects fitted output and the pending fit after fitted storage drains", () => {
  const mib = 1024 * 1024;
  const budgetBytes = 256 * mib;
  const inputEnvelopeBytes = 1 * mib;
  const fittedStorageBytes = 1 * mib;
  const pendingHeadStorageBytes = 4 * mib;
  const otherQueuedBytes = 95 * mib;
  const additionalQueuedBytes = 91 * mib;
  const queuedBytes =
    fittedStorageBytes + pendingHeadStorageBytes + otherQueuedBytes;

  const outputWorkspaceBytes = 4 * mib + 7 * fittedStorageBytes;
  const immediateOutputBytes =
    inputEnvelopeBytes +
    queuedBytes +
    additionalQueuedBytes -
    fittedStorageBytes +
    outputWorkspaceBytes;
  assert.equal(immediateOutputBytes, 202 * mib);
  assert.ok(immediateOutputBytes <= budgetBytes);

  const pendingOemBytes = 4 * mib;
  const pendingFitWorkspaceBytes =
    pendingHeadStorageBytes + 16 * pendingOemBytes + 2 * mib;
  const futurePendingFitBytes =
    inputEnvelopeBytes +
    queuedBytes +
    additionalQueuedBytes -
    fittedStorageBytes -
    pendingHeadStorageBytes +
    pendingFitWorkspaceBytes;
  assert.equal(futurePendingFitBytes, 257 * mib);
  assert.ok(futurePendingFitBytes > budgetBytes);

  const activeReserveStart = source.indexOf(
    "bool active_head_work_reserve_allows",
  );
  const activeReserveEnd = source.indexOf(
    "\n}\n\nvoid append_u32_be",
    activeReserveStart,
  );
  assert.ok(activeReserveStart >= 0 && activeReserveEnd > activeReserveStart);
  const activeReserve = source.slice(activeReserveStart, activeReserveEnd);
  assert.match(
    activeReserve,
    /fitted_head_output_reserve_allows\s*\(\s*additional_queued_bytes\s*\)/,
  );
  assert.match(
    activeReserve,
    /pending_head_fit_reserve_allows_after_releasing\s*\(\s*additional_queued_bytes\s*,\s*fitted_fit_bytes\(\)\s*,\s*first_additional\s*\)/,
    "admission must also reserve the pending fit after every fitted result drains",
  );
});

test("OD reserves the complete SDK response-copy envelope", () => {
  assert.match(
    source,
    /kMaxFittedFitBytes\s*=\s*8u?\s*\*\s*1024u?\s*\*\s*1024u?\s*;/,
  );
  assert.match(
    source,
    /output_workspace_bytes\([^]*scaled_workspace_bytes\([^;]+fitted_storage_bytes\s*,\s*7\s*\)/s,
  );
});

test("OD charges the live PIV request and hard-caps parser cardinality", () => {
  assert.match(source, /current_input_envelope_bytes\(\)/);
  assert.match(
    source,
    /g_current_input_envelope_bytes[^]*queued_storage_bytes\(\)[^]*kGuestTransientBudgetBytes/s,
  );
  assert.match(source, /kMaxNativeStatesPerObject\s*=\s*20000\s*;/);
  assert.match(source, /kMaxNativeObjectsPerResponse\s*=\s*64\s*;/);
  assert.match(source, /native_states_within_bounds/);

  const fit = source.slice(source.indexOf('extern "C" int fit(void)'));
  const parsedCountCheck = fit.indexOf(
    "parsed.size() > available_pending_objects",
  );
  const pendingReserve = fit.indexOf("pending.reserve(parsed.size())");
  assert.ok(parsedCountCheck >= 0 && parsedCountCheck < pendingReserve);
});

test("OD stops native-state parsing at the exact 20,000-state cap", () => {
  const maxStates = 20_000;
  let acceptedStates = 0;
  for (let index = 0; index < maxStates + 1; index += 1) {
    if (acceptedStates >= maxStates) break;
    acceptedStates += 1;
  }
  assert.equal(acceptedStates, maxStates);
  assert.match(
    source,
    /if\s*\(\s*!states\s*\|\|\s*states->size\(\)\s*>=\s*kMaxNativeStatesPerObject\s*\)\s*return\s*;/,
    "the parser must not append state 20,001 before the validation gate",
  );
});

test("OD storage counters fail closed and chunk growth uses an exact replacement", () => {
  for (const helperName of [
    "pending_object_storage_bytes",
    "batch_result_storage_bytes",
    "fitted_object_storage_bytes",
  ]) {
    const start = source.indexOf(`size_t ${helperName}`);
    const end = source.indexOf("\n}", start);
    assert.ok(start >= 0 && end > start);
    assert.match(
      source.slice(start, end),
      /return kGuestTransientBudgetBytes \+ 1;/,
      `${helperName} must expose accounting overflow`,
    );
  }
  assert.match(
    source,
    /std::vector<uint8_t> replacement\s*\(\s*new_size\s*\)/,
  );
  assert.doesNotMatch(source, /assembly\.bytes\.reserve\s*\(\s*new_size\s*\)/);
});
