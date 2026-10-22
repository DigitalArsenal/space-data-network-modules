// Image/source-time qualification only; no solar geometry or SDS records.
import assert from 'node:assert/strict';
import {fitsFields, jp2Xml, iso} from './source-parsers.mjs';
import {sha256} from './evidence-store.mjs';

export const api = (method, params = {}) => `https://api.helioviewer.org/v2/${method}/?${new URLSearchParams(params)}`;
export const channels = [['HMI','continuum'],['AIA','171'],['AIA','193'],['AIA','304']];
export const cadenceAuthority = 'https://helioviewer-project.github.io/user_guide/';

export function imageTiming(fields, instrument, measurement, target, capturedAt) {
  const observedAt = iso(fields['DATE-OBS'] || fields.DATE_OBS);
  const offsetSeconds = (Date.parse(observedAt) - Date.parse(iso(target))) / 1000;
  const headerCadenceSeconds = fields.CADENCE == null ? null : Number(fields.CADENCE);
  if (headerCadenceSeconds !== null) assert.ok(Number.isFinite(headerCadenceSeconds) && headerCadenceSeconds > 0);
  // The provider's guide explicitly distinguishes 12 s AIA observations from
  // its 36 s browse feed. An absent FITS keyword stays absent in `fields`.
  const aia = instrument === 'AIA' && ['171','193','304'].includes(measurement);
  const sourceCadenceSeconds = aia ? 36 : headerCadenceSeconds;
  return {observedAt, offsetSeconds, headerCadenceSeconds, sourceCadenceSeconds,
    instrumentCadenceSeconds:aia ? 12 : headerCadenceSeconds,
    cadenceAuthority:aia ? cadenceAuthority : 'Embedded JP2 FITS CADENCE',
    ageAtCaptureSeconds:(Date.parse(iso(capturedAt)) - Date.parse(observedAt)) / 1000,
    withinSourceCadence:sourceCadenceSeconds === null ? null : Math.abs(offsetSeconds) <= sourceCadenceSeconds,
    withinAcquisitionInterval:Math.abs(offsetSeconds) <= 900};
}

export async function captureImage(get, {catalog, instrument, measurement, target, capturedAt, prefix = ''}) {
  const source = `${prefix}helioviewer-${instrument.toLowerCase()}-${measurement}`;
  const sourceId = catalog.SDO?.[instrument]?.[measurement]?.sourceId;
  assert.ok(Number.isInteger(sourceId), `Missing SDO ${instrument} ${measurement}`);
  const closest = JSON.parse(await get(source,'closest.json',api('getClosestImage',{date:target, sourceId})));
  const apiHeader = fitsFields((await get(source,'header.xml',api('getJP2Header',{id:closest.id}))).toString('utf8'));
  const jp2 = await get(source,'image.jp2',api('getJP2Image',{date:iso(closest.date), sourceId}),16*1024*1024);
  const fields = fitsFields(jp2Xml(jp2));
  assert.deepEqual(fields,apiHeader,'Downloaded image WCS must equal metadata for the selected image ID');
  const timing = imageTiming(fields,instrument,measurement,target,capturedAt);
  const metadataTimeDeltaMs = Math.abs(Date.parse(timing.observedAt) - Date.parse(iso(closest.date)));
  assert.ok(metadataTimeDeltaMs < 1000,'Image date must match DB time at its one-second precision');
  return {instrument, measurement, sourceId, imageId:closest.id, requestedAt:target, ...timing,
    currentDay:timing.observedAt.slice(0,10) === capturedAt.slice(0,10), metadataTimeDeltaMs,
    bytes:jp2.length, sha256:sha256(jp2), fields};
}
