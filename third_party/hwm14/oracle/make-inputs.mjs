// Deterministic oracle inputs (float32 / int32, little-endian stream).
// Usage: node oracle/make-inputs.mjs <out.bin>
// Layout: int32 nGeo, then nGeo x {int32 iyd, f32 sec, alt, glat, glon, ap2};
//         int32 nMag, then nMag x {f32 mlt, mlat, kp};
//         int32 nAp,  then nAp  x {f32 ap}.
import fs from "node:fs";

let seed = 0x2014c0de >>> 0;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const f32 = (x) => Math.fround(x);
const uni = (a, b) => f32(a + (b - a) * rnd());

const geo = [];
const push = (iyd, sec, alt, glat, glon, ap2) => geo.push([iyd | 0, f32(sec), f32(alt), f32(glat), f32(glon), f32(ap2)]);
// Structured edges: every QWM knot and the 250 km transition.
const knots = [0, 0.001, 2.5, 5, 7.5, 50, 99.99, 100, 105, 110, 113.5, 117, 123, 130, 135, 140, 147.5, 155, 177, 199.999, 200, 225, 249.999, 250, 250.001, 275, 300, 400, 450, 500, 700, 1000];
for (const alt of knots) for (const ap2 of [-1, 0, 48, 400]) push(95150, 43200, alt, -45, -85, ap2);
for (let lat = -90; lat <= 90; lat += 2.5) for (const alt of [90, 250]) push(96305, 64800, alt, lat, 30, 48);
for (const lon of [-360, -180, -179.99, -90, 0, 0.001, 90, 179.99, 180, 270, 359.99, 360, 540]) push(97075, 30000, 125, 45, lon, 30);
for (const day of [0, 1, 59, 60, 80, 172, 266, 355, 365, 366]) for (const yy of [0, 95, 99]) push(yy * 1000 + day, 75600, 200, -65, -135, 15);
for (const sec of [0, 1, 3599.5, 43200, 86399, 86400, 90000]) push(95280, sec, 350, 38, 125, 48);
for (const ap2 of [0, 2, 3, 4, 5, 6, 7, 9, 12, 15, 18, 22, 27, 32, 39, 48, 56, 67, 80, 94, 111, 132, 154, 179, 207, 236, 300, 400, 401, 1e4, 0.5, 399.9, -0.5]) push(95280, 75600, 350, 38, 125, ap2);
// Random interior.
for (let k = 0; k < 8000; k++) {
  push(Math.floor(rnd() * 100) * 1000 + 1 + Math.floor(rnd() * 366), uni(0, 86400), uni(0, 600), uni(-90, 90), uni(-180, 360), rnd() < 0.2 ? -1 : uni(0, 420));
}
const mag = [];
for (let mlat = -90; mlat <= 90; mlat += 5) for (const mlt of [0, 3, 12.5, 23.99, 24, -1]) for (const kp of [0, 2, 5, 6, 8, 9]) mag.push([f32(mlt), f32(mlat), f32(kp)]);
for (let k = 0; k < 4000; k++) mag.push([uni(-5, 30), uni(-90, 90), uni(-1, 10)]);
const aps = [];
for (let ap = -2; ap <= 420; ap += 0.25) aps.push(f32(ap));

const buf = Buffer.alloc(4 + geo.length * 24 + 4 + mag.length * 12 + 4 + aps.length * 4);
let o = 0;
const i32 = (v) => { buf.writeInt32LE(v, o); o += 4; };
const fl = (v) => { buf.writeFloatLE(v, o); o += 4; };
i32(geo.length); for (const g of geo) { i32(g[0]); for (let j = 1; j < 6; j++) fl(g[j]); }
i32(mag.length); for (const m of mag) m.forEach(fl);
i32(aps.length); aps.forEach(fl);
fs.writeFileSync(process.argv[2], buf);
console.log(`geo=${geo.length} mag=${mag.length} ap=${aps.length} bytes=${buf.length}`);
