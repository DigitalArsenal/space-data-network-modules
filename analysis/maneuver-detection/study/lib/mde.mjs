// Reading the detector's typed outputs on the host side: the report ($MDE)
// and the propagation queries ($PRW WINDOW_REQUEST). The bindings are
// generated from the standards' own schemas (flatc --ts, bundled once with
// esbuild) and each record is unpacked with them, then rendered as the plain
// objects the studies and tests read: snake_case fields, ISO 8601 times, NaN
// statistics left out. This is a client rendering; nothing travels between
// modules as JSON.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import createFlatc from 'flatc-wasm/module';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.resolve(here, '../..');
const standards = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(path.join(MODULE_DIR, 'package.json')).resolve('spacedatastandards.org/package.json'));

const includesOf = (text) => [...text.matchAll(/^\s*include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs";/gm)].map((m) => m[1]);
let bindingsPromise;
// { MDE, PRW, enums..., flatbuffers }: generated TypeScript for MDE and PRW
// (and the families they include), in flatc's memory file system, bundled.
export const bindings = () => {
  bindingsPromise ??= (async () => {
    const flatc = await createFlatc();
    const mkdir = (dir) => { try { flatc.FS.mkdir(dir); } catch { /* present */ } };
    mkdir('/schemas');
    mkdir('/ts');
    const seen = new Set();
    const add = (family) => {
      if (seen.has(family)) return;
      seen.add(family);
      const text = fs.readFileSync(path.join(standards, 'schema', family, 'main.fbs'), 'utf8');
      mkdir(`/schemas/${family}`);
      flatc.FS.writeFile(`/schemas/${family}/main.fbs`, text);
      includesOf(text).forEach(add);
    };
    for (const family of ['MDE', 'PRW']) {
      add(family);
      const rc = flatc.callMain(['--ts', '--gen-all', '--gen-object-api', '--preserve-case', '--no-warnings', '-I', '/schemas', '-o', `/ts/${family}`, `/schemas/${family}/main.fbs`]);
      if (rc !== 0) throw new Error(`flatc --ts failed for ${family}`);
    }
    const memory = {
      name: 'flatc-memory',
      setup(build) {
        build.onResolve({ filter: /^\.\.?\//, namespace: 'flatc' }, (a) => ({ path: path.posix.join(path.posix.dirname(a.importer), a.path).replace(/\.js$/, '.ts'), namespace: 'flatc' }));
        build.onResolve({ filter: /^\/ts\// }, (a) => ({ path: a.path, namespace: 'flatc' }));
        build.onLoad({ filter: /.*/, namespace: 'flatc' }, (a) => ({ contents: flatc.FS.readFile(a.path, { encoding: 'utf8' }), loader: 'ts', resolveDir: standards }));
      },
    };
    const entry = [
      "export * as flatbuffers from 'flatbuffers';",
      "export { MDE } from '/ts/MDE/MDE.ts';",
      ...['mdeDetector', 'mdeRunStatus', 'mdeObjectStatus', 'mdeTimeBasis', 'mdeComparisonMode', 'maneuverCharacterization', 'maneuverStatus']
        .map((e) => `export { ${e} } from '/ts/MDE/${e}.ts';`),
      "export { PRW } from '/ts/PRW/PRW.ts';",
    ].join('\n');
    const out = await esbuild.build({ stdin: { contents: entry, resolveDir: standards, loader: 'js' }, bundle: true, write: false, format: 'esm',
      platform: 'node', nodePaths: [path.join(standards, 'node_modules')], plugins: [memory], logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  })();
  return bindingsPromise;
};

// One record, unpacked (object API).
export async function decodeRecord(family, bytes) {
  const b = await bindings();
  const bb = new b.flatbuffers.ByteBuffer(new Uint8Array(bytes));
  return b[family][`getRootAs${family}`](bb).unpack();
}

const iso = (ms) => new Date(Number(ms)).toISOString();
const isoOr = (ms) => (Number(ms) ? iso(ms) : undefined);
const finite = (x) => (Number.isNaN(x) ? undefined : x);
const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const DETECTOR_NAME = { Crossing: 'D1', LevelShift: 'D2', RateChange: 'D3', Combined: 'C' };
// Enum values by name, from the generated bindings (set by reportOf).
let E;
const DETECTOR = (v) => DETECTOR_NAME[E.mdeDetector[v]];

function evidence(e, detector) {
  const span = [iso(e.SPAN_START_MS), iso(e.SPAN_STOP_MS)];
  const timeFrom = E.mdeTimeBasis[e.TIME_BASIS] === 'Crossing' ? 'crossing' : E.mdeTimeBasis[e.TIME_BASIS] === 'Gap' ? 'gap' : undefined;
  if (detector === 'D1') {
    return { pair: e.PAIR_INDEX, step_in_track_mps: e.STEP_IN_TRACK_M_S, step_plane_mps: e.STEP_PLANE_M_S, threshold_in_track_mps: e.THRESHOLD_IN_TRACK_M_S,
      threshold_plane_mps: e.THRESHOLD_PLANE_M_S, crossing_at_edge: e.CROSSING_AT_EDGE, span };
  }
  if (detector === 'D2') {
    const plane = prune({ plane_lambda: finite(e.PLANE_GLR_STATISTIC), plane_step_mps: finite(e.PLANE_STEP_M_S) });
    if (Number.isNaN(e.GLR_STATISTIC)) return { ...plane, sigma_mps: e.SIGMA_M_S, gap: span, time_from: timeFrom };
    return { lambda: e.GLR_STATISTIC, step_mps: e.STEP_M_S, step_sd_mps: e.STEP_SD_M_S, sigma_mps: e.SIGMA_M_S, trend_mps_per_day: e.TREND_M_S_PER_DAY,
      gap: span, old_level_set: iso(e.OLD_LEVEL_SET_MS), new_level_set: iso(e.NEW_LEVEL_SET_MS), time_from: timeFrom, ...plane };
  }
  if (detector === 'D3') {
    return { lambda: e.GLR_STATISTIC, rate_change_mps_per_day: e.RATE_CHANGE_M_S_PER_DAY, rate_change_sd: e.RATE_CHANGE_SD,
      trend_before_mps_per_day: e.TREND_BEFORE_M_S_PER_DAY, gap: span };
  }
  const [d1, d2] = e.COMPONENTS;
  return { D1: evidence(d1, 'D1'), D2: evidence(d2, 'D2'), D1_time: iso(d1.TIME_MS), D2_time: iso(d2.TIME_MS), kept: DETECTOR(e.KEPT) };
}

function event(e) {
  const detector = DETECTOR(e.DETECTOR);
  return prune({ detector, time: iso(e.TIME_MS), characterization: E.maneuverCharacterization[e.CHARACTERIZATION], in_track_mps: e.IN_TRACK_M_S, cross_track_mps: e.CROSS_TRACK_M_S,
    in_track_fired: e.IN_TRACK_FIRED, cross_track_fired: e.CROSS_TRACK_FIRED, raw_in_track_mps: e.RAW_IN_TRACK_M_S, raw_cross_track_mps: e.RAW_CROSS_TRACK_M_S,
    delta_sma_km: e.DELTA_SMA_KM, separation_km: e.SEPARATION_KM, time_from_crossing: e.TIME_FROM_CROSSING, blocks: [e.BLOCK_BEFORE, e.BLOCK_AFTER],
    evidence: evidence(e.EVIDENCE, detector), accel_change_mps2: detector === 'D3' ? e.ACCEL_CHANGE_M_S2 : undefined, mnv_id: e.MNV_ID || undefined });
}

function detectReport(r) {
  const o = r.OPTIONS;
  const run = E.mdeRunStatus[r.STATUS];
  const detectors = o ? o.DETECTORS.map(DETECTOR) : [];
  const objects = r.OBJECTS.map((x) => {
    const obj = prune({ object: x.OBJECT_KEY, norad_cat_id: x.NORAD_CAT_ID, element_sets: x.ELEMENT_SETS, frame: x.FRAME,
      status: E.mdeObjectStatus[x.STATUS] === 'Screened' ? 'screened' : E.mdeObjectStatus[x.STATUS] === 'InsufficientHistory' ? 'insufficient-history' : undefined, detail: x.DETAIL || undefined });
    if (E.mdeObjectStatus[x.STATUS] !== 'Screened') return obj;
    if (o.REPORT_PAIRS) obj.pairs = x.PAIRS.map((p) => prune({ span: [iso(p.SPAN_START_MS), iso(p.SPAN_STOP_MS)], crossing: iso(p.CROSSING_MS), crossing_at_edge: p.CROSSING_AT_EDGE,
      separation_km: p.SEPARATION_KM, delta_sma_km: p.DELTA_SMA_KM, in_track_mps: p.IN_TRACK_M_S, plane_mps: p.PLANE_M_S,
      ...(Number.isNaN(p.STEP_IN_TRACK_M_S) ? {} : { step_in_track_mps: p.STEP_IN_TRACK_M_S, step_plane_mps: p.STEP_PLANE_M_S,
        threshold_in_track_mps: p.THRESHOLD_IN_TRACK_M_S, threshold_plane_mps: p.THRESHOLD_PLANE_M_S, candidate: p.CANDIDATE }) }));
    if (o.REPORT_LEVELS) obj.levels = x.LEVELS.map((l) => ({ set: iso(l.SET_EPOCH_MS), sma_km: l.SMA_KM, level_mps: l.LEVEL_M_S, sigma_mps: l.SIGMA_M_S,
      plane_mps: [...l.PLANE_M_S], plane_sigma_mps: l.PLANE_SIGMA_M_S }));
    const raised = x.DETECTOR_EVENTS.map(event);
    obj.D1 = raised.filter((e) => e.detector === 'D1');
    obj.D2 = raised.filter((e) => e.detector === 'D2');
    if (detectors.includes('D3')) obj.D3 = raised.filter((e) => e.detector === 'D3');
    obj.events = x.EVENTS.map(event);
    return obj;
  });
  return prune({
    status: run === 'NeedsPropagation' ? 'needs-propagation' : run === 'Detected' ? 'detected' : undefined,
    queries: run === 'NeedsPropagation' ? r.QUERIES : undefined,
    duplicate_epochs: r.DUPLICATE_EPOCHS.length === 0 ? undefined : r.DUPLICATE_EPOCHS.map((d) => ({ object: d.OBJECT_KEY, epoch: iso(d.EPOCH_MS), kept_record: d.KEPT_RECORD, dropped_record: d.DROPPED_RECORD })),
    options: o ? { detectors, k: o.K, floor_in_track_mps: o.FLOOR_IN_TRACK_M_S, floor_cross_track_mps: o.FLOOR_CROSS_TRACK_M_S, median_sets: o.MEDIAN_SETS,
      scale_window_pairs: o.SCALE_WINDOW_PAIRS, grid_step_s: o.GRID_STEP_S, neighbour_sets: o.NEIGHBOUR_SETS, glr_sets: o.GLR_SETS, glr_span_days: o.GLR_SPAN_DAYS,
      glr_h: o.GLR_H, glr_floor_in_track_mps: o.GLR_FLOOR_IN_TRACK_M_S, glr_floor_plane_rad: o.GLR_FLOOR_PLANE_RAD, lt_h: o.LT_H,
      lt_floor_mps_per_day: o.LT_FLOOR_M_S_PER_DAY, lt_span_days: o.LT_SPAN_DAYS, lt_sets: o.LT_SETS, merge_hours: o.MERGE_HOURS } : undefined,
    propagator_port_id: o?.PROPAGATOR_PORT_ID || undefined,
    objects: run === 'Detected' ? objects : undefined,
    objects_screened: run === 'Detected' ? r.OBJECTS_SCREENED : undefined,
    refused_sets: r.REFUSED_SETS.length === 0 ? undefined : r.REFUSED_SETS.map((s) => prune({ object: s.OBJECT_KEY, epoch: iso(s.EPOCH_MS), set: s.SET_INDEX >= 0 ? s.SET_INDEX : undefined, reason: s.REASON })),
    detections: run === 'Detected' ? r.DETECTIONS : undefined,
  });
}

const STATUS_NAME = (s) => E.maneuverStatus[s];
function compareReport(r) {
  const mode = { NoComparison: 'none', Overlap: 'overlap', Adjacent: 'adjacent' };
  return {
    objects: r.OBJECTS.map((x) => ({
      object: x.OBJECT_KEY, versions: x.VERSIONS,
      changes: x.CHANGES.map((c) => (E.mdeComparisonMode[c.MODE] === 'WithinVersion'
        ? { within: c.WITHIN, window: [iso(c.WINDOW_START_MS), iso(c.WINDOW_STOP_MS)], delta_sma_km: c.DELTA_SMA_KM }
        : E.mdeComparisonMode[c.MODE] === 'NoComparison' ? { older: c.OLDER, newer: c.NEWER, mode: 'none', detail: c.DETAIL }
          : { older: c.OLDER, newer: c.NEWER, mode: mode[E.mdeComparisonMode[c.MODE]], window: [iso(c.WINDOW_START_MS), iso(c.WINDOW_STOP_MS)], delta_sma_km: c.DELTA_SMA_KM,
            in_track_mps: c.IN_TRACK_M_S, cross_track_mps: c.CROSS_TRACK_M_S, gap_s: c.GAP_S })),
      planned: x.PLANNED.map((p) => prune({ id: p.ID, tig: iso(p.TIG_MS), planned_mps: p.PLANNED_M_S, status: STATUS_NAME(p.STATUS),
        group: [iso(p.GROUP_START_MS), iso(p.GROUP_STOP_MS)], detail: p.DETAIL || undefined, pre: p.PRE || undefined,
        ...(p.POST ? { post: p.POST, window: [iso(p.WINDOW_START_MS), iso(p.WINDOW_STOP_MS)], modeled_delta_sma_km: p.MODELED_DELTA_SMA_KM,
          post_minus_pre_sma_km: p.POST_MINUS_PRE_SMA_KM, executed_delta_sma_km: p.EXECUTED_DELTA_SMA_KM, executed_in_track_mps: p.EXECUTED_IN_TRACK_M_S,
          executed_cross_track_mps: p.EXECUTED_CROSS_TRACK_M_S, modeled_cross_track_mps: p.MODELED_CROSS_TRACK_M_S,
          post_minus_pre_cross_track_mps: p.POST_MINUS_PRE_CROSS_TRACK_M_S } : {}) })),
    })),
    executed: r.EXECUTED_COUNT, cancelled: r.CANCELLED_COUNT, unknown: r.UNDECIDED_COUNT, unplanned_changes: r.UNPLANNED_CHANGE_COUNT,
  };
}

function scoreReport(r) {
  const s = r.SUMMARY;
  const dist = (d) => (d ? { n: d.COUNT, median: d.MEDIAN, p10: d.P10, p90: d.P90 } : null);
  const match = (m) => prune({ object: m.OBJECT_KEY, id: m.ID, time: iso(m.TIME_MS), dv_mps: m.DV_M_S, in_track_mps: m.IN_TRACK_M_S,
    ...(m.EVENT_ID ? { event: m.EVENT_ID, event_time: iso(m.EVENT_TIME_MS), time_error_s: m.TIME_ERROR_S, event_dv_mps: m.EVENT_DV_M_S,
      event_in_track_mps: m.EVENT_IN_TRACK_M_S, dv_ratio: finite(m.DV_RATIO), in_track_ratio: finite(m.IN_TRACK_RATIO) } : {}) });
  return {
    before_s: r.OPTIONS.BEFORE_S, after_s: r.OPTIONS.AFTER_S,
    summary: {
      truth: s.TRUTH, events: s.EVENTS, detected: s.DETECTED, recall: s.TRUTH ? s.RECALL : null, wilson95: s.TRUTH ? [s.WILSON95_LOW, s.WILSON95_HIGH] : null,
      by_dv: s.BY_DELTA_V.map((b) => ({ from_mps: b.FROM_M_S, to_mps: Number.isFinite(b.TO_M_S) ? b.TO_M_S : null, truth: b.TRUTH, detected: b.DETECTED,
        recall: b.TRUTH ? b.RECALL : null, wilson95: b.TRUTH ? [b.WILSON95_LOW, b.WILSON95_HIGH] : null })),
      time_error_abs_s: dist(s.TIME_ERROR_ABS_S), dv_ratio: dist(s.DV_RATIO), in_track_ratio: dist(s.IN_TRACK_RATIO), unmatched_events: s.UNMATCHED_EVENTS,
      explained: s.EXPLAINED, false_alarms: s.FALSE_ALARMS, object_years: s.OBJECT_YEARS,
      false_alarms_per_object_year: Number.isNaN(s.FALSE_ALARMS_PER_OBJECT_YEAR) ? null : s.FALSE_ALARMS_PER_OBJECT_YEAR,
    },
    matches: r.MATCHES.map(match),
    missed: r.MISSED.map(match),
    unmatched: r.UNMATCHED.map((u) => ({ object: u.OBJECT_KEY, id: u.ID, time: iso(u.TIME_MS), dv_mps: u.DV_M_S, in_track_mps: u.IN_TRACK_M_S,
      cross_track_mps: u.CROSS_TRACK_M_S, explained: u.EXPLAINED, assessed: u.ASSESSED })),
  };
}

// The $MDE report, rendered by its arm.
export async function reportOf(bytes) {
  E = await bindings();
  const mde = await decodeRecord('MDE', bytes);
  if (mde.DETECT_REPORT) return { method: 'detect_maneuvers', ...detectReport(mde.DETECT_REPORT) };
  if (mde.COMPARE_REPORT) return { method: 'compare_ephemerides', ...compareReport(mde.COMPARE_REPORT) };
  if (mde.SCORE_REPORT) return { method: 'score_detections', ...scoreReport(mde.SCORE_REPORT) };
  throw new Error('An $MDE report with no report arm.');
}

// The $PRW WINDOW_REQUEST, as the providers read it: one query per element set.
export async function queriesOf(bytes) {
  const prw = await decodeRecord('PRW', bytes);
  const w = prw.WINDOW_REQUEST;
  if (!w) throw new Error('A $PRW with no WINDOW_REQUEST arm.');
  return {
    status: 'needs-propagation', propagator_port_id: w.PROPAGATOR_PORT_ID ?? '', neighbour_sets: w.NEIGHBOUR_SETS, answer: w.INSTRUCTIONS,
    queries: w.QUERIES.map((q) => ({ sequence: q.SEQUENCE, object: q.OBJECT_KEY, norad: q.NORAD_CAT_ID, object_id: q.OBJECT_ID ?? '', set: q.SET_INDEX,
      epoch: q.SOURCE_EPOCH?.ISO8601, start: q.START.ISO8601, stop: q.STOP.ISO8601, step_s: q.STEP_SECONDS })),
  };
}
