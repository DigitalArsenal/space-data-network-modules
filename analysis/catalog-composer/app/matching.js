// UI only: orbit numerics execute in the same Catalog WASM artifact.
export function setupMatching({ getModule, getRecipe, changed, status }) {
  const $=id=>document.getElementById(id);
  const fields=['positionToleranceKm','velocityToleranceKmS','finiteDifferenceToleranceKmS','minimumSpanSeconds'];
  const defaults={positionToleranceKm:10,velocityToleranceKmS:.01,finiteDifferenceToleranceKmS:.001,minimumSpanSeconds:3600};
  $('matching-open').onclick=()=>{const p=getRecipe().matching || defaults;for(const k of fields)$(`matching-${k}`).value=p[k];$('matching-dialog').showModal();};
  for(const tab of ['sources','policy','help']) $(`matching-tab-${tab}`).onclick=()=>{for(const key of ['sources','policy','help']){$(`matching-panel-${key}`).hidden=key!==tab;$(`matching-tab-${key}`).setAttribute('aria-selected',String(key===tab));}};
  $('matching-close').onclick=()=>$('matching-dialog').close();
  $('matching-form').onsubmit=async event=>{
    event.preventDefault(); const button=$('matching-run');button.disabled=true;$('matching-result').textContent='Checking trajectories…';
    try {
      const module=getModule();if(!module)throw new Error('The catalog module is not ready.');
      const policy=Object.fromEntries(fields.map(k=>[k,Number($(`matching-${k}`).value)]));
      if(Object.values(policy).some(v=>!Number.isFinite(v)||v<=0))throw new Error('Enter positive finite thresholds.');
      const candidates=[],inputs=[];
      for(const id of ['left','right']) {
        const file=$(`matching-${id}`).files[0];if(!file || file.size>16*1024*1024)throw new Error('Choose one size-prefixed OEM FlatBuffer per side (maximum 16 MiB each).');
        const provider=$(`matching-${id}-provider`).value.trim(),nativeId=$(`matching-${id}-id`).value.trim();
        if(!provider||!nativeId)throw new Error('Specify each provider and its native object ID.');
        const payload=new Uint8Array(await file.arrayBuffer());
        const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',payload))].map(v=>v.toString(16).padStart(2,'0')).join('');
        candidates.push({id,provider,nativeId,recordId:`sha256:${digest}`});
        inputs.push({portId:'ephemerides',typeRef:{schemaName:'OEM.fbs',fileIdentifier:'$OEM',rootTypeName:'OEM'},payload});
      }
      const recipe={version:1,...policy,candidates,pairs:[{left:'left',right:'right',evidence:{note:$('matching-evidence').value.trim()}}]};
      const payload=new TextEncoder().encode(JSON.stringify(recipe));
      const out=await module.invoke({methodId:'match_catalog',inputs:[{portId:'recipe',typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:payload.length},payload},...inputs]});
      if(out.statusCode!==0)throw new Error(out.errorMessage||'Trajectory check failed.');
      const report=JSON.parse(new TextDecoder().decode(out.outputs.find(f=>f.portId==='report').payload));
      const row=report.matches[0];
      $('matching-result').textContent=`${row.status.toUpperCase()}: ${row.reason}`+(row.maximumPositionResidualKm!==undefined?` Maximum separation: ${row.maximumPositionResidualKm.toPrecision(5)} km; velocity difference: ${row.maximumVelocityResidualKmS.toPrecision(5)} km/s.`:'');
      getRecipe().matching=policy;changed();status('Matching thresholds saved. Identity associations remain unchanged until reviewed.');
      $('matching-download').hidden=false;
      $('matching-download').onclick=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify({recipe,report},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='catalog-match-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
    } catch(error) {$('matching-result').textContent=error.message;$('matching-download').hidden=true;}
    finally{button.disabled=false;}
  };
}
