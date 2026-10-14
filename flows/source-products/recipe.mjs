// The recipe (version 1) of one source of sources.json: who the source is, which model answers for it, and the ages the
// $OCM carries rows at. No record travels without its source, so a source that is not in the registry has no recipe.
// A run of the flow is one source: flowConfig gives the recipe as the flow's node configuration (one ModuleConfig that
// every node reads, each module under its own prefix) and modelsFrame its models as the $ERM MODEL records of the
// `models` trigger.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encode } from '../../analysis/gp-error-model/scripts/erm-codec.mjs';

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

// The flow's node configuration for a recipe: epoch-state derive_omm reads derive.ages, gp-error-model attach_covariance
// attach.* and attribute_maneuvers attribute.*; maneuver-detection reads detect.* (none here: its defaults) and ignores the other prefixes.
export function flowConfig(recipe) {
  const { models, ages, ...rest } = recipe;
  return {
    ...(ages ? { derive: { ages } } : {}),
    attach: rest,
    attribute: { version: rest.version, source: rest.source, producer: rest.producer },
  };
}
// The recipe's models as size-prefixed $ERM MODEL records, concatenated: the bytes of the `models` trigger.
export const modelsBytes = (recipe) => Buffer.concat((recipe.models ?? []).map((m) => encode('model', m)));
