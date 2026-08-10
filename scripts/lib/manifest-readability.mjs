// EMBEDDED-MANIFEST READABILITY — can a host on TODAY'S SDK read this artifact's
// own declaration?
//
// Graph task: modules-shipped-artifact-resign-wave.
//
// Every other check in this repo asks whether an artifact can be REPRODUCED. This
// one asks something a reproducibility ledger cannot: whether the artifact can be
// LOADED. Those turned out to be different questions, and the second one had
// seven live answers of "no".
//
// The mechanism, measured rather than argued. `signModuleArtifact` embeds the
// module's `$PLG` manifest in an `sds.manifest` custom section, and the SDK's
// loader gate (`src/host/runtimeTargetGate.js`) decodes that section to decide
// whether the artifact admits the leg it is being loaded on. The $PLG ENCODING
// MOVED — the raw-em++ lane measured the same move from the other side
// (`plugin_get_manifest_flatbuffer_size()` 1,800 at the era vs `encodePlgManifest`
// emitting 3,232 at 0.8.12). An artifact carrying the older encoding is not
// rejected by the decoder; it is DECODED INTO GARBAGE — `runtimeTargets` comes
// back as a one-element array holding the whole raw FlatBuffer as a string. That
// admits no leg, so `assertArtifactRuntimeTarget` refuses the artifact on browser
// AND on wasmedge, and the module cannot be loaded anywhere at all.
//
// Silent, because nothing checked it: the bytes are valid wasm, the signature
// verifies, the sha256 matches the ledger, and the thread-model guard passes. The
// only thing wrong is that no current host will run it.
//
// Two things this deliberately does NOT do:
//
//   * It does not fail an artifact that declares NO manifest. An artifact with no
//     embedded declaration is unconstrained by the gate's own rule, and several
//     lanes legitimately ship one.
//   * It does not compile the SIGNED bytes as-is. `signModuleArtifact` appends a
//     detached `$REC` publication trailer (964 B) past the end of the module
//     proper; `WebAssembly.Module()` refuses that, and the node's own
//     `pmm.HashArtifact` strips it before hashing for exactly the same reason. So
//     the trailer is stripped here too, and what is checked is the PORTABLE bytes
//     — the same bytes a host is handed.

// The SDK's PUBLIC entry for the gate, not a deep path into its src/ — this check
// stands or falls with the gate the hosts actually run, so it must break loudly if
// that surface is ever withdrawn rather than quietly reach around it.
import { embeddedRuntimeTargets } from "space-data-module-sdk/host/runtime-target-gate";

/**
 * End of the wasm module proper: the first byte that is not part of a section
 * this format knows. Everything after it is an appended payload (the `$REC`
 * publication trailer), not module content.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {number}
 */
export function moduleProperEnd(bytes) {
  const buf = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0x6d736100) return buf.length;
  let offset = 8;
  while (offset < buf.length) {
    const id = buf[offset];
    // 0..11 are the MVP sections, 12 is datacount, 13 is the TAG section from the
    // exception-handling proposal. Stopping at 12 truncated every EH module in the
    // repo mid-body (`propagator/sgp4` at offset 2,192, where its tag section
    // begins) and produced a "function count is 1260, but code section…" that
    // looked like a corrupt artifact rather than a short walker.
    if (id > 13) return offset;
    let cursor = offset + 1;
    let size = 0;
    let shift = 0;
    let byte;
    do {
      if (cursor >= buf.length) return offset;
      byte = buf[cursor++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    if (cursor + size > buf.length) return offset;
    offset = cursor + size;
  }
  return offset;
}

/**
 * A target string is GARBAGE when it could not have been written by a human as a
 * runtime-target name: over-long, or carrying bytes outside printable ASCII. That
 * is what a mis-decoded FlatBuffer looks like coming out of the decoder, and it is
 * the difference between "declares targets this host is not" (a legitimate
 * refusal) and "declares nothing readable" (this defect).
 */
function looksLikeGarbage(target) {
  return target.length > 40 || /[^\x20-\x7e]/.test(target);
}

/**
 * @param {Buffer|Uint8Array} bytes committed artifact, signed or not
 * @param {string} label
 * @returns {{label: string, ok: boolean, reason: string|null, targets: string[]}}
 */
export function inspectEmbeddedManifest(bytes, label = "artifact") {
  const portable = Buffer.from(bytes).subarray(0, moduleProperEnd(bytes));
  let compiled;
  try {
    compiled = new WebAssembly.Module(portable);
  } catch (error) {
    return { label, ok: false, reason: `does not compile: ${String(error.message).split("\n")[0]}`, targets: [] };
  }
  let targets;
  try {
    targets = embeddedRuntimeTargets(compiled);
  } catch (error) {
    return { label, ok: false, reason: `embedded manifest could not be read: ${error.message}`, targets: [] };
  }
  if (targets.length === 0) return { label, ok: true, reason: null, targets };
  const garbage = targets.filter(looksLikeGarbage);
  if (garbage.length) {
    return {
      label,
      ok: false,
      reason:
        "embedded $PLG manifest DECODES INTO GARBAGE at the current SDK — runtimeTargets came back as " +
        `${targets.length} entr${targets.length === 1 ? "y" : "ies"} of raw FlatBuffer bytes. ` +
        "The manifest encoding moved under this artifact, so the loader gate admits NO leg and no current host " +
        "will run it. Rebuild the module at the current pin.",
      targets: [],
    };
  }
  return { label, ok: true, reason: null, targets };
}
