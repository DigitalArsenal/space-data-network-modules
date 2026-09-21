import { setupMatching } from './matching.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { callHost } from './bridge.js';
import { sourceLanes, loadCatalog } from './catalog-data.js';
import { validateRecipe } from './recipe.js';
import { coverageDesignators, primarySources } from './coverage.js';
import { catalogSearch } from './search-runtime.js';

const $ = (id) => document.getElementById(id), encoder = new TextEncoder(), decoder = new TextDecoder();
let discovering = false, overlapsOnly = false;
let coverage = new Map(), coverageLoading = new Set(), coverageErrors = new Map();
let search;
let module, available = [], loaded = new Map(), report = [], catalog, page = 1, editedKey, busy = false;
let recipe = { version: 2, layers: [], stateSources: [], asOf: Math.floor(Date.now() / 1000), overrides: {} };
function status(message, error = false, loading = false) {
  $('status').replaceChildren(); $('status').className = error ? 'error' : '';
  if (loading) { const spinner = document.createElement('span'); spinner.className = 'loading'; $('status').append(spinner); }
  $('status').append(document.createTextNode(message));
}
function option(value, label) { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
const label = (source) => `${source.provider} · ${source.source}`;
const layerLabel = (id) => { const layer = recipe.layers.find(l => l.id === id); return layer ? label(layer) : id; };
const stateLabel = (id) => { const source = primarySources(available).find(l => l.id === id); return source ? label(source) : id; };
function persist() {
  void callHost('configuration.write', { value: recipe }).catch(e => status(`Could not save the recipe: ${e.message}`, true));
}
function changed() { catalog = null; $('download').disabled = true; persist(); }
function renderLayers() {
  $('layers').replaceChildren();
  recipe.layers.forEach((layer, index) => {
    const li = document.createElement('li'); li.className = 'row';
    const title = document.createElement('div'); title.className = 'layer-name'; title.textContent = `${index + 1}. ${label(layer)}`;
    const controls = document.createElement('div'); controls.className = 'actions';
    for (const [title, delta] of [['Move up', -1], ['Move down', 1]]) {
      const button = document.createElement('button'); button.textContent = title; button.disabled = busy || index + delta < 0 || index + delta >= recipe.layers.length;
      button.onclick = () => { [recipe.layers[index], recipe.layers[index + delta]] = [recipe.layers[index + delta], recipe.layers[index]]; changed(); renderLayers(); }; controls.append(button);
    }
    const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.disabled = busy;
    remove.onclick = () => { recipe.layers.splice(index, 1); loaded.delete(layer.id); for (const choice of Object.values(recipe.overrides)) if (choice.catalogLayer === layer.id) delete choice.catalogLayer; changed(); renderLayers(); }; controls.append(remove); li.append(title, controls); $('layers').append(li);
  });
  $('source-picker').replaceChildren(option('', discovering ? 'Finding catalogs…' : available.some(l => l.schema === 'CAT') ? 'Choose a catalog' : 'No catalogs discovered yet'));
  $('refresh-sources').disabled = busy || discovering;
  $('refresh-sources').textContent = discovering ? 'Refreshing…' : 'Refresh sources';
  for (const source of available.filter(l => l.schema === 'CAT' && !recipe.layers.some(r => r.id === l.id))) $('source-picker').append(option(source.id, label(source)));
  $('state-options').replaceChildren();
  const stateSources = primarySources(available);
  for (const source of stateSources) {
    const card = document.createElement('div'); card.className = 'source-coverage';
    const labelElement = document.createElement('label'); labelElement.className = 'check small';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = recipe.stateSources.includes(source.id); input.disabled = busy || !source.published || coverageLoading.has(source.id);
    input.onchange = async () => {
      if (input.checked && !coverage.has(source.id)) await loadCoverage(source);
      recipe.stateSources = recipe.stateSources.filter(id => id !== source.id);
      if (input.checked && coverage.has(source.id)) recipe.stateSources.push(source.id);
      for (const choice of Object.values(recipe.overrides)) if (choice.stateSources) choice.stateSources = choice.stateSources.filter(id => recipe.stateSources.includes(id));
      changed(); renderLayers(); if (report.length) void compose(false);
    };
    labelElement.append(input, document.createTextNode(label(source))); card.append(labelElement);
    const info = document.createElement('div'); info.className = 'small muted coverage-info';
    const declared = coverage.get(source.id);
    let overlaps = 0;
    if (declared) for (const id of declared.objects) if (recipe.stateSources.some(other => other !== source.id && coverage.get(other)?.objectSet.has(id))) ++overlaps;
    info.textContent = coverageLoading.has(source.id) ? 'Loading declared object coverage…' : coverageErrors.get(source.id) || (declared ? `${declared.objects.length.toLocaleString()} objects · ${overlaps.toLocaleString()} overlapping${declared.unresolved ? ` · ${declared.unresolved} missing designators` : ''}` : source.published ? 'Object coverage available' : 'Object coverage not published');
    if (overlaps) card.classList.add('coverage-overlap');
    card.append(info);
    if (source.published && !declared && !coverageLoading.has(source.id)) { const inspect = document.createElement('button'); inspect.className = 'small'; inspect.textContent = 'Inspect coverage'; inspect.onclick = () => loadCoverage(source); card.append(inspect); }
    $('state-options').append(card);
  }
  if (!stateSources.length) $('state-options').textContent = 'No orbital providers discovered yet.';
  for (const id of ['import', 'add', 'source-picker']) $(id).disabled = busy;
  $('compose').disabled = busy || !module || !recipe.layers.length;
}
function render() {
  let result;
  try { result = search?.page($('search').value, page, 100, overlapsOnly) ?? {total:0,page:1,pages:1,indices:[]}; }
  catch (error) { status(error.message,true); return; }
  const {total,pages,indices} = result; page = result.page;
  $('rows').replaceChildren();
  for (const index of indices) {
    const row = report[index];
    const tr = document.createElement('tr'); tr.tabIndex = 0; tr.onclick = () => edit(row); tr.onkeydown = (event) => { if (event.key === 'Enter') edit(row); };
    const cells = [row.name || row.key, layerLabel(row.selectedLayer), ['identity-conflict', 'missing-designator'].includes(row.status) ? 'Review conflict' : (row.internationalDesignator || 'Missing international designator'),
      row.state?.status === 'overlap' ? `${row.state.sources.length} sources overlap · Review` : row.state?.sourceId ? stateLabel(row.state.sourceId) : 'No declared source'];
    cells.forEach((text, i) => { const td = document.createElement('td'); td.textContent = text; if (i === 2 && ['identity-conflict', 'missing-designator'].includes(row.status)) td.className = 'conflict'; if (i === 3 && row.state?.status === 'overlap') td.className = 'conflict'; tr.append(td); }); $('rows').append(tr);
  }
  $('empty').hidden = total > 0;
  $('empty').textContent = report.length ? 'No matching objects.' : recipe.layers.length ? 'Load the selected catalogs to see their objects.' : 'Add a catalog layer to begin.';
  $('count').textContent = `${total.toLocaleString()} objects`;
  $('page-info').textContent = `Page ${page} of ${pages}`;
  $('previous').disabled = page <= 1; $('next').disabled = page >= pages;
}
async function compose(refresh = true) {
  if (busy || !module || !recipe.layers.length) return;
  busy = true; $('compose').disabled = true; $('add').disabled = true; renderLayers();
  const controller = new AbortController();
  try {
    status('Loading catalogs…', false, true);
    if (refresh) { recipe.asOf = Math.floor(Date.now() / 1000); await refreshSources(); }
    if (refresh) for (const layer of recipe.layers) {
      const source = available.find(item => item.id === layer.id);
      if (!source?.manifest) throw new Error(`${layer.source} has no published edition available.`);
      layer.manifest = source.manifest;
      const result = await loadCatalog(layer, { signal: controller.signal, onRetry: (attempt, seconds) => status(`${layer.source}: retry ${attempt} in ${seconds}s`, false, true), onProgress: (count, total) => status(`${layer.source}: ${count.toLocaleString()}${Number.isFinite(total) ? ` / ${total.toLocaleString()}` : ''} records`, false, true) });
      if (!result.count) throw new Error(`${layer.source} has no catalog records in this snapshot.`);
      loaded.set(layer.id, result); layer.head = result.head; layer.contentSha256 = result.contentSha256;
    }
    if (recipe.layers.some(l => !loaded.has(l.id))) throw new Error('Load every catalog layer first.');
    for (const id of recipe.stateSources) if (!coverage.has(id)) {
      const source = primarySources(available).find(source => source.id === id);
      if (!source?.published) throw new Error('A selected source no longer publishes its object coverage.');
      await loadCoverage(source);
      if (!coverage.has(id)) throw new Error(coverageErrors.get(id) || 'Source coverage could not be loaded.');
    }
    const invocation = { ...recipe, coverage: recipe.stateSources.map(id => ({ sourceId: id, head: coverage.get(id).head, objects: coverage.get(id).objects })) };
    const payload = encoder.encode(JSON.stringify(invocation));
    const response = await module.invoke({ methodId: 'compose', inputs: [
      { portId: 'recipe', typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length }, payload },
      ...recipe.layers.map(layer => ({ portId: 'catalogs', typeRef: { schemaName: 'CAT.fbs', fileIdentifier: '$CAT', rootTypeName: 'CAT' }, payload: loaded.get(layer.id).stream })),
    ] });
    if (response.statusCode !== 0) throw new Error(response.errorMessage || 'Catalog composition failed.');
    const result = JSON.parse(decoder.decode(response.outputs.find(f => f.portId === 'report').payload));
    status('Indexing catalogs…',false,true);
    search ??= await catalogSearch();
    await search.replace(result.objects);
    report = result.objects; catalog = response.outputs.find(f => f.portId === 'catalog')?.payload; page = 1;
    $('download').disabled = !catalog?.length || report.some(row => ['identity-conflict', 'missing-designator'].includes(row.status));
    status(`${result.objectCount.toLocaleString()} objects · ${report.filter(row => row.state?.status === 'overlap').length.toLocaleString()} source overlaps${result.identityConflicts ? ` · ${report.filter(row => ['identity-conflict', 'missing-designator'].includes(row.status)).length} identity conflicts need review` : ''}`);
    persist(); render();
  } catch (error) { catalog = null; $('download').disabled = true; status(error.message, true); }
  finally { controller.abort(); busy = false; $('compose').disabled = false; $('add').disabled = false; renderLayers(); }
}
function edit(row) {
  if (busy) return; editedKey = row.key; $('object-title').textContent = row.name || row.key;
  $('catalog-choice').replaceChildren(option('', 'Use layer priority'));
  for (const candidate of row.candidates) $('catalog-choice').append(option(candidate.layer, `${layerLabel(candidate.layer)} · ${candidate.name}`));
  $('catalog-choice').value = recipe.overrides[row.key]?.catalogLayer || '';
  $('state-choice').replaceChildren(option('', row.state?.sources?.length > 1 ? 'Choose a source for this object' : 'Use declared coverage'));
  for (const id of row.state?.sources ?? []) $('state-choice').append(option(id, stateLabel(id)));
  $('state-choice').value = recipe.overrides[row.key]?.stateSources?.[0] || '';
  $('object-provenance').textContent = row.candidates.map(c => `${layerLabel(c.layer)}: ${c.nativeKey || c.designator || row.key}`).join(' · ');
  $('object-editor').showModal();
}
function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function loadCoverage(source) {
  if (coverageLoading.has(source.id)) return;
  coverageLoading.add(source.id); coverageErrors.delete(source.id); renderLayers();
  try {
    const result = await loadCatalog(source.catalog);
    const declared = coverageDesignators(result.stream);
    coverage.set(source.id, { ...declared, objectSet: new Set(declared.objects), head: result.snapshot });
  } catch (error) { coverageErrors.set(source.id, error.message); }
  finally { coverageLoading.delete(source.id); renderLayers(); }
}
async function refreshSources() {
  if (discovering) return;
  discovering = true; renderLayers();
  try { available = await sourceLanes();
    for (const source of primarySources(available)) if (coverage.get(source.id)?.head !== source.catalog?.manifest) coverage.delete(source.id);
  }
  catch (error) { status(error.message, true); }
  finally { discovering = false; renderLayers(); }
}
setupMatching({ getModule:()=>module, getRecipe:()=>recipe, changed, status });
$('review-overlaps').onclick = () => { overlapsOnly = !overlapsOnly; $('review-overlaps').setAttribute('aria-pressed', String(overlapsOnly)); $('review-overlaps').textContent = overlapsOnly ? 'Show all objects' : 'Review overlaps'; page = 1; render(); };
$('refresh-sources').onclick = () => refreshSources();
$('add').onclick = () => { const source = available.find(l => l.id === $('source-picker').value); if (!source || recipe.layers.length >= 16) return; recipe.layers.push({ ...source }); changed(); renderLayers(); render(); };

$('compose').onclick = () => compose(); $('search').oninput = () => { page = 1; render(); };
$('previous').onclick = () => { --page; render(); }; $('next').onclick = () => { ++page; render(); };
$('close-object').onclick = () => $('object-editor').close();
$('object-form').onsubmit = (event) => { event.preventDefault(); const choice = {};
  if ($('catalog-choice').value) choice.catalogLayer = $('catalog-choice').value;
  if ($('state-choice').value) choice.stateSources = [$('state-choice').value];
  recipe.overrides[editedKey] = choice; changed(); $('object-editor').close(); void compose(false);
};
$('reset-object').onclick = () => { delete recipe.overrides[editedKey]; changed(); $('object-editor').close(); void compose(false); };
$('export').onclick = () => download(JSON.stringify(recipe, null, 2), 'catalog-recipe.json', 'application/json');
$('download').onclick = () => { if (catalog) download(catalog, 'composite.cat', 'application/x-flatbuffers'); };
$('import').onclick = () => $('recipe-file').click();
$('recipe-file').onchange = async () => { try {
  if (busy) return;
  const file = $('recipe-file').files[0]; if (!file || file.size > 1024 * 1024) throw new Error('Choose a recipe smaller than 1 MiB.');
  const value = validateRecipe(JSON.parse(await file.text()));
  if (value.version !== 2) throw new Error('This recipe uses legacy identifiers. Add its catalogs again and review choices by international designator.');
  recipe = value; loaded.clear(); report = []; search?.clear(); changed(); renderLayers(); render(); status('Recipe imported. Load its catalog snapshots to continue.');
} catch (error) { status(error.message, true); } };

try {
  busy = true; renderLayers(); status('Loading', false, true);
  const artifact = await callHost('module');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', artifact.bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== '__MODULE_HASH__') throw new Error('The installed module does not match this editor.');
  module = await createBrowserModuleHarness({ wasmSource: artifact.bytes, manifest: __PLUGIN_MANIFEST__, surface: 'direct' });
  const saved = await callHost('configuration.read');
  if (saved != null) { recipe = validateRecipe(saved); if (recipe.version === 1) { recipe = { ...recipe, version: 2, stateSources: [], legacyOverrides: recipe.overrides, overrides: {} }; delete recipe.maxAgeSeconds; status('Catalog layers retained. Review object choices using international designators.', false); } }
  await refreshSources(); renderLayers(); render();
  if (!$('status').classList.contains('error')) status('Ready');
} catch (error) { status(error.message, true); }
finally { busy = false; renderLayers(); render(); }
