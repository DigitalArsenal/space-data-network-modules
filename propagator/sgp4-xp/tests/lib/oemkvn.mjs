// CCSDS OEM text (KVN) into block descriptions for oemBytes: the host side of the tests, which read operator files.
export function parseOemKvn(text) {
  const blocks = [];
  let header = {};
  let meta = null;
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('COMMENT')) continue;
    if (line === 'META_START') { meta = {}; continue; }
    if (line === 'META_STOP') {
      current = { frame: meta.REF_FRAME, timeSystem: meta.TIME_SYSTEM, start: meta.START_TIME, stop: meta.STOP_TIME, useableStart: meta.USEABLE_START_TIME, useableStop: meta.USEABLE_STOP_TIME, object: { name: meta.OBJECT_NAME, id: meta.OBJECT_ID }, lines: [] };
      blocks.push(current);
      meta = null;
      continue;
    }
    const kv = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (kv) { (meta ?? header)[kv[1]] = kv[2].trim(); continue; }
    if (!current) continue;
    const f = line.split(/\s+/);
    if (f.length >= 7 && /^\d{4}-/.test(f[0])) current.lines.push({ epoch: f[0], r: f.slice(1, 4).map(Number), v: f.slice(4, 7).map(Number) });
  }
  return { header, blocks };
}
const FRAMES = { EME2000: 'EME2000', J2000: 'J2000', GCRF: 'GCRF', ICRF: 'ICRF', TEME: 'TEMEOFDATE', ITRF: 'ITRF2000', ECEF: 'ECEF' };
export const sdsFrame = (name) => FRAMES[name] ?? name;
