#!/usr/bin/env node
// Rewrites iqengine-meta.sample.json from the structure of IQEngine's SigMF index.
//
// IQEngine's recordings carry per-recording licences, or none, and the site has no
// licence of its own, so no recording's descriptive text is kept here. This file has
// the same 16 documents with the same structure (extensions, annotations, geolocation
// shapes, hardware blocks, capture lists) and the same technical values (data type,
// sample rate, centre frequency, sample counts). Authors, descriptions, (file paths are kept: they are the recordings' identifiers),
// dataset names, recorder and hardware names, annotation text and checksums are
// replaced by labelled synthetic ones. Run in place on a document set that has the
// original text:  node make-synthetic.mjs <in.json> > iqengine-meta.sample.json
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const docs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sha = (s) => createHash('sha512').update(s).digest('hex');
docs.forEach((doc, i) => {
  const n = String(i + 1).padStart(2, '0');
  const g = doc.global;
  if ('core:author' in g) g['core:author'] = `synthetic-author-${n}`;
  if ('core:description' in g) g['core:description'] = `Synthetic capture ${n}`;
  if ('core:recorder' in g) g['core:recorder'] = `synthetic-recorder-${n}`;
  if ('core:dataset' in g) g['core:dataset'] = `synthetic-dataset-${n}`;
  if ('core:hw' in g) g['core:hw'] = `synthetic receiver ${n}`;
  if ('core:sha512' in g) g['core:sha512'] = sha(`synthetic-${n}`);
  (doc.annotations ?? []).forEach((a, k) => {
    for (const key of ['core:description', 'core:comment', 'core:label']) if (key in a) a[key] = `synthetic ${key.split(':')[1]} ${n}.${k}`;
  });
});
process.stdout.write(JSON.stringify(docs));
