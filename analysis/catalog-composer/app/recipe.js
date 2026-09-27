import { validateDecisions } from './review.js';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 8192;
const ids = value => Array.isArray(value) && value.length <= 64 && value.every(text) && new Set(value).size === value.length;
export function validateRecipe(value) {
  if (!plain(value) || ![1, 2].includes(value.version) || !Array.isArray(value.layers) || value.layers.length > 16 ||
      !ids(value.stateSources) || !plain(value.overrides) || (value.version === 1 && (!Number.isFinite(value.maxAgeSeconds) || value.maxAgeSeconds < 0)) ||
      !Number.isFinite(value.asOf) || value.asOf <= 0) throw new Error('This is not a valid Catalog Editor recipe.');
  if (value.matching !== undefined && (!plain(value.matching) || ['positionToleranceKm','velocityToleranceKmS','finiteDifferenceToleranceKmS','minimumSpanSeconds'].some(key => !Number.isFinite(value.matching[key]) || value.matching[key] <= 0))) throw new Error('Matching thresholds must be positive finite numbers.');
  if (value.identityDecisions !== undefined) validateDecisions(value.identityDecisions);
  const layerIds = new Set();
  for (const layer of value.layers) {
    if (!plain(layer) || !['id', 'node', 'provider', 'source'].every(key => text(layer[key])) || layerIds.has(layer.id)) throw new Error('Each catalog layer needs a unique ID and a node, provider and source.');
    layerIds.add(layer.id);
  }
  for (const [key, choice] of Object.entries(value.overrides)) {
    if (!text(key) || !plain(choice) || choice.catalogLayer && !layerIds.has(choice.catalogLayer) || choice.stateSources && !ids(choice.stateSources)) throw new Error('An object override refers to an invalid source.');
  }
  return value;
}
