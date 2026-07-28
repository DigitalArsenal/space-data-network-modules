/*
 * Shared driver for the CCSDS 124.0-B-1 vector suite.
 *
 * Used unchanged by BOTH runtime lanes:
 *  - the JS/SharedArrayBuffer lane (the browser contract: shared imported
 *    memory, same engine semantics as the SDK browser harness)
 *  - the WasmEdge lane (via tests/harness/wasmedge_runner.c, which links the
 *    same probe wasm bytes)
 *
 * so that a difference in results can only come from the wasm engine.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const PROBE_WASM = path.join(here, "build", "codec-probe.wasm");

// Parameters are the vector suite's own, read from the upstream metadata files.
// They are NOT invented here: byte-identity to the ESA reference output only
// holds for the exact (F, R, pt, ft, rt) the reference encoder used.
export const VECTORS = [
  { name: "simple", input: "simple.bin", expected: "simple.bin.pkt" },
  { name: "hiro", input: "hiro.bin", expected: "hiro.bin.pkt" },
  { name: "housekeeping", input: "housekeeping.bin", expected: "housekeeping.bin.pkt" },
  { name: "edge-cases", input: "edge-cases.bin", expected: "edge-cases.bin.pkt" },
  {
    name: "venus-express",
    input: "venus-express.ccsds",
    expected: "venus-express.ccsds.pkt",
  },
];

export function resolveVectorRoot() {
  const root = process.env.CCSDS124_VECTORS;
  if (!root) {
    throw new Error(
      "CCSDS124_VECTORS is not set. Point it at a checkout of " +
        "github.com/tanagraspace/ccsds124 (the test-vectors/ directory's parent).",
    );
  }
  return root;
}

export async function loadVectorSuite(vectorRoot) {
  const suite = [];
  for (const vector of VECTORS) {
    const metadataPath = path.join(
      vectorRoot,
      "test-vectors",
      "expected-output",
      `${vector.name}-metadata.json`,
    );
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    const params = metadata.compression.parameters;
    suite.push({
      ...vector,
      fBits: metadata.compression.packet_length * 8,
      robustness: params.robustness,
      ptLimit: params.pt,
      ftLimit: params.ft,
      rtLimit: params.rt,
      inputBytes: await fs.readFile(
        path.join(vectorRoot, "test-vectors", "input", vector.input),
      ),
      expectedBytes: await fs.readFile(
        path.join(vectorRoot, "test-vectors", "expected-output", vector.expected),
      ),
    });
  }
  return suite;
}

/**
 * Instantiate the probe over a SHARED imported memory — the browser contract
 * (SharedArrayBuffer). Returns a thin wrapper over the flat ABI.
 */
export async function instantiateProbe({ pages = 1280 } = {}) {
  const bytes = await fs.readFile(PROBE_WASM);
  const memory = new WebAssembly.Memory({
    initial: pages,
    maximum: 32768,
    shared: true,
  });
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  instance.exports._initialize?.();

  const view = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);

  const alloc = (size) => {
    const ptr = instance.exports.p124_alloc(size);
    if (ptr === 0) throw new Error(`probe arena exhausted allocating ${size} bytes`);
    return ptr;
  };

  return {
    memory,
    reset: () => instance.exports.p124_reset(),
    arenaCapacity: () => instance.exports.p124_arena_capacity(),

    compress(input, { fBits, robustness, ptLimit, ftLimit, rtLimit, outCapacity }) {
      instance.exports.p124_reset();
      const inPtr = alloc(input.length);
      view().set(input, inPtr);
      const capacity = outCapacity ?? input.length * 2 + 4096;
      const outPtr = alloc(capacity);
      const writtenPtr = alloc(4);
      const rc = instance.exports.p124_compress(
        inPtr, input.length, fBits, robustness, ptLimit, ftLimit, rtLimit,
        outPtr, capacity, writtenPtr,
      );
      if (rc !== 0) return { rc, bytes: null };
      const written = dv().getUint32(writtenPtr, true);
      return { rc, bytes: Buffer.from(view().slice(outPtr, outPtr + written)) };
    },

    decompress(input, { fBits, robustness, outCapacity }) {
      instance.exports.p124_reset();
      const inPtr = alloc(input.length);
      view().set(input, inPtr);
      // The caller MUST bound the output. POCKET+ is not self-delimiting in
      // the size sense: the only sound bound derivable from the bitstream alone
      // is packets <= input_bits, which for `housekeeping` is 160 MB for a
      // 900 KB answer. A ratio guess is equally wrong (`simple` compresses 14x
      // and overflows an 8x bound). This is why $CPS.PACKET_COUNT must be
      // required rather than advisory -- see SYNCHRONIZATION.md (d).
      if (!outCapacity) {
        throw new Error(
          "decompress requires an explicit outCapacity: POCKET+ output size is " +
            "not derivable from the compressed stream.",
        );
      }
      const capacity = outCapacity;
      const outPtr = alloc(capacity);
      const writtenPtr = alloc(4);
      const rc = instance.exports.p124_decompress(
        inPtr, input.length, fBits, robustness, outPtr, capacity, writtenPtr,
      );
      if (rc !== 0) return { rc, bytes: null };
      const written = dv().getUint32(writtenPtr, true);
      return { rc, bytes: Buffer.from(view().slice(outPtr, outPtr + written)) };
    },

    discover(input) {
      instance.exports.p124_reset();
      const inPtr = alloc(input.length);
      view().set(input, inPtr);
      const outPtr = alloc(4);
      const rc = instance.exports.p124_discover(inPtr, input.length, outPtr);
      return { rc, fBits: dv().getUint32(outPtr, true) };
    },
  };
}
