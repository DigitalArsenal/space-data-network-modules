// Reference Zarr v3 chunk decoder (normative for the parser tests).
//
// Erasable TypeScript only: Node strips the annotations natively, there is no
// build step, and the wasm parser (src/weathernext_parser_module.cpp) has to
// reproduce these constants bit for bit for the "bytes" codec. "zstd" is
// decoded here through node:zlib; the wasm reports codec-unsupported for it
// until a zstd decoder is vendored (documented follow-up).

import { zstdDecompressSync } from "node:zlib";

export interface ChunkLayout {
  /** Codec chain as declared in zarr.json: outermost LAST (e.g. ["bytes", "zstd"]). */
  codecs: readonly string[];
  /** Zarr data type: "float32" or "float16". */
  dataType: string;
  /** Chunk shape in dimension order; the decoded cell count is its product. */
  chunkShape: readonly number[];
}

export function itemSizeOf(dataType: string): number {
  switch (dataType) {
    case "float32":
      return 4;
    case "float16":
      return 2;
    default:
      throw new Error(`unsupported chunk data type "${dataType}" (float32 or float16)`);
  }
}

export function cellCountOf(chunkShape: readonly number[]): number {
  let count = 1;
  for (const dim of chunkShape) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`chunk_shape must hold positive integers, got ${JSON.stringify(chunkShape)}`);
    }
    count *= dim;
  }
  return count;
}

// IEEE 754 binary16 -> binary32, bit-exact (subnormals, infinities, NaN).
export function halfToFloat(half: number): number {
  const sign = (half & 0x8000) !== 0 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const mantissa = half & 0x03ff;
  if (exponent === 0) {
    return sign * mantissa * 2 ** -24;
  }
  if (exponent === 0x1f) {
    return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  }
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function decodeBytesCodec(bytes: Uint8Array, dataType: string, cellCount: number): Float32Array {
  const itemSize = itemSizeOf(dataType);
  if (bytes.byteLength !== cellCount * itemSize) {
    throw new Error(
      `chunk-size-mismatch: decoded ${bytes.byteLength} bytes, expected ${cellCount} x ${itemSize}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(cellCount);
  if (dataType === "float32") {
    for (let i = 0; i < cellCount; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  const globalWithF16 = globalThis as { Float16Array?: new (buffer: ArrayBuffer) => ArrayLike<number> };
  if (typeof globalWithF16.Float16Array === "function" && bytes.byteOffset % 2 === 0) {
    const halves = new globalWithF16.Float16Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    for (let i = 0; i < cellCount; i++) out[i] = halves[i];
    return out;
  }
  for (let i = 0; i < cellCount; i++) out[i] = halfToFloat(view.getUint16(i * 2, true));
  return out;
}

/**
 * Decodes one chunk's raw bytes into float32 cells in chunk row-major order.
 * The codec chain is applied outermost-first on decode (the reverse of the
 * declared order); a chain that does not end in "bytes" is rejected.
 */
export function decodeChunk(bytes: Uint8Array, layout: ChunkLayout): Float32Array {
  const codecs = [...layout.codecs];
  if (codecs.length === 0 || codecs[0] !== "bytes") {
    throw new Error(`codec chain must start with "bytes", got ${JSON.stringify(codecs)}`);
  }
  let current: Uint8Array = bytes;
  for (let i = codecs.length - 1; i >= 1; i--) {
    const codec = codecs[i];
    if (codec === "zstd") {
      const inflated = zstdDecompressSync(current);
      current = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
      continue;
    }
    throw new Error(`codec-unsupported: "${codec}"`);
  }
  return decodeBytesCodec(current, layout.dataType, cellCountOf(layout.chunkShape));
}
