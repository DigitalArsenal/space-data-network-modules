// SP3-d precise orbit files built here from SYNTHETIC satellites, in the layout the IGS specification fixes (The Extended
// Standard Product 3 Orbit Format, SP3-d, Hilla, NGS, 2016): the header columns, F14.6 position and clock fields, positions in
// kilometres, velocities in decimetres per second, an absent position written 0.000000. These stand for the ESA/ESOC
// products (the GLONASS and low-Earth-orbit POD files), which are not ours to reproduce (audit ids esa-navigation-office and
// esa-navigation-office-pod, reproduce no); the real IGS-licensed files the tests read are in files/orbit-products/fixtures.

const f = (x, width = 14, digits = 6) => x.toFixed(digits).padStart(width);

// sats: [{ id: 'L51', epochs: [[x, y, z] | [x, y, z, vx, vy, vz] (km, km/s) | null (absent)] }], one entry per epoch, every satellite
// the same count. flag 'V' writes a velocity record after each position that has one.
export function sp3File({ flag = 'P', start = [2026, 10, 11, 0, 0, 0], interval = 300, coordinateSystem = 'IGS20', orbitType = 'FIT', agency = 'ESOC', timeSystem = 'GPS', fileType = 'M', sats }) {
  const epochs = sats[0].epochs.length;
  const [y, mo, d, h, mi, s] = start;
  const lines = [`#d${flag}${String(y).padStart(4)} ${String(mo).padStart(2)} ${String(d).padStart(2)} ${String(h).padStart(2)} ${String(mi).padStart(2)} ${s.toFixed(8).padStart(11)} ${String(epochs).padStart(7)} d+D   ${coordinateSystem.padEnd(5)} ${orbitType.padEnd(3)} ${agency.padStart(4)}`,
    `## 2390 ${(0).toFixed(8).padStart(15)} ${interval.toFixed(8).padStart(14)} 61324 ${(0).toFixed(13).padStart(15)}`];
  const ids = sats.map((x) => x.id);
  const idLines = Math.max(5, Math.ceil(ids.length / 17));
  for (let k = 0; k < idLines; ++k) {
    const chunk = ids.slice(k * 17, k * 17 + 17);
    lines.push(`+ ${k === 0 ? String(ids.length).padStart(4) : '    '}   ${chunk.join('')}${'  0'.repeat(17 - chunk.length)}`);
  }
  for (let k = 0; k < idLines; ++k) lines.push(`++       ${ids.slice(k * 17, k * 17 + 17).map(() => '  5').join('')}${'  0'.repeat(17 - ids.slice(k * 17, k * 17 + 17).length)}`);
  lines.push(`%c ${fileType}  cc ${timeSystem.padEnd(3)} ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc`, '%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
    '%f  1.2500000  1.025000000  0.00000000000  0.000000000000000', '%f  0.0000000  0.000000000  0.00000000000  0.000000000000000',
    '%i    0    0    0    0      0      0      0      0         0', '%i    0    0    0    0      0      0      0      0         0',
    '/* synthetic orbits for the tests of data-source/sp3-precise-source', '/* no value in this file comes from a data centre', '/* epochs, kilometres and decimetres per second as SP3-d fixes them', '/* ');
  for (let e = 0; e < epochs; ++e) {
    const t = (((h * 3600 + mi * 60 + s) + e * interval) % 86400);
    lines.push(`*  ${String(y).padStart(4)} ${String(mo).padStart(2)} ${String(d + Math.floor(((h * 3600 + mi * 60 + s) + e * interval) / 86400)).padStart(2)} ${String(Math.floor(t / 3600)).padStart(2)} ${String(Math.floor(t / 60) % 60).padStart(2)} ${(t % 60).toFixed(8).padStart(11)}`);
    for (const sat of sats) {
      const row = sat.epochs[e];
      if (row === null) lines.push(`P${sat.id}${f(0)}${f(0)}${f(0)}${f(999999.999999)}`);
      else {
        lines.push(`P${sat.id}${f(row[0])}${f(row[1])}${f(row[2])}${f(12.345678)}`);
        if (flag === 'V' && row.length === 6) lines.push(`V${sat.id}${f(row[3] * 1e4)}${f(row[4] * 1e4)}${f(row[5] * 1e4)}${f(999999.999999)}`);
      }
    }
  }
  lines.push('EOF');
  return `${lines.join('\n')}\n`;
}
