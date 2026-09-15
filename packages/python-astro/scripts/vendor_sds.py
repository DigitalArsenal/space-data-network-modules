#!/usr/bin/env python3
"""Vendor immutable SDS Python output and generate module invoke bindings.

Uses only the selected git revision, never an SDS working tree. Generated imports
are rewritten mechanically into this distribution's private namespace. No schema
is authored or altered here. Run --check to compare byte-for-byte without writes.
"""
from __future__ import annotations

import argparse
import ast
from collections import defaultdict
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

PACKAGE = Path(__file__).resolve().parents[1]
MODULES = PACKAGE.parents[1]
SDS_REVISION = "b76da41467e260c83b3432ba7f34a1eb05cc7ac7"
SDS_VERSION = "1.217.0"
FLATC_VERSION = "26.1.32"
FAMILIES = "PIV TAB OMM CAT REC RFM CRD MEM OCM ODR TDM TRH CDM CSM ACW EVL PCE EOP FRM OEM LMO LMS TIM NCD".split()
SDS_NAMESPACE = "spacedatanetwork_astro.sds"
INVOKE_NAMESPACE = "spacedatanetwork_astro.invoke"
EXTERNAL_IMPORTS = {"flatbuffers", "typing", "numpy", "sys", "struct", "cryptography"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def git_bytes(repository: Path, revision: str, path: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repository), "show", f"{revision}:{path}"])


def source_tree(repository: Path, revision: str) -> dict[str, bytes]:
    archive = subprocess.check_output(["git", "-C", str(repository), "archive", revision, "lib/py"])
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
        return {item.name.removeprefix("lib/py/"): bundle.extractfile(item).read()
                for item in bundle.getmembers() if item.isfile()}


def import_modules(tree: ast.AST):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield node, [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            yield node, [node.module]


def rewrite_sds(name: str, data: bytes, sources: dict[str, bytes], index: dict[str, list[str]]):
    """Rewrite imports while preserving generated expressions and local aliases."""
    source = data.decode("utf-8")
    replacements = []
    dependencies = set()
    missing = []
    for node, modules in import_modules(ast.parse(source)):
        rewritten = []
        changed = False
        for module in modules:
            if module.split(".")[0] in EXTERNAL_IMPORTS:
                rewritten.append(None)
                continue
            candidate = str(PurePosixPath(name).parent / (module.replace(".", "/") + ".py"))
            if candidate not in sources:
                options = index.get(module, [])
                if len(options) == 1:
                    candidate = options[0]
                else:
                    missing.append({"file": name, "module": module, "candidates": options})
                    rewritten.append(None)
                    continue
            dependencies.add(candidate)
            rewritten.append(SDS_NAMESPACE + "." + candidate[:-3].replace("/", "."))
            changed = True
        if not changed:
            continue
        if isinstance(node, ast.Import):
            parts = []
            for alias, module in zip(node.names, rewritten):
                if module:
                    # Bare generator imports intentionally remain module objects.
                    parts.append(f"import {module} as {alias.asname or alias.name}")
                else:
                    parts.append("import " + alias.name + (f" as {alias.asname}" if alias.asname else ""))
            text = "; ".join(parts)
        else:
            text = "from " + (rewritten[0] or node.module) + " import " + ", ".join(
                alias.name + (f" as {alias.asname}" if alias.asname else "") for alias in node.names)
        replacements.append((node.lineno - 1, node.end_lineno - 1, node.col_offset, node.end_col_offset, text))
    lines = source.splitlines(keepends=True)
    for first, last, start, end, text in sorted(replacements, reverse=True):
        lines[first:last + 1] = [lines[first][:start] + text + lines[last][end:]]
    return "".join(lines).encode(), dependencies, missing


def vendor_sources(sources: dict[str, bytes]):
    index = defaultdict(list)
    for name in sorted(sources):
        if name.endswith(".py"):
            index[PurePosixPath(name).stem].append(name)
    # All types in requested families are public; recursively add imported types.
    pending = {name for name in sources if name.endswith(".py") and name.split("/")[0] in FAMILIES}
    result = {}
    missing = []
    while pending:
        name = min(pending)
        pending.remove(name)
        if name in result:
            continue
        data, dependencies, failures = rewrite_sds(name, sources[name], sources, index)
        result[name] = data
        missing.extend(failures)
        pending.update(dependencies - result.keys())
    return result, sorted(missing, key=lambda item: (item["file"], item["module"]))


# Flatc-wasm is the compiler used by the SDK. Every schema uses a fresh instance:
# flatc's process-global parser/options state must not leak between entrypoints.
NODE_GENERATOR = r"""
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const config = JSON.parse(fs.readFileSync(0, 'utf8'));
const {default:createFlatc} = await import(pathToFileURL(config.compiler).href);
const result = {};
for (const group of config.groups) {
  for (const entry of group.entries) {
    const messages = [];
    const flatc = await createFlatc({print:s=>messages.push(s), printErr:s=>messages.push(s)});
    flatc.FS.mkdir('/schemas'); flatc.FS.mkdir('/out');
    for (const [name, body] of Object.entries(group.files)) flatc.FS.writeFile('/schemas/'+name, body);
    const status = flatc.callMain(['--python','--gen-object-api','-I','/schemas','-o','/out','/schemas/'+entry]);
    if (status !== 0) throw new Error('flatc failed: '+group.id+'/'+entry+' status '+status+'\n'+messages.join('\n')); 
    function read(dir, prefix='') {
      for (const name of flatc.FS.readdir(dir).filter(n=>n!=='.'&&n!=='..').sort()) {
        const full=dir+'/'+name, rel=prefix+name;
        if (flatc.FS.isDir(flatc.FS.stat(full).mode)) read(full,rel+'/');
        else {
          const value=flatc.FS.readFile(full,{encoding:'utf8'});
          if (result[rel] !== undefined && result[rel] !== value) throw new Error('conflicting generated file '+rel);
          result[rel]=value;
        }
      }
    }
    read('/out',group.prefix || '');
  }
}
process.stdout.write(JSON.stringify(result));
"""


def generate_invoke(modules: Path):
    sdk = modules / "node_modules/space-data-module-sdk"
    flatc = modules / "node_modules/flatc-wasm"
    compiler_version = json.loads((flatc / "package.json").read_text())["version"]
    if compiler_version != FLATC_VERSION:
        raise RuntimeError(f"flatc-wasm {FLATC_VERSION} required, found {compiler_version}")
    sdk_schemas = sdk / "schemas/orbpro"
    group_specs = [
        ("sdk", sdk_schemas, [p.name for p in sorted(sdk_schemas.glob("*.fbs")) if p.name != "Solver.fbs"]),
        ("sgp4", modules / "propagator/sgp4/schemas", ["PropagatorState.fbs"]),
        ("sgp4-legacy", modules / "propagator/sgp4/schemas", ["BaseTypes.fbs", "StateVector.fbs"]),
        ("conjunction", modules / "analysis/conjunction-assessment/schemas", None),
    ]
    groups = []
    stamps = []
    for group_id, root, entries in group_specs:
        files = {p.name: p.read_text() for p in sorted(root.glob("*.fbs"))}
        entries = entries or list(files)
        groups.append({"id": group_id, "entries": entries, "files": files,
                       "prefix": "legacy/" if group_id == "sgp4-legacy" else ""})
        stamps.extend({"path": str((root / name).relative_to(modules)), "sha256": sha256(body.encode()),
                       "entrypoint": name in entries, "group": group_id} for name, body in files.items())
    configuration = {"compiler": str(flatc / "dist/flatc-wasm.js"), "groups": groups}
    output = subprocess.check_output(["node", "--input-type=module", "-e", NODE_GENERATOR],
                                     input=json.dumps(configuration).encode(), cwd=modules)
    result = {}
    for name, text in json.loads(output).items():
        # The generator references orbpro both in imports and qualified values.
        # AST-token replacement avoids rewriting documentation or string literals.
        import tokenize
        tokens = []
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type == tokenize.NAME and token.string == "orbpro":
                prefix = INVOKE_NAMESPACE + (".legacy" if name.startswith("legacy/") else "")
                token = token._replace(string=prefix + ".orbpro")
            tokens.append(token)
        result[name] = tokenize.untokenize(tokens).encode()
    return result, {"flatc_wasm_version": compiler_version,
                    "flatc_wasm_js_sha256": sha256((flatc / "dist/flatc-wasm.js").read_bytes()),
                    "sdk_version": json.loads((sdk / "package.json").read_text())["version"],
                    "schemas": stamps}


def add_initializers(files: dict[str, bytes]):
    for name in list(files):
        parent = PurePosixPath(name).parent
        while str(parent) != ".":
            files.setdefault(str(parent / "__init__.py"), b'"""Generated FlatBuffer bindings; see scripts/vendor_sds.py."""\n')
            parent = parent.parent
    files.setdefault("__init__.py", b'"""Private, reproducibly vendored FlatBuffer bindings."""\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sds-repo", type=Path, required=True)
    parser.add_argument("--sds-revision", default=SDS_REVISION)
    parser.add_argument("--modules-root", type=Path, default=MODULES)
    parser.add_argument("--output", type=Path, default=PACKAGE / "src/spacedatanetwork_astro")
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    revision = subprocess.check_output(["git", "-C", str(options.sds_repo), "rev-parse", options.sds_revision], text=True).strip()
    version = json.loads(git_bytes(options.sds_repo, revision, "package.json"))["version"]
    if version.split("+")[0] != SDS_VERSION:
        raise SystemExit(f"Expected ratified SDS {SDS_VERSION}, found {version}")
    sources = source_tree(options.sds_repo, revision)
    sds, missing = vendor_sources(sources)
    invoke, generation = generate_invoke(options.modules_root)
    add_initializers(sds)
    add_initializers(invoke)
    sds_metadata = json.loads(git_bytes(options.sds_repo, revision, "package.json"))
    if sds_metadata.get("license") != "Apache-2.0":
        raise SystemExit("SDS license declaration changed; review its license before vendoring")
    apache_path = options.modules_root / "node_modules/flatbuffers/LICENSE"
    apache_license = apache_path.read_bytes()
    apache_sha = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
    if sha256(apache_license) != apache_sha:
        raise SystemExit("The standard Apache-2.0 license source changed; review before updating its pin")
    sdk_license = (options.modules_root / "node_modules/space-data-module-sdk/LICENSE").read_bytes()
    sds["LICENSE.txt"] = apache_license
    sds["NOTICE.txt"] = ("spacedatastandards.org generated Python bindings\n"
        "Source: https://github.com/DigitalArsenal/spacedatastandards.org\n"
        f"Version: {version}\nGit revision: {revision}\n"
        "License: Apache License, Version 2.0 (see LICENSE.txt).\n"
        "The pinned package.json and README.md declare Apache-2.0; the upstream\n"
        "tree contains no SDS LICENSE or NOTICE file. Generated-file comments\n"
        "are preserved. Imports have been rewritten by scripts/vendor_sds.py\n"
        "to resolve within spacedatanetwork_astro.sds. No wire schema changed.\n").encode()
    invoke["SDK-LICENSE.txt"] = sdk_license
    invoke["NOTICE.txt"] = ("Module-local Python FlatBuffer bindings\n"
        "SDK schema source: https://github.com/DigitalArsenal/space-data-module-sdk\n"
        f"SDK version: {generation['sdk_version']}\n"
        "SDK-derived files retain the Apache-2.0 terms in SDK-LICENSE.txt.\n"
        "Other schemas come from this modules repository; this notice does not\n"
        "relicense those modules. bindings.lock.json identifies each source.\n"
        f"Python generated with flatc-wasm {FLATC_VERSION}; qualified Python\n"
        "imports are rewritten by scripts/vendor_sds.py. No wire schema changed.\n").encode()
    generation["license_sources"] = [
        {"path": "node_modules/flatbuffers/LICENSE", "sha256": apache_sha},
        {"path": "node_modules/space-data-module-sdk/LICENSE", "sha256": sha256(sdk_license)},
    ]
    outputs = {"sds/" + name: data for name, data in sds.items()}
    outputs.update({"invoke/" + name: data for name, data in invoke.items()})
    source_manifest = {name: sha256(data) for name, data in sorted(sources.items())}
    artifact_lock = json.loads((PACKAGE / "src/spacedatanetwork_astro/artifacts.lock.json").read_text())
    artifacts = []
    for module in artifact_lock["modules"]:
        root = options.modules_root / module["id"]
        metadata = json.loads((root / "package.json").read_text())
        artifacts.append({"id": module["id"],
                          "wasm_sha256": next(file["sha256"] for file in module["files"] if file["name"] == "module.wasm"),
                          "declared_sds_dependency": metadata.get("dependencies", {}).get("spacedatastandards.org") or metadata.get("devDependencies", {}).get("spacedatastandards.org"),
                          "build_provenance": json.loads((root / "dist/build-provenance.json").read_text()) if (root / "dist/build-provenance.json").is_file() else None})
    lock = {"format_version": 1, "artifacts": artifacts, "sds": {"repository": "https://github.com/DigitalArsenal/spacedatastandards.org",
            "revision": revision, "version": version, "families": sorted(FAMILIES),
            "lib_py_sha256": source_manifest, "lib_py_manifest_sha256": sha256(canonical_json(source_manifest))},
            "invoke": generation, "unresolved_imports": missing,
            "generated_sha256": {name: sha256(data) for name, data in sorted(outputs.items())}}
    outputs["bindings.lock.json"] = canonical_json(lock)
    mismatches = []
    for name, data in outputs.items():
        target = options.output / name
        if options.check:
            if not target.is_file() or target.read_bytes() != data:
                mismatches.append(name)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    for folder in ("sds", "invoke"):
        for target in (options.output / folder).rglob("*.py"):
            name = target.relative_to(options.output).as_posix()
            if name not in outputs:
                if options.check:
                    mismatches.append(name + " (stale)")
                else:
                    target.unlink()
    if mismatches:
        raise SystemExit("Generated bindings differ: " + ", ".join(mismatches[:20]))
    print(f"{'Verified' if options.check else 'Vendored'} {len(sds)} SDS and {len(invoke)} invoke files; "
          f"SDS {version} at {revision}; {len(missing)} unresolved imports")


if __name__ == "__main__":
    main()
