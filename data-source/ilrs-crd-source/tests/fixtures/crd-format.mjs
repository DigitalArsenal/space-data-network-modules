// ILRS Consolidated Laser Ranging Data, version 2, built from SYNTHETIC passes in the layout of the format specification
// (ILRS CRD v2.01: H1 format header, H2 station, H3 target, H4 session, C0 configuration, 11 normal point, 20 meteorology, H8 end
// of session, H9 end of file). The real file the tests read is lageos1_20261008.first-two-passes.np2 (PROVENANCE.md).

// A pass. `start` is the H4 start [Y, M, D, h, m, s]; flags are the H4 indicators; `points` are { sod, tof, cfg, event, window, raw, rms } as printed.
export function pass({ station = {}, target = {}, start = [2026, 10, 11, 0, 0, 0], end = 'na na na na na na', dataType = 1, release = 0, troposphere = 0, centreOfMass = 0, receiveAmplitude = 0,
  stationDelay = 1, spacecraftDelay = 0, rangeType = 2, quality = 0, configs = [{ id: 'std', nm: '532.000' }], points = [], meteo = [] }) {
  const s = { name: 'TEST', pad: '9999', sys: '01', occ: '01', scale: 4, network: 'ILRS', ...station };
  const t = { name: 'lageos2', ilrs: '9207002', sic: '5986', norad: '22195', sc: 0, cls: 1, loc: 1, ...target };
  const lines = [
    `H1 CRD 2 2026 10 11 12`,
    `H2 ${s.name} ${s.pad} ${s.sys} ${s.occ} ${s.scale} ${s.network}`,
    `H3 ${t.name} ${t.ilrs} ${t.sic} ${t.norad} ${t.sc} ${t.cls} ${t.loc}`,
    `H4 ${dataType} ${start.join(' ')} ${end} ${release} ${troposphere} ${centreOfMass} ${receiveAmplitude} ${stationDelay} ${spacecraftDelay} ${rangeType} ${quality}`,
    ...configs.map((c) => `C0 0 ${c.nm} ${c.id} las1 det1 tim1 met1 sw1 na na`),
    ...meteo.map((m) => `20 ${m.sod} ${m.p} ${m.t} ${m.h} 0`),
    ...points.map((p) => `11 ${p.sod} ${p.tof} ${p.cfg ?? configs[0].id} ${p.event ?? 2} ${p.window ?? '120.0'} ${p.raw ?? 50} ${p.rms ?? '100.0'} 0.100 -0.500 na na 0 na`),
    `50 ${configs[0].id} 100.0 0.100 -0.500 na 0`,
    'H8',
  ];
  return lines.join('\n');
}

export const crdFile = (passes, { eof = true, version = 2 } = {}) => `${passes.join('\n').replace(/^H1 CRD 2/gm, `H1 CRD ${version}`)}\n${eof ? 'H9\n' : ''}`;
