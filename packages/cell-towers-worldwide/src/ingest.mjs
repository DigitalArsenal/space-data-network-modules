import { getProvider } from "./provider-registry.mjs";

const FIELD_ALIASES = Object.freeze({
  radio: ["radio", "technology", "radio_type", "type", "act"],
  mcc: ["mcc", "mobile_country_code"],
  mnc: ["mnc", "mobile_network_code"],
  lac: ["lac", "location_area_code"],
  tac: ["tac", "tracking_area_code"],
  cellId: ["cell", "cellid", "cell_id", "eci", "enodeb_id", "gnodeb_id"],
  latitude: ["lat", "latitude", "y", "site_latitude"],
  longitude: ["lon", "lng", "longitude", "x", "site_longitude"],
  rangeMeters: ["range", "range_m", "accuracy", "location_accuracy"],
  samples: ["samples", "measurements"],
  updatedAt: ["updated", "updated_at", "timestamp", "last_seen"],
  createdAt: ["created", "created_at", "first_seen"],
  operator: ["operator", "operator_name", "licensee", "carrier", "owner"],
  frequencyMhz: ["frequency", "frequency_mhz", "freq_mhz", "tx_frequency"],
  siteName: ["site_name", "name", "location_name"],
  countryCode: ["country", "country_code", "iso2"],
});

function valueFrom(record, names) {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function finiteNumber(value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function integer(value) {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function normalizeRadio(value) {
  if (value === undefined) return undefined;
  const radio = String(value).trim().toUpperCase().replaceAll(" ", "_");
  const aliases = { GSM: "GSM", UMTS: "UMTS", WCDMA: "UMTS", LTE: "LTE", NR: "NR", "5G": "NR", "5G_NR": "NR", CDMA: "CDMA" };
  return aliases[radio] ?? radio;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function stableTowerId(providerId, values) {
  const nativeId = values.nativeId ?? [values.radio, values.mcc, values.mnc, values.lac ?? values.tac, values.cellId]
    .filter((value) => value !== undefined)
    .join(":");
  if (nativeId) return `${providerId}:${nativeId}`;
  return `${providerId}:geo:${fnv1a(`${values.latitude.toFixed(7)},${values.longitude.toFixed(7)},${values.frequencyMhz ?? ""}`)}`;
}

function osmTags(record) {
  if (!record?.tags) return record;
  const center = record.center ?? {};
  return {
    ...record.tags,
    native_id: `${record.type}/${record.id}`,
    latitude: record.lat ?? center.lat,
    longitude: record.lon ?? center.lon,
    operator: record.tags.operator,
    technology: record.tags["communication:mobile_phone"] ? "CELLULAR_SITE" : record.tags.communication,
  };
}

export function normalizeProviderRecord(providerId, input, { retrievedAt = new Date().toISOString() } = {}) {
  const provider = getProvider(providerId);
  const record = provider.adapter === "osm-overpass" ? osmTags(input) : input;
  const mapped = {};
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    const override = provider.fieldMap?.[canonical];
    mapped[canonical] = valueFrom(record, override ? [override, ...aliases] : aliases);
  }

  const latitude = finiteNumber(mapped.latitude);
  const longitude = finiteNumber(mapped.longitude);
  if (latitude === undefined || latitude < -90 || latitude > 90) throw new TypeError(`${providerId}: invalid latitude`);
  if (longitude === undefined || longitude < -180 || longitude > 180) throw new TypeError(`${providerId}: invalid longitude`);

  const values = {
    nativeId: valueFrom(record, [provider.fieldMap?.nativeId, "native_id", "id", "site_id", "registration_number"].filter(Boolean)),
    radio: normalizeRadio(mapped.radio),
    mcc: integer(mapped.mcc),
    mnc: integer(mapped.mnc),
    lac: integer(mapped.lac),
    tac: integer(mapped.tac),
    cellId: mapped.cellId === undefined ? undefined : String(mapped.cellId),
    latitude,
    longitude,
    rangeMeters: finiteNumber(mapped.rangeMeters),
    samples: integer(mapped.samples),
    operator: mapped.operator === undefined ? undefined : String(mapped.operator).trim(),
    frequencyMhz: finiteNumber(mapped.frequencyMhz),
    siteName: mapped.siteName === undefined ? undefined : String(mapped.siteName).trim(),
    countryCode: mapped.countryCode === undefined ? undefined : String(mapped.countryCode).trim().toUpperCase(),
  };

  return {
    id: stableTowerId(providerId, values),
    ...values,
    observedAt: mapped.updatedAt ?? mapped.createdAt ?? null,
    provenance: {
      providerId,
      authority: provider.authority,
      sourceUrl: provider.endpoints[0].url,
      retrievedAt,
      license: provider.license.name,
      licenseUrl: provider.license.url,
      attribution: provider.license.attribution,
    },
  };
}

export function parseCsv(text, { delimiter = "," } = {}) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === delimiter) { row.push(field); field = ""; }
    else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows.shift().map((header) => header.trim().replace(/^\uFEFF/, ""));
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function resolveProviderEndpoint(providerId, endpointIndex = 0) {
  const provider = getProvider(providerId);
  const endpoint = provider.endpoints[endpointIndex];
  if (!endpoint) throw new RangeError(`${providerId}: endpoint ${endpointIndex} does not exist`);
  return {
    ...endpoint,
    providerId,
    loginRequired: endpoint.loginRequired ?? provider.access.loginRequired,
    credentialEnv: provider.access.credentialEnv ?? null,
    registrationUrl: provider.access.registrationUrl ?? null,
    termsUrl: provider.access.termsUrl,
  };
}

function geoJsonRecords(payload) {
  if (payload.type !== "FeatureCollection" || !Array.isArray(payload.features)) {
    throw new TypeError("Expected a GeoJSON FeatureCollection");
  }
  return payload.features.map((feature) => {
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new TypeError("GeoJSON feature is missing point coordinates");
    }
    return {
      ...feature.properties,
      native_id: feature.id,
      longitude: coordinates[0],
      latitude: coordinates[1],
    };
  });
}

export function recordsFromPayload(providerId, payload, { endpointIndex = 0, delimiter = "," } = {}) {
  const endpoint = resolveProviderEndpoint(providerId, endpointIndex);
  if (endpoint.format === "csv") return parseCsv(String(payload), { delimiter });
  if (endpoint.format === "csv-zip") {
    if (typeof payload === "string") return parseCsv(payload, { delimiter });
    throw new TypeError(`${providerId}: decompress the ZIP in the host and pass CSV text`);
  }
  if (endpoint.format === "html") {
    throw new TypeError(`${providerId}: ${endpoint.format} is a discovery-only endpoint, not an ingest payload`);
  }
  const document = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (endpoint.format === "geojson") return geoJsonRecords(document);
  if (endpoint.format === "osm-json") {
    if (!Array.isArray(document?.elements)) throw new TypeError("Expected Overpass JSON elements");
    return document.elements;
  }
  if (endpoint.format === "json" || endpoint.format === "api-json") {
    if (Array.isArray(document)) return document;
    for (const key of ["records", "results", "data", "cells", "features"]) {
      if (Array.isArray(document?.[key])) return document[key];
    }
    throw new TypeError(`${providerId}: JSON payload has no recognized record array`);
  }
  throw new TypeError(`${providerId}: unsupported ingest format ${endpoint.format}`);
}

export function createIngestionSession(providerId, { retrievedAt, onInvalid = "throw" } = {}) {
  const seen = new Set();
  const statistics = { input: 0, emitted: 0, duplicates: 0, invalid: 0 };
  return {
    provider: getProvider(providerId),
    statistics,
    ingest(record) {
      statistics.input += 1;
      let normalized;
      try { normalized = normalizeProviderRecord(providerId, record, { retrievedAt }); }
      catch (error) {
        statistics.invalid += 1;
        if (onInvalid === "skip") return null;
        throw error;
      }
      if (seen.has(normalized.id)) { statistics.duplicates += 1; return null; }
      seen.add(normalized.id);
      statistics.emitted += 1;
      return normalized;
    },
  };
}

export function ingestRecords(providerId, records, options) {
  const session = createIngestionSession(providerId, options);
  const output = [];
  for (const record of records) {
    const normalized = session.ingest(record);
    if (normalized) output.push(normalized);
  }
  return { records: output, statistics: { ...session.statistics } };
}
