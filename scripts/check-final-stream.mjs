import assert from 'node:assert/strict';
import {createFinalStream,applyFinalStream,finishFinalStream,finalStreamMessages} from '../shared/final-stream.mjs';

const state=createFinalStream();
const event=(method,params)=>applyFinalStream(state,method,{turnId:'turn-a',...params});
event('item/started',{item:{id:'progress',type:'agentMessage',phase:'commentary',text:''}});
event('item/agentMessage/delta',{itemId:'progress',delta:'我要检查资料。'});
event('item/completed',{item:{id:'progress',type:'agentMessage',phase:'commentary',text:'我要检查资料。'}});
assert.deepEqual(finalStreamMessages(state),[],'process narration is never visible');
event('item/agentMessage/delta',{itemId:'answer',delta:'细胞膜'});
assert.deepEqual(finalStreamMessages(state),[],'unknown phase stays buffered');
event('item/started',{item:{id:'answer',type:'agentMessage',phase:'final_answer',text:''}});
assert.equal(finalStreamMessages(state)[0].text,'细胞膜','metadata releases buffered final text');
assert.equal(finalStreamMessages(state)[0].streaming,true);
event('item/agentMessage/delta',{itemId:'answer',delta:'是选择透过性的。'});
assert.equal(finalStreamMessages(state)[0].text,'细胞膜是选择透过性的。');
event('item/completed',{item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'细胞膜具有选择透过性。'}});
assert.equal(finalStreamMessages(state)[0].text,'细胞膜具有选择透过性。','completed content is authoritative');
assert.equal(finalStreamMessages(state)[0].streaming,false);
event('item/agentMessage/delta',{itemId:'answer',delta:'duplicate'});
assert.equal(finalStreamMessages(state)[0].text,'细胞膜具有选择透过性。','late delta cannot duplicate completed text');
finishFinalStream(state,{success:true});assert.equal(finalStreamMessages(state).length,1);assert.equal(finalStreamMessages(state)[0].incomplete,false);

const interrupted=createFinalStream();
applyFinalStream(interrupted,'item/started',{turnId:'b',item:{id:'partial',type:'agentMessage',phase:'final_answer',text:''}});
applyFinalStream(interrupted,'item/agentMessage/delta',{turnId:'b',itemId:'partial',delta:'结论：```ui\n{"blocks":['});
applyFinalStream(interrupted,'item/agentMessage/delta',{turnId:'other',itemId:'partial',delta:'wrong turn'});
finishFinalStream(interrupted);
assert.equal(finalStreamMessages(interrupted)[0].text,'结论：```ui\n{"blocks":[');
assert.equal(finalStreamMessages(interrupted)[0].streaming,false);assert.equal(finalStreamMessages(interrupted)[0].incomplete,true,'interruption retains text but disables executable components');

const phaseLess=createFinalStream();
applyFinalStream(phaseLess,'item/completed',{item:{id:'old',type:'agentMessage',phase:null,text:'无 phase 的完整最终回答'}});
assert.deepEqual(finalStreamMessages(phaseLess),[]);
finishFinalStream(phaseLess,{success:true});assert.equal(finalStreamMessages(phaseLess)[0].text,'无 phase 的完整最终回答');
const unknownSuccess=createFinalStream();applyFinalStream(unknownSuccess,'item/agentMessage/delta',{itemId:'hidden',delta:'尚未确认是否最终回答'});finishFinalStream(unknownSuccess,{success:true});assert.deepEqual(finalStreamMessages(unknownSuccess),[],'terminal success cannot promote unfinished unknown-phase deltas');
const unknownFailure=createFinalStream();applyFinalStream(unknownFailure,'item/completed',{item:{id:'hidden',type:'agentMessage',phase:null,text:'可能是过程'}});finishFinalStream(unknownFailure);assert.deepEqual(finalStreamMessages(unknownFailure),[]);

const terminal=createFinalStream();
finishFinalStream(terminal,{success:true,items:[{id:'complete',type:'agentMessage',phase:'final_answer',text:'完成'}]});assert.equal(finalStreamMessages(terminal)[0].text,'完成');
assert.equal(applyFinalStream(terminal,'item/agentMessage/delta',{itemId:'complete',delta:'late'}),false);
console.log('Final streaming passed: commentary/unknown phases hidden, ordered deltas, final metadata, authoritative completion, interruption, wrong turns, no duplicates, and terminal reconciliation.');
