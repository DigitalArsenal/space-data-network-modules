// Typed solar records on the released SDS standards SRO, SFE and SDI (1.262.0).
// Values are copied from the parsed source or left absent (NaN / HAS_* false).
import {SRO, SROT, sroRegionKind, PVNT, pvnSourceKind, pvnLicenseClass} from '../../sds-1.262.0/SRO/main.js';
import {SFE, SFET, sfeEventKind} from '../../sds-1.262.0/SFE/main.js';
import {SDI, SDIT} from '../../sds-1.262.0/SDI/main.js';
import * as fb from '../../vendor/flatbuffers/flatbuffers.js';

export const credits = {
  noaa:'Data courtesy of NOAA Space Weather Prediction Center (US Government work, public domain).',
  sdo:'Courtesy of NASA/SDO and the AIA, EVE and HMI science teams (public domain), served by Helioviewer.'};
const num = v => v == null ? NaN : Number(v);

export function provenance(sourceId, originator, credit) {
  return new PVNT(sourceId, pvnSourceKind.Observation, originator, 'space-data-network-modules/solar-activity',
    'solar-activity data source', pvnLicenseClass.Reproducible, 'public-domain-us-government-work', credit);
}
// Reads the N/S and E/W letters of a heliographic token; no frame conversion.
export function tokenAngles(token) {
  const m = /^([NS])(\d{2})([EW])(\d{2,3})$/.exec(token ?? '');
  if (!m) return {lat:NaN, lon:NaN};
  return {lat:(m[1] === 'N' ? 1 : -1) * +m[2], lon:(m[3] === 'W' ? 1 : -1) * +m[4]};
}
const text = v => v == null || v === '' ? null : String(v);

export function regionRecord(row, srs, src) {
  const {lat, lon} = tokenAngles(row.location);
  return new SROT(row.region, 'NOAA/SWPC', srs.issuedAt, srs.observationDay, srs.positionEpoch,
    row.section === 'I' ? sroRegionKind.SUNSPOT_GROUP : sroRegionKind.PLAGE, row.location, lat, lon,
    row.carringtonLongitude, num(row.area), num(row.longitudinalExtent), row.spotCount ?? 0, row.spotCount != null,
    row.spotClass, row.magneticClass,
    provenance('https://services.swpc.noaa.gov/text/srs.txt', 'NOAA Space Weather Prediction Center', credits.noaa),
    src.cid, src.sha256, src.retrievedAt);
}

export function flareRecord(f, src) {
  return new SFET(`GOES-${f.raw.satellite}/${f.begin}`, 'xray-flares-7-day', 'GOES', `GOES-${f.raw.satellite}`,
    sfeEventKind.XRAY, 'XRA', f.begin, f.peak, f.end, null, null, null, f.goesClass, null,
    num(f.peakFluxWm2), num(f.fluenceJm2), 0.1, 0.8, f.region ?? 0, f.region != null, NaN, NaN, null, null,
    provenance('https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json', 'NOAA Space Weather Prediction Center', credits.noaa),
    src.cid, src.sha256, src.retrievedAt);
}
const kinds = {XRA:sfeEventKind.XRAY, FLA:sfeEventKind.OPTICAL, RBR:sfeEventKind.RADIO, RSP:sfeEventKind.RADIO, RNS:sfeEventKind.RADIO};
export function eventRecord(e, src) {
  return new SFET(`${e.observatory}/${e.type}/${e.bin}/${e.begin}`, 'edited_events', e.observatory, null,
    kinds[e.type] ?? sfeEventKind.CUSTOM, e.type, e.begin, e.peak, e.end, text(e.beginQuality), text(e.peakQuality),
    text(e.endQuality), e.goesClass, e.opticalImportance, NaN, NaN, NaN, NaN, e.region ?? 0, e.region != null, NaN, NaN,
    text(e.raw.status_text), e.raw.change_flag == null ? null : String(e.raw.change_flag),
    provenance('https://services.swpc.noaa.gov/json/edited_events.json', 'NOAA Space Weather Prediction Center', credits.noaa),
    src.cid, src.sha256, src.retrievedAt);
}

export function imageRecord(img, src, headerCid) {
  const f = img.fields, n = k => f[k] == null ? NaN : Number(f[k]);
  const pc = ['PC1_1','PC1_2','PC2_1','PC2_2'].map(k => f[k]);
  const quality = Number(f.QUALITY);
  const nm = f.WAVELNTH == null ? NaN : f.WAVEUNIT === 'angstrom' ? Number(f.WAVELNTH) / 10 : f.WAVEUNIT === 'nm' ? Number(f.WAVELNTH) : NaN;
  return new SDIT('SDO', f.INSTRUME ?? img.instrument, img.measurement, nm, String(img.imageId), img.requestedAt,
    img.observedAt, f['DATE-OBS'] || f.DATE_OBS, f.TIMESYS ?? 'UTC', num(img.sourceCadenceSeconds), NaN,
    src.cid, 'image/jp2', src.sha256, BigInt(img.bytes), headerCid, n('NAXIS1'), n('NAXIS2'),
    f.CTYPE1, f.CTYPE2, f.CUNIT1, f.CUNIT2, n('CRPIX1'), n('CRPIX2'), n('CRVAL1'), n('CRVAL2'), n('CDELT1'), n('CDELT2'),
    n('CROTA2'), pc.every(v => v != null) ? pc.map(Number) : [], n('RSUN_OBS'), NaN, n('DSUN_OBS'), n('CRLN_OBS'),
    n('CRLT_OBS'), n('HGLN_OBS'), NaN, Number.isFinite(quality) ? BigInt(quality) : 0n, Number.isFinite(quality),
    text(f.CONTENT), provenance(`https://api.helioviewer.org/v2/getJP2Image/?sourceId=${img.sourceId}`, 'NASA Solar Dynamics Observatory', credits.sdo),
    src.cid, src.sha256, src.retrievedAt);
}

const classes = {SRO, SFE, SDI};
export function encode(record, standard) {
  const builder = new fb.Builder(1024);
  const offset = record.pack(builder);
  builder.finish(offset, `$${standard}`);
  return Buffer.from(builder.asUint8Array());
}
export function decode(bytes, standard) {
  const bb = new fb.ByteBuffer(new Uint8Array(bytes));
  const cls = classes[standard];
  if (!cls.bufferHasIdentifier(bb)) throw new Error(`Missing $${standard} file identifier`);
  return cls[`getRootAs${standard}`](bb).unpack();
}
