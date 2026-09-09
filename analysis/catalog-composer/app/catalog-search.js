const terms = query => {
  if (query.length > 1024) throw new Error('Search is limited to 1,024 characters.');
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (words.length > 64) throw new Error('Search is limited to 64 terms.');
  return words.map(word => `"${word.replaceAll('"', '""')}"`).join(' AND ');
};

/** One disposable FTS5 index of the complete composition report. Row IDs map
 * directly to report positions, including unresolved identity conflicts. */
export function createCatalogSearch(engine, { yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  let db, size = 0;
  return {
    async replace(rows) {
      const next = engine.createDatabase('{"tables":[]}', 'catalog-editor-search');
      try {
        next.query("CREATE VIRTUAL TABLE objects USING fts5(text, review UNINDEXED, tokenize='unicode61 remove_diacritics 2')");
        next.query('BEGIN');
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          const text = [row.key, row.name, ...row.candidates.flatMap(candidate => [candidate.name, candidate.nativeKey, candidate.designator])].filter(Boolean).join(' ');
          next.query('INSERT INTO objects(rowid,text,review) VALUES(?,?,?)', [index + 1, text, row.state?.status === 'overlap' ? '1' : '0']);
          if ((index + 1) % 512 === 0) await yieldFrame();
        }
        next.query('COMMIT');
      } catch (error) { next.destroy(); throw error; }
      db?.destroy(); db = next; size = rows.length;
    },
    page(query = '', page = 1, pageSize = 100, overlapsOnly = false) {
      if (!db) return { total:0, page:1, pages:1, indices:[] };
      const match = terms(query), parameters = match ? [match] : [];
      const clauses = [...(match ? ['objects MATCH ?'] : []), ...(overlapsOnly ? ["review = '1'"] : [])];
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const total = where ? Number(db.query(`SELECT COUNT(*) FROM objects${where}`, parameters).rows[0][0]) : size;
      const pages = Math.max(1, Math.ceil(total / pageSize)); page = Math.max(1, Math.min(page, pages));
      const indices = db.query(`SELECT rowid FROM objects${where} ORDER BY rowid LIMIT ? OFFSET ?`, [...parameters, pageSize, (page-1)*pageSize]).rows.map(row => Number(row[0])-1);
      return { total, page, pages, indices };
    },
    clear() { db?.destroy(); db = undefined; size = 0; },
  };
}
