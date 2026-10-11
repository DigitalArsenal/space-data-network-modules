// The recipe (version 1) that analysis/gp-error-model attach_covariance and attribute_maneuvers read for one source of
// sources.json: who the source is, which model answers for it, and the ages the $OCM carries rows at. No record travels
// without its source, so a source that is not in the registry has no recipe.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export const registry = readJson(here('./sources.json'));
const model = readJson(here(registry.model.file));

export const sourceIds = registry.sources.map((s) => s.id);

// `via` names the module that gave the records (default: the source's first): its plugin id is the provider on every record.
// `ages` defaults to the horizons E14 measured the model at, so the $OCM has a row, with its verdict, at each.
export function recipeFor(id, { created = new Date().toISOString(), via, ages = model.horizonsDays, extra = {} } = {}) {
  const source = registry.sources.find((s) => s.id === id);
  if (!source) throw new Error(`no source ${id} in sources.json`);
  const wiring = via ? source.via.find((w) => w.module === via) : source.via[0];
  if (!wiring) throw new Error(`${id} is not given by ${via}`);
  const provider = readJson(here(`../../${wiring.module}/plugin-manifest.json`)).pluginId;
  return {
    version: 1,
    source: {
      id: source.id,
      kind: source.kind,
      lineage: source.lineage,
      originator: source.originator,
      provider,
      licence: { ...source.licence },
      ...(source.fitClass ? { fitClass: source.fitClass } : {}),
    },
    producer: registry.flow,
    created,
    ages,
    models: [{ ...model, sources: registry.sources.filter((s) => s.ownModel).map((s) => s.id), pooled: true }],
    ...(source.realism ? { realism: source.realism } : {}),
    ...extra,
  };
}
