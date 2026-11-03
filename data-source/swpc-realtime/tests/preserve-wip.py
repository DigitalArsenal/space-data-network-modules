"""Preserve only this lane's paths on origin/main, without changing shared HEAD/index."""
import os,subprocess,tempfile
from pathlib import Path
os.chdir(Path(__file__).resolve().parents[3])
def git(*args,env=None): return subprocess.check_output(['git',*args],env=env,text=True).strip()
ref='refs/heads/wip/modules-swpc-realtime-producer-20261103/work'
previous=git('ls-remote','origin',ref).split()[0]
base=git('rev-parse','origin/main')
fd,idx=tempfile.mkstemp(prefix='swpc-index-');os.close(fd);os.unlink(idx)
env=dict(os.environ,GIT_INDEX_FILE=idx)
try:
 git('read-tree',base,env=env)
 git('add','--','data-source/swpc-realtime','flows/swpc-realtime',env=env)
 tree=git('write-tree',env=env)
 # If origin/main advanced, rebase this isolated snapshot via commit-tree only.
 same_base=subprocess.run(['git','merge-base','--is-ancestor',base,previous]).returncode==0
 parent=previous if same_base else base
 commit=git('commit-tree',tree,'-p',parent,'-m','modules-swpc-realtime-producer-20261103: preserve producer progress',env=env)
 changed=git('diff','--name-only',base,commit).splitlines()
 assert all(p.startswith(('data-source/swpc-realtime/','flows/swpc-realtime/')) for p in changed)
 git('push','--force-with-lease='+ref+':'+previous,'origin',commit+':'+ref)
 print(commit)
finally:
 if os.path.exists(idx): os.unlink(idx)
