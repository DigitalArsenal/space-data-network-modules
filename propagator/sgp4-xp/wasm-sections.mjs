// The one thing build.mjs needs from the WebAssembly binary format that no package here provides: reading and
// rewriting the export section. A section is an id byte, a LEB128 length and a payload; the export section (id 7)
// is a vector of (name, kind, index). Every other section is copied through byte for byte.
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readU32(buf, offset) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[offset++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [result, offset];
}

function u32(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Uint8Array.from(out);
}

function sections(bytes) {
  const list = [];
  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset];
    const [length, payloadStart] = readU32(bytes, offset + 1);
    list.push({ id, payload: bytes.subarray(payloadStart, payloadStart + length) });
    offset = payloadStart + length;
  }
  return list;
}

/** The exports of a module: [{ name, kind, index }]. */
export function exportNames(bytes) {
  const section = sections(bytes).find((s) => s.id === 7);
  if (!section) return [];
  const [count, start] = readU32(section.payload, 0);
  let offset = start;
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const [nameLength, nameStart] = readU32(section.payload, offset);
    const name = decoder.decode(section.payload.subarray(nameStart, nameStart + nameLength));
    const kind = section.payload[nameStart + nameLength];
    const [index, next] = readU32(section.payload, nameStart + nameLength + 1);
    entries.push({ name, kind, index });
    offset = next;
  }
  return entries;
}

/** The module with only the exports whose names are in `keep`. */
export function filterExports(bytes, keep) {
  const kept = exportNames(bytes).filter((e) => keep.has(e.name));
  const parts = [u32(kept.length)];
  for (const e of kept) {
    const name = encoder.encode(e.name);
    parts.push(u32(name.length), name, Uint8Array.of(e.kind), u32(e.index));
  }
  const rebuilt = Buffer.concat(parts);
  const out = [bytes.subarray(0, 8)];
  for (const s of sections(bytes)) {
    const payload = s.id === 7 ? rebuilt : s.payload;
    out.push(Uint8Array.of(s.id), u32(payload.length), payload);
  }
  return new Uint8Array(Buffer.concat(out));
}
