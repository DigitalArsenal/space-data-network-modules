// APP controls. Physics remains in the selected WASM module set.
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { callHost } from './bridge.js';
import { parseDatefirst, crosswalkCandidates, sha256 } from './crosswalk.js';
import { sealReview, recordDecision, activeBindings } from './review.js';
import { runMatching, propagateCommonGrid, normalizeVimpel, DEFAULT_MODEL, gridPolicy } from './common-grid.js';
export function setupMatching({ getModule, getRecipe, changed, status }) {
  const $=id=>document.getElementById(id);
  const fields=['positionToleranceKm','velocityToleranceKmS','finiteDifferenceToleranceKmS','minimumSpanSeconds'];
  const defaults={positionToleranceKm:10,velocityToleranceKmS:.01,finiteDifferenceToleranceKmS:.001,minimumSpanSeconds:3600};
  let review;
  const invalidate=()=>{review=null;$('matching-decision').hidden=true;$('matching-download').hidden=true;};
  const download=(value,name)=>{const u=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
  const history=()=>{$('matching-history').textContent=`${activeBindings(getRecipe().identityDecisions||[]).length} accepted associations · ${(getRecipe().identityDecisions||[]).length} review decisions saved with this recipe.`;};
  $('matching-open').onclick=()=>{const r=getRecipe(),p=r.matching||defaults;for(const k of fields)$(`matching-${k}`).value=p[k];
    const grid=r.matchingGrid||{start:new Date().toISOString().slice(0,19)+'Z',stepSeconds:60,samples:61};
    for(const [id,key] of [['start','start'],['step','stepSeconds'],['samples','samples']])$(`matching-${id}`).value=grid[key];
    $('matching-model').value=JSON.stringify(r.matchingModel||DEFAULT_MODEL,null,2);invalidate();history();$('matching-dialog').showModal();};
  for(const tab of ['sources','policy','help']) $(`matching-tab-${tab}`).onclick=()=>{for(const key of ['sources','policy','help']){$(`matching-panel-${key}`).hidden=key!==tab;$(`matching-tab-${key}`).setAttribute('aria-selected',String(key===tab));}};
  $('matching-close').onclick=()=>$('matching-dialog').close();
  $('matching-form').addEventListener('input',event=>{if(event.target.id!=='matching-reason')invalidate();});
  $('matching-history-download').onclick=()=>download(getRecipe().identityDecisions||[],'catalog-identity-decisions.json');
  for(const decision of ['accepted','rejected','revoked'])$(`matching-${decision}`).onclick=async()=>{
    try {if(!review)throw new Error('Run a trajectory check first.');
      const next=await recordDecision(getRecipe().identityDecisions||[],review,0,decision,$('matching-reason').value);
      const previous=getRecipe().identityDecisions;getRecipe().identityDecisions=next;
      try{await changed();}catch(error){getRecipe().identityDecisions=previous;throw error;}
      history();status(`Association ${decision}; provider records remain attributed.`);
    }catch(error){$('matching-result').textContent=error.message;}
  };
  $('matching-form').onsubmit=async event=>{
    event.preventDefault();const button=$('matching-run');button.disabled=true;invalidate();$('matching-result').textContent='Preparing and checking trajectories…';
    const runtimes=[];
    try {
      const module=getModule();if(!module)throw new Error('The catalog module is not ready.');
      const policy=Object.fromEntries(fields.map(k=>[k,Number($(`matching-${k}`).value)]));
      if(Object.values(policy).some(v=>!Number.isFinite(v)||v<=0))throw new Error('Enter positive finite thresholds.');
      const candidates=[];
      for(const id of ['left','right']) {
        const file=$(`matching-${id}`).files[0];if(!file || file.size>16*1024*1024)throw new Error('Choose a state product per side (maximum 16 MiB each).');
        const provider=$(`matching-${id}-provider`).value.trim(),nativeId=$(`matching-${id}-id`).value.trim();
        if(!provider||!nativeId)throw new Error('Specify each provider and its native object ID.');
        const bytes=new Uint8Array(await file.arrayBuffer());candidates.push({id,provider,nativeId,recordId:`sha256:${await sha256(bytes)}`,format:$(`matching-${id}-format`).value,bytes});
      }
      let pairs=[{left:'left',right:'right',evidence:{note:$('matching-evidence').value.trim()}}],crosswalk;
      const crosswalkFile=$('matching-crosswalk').files[0];
      if(crosswalkFile){if(crosswalkFile.size>8*1024*1024)throw new Error('Crosswalk exceeds 8 MiB.');const bytes=new Uint8Array(await crosswalkFile.arrayBuffer());
        crosswalk=await parseDatefirst(bytes,{recordId:`sha256:${await sha256(bytes)}`,leftProvider:candidates[0].provider,rightProvider:candidates[1].provider});
        const generated=crosswalkCandidates(crosswalk,candidates);pairs=generated.pairs;
        if(pairs.length!==1)throw new Error('The crosswalk has no unique, valid declaration for these two products. Review missing, invalid, duplicate or conflicting rows.');
      }
      const automatic=candidates.some(c=>c.format!=='oem');
      let adapters={},dependencies=[],grid,model;
      if(automatic) {
        if(candidates.some(c=>c.format==='oem'))throw new Error('Choose two epoch products for automatic propagation, or two prepared OEM trajectories.');
        grid=gridPolicy({start:$('matching-start').value,stepSeconds:Number($('matching-step').value),samples:Number($('matching-samples').value)});
        model=JSON.parse($('matching-model').value);
        for(const binding of __MATCHING_MODULES__) {
          if(binding.role==='normalizer'&&!candidates.some(c=>c.format==='vimpel'))continue;
          let bytes,hash=binding.hash;
          const alternative=binding.role==='propagator'&&$('matching-propagator-file').files[0];
          if(alternative){if(alternative.size>128*1024*1024)throw new Error('Propagator exceeds 128 MiB.');bytes=new Uint8Array(await alternative.arrayBuffer());hash=await sha256(bytes);}
          else {({bytes}=await callHost('module',{pluginId:binding.pluginId}));if(await sha256(bytes)!==hash)throw new Error('A declared module changed. Reopen the editor.');}
          adapters[binding.role]=await createBrowserModuleHarness({wasmSource:bytes,...(!alternative?{manifest:binding.manifest}:{}),surface:'direct'});runtimes.push(adapters[binding.role]);
          dependencies.push({role:binding.role,pluginId:alternative?`sha256:${hash}`:binding.pluginId,sha256:hash});
        }
      }
      const result=await runMatching({module,candidates,pairs,policy,prepare:async candidate=>{
        if(candidate.format==='oem')return {payload:candidate.bytes,provenance:{sourceProduct:candidate.recordId}};
        const seed=candidate.format==='vimpel'?await normalizeVimpel(candidate.bytes,candidate.nativeId,adapters.normalizer):candidate.bytes;
        const prepared=await propagateCommonGrid(seed,grid,adapters,model);
        return {...prepared,provenance:{sourceProduct:candidate.recordId,normalizedStateSha256:await sha256(seed),grid:prepared.grid,model:prepared.model,dependencies}};
      }});
      review=await sealReview(result.recipe,result.report,{...(grid?{grid,model,dependencies}:{}),...(crosswalk?{crosswalk:{sha256:crosswalk.sha256,recordId:crosswalk.recordId,rows:crosswalk.edges.length}}:{})});
      const row=review.report.matches[0];
      $('matching-result').textContent=`${row.status.toUpperCase()}: ${row.reason}`+(row.maximumPositionResidualKm!==undefined?` Maximum separation: ${row.maximumPositionResidualKm.toPrecision(5)} km; velocity difference: ${row.maximumVelocityResidualKmS.toPrecision(5)} km/s.`:'');
      getRecipe().matching=policy;if(grid){getRecipe().matchingGrid=grid;getRecipe().matchingModel=model;}await changed();
      $('matching-download').hidden=false;$('matching-download').onclick=()=>download(review,'catalog-match-review.json');
      $('matching-decision').hidden=false;$('matching-accepted').disabled=row.status!=='compatible';
      status('Review saved thresholds. Choose an explicit identity decision after inspecting the result.');
    }catch(error){$('matching-result').textContent=error.message;invalidate();}
    finally{for(const runtime of runtimes)await runtime.destroy();button.disabled=false;}
  };
}
