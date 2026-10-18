// A module resolve hook: a bare import from a sibling module's script
// (propagator/ffm/catalog.mjs, analysis/gp-error-model/scripts/*.mjs) that its
// own directory cannot resolve falls back to this package's node_modules, so a
// study runs with one npm ci here. Register it before importing those scripts:
//   register(new URL('./sibling-deps.mjs', import.meta.url));
// Set SPACE_DATA_STANDARDS_ROOT too: scripts that find the standards with
// createRequire do not pass through this hook.
const here = new URL('../../package.json', import.meta.url).href;

export async function resolve(specifier, context, next) {
  const bare = /^[a-z@]/i.test(specifier) && !specifier.startsWith('node:') && !specifier.includes(':');
  if (!bare || !context.parentURL || context.parentURL.includes('/node_modules/')) return next(specifier, context);
  try {
    return await next(specifier, context);
  } catch {
    return next(specifier, { ...context, parentURL: here });
  }
}
