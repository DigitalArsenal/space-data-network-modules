/**
 * Merged catalog record -> the natural-language document that gets embedded.
 *
 * WHY PROSE, NOT A FIELD DUMP: the retrieval model is a sentence encoder. It
 * was trained on prose, so prose is what it embeds well. "japanese satellites"
 * reaches NORAD 27600 because that object's document literally reads like a
 * sentence about a Japanese satellite; a tab-separated field list embeds
 * measurably worse.
 *
 * Every renderer below is keyed to a FIELD_SCHEMA entry with `prose: true` and
 * SKIPS SILENTLY when the field is absent. That is what lets the manufacturer /
 * frequency / size retrievers land later and immediately enrich the documents
 * without a single change here.
 */

import { LAUNCH_SITES } from "./catalog.mjs";

const OP_STATUS = {
  "+": "operational and active",
  "-": "nonoperational",
  P: "partially operational",
  B: "backup or standby",
  S: "spare",
  X: "extended mission",
  D: "decayed and reentered",
  "?": "status unknown",
};

/** DISCOS objectClass -> the words a user types for it. */
const OBJECT_CLASS_PROSE = {
  Payload: "payload satellite",
  "Rocket Body": "rocket body, a spent launch vehicle upper stage",
  "Rocket Mission Related Object": "rocket mission related hardware",
  "Rocket Debris": "rocket debris fragment",
  "Rocket Fragmentation Debris": "rocket fragmentation debris",
  "Payload Fragmentation Debris": "payload fragmentation debris",
  "Payload Debris": "payload debris fragment",
  "Payload Mission Related Object": "payload mission related hardware",
  "Other Debris": "orbital debris fragment",
  "Other Mission Related Object": "mission related hardware",
  Unknown: "unidentified catalogued object",
};

const CONSTELLATIONS = [
  [/^STARLINK/, "Starlink broadband internet constellation", "communications"],
  [/^ONEWEB/, "OneWeb broadband internet constellation", "communications"],
  [/^IRIDIUM/, "Iridium satellite telephone constellation", "communications"],
  [/^GLOBALSTAR/, "Globalstar satellite communications constellation", "communications"],
  [/^ORBCOMM/, "Orbcomm machine to machine messaging constellation", "communications"],
  [/^NAVSTAR|^GPS /, "NAVSTAR GPS constellation", "navigation"],
  [/GLONASS/, "GLONASS constellation", "navigation"],
  [/^BEIDOU/, "BeiDou constellation", "navigation"],
  [/GALILEO|^GSAT0\d/, "Galileo constellation", "navigation"],
  [/^QZS|^MICHIBIKI/, "Quasi-Zenith Satellite System", "navigation"],
  [/^COSMOS|^KOSMOS/, "Kosmos series of Russian and Soviet military and scientific satellites", "military"],
  [/^FLOCK|^DOVE|^SUPERDOVE|^SKYSAT/, "Planet Labs imaging constellation", "Earth observation"],
  [/^LEMUR/, "Spire Global constellation", "weather and ship tracking"],
  [/^ICEYE/, "ICEYE radar constellation", "synthetic aperture radar imaging"],
  [/^YAOGAN/, "Yaogan series", "Chinese remote sensing and reconnaissance"],
  [/^GAOFEN/, "Gaofen series", "high resolution Earth observation"],
  [/^GONETS/, "Gonets constellation", "communications"],
  [/^INTELSAT/, "Intelsat fleet", "geostationary communications"],
  [/^EUTELSAT/, "Eutelsat fleet", "geostationary communications"],
  [/^SES-|^ASTRA/, "SES fleet", "geostationary communications"],
  [/^O3B/, "O3b constellation", "medium Earth orbit broadband"],
  [/^INMARSAT/, "Inmarsat fleet", "mobile satellite communications"],
  [/^NOAA |^METOP|^GOES|^HIMAWARI|^FENGYUN|^METEOSAT|^METEOR/, null, "weather and meteorology"],
  [/^LANDSAT|^SENTINEL|^SPOT |^WORLDVIEW|^GEOEYE|^PLEIADES|^TERRA$|^AQUA$/, null, "Earth observation and imaging"],
  [/^HUBBLE|^CHANDRA|^SPITZER|^JWST|^XMM|^FERMI|^SWIFT|^TESS|^KEPLER/, null, "space telescope and astronomy"],
  [/^TIANGONG|^SHENZHOU|^TIANZHOU/, "Tiangong Chinese space station programme", "human spaceflight"],
  [/^PROGRESS|^SOYUZ/, null, "human spaceflight crew and cargo"],
  [/^DRAGON|^CYGNUS|^CST-100|^STARLINER/, null, "commercial cargo and crew spaceflight"],
];

/**
 * Classify constellation + mission theme from the object's names.
 *
 * MUST see the alt names, not just the SATCAT name. Two real defects came from
 * matching the SATCAT name alone:
 *   - NORAD 20580 is called "HST" in SATCAT, so /^HUBBLE/ never fired and the
 *     actual Hubble Space Telescope had no mission at all — the planner's
 *     "telescope" filter then excluded it from its own query.
 *   - Spire's "HUBBLE 6"/"HUBBLE 7" (alt name "Lemur-2 Lilo") matched /^HUBBLE/
 *     and were classified as space telescopes.
 * Testing every name, in list order, fixes both: LEMUR is checked before
 * HUBBLE, so the Spire craft classify as Spire, and HST matches on its alias.
 */
export function classifyName(name, altNames = []) {
  const candidates = [name, ...altNames].filter(Boolean).map((s) => String(s).toUpperCase());
  for (const [pattern, constellation, mission] of CONSTELLATIONS) {
    if (candidates.some((c) => pattern.test(c))) return { constellation, mission };
  }
  return { constellation: null, mission: null };
}

/** Broad orbital regime — the vocabulary of "geostationary"/"sun-synchronous" queries. */
export function orbitRegime({ apogee, perigee, period, inclination }) {
  if (!Number.isFinite(apogee) || !Number.isFinite(perigee)) return null;
  const spread = apogee - perigee;
  if (perigee > 34000 && apogee < 38000) {
    return Math.abs(inclination ?? 90) < 15 ? "geostationary orbit" : "geosynchronous orbit";
  }
  if (apogee > 30000 && spread > 15000) {
    return Number.isFinite(period) && period > 600 && period < 800
      ? "highly elliptical Molniya orbit"
      : "highly elliptical orbit";
  }
  if (perigee > 2000 && apogee < 35000) return "medium Earth orbit";
  if (apogee <= 2000) {
    if (Number.isFinite(inclination) && inclination > 95 && inclination < 105) {
      return "sun-synchronous low Earth orbit";
    }
    if (Number.isFinite(inclination) && inclination > 80) return "polar low Earth orbit";
    return "low Earth orbit";
  }
  return "high Earth orbit";
}

/** Derive the fields that come from other fields rather than from a source. */
export function deriveFields(rec) {
  const regime = orbitRegime(rec);

  // Alt names: DISCOS' long form and any parenthetical designator in the
  // SATCAT name. "ISS (ZARYA)" therefore yields both "International Space
  // Station" (DISCOS) and "ZARYA" without a hand-written alias table.
  const altNames = [];
  const paren = (rec.name ?? "").match(/\(([^)]+)\)/);
  if (paren) altNames.push(paren[1]);
  if (rec.discosName && rec.discosName.toUpperCase() !== (rec.name ?? "").toUpperCase()) {
    altNames.push(rec.discosName);
  }

  const { constellation, mission } = classifyName(rec.name ?? "", altNames);

  // Object class: prefer DISCOS' taxonomy, fall back to SATCAT naming.
  let objectClass = rec.objectClass;
  if (!objectClass) {
    const n = rec.name ?? "";
    if (/\bDEB\b|DEBRIS/.test(n)) objectClass = "Other Debris";
    else if (/\bR\/B\b/.test(n)) objectClass = "Rocket Body";
    else if (rec.payloadFlag === "*") objectClass = "Payload";
    else objectClass = "Unknown";
  }

  // Default every object to its single owner nation so the `nations` predicate
  // is uniform; STATION_PROGRAMS overrides this for multinational vehicles.
  const nations = rec.nations?.length ? rec.nations : rec.owner ? [rec.owner] : [];

  return { ...rec, constellation, mission, regime, altNames, objectClass, nations };
}

/**
 * Render the embedded document.
 * @param {object} rec merged + derived catalog record
 * @param {object} ownerTable from lcc.mjs buildOwnerTable()
 */
export function buildDocument(rec, ownerTable) {
  const parts = [];

  // 1. IDENTITY — name plus every alias, because users type any of them.
  const aliasText = rec.altNames?.length ? `, also known as ${rec.altNames.join(", ")}` : "";
  parts.push(`${rec.name}${aliasText}.`);

  // 2. WHAT IT IS + whether it is alive.
  const kind = OBJECT_CLASS_PROSE[rec.objectClass] ?? "catalogued space object";
  const status = OP_STATUS[rec.opStatus];
  const phrase = status ? `${status} ${kind}` : kind;
  parts.push(`${/^[aeiou]/i.test(phrase) ? "An" : "A"} ${phrase}.`);

  // 3. WHO — the "japanese satellites" hinge. Formal name AND demonyms.
  const owner = ownerTable[rec.owner];
  if (owner) {
    const demos = owner.demonyms.filter((d) => d.toLowerCase() !== owner.name.toLowerCase());
    parts.push(
      demos.length
        ? `Owned and operated by ${owner.name} (${demos.join(", ")}).`
        : `Owned and operated by ${owner.name}.`,
    );
  }

  // 3b. MULTINATIONAL PARTNERS. Named nations and modules, so a compositional
  //     query ("japanese space station") has something real to match against.
  if (rec.stationPartners) {
    parts.push(`Part of ${rec.stationProgramme}. ${rec.stationPartners}`);
    const others = (rec.nations ?? [])
      .filter((c) => c !== rec.owner)
      .map((c) => ownerTable[c])
      .filter(Boolean);
    if (others.length) {
      const words = others.flatMap((o) => [o.name, ...o.demonyms.slice(0, 1)]);
      parts.push(`Partner nations: ${[...new Set(words)].join(", ")}.`);
    }
  }

  // 4. WHO BUILT IT — absent until the manufacturer retriever lands.
  if (rec.manufacturer) {
    parts.push(rec.bus ? `Built by ${rec.manufacturer} on the ${rec.bus}.` : `Built by ${rec.manufacturer}.`);
  }

  // 5. PROGRAMME + MISSION.
  if (rec.constellation) parts.push(`Part of the ${rec.constellation}.`);
  if (rec.mission) parts.push(`Mission type: ${rec.mission}.`);

  // 6. SIZE — mass, class, CubeSat form factor.
  const size = [];
  if (rec.sizeClass) size.push(`a ${rec.sizeClass}`);
  if (Number.isFinite(rec.mass)) size.push(`mass ${formatMass(rec.mass)}`);
  if (Number.isFinite(rec.cubesatUnits)) size.push(`a ${rec.cubesatUnits}U CubeSat`);
  if (Number.isFinite(rec.span)) size.push(`${rec.span} metre span`);
  if (size.length) parts.push(`Physically ${size.join(", ")}.`);

  // 7. RADIO — bands are what users name, exact MHz stays a predicate.
  if (rec.bands?.length) {
    parts.push(`Transmits on ${rec.bands.join(" and ")} downlink.`);
  }

  // 8. ORBIT.
  if (rec.regime) {
    const detail = [];
    if (Number.isFinite(rec.perigee) && Number.isFinite(rec.apogee)) {
      detail.push(`${Math.round(rec.perigee)} by ${Math.round(rec.apogee)} kilometres`);
    }
    if (Number.isFinite(rec.inclination)) detail.push(`${rec.inclination} degree inclination`);
    parts.push(`In ${rec.regime}${detail.length ? `, ${detail.join(", ")}` : ""}.`);
  }

  // 9. LAUNCH.
  const site = LAUNCH_SITES[rec.launchSite];
  const launchBits = [];
  if (rec.launchYear) launchBits.push(`in ${rec.launchYear}`);
  if (rec.launchVehicle) launchBits.push(`on a ${rec.launchVehicle}`);
  if (site) launchBits.push(`from ${site}`);
  if (launchBits.length) parts.push(`Launched ${launchBits.join(" ")}.`);
  if (rec.decayDate) parts.push(`Reentered on ${rec.decayDate}.`);

  // 10. HARD IDENTIFIERS last — required for identifier queries, semantically
  //     inert, so they sit where they dilute the sentence least.
  parts.push(`NORAD catalog number ${rec.norad}, international designator ${rec.intldes}.`);

  return parts.join(" ");
}

function formatMass(kg) {
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} tonnes`;
  if (kg >= 1) return `${Math.round(kg)} kilograms`;
  return `${kg} kilograms`;
}
