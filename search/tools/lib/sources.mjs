/**
 * Metadata source adapters -> one merged, NORAD-keyed record per space object.
 *
 * DESIGN CONTRACT (this is the part that outlives the spike): every source is
 * an adapter with the same shape
 *
 *     { id, describe(), load(paths) -> Map<norad, Partial<CatalogRecord>> }
 *
 * and `mergeSources()` folds them left-to-right into one record. Adding the
 * manufacturer / frequency / size retrievers the parallel program is standing
 * up therefore means ADDING AN ADAPTER, never touching the document builder,
 * the embedding pipeline, or the query planner. Fields that no source has yet
 * are simply absent, and every consumer already treats absence as normal.
 *
 * The merged record's field set is declared once in `FIELD_SCHEMA` below; that
 * declaration drives the document text, the structured predicates the query
 * planner can emit, and the eval-set generator. One schema, three consumers.
 */

import { readFileSync } from "node:fs";
import { parseSatcatLine } from "./catalog.mjs";

/**
 * The catalog record schema.
 *
 * `predicate: true` marks a field the FlatSQL layer can filter on directly —
 * those are exactly the fields the query planner is allowed to turn into a
 * structured predicate ("launched in 2023" -> launchYear range). `prose`
 * marks fields that get rendered into the embedded document text.
 *
 * A field may be both: `owner` filters exactly AND reads naturally.
 */
export const FIELD_SCHEMA = {
  norad: { type: "int", predicate: true, prose: true, source: "satcat" },
  intldes: { type: "string", predicate: true, prose: true, source: "satcat" },
  name: { type: "string", predicate: false, prose: true, source: "satcat" },
  altNames: { type: "string[]", predicate: false, prose: true, source: "discos+derived" },
  owner: { type: "enum:LCC", predicate: true, prose: true, source: "satcat" },
  // Every nation with a stake in the object. For an ordinary satellite this is
  // just [owner]; for a multinational station it is every partner, which is the
  // only way "japanese space station" can reach the ISS (see STATION_PROGRAMS).
  nations: { type: "string[]", predicate: true, prose: true, source: "derived|stations" },
  stationProgramme: { type: "string", predicate: true, prose: true, source: "stations" },
  objectClass: { type: "string", predicate: true, prose: true, source: "discos|satcat" },
  opStatus: { type: "enum", predicate: true, prose: true, source: "satcat" },
  launchYear: { type: "int", predicate: true, prose: true, source: "satcat" },
  launchDate: { type: "date", predicate: true, prose: true, source: "satcat" },
  launchSite: { type: "string", predicate: true, prose: true, source: "satcat" },
  launchVehicle: { type: "string", predicate: true, prose: true, source: "gcat" },
  decayDate: { type: "date", predicate: true, prose: false, source: "satcat" },
  onOrbit: { type: "bool", predicate: true, prose: false, source: "derived" },
  regime: { type: "enum", predicate: true, prose: true, source: "derived" },
  apogee: { type: "float", predicate: true, prose: true, source: "satcat" },
  perigee: { type: "float", predicate: true, prose: true, source: "satcat" },
  inclination: { type: "float", predicate: true, prose: true, source: "satcat" },
  period: { type: "float", predicate: true, prose: false, source: "satcat" },
  mass: { type: "float", predicate: true, prose: true, source: "discos" },
  sizeClass: { type: "enum", predicate: true, prose: true, source: "derived:mass" },
  cubesatUnits: { type: "int", predicate: true, prose: true, source: "derived:dims" },
  shape: { type: "string", predicate: false, prose: true, source: "discos" },
  span: { type: "float", predicate: true, prose: true, source: "discos" },
  xSectAvg: { type: "float", predicate: true, prose: false, source: "discos" },
  constellation: { type: "string", predicate: true, prose: true, source: "derived:name" },
  mission: { type: "string", predicate: true, prose: true, source: "derived:name" },
  manufacturer: { type: "string", predicate: true, prose: true, source: "curated|PENDING-retriever" },
  frequenciesMhz: { type: "float[]", predicate: true, prose: false, source: "freqs" },
  bands: { type: "string[]", predicate: true, prose: true, source: "derived:freqs" },
};

/** RF band names by downlink frequency in MHz. Standard IEEE letter bands. */
export function bandForMhz(mhz) {
  if (!Number.isFinite(mhz) || mhz <= 0) return null;
  if (mhz < 300) return "VHF";
  if (mhz < 1000) return "UHF";
  if (mhz < 2000) return "L-band";
  if (mhz < 4000) return "S-band";
  if (mhz < 8000) return "C-band";
  if (mhz < 12000) return "X-band";
  if (mhz < 18000) return "Ku-band";
  if (mhz < 27000) return "K-band";
  if (mhz < 40000) return "Ka-band";
  return "millimetre wave";
}

/** Coarse size class from mass in kg — the vocabulary users actually type. */
export function sizeClassForMass(kg) {
  if (!Number.isFinite(kg) || kg <= 0) return null;
  if (kg < 1) return "picosatellite";
  if (kg < 10) return "nanosatellite";
  if (kg < 100) return "microsatellite";
  if (kg < 500) return "small satellite";
  if (kg < 1000) return "medium satellite";
  return "large satellite";
}

/**
 * CubeSat unit count from DISCOS box dimensions (metres).
 * 1U is a 10 cm cube; a 6U is 10x20x30 cm. Only claimed when the body really
 * is a box on the CubeSat grid, so "cubesats over 6U" cannot silently match a
 * bus-sized spacecraft.
 */
export function cubesatUnits({ shape, width, height, depth }) {
  if (!shape || !/box/i.test(shape)) return null;
  const dims = [width, height, depth].filter((d) => Number.isFinite(d) && d > 0);
  if (dims.length !== 3) return null;
  if (dims.some((d) => d > 0.65)) return null; // beyond plausible CubeSat form factors
  const units = Math.round((dims[0] * dims[1] * dims[2]) / 0.001);
  return units >= 1 && units <= 27 ? units : null;
}

/** ---------------------------------------------------------------- adapters */

export const satcatSource = {
  id: "satcat",
  describe: () => "CelesTrak SATCAT fixed-width catalogue (identity, owner, launch, orbit, status)",
  load(paths) {
    const out = new Map();
    const text = readFileSync(paths.satcat, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const row = parseSatcatLine(line);
      if (!row) continue;
      out.set(row.norad, {
        norad: row.norad,
        intldes: row.intldes,
        name: row.name,
        owner: row.owner,
        opStatus: row.opStatus,
        payloadFlag: row.payloadFlag,
        launchDate: row.launch || null,
        launchYear: row.launch ? Number.parseInt(row.launch.slice(0, 4), 10) : null,
        launchSite: row.site || null,
        decayDate: row.decay || null,
        onOrbit: !row.decay,
        apogee: row.apogee,
        perigee: row.perigee,
        inclination: row.inclination,
        period: row.period,
        rcs: row.rcs,
      });
    }
    return out;
  },
};

export const discosSource = {
  id: "discos",
  describe: () => "ESA DISCOS object database (canonical long name, object class, mass, shape, dimensions)",
  load(paths) {
    const out = new Map();
    if (!paths.discos) return out;
    const doc = JSON.parse(readFileSync(paths.discos, "utf8"));
    for (const r of doc.records ?? []) {
      const norad = Number(r.satno);
      if (!Number.isFinite(norad) || norad <= 0) continue;
      const units = cubesatUnits(r);
      out.set(norad, {
        discosName: r.name || null,
        objectClass: r.objectClass || null,
        mass: Number.isFinite(r.mass) ? r.mass : null,
        sizeClass: sizeClassForMass(r.mass),
        cubesatUnits: units,
        shape: r.shape || null,
        span: Number.isFinite(r.span) ? r.span : null,
        xSectAvg: Number.isFinite(r.xSectAvg) ? r.xSectAvg : null,
        discosActive: r.active,
      });
    }
    return out;
  },
};

/**
 * Parse a downlink-frequency cell into MHz values.
 *
 * The table is human-maintained, so the cell is a number for most rows but a
 * RANGE ("2170 - 2200") or a multi-value list for a large minority. Treating
 * it as a bare Number dropped 60% of the frequency-bearing rows on the first
 * pass; both endpoints of a range matter because a range can straddle a band
 * boundary.
 */
export function parseFrequencyCell(cell) {
  if (Number.isFinite(cell)) return [cell];
  if (typeof cell !== "string") return [];
  const nums = cell.match(/\d+(?:\.\d+)?/g);
  if (!nums) return [];
  return nums.map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

export const freqSource = {
  id: "freqs",
  describe: () => "Downlink frequency table (NORAD or COSPAR -> MHz), mapped to IEEE letter bands",
  load(paths, base) {
    const out = new Map();
    if (!paths.freqs) return out;
    const rows = JSON.parse(readFileSync(paths.freqs, "utf8"));
    const list = Array.isArray(rows) ? rows : Object.values(rows).find(Array.isArray) ?? [];

    // Rows keyed by international designator instead of NORAD are common in
    // this table; resolve them through the already-merged catalogue.
    const byIntldes = new Map();
    if (base) {
      for (const [norad, rec] of base) {
        if (rec.intldes) byIntldes.set(rec.intldes.replace(/\s+/g, "").toUpperCase(), norad);
      }
    }
    const resolve = (key) => {
      const n = Number(key);
      if (Number.isFinite(n) && n > 0) return n;
      if (typeof key !== "string") return null;
      const k = key.replace(/\s+/g, "").toUpperCase();
      if (byIntldes.has(k)) return byIntldes.get(k);
      // "2018-099" (launch tag, no piece letter) -> the primary payload "…A".
      if (/^\d{4}-\d{3}$/.test(k) && byIntldes.has(`${k}A`)) return byIntldes.get(`${k}A`);
      return null;
    };

    for (const r of list) {
      const norad = resolve(r.NORAD ?? r.norad);
      if (norad === null) continue;
      const mhzList = parseFrequencyCell(r["DOWNLINK FREQ"] ?? r.downlink ?? r.freq);
      if (!mhzList.length) continue;
      const prev = out.get(norad) ?? { frequenciesMhz: [], bands: [] };
      for (const mhz of mhzList) {
        if (!prev.frequenciesMhz.includes(mhz)) prev.frequenciesMhz.push(mhz);
        const band = bandForMhz(mhz);
        if (band && !prev.bands.includes(band)) prev.bands.push(band);
      }
      out.set(norad, prev);
    }
    return out;
  },
};

/**
 * GCAT launch table -> launch vehicle per LAUNCH, joined onto objects by the
 * international designator's launch tag ("1998-067A" -> "1998-067").
 */
export const gcatLaunchSource = {
  id: "gcat",
  describe: () => "Jonathan McDowell GCAT launch table (launch vehicle type per launch tag)",
  load(paths, base) {
    const out = new Map();
    if (!paths.gcatLaunch || !base) return out;
    const text = readFileSync(paths.gcatLaunch, "utf8");
    const lines = text.split(/\r?\n/);
    const headers = lines[0].replace(/^#/, "").split("\t").map((h) => h.trim());
    const iTag = headers.indexOf("Launch_Tag");
    const iLv = headers.indexOf("LV_Type");
    const byTag = new Map();
    for (const line of lines.slice(1)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const v = line.split("\t");
      const tag = (v[iTag] ?? "").trim();
      const lv = (v[iLv] ?? "").trim();
      if (tag && lv && lv !== "-") byTag.set(tag, lv);
    }
    for (const [norad, rec] of base) {
      const tag = (rec.intldes ?? "").match(/^(\d{4}-\d{3})/)?.[1];
      const lv = tag ? byTag.get(tag) : null;
      if (lv) out.set(norad, { launchVehicle: lv });
    }
    return out;
  },
};

/**
 * Manufacturer / satellite bus.
 *
 * ⚠ NO NORAD-KEYED MANUFACTURER SOURCE EXISTS IN THE STACK TODAY. This adapter
 * carries the well-established constellation -> prime contractor mapping only,
 * which covers the large families a user actually names. Everything else has
 * no manufacturer and the field is simply absent.
 *
 * This is the seam the parallel retriever program plugs into: replace the body
 * of `load()` with the real source and nothing downstream changes.
 * @see graph/tasks/embedding-search-metadata-retrievers.md
 */
export const manufacturerSource = {
  id: "manufacturer",
  describe: () => "Constellation -> prime contractor / bus (curated; PENDING a real NORAD-keyed retriever)",
  pending: true,
  load(paths, base) {
    const out = new Map();
    if (!base) return out;
    const rules = [
      [/^STARLINK/, "SpaceX", "Starlink bus"],
      [/^ONEWEB/, "Airbus OneWeb Satellites", "OneWeb bus"],
      [/^IRIDIUM \d*1\d\d|^IRIDIUM NEXT/, "Thales Alenia Space", "ELiTeBus"],
      [/^IRIDIUM/, "Motorola", null],
      [/^GLOBALSTAR/, "Thales Alenia Space", null],
      [/^NAVSTAR|^GPS /, "Lockheed Martin", "GPS III bus"],
      [/GALILEO|^GSAT0\d/, "OHB System", null],
      [/^SENTINEL-1/, "Thales Alenia Space", null],
      [/^SENTINEL-2/, "Airbus Defence and Space", null],
      [/^SPOT |^PLEIADES/, "Airbus Defence and Space", "AstroBus"],
      [/^METOP|^METEOSAT/, "Airbus Defence and Space", null],
      [/^FLOCK|^DOVE|^SUPERDOVE/, "Planet Labs", "Dove 3U CubeSat bus"],
      [/^SKYSAT/, "Maxar", "SkySat bus"],
      [/^LEMUR/, "Spire Global", "LEMUR 3U CubeSat bus"],
      [/^ICEYE/, "ICEYE", null],
      [/^WORLDVIEW|^GEOEYE/, "Maxar", "Legion bus"],
      [/^INTELSAT/, "Boeing", "Boeing 702 bus"],
      [/^INMARSAT/, "Airbus Defence and Space", "Eurostar bus"],
      [/^O3B/, "Thales Alenia Space", null],
      [/^SES-/, "Boeing", "Boeing 702 bus"],
      [/^WGS |^WIDEBAND GLOBAL/, "Boeing", "Boeing 702 bus"],
      [/^GOES/, "Lockheed Martin", "A2100 bus"],
      [/^TDRS/, "Boeing", "Boeing 601 bus"],
    ];
    for (const [norad, rec] of base) {
      const name = rec.name ?? "";
      for (const [pattern, maker, bus] of rules) {
        if (pattern.test(name)) {
          out.set(norad, { manufacturer: maker, bus: bus ?? null });
          break;
        }
      }
    }
    return out;
  },
};

/**
 * Crewed-station partner nations and modules.
 *
 * WHY THIS EXISTS — the owner's litmus query "japanese space station" returned
 * NOTHING, and the reason is structural, not a ranking accident: the Japanese
 * segment of the ISS (the Kibo / JEM pressurised module) has NO NORAD catalogue
 * entry of its own. It was carried up by Shuttle and bolted to a stack that is
 * catalogued under `owner = ISS`. So no amount of similarity search over the
 * catalogue as-shipped can connect "japanese" to it — the fact is simply absent
 * from every record.
 *
 * A station is a MULTINATIONAL object, and one `owner` code cannot express
 * that. `nations` is the honest field: every country with a segment on the
 * vehicle. Ordinary satellites get `nations = [owner]`, so the same predicate
 * ("does this object belong to Japan?") works uniformly and the planner needs
 * no special case.
 */
export const STATION_PROGRAMS = [
  {
    match: (rec) => rec.owner === "ISS" || /^ISS \(/.test(rec.name ?? "") || rec.norad === 36086,
    programme: "the International Space Station",
    nations: ["ISS", "US", "CIS", "JPN", "ESA", "CA", "IT"],
    partners:
      "International partners: the United States (NASA), Russia (Roscosmos), Japan (JAXA, which " +
      "operates the Kibo Japanese Experiment Module), Europe (ESA, Columbus laboratory) and " +
      "Canada (CSA, Canadarm2). Crewed orbital laboratory and space station.",
  },
  {
    match: (rec) => /^CSS \(|^TIANGONG/.test(rec.name ?? ""),
    programme: "the Tiangong Chinese Space Station",
    nations: ["PRC"],
    partners:
      "Chinese space station operated by the China Manned Space Agency, comprising the Tianhe " +
      "core module and the Wentian and Mengtian laboratory modules. Crewed orbital laboratory " +
      "and space station.",
  },
  {
    match: (rec) => /^MIR$|^MIR /.test(rec.name ?? ""),
    programme: "the Mir space station",
    nations: ["CIS"],
    partners: "Soviet and Russian crewed space station. Crewed orbital laboratory and space station.",
  },
];

export const stationSource = {
  id: "stations",
  describe: () => "Crewed-station programme membership: partner nations and module prose",
  load(paths, base) {
    const out = new Map();
    if (!base) return out;
    for (const [norad, rec] of base) {
      for (const prog of STATION_PROGRAMS) {
        if (prog.match(rec)) {
          out.set(norad, {
            stationProgramme: prog.programme,
            stationPartners: prog.partners,
            nations: prog.nations,
          });
          break;
        }
      }
    }
    return out;
  },
};

export const ALL_SOURCES = [
  satcatSource,
  discosSource,
  freqSource,
  gcatLaunchSource,
  manufacturerSource,
  stationSource,
];

/**
 * Fold every adapter into one record per NORAD.
 * Adapters that need the already-merged base (joins by designator or name)
 * receive it as the second argument, so ordering in ALL_SOURCES is meaningful:
 * pure sources first, derived joins after.
 */
export function mergeSources(paths, sources = ALL_SOURCES) {
  const merged = new Map();
  const report = [];
  for (const source of sources) {
    const partial = source.load(paths, merged);
    let touched = 0;
    for (const [norad, fields] of partial) {
      const existing = merged.get(norad);
      if (!existing && source.id !== "satcat") continue; // SATCAT defines catalogue membership
      merged.set(norad, { ...(existing ?? {}), ...fields });
      touched += 1;
    }
    report.push({ source: source.id, records: partial.size, applied: touched, pending: !!source.pending });
  }
  return { records: merged, report };
}
