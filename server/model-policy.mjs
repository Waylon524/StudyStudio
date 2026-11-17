export const MODEL_ID = 'gpt-6.1-terra';
export const DEEP_MODEL_ID = 'gpt-6.1-sol';
export const REASONING_LEVELS = Object.freeze(['medium','high','xhigh']);
export function checkedModel(value) {
  if (value != null && value !== MODEL_ID && value !== DEEP_MODEL_ID) throw Error('此学习平台仅支持 GPT-6.1 Terra 和 GPT-6.1 Sol。');
  return value ?? MODEL_ID;
}
export function checkedEffort(value) {
  if (value == null) return 'medium';
  if (!REASONING_LEVELS.includes(value)) throw Error('思考程度只能选择 medium、high 或 xhigh。');
  return value;
}
export function checkedTurn(model,effort) {
  const fixedEffort=checkedEffort(effort),fixedModel=fixedEffort==='xhigh'?DEEP_MODEL_ID:MODEL_ID;
  if(model!=null&&checkedModel(model)!==fixedModel)throw Error('Fast / Default 使用 GPT-6.1 Terra，Deep 使用 GPT-6.1 Sol xhigh。');
  return {model:fixedModel,effort:fixedEffort};
}
export function selectModel(models,model=MODEL_ID) {
  const id=checkedModel(model),name=id===DEEP_MODEL_ID?'GPT-6.1 Sol':'GPT-6.1 Terra';
  const found=models.find(x=>x?.model===id || x?.id===id);
  if(!found) throw Error(`当前账号的模型目录中没有 ${name}。`);
  const levels=id===DEEP_MODEL_ID?['xhigh']:['medium','high'];
  const options=Array.isArray(found.supportedReasoningEfforts)?found.supportedReasoningEfforts:[];
  const ordered=levels.map(level=>options.find(x=>x.reasoningEffort===level));
  if(ordered.some(x=>!x)) throw Error(`当前模型目录中的 ${name} 未提供所需思考强度：${levels.join(' / ')}。`);
  return {id,model:id,displayName:found.displayName,isDefault:id===MODEL_ID,supportedReasoningEfforts:ordered,defaultReasoningEffort:levels[0]};
}
export function selectModels(models) {
  const available=[selectModel(models)];
  // An unavailable Deep preset must not disable the two Terra presets. A Deep
  // request still validates Sol explicitly and fails instead of falling back.
  try { available.push(selectModel(models,DEEP_MODEL_ID)); } catch {}
  return available;
}
