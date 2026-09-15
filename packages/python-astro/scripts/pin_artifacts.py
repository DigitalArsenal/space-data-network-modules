"""Explicitly reviewable repin of SDK-built artifacts, never run by wheel builds."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--source-revision', required=True)
a = p.parse_args()
package = Path(__file__).resolve().parents[1]
root = package.parents[1]
revision = subprocess.check_output(['git', 'rev-parse', a.source_revision], cwd=root, text=True).strip()
lock_path = package / 'src/spacedatanetwork_astro/artifacts.lock.json'
lock = json.loads(lock_path.read_text())
for module in lock['modules']:
    for record in module['files']:
        data = (root / record['source_path']).read_bytes()
        committed = subprocess.check_output(['git', 'show', f'{revision}:{record["source_path"]}'], cwd=root)
        if data != committed:
            raise SystemExit(f'Artifact differs from source revision: {record["source_path"]}')
        record.update(sha256=hashlib.sha256(data).hexdigest(), size=len(data))
lock['source_revision'] = revision
lock['status'] = 'ctypes WasmEdge runtime; see docs/verification.md for validation limits'
lock['artifact_set_sha256'] = hashlib.sha256(json.dumps(lock['modules'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
lock['version'] = f"0.1.0.dev0+modules.{revision[:12]}.a{lock['artifact_set_sha256'][:12]}"
lock_path.write_text(json.dumps(lock, indent=2) + '\n')
(lock_path.parent / '_version.py').write_text(f'__version__ = {lock["version"]!r}\n')
print('PASS: reviewed artifact set ' + lock['artifact_set_sha256'])
