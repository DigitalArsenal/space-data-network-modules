import test from 'node:test';
import assert from 'node:assert/strict';
import { sealReview, recordDecision, activeBindings } from '../app/review.js';
const candidate = (provider, nativeId) => ({ id:provider+nativeId,provider,nativeId,recordId:'immutable:'+nativeId });
async function review(a,b,status='compatible') {
  const recipe={candidates:[a,b],pairs:[{left:a.id,right:b.id}]};
  return sealReview(recipe,{policy:{positionToleranceKm:1},matches:[{left:a.id,right:b.id,status,evidence:{recordId:'crosswalk-edition'}}]});
}
test('explicit acceptance persists with evidence, revocation releases the identity',async()=>{
 const r=await review(candidate('a','1'),candidate('b','2'));
 let decisions=await recordDecision([],r,0,'accepted','checked both provider editions');
 const restored=JSON.parse(JSON.stringify(decisions)); assert.equal(activeBindings(restored).length,1);
 assert.equal(restored[0].evidence.recordId,'crosswalk-edition'); assert.equal(restored[0].reviewSha256,r.sha256);
 decisions=await recordDecision(restored,r,0,'revoked','new evidence'); assert.equal(activeBindings(decisions).length,0);
});
test('ambiguous, rejected, insufficient and modified reviews cannot be accepted',async()=>{
 for(const status of ['ambiguous','rejected','insufficient']) await assert.rejects(recordDecision([],await review(candidate('a','1'),candidate('b','2'),status),0,'accepted','review'));
 const r=await review(candidate('a','1'),candidate('b','2'));r.report.matches[0].status='rejected';await assert.rejects(recordDecision([],r,0,'accepted','review'),/changed/);
});
test('direct and transitive conflicting identities require explicit revocation',async()=>{
 let d=await recordDecision([],await review(candidate('a','1'),candidate('b','2')),0,'accepted','review');
 d=await recordDecision(d,await review(candidate('b','2'),candidate('c','3')),0,'accepted','review');
 await assert.rejects(recordDecision(d,await review(candidate('c','3'),candidate('a','4')),0,'accepted','review'),/conflicts/);
 await assert.rejects(recordDecision(d,await review(candidate('a','1'),candidate('b','5')),0,'accepted','review'),/conflicts/);
});

test('imported history cannot activate incompatible or contradictory identities',async()=>{
 const a=await recordDecision([],await review(candidate('a','1'),candidate('b','2')),0,'accepted','review');
 const b=await recordDecision([],await review(candidate('a','1'),candidate('b','3')),0,'accepted','review');
 assert.throws(()=>activeBindings([...a,...b]),/conflicts/);
 a[0].diagnostics.status='ambiguous';assert.throws(()=>activeBindings(a),/compatible/);
});
