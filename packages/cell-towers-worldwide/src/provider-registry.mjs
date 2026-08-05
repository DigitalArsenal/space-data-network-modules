import registryDocument from "../providers.json" with { type: "json" };

export const PROVIDER_REGISTRY_VERSION = registryDocument.registryVersion;

const ACCESS_MODES = new Set([
  "anonymous-download",
  "anonymous-api",
  "registration-token",
  "account-api",
  "interactive-public",
]);
const FORMATS = new Set(["csv", "csv-zip", "json", "geojson", "osm-json", "api-json", "html"]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateProviderRegistry(document = registryDocument) {
  const errors = [];
  if (!nonEmpty(document.registryVersion)) errors.push("registryVersion is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(document.reviewedAt ?? "")) {
    errors.push("reviewedAt must be YYYY-MM-DD");
  }
  if (!Array.isArray(document.providers) || document.providers.length === 0) {
    errors.push("providers must be a non-empty array");
    return errors;
  }

  const ids = new Set();
  for (const [index, provider] of document.providers.entries()) {
    const at = `providers[${index}]`;
    if (!/^[a-z0-9][a-z0-9-]+$/.test(provider.id ?? "")) errors.push(`${at}.id is invalid`);
    if (ids.has(provider.id)) errors.push(`${at}.id duplicates ${provider.id}`);
    ids.add(provider.id);
    for (const field of ["name", "authority", "homepage", "scope", "adapter"]) {
      if (!nonEmpty(provider[field])) errors.push(`${at}.${field} is required`);
    }
    if (!Array.isArray(provider.coverage) || provider.coverage.length === 0) {
      errors.push(`${at}.coverage must be non-empty`);
    }
    if (!ACCESS_MODES.has(provider.access?.mode)) errors.push(`${at}.access.mode is invalid`);
    if (typeof provider.access?.loginRequired !== "boolean") {
      errors.push(`${at}.access.loginRequired must be boolean`);
    }
    if (!nonEmpty(provider.access?.termsUrl)) errors.push(`${at}.access.termsUrl is required`);
    if (!nonEmpty(provider.license?.name) || !nonEmpty(provider.license?.url)) {
      errors.push(`${at}.license name and url are required (use 'provider terms' when not standardized)`);
    }
    if (!Array.isArray(provider.endpoints) || provider.endpoints.length === 0) {
      errors.push(`${at}.endpoints must be non-empty`);
    } else {
      for (const [endpointIndex, endpoint] of provider.endpoints.entries()) {
        if (!nonEmpty(endpoint.url)) errors.push(`${at}.endpoints[${endpointIndex}].url is required`);
        if (!FORMATS.has(endpoint.format)) errors.push(`${at}.endpoints[${endpointIndex}].format is invalid`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(provider.verifiedAt ?? "")) {
      errors.push(`${at}.verifiedAt must be YYYY-MM-DD`);
    }
  }
  return errors;
}

export function loadProviderRegistry() {
  const errors = validateProviderRegistry(registryDocument);
  if (errors.length) throw new Error(`Invalid cell provider registry:\n${errors.join("\n")}`);
  return structuredClone(registryDocument);
}

export function listProviders({ coverage, loginRequired, adapter } = {}) {
  return loadProviderRegistry().providers.filter((provider) => {
    if (coverage && !provider.coverage.includes(coverage)) return false;
    if (loginRequired !== undefined && provider.access.loginRequired !== loginRequired) return false;
    return !adapter || provider.adapter === adapter;
  });
}

export function getProvider(id) {
  const provider = loadProviderRegistry().providers.find((candidate) => candidate.id === id);
  if (!provider) throw new RangeError(`Unknown cell-tower provider: ${id}`);
  return provider;
}
