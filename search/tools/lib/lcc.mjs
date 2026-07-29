/**
 * SDS $LCC (legacyCountryCode) -> human country/organization name, plus the
 * demonym forms a natural-language query actually uses.
 *
 * The code->name half is READ FROM SDS, never retyped: the IDL doc comment on
 * each enumerant IS the authoritative name ("/// Japan" above `JPN,`). That
 * keeps this file from becoming a second, drifting country table.
 *
 * The demonym half is genuinely new information (SDS has no demonym field), so
 * it lives here as an explicit table. It is the single reason a query like
 * "japanese satellites" can reach an object whose only country marker is the
 * three-letter code `JPN`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/** Parse `schema/LCC/main.fbs` into { CODE: "Human Name" }. */
export function loadLccNames(standardsRoot) {
  const fbs = path.join(standardsRoot, "schema", "LCC", "main.fbs");
  const text = readFileSync(fbs, "utf8");
  const names = {};
  let doc = null;
  for (const line of text.split(/\r?\n/)) {
    const d = line.match(/^\s*\/\/\/\s*(.+?)\s*$/);
    if (d) {
      doc = d[1];
      continue;
    }
    const e = line.match(/^\s*([A-Z][A-Z0-9]*)\s*,?\s*$/);
    if (e && doc) {
      names[e[1]] = doc;
      doc = null;
    }
  }
  if (Object.keys(names).length < 100) {
    throw new Error(`LCC parse produced only ${Object.keys(names).length} codes — schema shape changed`);
  }
  return names;
}

/**
 * Owner codes present in the live CelesTrak SATCAT that SDS $LCC does NOT
 * define (measured 2026-07-29 against schema/LCC/main.fbs v1.0.1: 129 SATCAT
 * owners, 119 covered). Carried here so the corpus is complete TODAY; the
 * real fix is an $LCC amendment.
 *
 * @see graph/tasks/embedding-search-sds-lcc-gap.md — Themis escalation.
 */
export const LCC_GAP = {
  SVK: "Slovakia",
  JOR: "Jordan",
  KWT: "Kuwait",
  UGA: "Uganda",
  SEN: "Senegal",
  HRV: "Croatia",
  BWA: "Botswana",
  BHR: "Bahrain",
  SLB: "Solomon Islands",
  MNE: "Montenegro",
};

/**
 * Demonyms + colloquial aliases per owner code.
 *
 * Only codes a user plausibly names in a query need an entry; everything else
 * falls back to the LCC name itself. Multi-word entries are fine — the corpus
 * text is natural language, not a keyword list.
 */
export const DEMONYMS = {
  US: ["American", "United States", "USA", "US"],
  CIS: ["Russian", "Russia", "Soviet", "USSR", "Commonwealth of Independent States"],
  PRC: ["Chinese", "China", "PRC"],
  JPN: ["Japanese", "Japan"],
  UK: ["British", "United Kingdom", "Britain", "UK"],
  FR: ["French", "France"],
  GER: ["German", "Germany"],
  IND: ["Indian", "India"],
  ITSO: ["Intelsat", "international telecommunications satellite"],
  ESA: ["European", "Europe", "European Space Agency", "ESA"],
  IT: ["Italian", "Italy"],
  CA: ["Canadian", "Canada"],
  SKOR: ["South Korean", "South Korea", "Korean", "Republic of Korea"],
  NKOR: ["North Korean", "North Korea"],
  SPN: ["Spanish", "Spain"],
  AUS: ["Australian", "Australia"],
  TURK: ["Turkish", "Turkey", "Türkiye"],
  ARGN: ["Argentine", "Argentinian", "Argentina"],
  BRAZ: ["Brazilian", "Brazil"],
  ISRA: ["Israeli", "Israel"],
  IRAN: ["Iranian", "Iran"],
  UAE: ["Emirati", "United Arab Emirates", "UAE"],
  SAUD: ["Saudi", "Saudi Arabia", "Saudi Arabian"],
  EGYP: ["Egyptian", "Egypt"],
  NETH: ["Dutch", "Netherlands", "Holland"],
  SWED: ["Swedish", "Sweden"],
  NOR: ["Norwegian", "Norway"],
  FIN: ["Finnish", "Finland"],
  DEN: ["Danish", "Denmark"],
  POL: ["Polish", "Poland"],
  CZCH: ["Czech", "Czechia", "Czech Republic", "Czechoslovakia"],
  SWTZ: ["Swiss", "Switzerland"],
  BEL: ["Belgian", "Belgium"],
  POR: ["Portuguese", "Portugal"],
  GREC: ["Greek", "Greece"],
  LUXE: ["Luxembourgish", "Luxembourg"],
  UKR: ["Ukrainian", "Ukraine"],
  BELA: ["Belarusian", "Belarus"],
  KAZ: ["Kazakh", "Kazakhstan"],
  AZER: ["Azerbaijani", "Azerbaijan"],
  ARM: ["Armenian", "Armenia"],
  MEX: ["Mexican", "Mexico"],
  CHLE: ["Chilean", "Chile"],
  COL: ["Colombian", "Colombia"],
  PERU: ["Peruvian", "Peru"],
  VENZ: ["Venezuelan", "Venezuela"],
  ROC: ["Taiwanese", "Taiwan", "Republic of China"],
  THAI: ["Thai", "Thailand"],
  INDO: ["Indonesian", "Indonesia"],
  MALA: ["Malaysian", "Malaysia"],
  SING: ["Singaporean", "Singapore"],
  PHIL: ["Filipino", "Philippines"],
  VTNM: ["Vietnamese", "Vietnam"],
  PAKI: ["Pakistani", "Pakistan"],
  BGD: ["Bangladeshi", "Bangladesh"],
  LKA: ["Sri Lankan", "Sri Lanka"],
  NPL: ["Nepali", "Nepal"],
  RSA: ["South African", "South Africa"],
  NIG: ["Nigerian", "Nigeria"],
  ALG: ["Algerian", "Algeria"],
  MOR: ["Moroccan", "Morocco"],
  TUN: ["Tunisian", "Tunisia"],
  KEN: ["Kenyan", "Kenya"],
  GHA: ["Ghanaian", "Ghana"],
  ETH: ["Ethiopian", "Ethiopia"],
  ANG: ["Angolan", "Angola"],
  SVK: ["Slovak", "Slovakia"],
  HRV: ["Croatian", "Croatia"],
  HUN: ["Hungarian", "Hungary"],
  ROM: ["Romanian", "Romania"],
  BUL: ["Bulgarian", "Bulgaria"],
  EST: ["Estonian", "Estonia"],
  LTU: ["Lithuanian", "Lithuania"],
  LVA: ["Latvian", "Latvia"],
  IRAQ: ["Iraqi", "Iraq"],
  JOR: ["Jordanian", "Jordan"],
  KWT: ["Kuwaiti", "Kuwait"],
  QAT: ["Qatari", "Qatar"],
  BHR: ["Bahraini", "Bahrain"],
  NZ: ["New Zealand", "New Zealander", "Kiwi"],
  IRAN_: [],
  ISS: ["International Space Station", "ISS", "space station"],
  SEAL: ["Sea Launch"],
  GLOB: ["Globalstar"],
  O3B: ["O3b", "SES O3b"],
  SES: ["SES", "SES Astra"],
  ORB: ["Orbcomm"],
  EUTE: ["Eutelsat", "European telecommunications satellite"],
  IM: ["Inmarsat"],
  ASRA: ["Austrian", "Austria"],
  TBD: [],
  NATO: ["NATO", "North Atlantic Treaty Organization"],
  EUME: ["EUMETSAT", "European meteorological"],
  RASC: ["RascomStar"],
  AB: ["Arabsat", "Arab Satellite Communications Organization"],
  ABS: ["Asia Broadcast Satellite"],
  AC: ["AsiaSat", "Asia Satellite Telecommunications"],
};

/** Full owner table: LCC names + gap fill, each with its demonym list. */
export function buildOwnerTable(standardsRoot) {
  const names = { ...loadLccNames(standardsRoot), ...LCC_GAP };
  const table = {};
  for (const [code, name] of Object.entries(names)) {
    const demonyms = DEMONYMS[code] ?? [];
    table[code] = { code, name, demonyms };
  }
  return table;
}
