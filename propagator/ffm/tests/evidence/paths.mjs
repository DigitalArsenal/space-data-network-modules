// Paths the FFM evidence records, with no one's home folder in them.
//
// A file in this repository is recorded relative to the folder of the file that records it, as the scorers always
// did. A file outside the repository is recorded as a label, <root>/rest: the root names the outside folder it lives
// in, and an environment variable names that folder on this machine (docs/cross-validation.md, Outside inputs).
// A label whose variable is unset, or whose root has no variable (a past checkout), resolves to nothing: the file
// is unavailable here, as it always was on any other machine.
//
//   node propagator/ffm/tests/evidence/paths.mjs --rewrite <file.json>... [--tool-output]
//
// rewrites the path strings of evidence JSON files, and only those: every string holding an absolute path under a
// home folder, or a relative path that leaves the repository, gets its paths replaced by their recorded form. Each
// rewritten file is compared with its original with the path strings masked, and the rewrite is refused unless
// nothing else differs. --tool-output adds, to a file an outside tool wrote, one provenance sentence naming the
// rewrite and the SHA-256 of the bytes the tool wrote.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// [label, environment variable (null: never resolvable here), what the folder is]
export const ROOTS = [
  ['nyx out', 'FFM_XVAL_NYX_OUT', 'the folder of the stored Nyx runs that run-nyx.mjs wrote'],
  ['gmat work', 'FFM_XVAL_GMAT_WORK', 'the GMAT work folder holding the anomalous-oxygen/ and variants/ diagnostic reports'],
  ['homebrew', 'FFM_HOMEBREW_PREFIX', 'the Homebrew prefix whose Python the Basilisk runs used'],
  ['xval', 'FFM_XVAL_TOOLS', 'the folder of the cross-validation tool installs and their outputs (gmat-R2026a, GMAT, gmat-src, gmat-work, nyx, mamba, bsk-venv, bsk-data, naif-kernels, erfa-spice, iers)'],
  ['tudat resources', 'FFM_TUDAT_RESOURCES', 'the resource folder of tudat-resources, which tudatpy reads as .tudat/resource in the home folder'],
  ['orekit authority', 'FFM_OREKIT_AUTHORITY', 'the folder holding the Orekit jars/ and orekit-data/ that OrekitReference.java and OrekitFrames.java ran with'],
  ['flatbuffers include', 'XVAL_FLATBUFFERS', 'the include/ folder of a flatbuffers checkout'],
  ['tudat source', 'FFM_TUDAT_SOURCE', 'a checkout of the Tudat source (tudat-team/tudat) that the extracted constants were read from'],
  ['past checkout', null, 'a checkout of this repository that recorded the file and no longer exists; the path after it is the file\'s place in the repository then'],
];
const HOME = /^\/(?:Users|home)\/[^/]+\//;
const labelOf = (recorded) => /^<([^>]+)>(?:\/(.*))?$/.exec(recorded);
// A recorded path that names an outside folder (the file may be unavailable on this machine).
export const isLabel = (recorded) => typeof recorded === 'string' && labelOf(recorded) !== null;

// The folder an environment variable names, or a refusal that says which variable and what it should name.
export function rootDir(label, { required = false } = {}) {
  const root = ROOTS.find(([name]) => name === label);
  if (!root) throw new Error(`Unknown path label <${label}>`);
  const [, env, what] = root;
  const value = env ? process.env[env] : null;
  if (!value && required) throw new Error(`Set ${env} to ${what}.`);
  return value ? path.resolve(value) : null;
}

// A file under a labeled outside folder on this machine, or undefined when the folder's variable is unset.
export const outsidePath = (label, rest) => { const dir = rootDir(label); return dir ? path.join(dir, rest) : undefined; };
// The option values a script needs, refused by name when neither the option nor its variable gives one.
export function requireOptions(values, names) {
  const missing = names.filter(([key]) => !values[key]);
  if (missing.length) throw new Error(missing.map(([key, how]) => `--${key} is needed: ${how}.`).join(' '));
}

// The recorded form of a path on this machine: relative to `from` inside the repository, a label outside it.
export function recordPath(file, from) {
  const absolute = path.resolve(from, file);
  if (absolute === REPO || absolute.startsWith(REPO + path.sep)) return path.relative(from, absolute);
  const named = ROOTS.filter(([, env]) => env && process.env[env]).map(([label, env]) => [label, path.resolve(process.env[env])])
    .sort((a, b) => b[1].length - a[1].length);
  for (const [label, dir] of named)
    if (absolute === dir || absolute.startsWith(dir + path.sep)) return `<${label}>${absolute === dir ? '' : `/${path.relative(dir, absolute)}`}`;
  if (HOME.test(absolute)) throw new Error(`${absolute}: an outside path with no label; set the variable of its folder (docs/cross-validation.md, Outside inputs)`);
  return path.isAbsolute(file) ? absolute : path.relative(from, absolute);
}

// A recorded path back to a path on this machine, or null when it names a folder this machine has not named.
export function resolveRecorded(recorded, from) {
  const label = labelOf(recorded);
  if (!label) return path.resolve(from, recorded);
  const dir = rootDir(label[1]);
  return dir ? path.join(dir, label[2] ?? '') : null;
}

// One-time rewrite of a path written before this convention. The folders a label stands for are those its variable
// names on this machine, plus, for the rewrite only, FFM_PATH_REWRITE_ALIASES ("label=folder;label=folder") for other
// places the same outside folder was recorded at. A relative path that leaves the repository was recorded from a
// checkout elsewhere: its tail is matched against the trailing folders of each labeled root. A checkout of this
// repository that is gone is matched against the repository's top-level folders.
const TOP = ['propagator', 'files', 'third_party', 'foundation', 'analysis', 'docs', 'scripts', 'flows', 'packages', 'tools', 'data-source'];
function rootFolders() {
  const folders = [];
  for (const [label, env] of ROOTS) if (env && process.env[env]) folders.push([label, path.resolve(process.env[env])]);
  for (const alias of (process.env.FFM_PATH_REWRITE_ALIASES ?? '').split(';').filter(Boolean)) {
    const [label, dir] = alias.split('=');
    if (!ROOTS.some(([name]) => name === label)) throw new Error(`FFM_PATH_REWRITE_ALIASES: unknown label ${label}`);
    folders.push([label, path.resolve(dir)]);
  }
  return folders.sort((a, b) => b[1].length - a[1].length);
}
function rewritePath(token, from) {
  const absolute = path.resolve(from, token);
  if (absolute === REPO || absolute.startsWith(REPO + path.sep)) return path.relative(from, absolute);
  const folders = rootFolders();
  const under = (dir) => absolute === dir || absolute.startsWith(dir + path.sep);
  for (const [label, dir] of folders) if (under(dir)) return `<${label}>${absolute === dir ? '' : `/${path.relative(dir, absolute)}`}`;
  if (!token.startsWith('/')) {
    const tail = token.replace(/^(?:\.\.\/)+/, '');
    for (const [label, dir] of folders) {
      const parts = dir.split(path.sep).filter(Boolean);
      // At least two trailing folders, so a common name (include/, out/) is never matched alone.
      for (let k = Math.min(3, parts.length); k >= Math.min(2, parts.length); k--) {
        const end = parts.slice(-k).join('/');
        if (tail === end || tail.startsWith(`${end}/`)) return `<${label}>${tail === end ? '' : `/${tail.slice(end.length + 1)}`}`;
      }
    }
  }
  const parts = absolute.split(path.sep);
  for (let i = 1; i < parts.length; i++)
    if (TOP.includes(parts[i]) && fs.existsSync(path.join(REPO, parts[i]))) return `<past checkout>/${parts.slice(i).join('/')}`;
  throw new Error(`${token}: no labeled folder contains it; set the variable of its folder (docs/cross-validation.md, Outside inputs)`);
}

// An absolute path under a home folder, or a relative path climbing at least three folders (one that may leave it).
const PATH_TOKEN = /(?:\/(?:Users|home)\/[^\s"'`<>|;,()\\]+|(?:\.\.\/){3,}[^\s"'`<>|;,()\\]+)/g;
// A home folder flattened into a file name (an SDK cache key such as flowmount-_Users_<name>_...).
const FLATTENED_HOME = /_(?:Users|home)_[A-Za-z0-9.-]+_/g;
const hasPath = (text) => new RegExp(PATH_TOKEN.source).test(text) || new RegExp(FLATTENED_HOME.source).test(text);
function rewriteString(text, from, rewrite = rewritePath) {
  return text.replace(PATH_TOKEN, (token) => {
    const absolute = path.resolve(from, token);
    // A relative path that stays in the repository is already in recorded form.
    if (!token.startsWith('/') && (absolute === REPO || absolute.startsWith(REPO + path.sep))) return token;
    return rewrite(token, from);
  }).replace(FLATTENED_HOME, '_<home>_');
}
// A value about to be written as evidence, with every path in its strings in recorded form (relative to `from`, the
// folder of the file being written). An outside path under a home folder with no label is refused.
export const recordedJson = (value, from) => (typeof value === 'string' ? rewriteString(value, from, recordPath)
  : Array.isArray(value) ? value.map((v) => recordedJson(v, from))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, recordedJson(v, from)])) : value);

// The masked comparison: the two parsed files have the same keys, arrays, numbers, booleans and nulls, and every
// string is byte for byte the same unless the original holds a path. Returns the differences found (none expected).
export function maskedDifferences(before, after, at = '') {
  if (typeof before === 'string') return typeof after === 'string' && (before === after || hasPath(before)) ? [] : [at || '/'];
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length !== before.length) return [at || '/'];
    return before.flatMap((v, i) => maskedDifferences(v, after[i], `${at}/${i}`));
  }
  if (before && typeof before === 'object') {
    if (!after || typeof after !== 'object' || Array.isArray(after)) return [at || '/'];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) => (k in before && k in after ? maskedDifferences(before[k], after[k], `${at}/${k}`) : [`${at}/${k}`]));
  }
  return Object.is(before, after) ? [] : [at || '/'];
}

// The SHA-256 a rewritten tool output declares for the bytes the tool wrote, or null. A pin recorded before the
// rewrite (another tool output that pinned this file) is checked against it.
export function writtenSha256(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('"pathRewrite"')) return null;
    return /SHA-256 of the file as the tool wrote it: ([0-9a-f]{64})\./.exec(JSON.parse(text).pathRewrite ?? '')?.[1] ?? null;
  } catch { return null; }
}

// The rewrite works on the file's text, so every byte outside a path stays as written (number formatting included).
export function rewriteFile(file, { toolOutput = false } = {}) {
  const raw = fs.readFileSync(file, 'utf8'), before = JSON.parse(raw), from = path.dirname(path.resolve(file));
  let text = rewriteString(raw, from);
  if (text === raw) return { file, changed: false, maskedDiff: 'empty' };
  if (toolOutput) {
    const sentence = `Its path strings were made relative or labeled on 2026-11-10 by propagator/ffm/tests/evidence/paths.mjs --rewrite; nothing else changed. SHA-256 of the file as the tool wrote it: ${createHash('sha256').update(raw).digest('hex')}.`;
    const end = text.lastIndexOf('}'), indent = /^\{\n( +)"/.exec(text)?.[1] ?? '';
    text = `${text.slice(0, end).replace(/\s*$/, '')},${indent ? `\n${indent}` : ''}"pathRewrite":${indent ? ' ' : ''}${JSON.stringify(sentence)}${indent ? '\n' : ''}${text.slice(end)}`;
  }
  const after = JSON.parse(text);
  if (toolOutput) delete after.pathRewrite;
  const differences = maskedDifferences(before, after);
  if (differences.length) throw new Error(`${file}: the rewrite changed something other than a path string: ${differences.slice(0, 5).join(', ')}`);
  fs.writeFileSync(file, text);
  return { file, changed: true, maskedDiff: 'empty' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] !== '--rewrite' || args.length < 2) throw new Error('usage: paths.mjs --rewrite <file.json>... [--tool-output]');
  const toolOutput = args.includes('--tool-output');
  for (const file of args.slice(1).filter((a) => a !== '--tool-output')) {
    const r = rewriteFile(file, { toolOutput });
    console.log(`${path.relative(REPO, path.resolve(file))}: ${r.changed ? 'rewritten' : 'unchanged'}; masked comparison ${r.maskedDiff}`);
  }
}
