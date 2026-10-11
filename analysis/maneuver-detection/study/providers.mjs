// One element-set history through the detector with each plugged propagator
// (PLAN-2026-10 Q3, descriptive): the same queries answered by propagator/sgp4,
// the keplerian reference through the propagator ABI (Earth-fixed answers) and
// propagator/hpop at full force, each scored against the same truth.
//
//   node study/providers.mjs <work> --history <gp-25544.json> --truth <iss-truth.json> --variants <variants.json>
//        --from 2026-09-01 --to 2026-10-01 --providers sgp4,keplerian-reference,hpop [--environment <hpop env dir>]
import fs from 'node:fs';
import { iso, seconds } from './lib/host.mjs';
import { detectHistories, scoreVariants, printScores, writeJson, log } from './lib/run.mjs';
import { truthMnv } from './lib/nasa.mjs';

const [work, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
fs.mkdirSync(work, { recursive: true });
const from = flag('from'), to = flag('to');
const variants = JSON.parse(fs.readFileSync(flag('variants'), 'utf8'));
const truthFile = JSON.parse(fs.readFileSync(flag('truth'), 'utf8'));
const burns = truthFile.burns.filter((b) => b.tig_iso >= `${from}T00:00:00` && b.tig_iso < `${to}T00:00:00`);
const key = 'NORAD:25544';
const out = {};
for (const provider of flag('providers').split(',')) {
  const started = Date.now();
  const { sets, events } = await detectHistories([{ history: flag('history'), from, to }], variants,
    { provider, workers: 6, environment: flag('environment') });
  const scores = await scoreVariants(events, truthMnv(burns), { before_s: 6 * 3600, after_s: 36 * 3600,
    explained: truthFile.listed_events.map((e) => ({ object: key, from: iso(seconds(e.tig) - 1.5 * 86400), to: iso(seconds(e.tig) + 1.5 * 86400) })),
    assessed: truthFile.coverage.map(([a, b]) => ({ object: key, from: a, to: b })),
    spans: [{ object: key, from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z` }] });
  log(`== ${provider} (${Math.round((Date.now() - started) / 1000)} s, ${sets} sets)`);
  printScores(scores);
  out[provider] = { sets, events, scores };
}
writeJson(work, `providers-${from}-${to}.json`, out);
