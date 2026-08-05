import assert from "node:assert/strict";
import test from "node:test";

import {
  getProvider,
  listProviders,
  loadProviderRegistry,
  validateProviderRegistry,
} from "../src/index.mjs";

test("registry is internally valid and spans global crowdsourced plus national authority sources", () => {
  const registry = loadProviderRegistry();
  assert.deepEqual(validateProviderRegistry(registry), []);
  assert.ok(registry.providers.length >= 18);
  assert.ok(listProviders({ coverage: "global" }).length >= 6);
  assert.ok(registry.providers.filter((provider) => provider.coverage.some((item) => /^[A-Z]{2}$/.test(item))).length >= 10);
});

test("login requirements and restrictive/custom licences remain visible", () => {
  const registry = loadProviderRegistry();
  assert.ok(registry.providers.some((provider) => provider.access.loginRequired));
  assert.ok(registry.providers.some((provider) => !provider.access.loginRequired));
  assert.equal(getProvider("opencellid").access.credentialEnv, "OPENCELLID_TOKEN");
  assert.match(getProvider("opencellid").license.name, /BY-SA/);
  assert.equal(getProvider("wigle").access.loginRequired, true);
  assert.match(getProvider("acma-rrl").license.name, /ACMA/);
});

test("every provider has an official access posture, terms, licence, and verified endpoint", () => {
  for (const provider of loadProviderRegistry().providers) {
    assert.match(provider.homepage, /^https:\/\//);
    assert.match(provider.access.termsUrl, /^https:\/\//);
    assert.match(provider.license.url, /^https:\/\//);
    assert.ok(provider.license.attribution.length > 0);
    assert.match(provider.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(provider.endpoints.every((endpoint) => endpoint.url.startsWith("https://")));
  }
});
