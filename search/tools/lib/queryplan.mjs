/**
 * Query planner — the STRUCTURED half of hybrid retrieval.
 *
 * The owner's rule: "'launched in 2023' is a range predicate the FlatSQL layer
 * executes; the model's job is mapping the query to it." So this module turns a
 * natural-language query into
 *
 *     { predicates: [...], semantic: "<residual text to embed>", spans: [...] }
 *
 * and the embedding never has to learn arithmetic. Predicates go to FlatSQL as
 * a WHERE clause (the orbpro-wasm-flatsql law: filtering happens IN the query
 * engine, never as a JS predicate pass over results); the residual text goes to
 * the encoder for ranking.
 *
 * THE LEXICON IS GENERATED, NOT TYPED. `buildLexicon()` reads the owner table
 * and the corpus's own distinct values for regime / launch site / vehicle /
 * constellation / band / manufacturer. A new metadata field therefore becomes
 * queryable as soon as its adapter lands — no second table to maintain, and no
 * drift between what the corpus contains and what the planner can ask for.
 *
 * Deliberately a deterministic lexicon+pattern matcher, not a learned parser:
 * it has to run identically in the browser module and in Node, it must be
 * explainable to a user ("filtered on launchYear = 2023"), and it must never
 * hallucinate a filter that silently empties a result set.
 */

/** Terms that carry no retrieval signal once the structure has been pulled out. */
const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "from", "by", "with",
  "and", "or", "that", "which", "is", "are", "was", "were", "be", "been",
  "show", "me", "find", "list", "all", "any", "some", "please", "give",
  "satellite", "satellites", "spacecraft", "object", "objects",
]);

/** Build the matcher lexicon from live data. */
export function buildLexicon({ ownerTable, corpus }) {
  const distinct = (key) => {
    const s = new Set();
    for (const row of corpus) {
      const v = row.fields[key];
      if (Array.isArray(v)) v.forEach((x) => s.add(x));
      else if (v) s.add(v);
    }
    return [...s];
  };

  /** owner: every demonym and formal name -> its LCC code. */
  const owner = [];
  for (const [code, entry] of Object.entries(ownerTable)) {
    const terms = new Set([entry.name, ...entry.demonyms]);
    for (const t of terms) {
      const term = t.toLowerCase().trim();
      // One- and two-letter codes ("US", "IT", "CA") are far too collision-prone
      // to match as free text — "it" and "ca" appear in ordinary queries.
      if (term.length < 4) continue;
      // `nations`, not `owner`: an ordinary satellite has nations=[owner], but
      // the ISS has every partner nation, which is what makes the owner's
      // litmus query "japanese space station" reach it at all.
      owner.push({ term, field: "nations", op: "has", value: code });
    }
  }

  const enumField = (key, field = key) =>
    distinct(key).map((v) => ({ term: String(v).toLowerCase(), field, op: "eq", value: v }));

  return {
    owner,
    regime: enumField("regime"),
    vehicle: distinct("launchVehicle").map((v) => ({
      term: v.toLowerCase(),
      field: "launchVehicle",
      op: "eq",
      value: v,
    })),
    band: distinct("bands").map((v) => ({
      term: v.toLowerCase(),
      field: "bands",
      op: "has",
      value: v,
    })),
    manufacturer: [...new Set(distinct("manufacturer"))].map((v) => ({
      term: v.toLowerCase(),
      field: "manufacturer",
      op: "eq",
      value: v,
    })),
    mission: enumField("mission"),
    sizeClass: enumField("sizeClass"),
    // Constellation values are long labels ("Starlink broadband internet
    // constellation"); users type only the brand word, so index the FIRST
    // token as well as the whole label.
    constellation: distinct("constellation").flatMap((v) => {
      const head = String(v).split(/\s+/)[0].toLowerCase();
      const out = [{ term: String(v).toLowerCase(), field: "constellation", op: "eq", value: v }];
      if (head.length >= 4) out.push({ term: head, field: "constellation", op: "eq", value: v });
      return out;
    }),
    // Aliases that are common phrasing rather than catalogue values.
    aliases: [
      { term: "geo", field: "regime", op: "eq", value: "geostationary orbit" },
      { term: "geostationary", field: "regime", op: "eq", value: "geostationary orbit" },
      { term: "geosynchronous", field: "regime", op: "eq", value: "geosynchronous orbit" },
      { term: "leo", field: "regime", op: "contains", value: "low Earth orbit" },
      { term: "low earth orbit", field: "regime", op: "contains", value: "low Earth orbit" },
      { term: "meo", field: "regime", op: "eq", value: "medium Earth orbit" },
      { term: "medium earth orbit", field: "regime", op: "eq", value: "medium Earth orbit" },
      { term: "sun synchronous", field: "regime", op: "eq", value: "sun-synchronous low Earth orbit" },
      { term: "sun-synchronous", field: "regime", op: "eq", value: "sun-synchronous low Earth orbit" },
      { term: "polar", field: "regime", op: "contains", value: "polar" },
      { term: "molniya", field: "regime", op: "contains", value: "Molniya" },
      { term: "debris", field: "objectClass", op: "contains", value: "Debris" },
      { term: "junk", field: "objectClass", op: "contains", value: "Debris" },
      { term: "fragment", field: "objectClass", op: "contains", value: "Debris" },
      { term: "rocket body", field: "objectClass", op: "eq", value: "Rocket Body" },
      { term: "rocket bodies", field: "objectClass", op: "eq", value: "Rocket Body" },
      { term: "upper stage", field: "objectClass", op: "eq", value: "Rocket Body" },
      { term: "booster stage", field: "objectClass", op: "eq", value: "Rocket Body" },
      { term: "payload", field: "objectClass", op: "eq", value: "Payload" },
      // "satellites" is NOT a stopword. When a user says "satellites" they mean
      // working spacecraft, not the spent stages and debris that outnumber them
      // 2:1 in the catalogue. Dropping it as noise was measurably wrong: on
      // "launched on a falcon 9" the planner returned all 4,841 Falcon 9
      // objects and ranked debris above payloads, scoring nDCG 0 on a query it
      // had filtered perfectly.
      { term: "satellite", field: "objectClass", op: "eq", value: "Payload" },
      { term: "satellites", field: "objectClass", op: "eq", value: "Payload" },
      { term: "spacecraft", field: "objectClass", op: "eq", value: "Payload" },
      { term: "payloads", field: "objectClass", op: "eq", value: "Payload" },
      { term: "active", field: "opStatus", op: "eq", value: "+" },
      { term: "operational", field: "opStatus", op: "eq", value: "+" },
      { term: "still work", field: "opStatus", op: "eq", value: "+" },
      { term: "functioning", field: "opStatus", op: "eq", value: "+" },
      { term: "dead", field: "opStatus", op: "eq", value: "-" },
      { term: "defunct", field: "opStatus", op: "eq", value: "-" },
      { term: "nonoperational", field: "opStatus", op: "eq", value: "-" },
      { term: "cubesat", field: "cubesatUnits", op: "exists", value: true },
      { term: "cubesats", field: "cubesatUnits", op: "exists", value: true },
      { term: "smallsat", field: "sizeClass", op: "in", value: ["small satellite", "microsatellite", "nanosatellite"] },
      { term: "smallsats", field: "sizeClass", op: "in", value: ["small satellite", "microsatellite", "nanosatellite"] },
      { term: "small satellite", field: "sizeClass", op: "in", value: ["small satellite", "microsatellite", "nanosatellite"] },
      { term: "nanosatellite", field: "sizeClass", op: "eq", value: "nanosatellite" },
      { term: "microsatellite", field: "sizeClass", op: "eq", value: "microsatellite" },
      { term: "large satellite", field: "sizeClass", op: "eq", value: "large satellite" },
      { term: "gnss", field: "mission", op: "eq", value: "navigation" },
      { term: "remote sensing", field: "mission", op: "eq", value: "Earth observation and imaging" },
      { term: "weather", field: "mission", op: "eq", value: "weather and meteorology" },
      { term: "meteorological", field: "mission", op: "eq", value: "weather and meteorology" },
      { term: "telescope", field: "mission", op: "eq", value: "space telescope and astronomy" },
      { term: "observatory", field: "mission", op: "eq", value: "space telescope and astronomy" },
    ],
    launchSite: buildSiteTerms(corpus),
    aliasIndex: buildAliasIndex(corpus),
  };
}

/**
 * Exact object-name / alias -> NORAD index.
 *
 * The identity path. Without it, "international space station" ranked ISS
 * (ZARYA) THIRD: every ISS-owned module carries "International Space Station"
 * in its owner sentence, and 25544's document is the longest of them, so pure
 * cosine similarity diluted the one object the user actually meant.
 *
 * An exact alias hit is not a similarity judgement, it is a lookup — the same
 * class of operation as `owner = 'JPN'`, and in production it is a FlatSQL
 * equality query against the alias column, not a JS scan.
 */
function buildAliasIndex(corpus) {
  const idx = new Map();
  const put = (alias, norad) => {
    const k = String(alias).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (k.length < 3) return;
    const list = idx.get(k);
    if (list) {
      if (!list.includes(norad)) list.push(norad);
    } else idx.set(k, [norad]);
  };
  for (const row of corpus) {
    const f = row.fields;
    put(f.name, f.norad);
    // The bare name without its parenthetical, so "ISS (ZARYA)" is reachable
    // as "iss" and as "zarya" but ALSO as the full string.
    put(String(f.name ?? "").replace(/\s*\([^)]*\)\s*/g, " "), f.norad);
    for (const alt of f.altNames ?? []) put(alt, f.norad);
  }
  return idx;
}

/** Launch sites: match on the place words, not the five-letter code. */
function buildSiteTerms(corpus) {
  const SITE_WORDS = {
    TYMSC: ["baikonur", "kazakhstan"],
    BILAK: ["baikonur"],
    AFETR: ["cape canaveral", "florida"],
    AFWTR: ["vandenberg"],
    FRGUI: ["kourou", "french guiana"],
    PLMSC: ["plesetsk"],
    TANSC: ["tanegashima"],
    KSCUT: ["uchinoura"],
    JSC: ["jiuquan"],
    TSC: ["taiyuan"],
    XSC: ["xichang"],
    WSC: ["wenchang"],
    SRILR: ["sriharikota", "satish dhawan"],
    WLPIS: ["wallops"],
    RLLB: ["mahia", "new zealand"],
    KODAK: ["kodiak"],
    VOSTO: ["vostochny"],
    KWAJ: ["kwajalein"],
    YAVNE: ["palmachim"],
  };
  const present = new Set(corpus.map((r) => r.fields.launchSite).filter(Boolean));
  const out = [];
  for (const [code, words] of Object.entries(SITE_WORDS)) {
    if (!present.has(code)) continue;
    for (const w of words) out.push({ term: w, field: "launchSite", op: "eq", value: code });
  }
  return out;
}

/** Year / date predicates. Handled by pattern, because they are ranges. */
function extractDates(text) {
  const found = [];
  const consume = [];
  const push = (pred, match) => {
    found.push(pred);
    consume.push(match);
  };

  let m;
  const decade = /\b(?:the\s+)?(\d{4})s\b/g;
  while ((m = decade.exec(text))) {
    const lo = Number(m[1]);
    push({ field: "launchYear", op: "between", value: [lo, lo + 9] }, m[0]);
  }
  const before = /\b(?:before|prior to|earlier than)\s+(\d{4})\b/g;
  while ((m = before.exec(text))) push({ field: "launchYear", op: "lt", value: Number(m[1]) }, m[0]);
  const after = /\b(?:after|since|later than|newer than)\s+(\d{4})\b/g;
  while ((m = after.exec(text))) push({ field: "launchYear", op: "gt", value: Number(m[1]) }, m[0]);
  const between = /\bbetween\s+(\d{4})\s+and\s+(\d{4})\b/g;
  while ((m = between.exec(text))) {
    push({ field: "launchYear", op: "between", value: [Number(m[1]), Number(m[2])] }, m[0]);
  }
  // A bare year, only when it is not already inside a range phrase above.
  const bare = /\b(19\d{2}|20\d{2})\b/g;
  while ((m = bare.exec(text))) {
    if (consume.some((c) => c.includes(m[1]))) continue;
    push({ field: "launchYear", op: "eq", value: Number(m[1]) }, m[0]);
  }
  if (/\b(recent|recently|newest|latest|new)\b/.test(text) && !found.length) {
    const cutoff = new Date().getUTCFullYear() - 2;
    push({ field: "launchYear", op: "gte", value: cutoff }, "");
  }
  if (/\boldest\b/.test(text)) push({ field: "launchYear", op: "sortAsc", value: true }, "oldest");
  return { predicates: found, consumed: consume };
}

/** Mass / size numeric predicates ("over 1000 kg", "cubesats over 6U", "under 10 kg"). */
function extractMagnitudes(text, context = text) {
  const found = [];
  const consumed = [];
  let m;
  const mass = /\b(over|above|more than|under|below|less than)\s+(\d+(?:\.\d+)?)\s*(kg|kilograms?|tonnes?|t)\b/g;
  while ((m = mass.exec(text))) {
    const gt = /over|above|more than/.test(m[1]);
    let v = Number(m[2]);
    if (/tonne|^t$/.test(m[3])) v *= 1000;
    found.push({ field: "mass", op: gt ? "gt" : "lt", value: v });
    consumed.push(m[0]);
  }
  const units = /\b(over|above|more than|under|below|less than)?\s*(\d+)\s*u\b/gi;
  while ((m = units.exec(text))) {
    if (!/cubesat/i.test(context)) continue;
    const op = m[1] ? (/over|above|more than/.test(m[1]) ? "gt" : "lt") : "eq";
    found.push({ field: "cubesatUnits", op, value: Number(m[2]) });
    consumed.push(m[0]);
  }
  return { predicates: found, consumed };
}

/**
 * Plan a query.
 * @returns {{predicates: Array, semantic: string, matched: Array}}
 */
export function planQuery(raw, lexicon) {
  const text = ` ${String(raw).toLowerCase().replace(/[^\p{L}\p{N}\s.-]/gu, " ").replace(/\s+/g, " ").trim()} `;
  const predicates = [];
  const matched = [];
  let residual = text;

  // IDENTITY FIRST. If the whole query is an object's name or alias, this is a
  // lookup, not a search — answer it exactly and skip the rest of the planner,
  // which would otherwise turn "hubble space telescope" into a mission filter
  // that excludes Hubble itself. Bounded to a small hit list so a generic alias
  // shared by hundreds of objects still goes down the semantic path.
  const whole = text.trim().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const aliasHit = lexicon.aliasIndex?.get(whole);
  if (aliasHit && aliasHit.length <= 20) {
    return {
      predicates: [{ field: "norad", op: "in", value: aliasHit }],
      semantic: String(raw).trim(),
      matched: [`alias:${whole}`],
    };
  }

  const eat = (term) => {
    const needle = ` ${term} `;
    const idx = residual.indexOf(needle);
    if (idx < 0) {
      // also allow the term at a word boundary followed by punctuation/suffix
      const re = new RegExp(`(?<=\\s)${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=s?\\s)`);
      if (!re.test(residual)) return false;
      residual = residual.replace(re, " ");
      return true;
    }
    residual = `${residual.slice(0, idx + 1)}${residual.slice(idx + needle.length - 1)}`;
    return true;
  };

  // Country names and launch-site names collide: "new zealand" is both an
  // owner (NZ) and Rocket Lab's Mahia site. "launched from X" names the PLACE,
  // so when that frame is present the site lexicon must win the span — without
  // this, "launched from new zealand" planned `owner = NZ` and returned a
  // single object.
  const sitePhrasing = /\blaunch(ed|es)?\s+(from|at)\b|\bfrom\s+the\s+\w+\s+(site|centre|center|cosmodrome)\b/.test(text);

  // Longest term first so "sun synchronous" beats "polar", and
  // "medium earth orbit" beats "earth".
  const ordered = sitePhrasing
    ? [lexicon.launchSite, lexicon.aliases, lexicon.owner]
    : [lexicon.aliases, lexicon.owner, lexicon.launchSite];
  const entries = [
    ...ordered.flat(),
    ...lexicon.regime,
    ...lexicon.mission,
    ...lexicon.constellation,
    ...lexicon.sizeClass,
    ...lexicon.band,
    ...lexicon.manufacturer,
    ...lexicon.vehicle,
  ];
  // Stable sort by term length, so the group priority above survives ties.
  entries.forEach((e, i) => {
    e.__ord = i;
  });
  entries.sort((a, b) => b.term.length - a.term.length || a.__ord - b.__ord);

  const seen = new Set();
  for (const e of entries) {
    if (e.term.length < 3) continue;
    const key = `${e.field}:${JSON.stringify(e.value)}`;
    if (seen.has(key)) continue;
    if (eat(e.term)) {
      predicates.push({ field: e.field, op: e.op, value: e.value });
      matched.push(e.term);
      seen.add(key);
    }
  }

  const dates = extractDates(residual);
  for (const p of dates.predicates) predicates.push(p);
  for (const c of dates.consumed) if (c) residual = residual.replace(c, " ");

  const mags = extractMagnitudes(residual, text);
  for (const p of mags.predicates) predicates.push(p);
  for (const c of mags.consumed) residual = residual.replace(c, " ");

  const semantic = residual
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(" ")
    .trim();

  // RANKING PRIOR, not a filter. "launched on a falcon 9" legitimately matches
  // all 4,841 Falcon 9 objects, but two thirds of those are spent stages and
  // debris and no user means those first. When the query names no object type
  // at all, prefer payloads in the ORDERING while still returning the rest —
  // a filter here would be wrong (the debris really did launch on a Falcon 9),
  // an ordering preference is right.
  const namesAType = predicates.some((p) => p.field === "objectClass");
  const prefer = namesAType ? null : { field: "objectClass", value: "Payload", weight: 0.15 };

  return { predicates, semantic: semantic || String(raw).trim(), matched, prefer };
}

/** Evaluate one predicate against a record's fields (the FlatSQL semantics, in JS, for testing). */
export function matchesPredicate(fields, p) {
  const v = fields[p.field];
  switch (p.op) {
    case "eq":
      return Array.isArray(v) ? v.includes(p.value) : v === p.value;
    case "has":
      return Array.isArray(v) && v.includes(p.value);
    case "in":
      return p.value.includes(v);
    case "contains":
      return typeof v === "string" && v.toLowerCase().includes(String(p.value).toLowerCase());
    case "exists":
      return v !== undefined && v !== null;
    case "gt":
      return Number.isFinite(v) && v > p.value;
    case "gte":
      return Number.isFinite(v) && v >= p.value;
    case "lt":
      return Number.isFinite(v) && v < p.value;
    case "lte":
      return Number.isFinite(v) && v <= p.value;
    case "between":
      return Number.isFinite(v) && v >= p.value[0] && v <= p.value[1];
    case "sortAsc":
      return true; // ordering hint, not a filter
    default:
      return true;
  }
}

/**
 * Record accessors — the seam that keeps ONE planner for every backend.
 *
 * `applyPlan` only ever needs "how many rows, and what is field F of row I".
 * Node evaluates that over corpus.jsonl, the browser harness over the
 * dictionary-encoded facet columns, and production over FlatSQL. Duplicating
 * the matcher per backend is how the three drift apart, so they share it.
 */
export function corpusAccessor(corpus) {
  return { count: corpus.length, get: (i, field) => corpus[i].fields[field] };
}

/** Accessor over the exported dictionary-encoded facet columns. */
export function facetsAccessor(facets) {
  const { dicts, cols, nationDict, bandDict } = facets;
  return {
    count: facets.count,
    get(i, field) {
      switch (field) {
        case "nations":
          return facets.nations[i].map((n) => nationDict[n]);
        case "bands":
          return facets.bands[i].map((b) => bandDict[b]);
        case "launchYear":
          return facets.launchYear[i] < 0 ? undefined : facets.launchYear[i];
        case "mass":
          return facets.mass[i] < 0 ? undefined : facets.mass[i];
        case "cubesatUnits":
          return facets.cubesatUnits[i] < 0 ? undefined : facets.cubesatUnits[i];
        case "stationProgramme":
          return facets.stationProgramme[i] ? "yes" : undefined;
        case "norad":
          return facets.norads[i];
        default: {
          const col = cols[field];
          if (!col) return undefined;
          const code = col[i];
          return code < 0 ? undefined : dicts[field][code];
        }
      }
    },
  };
}

/**
 * Apply a plan as a filter, returning the candidate row indices (or null when
 * the query carries no structure at all and the whole catalog is the pool).
 */
export function applyPlan(plan, source) {
  const filters = plan.predicates.filter((p) => p.op !== "sortAsc");
  if (!filters.length) return null;
  const acc = Array.isArray(source)
    ? corpusAccessor(source)
    : source.get
      ? source
      : facetsAccessor(source);
  const idx = [];
  for (let i = 0; i < acc.count; i += 1) {
    let ok = true;
    for (const p of filters) {
      if (!matchesPredicate({ [p.field]: acc.get(i, p.field) }, p)) {
        ok = false;
        break;
      }
    }
    if (ok) idx.push(i);
  }
  return idx;
}
