/**
 * Cross-provider deconfliction — the reference semantics.
 *
 * OWNER DIRECTIVE 2026-08-08: the aggregation module on the node grabs from ALL
 * providers and the caller chooses "how to deconflict them". This file is the
 * NORMATIVE definition of what each choice means. The WASM aggregation node
 * implements exactly this, and the parity gate compares the two against the same
 * fixtures — so a disagreement is a build failure, not a judgement call.
 *
 * Everything here is pure: reports in, merged sites out. No fetching, no clock,
 * no I/O. `ingest.mjs` produces the per-provider normalized reports this
 * consumes; `toTbsRecord()` projects a merged site onto the `$TBS` field names
 * with IDL capitalization exactly (standing owner law), which is the only
 * spelling allowed to reach the wire.
 *
 * @module cell-towers-worldwide/deconflict
 */

/**
 * Merge methods, mirroring `tbsMergeMethod` in the `$TBS` standard.
 *
 * These are capability classes, never provider names (owner law 2026-08-06);
 * which provider actually won is DATA, carried in `WINNING_PROVIDER_ID`.
 *
 * @enum {string}
 */
export const MergeMethod = Object.freeze({
  SINGLE_SOURCE: "SINGLE_SOURCE",
  HIGHEST_SAMPLE_COUNT: "HIGHEST_SAMPLE_COUNT",
  MOST_RECENT: "MOST_RECENT",
  AUTHORITY_PRECEDENCE: "AUTHORITY_PRECEDENCE",
  CENTROID: "CENTROID",
  UNSPECIFIED: "UNSPECIFIED",
});

/** Ordinal order of `tbsMergeMethod`, for the FlatBuffer enum value. */
export const MERGE_METHOD_ORDINALS = Object.freeze([
  MergeMethod.SINGLE_SOURCE,
  MergeMethod.HIGHEST_SAMPLE_COUNT,
  MergeMethod.MOST_RECENT,
  MergeMethod.AUTHORITY_PRECEDENCE,
  MergeMethod.CENTROID,
  MergeMethod.UNSPECIFIED,
]);

/** Ordinal order of `tbsRadioClass`. */
export const RADIO_CLASS_ORDINALS = Object.freeze([
  "GSM",
  "CDMA",
  "UMTS",
  "LTE",
  "NR",
  "OTHER",
  "UNKNOWN",
]);

/**
 * Default positional tolerance for geometric matching, in metres.
 *
 * Crowdsourced positions are estimates of where a transmitter probably is, not
 * surveyed coordinates; two providers describing the same mast routinely differ
 * by a few hundred metres. 250 m is deliberately conservative: too wide and
 * distinct masts on the same street collapse into one, which is a worse error
 * than leaving a duplicate visible.
 */
export const DEFAULT_POSITION_TOLERANCE_M = 250;

/**
 * Providers whose reports are administrative records rather than observations.
 *
 * Read off the registry's own `authority`/`access` metadata rather than named
 * here, so the list cannot drift from the registry.
 *
 * @param {object} provider A registry provider entry.
 * @returns {boolean}
 */
export function isAuthorityProvider(provider) {
  const mode = String(provider?.access?.mode ?? "");
  const scope = `${provider?.scope ?? ""} ${provider?.authority ?? ""}`;
  // An administration/regulator publishes a register; a crowd publishes
  // observations. The registry says which in prose, so match on the role words
  // rather than on any organisation's name.
  return (
    /regulator|administration|authority|ministry|commission|agency|register/iu.test(
      scope,
    ) && mode !== "crowdsourced"
  );
}

const EARTH_RADIUS_M = 6378137;

/**
 * Great-circle distance in metres.
 *
 * @param {{latitude: number, longitude: number}} a
 * @param {{latitude: number, longitude: number}} b
 * @returns {number}
 */
export function haversineMetres(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const lat1 = a.latitude * toRad;
  const lat2 = b.latitude * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The cross-provider identity of a report.
 *
 * Two providers describing the same cell agree on the network identifiers even
 * when they disagree on everything else, so those identifiers are the primary
 * key. A report missing them (a regulator's mast register often has no cell id)
 * falls back to geometry, handled separately by {@link groupReports}.
 *
 * @param {object} report A normalized report from `ingest.mjs`.
 * @returns {string|null} the identity key, or null when it must be matched
 *   geometrically.
 */
export function networkIdentity(report) {
  const { mcc, mnc, cellId } = report;
  if (mcc === undefined || mnc === undefined || cellId === undefined) {
    return null;
  }
  // LAC and TAC are the same slot in different generations; a provider reports
  // one or the other for a given cell, so including both in the key would
  // split a match that is really an agreement.
  const area = report.lac ?? report.tac ?? "";
  return `${report.radio ?? "UNKNOWN"}|${mcc}|${mnc}|${area}|${cellId}`;
}

/**
 * Group reports from many providers into candidate sites.
 *
 * Identifier-keyed reports group exactly. Reports without identifiers are
 * matched to the nearest existing group within tolerance, and otherwise start
 * their own — never merged into an identifier group, because a mast register
 * entry near a cell is not evidence that it IS that cell.
 *
 * @param {object[]} reports
 * @param {object} [options]
 * @param {number} [options.toleranceMetres=DEFAULT_POSITION_TOLERANCE_M]
 * @returns {object[][]} groups, in first-seen order (deterministic).
 */
export function groupReports(reports, options = {}) {
  const tolerance = options.toleranceMetres ?? DEFAULT_POSITION_TOLERANCE_M;
  const byIdentity = new Map();
  const geometric = [];
  const order = [];

  for (const report of reports) {
    const identity = networkIdentity(report);
    if (identity !== null) {
      let group = byIdentity.get(identity);
      if (!group) {
        group = [];
        byIdentity.set(identity, group);
        order.push(group);
      }
      group.push(report);
      continue;
    }
    let matched = null;
    let best = Infinity;
    for (const group of geometric) {
      const distance = haversineMetres(group[0], report);
      if (distance <= tolerance && distance < best) {
        best = distance;
        matched = group;
      }
    }
    if (matched) {
      matched.push(report);
      continue;
    }
    const group = [report];
    geometric.push(group);
    order.push(group);
  }
  return order;
}

function sampleCount(report) {
  return Number.isFinite(report.samples) ? report.samples : 0;
}

function observedAtMillis(report) {
  const value = report.observedAt;
  if (value === null || value === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    // Providers publish seconds; anything below this threshold is not a
    // plausible millisecond timestamp for a live network.
    return numeric < 1e11 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Pick the winning report of a group under a merge method.
 *
 * Ties break on provider id, ascending, so the same input always produces the
 * same output — the parity gate depends on it.
 *
 * @param {object[]} group
 * @param {string} method
 * @param {object} [context]
 * @param {(providerId: string) => boolean} [context.isAuthority]
 * @returns {object}
 */
export function selectWinner(group, method, context = {}) {
  const isAuthority = context.isAuthority ?? (() => false);
  const ranked = [...group];
  const tieBreak = (a, b) =>
    String(a.provenance.providerId).localeCompare(String(b.provenance.providerId));

  switch (method) {
    case MergeMethod.MOST_RECENT:
      ranked.sort(
        (a, b) => observedAtMillis(b) - observedAtMillis(a) || tieBreak(a, b),
      );
      break;
    case MergeMethod.AUTHORITY_PRECEDENCE:
      ranked.sort((a, b) => {
        const rank =
          (isAuthority(b.provenance.providerId) ? 1 : 0) -
          (isAuthority(a.provenance.providerId) ? 1 : 0);
        return rank || sampleCount(b) - sampleCount(a) || tieBreak(a, b);
      });
      break;
    case MergeMethod.CENTROID:
    case MergeMethod.HIGHEST_SAMPLE_COUNT:
    default:
      ranked.sort(
        (a, b) => sampleCount(b) - sampleCount(a) || tieBreak(a, b),
      );
      break;
  }
  return ranked[0];
}

/**
 * Deconflict many providers' reports into merged sites.
 *
 * @param {object[]} reports Normalized reports from any number of providers.
 * @param {object} [options]
 * @param {string} [options.method=MergeMethod.HIGHEST_SAMPLE_COUNT]
 * @param {number} [options.toleranceMetres]
 * @param {string[]} [options.providersConsulted] Every provider the module
 *   ASKED, including ones that returned nothing — absent is not zero.
 * @param {(providerId: string) => boolean} [options.isAuthority]
 * @param {string} [options.mergedAt] ISO timestamp stamped on each consensus.
 * @returns {{sites: object[], statistics: object}}
 */
export function deconflictReports(reports, options = {}) {
  const method = options.method ?? MergeMethod.HIGHEST_SAMPLE_COUNT;
  if (!MERGE_METHOD_ORDINALS.includes(method)) {
    throw new TypeError(`Unknown deconfliction method: ${method}`);
  }
  const consulted =
    options.providersConsulted ??
    Array.from(new Set(reports.map((r) => r.provenance.providerId))).sort();
  const mergedAt = options.mergedAt ?? new Date().toISOString();

  // SINGLE_SOURCE is "show me the duplicates": every report stands alone.
  const groups =
    method === MergeMethod.SINGLE_SOURCE
      ? reports.map((report) => [report])
      : groupReports(reports, options);

  const sites = groups.map((group) => {
    const winner = selectWinner(group, method, options);
    const latitude =
      method === MergeMethod.CENTROID
        ? mean(group.map((r) => r.latitude))
        : winner.latitude;
    const longitude =
      method === MergeMethod.CENTROID
        ? mean(group.map((r) => r.longitude))
        : winner.longitude;
    const spread = positionSpread(group);
    return {
      ...winner,
      latitude,
      longitude,
      // The merged site's identity is the WINNER's, so a site that keeps
      // winning keeps its id across runs and the globe does not churn.
      id: winner.id,
      sources: group.map((report) => ({
        ...report.provenance,
        nativeId: report.nativeId,
        reportedLatitude: report.latitude,
        reportedLongitude: report.longitude,
        contributed: report === winner,
      })),
      consensus: {
        method,
        providersConsulted: consulted.length,
        providersAgreeing: new Set(
          group.map((report) => report.provenance.providerId),
        ).size,
        winningProviderId: winner.provenance.providerId,
        positionSpreadMetres: spread,
        confidence: confidenceOf(group, consulted.length, spread, options),
        mergedAt,
      },
    };
  });

  return {
    sites,
    statistics: {
      reportsIn: reports.length,
      sitesOut: sites.length,
      collapsed: reports.length - sites.length,
      multiProviderSites: sites.filter(
        (site) => site.consensus.providersAgreeing > 1,
      ).length,
      providersConsulted: consulted.length,
      method,
    },
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function positionSpread(group) {
  if (group.length < 2) {
    return 0;
  }
  let worst = 0;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      worst = Math.max(worst, haversineMetres(group[i], group[j]));
    }
  }
  return worst;
}

/**
 * Confidence in a merged site, in [0, 1].
 *
 * Agreement raises it; positional disagreement lowers it. A single-source site
 * is not "wrong", it is merely uncorroborated, so it lands mid-scale rather
 * than at zero — a zero would read as "this site is not there", which is a
 * claim the data does not support.
 *
 * @param {object[]} group
 * @param {number} consultedCount
 * @param {number} spreadMetres
 * @param {object} [options]
 * @returns {number}
 */
export function confidenceOf(group, consultedCount, spreadMetres, options = {}) {
  const tolerance = options.toleranceMetres ?? DEFAULT_POSITION_TOLERANCE_M;
  const agreeing = new Set(group.map((r) => r.provenance.providerId)).size;
  const corroboration =
    consultedCount <= 1 ? 0.5 : 0.5 + 0.5 * ((agreeing - 1) / (consultedCount - 1));
  const dispersion = spreadMetres <= 0 ? 1 : Math.max(0, 1 - spreadMetres / (tolerance * 2));
  return Math.round(Math.min(1, corroboration * (0.6 + 0.4 * dispersion)) * 1000) / 1000;
}

/**
 * Project a merged site onto `$TBS` field names.
 *
 * IDL capitalization exactly (standing owner law): the internal camelCase of
 * this package is never allowed to reach the wire or a JSON mirror. Absent
 * optional values are OMITTED rather than nulled, so "the source did not say"
 * stays distinguishable from "the source said zero".
 *
 * @param {object} site A site from {@link deconflictReports}.
 * @returns {object} a `$TBS`-shaped plain object.
 */
export function toTbsRecord(site) {
  const record = {
    ID: site.id,
    RADIO: site.radio ?? "UNKNOWN",
    LATITUDE: site.latitude,
    LONGITUDE: site.longitude,
    SOURCES: site.sources.map((source) => {
      const entry = {
        PROVIDER_ID: source.providerId,
        RETRIEVED_AT: source.retrievedAt,
        LICENSE: source.license,
        CONTRIBUTED: source.contributed,
      };
      assign(entry, "AUTHORITY", source.authority);
      assign(entry, "SOURCE_URL", source.sourceUrl);
      assign(entry, "LICENSE_URL", source.licenseUrl);
      assign(entry, "ATTRIBUTION", source.attribution);
      assign(entry, "NATIVE_ID", source.nativeId);
      assign(entry, "REPORTED_LATITUDE", source.reportedLatitude);
      assign(entry, "REPORTED_LONGITUDE", source.reportedLongitude);
      return entry;
    }),
    CONSENSUS: {
      METHOD: site.consensus.method,
      PROVIDERS_CONSULTED: site.consensus.providersConsulted,
      PROVIDERS_AGREEING: site.consensus.providersAgreeing,
      WINNING_PROVIDER_ID: site.consensus.winningProviderId,
      POSITION_SPREAD_M: site.consensus.positionSpreadMetres,
      CONFIDENCE: site.consensus.confidence,
      MERGED_AT: site.consensus.mergedAt,
    },
  };
  assign(record, "NATIVE_ID", site.nativeId);
  assign(record, "MCC", site.mcc);
  assign(record, "MNC", site.mnc);
  assign(record, "LAC", site.lac);
  assign(record, "TAC", site.tac);
  assign(record, "CELL_ID", site.cellId);
  assign(record, "RANGE_M", site.rangeMeters);
  assign(record, "SAMPLES", site.samples);
  assign(record, "AVERAGE_SIGNAL_DBM", site.averageSignalDbm);
  assign(record, "FIRST_OBSERVED", site.firstObserved);
  assign(record, "LAST_OBSERVED", site.observedAt ?? undefined);
  assign(record, "OPERATOR", site.operator);
  assign(record, "FREQUENCY_MHZ", site.frequencyMhz);
  assign(record, "SITE_NAME", site.siteName);
  assign(record, "COUNTRY_CODE", site.countryCode);
  return record;
}

function assign(target, key, value) {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}
