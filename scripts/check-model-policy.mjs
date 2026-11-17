import assert from 'node:assert/strict';
import {MODEL_ID,DEEP_MODEL_ID,checkedModel,checkedEffort,checkedTurn,selectModel,selectModels} from '../server/model-policy.mjs';
import {CodexBridge} from '../server/codex.mjs';

const terra={id:MODEL_ID,model:MODEL_ID,supportedReasoningEfforts:['medium','high'].map(reasoningEffort=>({reasoningEffort}))};
const sol={id:DEEP_MODEL_ID,model:DEEP_MODEL_ID,supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]};
assert.equal(checkedModel(),MODEL_ID);assert.equal(checkedModel(DEEP_MODEL_ID),DEEP_MODEL_ID);
assert.equal(checkedEffort(),'medium');assert.throws(()=>checkedEffort('low'),/只能选择/);
for(const [effort,model] of [['medium',MODEL_ID],['high',MODEL_ID],['xhigh',DEEP_MODEL_ID]]){
  assert.deepEqual(checkedTurn(undefined,effort),{model,effort});assert.deepEqual(checkedTurn(model,effort),{model,effort});
}
for(const [model,effort] of [[MODEL_ID,'xhigh'],[DEEP_MODEL_ID,'medium'],[DEEP_MODEL_ID,'high'],['other','xhigh']])assert.throws(()=>checkedTurn(model,effort));
assert.deepEqual(selectModels([terra,sol]).map(x=>[x.model,x.supportedReasoningEfforts.map(e=>e.reasoningEffort)]),[[MODEL_ID,['medium','high']],[DEEP_MODEL_ID,['xhigh']]]);
assert.deepEqual(selectModels([terra]).map(x=>x.model),[MODEL_ID]);
assert.deepEqual(selectModels([terra,{...sol,supportedReasoningEfforts:[{reasoningEffort:'high'}]}]).map(x=>x.model),[MODEL_ID]);
assert.throws(()=>selectModel([terra],DEEP_MODEL_ID),/Sol/);
assert.throws(()=>selectModel([{...sol,supportedReasoningEfforts:[]}],DEEP_MODEL_ID),/xhigh/);

let now=1000;
class Stub extends CodexBridge{
  constructor(){super({now:()=>now});this.calls=[];this.models=[terra,sol];this.catalog={data:this.models,expires:61000};this.isolated.set('lesson',{cacheable:true})}
  async start(){}
  async assertPolicy(){}
  async request(method,params){this.calls.push({method,params});if(method==='model/list')return{data:this.models,nextCursor:null};if(method==='turn/start')return{turn:{id:'turn'}};throw Error('Unexpected request '+method)}
}
const bridge=new Stub();
for(const [model,effort] of [[MODEL_ID,'medium'],[MODEL_ID,'high'],[DEEP_MODEL_ID,'xhigh']]){
  bridge.calls=[];await bridge.turn('lesson','说明',model,effort);assert.deepEqual(bridge.calls.map(x=>x.method),['turn/start']);assert.equal(bridge.calls[0].params.model,model);assert.equal(bridge.calls[0].params.effort,effort);
}
bridge.calls=[];await assert.rejects(bridge.turn('lesson','x',MODEL_ID,'xhigh'));assert.equal(bridge.calls.length,0);
bridge.models=[terra];now=61001;bridge.calls=[];await assert.rejects(bridge.turn('lesson','x',DEEP_MODEL_ID,'xhigh'),/Sol/);assert.deepEqual(bridge.calls.map(x=>x.method),['model/list'],'expired catalog cannot silently retain an unavailable Deep model');
bridge.calls=[];await bridge.turn('lesson','x',MODEL_ID,'medium');assert.deepEqual(bridge.calls.map(x=>x.method),['turn/start'],'Terra remains usable when Deep is unavailable');
console.log('Model policy passed: Fast Terra medium, Default Terra high, Deep Sol xhigh, cached live catalog, no fallback, mismatch rejection, and independent Deep availability.');
