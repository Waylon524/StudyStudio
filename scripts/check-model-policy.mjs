import assert from 'node:assert/strict';
import {MODEL_ID,DEEP_MODEL_ID,checkedModel,checkedEffort,checkedTurn,selectModel,selectModels,validatePresetConfigs} from '../server/model-policy.mjs';
import {THINKING_PRESETS,DEFAULT_PRESET_CONFIGS,thinkingPreset,normalizePresetConfigs,restoreThinkingPreset,effortLabel} from '../shared/model-presets.mjs';
import {CodexBridge} from '../server/codex.mjs';

const terra={id:MODEL_ID,model:MODEL_ID,displayName:'GPT-6.1 Terra',supportedReasoningEfforts:['low','medium','high','xhigh'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'medium'};
const deep={id:DEEP_MODEL_ID,model:DEEP_MODEL_ID,displayName:'GPT-6.2 Astra',supportedReasoningEfforts:[{reasoningEffort:'high'}]};
const sol={id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',supportedReasoningEfforts:['minimal','low','medium','high'].map(reasoningEffort=>({reasoningEffort}))};
const nonReasoning={id:'gpt-plain',model:'gpt-plain',displayName:'GPT Plain',supportedReasoningEfforts:[]};

assert.equal(DEEP_MODEL_ID,'gpt-6.2-astra');
assert.equal(checkedModel(),MODEL_ID);
assert.equal(checkedModel(DEEP_MODEL_ID),DEEP_MODEL_ID);
assert.equal(checkedModel('gpt-6.1-sol'),'gpt-6.1-sol');
assert.throws(()=>checkedModel('bad model!'),/模型名称无效/);
assert.throws(()=>checkedModel('../evil'),/模型名称无效/);

assert.equal(checkedEffort(),'medium');
assert.equal(checkedEffort(null),null);
assert.equal(checkedEffort(''),null);
assert.equal(checkedEffort('xhigh'),'xhigh');
assert.throws(()=>checkedEffort('bad effort!'),/思考强度/);

assert.deepEqual(THINKING_PRESETS,['fast','default','deep']);
for(const [preset,model,effort] of [['fast',MODEL_ID,'medium'],['default',MODEL_ID,'high'],['deep',DEEP_MODEL_ID,'high']]){
  assert.deepEqual(checkedTurn(model,effort),{model,effort});
  assert.deepEqual(thinkingPreset(preset),{label:preset==='fast'?'Fast':preset==='default'?'Default':'Deep',model,effort});
}

// Custom overrides flow cleanly into thinkingPreset and normalizePresetConfigs
const custom=normalizePresetConfigs({
  fast:{model:'gpt-6.1-sol',effort:'low'},
  default:{model:MODEL_ID,effort:'xhigh'},
  deep:{model:'gpt-plain',effort:null},
});
assert.deepEqual(thinkingPreset('fast',custom),{label:'Fast',model:'gpt-6.1-sol',effort:'low'});
assert.deepEqual(thinkingPreset('default',custom),{label:'Default',model:MODEL_ID,effort:'xhigh'});
assert.deepEqual(thinkingPreset('deep',custom),{label:'Deep',model:'gpt-plain',effort:null});
assert.equal(effortLabel('xhigh'),'极高 (xhigh)');
assert.equal(effortLabel(null),'默认');

assert.equal(restoreThinkingPreset(null,'xhigh'),'deep');
assert.equal(restoreThinkingPreset(null,'high'),'default');
assert.equal(restoreThinkingPreset(null,'medium'),'fast');
assert.equal(restoreThinkingPreset('default','xhigh'),'default','explicit new preset takes precedence over legacy Deep sentinel');
assert.equal(restoreThinkingPreset('deep','high'),'deep');
assert.equal(restoreThinkingPreset('unknown','unknown'),'fast');
assert.throws(()=>thinkingPreset('__proto__'));

// selectModels exposes ALL valid models and ALL their supported reasoning efforts
const allSelected=selectModels([terra,deep,sol,nonReasoning]);
assert.deepEqual(
  allSelected.map(value=>[value.model,value.supportedReasoningEfforts.map(e=>e.reasoningEffort)]),
  [
    [MODEL_ID,['low','medium','high','xhigh']],
    [DEEP_MODEL_ID,['high']],
    ['gpt-6.1-sol',['minimal','low','medium','high']],
    ['gpt-plain',[]],
  ]
);

// selectModel validates exact catalog membership and effort support (no silent fallback)
assert.equal(selectModel([terra,sol],'gpt-6.1-sol','low').model,'gpt-6.1-sol');
assert.equal(selectModel([nonReasoning],'gpt-plain',null).model,'gpt-plain');
assert.throws(()=>selectModel([terra],DEEP_MODEL_ID),/没有/);
assert.throws(()=>selectModel([deep],DEEP_MODEL_ID,'medium'),/不支持思考强度/);
assert.throws(()=>selectModel([nonReasoning],'gpt-plain','high'),/不支持自定义思考强度/);

// validatePresetConfigs validates all 3 slots against live Codex catalog
const validated=validatePresetConfigs([terra,deep,sol,nonReasoning],{
  fast:{model:'gpt-6.1-sol',effort:'low'},
  default:{model:MODEL_ID,effort:'xhigh'},
  deep:{model:'gpt-plain',effort:null},
});
assert.deepEqual(validated,{
  fast:{model:'gpt-6.1-sol',effort:'low'},
  default:{model:MODEL_ID,effort:'xhigh'},
  deep:{model:'gpt-plain',effort:null},
});
assert.throws(()=>validatePresetConfigs([terra,deep],{
  fast:{model:'gpt-6.1-sol',effort:'low'},
  default:{model:MODEL_ID,effort:'high'},
  deep:{model:DEEP_MODEL_ID,effort:'high'},
}),/没有/);
assert.throws(()=>validatePresetConfigs([terra,deep],{
  fast:{model:MODEL_ID,effort:'medium'},
  default:{model:MODEL_ID,effort:'high'},
  deep:{model:DEEP_MODEL_ID,effort:'low'},
}),/不支持思考强度/);

let now=1000;
class Stub extends CodexBridge{
  constructor(){super({now:()=>now});this.calls=[];this.models=[terra,deep,sol,nonReasoning];this.catalog={data:this.models,expires:61000};this.isolated.set('lesson',{cacheable:true})}
  async start(){}
  async assertPolicy(){}
  async request(method,params){this.calls.push({method,params});if(method==='model/list')return{data:this.models,nextCursor:null};if(method==='turn/start')return{turn:{id:'turn'}};throw Error('Unexpected request '+method)}
}
const bridge=new Stub();
for(const [model,effort] of [[MODEL_ID,'xhigh'],['gpt-6.1-sol','minimal'],[DEEP_MODEL_ID,'high']]){
  bridge.calls=[];await bridge.turn('lesson','说明',model,effort);assert.deepEqual(bridge.calls.map(value=>value.method),['turn/start']);assert.equal(bridge.calls[0].params.model,model);assert.equal(bridge.calls[0].params.effort,effort);
}
bridge.calls=[];await bridge.turn('lesson','说明','gpt-plain',null);assert.equal(bridge.calls[0].params.model,'gpt-plain');assert.equal('effort' in bridge.calls[0].params,false,'non-reasoning model omits effort param');
for(const [model,effort] of [[DEEP_MODEL_ID,'medium'],['gpt-6.1-sol','xhigh'],['unknown-model','high']]){
  bridge.calls=[];await assert.rejects(bridge.turn('lesson','x',model,effort));assert.equal(bridge.calls.length,0);
}
bridge.models=[terra];now=61001;bridge.calls=[];await assert.rejects(bridge.turn('lesson','x',DEEP_MODEL_ID,'high'),/没有/);assert.deepEqual(bridge.calls.map(value=>value.method),['model/list'],'expired catalog cannot silently retain an unavailable model');
bridge.calls=[];await bridge.turn('lesson','x',MODEL_ID,'medium');assert.deepEqual(bridge.calls.map(value=>value.method),['turn/start'],'configured catalog model remains usable');
assert.equal(DEFAULT_PRESET_CONFIGS.fast.model,MODEL_ID);
console.log('Model policy passed: full Codex catalog exposure, exact model+effort validation, custom Fast/Default/Deep preset configs, non-reasoning model support, and no silent fallback.');
