import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {sha256} from './lib/evidence-store.mjs';
import {imageTiming, cadenceAuthority} from './lib/image-evidence.mjs';
import {fitsFields, jp2Xml, iso} from './lib/source-parsers.mjs';

const fixture = new URL('./evidence/2026-10-22-freshness-R5Cpu0/',import.meta.url);
const bytes = name => fs.readFile(new URL(name,fixture));
const json = async name => JSON.parse(await bytes(name));

test('freshness capture retains 27 successful responses and two explicit JSOC failures',async () => {
  const receipts = await json('provenance.json');
  assert.equal(receipts.filter(r=>r.status===200).length,27);
  assert.equal(receipts.filter(r=>r.error).length,2);
  for (const r of receipts) {
    if (r.error) {
      assert.equal(new URL(r.url).hostname,'jsoc.stanford.edu');
      assert.equal(r.errorCode,'ERR_SSL_UNSUPPORTED_PROTOCOL');
      assert.equal(r.bytes,undefined,'No HTTP response received');
    } else {
      const body = await bytes(r.file);
      assert.equal(body.length,r.bytes,r.file);
      assert.equal(sha256(body),r.sha256,r.file);
    }
  }
  const guide = (await bytes('helioviewer-guide/user-guide.html')).toString();
  assert.ok(guide.includes('(36 seconds)') && guide.includes('(12 seconds)'));
  assert.equal(receipts.find(r=>r.source==='helioviewer-guide').url,cadenceAuthority);
});

// Authority: original DATE-OBS in the retained JP2/XML headers, independently
// transcribed below. Epochs UTC; offsets seconds, frame not applicable to time.
// Targets 17:15 and 14:15 UTC on 2026-10-22. Zero tolerance for transcription;
// <1 ms for decimal-second subtraction's binary64 rounding only. API dates are
// whole seconds, hence <1 s agreement. Helioviewer guide: AIA feed 36 s, native
// observations 12 s. HMI header CADENCE=45 s. These are bounds, not uncertainty.
test('current slots fail cadence while an explicit three-hour backfill fits all four feeds',async () => {
  const summary = await json('summary.json');
  const reference = [
    ['current','hmi-continuum','14:21:28.100',-10411.900,45],
    ['current','aia-171','16:49:09.348',-1550.652,36],
    ['current','aia-193','16:46:40.843',-1699.157,36],
    ['current','aia-304','16:47:29.128',-1650.872,36],
    ['backfill','hmi-continuum','14:14:43.100',-16.900,45],
    ['backfill','aia-171','14:14:45.349',-14.651,36],
    ['backfill','aia-193','14:15:16.843',16.843,36],
    ['backfill','aia-304','14:15:05.129',5.129,36],
  ];
  assert.equal(summary.currentTarget,'2026-10-22T17:15:00.000Z');
  assert.equal(summary.backfillTarget,'2026-10-22T14:15:00.000Z');
  for (const [mode,source,date,offset,cadence] of reference) {
    const dir = `${mode}-helioviewer-${source}`;
    const fields = fitsFields(jp2Xml(await bytes(`${dir}/image.jp2`)));
    assert.deepEqual(fields,fitsFields((await bytes(`${dir}/header.xml`)).toString()));
    assert.equal(iso(fields['DATE-OBS'] || fields.DATE_OBS),`2026-10-22T${date}Z`);
    const closest = await json(`${dir}/closest.json`);
    assert.ok(Math.abs(Date.parse(iso(closest.date))-Date.parse(`2026-10-22T${date}Z`))<1000);
    const [instrument,measurement] = source.split('-');
    const target = mode==='current' ? summary.currentTarget : summary.backfillTarget;
    const timing = imageTiming(fields,instrument.toUpperCase(),measurement,target,summary.capturedAt);
    assert.ok(Math.abs(timing.offsetSeconds-offset)<0.001);
    assert.equal(timing.sourceCadenceSeconds,cadence);
    assert.equal(timing.withinSourceCadence,mode==='backfill');
    assert.equal(timing.withinAcquisitionInterval,mode==='backfill');
    assert.ok(timing.ageAtCaptureSeconds>900,'Backfill cannot claim present-time freshness');
    if (instrument==='aia') {
      assert.equal(fields.CADENCE,null);
      assert.equal(timing.instrumentCadenceSeconds,12);
    }
  }
  assert.equal(summary.samples.length,8);
  assert.equal(summary.samples.filter(i=>i.currentDay).length,8);
  assert.equal(summary.publishedRecords,0); assert.equal(summary.cidReadBacks,0);
});

test('unknown cadence stays unverified and invalid declared cadence is rejected', () => {
  const fields = {'DATE-OBS':'2026-10-22T14:15:00',CADENCE:null};
  const args = ['unknown','unknown','2026-10-22T14:15:00Z','2026-10-22T17:15:00Z'];
  assert.equal(imageTiming(fields,...args).withinSourceCadence,null);
  for (const CADENCE of ['',0,-1,'NaN']) assert.throws(()=>imageTiming({...fields,CADENCE},...args));
});
