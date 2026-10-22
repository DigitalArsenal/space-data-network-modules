// Source qualification only; no SDS serialization or solar geometry.
import assert from 'node:assert/strict';

// NOAA labels and Helioviewer DATE-OBS are UTC. Never use T_OBS/T_REC (TAI).
export function iso(value) {
  assert.equal(typeof value, 'string', 'Timestamp must be a string');
  const text = value.replace(' ', 'T');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/.exec(text);
  assert.ok(match, `Unsupported UTC timestamp ${value}`);
  dateLabel(match[1]);
  assert.ok(+match[2] < 24 && +match[3] < 60 && +match[4] < 60, `Invalid UTC timestamp ${value}`);
  return text.endsWith('Z') ? text : `${text}Z`;
}

export function dateLabel(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
  const epoch = Date.parse(`${value}T00:00:00Z`);
  assert.ok(Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0,10) === value, `Invalid UTC date ${value}`);
  return value;
}

function finite(value, name, {min = -Infinity, max = Infinity, integer = false, optional = false} = {}) {
  if (optional && value == null) return null;
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max &&
    (!integer || Number.isSafeInteger(value)), `Invalid ${name}`);
  return value;
}
const optionalText = (value, name) => {
  assert.ok(value == null || typeof value === 'string', `Invalid ${name}`);
  return value ?? null;
};
const optionalTime = value => value == null ? null : iso(value);
const integer = (value, name, optional = false) => finite(value, name, {min:0, integer:true, optional});
function location(value) {
  assert.equal(typeof value, 'string');
  const m = /^([NS])(\d{2})([EW])(\d{2,3})$/.exec(value);
  assert.ok(m && +m[2] <= 90 && +m[4] <= 180, `Invalid solar location ${value}`);
  return value;
}
function sourceRows(payload) {
  assert.ok(Array.isArray(payload), 'Expected source array');
  for (const row of payload) assert.ok(row && typeof row === 'object' && !Array.isArray(row), 'Invalid source row');
  return payload;
}

export function parseRegions(payload) {
  const seen = new Set();
  return sourceRows(payload).map(row => {
    const observedDate = dateLabel(row.observed_date);
    const region = integer(row.region, 'region');
    const key = `${observedDate}/${region}`;
    assert.ok(!seen.has(key), 'Duplicate NOAA region/day'); seen.add(key);
    // NOAA also publishes flagged tokens such as S08W0*. Keep these verbatim;
    // they cannot serve as an exact numeric location or an SRS position match.
    assert.equal(typeof row.location, 'string');
    const positionComplete = !row.location.includes('*');
    if (positionComplete) location(row.location);
    else assert.match(row.location, /^[NS][\d*]{2}[EW][\d*]{2,3}$/);
    finite(row.latitude, 'latitude', {min:-90,max:90});
    finite(row.longitude, 'longitude', {min:-180,max:180});
    finite(row.carrington_longitude, 'Carrington longitude', {min:0,max:360});
    for (const key of ['area','extent','number_spots']) integer(row[key],key,true);
    for (const key of ['spot_class','mag_class']) optionalText(row[key],key);
    // Preserve NOAA's longitude convention, nulls, and every additional field.
    return {...row, positionComplete};
  });
}

export function parseFlares(payload) {
  return sourceRows(payload).map((raw, sourceRow) => {
    const begin = iso(raw.begin_time), peak = optionalTime(raw.max_time), end = optionalTime(raw.end_time);
    for (const [key,value] of [['peak',peak],['end',end]]) {
      assert.ok(value === null || Date.parse(value) >= Date.parse(begin), `${key} precedes flare start`);
    }
    assert.ok(!peak || !end || Date.parse(peak) <= Date.parse(end), 'Flare peak follows end');
    const goesClass = optionalText(raw.max_class, 'GOES class');
    if (goesClass !== null) assert.match(goesClass, /^[ABCMX]\d+(?:\.\d+)?$/);
    return {sourceRow, begin, peak, end, goesClass,
      peakFluxWm2:finite(raw.max_xrlong,'peak X-ray flux',{min:0,optional:true}),
      fluenceJm2:finite(raw.current_int_xrlong,'X-ray fluence',{min:0,optional:true}),
      satellite:integer(raw.satellite,'satellite'), region:integer(raw.region,'region',true), raw:{...raw}};
  });
}

export function parseEvents(payload) {
  return sourceRows(payload).map((raw, sourceRow) => {
    assert.ok(typeof raw.type === 'string' && /^[A-Z]{3}$/.test(raw.type), 'Invalid event type');
    assert.ok(typeof raw.observatory === 'string' && raw.observatory.length, 'Missing event observatory');
    const begin = iso(raw.begin_datetime), peak = optionalTime(raw.max_datetime), end = optionalTime(raw.end_datetime);
    // Qualified times (A/B/U) are retained as supplied, not treated as exact bounds.
    return {sourceRow, type:raw.type, bin:integer(raw.bin,'event bin'), obsid:integer(raw.obsid,'obsid',true),
      observatory:raw.observatory, begin, peak, end,
      beginQuality:optionalText(raw.begin_quality,'begin quality'), peakQuality:optionalText(raw.max_quality,'peak quality'),
      endQuality:optionalText(raw.end_quality,'end quality'), region:integer(raw.region,'region',true),
      goesClass:raw.type === 'XRA' ? optionalText(raw.particulars1,'XRA class') : null,
      opticalImportance:raw.type === 'FLA' ? optionalText(raw.particulars1,'optical importance') : null,
      // Bin alone is not identity: keep every observer, revision, and source row.
      raw:{...raw}};
  });
}

export function parseSrs(text) {
  const issued = /:Issued: (\d{4}) (\w{3}) (\d{2}) (\d{2})(\d{2}) UTC/.exec(text);
  assert.ok(issued, 'SRS issue epoch required');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months.indexOf(issued[2]);
  assert.ok(month >= 0, 'SRS issue month');
  const issuedAt = new Date(Date.UTC(+issued[1], month, +issued[3], +issued[4], +issued[5]));
  iso(`${issued[1]}-${String(month+1).padStart(2,'0')}-${issued[3]}T${issued[4]}:${issued[5]}:00Z`);
  const valid = /I\.\s+Regions with Sunspots\.\s+Locations Valid at (\d{2})\/2400Z/.exec(text);
  assert.ok(valid, 'SRS must explicitly state the supported 24:00 position epoch');
  const observationDay = new Date(issuedAt);
  observationDay.setUTCDate(observationDay.getUTCDate() - 1);
  assert.equal(+valid[1], observationDay.getUTCDate(), 'SRS observation day must precede issue day');
  const sectionI = text.split(/I\.\s+Regions with Sunspots\./)[1]?.split(/IA\./)[0];
  const sectionIa = text.split(/IA\.\s+H-alpha Plages without Spots\./)[1]?.split(/II\./)[0];
  assert.ok(sectionI && sectionIa, 'Both SRS position sections required');
  const iaEpoch = /Locations Valid at (\d{2})\/2400Z/.exec(sectionIa);
  assert.equal(iaEpoch?.[1], valid[1], 'SRS sections must use the same epoch');
  const rows = [];
  for (const [section, body] of [['I', sectionI], ['IA', sectionIa]]) {
    let none = false;
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || /^Locations Valid at /.test(trimmed) || /^Nmbr\s+Location\s+Lo/.test(trimmed)) continue;
      if (trimmed === 'None') { assert.ok(!none, 'Repeated None'); none = true; continue; }
      const row = /^(\d+)\s+([NS]\d{2}[EW]\d{2,3})\s+(\d+)(?:\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.+))?\s*$/.exec(line.trim());
      assert.ok(row, `Unrecognized SRS row: ${line}`);
      assert.ok(section !== 'I' || row[4], 'Sunspot row requires area and class');
      assert.ok(section !== 'IA' || row[4] === undefined, 'Plage row has unexpected morphology');
      location(row[2]);
      finite(+row[3], 'SRS Carrington longitude', {min:0,max:360});
      rows.push({section, region: +row[1], location: row[2], carringtonLongitude: +row[3],
        area: row[4] === undefined ? null : +row[4], spotClass: row[5] ?? null,
        longitudinalExtent:row[6] === undefined ? null : +row[6], spotCount:row[7] === undefined ? null : +row[7],
        magneticClass: row[8]?.trim() ?? null});
    }
    assert.notEqual(rows.some(r => r.section === section), none, `SRS ${section} must state rows or None exclusively`);
  }
  assert.equal(new Set(rows.map(r => r.region)).size, rows.length, 'Duplicate SRS region');
  return {issuedAt: issuedAt.toISOString(), observationDay: observationDay.toISOString().slice(0,10),
    positionEpoch: `${issuedAt.toISOString().slice(0,10)}T00:00:00.000Z`, rows};
}

export function compareRegions(srs, rows, day) {
  dateLabel(day);
  const selected = rows.filter(r => r.observed_date === day);
  assert.equal(new Set(selected.map(r => r.region)).size, selected.length, 'Duplicate NOAA region/day');
  const comparisons = srs.rows.map(expected => {
    const actual = selected.find(r => r.region === expected.region);
    return {region: expected.region, expected: {location: expected.location, carringtonLongitude: expected.carringtonLongitude},
      actual: actual ? {location: actual.location, carringtonLongitude: actual.carrington_longitude} : null,
      matches: actual?.location === expected.location && actual?.carrington_longitude === expected.carringtonLongitude};
  });
  return {jsonObservationDay: day, expected: srs.rows.length, available: selected.length,
    matches: comparisons.filter(r => r.matches).length, comparisons,
    extraRegions: selected.filter(r => !srs.rows.some(s => s.region === r.region)).map(r => r.region)};
}

export function fitsFields(xml) {
  assert.ok(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'XML entity declarations are not accepted');
  const fits = /<fits>([\s\S]*?)<\/fits>/.exec(xml)?.[1];
  assert.ok(fits, 'JP2 must include FITS metadata');
  const names = ['DATE-OBS','DATE_OBS','CTYPE1','CTYPE2','CUNIT1','CUNIT2','CRPIX1','CRPIX2','CRVAL1','CRVAL2',
    'CDELT1','CDELT2','CROTA2','PC1_1','PC1_2','PC2_1','PC2_2','CD1_1','CD1_2','CD2_1','CD2_2',
    'RSUN_OBS','CRLN_OBS','CRLT_OBS','HGLN_OBS','DSUN_OBS','NAXIS1','NAXIS2','CADENCE','QUALITY','CONTENT',
    'TELESCOP','INSTRUME','WAVELNTH','WAVEUNIT','TIMESYS','T_OBS','T_REC'];
  const fields = Object.fromEntries(names.map(name => {
    const matches = [...fits.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
    assert.ok(matches.length <= 1, `Duplicate FITS keyword ${name}`);
    return [name, matches[0]?.[1]?.trim() ?? null];
  }));
  assert.ok(fields['DATE-OBS'] || fields.DATE_OBS, 'Observation time required');
  iso(fields['DATE-OBS'] || fields.DATE_OBS);
  if (fields['DATE-OBS'] && fields.DATE_OBS) assert.equal(iso(fields['DATE-OBS']),iso(fields.DATE_OBS),'Conflicting observation times');
  assert.ok(fields.TIMESYS === null || fields.TIMESYS === 'UTC', 'Unsupported DATE-OBS time scale');
  assert.equal(fields.CTYPE1,'HPLN-TAN'); assert.equal(fields.CTYPE2,'HPLT-TAN');
  assert.equal(fields.CUNIT1,'arcsec'); assert.equal(fields.CUNIT2,'arcsec');
  for (const key of ['CRPIX1','CRPIX2','CRVAL1','CRVAL2','CDELT1','CDELT2','RSUN_OBS','CRLN_OBS','CRLT_OBS','DSUN_OBS','NAXIS1','NAXIS2']) {
    assert.ok(fields[key] !== null && fields[key] !== '' && Number.isFinite(Number(fields[key])), `Missing/nonnumeric ${key}`);
  }
  for (const key of ['CROTA2','PC1_1','PC1_2','PC2_1','PC2_2','CD1_1','CD1_2','CD2_1','CD2_2','HGLN_OBS','CADENCE']) {
    if (fields[key] !== null) assert.ok(fields[key] !== '' && Number.isFinite(Number(fields[key])), `Nonnumeric ${key}`);
  }
  for (const prefix of ['PC','CD']) {
    const matrix = ['1_1','1_2','2_1','2_2'].map(suffix => fields[prefix+suffix]);
    assert.ok(matrix.every(v => v === null) || matrix.every(v => v !== null), `Incomplete ${prefix} orientation matrix`);
  }
  assert.ok(fields.CROTA2 !== null || fields.PC1_1 !== null || fields.CD1_1 !== null, 'Missing WCS orientation');
  for (const key of ['RSUN_OBS','DSUN_OBS','NAXIS1','NAXIS2']) assert.ok(Number(fields[key]) > 0, `Nonpositive ${key}`);
  for (const key of ['NAXIS1','NAXIS2']) assert.ok(Number.isSafeInteger(Number(fields[key])), `Invalid dimension ${key}`);
  assert.ok(Number(fields.CDELT1) !== 0 && Number(fields.CDELT2) !== 0, 'Zero WCS scale');
  return fields;
}

export function jp2Xml(bytes) {
  assert.equal(bytes.subarray(0,12).toString('hex'), '0000000c6a5020200d0a870a', 'JPEG2000 signature');
  let xml;
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length, 'Truncated JP2 box header');
    let length = bytes.readUInt32BE(offset), header = 8;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length === 1) {
      assert.ok(offset + 16 <= bytes.length, 'Truncated extended JP2 box');
      const extended = bytes.readBigUInt64BE(offset + 8);
      assert.ok(extended <= BigInt(Number.MAX_SAFE_INTEGER));
      length = Number(extended); header = 16;
    } else if (length === 0) length = bytes.length - offset;
    assert.ok(length >= header && offset + length <= bytes.length, 'Invalid JP2 box length');
    if (type === 'xml ') {
      assert.equal(xml, undefined, 'Ambiguous multiple JP2 XML boxes');
      xml = bytes.toString('utf8', offset + header, offset + length);
    }
    offset += length;
  }
  assert.ok(xml, 'No JP2 XML box');
  return xml;
}
