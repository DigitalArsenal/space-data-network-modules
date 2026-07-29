/**
 * CelesTrak SATCAT fixed-width parsing, and the launch-site code table.
 *
 * Parsing only — the record MERGE lives in sources.mjs and the embedded
 * document text lives in document.mjs, so a new metadata source never has to
 * touch this file.
 */

/** SATCAT column spans, 1-indexed inclusive, per CelesTrak's published format. */
const COLS = {
  intldes: [1, 11],
  norad: [14, 18],
  // Measured against real rows 2026-07-29, NOT taken from the published spec,
  // which is one column to the left of the actual file:
  //   "1998-067A    25544  *+ ISS (ZARYA)"
  //                        ^^ col 21 = payload flag, col 22 = operational status
  // Reading these one column early made `opStatus` a copy of the payload flag
  // ("*"/blank), so operational status never reached the documents at all.
  multipleName: [20, 20],
  payloadFlag: [21, 21],
  opStatus: [22, 22],
  name: [24, 47],
  owner: [50, 55],
  launch: [57, 66],
  site: [69, 73],
  decay: [76, 85],
  // The five trailing numeric fields are RIGHT-ALIGNED and were mis-specified
  // on the first pass, which silently dropped 80% of apogees (and with them
  // every orbital regime). Verified against real rows 2026-07-29:
  //   "...1957-12-01     96.2   65.1     938     214   20.4200"
  //    period 91-94, incl 98-101, apogee 107-109, perigee 115-117, rcs 121-127
  // Spans below are the full padded fields; `field()` trims. "N/A" -> null.
  period: [87, 94],
  inclination: [96, 101],
  apogee: [103, 109],
  perigee: [111, 117],
  rcs: [119, 127],
};

const field = (line, [a, b]) => line.slice(a - 1, b).trim();

/** Launch site codes -> place names, for "launched from ..." queries. */
export const LAUNCH_SITES = {
  AFETR: "Cape Canaveral, Florida, United States",
  AFWTR: "Vandenberg Space Force Base, California, United States",
  TYMSC: "Baikonur Cosmodrome, Kazakhstan",
  BILAK: "Baikonur Cosmodrome, Kazakhstan",
  PLMSC: "Plesetsk Cosmodrome, Russia",
  KYMSC: "Kapustin Yar, Russia",
  SVOBO: "Svobodny, Russia",
  VOSTO: "Vostochny Cosmodrome, Russia",
  OREN: "Orenburg, Russia",
  KSCUT: "Uchinoura Space Center, Japan",
  TANSC: "Tanegashima Space Center, Japan",
  JSC: "Jiuquan Satellite Launch Center, China",
  TSC: "Taiyuan Satellite Launch Center, China",
  XSC: "Xichang Satellite Launch Center, China",
  WSC: "Wenchang Space Launch Site, China",
  SRILR: "Satish Dhawan Space Centre, Sriharikota, India",
  FRGUI: "Guiana Space Centre, Kourou, French Guiana",
  SNMLP: "San Marco platform, Kenya",
  WLPIS: "Wallops Island, Virginia, United States",
  KODAK: "Kodiak Island, Alaska, United States",
  KWAJ: "Kwajalein Atoll, Marshall Islands",
  SEAL: "Sea Launch Odyssey platform, Pacific Ocean",
  SEMLS: "Semnan, Iran",
  SUBL: "submarine launch platform",
  YAVNE: "Palmachim, Israel",
  YUN: "Sohae, North Korea",
  RLLB: "Rocket Lab Launch Complex 1, Mahia, New Zealand",
  WOMRA: "Woomera, Australia",
  HGSTR: "Hammaguir, Algeria",
  ERAS: "European launch site",
  VOSTOCHNY: "Vostochny Cosmodrome, Russia",
};

/** Parse one fixed-width SATCAT line into a structured row (null if not a record). */
export function parseSatcatLine(line) {
  if (line.length < 60) return null;
  const num = (v) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const norad = Number.parseInt(field(line, COLS.norad), 10);
  if (!Number.isFinite(norad)) return null;
  return {
    norad,
    intldes: field(line, COLS.intldes),
    name: field(line, COLS.name),
    payloadFlag: field(line, COLS.payloadFlag),
    opStatus: field(line, COLS.opStatus),
    owner: field(line, COLS.owner),
    launch: field(line, COLS.launch),
    site: field(line, COLS.site),
    decay: field(line, COLS.decay),
    period: num(field(line, COLS.period)),
    inclination: num(field(line, COLS.inclination)),
    apogee: num(field(line, COLS.apogee)),
    perigee: num(field(line, COLS.perigee)),
    rcs: num(field(line, COLS.rcs)),
  };
}
