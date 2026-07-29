/**
 * Domain training phrases — the "DOMAIN PAIRS generated from our own catalog +
 * GCAT metadata" the brief calls for.
 *
 * These are the short, query-shaped texts the student encoder is trained to
 * place where the teacher would put them. Catalog documents alone are not
 * enough: they are long third-person prose, and a user types four words. A
 * static encoder trained only on documents ends up good at documents and bad
 * at queries, which is precisely the failure mode this file prevents.
 *
 * ⚠ HELD OUT FROM EVALUATION. `buildTrainingPhrases` takes the eval queries and
 * removes any exact match, and the templates here are deliberately different
 * from the eval templates. Training on the acceptance set would turn the
 * measured recall into a memorisation score.
 */

const TEMPLATES = [
  (t) => `${t}`,
  (t) => `${t} in orbit`,
  (t) => `find ${t}`,
  (t) => `show me ${t}`,
  (t) => `list of ${t}`,
  (t) => `which objects are ${t}`,
  (t) => `${t} currently tracked`,
  (t) => `catalogue of ${t}`,
];

/**
 * Build training phrases from the corpus's own field values.
 * @param {Array} corpus rows ({norad, doc, fields})
 * @param {object} ownerTable
 * @param {Set<string>} exclude lowercase eval queries to hold out
 */
export function buildTrainingPhrases(corpus, ownerTable, exclude = new Set()) {
  const phrases = new Set();
  const add = (s) => {
    const t = String(s).toLowerCase().replace(/\s+/g, " ").trim();
    if (t && !exclude.has(t)) phrases.add(t);
  };

  // --- country / demonym: the headline generalisation we need.
  const owners = new Set(corpus.map((r) => r.fields.owner));
  for (const code of owners) {
    const owner = ownerTable[code];
    if (!owner) continue;
    for (const term of [owner.name, ...owner.demonyms]) {
      const t = term.toLowerCase();
      add(`${t} spacecraft`);
      add(`objects owned by ${t}`);
      add(`${t} space programme`);
      add(`operated by ${t}`);
      for (const tpl of TEMPLATES.slice(0, 4)) add(tpl(`${t} satellites`));
    }
  }

  // --- constellation, mission, regime, size, band, vehicle, site: every
  //     distinct value the catalogue actually holds, in query clothing.
  const distinct = (key) => {
    const s = new Set();
    for (const r of corpus) {
      const v = r.fields[key];
      if (Array.isArray(v)) v.forEach((x) => s.add(x));
      else if (v) s.add(v);
    }
    return [...s];
  };

  for (const v of distinct("constellation")) {
    const head = String(v).split(/\s+/)[0];
    add(v);
    for (const tpl of TEMPLATES) add(tpl(`${head} satellites`));
  }
  for (const v of distinct("mission")) {
    for (const tpl of TEMPLATES) add(tpl(`${v} satellites`));
    add(`spacecraft for ${v}`);
  }
  for (const v of distinct("regime")) {
    for (const tpl of TEMPLATES.slice(0, 5)) add(tpl(`satellites in ${v}`));
    add(`${v} objects`);
  }
  for (const v of distinct("sizeClass")) {
    for (const tpl of TEMPLATES.slice(0, 5)) add(tpl(`${v}s`));
  }
  for (const v of distinct("bands")) {
    add(`${v} satellites`);
    add(`spacecraft transmitting on ${v}`);
    add(`${v} downlink`);
  }
  for (const v of distinct("launchVehicle").slice(0, 400)) {
    add(`payloads launched on ${v}`);
    add(`${v} launches`);
  }
  for (const v of distinct("manufacturer")) {
    add(`spacecraft built by ${v}`);
    add(`${v} satellites`);
    add(`${v} manufactured spacecraft`);
  }
  for (const v of distinct("objectClass")) {
    for (const tpl of TEMPLATES.slice(0, 5)) add(tpl(`${v.toLowerCase()}`));
  }

  // --- object names: the identity path. Names plus their alt names, so
  //     "zarya" and "international space station" both land near NORAD 25544.
  for (const r of corpus) {
    const f = r.fields;
    if (f.objectClass !== "Payload") continue;
    add(f.name);
    for (const alt of f.altNames ?? []) add(alt);
  }

  // --- launch years, so the encoder at least does not fight the planner.
  for (let y = 1957; y <= new Date().getUTCFullYear(); y += 1) {
    add(`satellites launched in ${y}`);
  }

  return [...phrases];
}
