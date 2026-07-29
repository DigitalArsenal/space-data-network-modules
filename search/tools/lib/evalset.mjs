/**
 * The acceptance suite: a few hundred natural-language queries, each with a
 * GRADED relevance judge computed from the object's real structured metadata.
 *
 * Why judges instead of hand-listed answer keys: the catalog has 33,814 live
 * objects and changes every day. A frozen list of NORAD ids would be stale by
 * the next ingest and would silently overstate recall. A judge is a predicate
 * over FIELD_SCHEMA fields, so the qrels are RECOMPUTED from whatever catalog
 * is in front of it — the suite ages with the data instead of against it.
 *
 * Grades (standard 4-point graded relevance, feeds nDCG):
 *   3 — exactly what the user asked for
 *   2 — clearly relevant, misses one soft qualifier (e.g. decayed, not active)
 *   1 — same family but not the intent (e.g. the debris from a named mission)
 *   0 — irrelevant
 *
 * Each entry also declares the STRUCTURED PREDICATE a perfect query planner
 * would emit. That is scored separately (see eval.mjs `planner` section): the
 * embedding is responsible for semantics, the planner for the parts of the
 * query that are really range/equality filters the FlatSQL layer must execute.
 */

const payload = (f) => f.objectClass === "Payload";
const live = (f) => f.onOrbit && f.opStatus === "+";

/** Grade helper: 3 if strict, 2 if core, 1 if loose, else 0. */
const graded = (strict, core, loose) => (f) => {
  if (strict(f)) return 3;
  if (core(f)) return 2;
  if (loose && loose(f)) return 1;
  return 0;
};

/**
 * Country / demonym family — the owner's headline case.
 *
 * Generated FROM THE CORPUS rather than hand-listed. A hand-list silently
 * produced empty judgement sets for five codes that simply are not CelesTrak's
 * spelling (RSA vs SAFR) or are absent from the on-orbit catalogue entirely.
 * Deriving from owner codes actually present, with a payload-count floor,
 * makes an empty qrel structurally impossible and scales the family with the
 * data.
 */
function countryQueries(corpus, ownerTable, minPayloads = 4) {
  const counts = new Map();
  for (const row of corpus) {
    const f = row.fields;
    if (f.objectClass !== "Payload") continue;
    counts.set(f.owner, (counts.get(f.owner) ?? 0) + 1);
  }
  const out = [];
  for (const [code, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (n < minPayloads) continue;
    const owner = ownerTable[code];
    if (!owner) continue;
    // The demonym is the interesting probe ("japanese"); fall back to the
    // formal name when SDS/our table has no demonym for the code.
    const term = owner.demonyms[0] ?? owner.name;
    out.push([`${term.toLowerCase()} satellites`, code]);
    // A second phrasing for the biggest operators, to prove the model is not
    // keying on one exact surface form.
    if (n >= 100 && owner.demonyms.length > 1) {
      out.push([`satellites from ${owner.demonyms[1].toLowerCase()}`, code]);
    }
  }
  return out;
}

/** Launch-vehicle family — joins through GCAT, a pure structured predicate. */
const VEHICLES = [
  ["launched on a falcon 9", /^Falcon 9/],
  ["falcon 9 payloads", /^Falcon 9/],
  ["launched on a long march rocket", /^Chang Zheng/],
  ["chinese long march launches", /^Chang Zheng/],
  ["launched on a soyuz", /^Soyuz/],
  ["soyuz launched satellites", /^Soyuz/],
  ["launched on a proton", /^Proton/],
  ["launched on an atlas v", /^Atlas V/],
  ["atlas launched satellites", /^Atlas/],
  ["launched on a delta rocket", /^Delta/],
  ["launched on an ariane", /^Ariane/],
  ["ariane 5 payloads", /^Ariane 5/],
  ["launched on an electron rocket", /^Electron/],
  ["launched by the space shuttle", /^Space Shuttle/],
  ["launched on a PSLV", /^PSLV/],
  ["launched on an H-IIA", /^H-2A|^H-IIA/],
  ["launched on a vega", /^Vega/],
  ["launched on a zenit", /^Zenit/],
  ["launched on a titan", /^Titan/],
  ["launched on a tsiklon", /^Tsiklon/],
  ["launched on a kosmos rocket", /^Kosmos \d/],
  ["launched on a rokot", /^Rokot/],
  ["launched on a minotaur", /^Minotaur/],
  ["launched on a pegasus", /^Pegasus/],
];

/** Named single objects — top-1 must be exact. */
const NAMED = [
  ["international space station", 25544, (f) => f.owner === "ISS"],
  ["the space station", 25544, (f) => f.owner === "ISS"],
  ["ISS", 25544, (f) => f.owner === "ISS"],
  ["space station zarya module", 25544, (f) => f.owner === "ISS"],
  ["hubble space telescope", 20580, null],
  ["hubble", 20580, null],
];

const CONSTELLATIONS = [
  ["starlink satellites", /^STARLINK/],
  ["spacex internet constellation", /^STARLINK/],
  ["oneweb satellites", /^ONEWEB/],
  ["iridium satellites", /^IRIDIUM/],
  ["globalstar", /^GLOBALSTAR/],
  ["orbcomm satellites", /^ORBCOMM/],
  ["gps constellation", /^NAVSTAR|^GPS /],
  ["navstar gps satellites", /^NAVSTAR|^GPS /],
  ["glonass satellites", /GLONASS/],
  ["beidou satellites", /^BEIDOU/],
  ["galileo navigation satellites", /GALILEO/],
  ["planet labs imaging satellites", /^FLOCK|^DOVE|^SUPERDOVE|^SKYSAT/],
  ["spire lemur satellites", /^LEMUR/],
  ["iceye radar satellites", /^ICEYE/],
  ["yaogan satellites", /^YAOGAN/],
  ["gaofen satellites", /^GAOFEN/],
  ["intelsat satellites", /^INTELSAT/],
  ["eutelsat satellites", /^EUTELSAT/],
  ["inmarsat satellites", /^INMARSAT/],
  ["o3b satellites", /^O3B/],
  ["kosmos satellites", /^COSMOS|^KOSMOS/],
  ["gonets satellites", /^GONETS/],
  ["quasi zenith michibiki satellites", /^QZS|^MICHIBIKI/],
  ["tiangong chinese space station", /^TIANGONG|^SHENZHOU|^TIANZHOU/],
];

const MISSIONS = [
  ["weather satellites", "weather and meteorology"],
  ["meteorological satellites", "weather and meteorology"],
  ["navigation satellites", "navigation"],
  ["earth observation satellites", "Earth observation and imaging"],
  ["imaging satellites", "Earth observation and imaging"],
  ["space telescopes", "space telescope and astronomy"],
  ["astronomy observatories in orbit", "space telescope and astronomy"],
  ["communications satellites", "communications"],
  ["comms satellites", "communications"],
  ["military satellites", "military"],
  ["human spaceflight vehicles", "human spaceflight"],
  ["synthetic aperture radar satellites", "synthetic aperture radar imaging"],
];

const OBJECT_TYPES = [
  ["debris", (f) => /Debris/.test(f.objectClass ?? ""), (f) => /Debris|Unknown/.test(f.objectClass ?? "")],
  ["orbital debris fragments", (f) => /Debris/.test(f.objectClass ?? ""), (f) => /Debris|Unknown/.test(f.objectClass ?? "")],
  ["rocket bodies", (f) => f.objectClass === "Rocket Body", (f) => /Rocket/.test(f.objectClass ?? "")],
  ["spent upper stages", (f) => f.objectClass === "Rocket Body", (f) => /Rocket/.test(f.objectClass ?? "")],
  ["active payloads", (f) => payload(f) && live(f), payload],
  ["operational satellites", (f) => payload(f) && live(f), payload],
  ["dead satellites", (f) => payload(f) && f.opStatus === "-", (f) => f.opStatus === "-"],
];

const ORBITS = [
  ["geostationary satellites", "geostationary orbit"],
  ["satellites in GEO", "geostationary orbit"],
  ["geosynchronous satellites", "geosynchronous orbit"],
  ["sun synchronous satellites", "sun-synchronous low Earth orbit"],
  ["polar orbiting satellites", "polar low Earth orbit"],
  ["low earth orbit satellites", "low Earth orbit"],
  ["satellites in LEO", "low Earth orbit"],
  ["medium earth orbit satellites", "medium Earth orbit"],
  ["MEO satellites", "medium Earth orbit"],
  ["molniya orbit satellites", "highly elliptical Molniya orbit"],
  ["highly elliptical orbit satellites", "highly elliptical orbit"],
];

const SIZES = [
  ["smallsats", (f) => ["small satellite", "microsatellite", "nanosatellite"].includes(f.sizeClass)],
  ["small satellites", (f) => ["small satellite", "microsatellite", "nanosatellite"].includes(f.sizeClass)],
  ["cubesats", (f) => Number.isFinite(f.cubesatUnits)],
  ["cubesats over 6U", (f) => Number.isFinite(f.cubesatUnits) && f.cubesatUnits > 6],
  ["3U cubesats", (f) => f.cubesatUnits === 3],
  ["nanosatellites", (f) => f.sizeClass === "nanosatellite"],
  ["microsatellites", (f) => f.sizeClass === "microsatellite"],
  ["large satellites", (f) => f.sizeClass === "large satellite"],
  ["heavy satellites over 1000 kg", (f) => Number.isFinite(f.mass) && f.mass > 1000],
  ["satellites under 10 kg", (f) => Number.isFinite(f.mass) && f.mass < 10],
];

const BANDS = [
  ["UHF transmitters", "UHF"],
  ["satellites with UHF downlink", "UHF"],
  ["X-band downlink", "X-band"],
  ["S-band satellites", "S-band"],
  ["L-band satellites", "L-band"],
  ["Ku-band satellites", "Ku-band"],
  ["C-band satellites", "C-band"],
  ["VHF satellites", "VHF"],
];

const SITES = [
  ["launched from baikonur", "TYMSC"],
  ["launched from cape canaveral", "AFETR"],
  ["launched from vandenberg", "AFWTR"],
  ["launched from kourou french guiana", "FRGUI"],
  ["launched from plesetsk", "PLMSC"],
  ["launched from tanegashima japan", "TANSC"],
  ["launched from jiuquan china", "JSC"],
  ["launched from sriharikota india", "SRILR"],
  ["launched from wallops island", "WLPIS"],
  ["launched from new zealand", "RLLB"],
];

const MANUFACTURERS = [
  ["airbus satellites", "Airbus"],
  ["airbus built spacecraft", "Airbus"],
  ["boeing built", "Boeing"],
  ["boeing satellites", "Boeing"],
  ["lockheed martin satellites", "Lockheed Martin"],
  ["thales alenia space satellites", "Thales Alenia"],
  ["maxar satellites", "Maxar"],
  ["spacex built satellites", "SpaceX"],
  ["planet labs built", "Planet Labs"],
  ["ohb system satellites", "OHB"],
];

/**
 * Build the full suite.
 * @param {Array} corpus rows from corpus.jsonl ({norad, doc, fields})
 * @param {object} ownerTable from lcc.mjs buildOwnerTable()
 */
export function buildEvalSet(corpus, ownerTable) {
  const q = [];
  const add = (family, query, judge, predicate) =>
    q.push({ id: `${family}-${q.length}`, family, query, judge, predicate });

  for (const [query, code] of countryQueries(corpus, ownerTable)) {
    add(
      "country",
      query,
      graded(
        (f) => f.owner === code && payload(f) && f.onOrbit,
        (f) => f.owner === code && payload(f),
        (f) => f.owner === code,
      ),
      { nations: { has: code } },
    );
  }

  for (const [query, norad, near] of NAMED) {
    add(
      "named",
      query,
      (f) => (f.norad === norad ? 3 : near && near(f) ? 2 : 0),
      { norad: { eq: norad } },
    );
  }

  for (const [query, pattern] of CONSTELLATIONS) {
    add(
      "constellation",
      query,
      graded(
        (f) => pattern.test(f.name) && payload(f) && f.onOrbit,
        (f) => pattern.test(f.name) && payload(f),
        (f) => pattern.test(f.name),
      ),
      { nameMatches: pattern.source },
    );
  }

  for (const [query, mission] of MISSIONS) {
    add(
      "mission",
      query,
      graded(
        (f) => f.mission === mission && payload(f) && f.onOrbit,
        (f) => f.mission === mission && payload(f),
        (f) => f.mission === mission,
      ),
      { mission: { eq: mission } },
    );
  }

  for (const [query, strict, loose] of OBJECT_TYPES) {
    add("type", query, graded(strict, strict, loose), { objectClassRule: query });
  }

  for (const [query, regime] of ORBITS) {
    add(
      "orbit",
      query,
      graded(
        (f) => f.regime === regime && payload(f) && f.onOrbit,
        (f) => f.regime === regime && payload(f),
        (f) => f.regime === regime,
      ),
      { regime: { eq: regime } },
    );
  }

  for (const [query, test] of SIZES) {
    add(
      "size",
      query,
      graded(
        (f) => test(f) && payload(f) && f.onOrbit,
        (f) => test(f) && payload(f),
        (f) => test(f),
      ),
      { sizeRule: query },
    );
  }

  for (const [query, band] of BANDS) {
    add(
      "band",
      query,
      graded(
        (f) => (f.bands ?? []).includes(band) && f.onOrbit,
        (f) => (f.bands ?? []).includes(band),
        null,
      ),
      { bands: { has: band } },
    );
  }

  for (const [query, site] of SITES) {
    add(
      "site",
      query,
      graded(
        (f) => f.launchSite === site && payload(f) && f.onOrbit,
        (f) => f.launchSite === site && payload(f),
        (f) => f.launchSite === site,
      ),
      { launchSite: { eq: site } },
    );
  }

  for (const [query, pattern] of VEHICLES) {
    add(
      "vehicle",
      query,
      graded(
        (f) => pattern.test(f.launchVehicle ?? "") && payload(f) && f.onOrbit,
        (f) => pattern.test(f.launchVehicle ?? "") && payload(f),
        (f) => pattern.test(f.launchVehicle ?? ""),
      ),
      { launchVehicle: { matches: pattern.source } },
    );
  }

  for (const [query, maker] of MANUFACTURERS) {
    add(
      "manufacturer",
      query,
      graded(
        (f) => (f.manufacturer ?? "").includes(maker) && f.onOrbit,
        (f) => (f.manufacturer ?? "").includes(maker),
        null,
      ),
      { manufacturer: { contains: maker } },
    );
  }

  // ---- launch dates: single years, decades, ranges, and superlatives.
  for (const year of [1998, 2003, 2008, 2013, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]) {
    add(
      "date",
      `launched in ${year}`,
      graded(
        (f) => f.launchYear === year && payload(f) && f.onOrbit,
        (f) => f.launchYear === year && payload(f),
        (f) => f.launchYear === year,
      ),
      { launchYear: { eq: year } },
    );
  }
  for (const [label, lo, hi] of [
    ["the 1960s", 1960, 1969],
    ["the 1970s", 1970, 1979],
    ["the 1980s", 1980, 1989],
    ["the 1990s", 1990, 1999],
    ["the 2000s", 2000, 2009],
    ["the 2010s", 2010, 2019],
  ]) {
    add(
      "date",
      `satellites launched in ${label}`,
      graded(
        (f) => f.launchYear >= lo && f.launchYear <= hi && payload(f) && f.onOrbit,
        (f) => f.launchYear >= lo && f.launchYear <= hi && payload(f),
        (f) => f.launchYear >= lo && f.launchYear <= hi,
      ),
      { launchYear: { gte: lo, lte: hi } },
    );
  }
  add(
    "date",
    "satellites launched before 1970",
    graded(
      (f) => f.launchYear < 1970 && payload(f) && f.onOrbit,
      (f) => f.launchYear < 1970 && payload(f),
      (f) => f.launchYear < 1970,
    ),
    { launchYear: { lt: 1970 } },
  );
  add(
    "date",
    "recently launched satellites",
    graded(
      (f) => f.launchYear >= 2024 && payload(f) && f.onOrbit,
      (f) => f.launchYear >= 2024 && payload(f),
      null,
    ),
    { launchYear: { gte: 2024 } },
  );
  add(
    "date",
    "oldest active satellite",
    graded(
      (f) => live(f) && payload(f) && f.launchYear < 1975,
      (f) => live(f) && payload(f) && f.launchYear < 1985,
      null,
    ),
    { onOrbit: { eq: true }, opStatus: { eq: "+" }, sort: { launchYear: "asc" } },
  );

  // ---- combinations: the real test of "semantics AND structure together".
  const COMBOS = [
    ["japanese weather satellites", (f) => f.owner === "JPN" && f.mission === "weather and meteorology", { owner: { eq: "JPN" }, mission: { eq: "weather and meteorology" } }],
    ["chinese navigation satellites", (f) => f.owner === "PRC" && f.mission === "navigation", { owner: { eq: "PRC" }, mission: { eq: "navigation" } }],
    ["russian rocket bodies", (f) => f.owner === "CIS" && f.objectClass === "Rocket Body", { owner: { eq: "CIS" }, objectClass: { eq: "Rocket Body" } }],
    ["american debris in low earth orbit", (f) => f.owner === "US" && /Debris/.test(f.objectClass ?? "") && f.regime?.includes("low Earth"), { owner: { eq: "US" }, regime: { contains: "low Earth" } }],
    ["active starlink satellites", (f) => /^STARLINK/.test(f.name) && live(f), { nameMatches: "^STARLINK", opStatus: { eq: "+" } }],
    ["japanese satellites in geostationary orbit", (f) => f.owner === "JPN" && f.regime === "geostationary orbit", { owner: { eq: "JPN" }, regime: { eq: "geostationary orbit" } }],
    ["chinese cubesats", (f) => f.owner === "PRC" && Number.isFinite(f.cubesatUnits), { owner: { eq: "PRC" }, sizeRule: "cubesats" }],
    ["european earth observation satellites", (f) => ["ESA", "FR", "GER", "IT", "SPN", "UK"].includes(f.owner) && f.mission === "Earth observation and imaging", { mission: { eq: "Earth observation and imaging" } }],
    ["indian satellites launched after 2015", (f) => f.owner === "IND" && f.launchYear > 2015, { owner: { eq: "IND" }, launchYear: { gt: 2015 } }],
    ["geostationary communications satellites", (f) => f.regime === "geostationary orbit" && /communications/.test(f.mission ?? ""), { regime: { eq: "geostationary orbit" }, mission: { eq: "communications" } }],
    ["russian satellites launched in the 1980s", (f) => f.owner === "CIS" && f.launchYear >= 1980 && f.launchYear <= 1989, { owner: { eq: "CIS" }, launchYear: { gte: 1980, lte: 1989 } }],
    ["small japanese satellites", (f) => f.owner === "JPN" && ["small satellite", "microsatellite", "nanosatellite"].includes(f.sizeClass), { owner: { eq: "JPN" }, sizeRule: "smallsats" }],
    ["debris from chinese launches", (f) => f.owner === "PRC" && /Debris/.test(f.objectClass ?? ""), { owner: { eq: "PRC" } }],
    ["operational weather satellites in geostationary orbit", (f) => f.mission === "weather and meteorology" && /geo/i.test(f.regime ?? "") && live(f), { mission: { eq: "weather and meteorology" }, regime: { eq: "geostationary orbit" } }],
    ["sun synchronous imaging satellites", (f) => f.regime === "sun-synchronous low Earth orbit" && f.mission === "Earth observation and imaging", { regime: { eq: "sun-synchronous low Earth orbit" } }],
  ];
  for (const [query, test, predicate] of COMBOS) {
    add("combo", query, graded((f) => test(f) && payload(f) && f.onOrbit, (f) => test(f) && payload(f), (f) => test(f)), predicate);
  }

  // ---- COMPOSITIONAL: "<demonym> <object type>" where NO catalogue name
  // contains the literal words. These are the queries that prove the system
  // composes structured facts rather than matching strings. The owner's
  // litmus case "japanese space station" is the first entry: the Japanese ISS
  // segment (Kibo/JEM) has no NORAD entry of its own, so the only path to a
  // correct answer is nations[] on the station stack.
  const COMPOSITIONAL = [
    ["japanese space station", (f) => (f.nations ?? []).includes("JPN") && !!f.stationProgramme, { nations: { has: "JPN" } }],
    ["japan space station module", (f) => (f.nations ?? []).includes("JPN") && !!f.stationProgramme, { nations: { has: "JPN" } }],
    ["chinese space station", (f) => (f.nations ?? []).includes("PRC") && !!f.stationProgramme, { nations: { has: "PRC" } }],
    ["russian space station", (f) => (f.nations ?? []).includes("CIS") && !!f.stationProgramme, { nations: { has: "CIS" } }],
    ["american space station", (f) => (f.nations ?? []).includes("US") && !!f.stationProgramme, { nations: { has: "US" } }],
    ["european space station module", (f) => (f.nations ?? []).includes("ESA") && !!f.stationProgramme, { nations: { has: "ESA" } }],
    ["french earth observation", (f) => f.owner === "FR" && f.mission === "Earth observation and imaging", { nations: { has: "FR" } }],
    ["indian navigation satellite", (f) => f.owner === "IND" && f.mission === "navigation", { nations: { has: "IND" } }],
    ["chinese navigation constellation", (f) => f.owner === "PRC" && f.mission === "navigation", { nations: { has: "PRC" } }],
    ["japanese weather satellite", (f) => f.owner === "JPN" && f.mission === "weather and meteorology", { nations: { has: "JPN" } }],
    ["american space telescope", (f) => f.owner === "US" && f.mission === "space telescope and astronomy", { nations: { has: "US" } }],
    ["russian navigation satellite", (f) => f.owner === "CIS" && f.mission === "navigation", { nations: { has: "CIS" } }],
    ["european weather satellite", (f) => ["ESA", "EUME", "FR", "GER", "IT"].includes(f.owner) && f.mission === "weather and meteorology", {}],
    ["chinese imaging satellite", (f) => f.owner === "PRC" && f.mission?.includes("remote sensing"), { nations: { has: "PRC" } }],
    ["japanese navigation satellite", (f) => f.owner === "JPN" && f.mission === "navigation", { nations: { has: "JPN" } }],
    ["indian earth observation", (f) => f.owner === "IND" && f.mission === "Earth observation and imaging", { nations: { has: "IND" } }],
    ["american communications satellite", (f) => f.owner === "US" && /communications/.test(f.mission ?? ""), { nations: { has: "US" } }],
    ["chinese military satellite", (f) => f.owner === "PRC" && f.mission === "military", { nations: { has: "PRC" } }],
  ];
  for (const [query, test, predicate] of COMPOSITIONAL) {
    add(
      "compositional",
      query,
      graded((f) => test(f) && payload(f) && f.onOrbit, (f) => test(f) && payload(f), (f) => test(f)),
      predicate,
    );
  }

  // ---- PARAPHRASES: the same information need said a different way.
  //
  // These reuse the judge of the query they paraphrase, so they add no new
  // ground truth — they test whether retrieval keys on MEANING or on one exact
  // surface form. A model that scores well on "weather satellites" and badly on
  // "satellites that observe the weather" is memorising strings, and this
  // family is what exposes that.
  const PARAPHRASES = {
    "weather satellites": ["satellites that observe the weather", "spacecraft for weather forecasting"],
    "navigation satellites": ["satellites used for positioning and navigation", "gnss satellites"],
    "earth observation satellites": ["satellites that take pictures of earth", "remote sensing spacecraft"],
    "space telescopes": ["orbiting observatories that look at stars", "telescopes in space"],
    "communications satellites": ["satellites that relay telephone and internet traffic"],
    "debris": ["junk in orbit", "space garbage fragments"],
    "rocket bodies": ["leftover rocket stages in orbit", "discarded booster stages"],
    "active payloads": ["satellites that still work", "currently functioning spacecraft"],
    "geostationary satellites": ["satellites parked over the equator", "satellites that stay above one spot on earth"],
    "sun synchronous satellites": ["satellites that cross the equator at the same local time"],
    "polar orbiting satellites": ["satellites that fly over the poles"],
    "cubesats": ["tiny standardised box satellites", "10 centimetre cube satellites"],
    "smallsats": ["lightweight satellites", "compact small spacecraft"],
    "starlink satellites": ["spacex broadband satellites", "starlink internet fleet"],
    "gps constellation": ["american navigation satellites", "the global positioning system satellites"],
    "japanese satellites": ["spacecraft operated by japan", "satellites built and run by japan"],
    "chinese satellites": ["spacecraft operated by china"],
    "russian satellites": ["spacecraft operated by russia"],
    "international space station": ["the crewed orbital laboratory", "the big space station where astronauts live"],
    "hubble space telescope": ["the famous orbiting optical telescope"],
    "launched on a falcon 9": ["payloads carried by spacex falcon 9", "satellites put up by falcon 9"],
    "launched from baikonur": ["satellites that lifted off from kazakhstan"],
    "UHF transmitters": ["satellites broadcasting in the ultra high frequency band"],
    "X-band downlink": ["spacecraft transmitting on x band"],
    "airbus satellites": ["spacecraft manufactured by airbus"],
    "boeing built": ["spacecraft manufactured by boeing"],
    "launched in 2023": ["satellites that went up in 2023"],
    "recently launched satellites": ["the newest satellites in orbit"],
    "rocket bodies ": [],
  };
  const byQuery = new Map(q.map((x) => [x.query, x]));
  for (const [base, variants] of Object.entries(PARAPHRASES)) {
    const src = byQuery.get(base);
    if (!src) continue;
    for (const variant of variants) {
      add(`${src.family}-paraphrase`, variant, src.judge, src.predicate);
    }
  }

  return q;
}

/** Resolve judges against a corpus into qrels: Map<queryId, Map<norad, grade>>. */
export function computeQrels(queries, corpus) {
  const qrels = new Map();
  for (const q of queries) {
    const rel = new Map();
    for (const row of corpus) {
      let g = 0;
      try {
        g = q.judge(row.fields) | 0;
      } catch {
        g = 0;
      }
      if (g > 0) rel.set(row.norad, g);
    }
    qrels.set(q.id, rel);
  }
  return qrels;
}
