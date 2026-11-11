import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from '../../../src/harness/contracts.mjs';

// Seed an already-persisted pre-stage12 beta approval, rather than treating fresh
// caller omission as permission to choose the legacy reviewer. Lifecycle actions
// after loading use the ordinary production coordinator.
export function savedBetaGoal(c,raw){
 const manifest=c.goalManifest(raw,undefined,{historic:true});
 assert.equal(Object.hasOwn(manifest,'reviewPolicy'),false);
 const goal={id:randomUUID(),manifest,hash:digest(manifest),version:1,status:'draft',createdAt:c.now(),activatedAt:null,deadline:null};
 c.store.tx(()=>c.store.put('goal',goal));
 return goal;
}
