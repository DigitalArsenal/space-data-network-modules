// The "flatsql" host trampolines flatsql-store imports, answered over the guest's own memory the way the Go node's
// flatsqlrt bake does (mechanical byte movers): an arena per wrapper file identifier (SOMM -> sds_omm, ...), a global
// monotonic ingest sequence (_rowid), tombstones, and compact. The SQL is the module's own; this host answers exactly
// the three statements the module sends and fails anything else (so a changed statement fails the tests).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SDK_ROOT = fs.realpathSync(fileURLToPath(new URL("../node_modules/space-data-module-sdk/", import.meta.url)));
const { ByteBuffer } = createRequire(pathToFileURL(path.join(SDK_ROOT, "package.json")))("flatbuffers");

const TABLE_BY_FID = { SOMM: "sds_omm", SOCM: "sds_ocm", SOBD: "sds_obd" };
const COUNT_SQL = /^SELECT COUNT\(\*\) FROM (sds_omm|sds_ocm|sds_obd) WHERE cid = \?$/;
const STALE_SQL = /^SELECT batch_id FROM \(SELECT batch_id, MAX\(_rowid\) AS m FROM (sds_omm|sds_ocm|sds_obd) GROUP BY batch_id ORDER BY m DESC\) LIMIT -1 OFFSET (\d+)$/;
const ROWIDS_SQL = /^SELECT _rowid FROM (sds_omm|sds_ocm|sds_obd) WHERE batch_id = \?$/;

// The wrapper table: 0 cid, 1 provider, 2 source_name, 3 batch_id, 4 data, 5 pulled_at:long.
export function decodeWrapper(bytes) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(0);
  const str = (vo) => { const o = bb.__offset(root, vo); return o ? bb.__string(root + o) : null; };
  const dataOff = bb.__offset(root, 12);
  const pulledOff = bb.__offset(root, 14);
  return {
    fileId: new TextDecoder().decode(bytes.subarray(4, 8)),
    cid: str(4), provider: str(6), sourceName: str(8), batchId: str(10),
    data: dataOff ? bytes.slice(bb.__vector(root + dataOff), bb.__vector(root + dataOff) + bb.__vector_len(root + dataOff)) : null,
    pulledAt: pulledOff ? Number(bb.readInt64(root + pulledOff)) : 0,
  };
}

export function createFlatsqlHost() {
  let memory = null;
  let seq = 0;
  const tables = { sds_omm: [], sds_ocm: [], sds_obd: [] };
  const log = { ingested: [], sql: [], tombstoned: [], compacts: 0 };
  const bytes = (ptr, len) => new Uint8Array(memory.buffer, ptr, len).slice();
  const live = (t) => tables[t].filter((r) => !r.deleted);

  function envelope(ptr, len) {
    const b = bytes(ptr, len), v = new DataView(b.buffer);
    const sqlLen = v.getUint32(0, true);
    const sql = new TextDecoder().decode(b.subarray(4, 4 + sqlLen));
    const count = v.getUint32(4 + sqlLen, true);
    const params = [];
    let at = 8 + sqlLen;
    for (let i = 0; i < count; i++) {
      const tag = b[at], n = v.getUint32(at + 1, true);
      params.push({ tag, value: new TextDecoder().decode(b.subarray(at + 5, at + 5 + n)) });
      at += 5 + n;
    }
    log.sql.push({ sql, params });
    return { sql, params };
  }

  const flatsql = {
    ingest_record(ptr, len) {
      const b = bytes(ptr, len);
      const w = decodeWrapper(b);
      const table = TABLE_BY_FID[w.fileId];
      if (!table) return -1n;
      seq += 1;
      tables[table].push({ seq, bytes: b, cid: w.cid, batchId: w.batchId, deleted: false });
      log.ingested.push({ table, bytes: b });
      return BigInt(seq);
    },
    exec_envelope(ptr, len) {
      const { sql, params } = envelope(ptr, len);
      const m = COUNT_SQL.exec(sql);
      if (!m || params.length !== 1 || params[0].tag !== 4) return -1n;
      return BigInt(live(m[1]).filter((r) => r.cid === params[0].value).length);
    },
    query_rows(ptr, len, outPtr, outCap) {
      const { sql, params } = envelope(ptr, len);
      let rows;
      let m;
      if ((m = STALE_SQL.exec(sql)) && params.length === 0) {
        const max = new Map();
        for (const r of live(m[1])) max.set(r.batchId, Math.max(max.get(r.batchId) ?? 0, r.seq));
        rows = [...max.entries()].sort((a, b) => b[1] - a[1]).slice(Number(m[2])).map(([batch]) => [[2, batch]]);
      } else if ((m = ROWIDS_SQL.exec(sql)) && params.length === 1 && params[0].tag === 4) {
        rows = live(m[1]).filter((r) => r.batchId === params[0].value).map((r) => [[1, r.seq]]);
      } else {
        return -1n;
      }
      const out = [];
      const u32 = (n) => out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
      u32(rows.length);
      for (const row of rows) {
        u32(row.length);
        for (const [type, value] of row) {
          out.push(type);
          if (type === 1) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(value), true); out.push(...b); }
          else { const s = new TextEncoder().encode(value); u32(s.length); out.push(...s); }
        }
      }
      if (out.length <= outCap) new Uint8Array(memory.buffer, outPtr, out.length).set(out);
      return BigInt(out.length);
    },
    mark_deleted_bulk(tblPtr, tblLen, seqsPtr, seqCount) {
      const table = new TextDecoder().decode(bytes(tblPtr, tblLen));
      if (!tables[table]) return -1n;
      const v = new DataView(memory.buffer, seqsPtr, seqCount * 8);
      let n = 0;
      for (let i = 0; i < seqCount; i++) {
        const s = Number(v.getBigUint64(i * 8, true));
        const row = tables[table].find((r) => r.seq === s && !r.deleted);
        if (row) { row.deleted = true; n++; log.tombstoned.push({ table, seq: s, batchId: row.batchId }); }
      }
      return BigInt(n);
    },
    compact() {
      log.compacts += 1;
      let survivors = 0;
      for (const t of Object.keys(tables)) { tables[t] = live(t); survivors += tables[t].length; }
      return BigInt(survivors);
    },
  };
  return { flatsql, tables, log, live, bind(mem) { memory = mem; } };
}

// Runs `make` with WebAssembly.instantiate patched so the instance also gets the "flatsql" import module.
export async function withFlatsqlImports(host, make) {
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    const result = await instantiate(module, { ...imports, flatsql: host.flatsql });
    const instance = result.instance ?? result;
    host.bind(instance.exports.memory);
    return result;
  };
  try { return await make(); } finally { WebAssembly.instantiate = instantiate; }
}
