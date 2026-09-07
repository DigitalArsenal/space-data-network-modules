import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipe } from '../app/recipe.js';
const recipe = () => ({ version: 1, layers: [{ id: 'a', node: 'peer', provider: 'gcat', source: 'satcat' }], stateSources: ['preferred', 'fallback'], asOf: 1000, maxAgeSeconds: 86400, overrides: { 'norad:1': { catalogLayer: 'a', stateSources: ['fallback'] } } });
test('saved recipes retain explicit source order and per-object overrides', () => {
  const value = recipe(); assert.deepEqual(validateRecipe(JSON.parse(JSON.stringify(value))), value);
});
test('rejects malformed saved configuration before rendering the editor', () => {
  for (const value of [null, [], {}, { ...recipe(), layers: [null] }, { ...recipe(), overrides: [] }, { ...recipe(), stateSources: ['a', 'a'] }, { ...recipe(), maxAgeSeconds: -1 }, { ...recipe(), asOf: 0 }]) assert.throws(() => validateRecipe(value));
  const duplicate = recipe(); duplicate.layers.push(duplicate.layers[0]); assert.throws(() => validateRecipe(duplicate));
  const missing = recipe(); missing.overrides['norad:1'].catalogLayer = 'removed'; assert.throws(() => validateRecipe(missing));
});
