import { loadProviderRegistry } from "../src/provider-registry.mjs";

const registry = loadProviderRegistry();
const login = registry.providers.filter((provider) => provider.access.loginRequired).length;
const machine = registry.providers.filter((provider) => provider.endpoints.some((endpoint) => endpoint.format !== "html")).length;
console.log(`cell provider registry ${registry.registryVersion}: ${registry.providers.length} providers, ${machine} machine-readable, ${login} login-required`);
